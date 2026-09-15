import { createHash } from "node:crypto";
import { broadcastToTeachersLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import type { ClasspilotSupervisionContext, ClasspilotSupervisionStudent } from "../schema/classpilot.js";

export type OwnTestingContextSummary = {
  id: string;
  name: string;
  endsAt: string;
  activeStudentCount: number;
};

export type OwnSupervisionContextSummary = OwnTestingContextSummary & {
  contextType: string;
  startsAt: string;
};

export type ClasspilotCoverageSummary = {
  schoolId: string;
  viewerId: string;
  revision: string;
  availableStudentCount: number;
  claimedStudentCount: number;
  activeContextCount: number;
  ownTestingContexts: OwnTestingContextSummary[];
  ownSupervisionContexts: OwnSupervisionContextSummary[];
  ownAdHocContexts?: OwnSupervisionContextSummary[];
};

/** Personal supervision includes manual claims as well as scheduled testing. */
export function ownActiveSupervisionContexts(options: {
  schoolId: string;
  viewerId: string;
  contexts: readonly Pick<ClasspilotSupervisionContext,
    "id" | "schoolId" | "name" | "contextType" | "assignedStaffId" | "status" | "startsAt" | "endsAt">[];
  activeStudents: readonly Pick<ClasspilotSupervisionStudent, "schoolId" | "contextId" | "studentId">[];
  now?: Date;
}): OwnSupervisionContextSummary[] {
  const now = options.now ?? new Date();
  const studentsByContext = new Map<string, Set<string>>();
  for (const row of options.activeStudents) {
    if (row.schoolId !== options.schoolId) continue;
    const ids = studentsByContext.get(row.contextId) ?? new Set<string>();
    ids.add(row.studentId);
    studentsByContext.set(row.contextId, ids);
  }
  return options.contexts.flatMap((context) => {
    const activeStudentCount = studentsByContext.get(context.id)?.size ?? 0;
    if (context.schoolId !== options.schoolId || context.assignedStaffId !== options.viewerId
      || context.status !== "active" || context.startsAt > now || context.endsAt <= now
      || activeStudentCount === 0) return [];
    return [{
      id: context.id, name: context.name, contextType: context.contextType,
      startsAt: context.startsAt.toISOString(), endsAt: context.endsAt.toISOString(), activeStudentCount,
    }];
  }).sort((left, right) => left.endsAt.localeCompare(right.endsAt) || left.id.localeCompare(right.id));
}

/** Navigation hints only: admin visibility never becomes a personal assignment. */
export function ownScheduledTestingContexts(options: {
  schoolId: string;
  viewerId: string;
  contexts: readonly Pick<ClasspilotSupervisionContext,
    "id" | "schoolId" | "name" | "assignedStaffId" | "status" | "startsAt" | "endsAt"
    | "scheduleProfileApplicationId" | "scheduleProfileDate" | "scheduleProfileBlockId">[];
  activeStudents: readonly Pick<ClasspilotSupervisionStudent, "schoolId" | "contextId" | "studentId">[];
  now?: Date;
}): OwnTestingContextSummary[] {
  const now = options.now ?? new Date();
  const studentsByContext = new Map<string, Set<string>>();
  for (const row of options.activeStudents) {
    if (row.schoolId !== options.schoolId) continue;
    const studentIds = studentsByContext.get(row.contextId) ?? new Set<string>();
    studentIds.add(row.studentId);
    studentsByContext.set(row.contextId, studentIds);
  }
  return options.contexts.flatMap((context) => {
    const activeStudentCount = studentsByContext.get(context.id)?.size ?? 0;
    if (context.schoolId !== options.schoolId || context.assignedStaffId !== options.viewerId
      || context.status !== "active" || context.startsAt > now || context.endsAt <= now
      || !context.scheduleProfileApplicationId || !context.scheduleProfileDate || !context.scheduleProfileBlockId
      || activeStudentCount === 0) return [];
    return [{ id: context.id, name: context.name, endsAt: context.endsAt.toISOString(), activeStudentCount }];
  }).sort((left, right) => left.endsAt.localeCompare(right.endsAt) || left.id.localeCompare(right.id));
}

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
