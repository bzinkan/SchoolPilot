import type {
  ClasspilotClassroomState,
  ClasspilotStudentControlState,
} from "../schema/classpilot.js";
import { recordHeartbeatHotPathCounter } from "./heartbeatHotPathMetrics.js";
import type { ClasspilotSsoPolicy } from "./classpilotSsoPolicy.js";
import { focusAssignmentMatches, focusCapabilityAccepted, focusRecord, readFocusAssignment,
  readFocusRestriction, type ClasspilotFocusRestriction } from "./classpilotFocus.js";
import {
  PRECISE_RESTRICTION_RESOURCES_CAPABILITY,
  isWaypointLandingUrl,
  validateAllowedResource,
  validateAllowedResourceList,
  type AllowedResource,
  type PreciseAllowedResource,
} from "./restrictionResources.js";

export const CLASSPILOT_CLASSROOM_STATE_SCHEMA_VERSION = 1 as const;

export type ClasspilotRestrictionAuthPassThroughEnvelope = {
  schemaVersion: 1;
  policyRevision: number;
  /** Canonical enabled policies always identify one configured provider. */
  defaultProfileId: string;
  attemptTtlSeconds: number;
  profiles: Array<{
    id: string;
    name: string;
    startUrl: string;
    hostRules: Array<{ hostname: string; includeSubdomains: boolean }>;
  }>;
};

/**
 * Wire-order fence for SSO authority. The low bit is a rollback tombstone:
 * an enabled operator gate emits 2N and gate-off emits 2N+1. Re-enabling
 * after rollback therefore requires a settings PATCH that advances N; a
 * same-database-revision re-enable is intentionally rejected by clients as
 * older than the tombstone rather than reopening stale IdP authority.
 */
export function classpilotRestrictionAuthProjectionRevision(options: {
  policyRevision: number;
  gateActive: boolean;
}): number {
  const policyRevision = Math.max(0, Math.trunc(options.policyRevision));
  return (policyRevision * 2) + (options.gateActive ? 0 : 1);
}

export function classpilotRestrictionAuthPassThroughEnvelope(options: {
  gateActive: boolean;
  policyRevision: number;
  policy: ClasspilotSsoPolicy;
}): ClasspilotRestrictionAuthPassThroughEnvelope | null {
  const defaultProfileId = options.policy.defaultProfileId;
  if (!options.gateActive || !options.policy.enabled || !defaultProfileId) return null;
  return {
    schemaVersion: 1,
    policyRevision: classpilotRestrictionAuthProjectionRevision(options),
    defaultProfileId,
    attemptTtlSeconds: options.policy.attemptTtlSeconds,
    profiles: options.policy.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      startUrl: profile.startUrl,
      hostRules: profile.hostRules.map((rule) => ({
        hostname: rule.hostname,
        includeSubdomains: rule.includeSubdomains,
      })),
    })),
  };
}

export type ClasspilotClassroomStateSnapshot = {
  schemaVersion: 1;
  revision: number;
  teachingSessionId: string | null;
  supervisionContextId?: string | null;
  receivedAt: string;
  scheduledEndAt: string | null;
  hardExpiresAt: string;
  /**
   * Server-derived delivery metadata. Deferred origin is separate from the
   * login-only portal request; ordinary live updates never request portal
   * entry. Both are released only to an exact capable binding.
   */
  deliveryContext?: { lateSignInRestrictionSso?: true; portalFirstOnLogin?: true };
  /**
   * School-authoritative, exact-binding authentication exception for a
   * Waypoint or Flight Path. This is intentionally separate from the legacy
   * deferred-origin marker: live restrictions receive the same policy.
   */
  authPassThrough?: ClasspilotRestrictionAuthPassThroughEnvelope;
  /**
   * Monotonic school-policy fence for same-control-revision reconciliation.
   * Present on exact-bound Waypoint/Flight Path snapshots, including policy-
   * disabled and operator-gate rollback tombstones with no envelope.
   */
  authPassThroughPolicyRevision?: number;
  restrictions: {
    screenLock: {
      active: boolean;
      url?: string | null;
      domain?: string | null;
      /**
       * "This resource only" Waypoint (preciseRestrictionResourcesV1): one
       * section or resource whose canonical URL is `url`. Raw stored values
       * are kept verbatim through every normalization; a delivery snapshot
       * carries only a re-validated canonical copy, and only to an exact
       * binding that accepted the capability.
       */
      resource?: unknown;
    };
    flightPath: {
      active: boolean;
      /** Website hostnames, the only part ClassPilot 2.9.x enforces. */
      allowedDomains: string[];
      name?: string | null;
      /** Section and resource entries of a precise Flight Path (see screenLock.resource). */
      resources?: unknown;
    };
    blockList: { active: boolean; blockedDomains: string[]; name?: string | null };
    attentionMode: { active: boolean; message?: string };
    tabLimit: number | null;
    temporaryAllows: Array<{ domain: string; expiresAt: string }>;
    focus?: ClasspilotFocusRestriction;
  };
};

