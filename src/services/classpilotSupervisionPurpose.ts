import type { ClasspilotSupervisionContext } from "../schema/classpilot.js";

export type ClasspilotActivityPurpose = "class" | "testing" | "coverage" | "supervision" | "claim";
type Context = Pick<ClasspilotSupervisionContext, "name" | "contextType" | "scheduledConflictId"
  | "scheduleProfileApplicationId" | "scheduleProfileDate" | "scheduleProfileBlockId">;

/** Saved group names/membership never establish the purpose of a live activity. */
export function supervisionActivityPresentation(context: Context, assignments: readonly { source: string }[] = []) {
  const scheduledTesting = Boolean(context.scheduleProfileApplicationId && context.scheduleProfileDate && context.scheduleProfileBlockId);
  const hasScheduleMetadata = Boolean(context.scheduleProfileApplicationId || context.scheduleProfileDate || context.scheduleProfileBlockId);
  const ordinaryClaim = !hasScheduleMetadata && !context.scheduledConflictId
    && (context.contextType === "direct_pickup" || (context.contextType === "supervision_group"
      && assignments.length > 0 && assignments.every(row => ["staff_claim", "admin_assign"].includes(row.source))));
  const purpose: ClasspilotActivityPurpose = scheduledTesting || context.contextType === "state_testing" ? "testing"
    : context.scheduledConflictId ? "coverage" : ordinaryClaim ? "claim" : "supervision";
  return { purpose, contextType: context.contextType, name: ordinaryClaim ? "Claimed students" : context.name };
}
