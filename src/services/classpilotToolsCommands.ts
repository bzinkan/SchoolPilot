import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { db } from "../db.js";
import { classpilotCommands, classpilotCommandTargets, classpilotClassroomStates, type ClasspilotCommand, type InsertClasspilotCommand } from "../schema/classpilot.js";
import { classpilotTimers, classpilotLessonActivities, classpilotLessonProgress } from "../schema/classpilotTools.js";
import { requireClassToolsPhase, classToolsPhase } from "../config/classpilotClassTools.js";
import { recordToolsHistory, toolsError, toolsParent, toolsWhere, type ToolsScope } from "./classpilotToolsAuthority.js";
import { lessonContent } from "./classpilotToolsValidation.js";

const commandScope = (command: InsertClasspilotCommand): ToolsScope => ({ schoolId: command.schoolId, actorId: command.teacherId,
  authority: command.teachingSessionId ? { teachingSessionId: command.teachingSessionId } : { supervisionContextId: command.supervisionContextId! } });
export function timerRemaining(timer: { deadline: Date | null; pausedRemainingMs: number | null }, now = Date.now()) {
  return Math.max(0, timer.pausedRemainingMs ?? ((timer.deadline?.getTime() ?? now) - now));
}
export function nextTimerState(timer: { revision: number; deadline: Date | null; pausedRemainingMs: number | null; expiresAt: Date },
  action: string, seconds = 0, now = Date.now()) {
  const remaining = timerRemaining(timer, now);
  if (action !== "stop" && (remaining <= 0 || timer.expiresAt.getTime() <= now)) throw toolsError("Timer has finished", "TIMER_FINISHED");
  if (action === "pause" && timer.pausedRemainingMs != null) throw toolsError("Timer is already paused", "TIMER_ALREADY_PAUSED");
  if (action === "resume" && timer.pausedRemainingMs == null) throw toolsError("Timer is already running", "TIMER_ALREADY_RUNNING");
  const next = action === "extend" ? remaining + seconds * 1000 : remaining;
  if (next > 3600_000) throw toolsError("Timer cannot exceed 60 minutes", "TIMER_LIMIT");
  return { revision: timer.revision + 1, updatedAt: new Date(now),
    ...(action === "stop" ? { endedAt: new Date(now) } : action === "pause" || (action === "extend" && timer.pausedRemainingMs != null)
      ? { deadline: null, pausedRemainingMs: Math.min(next, timer.expiresAt.getTime() - now) }
      : { deadline: new Date(Math.min(now + next, timer.expiresAt.getTime())), pausedRemainingMs: null }) };
}

