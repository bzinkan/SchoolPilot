import { createHash } from "crypto";
import { redisCommand } from "../middleware/rateLimiter.js";
import type { ClasspilotClassroomStateSnapshot } from "./classpilotClassroomState.js";

export const CLASSPILOT_REALTIME_SCHEMA_VERSION = 2;
export const CLASSPILOT_REALTIME_TTL_SECONDS = 360;
export const CLASSPILOT_REALTIME_STALE_AFTER_MS = 60_000;
export const CLASSPILOT_REALTIME_EXPIRED_AFTER_MS = 300_000;
export const CLASSPILOT_REALTIME_MAX_TABS = 50;
export const CLASSPILOT_REALTIME_MAX_BYTES = 128 * 1024;
export const CLASSPILOT_REALTIME_BATCH_SIZE = 500;

const REALTIME_REDIS_TIMEOUT_MS = 250;
const REALTIME_REDIS_READY_TIMEOUT_MS = 100;
const MAX_LOCAL_SNAPSHOTS = 10_000;

type RealtimeMetrics = {
  writesStored: number;
  writesLocalFallback: number;
  writesStale: number;
  classificationStale: number;
  sharedReadHits: number;
  sharedReadMisses: number;
  sharedReadUnavailable: number;
  sharedReadRejected: number;
  localReadHits: number;
};

function emptyRealtimeMetrics(): RealtimeMetrics {
  return {
    writesStored: 0,
    writesLocalFallback: 0,
    writesStale: 0,
    classificationStale: 0,
    sharedReadHits: 0,
    sharedReadMisses: 0,
    sharedReadUnavailable: 0,
    sharedReadRejected: 0,
    localReadHits: 0,
  };
}

let realtimeMetrics = emptyRealtimeMetrics();
const realtimeMetricsTimer = setInterval(() => {
  const snapshot = realtimeMetrics;
  realtimeMetrics = emptyRealtimeMetrics();
  if (Object.values(snapshot).every((value) => value === 0)) return;
  // Process-level counters only: never include school, student, session,
  // device, URL, title, Redis key, or message payload dimensions.
  console.log(JSON.stringify({
    event: "classpilot_realtime_status",
    intervalSeconds: 60,
    ...snapshot,
  }));
}, 60_000);
realtimeMetricsTimer.unref?.();

type RedisCommand = (args: string[]) => Promise<unknown | undefined>;

export type ClasspilotActivityState = "active" | "idle" | "off" | "unknown";

export type ClasspilotRealtimeTab = {
  tabRef?: string;
  url: string;
  title: string;
  favicon?: string;
  active?: boolean;
};

export type ClasspilotScreenshotHealth = {
  lastSuccessAt: number;
  lastErrorAt: number;
  lastError: string;
  attempts: number;
  successes: number;
  alarmActive: boolean;
};

export type ClasspilotRealtimeClassification = {
  category: string;
  safetyAlert: string | null;
};

export type ClasspilotRealtimeStatus = {
  schemaVersion: typeof CLASSPILOT_REALTIME_SCHEMA_VERSION;
  state: "active" | "signed_out";
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  revision: number;
  tabSnapshotRevision?: number;
  heartbeatId: string | null;
  observedAt: number;
  activeTabUrl: string;
  activeTabTitle: string;
  favicon?: string;
  allOpenTabs: ClasspilotRealtimeTab[];
  openTabCount: number;
  tabsTruncated: boolean;
  activityState: ClasspilotActivityState;
  classroomControls: {
    screenLocked: boolean;
    flightPathActive: boolean;
    activeFlightPathName?: string;
    isSharing: boolean;
    cameraActive: boolean;
  };
  classroomState?: ClasspilotClassroomStateSnapshot;
  enforcementHealth?: "synced" | "pending" | "failed" | "unsupported" | "expired";
  screenshotHealth?: ClasspilotScreenshotHealth;
  aiClassification?: ClasspilotRealtimeClassification;
  classificationPending: boolean;
  extensionVersion?: string;
  extensionCapabilities?: string[];
  chromeVersion?: string;
  signOutReason?: string;
};

export type ClasspilotRealtimeBinding = {
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};

export type ClasspilotRealtimeReadResult =
  | { status: "hit"; snapshot: ClasspilotRealtimeStatus }
  | { status: "miss" | "unavailable" | "mismatch" | "expired" };