export type ClasspilotLateSignInAppliedBinding = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  revision: number;
  appliedAt: string;
};

export type ClasspilotLateSignInDeliveryProvenance = {
  origin: "deferred";
  originCommandId: string;
  originCreatedAt: string;
  appliedBindings: ClasspilotLateSignInAppliedBinding[];
};

export type ClasspilotExactStudentBinding = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};

const MAX_APPLIED_BINDINGS = 32;

export type ClasspilotControlEnforcementHealth =
  | "synced"
  | "pending"
  | "failed"
  | "unsupported"
  | "expired";

const EMPTY_RESTRICTIONS: ClasspilotClassroomStateSnapshot["restrictions"] = {
  screenLock: { active: false },
  flightPath: { active: false, allowedDomains: [] },
  blockList: { active: false, blockedDomains: [] },
  attentionMode: { active: false },
  tabLimit: null,
  temporaryAllows: [],
};

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function ruleLimitExceeded(): never {
  throw Object.assign(new Error("Classroom rule lists cannot contain more than 1,000 entries"), {
    status: 400,
    code: "CLASSROOM_RULE_LIMIT_EXCEEDED",
  });
}

function stringList(value: unknown, max = 1_000): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > max) ruleLimitExceeded();
  const normalized = [...new Set(value
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean))];
  return normalized;
}

function positiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Precise restriction resources (roadmap PR 2; fence from PR 2-pre). A precise
 * Waypoint is stored as `screenLock.resource` and precise Flight Path entries
 * as `flightPath.resources`, in classroom-state rows, desired snapshots and
 * command payloads. Dropping either key would widen a single-document
 * Waypoint into a lock on its whole domain (ClassPilot 2.9.x derives the
 * domain from `url`) and turn a resource-only Flight Path into an empty one.
 *
 * Presence rule: any value other than `undefined` counts, valid or not, and is
 * preserved verbatim through every normalization. A snapshot carrying either
 * key is delivered only to an exact binding whose negotiated (accepted, never
 * advertised) capabilities include preciseRestrictionResourcesV1, and only
 * when every carried entry re-validates. Everything else is withheld whole.
 */
export const CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON =
  "Unsupported client: preciseRestrictionResourcesV1 is required";
export const CLASSPILOT_PRECISE_RESTRICTION_ENFORCEMENT_UNAVAILABLE_REASON =
  "Extension update required for this Waypoint or Flight Path";

function carriesPreciseRestrictionKey(value: unknown, key: "resource" | "resources"): boolean {
  const source = objectValue(value);
  return Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined;
}

function preservedScreenLockResource(screenLock: unknown): { resource?: unknown } {
  return carriesPreciseRestrictionKey(screenLock, "resource")
    ? { resource: objectValue(screenLock).resource }
    : {};
}

function preservedFlightPathResources(flightPath: unknown): { resources?: unknown } {
  return carriesPreciseRestrictionKey(flightPath, "resources")
    ? { resources: objectValue(flightPath).resources }
    : {};
}

/** True when a restrictions object carries a precise-resource key, valid or not. */
export function classpilotRestrictionsRequirePreciseCapability(restrictions: unknown): boolean {
  const source = objectValue(restrictions);
  return carriesPreciseRestrictionKey(source.screenLock, "resource")
    || carriesPreciseRestrictionKey(source.flightPath, "resources");
}

/** Reads a desired snapshot (or a serialized classroom state) the way the serializer does. */
export function classpilotControlStateRequiresPreciseCapability(desiredState: unknown): boolean {
  const desired = objectValue(desiredState);
  return classpilotRestrictionsRequirePreciseCapability(desired.restrictions ?? desired);
}

