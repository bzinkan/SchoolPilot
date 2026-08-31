import type { StudentSession } from "../schema/classpilot.js";
import {
  CLASSPILOT_REALTIME_BATCH_SIZE,
  CLASSPILOT_REALTIME_EXPIRED_AFTER_MS,
  CLASSPILOT_REALTIME_STALE_AFTER_MS,
  readClasspilotRealtimeStatusBatch,
  readLocalClasspilotRealtimeStatusBatch,
  type ClasspilotRealtimeBinding,
  type ClasspilotRealtimeStatus,
} from "./classpilotRealtimeStatus.js";
import { getActiveSessionsForStudents } from "./storage.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";

export type ClasspilotCoverageStatus = {
  status: "online" | "idle" | "offline";
  isLoggedIn: boolean;
  loginState: "logged_in" | "not_logged_in";
  lastSeenAt: number | null;
  activeTabTitle: string;
  activeTabUrl: string;
  allOpenTabs: Array<{
    tabRef?: string;
    title: string;
    url: string;
    favIconUrl: string;
    active: boolean;
  }>;
  tabSnapshot: { schemaVersion: 1; revision: number } | null;
  tabSnapshotRevision: number | null;
  extensionVersion: string | null;
  clientProtocolVersion: number | null;
  capabilities: {
    exactTabCloseV1: boolean;
    exactTabCloseV2: boolean;
    screenOnlyUnlockV1: boolean;
    fabStateRevisionV1: boolean;
    liveViewNegotiationV1: boolean;
    domainPreservingRestrictionsV1: boolean;
    studentAuthGatePresenceV1: boolean;
    lateSignInRestrictionSsoV1: boolean;
    minExtensionVersion: "2.6.0";
  };
  screenshotHealth: ClasspilotRealtimeStatus["screenshotHealth"];
  operatorCapabilities: {
    studentAuthGatePresenceV1: boolean;
    lateSignInRestrictionSsoV1: boolean;
  };
  studentAuthGatePresenceV1Enabled: boolean;
  lateSignInRestrictionSsoV1Enabled: boolean;
};

type CoverageHydrationMetrics = {
  requests: number;
  students: number;
  sessionSqlStatements: number;
  realtimeRedisCommands: number;
  durationMs: number;
};

type CoverageHydrationSession = Pick<
  StudentSession,
  "id" | "studentId" | "deviceId" | "lastSeenAt"
>;

const metrics: CoverageHydrationMetrics = {
  requests: 0,
  students: 0,
  sessionSqlStatements: 0,
  realtimeRedisCommands: 0,
  durationMs: 0,
};