export type ClasspilotRealtimeWriteInput = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  heartbeatId: string;
  observedAt?: number;
  activeTabUrl?: unknown;
  activeTabTitle?: unknown;
  favicon?: unknown;
  allOpenTabs?: unknown;
  tabSnapshotRevision?: unknown;
  trackingStatus?: unknown;
  screenLocked?: unknown;
  flightPathActive?: unknown;
  activeFlightPathName?: unknown;
  isSharing?: unknown;
  cameraActive?: unknown;
  screenshotHealth?: unknown;
  classificationPending?: boolean;
  extensionVersion?: unknown;
  extensionCapabilities?: unknown;
  chromeVersion?: unknown;
  classroomState?: ClasspilotClassroomStateSnapshot;
  enforcementHealth?: "synced" | "pending" | "failed" | "unsupported" | "expired";
};

export type ClasspilotRealtimeClassificationPatch = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  heartbeatId: string;
  classification: ClasspilotRealtimeClassification | null;
};

export type ClasspilotRealtimeSignOutInput = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  reason: string;
  observedAt?: number;
};

export type ClasspilotRealtimeMutationResult = {
  status: "stored" | "local" | "stale";
  snapshot?: ClasspilotRealtimeStatus;
};

const WRITE_SCRIPT = `
local currentRaw = redis.call('GET', KEYS[1])
local currentRevision = 0
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  if ok and current then
    local incoming = cjson.decode(ARGV[2])
    local currentObservedAt = tonumber(current.observedAt) or 0
    local incomingObservedAt = tonumber(incoming.observedAt) or 0
    if (current.state == 'signed_out'
        and current.studentSessionId == incoming.studentSessionId)
      or incomingObservedAt < currentObservedAt
      or (incomingObservedAt == currentObservedAt and incoming.heartbeatId ~= current.heartbeatId) then
      return ''
    end
    currentRevision = tonumber(current.revision) or 0
  end
end
local proposedRevision = tonumber(ARGV[1]) or 0
local nextRevision = proposedRevision
if nextRevision <= currentRevision then
  nextRevision = currentRevision + 1
end
local snapshot = cjson.decode(ARGV[2])
snapshot.revision = nextRevision
local encoded = cjson.encode(snapshot)
redis.call('SET', KEYS[1], encoded, 'EX', tonumber(ARGV[3]))
return encoded
`;

const PATCH_CLASSIFICATION_SCRIPT = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then return '' end
local ok, current = pcall(cjson.decode, currentRaw)
if not ok or not current then return '' end
if current.state ~= 'active'
  or current.schoolId ~= ARGV[1]
  or current.studentId ~= ARGV[2]
  or current.studentSessionId ~= ARGV[3]
  or current.deviceId ~= ARGV[4]
  or current.heartbeatId ~= ARGV[5] then
  return ''
end
local proposedRevision = tonumber(ARGV[6]) or 0
local currentRevision = tonumber(current.revision) or 0
if proposedRevision <= currentRevision then
  proposedRevision = currentRevision + 1
end
local classification = cjson.decode(ARGV[7])
if classification == cjson.null then
  current.aiClassification = nil
else
  current.aiClassification = classification
end
current.classificationPending = false
current.revision = proposedRevision
local encoded = cjson.encode(current)
redis.call('SET', KEYS[1], encoded, 'EX', tonumber(ARGV[8]))
return encoded
`;

const SIGN_OUT_SCRIPT = `
local currentRaw = redis.call('GET', KEYS[1])
local currentRevision = 0
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  if ok and current then
    if current.schoolId ~= ARGV[1]
      or current.studentId ~= ARGV[2]
      or current.studentSessionId ~= ARGV[3]
      or current.deviceId ~= ARGV[4] then
      return ''
    end
    currentRevision = tonumber(current.revision) or 0
  end
end
local proposedRevision = tonumber(ARGV[5]) or 0
if proposedRevision <= currentRevision then
  proposedRevision = currentRevision + 1