/** Only Waypoint and Flight Path payloads can carry precise resources. */
export function classpilotCommandPayloadRequiresPreciseCapability(
  commandType: string,
  payload: unknown
): boolean {
  if (commandType === "lock-screen") return carriesPreciseRestrictionKey(payload, "resource");
  if (commandType === "apply-flight-path") return carriesPreciseRestrictionKey(payload, "resources");
  return false;
}

export type ClasspilotPreciseRestrictionPayload =
  | { state: "none" }
  | { state: "invalid" }
  | {
      state: "valid";
      screenLockResource?: PreciseAllowedResource;
      flightPathResources?: AllowedResource[];
    };

/**
 * Re-validates the precise keys of a restrictions object exactly as stored.
 * A Waypoint resource must be a section or resource on an active Waypoint
 * whose `url` is its canonical URL; Flight Path resources must be a valid,
 * non-empty list on an active path. Anything else is "invalid" and withholds
 * the whole snapshot: an entry is never dropped or degraded to its host.
 */
export function classpilotPreciseRestrictionPayload(restrictions: unknown): ClasspilotPreciseRestrictionPayload {
  const source = objectValue(restrictions);
  const screenLock = objectValue(source.screenLock);
  const flightPath = objectValue(source.flightPath);
  const hasResource = carriesPreciseRestrictionKey(screenLock, "resource");
  const hasResources = carriesPreciseRestrictionKey(flightPath, "resources");
  if (!hasResource && !hasResources) return { state: "none" };
  let screenLockResource: PreciseAllowedResource | undefined;
  let flightPathResources: AllowedResource[] | undefined;
  if (hasResource) {
    const resource = validateAllowedResource(screenLock.resource);
    if (
      !resource
      || resource.type === "website"
      || screenLock.active !== true
      || !isWaypointLandingUrl(screenLock.url, resource)
    ) return { state: "invalid" };
    screenLockResource = resource;
  }
  if (hasResources) {
    const resources = validateAllowedResourceList(flightPath.resources);
    if (!resources || resources.length === 0 || flightPath.active !== true) return { state: "invalid" };
    flightPathResources = resources;
  }
  return {
    state: "valid",
    ...(screenLockResource ? { screenLockResource } : {}),
    ...(flightPathResources ? { flightPathResources } : {}),
  };
}

/**
 * Whether a desired snapshot's precise restriction cannot be delivered to a
 * client with these negotiated capabilities (teacher DTO and health): any
 * invalid precise payload, or a valid one without the accepted capability.
 */
export function classpilotPreciseRestrictionCapabilityRequired(options: {
  desiredState: unknown;
  acceptedCapabilities: readonly string[];
}): boolean {
  const desired = objectValue(options.desiredState);
  const precise = classpilotPreciseRestrictionPayload(desired.restrictions ?? desired);
  if (precise.state === "none") return false;
  return precise.state === "invalid"
    || !options.acceptedCapabilities.includes(PRECISE_RESTRICTION_RESOURCES_CAPABILITY);
}

export function readClasspilotLateSignInDeliveryProvenance(
  desiredState: unknown
): ClasspilotLateSignInDeliveryProvenance | null {
  const source = objectValue(objectValue(desiredState).lateSignInDelivery);
  if (source.origin !== "deferred") return null;
  const originCommandId = String(source.originCommandId || "").trim();
  const originCreatedAt = iso(source.originCreatedAt);
  if (!originCommandId || !originCreatedAt) return null;
  const appliedBindings = Array.isArray(source.appliedBindings)
    ? source.appliedBindings.slice(-MAX_APPLIED_BINDINGS).flatMap((entry) => {
        const binding = objectValue(entry);
        const schoolId = String(binding.schoolId || "").trim();
        const studentId = String(binding.studentId || "").trim();
        const studentSessionId = String(binding.studentSessionId || "").trim();
        const deviceId = String(binding.deviceId || "").trim();
        const revision = Number(binding.revision);
        const appliedAt = iso(binding.appliedAt);
        return schoolId && studentId && studentSessionId && deviceId
          && Number.isSafeInteger(revision) && revision > 0 && appliedAt
          ? [{ schoolId, studentId, studentSessionId, deviceId, revision, appliedAt }]
          : [];
      })
    : [];
  return { origin: "deferred", originCommandId, originCreatedAt, appliedBindings };
}

export function classpilotControlStateHasLateSignInOrigin(desiredState: unknown): boolean {
  return readClasspilotLateSignInDeliveryProvenance(desiredState) !== null;
}

