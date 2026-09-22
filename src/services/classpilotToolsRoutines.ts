import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db.js";
import { classpilotRoutineRuns, classpilotToolTemplates, classpilotTimers, classpilotLessonActivities } from "../schema/classpilotTools.js";
import { classpilotCommands, classpilotCommandTargets, polls, type InsertClasspilotCommand, type ClasspilotCommand } from "../schema/classpilot.js";
import { requireClassToolsPhase } from "../config/classpilotClassTools.js";
import { routineContent } from "./classpilotToolsValidation.js";
import { recordToolsHistory, toolsError, toolsParent, toolsRoster, toolsWhere, withToolsStaff, type ToolsScope } from "./classpilotToolsAuthority.js";
import { getActiveSessionsForStudents } from "./storage.js";
import type { ResolvedClasspilotCommandTarget } from "./classpilotCommandDispatcher.js";

export type RoutineReservation = { runId: string; expectedRevision: number; step: number; replayCommandId?: string };
type Run = typeof classpilotRoutineRuns.$inferSelect;
const commandFor = (step: Run["steps"][number]) => step.kind === "instructions" ? { type: "lesson-activity", payload: { ...step.payload, action: "start" } }
  : step.kind === "resource" ? { type: "open-tab", payload: step.payload }
    : step.kind === "flight_path" ? { type: "apply-flight-path", payload: step.payload }
      : step.kind === "timer" ? { type: "timer", payload: { ...step.payload, action: "start" } }
        : { type: "poll", payload: { ...step.payload, action: "start", purpose: step.kind === "exit_ticket" ? "exit_ticket" : "poll" } };

export async function startRoutine(scope: ToolsScope, templateId: string, targetStudentIds: string[]) {
  requireClassToolsPhase(scope.schoolId, 5);
  return withToolsStaff(scope, async database => {
    const [template] = await database.select().from(classpilotToolTemplates).where(and(eq(classpilotToolTemplates.schoolId, scope.schoolId), eq(classpilotToolTemplates.teacherId, scope.actorId), eq(classpilotToolTemplates.id, templateId), eq(classpilotToolTemplates.kind, "routine"))).limit(1);
    if (!template) throw toolsError("Routine template not found", "ROUTINE_TEMPLATE_NOT_FOUND", 404);
    const content = routineContent.parse(template.content);
    const roster = new Set((await toolsRoster(scope, database)).map(row => row.studentId));
    const targets = [...new Set(targetStudentIds)];
    if (!targets.length || targets.some(id => !roster.has(id))) throw toolsError("Choose exact students in this classroom", "ROUTINE_TARGETS_REQUIRED", 400);
    const [active] = await database.select({ id: classpilotRoutineRuns.id }).from(classpilotRoutineRuns).where(and(toolsWhere(classpilotRoutineRuns, scope), isNull(classpilotRoutineRuns.endedAt))).limit(1);
    if (active) throw toolsError("Finish or end the current routine first", "ROUTINE_ALREADY_ACTIVE");
    const [run] = await database.insert(classpilotRoutineRuns).values({ ...toolsParent(scope), teacherId: scope.actorId, ...content, targetStudentIds: targets }).returning();
    await recordToolsHistory(database, scope, "routine_started", run!.id);
    return run!;
  });
}

async function currentRun(database: typeof db, scope: ToolsScope, id: string, revision: number) {
  const [run] = await database.select().from(classpilotRoutineRuns).where(and(toolsWhere(classpilotRoutineRuns, scope), eq(classpilotRoutineRuns.id, id), eq(classpilotRoutineRuns.teacherId, scope.actorId), isNull(classpilotRoutineRuns.endedAt))).limit(1).for("update");
  if (!run || run.revision !== revision) throw toolsError("Routine changed. Refresh before advancing it.", "ROUTINE_REVISION_CONFLICT");
  return run;
}

