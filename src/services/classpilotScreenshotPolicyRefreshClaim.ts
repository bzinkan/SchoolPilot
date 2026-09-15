import { createHash } from "node:crypto";

export type ClasspilotScreenshotPolicyRefreshReason =
  | "activated"
  | "scope_changed"
  | "released";

/**
 * Hash the complete, sorted target set into the coalescing namespace. The key
 * carries no identifiers, but disjoint cohorts cannot suppress one another.
 */
export function classpilotScreenshotPolicyRefreshClaimDigest(options: {
  schoolId: string;
  teachingSessionId?: string;
  supervisionContextId?: string;
  reason: ClasspilotScreenshotPolicyRefreshReason;
  studentIds: readonly string[];
}): string {
  const targetSet = [...new Set(options.studentIds.map(String).filter(Boolean))].sort();
  if (Boolean(options.teachingSessionId) === Boolean(options.supervisionContextId)) throw new Error("One screenshot refresh authority is required");
  return createHash("sha256")
    .update([
      options.schoolId,
      options.supervisionContextId ? `supervision:${options.supervisionContextId}` : options.teachingSessionId,
      options.reason,
      ...targetSet,
    ].join("\u001f"))
    .digest("base64url");
}