export function withClasspilotLateSignInOrigin(options: {
  desiredState: unknown;
  commandId: string;
  createdAt?: Date;
}): Record<string, unknown> {
  const desired = objectValue(options.desiredState);
  const existing = readClasspilotLateSignInDeliveryProvenance(desired);
  return {
    ...desired,
    lateSignInDelivery: existing ?? {
      origin: "deferred",
      originCommandId: options.commandId,
      originCreatedAt: (options.createdAt ?? new Date()).toISOString(),
      appliedBindings: [],
    },
  };
}

export function recordClasspilotLateSignInAppliedBinding(options: {
  desiredState: unknown;
  binding: ClasspilotExactStudentBinding;
  revision: number;
  appliedAt?: Date;
}): Record<string, unknown> {
  const desired = objectValue(options.desiredState);
  const provenance = readClasspilotLateSignInDeliveryProvenance(desired);
  if (!provenance) return desired;
  const withoutExactBinding = provenance.appliedBindings.filter((entry) => !(
    entry.schoolId === options.binding.schoolId
    && entry.studentId === options.binding.studentId
    && entry.studentSessionId === options.binding.studentSessionId
    && entry.deviceId === options.binding.deviceId
  ));
  return {
    ...desired,
    lateSignInDelivery: {
      ...provenance,
      appliedBindings: [...withoutExactBinding, {
        ...options.binding,
        revision: options.revision,
        appliedAt: (options.appliedAt ?? new Date()).toISOString(),
      }].slice(-MAX_APPLIED_BINDINGS),
    },
  };
}

export function classpilotLateSignInRevisionAppliedToBinding(options: {
  desiredState: unknown;
  binding: ClasspilotExactStudentBinding | null;
  revision: number;
}): boolean {
  const provenance = readClasspilotLateSignInDeliveryProvenance(options.desiredState);
  const binding = options.binding;
  if (!provenance || !binding?.studentSessionId || !binding.deviceId) return false;
  return provenance.appliedBindings.some((entry) =>
    entry.schoolId === binding.schoolId
    && entry.studentId === binding.studentId
    && entry.studentSessionId === binding.studentSessionId
    && entry.deviceId === binding.deviceId
    && entry.revision === options.revision
  );
}

export function emptyClasspilotRestrictions(): ClasspilotClassroomStateSnapshot["restrictions"] {
  return structuredClone(EMPTY_RESTRICTIONS);
}

export function normalizeClasspilotRestrictions(value: unknown): ClasspilotClassroomStateSnapshot["restrictions"] {
  const source = objectValue(value);
  const screenLock = objectValue(source.screenLock);
  const flightPath = objectValue(source.flightPath);
  const blockList = objectValue(source.blockList);
  const attentionMode = objectValue(source.attentionMode);
  const temporaryAllows = Array.isArray(source.temporaryAllows)
    ? source.temporaryAllows.flatMap((entry) => {
        const item = objectValue(entry);
        const domain = String(item.domain || "").trim().toLowerCase();
        const expiresAt = iso(item.expiresAt);
        return domain && expiresAt ? [{ domain, expiresAt }] : [];
      })
    : [];
  if (temporaryAllows.length > 1_000) ruleLimitExceeded();
  return {
    screenLock: {
      active: screenLock.active === true,
      ...(screenLock.url ? { url: String(screenLock.url).slice(0, 4_096) } : {}),
      ...(screenLock.domain ? { domain: String(screenLock.domain).slice(0, 253) } : {}),
      ...preservedScreenLockResource(screenLock),
    },
    flightPath: {
      active: flightPath.active === true,
      allowedDomains: stringList(flightPath.allowedDomains),
      ...(flightPath.name ? { name: String(flightPath.name).slice(0, 256) } : {}),
      ...preservedFlightPathResources(flightPath),
    },
    blockList: {
      active: blockList.active === true,
      blockedDomains: stringList(blockList.blockedDomains),
      ...(blockList.name ? { name: String(blockList.name).slice(0, 256) } : {}),
    },
    attentionMode: {
      active: attentionMode.active === true,
      ...(attentionMode.message ? { message: String(attentionMode.message).slice(0, 500) } : {}),
    },
    tabLimit: positiveInteger(source.tabLimit),
    temporaryAllows,
    // Preserve even malformed carried Focus; the delivery validator withholds
    // it whole instead of silently converting an active assignment to a clear.
    ...(source.focus !== undefined ? { focus: source.focus as ClasspilotFocusRestriction } : {}),
  };
}