end
local snapshot = cjson.decode(ARGV[6])
snapshot.revision = proposedRevision
local encoded = cjson.encode(snapshot)
redis.call('SET', KEYS[1], encoded, 'EX', tonumber(ARGV[7]))
return encoded
`;

async function boundedRedisCommand(args: string[]): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REALTIME_REDIS_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await redisCommand(args, {
      readyTimeoutMs: REALTIME_REDIS_READY_TIMEOUT_MS,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  const normalized = boundedString(value, maxLength).trim();
  return normalized || undefined;
}

function boundedNumber(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(Math.max(Math.trunc(numeric), minimum), maximum);
}

function normalizeActivityState(value: unknown): ClasspilotActivityState {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "active") return "active";
  if (normalized === "idle") return "idle";
  if (normalized === "off") return "off";
  return "unknown";
}

function normalizeFavicon(value: unknown): string | undefined {
  const favicon = optionalString(value, 4_096);
  if (!favicon || /^data:/i.test(favicon)) return undefined;
  return favicon;
}

function normalizeTabs(value: unknown): {
  tabs: ClasspilotRealtimeTab[];
  openTabCount: number;
  tabsTruncated: boolean;
} {
  if (!Array.isArray(value)) {
    return { tabs: [], openTabCount: 0, tabsTruncated: false };
  }
  const openTabCount = Math.min(value.length, 10_000);
  const tabs = value.slice(0, CLASSPILOT_REALTIME_MAX_TABS).map((raw) => {
    const tab = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const normalized: ClasspilotRealtimeTab = {
      url: boundedString(tab.url, 4_096),
      title: boundedString(tab.title, 512),
    };
    const tabRef = optionalString(tab.tabRef, 128);
    if (tabRef) normalized.tabRef = tabRef;
    const favicon = normalizeFavicon(tab.favicon ?? tab.favIconUrl);
    if (favicon) normalized.favicon = favicon;
    if (typeof tab.active === "boolean") normalized.active = tab.active;
    return normalized;
  });
  return {
    tabs,
    openTabCount,
    tabsTruncated: value.length > tabs.length,
  };
}

function normalizeScreenshotHealth(value: unknown): ClasspilotScreenshotHealth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const health = value as Record<string, unknown>;
  return {
    lastSuccessAt: boundedNumber(health.lastSuccessAt),
    lastErrorAt: boundedNumber(health.lastErrorAt),
    lastError: boundedString(health.lastError, 256),
    attempts: boundedNumber(health.attempts, 0, 1_000_000),
    successes: boundedNumber(health.successes, 0, 1_000_000),
    alarmActive: health.alarmActive === true,
  };
}

let revisionSequence = 0;
let lastRevisionMillisecond = 0;

function proposedRevision(now: number): number {
  const millisecond = Math.max(Math.trunc(now), 0);
  if (millisecond === lastRevisionMillisecond) {
    revisionSequence = (revisionSequence + 1) % 1_000;
  } else {
    lastRevisionMillisecond = millisecond;
    revisionSequence = 0;
  }
  return millisecond * 1_000 + revisionSequence;
}

function hashBinding(schoolId: string, deviceId: string): string {
  return createHash("sha256")
    .update(schoolId)
    .update("\u0000")
    .update(deviceId)
    .digest("base64url");
}

/**
 * Stable, non-reversible identifier for one authenticated student-session
 * binding. This is safe to expose to teacher clients and lets them distinguish
 * a newly authenticated browser from delayed events for the previous binding
 * without exposing the internal student-session or device identifiers.
 */
export function classpilotPublicRealtimeBinding(
  studentSessionId: string | null | undefined
): string | null {
  if (!studentSessionId) return null;
  return createHash("sha256")
    .update("classpilot:public-realtime-binding:v1")
    .update("\u0000")
    .update(studentSessionId)
    .digest("base64url");
}

export function classpilotRealtimeStatusKey(schoolId: string, deviceId: string): string {
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  return `${prefix}:classpilot:latest-status:${hashBinding(schoolId, deviceId)}`;
}

export function classpilotRealtimeOrderingKey(schoolId: string, deviceId: string): string {
  return `classpilot-latest-status:${hashBinding(schoolId, deviceId)}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validDecodedTab(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tab = value as Record<string, unknown>;
  return typeof tab.url === "string" && tab.url.length <= 4_096 &&
    typeof tab.title === "string" && tab.title.length <= 512 &&
    (tab.tabRef === undefined || (
      typeof tab.tabRef === "string" && tab.tabRef.length > 0 && tab.tabRef.length <= 128
    )) &&
    (tab.favicon === undefined || (
      typeof tab.favicon === "string" &&
      tab.favicon.length <= 4_096 &&
      !/^data:/i.test(tab.favicon)
    )) &&
    (tab.active === undefined || typeof tab.active === "boolean");
}

