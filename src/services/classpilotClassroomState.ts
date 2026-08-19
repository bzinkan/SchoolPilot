import type {
  ClasspilotClassroomState,
  ClasspilotStudentControlState,
} from "../schema/classpilot.js";

export const CLASSPILOT_CLASSROOM_STATE_SCHEMA_VERSION = 1 as const;

export type ClasspilotClassroomStateSnapshot = {
  schemaVersion: 1;
  revision: number;
  teachingSessionId: string | null;
  supervisionContextId?: string | null;
  receivedAt: string;
  scheduledEndAt: string | null;
  hardExpiresAt: string;
  restrictions: {
    screenLock: { active: boolean; url?: string | null; domain?: string | null };
    flightPath: { active: boolean; allowedDomains: string[]; name?: string | null };
    blockList: { active: boolean; blockedDomains: string[]; name?: string | null };
    attentionMode: { active: boolean; message?: string };
    tabLimit: number | null;
    temporaryAllows: Array<{ domain: string; expiresAt: string }>;
  };
};

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

export function effectiveClasspilotControlEnforcementHealth(
  state: ClasspilotStudentControlState,
  extensionVersion: unknown,
  now = new Date()
): ClasspilotControlEnforcementHealth {
  const effectiveExpiry = [state.scheduledEndAt, state.hardExpiresAt]
    .filter((value): value is Date => !!value)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  if (effectiveExpiry && effectiveExpiry.getTime() <= now.getTime()) return "expired";

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