export function applyClasspilotControlCommand(
  previous: unknown,
  commandType: string,
  payloadValue: unknown,
  now = new Date()
): ClasspilotClassroomStateSnapshot["restrictions"] {
  const restrictions = normalizeClasspilotRestrictions(previous);
  const payload = objectValue(payloadValue);
  switch (commandType) {
    case "lock-screen":
      restrictions.screenLock = {
        active: true,
        url: payload.url ? String(payload.url).slice(0, 4_096) : null,
        ...preservedScreenLockResource(payload),
      };
      // Screen Lock overlays the independently configured Flight Path. The
      // lock wins while active, and a canonical screen-only unlock reveals
      // the retained path instead of silently widening browsing access.
      break;
    case "unlock-screen":
      restrictions.screenLock = { active: false };
      if (payload.screenOnly !== true) {
        restrictions.flightPath = { active: false, allowedDomains: [] };
      }
      break;
    case "apply-flight-path":
      restrictions.screenLock = { active: false };
      restrictions.flightPath = {
        active: true,
        allowedDomains: stringList(payload.allowedDomains),
        ...(payload.flightPathName ? { name: String(payload.flightPathName).slice(0, 256) } : {}),
        ...preservedFlightPathResources(payload),
      };
      break;
    case "remove-flight-path":
      restrictions.flightPath = { active: false, allowedDomains: [] };
      break;
    case "apply-block-list":
      restrictions.blockList = {
        active: true,
        blockedDomains: stringList(payload.blockedDomains),
        ...(payload.blockListName ? { name: String(payload.blockListName).slice(0, 256) } : {}),
      };
      break;
    case "remove-block-list":
      restrictions.blockList = { active: false, blockedDomains: [] };
      break;
    case "attention-mode":
      restrictions.attentionMode = payload.active === false
        ? { active: false }
        : { active: true, ...(payload.message ? { message: String(payload.message).slice(0, 500) } : {}) };
      break;
    case "limit-tabs":
      restrictions.tabLimit = positiveInteger(payload.maxTabs);
      break;
    case "temp-unblock": {
      const domain = String(payload.domain || "").trim().toLowerCase();
      const explicitExpiry = iso(payload.expiresAt);
      const duration = Math.min(720, Math.max(1, Number(payload.durationMinutes) || 5));
      const expiresAt = explicitExpiry || new Date(now.getTime() + duration * 60_000).toISOString();
      restrictions.temporaryAllows = restrictions.temporaryAllows
        .filter((entry) => entry.domain !== domain && Date.parse(entry.expiresAt) > now.getTime());
      if (domain) restrictions.temporaryAllows.push({ domain, expiresAt });
      if (restrictions.temporaryAllows.length > 1_000) ruleLimitExceeded();
      break;
    }
  }
  return restrictions;
}

export function restrictionsFromClassroomStates(
  states: ClasspilotClassroomState[],
  now = new Date()
): ClasspilotClassroomStateSnapshot["restrictions"] {
  let restrictions = emptyClasspilotRestrictions();
  for (const state of states) {
    if (state.expiresAt && state.expiresAt <= now) continue;
    const payload = objectValue(state.payload);
    switch (state.stateType) {
      case "screen-lock":
        restrictions = applyClasspilotControlCommand(restrictions, "lock-screen", payload, now);
        break;
      case "flight-path":
        restrictions = applyClasspilotControlCommand(restrictions, "apply-flight-path", payload, now);
        break;
      case "block-list":
        restrictions = applyClasspilotControlCommand(restrictions, "apply-block-list", payload, now);
        break;
      case "attention":
        restrictions = applyClasspilotControlCommand(restrictions, "attention-mode", payload, now);
        break;
      case "tab-limit":
        restrictions = applyClasspilotControlCommand(restrictions, "limit-tabs", payload, now);
        break;
      case "temporary-allow":
        restrictions = applyClasspilotControlCommand(restrictions, "temp-unblock", {
          ...payload,
          expiresAt: state.expiresAt,
        }, now);
        break;
    }
  }
  return restrictions;
}