function decodeSnapshot(raw: unknown): ClasspilotRealtimeStatus | undefined {
  if (typeof raw !== "string" || raw.length > CLASSPILOT_REALTIME_MAX_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const controls = row.classroomControls as Record<string, unknown> | undefined;
  const classification = row.aiClassification &&
    typeof row.aiClassification === "object" &&
    !Array.isArray(row.aiClassification)
    ? row.aiClassification as Record<string, unknown>
    : undefined;
  if (
    row.schemaVersion !== CLASSPILOT_REALTIME_SCHEMA_VERSION ||
    (row.state !== "active" && row.state !== "signed_out") ||
    !isNonEmptyString(row.schoolId) ||
    !isNonEmptyString(row.studentId) ||
    !isNonEmptyString(row.studentSessionId) ||
    !isNonEmptyString(row.deviceId) ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    (row.tabSnapshotRevision !== undefined && (
      typeof row.tabSnapshotRevision !== "number" ||
      !Number.isSafeInteger(row.tabSnapshotRevision) ||
      Number(row.tabSnapshotRevision) < 1
    )) ||
    !(row.heartbeatId === null || typeof row.heartbeatId === "string") ||
    typeof row.observedAt !== "number" ||
    !Number.isFinite(row.observedAt) ||
    typeof row.activeTabUrl !== "string" || row.activeTabUrl.length > 4_096 ||
    typeof row.activeTabTitle !== "string" || row.activeTabTitle.length > 512 ||
    (row.favicon !== undefined && (
      typeof row.favicon !== "string" ||
      row.favicon.length > 4_096 ||
      /^data:/i.test(row.favicon)
    )) ||
    !Array.isArray(row.allOpenTabs) ||
    row.allOpenTabs.length > CLASSPILOT_REALTIME_MAX_TABS ||
    !row.allOpenTabs.every(validDecodedTab) ||
    typeof row.openTabCount !== "number" ||
    !Number.isSafeInteger(row.openTabCount) ||
    row.openTabCount < row.allOpenTabs.length ||
    typeof row.tabsTruncated !== "boolean" ||
    !["active", "idle", "off", "unknown"].includes(String(row.activityState)) ||
    !controls ||
    typeof controls.screenLocked !== "boolean" ||
    typeof controls.flightPathActive !== "boolean" ||
    typeof controls.isSharing !== "boolean" ||
    typeof controls.cameraActive !== "boolean" ||
    (controls.activeFlightPathName !== undefined && (
      typeof controls.activeFlightPathName !== "string" ||
      controls.activeFlightPathName.length > 256
    )) ||
    (row.aiClassification !== undefined && !classification) ||
    (classification !== undefined && (
      typeof classification.category !== "string" ||
      classification.category.length > 64 ||
      !(classification.safetyAlert === null || (
        typeof classification.safetyAlert === "string" &&
        classification.safetyAlert.length <= 64
      ))
    )) ||
    typeof row.classificationPending !== "boolean"
  ) {
    return undefined;
  }
  const snapshot: ClasspilotRealtimeStatus = {
    schemaVersion: CLASSPILOT_REALTIME_SCHEMA_VERSION,
    state: row.state as "active" | "signed_out",
    schoolId: row.schoolId as string,
    studentId: row.studentId as string,
    studentSessionId: row.studentSessionId as string,
    deviceId: row.deviceId as string,
    revision: row.revision as number,
    ...(Number.isSafeInteger(row.tabSnapshotRevision) && Number(row.tabSnapshotRevision) > 0
      ? { tabSnapshotRevision: Number(row.tabSnapshotRevision) }
      : {}),
    heartbeatId: row.heartbeatId as string | null,
    observedAt: row.observedAt as number,
    activeTabUrl: row.activeTabUrl as string,
    activeTabTitle: row.activeTabTitle as string,
    allOpenTabs: (row.allOpenTabs as Array<Record<string, unknown>>).map((tab) => ({
      ...(typeof tab.tabRef === "string" ? { tabRef: tab.tabRef } : {}),
      url: tab.url as string,
      title: tab.title as string,
      ...(typeof tab.favicon === "string" ? { favicon: tab.favicon } : {}),
      ...(typeof tab.active === "boolean" ? { active: tab.active } : {}),
    })),
    openTabCount: row.openTabCount as number,
    tabsTruncated: row.tabsTruncated as boolean,
    activityState: row.activityState as ClasspilotActivityState,
    classroomControls: {
      screenLocked: controls.screenLocked as boolean,
      flightPathActive: controls.flightPathActive as boolean,
      isSharing: controls.isSharing as boolean,
      cameraActive: controls.cameraActive as boolean,
      ...(typeof controls.activeFlightPathName === "string"
        ? { activeFlightPathName: controls.activeFlightPathName }
        : {}),
    },
    classificationPending: row.classificationPending as boolean,
  };
  if (typeof row.favicon === "string") snapshot.favicon = row.favicon;
  const health = normalizeScreenshotHealth(row.screenshotHealth);
  if (health) snapshot.screenshotHealth = health;
  if (classification) {
    snapshot.aiClassification = {
      category: classification.category as string,
      safetyAlert: classification.safetyAlert as string | null,
    };
  }
  if (typeof row.extensionVersion === "string") {
    snapshot.extensionVersion = boundedString(row.extensionVersion, 64);
  }
  if (Array.isArray(row.extensionCapabilities)) {
    snapshot.extensionCapabilities = row.extensionCapabilities
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .slice(0, 32)
      .map((value) => boundedString(value, 64));
  }
  if (typeof row.chromeVersion === "string") {
    snapshot.chromeVersion = boundedString(row.chromeVersion, 128);
  }
  if (typeof row.signOutReason === "string") {
    snapshot.signOutReason = boundedString(row.signOutReason, 64);
  }
  if (
    row.classroomState
    && typeof row.classroomState === "object"
    && !Array.isArray(row.classroomState)
    && Number((row.classroomState as Record<string, unknown>).schemaVersion) === 1
  ) {
    snapshot.classroomState = row.classroomState as ClasspilotClassroomStateSnapshot;
  }
  if (["synced", "pending", "failed", "unsupported", "expired"].includes(String(row.enforcementHealth))) {
    snapshot.enforcementHealth = row.enforcementHealth as ClasspilotRealtimeStatus["enforcementHealth"];
  }
  return snapshot;
}

function enforceSnapshotByteLimit(snapshot: ClasspilotRealtimeStatus): ClasspilotRealtimeStatus {
  while (
    snapshot.allOpenTabs.length > 0 &&
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") > CLASSPILOT_REALTIME_MAX_BYTES
  ) {
    snapshot.allOpenTabs.pop();
    snapshot.tabsTruncated = true;
  }
  // Desired classroom state remains authoritative in PostgreSQL and has its
  // own reconciliation path. Do not let an unusually large restriction list
  // turn the bounded latest-status cache into an oversized Redis value.
  if (
    snapshot.classroomState &&
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") > CLASSPILOT_REALTIME_MAX_BYTES
  ) {
    delete snapshot.classroomState;
  }
  return snapshot;
}

function activeSnapshot(input: ClasspilotRealtimeWriteInput, now: number): ClasspilotRealtimeStatus {
  const normalizedTabs = normalizeTabs(input.allOpenTabs);
  const snapshot: ClasspilotRealtimeStatus = {
    schemaVersion: CLASSPILOT_REALTIME_SCHEMA_VERSION,
    state: "active",
    schoolId: input.schoolId,
    studentId: input.studentId,
    studentSessionId: input.studentSessionId,
    deviceId: input.deviceId,
    revision: proposedRevision(now),
    ...(Number.isSafeInteger(Number(input.tabSnapshotRevision)) && Number(input.tabSnapshotRevision) > 0
      ? { tabSnapshotRevision: Number(input.tabSnapshotRevision) }
      : {}),
    heartbeatId: input.heartbeatId,
    observedAt: Math.max(Math.trunc(input.observedAt ?? now), 0),
    activeTabUrl: boundedString(input.activeTabUrl, 4_096),
    activeTabTitle: boundedString(input.activeTabTitle, 512),
    allOpenTabs: normalizedTabs.tabs,
    openTabCount: normalizedTabs.openTabCount,
    tabsTruncated: normalizedTabs.tabsTruncated,
    activityState: normalizeActivityState(input.trackingStatus),
    classroomControls: {
      screenLocked: input.screenLocked === true,
      flightPathActive: input.flightPathActive === true,
      isSharing: input.isSharing === true,
      cameraActive: input.cameraActive === true,
    },
    classificationPending: input.classificationPending === true,
  };
  const favicon = normalizeFavicon(input.favicon);
  const activeFlightPathName = optionalString(input.activeFlightPathName, 256);
  const screenshotHealth = normalizeScreenshotHealth(input.screenshotHealth);
  const extensionVersion = optionalString(input.extensionVersion, 64);
  const extensionCapabilities = Array.isArray(input.extensionCapabilities)
    ? [...new Set(input.extensionCapabilities
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim().slice(0, 64)))]
        .slice(0, 32)
    : [];
  const chromeVersion = optionalString(input.chromeVersion, 128);
  if (favicon) snapshot.favicon = favicon;
  if (activeFlightPathName) snapshot.classroomControls.activeFlightPathName = activeFlightPathName;
  if (screenshotHealth) snapshot.screenshotHealth = screenshotHealth;
  if (extensionVersion) snapshot.extensionVersion = extensionVersion;
  if (extensionCapabilities.length > 0) snapshot.extensionCapabilities = extensionCapabilities;
  if (chromeVersion) snapshot.chromeVersion = chromeVersion;
  if (input.classroomState) snapshot.classroomState = input.classroomState;
  if (input.enforcementHealth) snapshot.enforcementHealth = input.enforcementHealth;
  return enforceSnapshotByteLimit(snapshot);
}