/** Invoked inside the canonical command transaction, after authority and target locks. */
export async function prepareToolsCommand(database: typeof db, command: InsertClasspilotCommand, expiresAt: Date): Promise<InsertClasspilotCommand> {
  if (!["timer", "lesson-activity"].includes(command.commandType)) return command;
  const scope = commandScope(command);
  const payload = command.commandPayload as Record<string, any>;
  if (command.commandType === "timer") {
    // Backward-compatible API can deploy with the feature dark.
    if (classToolsPhase(command.schoolId) < 2 && ["start", "stop"].includes(payload.action)) {
      // Rollback keeps legacy stop usable and tombstones retained enhanced state.
      if (payload.action === "stop") await database.update(classpilotTimers).set({ endedAt: new Date(), updatedAt: new Date(), revision: sql`${classpilotTimers.revision}+1` })
        .where(and(toolsWhere(classpilotTimers, scope), isNull(classpilotTimers.endedAt)));
      return command;
    }
    requireClassToolsPhase(command.schoolId, 2);
    const now = new Date();
    await database.update(classpilotTimers).set({ endedAt: now, updatedAt: now }).where(and(toolsWhere(classpilotTimers, scope), isNull(classpilotTimers.endedAt),
      or(lte(classpilotTimers.expiresAt, now), and(isNull(classpilotTimers.pausedRemainingMs), lte(classpilotTimers.deadline, now)))));
    const [active] = await database.select().from(classpilotTimers).where(and(toolsWhere(classpilotTimers, scope), isNull(classpilotTimers.endedAt))).limit(1).for("update");
    if (payload.action === "start") {
      if (active) throw toolsError("This classroom already has a timer. Stop it before starting another.", "TIMER_ALREADY_ACTIVE");
      return { ...command, commandPayload: { ...payload, timerId: randomUUID(), revision: 1,
        deadline: new Date(Math.min(now.getTime() + Number(payload.seconds) * 1000, expiresAt.getTime())).toISOString(), pausedRemainingMs: null, timerExpiresAt: expiresAt.toISOString() } };
    }
    if (!active) {
      if (payload.action === "stop" && !payload.timerId) return command;
      throw toolsError("Timer is no longer active", "TIMER_NOT_ACTIVE");
    }
    if ((payload.timerId && payload.timerId !== active.id) || (payload.expectedRevision !== undefined && payload.expectedRevision !== active.revision)) throw toolsError("Timer changed. Refresh before trying again.", "TIMER_REVISION_CONFLICT");
    const [updated] = await database.update(classpilotTimers).set(nextTimerState(active, payload.action, payload.seconds)).where(eq(classpilotTimers.id, active.id)).returning();
    return { ...command, commandPayload: { ...payload, timerId: active.id, revision: updated!.revision, deadline: updated!.deadline?.toISOString() ?? null,
      pausedRemainingMs: updated!.pausedRemainingMs, timerExpiresAt: updated!.expiresAt.toISOString(), message: active.message } };
  }
  requireClassToolsPhase(command.schoolId, 3);
  await database.update(classpilotLessonActivities).set({ endedAt: new Date() }).where(and(toolsWhere(classpilotLessonActivities, scope), isNull(classpilotLessonActivities.endedAt), lte(classpilotLessonActivities.expiresAt, new Date())));
  const [current] = await database.select().from(classpilotLessonActivities).where(and(toolsWhere(classpilotLessonActivities, scope), isNull(classpilotLessonActivities.endedAt))).limit(1).for("update");
  if (payload.action === "start") {
    if (current) await database.update(classpilotLessonActivities).set({ endedAt: new Date(), revision: current.revision + 1 }).where(eq(classpilotLessonActivities.id, current.id));
    return { ...command, commandPayload: { ...lessonContent.parse({ title: payload.title, instructions: payload.instructions, resources: payload.resources, checklist: payload.checklist }),
      action: "start", activityId: randomUUID(), revision: 1, activityExpiresAt: expiresAt.toISOString() } };
  }
  if (!current || current.id !== payload.activityId || current.revision !== payload.expectedRevision) throw toolsError("Lesson activity changed. Refresh before trying again.", "ACTIVITY_REVISION_CONFLICT");
  const content = payload.action === "end" ? null : lessonContent.parse({ title: payload.title, instructions: payload.instructions, resources: payload.resources, checklist: payload.checklist });
  await database.update(classpilotLessonActivities).set({ ...content, revision: current.revision + 1, updatedAt: new Date(), ...(payload.action === "end" ? { endedAt: new Date() } : {}) }).where(eq(classpilotLessonActivities.id, current.id));
  if (payload.action === "update" && content) {
    // Only unchanged items retain completion; rewording an item changes its meaning.
    const retained = content.checklist.filter(item => current.checklist.some(old => old.id === item.id && old.text === item.text)).map(item => item.id);
    await database.execute(sql`UPDATE classpilot_lesson_progress SET completed_item_ids=(SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) FROM jsonb_array_elements_text(completed_item_ids) item WHERE ${JSON.stringify(retained)}::jsonb ? item), revision=revision+1, updated_at=now() WHERE school_id=${scope.schoolId} AND lesson_activity_id=${current.id}`);
  }
  return { ...command, commandPayload: { ...payload, ...content, revision: current.revision + 1, activityExpiresAt: current.expiresAt.toISOString() } };
}