export function serializeClasspilotStudentControlState(
  state: ClasspilotStudentControlState,
  now = new Date()
): ClasspilotClassroomStateSnapshot {
  const desired = objectValue(state.desiredState);
  const hardExpiry = state.hardExpiresAt || new Date(now.getTime() + 12 * 60 * 60_000);
  const effectiveExpiry = [state.scheduledEndAt, state.hardExpiresAt]
    .filter((value): value is Date => !!value)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  const expired = !!effectiveExpiry && effectiveExpiry.getTime() <= now.getTime();
  return {
    schemaVersion: CLASSPILOT_CLASSROOM_STATE_SCHEMA_VERSION,
    revision: state.revision,
    teachingSessionId: state.teachingSessionId,
    supervisionContextId: state.supervisionContextId,
    receivedAt: now.toISOString(),
    scheduledEndAt: iso(state.scheduledEndAt),
    hardExpiresAt: hardExpiry.toISOString(),
    // The stored snapshot remains immutable audit state, but an expired class
    // must always reconcile to an empty restriction set. The extension also
    // enforces these deadlines locally, so either side can safely recover
    // after being offline when the deadline passes.
    restrictions: expired
      ? emptyClasspilotRestrictions()
      : normalizeClasspilotRestrictions(desired.restrictions ?? desired),
  };
}

/**
 * Fail-closed serializer for an extension delivery surface. Deferred-origin
 * state is never exposed (including its revision) unless all three pieces of
 * authority agree: the exact-school operator gate, the negotiated client
 * capability, and the current exact student/session/device binding.
 */