async function retryTargets(database: typeof db, scope: ToolsScope, run: Run, step: number) {
  const outcome = run.outcomes.find(row => row.step === step);
  if (!outcome?.commandIds.length) throw toolsError("This step has no command to retry", "ROUTINE_RETRY_UNAVAILABLE");
  const commands = await database.select().from(classpilotCommands).where(and(toolsWhere(classpilotCommands, scope), inArray(classpilotCommands.id, outcome.commandIds)));
  const original = commands.find(command => command.id === outcome.commandIds[0]);
  if (!original) throw toolsError("Step history is no longer retained", "ROUTINE_RETRY_UNAVAILABLE");
  const targets = await database.select().from(classpilotCommandTargets).where(and(eq(classpilotCommandTargets.schoolId, scope.schoolId), inArray(classpilotCommandTargets.commandId, outcome.commandIds)));
  const eligible = targets.filter(row => row.commandId === original.id && row.studentSessionId && row.deviceId && !targets.some(attempt => attempt.studentId === row.studentId && (
    ["received", "completed"].includes(attempt.status) || ["requested", "sent"].includes(attempt.status) && (commands.find(command => command.id === attempt.commandId)?.expiresAt?.getTime() ?? Infinity) > Date.now())));
  if (!eligible.length) throw toolsError("No unsuccessful targets are eligible to retry yet", "ROUTINE_RETRY_UNAVAILABLE");
  const payload = original.commandPayload as Record<string, unknown>;
  if (original.commandType === "timer" || original.commandType === "lesson-activity") {
    const table = original.commandType === "timer" ? classpilotTimers : classpilotLessonActivities;
    const id = String(payload.timerId || payload.activityId || "");
    const [resource] = await database.select().from(table).where(and(toolsWhere(table, scope), eq(table.id, id), isNull(table.endedAt))).limit(1);
    if (!resource || resource.revision !== payload.revision || resource.expiresAt <= new Date()
      || ("deadline" in resource && resource.deadline && resource.deadline <= new Date())) throw toolsError("This tool has changed or ended and cannot be retried", "ROUTINE_RETRY_UNAVAILABLE");
  }
  if (original.commandType === "poll") {
    const [prompt] = await database.select().from(polls).where(and(eq(polls.schoolId, scope.schoolId), eq(polls.id, String(payload.pollId)), eq(polls.isActive, true))).limit(1);
    if (!prompt || !prompt.expiresAt || prompt.expiresAt <= new Date()) throw toolsError("The response prompt has ended", "ROUTINE_RETRY_UNAVAILABLE");
  }
  return { original, targets: eligible };
}

/** Validated again inside the command transaction, so double-clicks cannot emit two steps. */
export async function prepareRoutineCommand(database: typeof db, command: InsertClasspilotCommand, reservation: RoutineReservation, targets: Array<{ studentId: string; studentSessionId?: string | null; deviceId?: string | null }>) {
  const scope: ToolsScope = { schoolId: command.schoolId, actorId: command.teacherId, authority: command.teachingSessionId ? { teachingSessionId: command.teachingSessionId } : { supervisionContextId: command.supervisionContextId! } };
  requireClassToolsPhase(scope.schoolId, 5);
  const run = await currentRun(database, scope, reservation.runId, reservation.expectedRevision);
  const step = run.steps[reservation.step];
  if (!step || commandFor(step).type !== command.commandType) throw toolsError("Routine step does not match the command", "ROUTINE_STEP_MISMATCH");
  if (reservation.replayCommandId) {
    const retry = await retryTargets(database, scope, run, reservation.step);
    if (retry.original.id !== reservation.replayCommandId || targets.length !== retry.targets.length || targets.some(target => !retry.targets.some(original => original.studentId === target.studentId && original.studentSessionId === target.studentSessionId && original.deviceId === target.deviceId))) throw toolsError("Retry recipients changed", "ROUTINE_RETRY_UNAVAILABLE");
    return { ...command, commandPayload: { ...(retry.original.commandPayload as object), replayOfCommandId: retry.original.id } };
  }
  if (run.currentStep !== reservation.step || run.targetStudentIds.length !== targets.length || targets.some(target => !run.targetStudentIds.includes(target.studentId))) throw toolsError("Routine step or recipients changed", "ROUTINE_STEP_MISMATCH");
  return command;
}

export async function completeRoutineCommand(database: typeof db, command: ClasspilotCommand, reservation: RoutineReservation) {
  const scope: ToolsScope = { schoolId: command.schoolId, actorId: command.teacherId, authority: command.teachingSessionId ? { teachingSessionId: command.teachingSessionId } : { supervisionContextId: command.supervisionContextId! } };
  const run = await currentRun(database, scope, reservation.runId, reservation.expectedRevision);
  const prior = run.outcomes.find(row => row.step === reservation.step);
  const outcomes = [...run.outcomes.filter(row => row.step !== reservation.step), { step: reservation.step, commandIds: [...(prior?.commandIds || []), command.id], state: "attempted" as const }].sort((a, b) => a.step - b.step);
  await database.update(classpilotRoutineRuns).set({ outcomes, currentStep: reservation.replayCommandId ? run.currentStep : run.currentStep + 1, revision: run.revision + 1, updatedAt: new Date() }).where(eq(classpilotRoutineRuns.id, run.id));
  await recordToolsHistory(database, scope, reservation.replayCommandId ? "routine_step_retried" : "routine_step_attempted", run.id, { step: reservation.step, commandId: command.id });
}

