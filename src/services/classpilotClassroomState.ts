import type {
  ClasspilotClassroomState,
  ClasspilotStudentControlState,
} from "../schema/classpilot.js";
import { recordHeartbeatHotPathCounter } from "./heartbeatHotPathMetrics.js";

export const CLASSPILOT_CLASSROOM_STATE_SCHEMA_VERSION = 1 as const;

export type ClasspilotClassroomStateSnapshot = {
  schemaVersion: 1;
  revision: number;
  teachingSessionId: string | null;
  supervisionContextId?: string | null;
  receivedAt: string;
  scheduledEndAt: string | null;
  hardExpiresAt: string;
  /**
   * Server-derived delivery metadata. This marker is intentionally absent
   * from ordinary live classroom state. It is emitted only when durable
   * deferred-origin state is released to an exact capable binding.
   */
  deliveryContext?: { lateSignInRestrictionSso: true };
  restrictions: {
    screenLock: { active: boolean; url?: string | null; domain?: string | null };
    flightPath: { active: boolean; allowedDomains: string[]; name?: string | null };
    blockList: { active: boolean; blockedDomains: string[]; name?: string | null };
    attentionMode: { active: boolean; message?: string };
    tabLimit: number | null;
    temporaryAllows: Array<{ domain: string; expiresAt: string }>;
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
    },
    flightPath: {
      active: flightPath.active === true,
      allowedDomains: stringList(flightPath.allowedDomains),
      ...(flightPath.name ? { name: String(flightPath.name).slice(0, 256) } : {}),
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
  now?: Date;
}): { classroomState: ClasspilotClassroomStateSnapshot | null; withheld: boolean } {
  const provenance = readClasspilotLateSignInDeliveryProvenance(options.state.desiredState);
  if (!provenance) {
    return {
      classroomState: serializeClasspilotStudentControlState(options.state, options.now),
      withheld: false,
    };
  }
  // Aggregate counters only: no URL, school, student, device, session, or
  // command identity is attached. Sampling every actual delivery inspection
  // makes rollback/off observations and the still-stamped backlog visible.
  recordHeartbeatHotPathCounter("lateSignInStampedInspection");
  if (!options.gateActive) recordHeartbeatHotPathCounter("lateSignInRollback");
  const exact = options.exactBinding;
  const authorized = options.gateActive
    && options.acceptedCapabilities.includes("lateSignInRestrictionSsoV1")
    && !!exact
    && !!exact.studentSessionId
    && !!exact.deviceId
    && exact.schoolId === options.state.schoolId
    && exact.studentId === options.state.studentId;
  if (!authorized) return { classroomState: null, withheld: true };
  const classroomState = serializeClasspilotStudentControlState(options.state, options.now);
  const restrictions = classroomState.restrictions;
  const stillRestricted = restrictions.screenLock.active
    || restrictions.flightPath.active
    || restrictions.blockList.active
    || restrictions.attentionMode.active
    || restrictions.tabLimit !== null
    || restrictions.temporaryAllows.length > 0;
  return {
    // An expired stamped row still reconciles an exact capable client to the
    // empty revision, but it must not trigger the cold Clever/SSO landing flow.
    // Provenance remains durable audit history. The database-backed rollback
    // gauge excludes this row after its effective expiry because only this
    // empty revision can be serialized from then on.
    classroomState: stillRestricted
      ? { ...classroomState, deliveryContext: { lateSignInRestrictionSso: true } }
      : classroomState,
    withheld: false,
  };
}

export function effectiveClasspilotControlEnforcementHealth(
  state: ClasspilotStudentControlState,
  extensionVersion: unknown,
  now = new Date(),
  delivery?: {
    gateActive: boolean;
    acceptedCapabilities: readonly string[];
    exactBinding: ClasspilotExactStudentBinding | null;
  }
): ClasspilotControlEnforcementHealth {
  const effectiveExpiry = [state.scheduledEndAt, state.hardExpiresAt]
    .filter((value): value is Date => !!value)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  if (effectiveExpiry && effectiveExpiry.getTime() <= now.getTime()) return "expired";

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