export function serializeClasspilotStudentControlStateForDelivery(options: {
  state: ClasspilotStudentControlState;
  gateActive: boolean;
  acceptedCapabilities: readonly string[];
  exactBinding: ClasspilotExactStudentBinding | null;
  authPassThrough?: {
    gateActive: boolean;
    policyRevision: number;
    policy: ClasspilotSsoPolicy;
  };
  /** Only the exact authenticated login-response transaction may set this. */
  portalFirstOnLogin?: true;
  now?: Date;
}): {
  classroomState: ClasspilotClassroomStateSnapshot | null;
  withheld: boolean;
  withheldReason?:
    | "late_sign_in_capability_required"
    | "restriction_auth_update_required"
    | "precise_restriction_capability_required"
    | "focus_tab_capability_required";
} {
  const provenance = readClasspilotLateSignInDeliveryProvenance(options.state.desiredState);
  const exact = options.exactBinding;
  const exactBindingAuthorized = !!exact
    && !!exact.studentSessionId
    && !!exact.deviceId
    && exact.schoolId === options.state.schoolId
    && exact.studentId === options.state.studentId;
  if (provenance) {
    // Aggregate counters only: no URL, school, student, device, session, or
    // command identity is attached. Sampling every actual delivery inspection
    // makes rollback/off observations and the still-stamped backlog visible.
    recordHeartbeatHotPathCounter("lateSignInStampedInspection");
    if (!options.gateActive) recordHeartbeatHotPathCounter("lateSignInRollback");
    const authorized = options.gateActive
      && options.acceptedCapabilities.includes("lateSignInRestrictionSsoV1")
      && exactBindingAuthorized;
    if (!authorized) {
      return {
        classroomState: null,
        withheld: true,
        withheldReason: "late_sign_in_capability_required",
      };
    }
  }
  let classroomState = serializeClasspilotStudentControlState(options.state, options.now);
  let restrictions = classroomState.restrictions;
  if (restrictions.focus !== undefined) {
    const focus = readFocusRestriction(restrictions);
    const assignment = readFocusAssignment(options.state.desiredState);
    if (!focus || (focus.active && (!assignment || assignment.assignmentId !== focus.assignmentId
      || !exact || !focusCapabilityAccepted(options.acceptedCapabilities)
      || !focusAssignmentMatches({ assignment, ...exact,
        teachingSessionId: options.state.teachingSessionId,
        supervisionContextId: options.state.supervisionContextId })))) {
      return { classroomState: null, withheld: true, withheldReason: "focus_tab_capability_required" };
    }
    restrictions = { ...restrictions, focus };
    classroomState = { ...classroomState, restrictions };
  }
  // Precise restriction resources reach only an exact binding that accepted
  // preciseRestrictionResourcesV1, and only when every carried entry
  // re-validates. Anything else withholds the whole snapshot (never a host
  // fallback). An expired snapshot has already serialized to the empty set
  // above, so its clear still reaches every device.
  const precise = classpilotPreciseRestrictionPayload(restrictions);
  if (precise.state !== "none") {
    if (
      precise.state === "invalid"
      || !exactBindingAuthorized
      || !options.acceptedCapabilities.includes(PRECISE_RESTRICTION_RESOURCES_CAPABILITY)
    ) {
      recordHeartbeatHotPathCounter("preciseRestrictionDeliveryWithheld");
      return {
        classroomState: null,
        withheld: true,
        withheldReason: "precise_restriction_capability_required",
      };
    }
    restrictions = {
      ...restrictions,
      screenLock: precise.screenLockResource
        ? { ...restrictions.screenLock, resource: precise.screenLockResource }
        : restrictions.screenLock,
      flightPath: precise.flightPathResources
        ? { ...restrictions.flightPath, resources: precise.flightPathResources }
        : restrictions.flightPath,
    };
    classroomState = { ...classroomState, restrictions };
    recordHeartbeatHotPathCounter("preciseRestrictionCapableDelivery");
  }
  const stillRestricted = restrictions.screenLock.active
    || restrictions.flightPath.active
    || restrictions.blockList.active
    || restrictions.attentionMode.active
    || restrictions.tabLimit !== null
    || restrictions.temporaryAllows.length > 0
    || restrictions.focus?.active === true;
  let deliveredState = stillRestricted && provenance
    ? { ...classroomState, deliveryContext: { lateSignInRestrictionSso: true } as const }
    : classroomState;

  const auth = options.authPassThrough;
  const authRelevantRestriction = restrictions.flightPath.active
    || (restrictions.screenLock.active && !!restrictions.screenLock.url);
  if (
    auth
    && authRelevantRestriction
    && exactBindingAuthorized
  ) {
    deliveredState = {
      ...deliveredState,
      authPassThroughPolicyRevision: classpilotRestrictionAuthProjectionRevision(auth),
    };
  }
  const restrictionAuthCapabilityRequired = !!auth
    && authRelevantRestriction
    && classpilotRestrictionAuthCapabilityRequired({
      desiredState: options.state.desiredState,
      gateActive: auth.gateActive,
      policy: auth.policy,
    });
  if (auth && restrictionAuthCapabilityRequired) {
    const authEnvelope = classpilotRestrictionAuthPassThroughEnvelope(auth);
    const authAuthorized = exactBindingAuthorized
      && options.acceptedCapabilities.includes("restrictionAuthPassThroughV1")
      && !!authEnvelope;
    if (!authAuthorized) {
      recordHeartbeatHotPathCounter("restrictionAuthDeliveryWithheld");
      return {
        classroomState: null,
        withheld: true,
        withheldReason: "restriction_auth_update_required",
      };
    }
    deliveredState = {
      ...deliveredState,
      authPassThrough: authEnvelope!,
      ...(options.portalFirstOnLogin === true
        && options.acceptedCapabilities.includes("restrictionPortalFirstV1") ? {
          deliveryContext: {
            ...deliveredState.deliveryContext,
            portalFirstOnLogin: true as const,
          },
        } : {}),
    };
    recordHeartbeatHotPathCounter("restrictionAuthCapableDelivery");
  }

  return {
    // An expired stamped row still reconciles an exact capable client to the
    // empty revision, but it must not trigger the cold Clever/SSO landing flow.
    // Provenance remains durable audit history. The database-backed rollback
    // gauge excludes this row after its effective expiry because only this
    // empty revision can be serialized from then on.
    classroomState: deliveredState,
    withheld: false,
  };
}

export function classpilotRestrictionAuthCapabilityRequired(options: {
  desiredState: unknown;
  gateActive: boolean;
  policy: ClasspilotSsoPolicy;
}): boolean {
  if (!options.gateActive || !options.policy.enabled) return false;
  return classpilotControlStateHasAuthRelevantRestriction(options.desiredState);
}

export function classpilotControlStateHasAuthRelevantRestriction(
  desiredState: unknown
): boolean {
  const desired = desiredState && typeof desiredState === "object"
    && !Array.isArray(desiredState)
    ? desiredState as Record<string, unknown>
    : {};
  const restrictions = normalizeClasspilotRestrictions(
    desired.restrictions ?? desired
  );
  return restrictions.flightPath.active
    || (restrictions.screenLock.active && !!restrictions.screenLock.url);
}