function signedOutSnapshot(input: ClasspilotRealtimeSignOutInput, now: number): ClasspilotRealtimeStatus {
  return {
    schemaVersion: CLASSPILOT_REALTIME_SCHEMA_VERSION,
    state: "signed_out",
    schoolId: input.schoolId,
    studentId: input.studentId,
    studentSessionId: input.studentSessionId,
    deviceId: input.deviceId,
    revision: proposedRevision(now),
    heartbeatId: null,
    observedAt: Math.max(Math.trunc(input.observedAt ?? now), 0),
    activeTabUrl: "",
    activeTabTitle: "",
    allOpenTabs: [],
    openTabCount: 0,
    tabsTruncated: false,
    activityState: "off",
    classroomControls: {
      screenLocked: false,
      flightPathActive: false,
      isSharing: false,
      cameraActive: false,
    },
    classificationPending: false,
    signOutReason: boundedString(input.reason, 64) || "signed_out",
  };
}

function matchesBinding(
  snapshot: ClasspilotRealtimeStatus,
  schoolId: string,
  binding: ClasspilotRealtimeBinding
): boolean {
  return snapshot.schoolId === schoolId &&
    snapshot.studentId === binding.studentId &&
    snapshot.studentSessionId === binding.studentSessionId &&
    snapshot.deviceId === binding.deviceId;
}