export async function persistToolsCommand(database: typeof db, command: ClasspilotCommand) {
  const payload = command.commandPayload as Record<string, any>;
  const scope = commandScope(command);
  if (command.commandType === "timer" && payload.timerId) {
    if (payload.action === "start") await database.insert(classpilotTimers).values({ ...toolsParent(scope), id: payload.timerId,
      startCommandId: command.id, message: payload.message || "", deadline: new Date(payload.deadline), expiresAt: new Date(payload.timerExpiresAt) });
    await recordToolsHistory(database, scope, `timer_${payload.action}`, payload.timerId, { commandId: command.id });
  }
  if (command.commandType === "lesson-activity") {
    if (payload.action === "start") await database.insert(classpilotLessonActivities).values({ ...toolsParent(scope), id: payload.activityId,
      startCommandId: command.id, ...lessonContent.parse({ title: payload.title, instructions: payload.instructions, resources: payload.resources, checklist: payload.checklist }), expiresAt: new Date(payload.activityExpiresAt) });
    await recordToolsHistory(database, scope, `activity_${payload.action}`, payload.activityId, { commandId: command.id });
  }
}

/** A control continues targeting the exact original start bindings. */
export async function frozenToolsTargets(database: typeof db, scope: ToolsScope, commandType: string, payload: Record<string, any>) {
  const table = commandType === "timer" ? classpilotTimers : classpilotLessonActivities;
  const id = commandType === "timer" ? payload.timerId : payload.activityId;
  const [resource] = await database.select().from(table).where(and(toolsWhere(table, scope), id ? eq(table.id, id) : isNull(table.endedAt))).limit(1);
  const [command] = resource ? await database.select().from(classpilotCommands).where(and(eq(classpilotCommands.schoolId, scope.schoolId), eq(classpilotCommands.id, resource.startCommandId))).limit(1)
    : commandType === "timer" && payload.action === "stop" && !id ? await database.select().from(classpilotCommands).where(and(toolsWhere(classpilotCommands, scope), eq(classpilotCommands.commandType, "timer"), sql`${classpilotCommands.commandPayload}->>'action'='start'`)).orderBy(desc(classpilotCommands.createdAt)).limit(1) : [];
  if (!command && commandType === "timer" && payload.action === "stop" && !id) return { targetScope: "students" as const, subgroupId: null, targets: [], resourceId: null, revision: null };
  if (!command) throw toolsError("Original recipients are unavailable", "TOOLS_TARGET_AUTHORITY_MISSING");
  const targets = await database.select().from(classpilotCommandTargets).where(and(eq(classpilotCommandTargets.schoolId, scope.schoolId), eq(classpilotCommandTargets.commandId, command.id)));
  return { resourceId: resource?.id ?? null, revision: resource?.revision ?? null, targetScope: command.targetScope, subgroupId: command.subgroupId, targets: targets.map(target => ({ studentId: target.studentId, studentName: target.studentId,
    studentSessionId: target.studentSessionId, deviceId: target.deviceId, available: target.status !== "unavailable" && Boolean(target.deviceId && target.studentSessionId),
    stateAuthorized: target.status !== "unavailable", unavailableReason: target.status === "unavailable" ? "Student was unavailable when the tool started" : undefined })) };
}

export async function frozenAttentionTargets(database: typeof db, scope: ToolsScope) {
  const rows = await database.select({ target: classpilotCommandTargets }).from(classpilotClassroomStates)
    .innerJoin(classpilotCommandTargets, and(eq(classpilotCommandTargets.schoolId, scope.schoolId), eq(classpilotCommandTargets.commandId, classpilotClassroomStates.commandId), eq(classpilotCommandTargets.studentId, classpilotClassroomStates.studentId)))
    .where(and(toolsWhere(classpilotClassroomStates, scope), eq(classpilotClassroomStates.stateType, "attention"), isNull(classpilotClassroomStates.clearedAt)));
  const unique = new Map(rows.map(({ target }) => [target.studentId, target]));
  return { targetScope: "students" as const, subgroupId: null, targets: [...unique.values()].map(target => ({ studentId: target.studentId, studentName: target.studentId,
    studentSessionId: target.studentSessionId, deviceId: target.deviceId, available: Boolean(target.deviceId && target.studentSessionId), stateAuthorized: true })) };
}
