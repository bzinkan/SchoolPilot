import { z } from "zod";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";

export const FOCUS_TAB_CAPABILITY = "focusTabV1" as const;
const boundedId = z.string().trim().min(1).max(128);
export const exactTabTargetSchema = z.object({
  studentId: boundedId,
  tabRef: boundedId,
  observedRevision: z.number().int().positive().safe(),
}).strict();
export type ClasspilotExactTabTarget = z.infer<typeof exactTabTargetSchema>;

const activeFocusSchema = z.object({
  active: z.literal(true), assignmentId: boundedId, tabRef: boundedId,
  observedRevision: z.number().int().positive().safe(),
  targetKind: z.enum(["snapshot", "open_receipt"]),
  source: z.literal("teacher"), setAt: z.string().datetime(),
}).strict();
export const focusRestrictionSchema = z.union([
  activeFocusSchema, z.object({ active: z.literal(false) }).strict(),
]);
export type ClasspilotFocusRestriction = z.infer<typeof focusRestrictionSchema>;
export type ClasspilotActiveFocus = z.infer<typeof activeFocusSchema>;

const assignmentSchema = z.object({
  version: z.literal(1), assignmentId: boundedId, schoolId: boundedId, studentId: boundedId,
  studentSessionId: boundedId, deviceId: boundedId, serverOrigin: z.string().max(2048),
  teachingSessionId: boundedId.nullable(), supervisionContextId: boundedId.nullable(),
  ownerId: boundedId, contextAuthorityRevision: boundedId.nullable(),
  sourceCommandId: boundedId, sourceTargetId: boundedId,
  revisionAtAssignment: z.number().int().positive().safe(),
}).strict();
export type ClasspilotFocusAssignment = z.infer<typeof assignmentSchema>;

export const focusStatusSchema = z.union([
  z.object({ state: z.literal("inactive") }).strict(),
  z.object({ assignmentId: boundedId, state: z.literal("active") }).strict(),
  z.object({ assignmentId: boundedId, state: z.literal("suspended"),
    reason: z.enum(["attention", "authentication", "browser_operation_pending"]) }).strict(),
  z.object({ assignmentId: boundedId, state: z.literal("invalidated"),
    reason: z.enum(["focus_tab_closed", "focus_tab_missing", "focus_tab_off_policy"]) }).strict(),
]);
export type ClasspilotFocusStatus = z.infer<typeof focusStatusSchema>;
export const focusOpenReceiptSchema = z.object({
  tabReceiptVersion: z.literal(1), tabRef: boundedId,
  tabSnapshotRevision: z.number().int().positive().safe(),
}).strict();

const intentSchema = z.object({
  version: z.literal(1), assignmentId: boundedId, childCommandId: boundedId,
  deadline: z.string().datetime(), state: z.enum(["pending", "committed", "refused", "expired"]),
  binding: assignmentSchema,
  childRevision: z.number().int().positive().safe().optional(),
  errorCode: boundedId.optional(),
}).strict();
export type ClasspilotFocusOpenIntent = z.infer<typeof intentSchema>;

export function focusRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export function readFocusAssignment(desiredState: unknown): ClasspilotFocusAssignment | null {
  const parsed = assignmentSchema.safeParse(focusRecord(desiredState).focusAssignmentV1);
  return parsed.success ? parsed.data : null;
}
export function readFocusCleanup(desiredState: unknown): ClasspilotFocusAssignment | null {
  const parsed = assignmentSchema.safeParse(focusRecord(desiredState).focusCleanupV1);
  return parsed.success ? parsed.data : null;
}
export function readFocusOpenIntent(result: unknown): ClasspilotFocusOpenIntent | null {
  const parsed = intentSchema.safeParse(focusRecord(result).focusOpenIntentV1);
  return parsed.success ? parsed.data : null;
}
export function readFocusRestriction(restrictions: unknown): ClasspilotFocusRestriction | null {
  const parsed = focusRestrictionSchema.safeParse(focusRecord(restrictions).focus);
  return parsed.success ? parsed.data : null;
}
export function focusCapabilityAccepted(accepted: readonly string[]): boolean {
  return accepted.includes(FOCUS_TAB_CAPABILITY) && accepted.includes("scopedAuthorityChecksV1");
}
export function focusAuthoringEnabled(schoolId: string): boolean {
  return isClasspilotCapabilityActive(FOCUS_TAB_CAPABILITY, { schoolId })
    && isClasspilotCapabilityActive("scopedAuthorityChecksV1", { schoolId });
}
export function focusServerOrigin(): string {
  return new URL(process.env.PUBLIC_BASE_URL || process.env.CLIENT_URL || "http://localhost:4000").origin;
}
export function focusAssignmentMatches(options: {
  assignment: ClasspilotFocusAssignment; schoolId: string; studentId: string;
  studentSessionId: string; deviceId: string;
  teachingSessionId: string | null; supervisionContextId: string | null;
}): boolean {
  const a = options.assignment;
  return a.schoolId === options.schoolId && a.studentId === options.studentId
    && a.studentSessionId === options.studentSessionId && a.deviceId === options.deviceId
    && a.teachingSessionId === options.teachingSessionId
    && a.supervisionContextId === options.supervisionContextId && a.serverOrigin === focusServerOrigin();
}

/** Remove active, private and saved Focus together. Other restrictions survive. */
export function withoutClasspilotFocus(value: unknown): Record<string, unknown> {
  const desired = { ...focusRecord(value) };
  delete desired.focusAssignmentV1;
  delete desired.focusCleanupV1;
  delete desired.focusStatusV1;
  const restrictions = { ...focusRecord(desired.restrictions ?? desired) };
  delete restrictions.focus;
  // Canonical stored snapshots have a restrictions wrapper. Preserve it even
  // for old bare input so cleanup never moves unrelated fields into authority.
  if (Object.hasOwn(desired, "restrictions")) desired.restrictions = restrictions;
  else delete desired.focus;
  if (desired.restorableClassState) {
    const saved = { ...focusRecord(desired.restorableClassState) };
    saved.desiredState = withoutClasspilotFocus(saved.desiredState);
    desired.restorableClassState = saved;
  }
  return desired;
}

export function focusStatusChanged(desiredState: unknown, statusValue: unknown): boolean {
  const status = focusStatusSchema.safeParse(statusValue);
  return status.success && JSON.stringify(status.data)
    !== JSON.stringify(focusRecord(desiredState).focusStatusV1);
}

/** Exact commands never expand a class/subgroup and never accept receipt proof. */
export function assertExactFocusTargetScope(commandType: string, targetScope: string,
  requestedStudentIds: unknown, targets: readonly ClasspilotExactTabTarget[]): void {
  if (commandType !== "focus-tab" && commandType !== "activate-tab") return;
  const ids = Array.isArray(requestedStudentIds) ? requestedStudentIds : [];
  const rowIds = targets.map(row => row.studentId);
  if (targetScope !== "students" || !ids.length || ids.some(id => typeof id !== "string")
    || new Set(ids).size !== ids.length || new Set(rowIds).size !== rowIds.length
    || ids.length !== rowIds.length || ids.some(id => !rowIds.includes(id))) {
    throw Object.assign(new Error("Exact tab actions require matching explicit student targets"), {
      status: 400, code: "TAB_TARGET_OUTSIDE_COMMAND_SCOPE",
    });
  }
}
