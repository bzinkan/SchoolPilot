/** Observe subscriptions expose monitoring only, never classroom conversations or responses. */
export function classpilotObserverEvent(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const input = message as Record<string, unknown>;
  const common = ["type", "teachingSessionId", "supervisionContextId", "contextAuthorityRevision"];
  const fields = input.type === "screenshot-available"
    ? [...common, "studentId", "capturedAt", "timestamp", "controlRevision"]
    : ["student-update", "student-signed-out", "ai-classification"].includes(String(input.type))
      ? [...common, "studentId", "schoolId", "timestamp", "schemaVersion", "eventVersion", "realtimeBinding",
        "realtimeRevision", "realtimeObservedAt", "revision", "observedAtMs", "reason", "extensionVersion", "clientProtocolVersion", "activityFresh",
        "activityState", "monitoringState", "monitoringLostAt", "status", "visibilityState", "classificationPending",
        "openTabCount", "tabsTruncated", "activeTabUrl", "activeTabTitle", "classifiedUrl", "favicon", "screenLocked",
        "flightPathActive", "activeFlightPathName", "isSharing", "isScreenSharing", "isScreenRecording", "cameraActive"]
      : ["session-ended", "supervision-context-ended", "classroom-authority-changed", "student-session-ended"].includes(String(input.type))
        ? [...common, "studentId", "timestamp", "reason"] : null;
  if (!fields) return null;
  // Scalar-only projection also prevents future nested payloads from widening access.
  const result = Object.fromEntries(fields.filter(key => input[key] === null || ["string", "number", "boolean"].includes(typeof input[key]))
    .map(key => [key, input[key]]));
  if (["student-update", "ai-classification"].includes(String(input.type))) {
    for (const [key, allowed] of [
      ["classification", ["category", "contentCategory", "teacherIntentSource"]],
      ["aiClassification", ["category", "contentCategory", "teacherIntentSource"]],
      ["screenshotHealth", ["lastSuccessAt", "lastErrorAt", "lastError", "attempts", "successes", "alarmActive",
        "lastSuccessfulHeartbeatAt", "screenshotPolicySource", "screenshotPolicyAdoptedAt", "lastCaptureAttemptAt"]],
      ["acceptedCapabilities", ["scheduledClassroomV1", "scopedAuthorityChecksV1", "screenshotActiveObservationCadenceV1"]],
    ] as const) {
      const value = input[key];
      if (value === null) { result[key] = null; continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const entries = allowed.filter(field => record[field] === null || ["string", "number", "boolean"].includes(typeof record[field]))
        .map(field => [field, record[field]]);
      if (entries.length) result[key] = Object.fromEntries(entries);
    }
  }
  return result;
}
