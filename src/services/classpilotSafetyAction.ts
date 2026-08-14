import type { AiClassification } from "./aiClassification.js";
import type {
  ClasspilotRealtimeMutationResult,
  ClasspilotRealtimeStatus,
} from "./classpilotRealtimeStatus.js";

export type ClasspilotSafetyAction = {
  snapshot: ClasspilotRealtimeStatus;
  classifiedUrl: string;
  classifiedTitle: string;
  teachingSessionId: string | null;
  closeTabData: { specificUrls: [string] };
};

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
  if (!classifiedUrl) return null;

  return {
    snapshot,
    classifiedUrl,
    classifiedTitle: String(options.activeTabTitle || ""),
    teachingSessionId: snapshot.classroomState?.teachingSessionId ?? null,
    // The classifier may use a synthetic domain such as `search:<term>` for
    // alert categorization/cooldown. Chrome must receive the actual observed
    // URL, because its specificUrls contract performs an exact URL match.
    closeTabData: { specificUrls: [classifiedUrl] },
  };
}
