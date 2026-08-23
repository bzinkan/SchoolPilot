import type { AiClassification } from "./aiClassification.js";
import type {
  ClasspilotRealtimeMutationResult,
  ClasspilotRealtimeStatus,
} from "./classpilotRealtimeStatus.js";
import { classpilotExactTabCloseVersion } from "./classpilotExactTabCapability.js";

export type ClasspilotSafetyAction = {
  snapshot: ClasspilotRealtimeStatus;
  classifiedUrl: string;
  classifiedTitle: string;
  teachingSessionId: string | null;
  exactTabCloseVersion: 1 | 2 | null;
  closeTabData:
    | { tabRefs: [string]; snapshotRevision: number }
    | { specificUrls: [string] }
    | null;
  evidenceTarget: { tabRef: string; snapshotRevision: number } | null;
};

function normalizedLegacyUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Converts a safety classification into live side-effect context only when the
 * realtime store confirms that the classified heartbeat still owns the exact
 * active student/session/device binding. Historical heartbeat persistence is
 * intentionally handled before this boundary by the caller.
 */
export function resolveCurrentClasspilotSafetyAction(options: {
  classification: AiClassification;
  realtimeMutation: ClasspilotRealtimeMutationResult;
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  heartbeatId: string;
  activeTabUrl: string;
  activeTabTitle?: string;
}): ClasspilotSafetyAction | null {
  if (!options.classification.safetyAlert) return null;
  if (options.realtimeMutation.status === "stale") return null;

  const snapshot = options.realtimeMutation.snapshot;
  if (
    !snapshot
    || snapshot.state !== "active"
    || snapshot.schoolId !== options.schoolId
    || snapshot.studentId !== options.studentId
    || snapshot.studentSessionId !== options.studentSessionId
    || snapshot.deviceId !== options.deviceId
    || snapshot.heartbeatId !== options.heartbeatId
  ) {
    return null;
  }

  const classifiedUrl = String(options.activeTabUrl || "");
  if (!classifiedUrl || snapshot.activeTabUrl !== classifiedUrl) return null;

  const snapshotRevision = snapshot.tabSnapshotRevision;
  const activeTabRef = snapshot.activeTabRef;
  const exactTab = activeTabRef
    ? snapshot.allOpenTabs.find(
        (tab) => tab.tabRef === activeTabRef && tab.url === classifiedUrl
      )
    : undefined;
  const exactTabCloseVersion = classpilotExactTabCloseVersion(snapshot);
  const exactTarget = exactTabCloseVersion && exactTab?.tabRef && snapshotRevision
    ? { tabRef: exactTab.tabRef, snapshotRevision }
    : null;

  // Protocol-v2 compatibility may use a URL only when the complete snapshot
  // proves it identifies exactly one tab. Missing/truncated tab data never
  // broadens the action into closing every matching or open tab.
  const normalizedClassifiedUrl = normalizedLegacyUrl(classifiedUrl);
  const legacyMatches = normalizedClassifiedUrl && !snapshot.tabsTruncated
    ? snapshot.allOpenTabs.filter((tab) => normalizedLegacyUrl(tab.url) === normalizedClassifiedUrl)
    : [];
  const closeTabData = exactTarget
    ? { tabRefs: [exactTarget.tabRef] as [string], snapshotRevision: exactTarget.snapshotRevision }
    : exactTabCloseVersion !== 2 && legacyMatches.length === 1
      ? { specificUrls: [legacyMatches[0]!.url] as [string] }
      : null;

  return {
    snapshot,
    classifiedUrl,
    classifiedTitle: String(options.activeTabTitle || ""),
    teachingSessionId: snapshot.classroomState?.teachingSessionId ?? null,
    exactTabCloseVersion,
    closeTabData,
    evidenceTarget: exactTarget,
  };
}