export function createClasspilotRealtimeStatusStore(
  command: RedisCommand = boundedRedisCommand,
  now: () => number = Date.now
) {
  const localSnapshots = new Map<string, ClasspilotRealtimeStatus>();

  const saveLocal = (snapshot: ClasspilotRealtimeStatus): void => {
    const key = classpilotRealtimeStatusKey(snapshot.schoolId, snapshot.deviceId);
    const current = localSnapshots.get(key);
    if (current && snapshot.revision <= current.revision) return;
    localSnapshots.set(key, snapshot);
    if (localSnapshots.size > MAX_LOCAL_SNAPSHOTS) {
      const oldestKey = localSnapshots.keys().next().value;
      if (oldestKey) localSnapshots.delete(oldestKey);
    }
  };

  const localMutationRevision = (snapshot: ClasspilotRealtimeStatus): ClasspilotRealtimeStatus => {
    const key = classpilotRealtimeStatusKey(snapshot.schoolId, snapshot.deviceId);
    const current = localSnapshots.get(key);
    if (current && snapshot.revision <= current.revision) {
      snapshot.revision = current.revision + 1;
    }
    saveLocal(snapshot);
    return snapshot;
  };

  async function write(input: ClasspilotRealtimeWriteInput): Promise<ClasspilotRealtimeMutationResult> {
    const proposed = activeSnapshot(input, now());
    try {
      const raw = await command([
        "EVAL",
        WRITE_SCRIPT,
        "1",
        classpilotRealtimeStatusKey(input.schoolId, input.deviceId),
        String(proposed.revision),
        JSON.stringify(proposed),
        String(CLASSPILOT_REALTIME_TTL_SECONDS),
      ]);
      const stored = decodeSnapshot(raw);
      if (raw === "") {
        realtimeMetrics.writesStale += 1;
        return { status: "stale" };
      }
      if (stored && matchesBinding(stored, input.schoolId, input)) {
        saveLocal(stored);
        realtimeMetrics.writesStored += 1;
        return { status: "stored", snapshot: stored };
      }
    } catch {
      // A heartbeat remains successful during a Redis outage. The caller uses
      // this bounded process-local copy only after shared cache fallbacks.
    }
    const localCurrent = localSnapshots.get(classpilotRealtimeStatusKey(input.schoolId, input.deviceId));
    if (
      (localCurrent?.state === "signed_out"
        && localCurrent.studentSessionId === proposed.studentSessionId)
      || (localCurrent && proposed.observedAt < localCurrent.observedAt)
      || (localCurrent
        && proposed.observedAt === localCurrent.observedAt
        && proposed.heartbeatId !== localCurrent.heartbeatId)
    ) {
      realtimeMetrics.writesStale += 1;
      return { status: "stale" };
    }
    realtimeMetrics.writesLocalFallback += 1;
    return { status: "local", snapshot: localMutationRevision(proposed) };
  }

  async function patchClassification(
    patch: ClasspilotRealtimeClassificationPatch
  ): Promise<ClasspilotRealtimeMutationResult> {
    const revision = proposedRevision(now());
    try {
      const raw = await command([
        "EVAL",
        PATCH_CLASSIFICATION_SCRIPT,
        "1",
        classpilotRealtimeStatusKey(patch.schoolId, patch.deviceId),
        patch.schoolId,
        patch.studentId,
        patch.studentSessionId,
        patch.deviceId,
        patch.heartbeatId,
        String(revision),
        JSON.stringify(patch.classification),
        String(CLASSPILOT_REALTIME_TTL_SECONDS),
      ]);
      if (raw === "") {
        realtimeMetrics.classificationStale += 1;
        return { status: "stale" };
      }
      const stored = decodeSnapshot(raw);
      if (stored && matchesBinding(stored, patch.schoolId, patch)) {
        saveLocal(stored);
        return { status: "stored", snapshot: stored };
      }
    } catch {
      // Fall through to the guarded same-process copy.
    }

    const key = classpilotRealtimeStatusKey(patch.schoolId, patch.deviceId);
    const current = localSnapshots.get(key);
    if (
      !current ||
      !matchesBinding(current, patch.schoolId, patch) ||
      current.state !== "active" ||
      current.heartbeatId !== patch.heartbeatId
    ) {
      realtimeMetrics.classificationStale += 1;
      return { status: "stale" };
    }
    const next: ClasspilotRealtimeStatus = {
      ...current,
      revision: Math.max(revision, current.revision + 1),
      classificationPending: false,
    };
    if (patch.classification) next.aiClassification = patch.classification;
    else delete next.aiClassification;
    saveLocal(next);
    return { status: "local", snapshot: next };
  }

  async function markSignedOut(
    input: ClasspilotRealtimeSignOutInput
  ): Promise<ClasspilotRealtimeMutationResult> {
    const proposed = signedOutSnapshot(input, now());
    try {
      const raw = await command([
        "EVAL",
        SIGN_OUT_SCRIPT,
        "1",
        classpilotRealtimeStatusKey(input.schoolId, input.deviceId),
        input.schoolId,
        input.studentId,
        input.studentSessionId,
        input.deviceId,
        String(proposed.revision),
        JSON.stringify(proposed),
        String(CLASSPILOT_REALTIME_TTL_SECONDS),
      ]);
      if (raw === "") return { status: "stale" };
      const stored = decodeSnapshot(raw);
      if (stored && matchesBinding(stored, input.schoolId, input)) {
        saveLocal(stored);
        return { status: "stored", snapshot: stored };
      }
    } catch {
      // Fall through to the same-process tombstone.
    }

    const key = classpilotRealtimeStatusKey(input.schoolId, input.deviceId);
    const current = localSnapshots.get(key);
    if (current && !matchesBinding(current, input.schoolId, input)) {
      return { status: "stale" };
    }
    return { status: "local", snapshot: localMutationRevision(proposed) };
  }

  function qualify(
    raw: unknown,
    schoolId: string,
    binding: ClasspilotRealtimeBinding
  ): ClasspilotRealtimeReadResult {
    if (raw === null || raw === undefined) return { status: "miss" };
    const snapshot = typeof raw === "string" ? decodeSnapshot(raw) : undefined;
    if (!snapshot || !matchesBinding(snapshot, schoolId, binding)) {
      return { status: "mismatch" };
    }
    if (now() - snapshot.observedAt >= CLASSPILOT_REALTIME_EXPIRED_AFTER_MS) {
      return { status: "expired" };
    }
    return { status: "hit", snapshot };
  }

  async function readBatch(
    schoolId: string,
    bindings: readonly ClasspilotRealtimeBinding[]
  ): Promise<Map<string, ClasspilotRealtimeReadResult>> {
    const results = new Map<string, ClasspilotRealtimeReadResult>();
    const unique = [...new Map(bindings.map((binding) => [binding.studentId, binding])).values()];
    for (let offset = 0; offset < unique.length; offset += CLASSPILOT_REALTIME_BATCH_SIZE) {
      const chunk = unique.slice(offset, offset + CLASSPILOT_REALTIME_BATCH_SIZE);
      let raw: unknown;
      try {
        raw = await command([
          "MGET",
          ...chunk.map((binding) => classpilotRealtimeStatusKey(schoolId, binding.deviceId)),
        ]);
      } catch {
        raw = undefined;
      }
      if (!Array.isArray(raw) || raw.length !== chunk.length) {
        for (const binding of chunk) results.set(binding.studentId, { status: "unavailable" });
        realtimeMetrics.sharedReadUnavailable += chunk.length;
        continue;
      }
      chunk.forEach((binding, index) => {
        const result = qualify(raw[index], schoolId, binding);
        results.set(binding.studentId, result);
        if (result.status === "hit") realtimeMetrics.sharedReadHits += 1;
        else if (result.status === "miss") realtimeMetrics.sharedReadMisses += 1;
        else if (result.status === "unavailable") realtimeMetrics.sharedReadUnavailable += 1;
        else realtimeMetrics.sharedReadRejected += 1;
      });
    }
    return results;
  }

  function readLocal(
    schoolId: string,
    bindings: readonly ClasspilotRealtimeBinding[]
  ): Map<string, ClasspilotRealtimeReadResult> {
    const results = new Map<string, ClasspilotRealtimeReadResult>();
    for (const binding of bindings) {
      const snapshot = localSnapshots.get(classpilotRealtimeStatusKey(schoolId, binding.deviceId));
      const result = qualify(snapshot ? JSON.stringify(snapshot) : null, schoolId, binding);
      results.set(
        binding.studentId,
        result
      );
      if (result.status === "hit") realtimeMetrics.localReadHits += 1;
    }
    return results;
  }

  function resetLocal(): void {
    localSnapshots.clear();
  }

  return { write, patchClassification, markSignedOut, readBatch, readLocal, resetLocal };
}

const realtimeStatusStore = createClasspilotRealtimeStatusStore();

export const writeClasspilotRealtimeStatus = realtimeStatusStore.write;
export const patchClasspilotRealtimeClassification = realtimeStatusStore.patchClassification;
export const markClasspilotRealtimeSignedOut = realtimeStatusStore.markSignedOut;
export const readClasspilotRealtimeStatusBatch = realtimeStatusStore.readBatch;
export const readLocalClasspilotRealtimeStatusBatch = realtimeStatusStore.readLocal;

export function classpilotRealtimeFresh(snapshot: ClasspilotRealtimeStatus, at = Date.now()): boolean {
  return at - snapshot.observedAt < CLASSPILOT_REALTIME_STALE_AFTER_MS;
}