export async function advanceRoutine(scope: ToolsScope, id: string, input: { action: "next" | "launch" | "skip" | "retry" | "end"; expectedRevision: number; step?: number }) {
  requireClassToolsPhase(scope.schoolId, 5);
  const prepared = await withToolsStaff(scope, async database => {
    const run = await currentRun(database, scope, id, input.expectedRevision);
    if (input.action === "end") {
      await database.update(classpilotRoutineRuns).set({ endedAt: new Date(), updatedAt: new Date(), revision: run.revision + 1 }).where(eq(classpilotRoutineRuns.id, run.id));
      await recordToolsHistory(database, scope, "routine_ended", run.id); return null;
    }
    const index = input.action === "retry" ? input.step : run.currentStep;
    if (index === undefined || !run.steps[index]) throw toolsError("No routine step remains. End this routine or retry an eligible outcome.", "ROUTINE_COMPLETE");
    const step = run.steps[index]!;
    const prompt = ["poll", "exit_ticket"].includes(step.kind);
    if (input.action === "skip" || prompt && input.action === "next") {
      const outcomes = [...run.outcomes.filter(row => row.step !== index), { step: index, commandIds: [], state: input.action === "skip" ? "skipped" as const : "prepared" as const }];
      await database.update(classpilotRoutineRuns).set({ outcomes, currentStep: run.currentStep + (input.action === "skip" ? 1 : 0), revision: run.revision + 1, updatedAt: new Date() }).where(eq(classpilotRoutineRuns.id, run.id));
      await recordToolsHistory(database, scope, input.action === "skip" ? "routine_step_skipped" : "routine_prompt_prepared", run.id, { step: index }); return null;
    }
    if (input.action === "launch" && (!prompt || !run.outcomes.some(row => row.step === index && row.state === "prepared"))) throw toolsError("Prepare this response prompt first", "ROUTINE_PROMPT_NOT_PREPARED");
    const retry = input.action === "retry" ? await retryTargets(database, scope, run, index) : null;
    return { run, index, command: commandFor(step), retry };
  });
  if (!prepared) return { ok: true };
  const { run, index, command, retry } = prepared;
  const roster = await toolsRoster(scope);
  const currentIds = new Set(roster.map(row => row.studentId));
  const bindings = await getActiveSessionsForStudents(scope.schoolId, run.targetStudentIds);
  const targets: ResolvedClasspilotCommandTarget[] = (retry ? retry.targets : run.targetStudentIds.map(studentId => ({ studentId }))).map(target => {
    const binding = bindings.find(row => row.studentId === target.studentId);
    const original = retry?.targets.find(row => row.studentId === target.studentId);
    const exact = Boolean(binding && (!original || binding.id === original.studentSessionId && binding.deviceId === original.deviceId));
    const available = currentIds.has(target.studentId) && exact;
    return { studentId: target.studentId, studentName: target.studentId, studentSessionId: original?.studentSessionId ?? binding?.id ?? null, deviceId: original?.deviceId ?? binding?.deviceId ?? null,
      available, stateAuthorized: available, unavailableReason: available ? undefined : "Student is unavailable under the original classroom authority" };
  });
  const { executeClasspilotCommand } = await import("./classpilotCommandDispatcher.js");
  const result = await executeClasspilotCommand({ schoolId: scope.schoolId, actorId: scope.actorId, ...scope.authority, contextAuthorityRevision: scope.contextAuthorityRevision,
    targetScope: "students", targets, commandType: command.type, rawCommandPayload: command.payload,
    routineReservation: { runId: run.id, expectedRevision: input.expectedRevision, step: index, ...(retry ? { replayCommandId: retry.original.id } : {}) },
    replayCommand: retry?.original });
  const { publicClasspilotCommand } = await import("./classpilotCommandPublic.js");
  return { ...result, command: publicClasspilotCommand(result.command) };
}