export function effectiveClasspilotControlEnforcementHealth(
  state: ClasspilotStudentControlState,
  extensionVersion: unknown,
  now = new Date(),
  delivery?: {
    gateActive: boolean;
    acceptedCapabilities: readonly string[];
    exactBinding: ClasspilotExactStudentBinding | null;
    restrictionAuthCapabilityRequired?: boolean;
    restrictionAuthPolicyRevision?: number | null;
    appliedAuthPolicyRevision?: number | null;
    /** Set by the teacher DTO beside restrictionAuthCapabilityRequired. */
    preciseRestrictionCapabilityRequired?: boolean;
  }
): ClasspilotControlEnforcementHealth {
  const effectiveExpiry = [state.scheduledEndAt, state.hardExpiresAt]
    .filter((value): value is Date => !!value)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  if (effectiveExpiry && effectiveExpiry.getTime() <= now.getTime()) return "expired";
  const focusValue = focusRecord(focusRecord(state.desiredState).restrictions).focus;
  if (focusValue !== undefined) {
    const focus = readFocusRestriction(focusRecord(state.desiredState).restrictions);
    const assignment = readFocusAssignment(state.desiredState);
    if (!focus || (focus.active && (!delivery?.exactBinding
      || !focusCapabilityAccepted(delivery.acceptedCapabilities)
      || !assignment || assignment.assignmentId !== focus.assignmentId
      || !focusAssignmentMatches({ assignment, ...delivery.exactBinding,
        teachingSessionId: state.teachingSessionId, supervisionContextId: state.supervisionContextId })))) return "unsupported";
  }

  // A precise-resource snapshot that this binding cannot receive (invalid, or
  // preciseRestrictionResourcesV1 not accepted) is never synced to it,
  // whatever an earlier ACK or another binding recorded.
  if (
    delivery?.preciseRestrictionCapabilityRequired
    || classpilotPreciseRestrictionCapabilityRequired({
      desiredState: state.desiredState,
      acceptedCapabilities: delivery?.acceptedCapabilities ?? [],
    })
  ) return "unsupported";

  // A previously delivered strict restriction can outlive a school policy
  // activation. Once sign-in-safe projection is required, a client without the
  // currently accepted capability is unsupported even if it ACKed this same
  // revision before the policy changed.
  if (
    delivery?.restrictionAuthCapabilityRequired
    && !delivery.acceptedCapabilities.includes("restrictionAuthPassThroughV1")
  ) {
    return "unsupported";
  }
  if (
    delivery?.acceptedCapabilities.includes("restrictionAuthPassThroughV1")
    && typeof delivery.restrictionAuthPolicyRevision === "number"
    && Number.isSafeInteger(delivery.restrictionAuthPolicyRevision)
    && delivery.appliedAuthPolicyRevision !== delivery.restrictionAuthPolicyRevision
  ) {
    return "pending";
  }

  const deferred = readClasspilotLateSignInDeliveryProvenance(state.desiredState);
  if (deferred) {
    // A row-global ACK is not evidence for a replacement or older binding.
    // Deferred truth is exact-binding truth: clients that did not negotiate
    // the feature are unsupported, capable bindings remain pending until this
    // precise revision is recorded for them, and only then may the stored ACK
    // outcome be projected.
    if (!delivery?.gateActive
      || !delivery.acceptedCapabilities.includes("lateSignInRestrictionSsoV1")) {
      return "unsupported";
    }
    if (!classpilotLateSignInRevisionAppliedToBinding({
      desiredState: state.desiredState,
      binding: delivery.exactBinding,
      revision: state.revision,
    })) {
      return "pending";
    }
    return state.enforcementHealth as ClasspilotControlEnforcementHealth;
  }

  // Full-state reconciliation ships in 2.6.0. During the mixed-version
  // rollout, an older extension must be described as unsupported rather than
  // left indefinitely pending or reported as synchronized.
  const match = typeof extensionVersion === "string"
    ? /^(\d+)\.(\d+)\.(\d+)/.exec(extensionVersion.trim())
    : null;
  // Missing/unparseable versions are not evidence of snapshot support. Keep
  // mixed-version reporting fail-closed instead of inheriting a stale synced
  // value from an earlier device/session.
  if (!match) return "unsupported";
  const version = match.slice(1).map(Number);
  const supportsSnapshots = version[0]! > 2
    || (version[0] === 2 && (version[1]! > 6 || (version[1] === 6 && version[2]! >= 0)));
  if (!supportsSnapshots) return "unsupported";
  return state.enforcementHealth as ClasspilotControlEnforcementHealth;
}