function sessionTimestamp(session: CoverageHydrationSession): number {
  const value = session.lastSeenAt;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function newestSessionsByStudent(sessions: readonly CoverageHydrationSession[]) {
  const byStudent = new Map<string, CoverageHydrationSession>();
  for (const session of sessions) {
    const current = byStudent.get(session.studentId);
    if (!current || sessionTimestamp(session) > sessionTimestamp(current)) {
      byStudent.set(session.studentId, session);
    }
  }
  return byStudent;
}

function coverageRealtimeCapabilities(status: ClasspilotRealtimeStatus | null) {
  const capabilities = new Set(status?.extensionCapabilities || []);
  const acceptedCapabilities = new Set(status?.acceptedCapabilities || []);
  return {
    exactTabCloseV1: capabilities.has("exactTabCloseV1"),
    exactTabCloseV2: acceptedCapabilities.has("exactTabCloseV2"),
    screenOnlyUnlockV1: capabilities.has("screenOnlyUnlockV1"),
    fabStateRevisionV1: capabilities.has("fabStateRevisionV1"),
    liveViewNegotiationV1: capabilities.has("liveViewNegotiationV1"),
    domainPreservingRestrictionsV1: capabilities.has("domainPreservingRestrictionsV1"),
    studentAuthGatePresenceV1: capabilities.has("studentAuthGatePresenceV1"),
    lateSignInRestrictionSsoV1: capabilities.has("lateSignInRestrictionSsoV1"),
    minExtensionVersion: "2.6.0" as const,
  };
}

function sanitizeTabs(status: ClasspilotRealtimeStatus | null) {
  return (status?.allOpenTabs || []).map((tab) => ({
    ...(tab.tabRef ? { tabRef: tab.tabRef } : {}),
    title: tab.title || "",
    url: tab.url || "",
    favIconUrl: tab.favicon || "",
    active: !!tab.active,
  }));
}

function publicStatus(
  session: CoverageHydrationSession | undefined,
  candidate: ClasspilotRealtimeStatus | null,
  now: number,
  operatorCapabilities: ClasspilotCoverageStatus["operatorCapabilities"]
): ClasspilotCoverageStatus {
  const realtime = candidate?.state === "active" ? candidate : null;
  const signedOut = candidate?.state === "signed_out";
  const isLoggedIn = !!session && !signedOut;
  const sessionLastSeenAt = session ? sessionTimestamp(session) : Number.NaN;
  const lastSeenAt = candidate?.observedAt ||
    (Number.isFinite(sessionLastSeenAt) ? sessionLastSeenAt : null);
  const age = lastSeenAt ? now - lastSeenAt : Infinity;
  return {
    status: signedOut
      ? "offline"
      : age < CLASSPILOT_REALTIME_STALE_AFTER_MS
        ? "online"
        : age < CLASSPILOT_REALTIME_EXPIRED_AFTER_MS
          ? "idle"
          : "offline",
    isLoggedIn,
    loginState: isLoggedIn ? "logged_in" : "not_logged_in",
    lastSeenAt,
    activeTabTitle: realtime?.activeTabTitle || "",
    activeTabUrl: realtime?.activeTabUrl || "",
    allOpenTabs: sanitizeTabs(realtime),
    tabSnapshot: realtime
      ? { schemaVersion: 1, revision: realtime.tabSnapshotRevision ?? realtime.revision }
      : null,
    tabSnapshotRevision: realtime?.tabSnapshotRevision ?? realtime?.revision ?? null,
    extensionVersion: realtime?.extensionVersion ?? null,
    clientProtocolVersion: realtime?.clientProtocolVersion ?? null,
    capabilities: coverageRealtimeCapabilities(realtime),
    screenshotHealth: realtime?.screenshotHealth,
    operatorCapabilities,
    studentAuthGatePresenceV1Enabled: operatorCapabilities.studentAuthGatePresenceV1,
    lateSignInRestrictionSsoV1Enabled: operatorCapabilities.lateSignInRestrictionSsoV1,
  };
}

/**
 * Bulk-hydrates exact student/session/device bindings. For 500 students this
 * performs at most one session SQL statement and one Redis MGET (plus a
 * process-local fallback read that has no I/O). Returned values contain no
 * device or student-session identifiers.
 */
export async function hydrateClasspilotCoverageStatuses(options: {
  schoolId: string;
  studentIds: readonly string[];
  knownSessions?: readonly CoverageHydrationSession[];
  now?: number;
}): Promise<Map<string, ClasspilotCoverageStatus>> {
  const startedAt = performance.now();
  const studentIds = [...new Set(options.studentIds.map(String).filter(Boolean))];
  const sessionsByStudent = newestSessionsByStudent(options.knownSessions || []);
  const missingStudentIds = studentIds.filter((id) => !sessionsByStudent.has(id));
  let sessionSqlStatements = 0;
  if (missingStudentIds.length > 0) {
    sessionSqlStatements = 1;
    const loaded = await getActiveSessionsForStudents(options.schoolId, missingStudentIds);
    for (const [studentId, session] of newestSessionsByStudent(loaded)) {
      sessionsByStudent.set(studentId, session);
    }
  }

  const bindings: ClasspilotRealtimeBinding[] = [];
  for (const studentId of studentIds) {
    const session = sessionsByStudent.get(studentId);
    if (!session) continue;
    bindings.push({
      studentId,
      studentSessionId: session.id,
      deviceId: session.deviceId,
    });
  }

  const shared = bindings.length > 0
    ? await readClasspilotRealtimeStatusBatch(options.schoolId, bindings)
    : new Map();
  const local = bindings.length > 0
    ? readLocalClasspilotRealtimeStatusBatch(options.schoolId, bindings)
    : new Map();
  const candidateByStudent = new Map<string, ClasspilotRealtimeStatus>();
  for (const binding of bindings) {
    const sharedResult = shared.get(binding.studentId);
    const localResult = local.get(binding.studentId);
    const candidate = sharedResult?.status === "hit"
      ? sharedResult.snapshot
      : localResult?.status === "hit"
        ? localResult.snapshot
        : null;
    if (candidate) candidateByStudent.set(binding.studentId, candidate);
  }

  const now = options.now ?? Date.now();
  const operatorCapabilities = {
    studentAuthGatePresenceV1: isClasspilotCapabilityActive(
      "studentAuthGatePresenceV1",
      { schoolId: options.schoolId }
    ),
    lateSignInRestrictionSsoV1: isClasspilotCapabilityActive(
      "lateSignInRestrictionSsoV1",
      { schoolId: options.schoolId }
    ),
  };
  const result = new Map<string, ClasspilotCoverageStatus>();
  for (const studentId of studentIds) {
    result.set(
      studentId,
      publicStatus(
        sessionsByStudent.get(studentId),
        candidateByStudent.get(studentId) || null,
        now,
        operatorCapabilities
      )
    );
  }

  metrics.requests += 1;
  metrics.students += studentIds.length;
  metrics.sessionSqlStatements += sessionSqlStatements;
  metrics.realtimeRedisCommands += bindings.length > 0
    ? Math.ceil(bindings.length / CLASSPILOT_REALTIME_BATCH_SIZE)
    : 0;
  metrics.durationMs += performance.now() - startedAt;
  return result;
}

export function snapshotClasspilotCoverageHydrationMetrics(options: {
  reset?: boolean;
} = {}): CoverageHydrationMetrics {
  const snapshot = { ...metrics };
  if (options.reset) {
    metrics.requests = 0;
    metrics.students = 0;
    metrics.sessionSqlStatements = 0;
    metrics.realtimeRedisCommands = 0;
    metrics.durationMs = 0;
  }
  return snapshot;
}

const coverageHydrationMetricsTimer = setInterval(() => {
  const snapshot = snapshotClasspilotCoverageHydrationMetrics({ reset: true });
  if (snapshot.requests === 0) return;
  // Fixed-name aggregate counters only. Never add school, student, session,
  // device, token, URL, or request identifiers to this event.
  console.log(JSON.stringify({
    event: "classpilot_coverage_hydration_hot_path",
    intervalSeconds: 60,
    ...snapshot,
  }));
}, 60_000);
coverageHydrationMetricsTimer.unref?.();
