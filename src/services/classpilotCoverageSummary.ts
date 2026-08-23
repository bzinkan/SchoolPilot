import { createHash } from "node:crypto";
import { broadcastToTeachersLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";

export type ClasspilotCoverageSummary = {
  revision: string;
  availableStudentCount: number;
  claimedStudentCount: number;
  activeContextCount: number;
};

export function classpilotCoverageSummaryRevision(options: {
  availableStudentIds: readonly string[];
  claimedStudentIds: readonly string[];
  contexts: readonly { id: string; updatedAt?: Date | string | null }[];
}): string {
  const identity = JSON.stringify({
    available: [...new Set(options.availableStudentIds)].sort(),
    claimed: [...new Set(options.claimedStudentIds)].sort(),
    contexts: options.contexts
      .map((context): [string, string] => [
        context.id,
        context.updatedAt instanceof Date
          ? context.updatedAt.toISOString()
          : String(context.updatedAt || ""),
      ])
      .sort((left, right) => left[0].localeCompare(right[0])),
  });
  return `coverage-v1:${createHash("sha256").update(identity).digest("base64url")}`;
}

/**
 * Broadcasts only an invalidation revision. Visibility-specific counts are
 * always refetched under the recipient's own tenant/role authorization.
 */
export function publishClasspilotCoverageSummaryUpdated(schoolId: string): void {
  if (!schoolId) return;
  const message = {
    type: "coverage-summary-updated",
    revision: `event-v1:${Date.now().toString(36)}`,
  };
  broadcastToTeachersLocal(schoolId, message);
  void publishWS({ kind: "staff", schoolId }, message);
}
