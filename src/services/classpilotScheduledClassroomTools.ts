import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { chatMessages, classpilotActiveHands, classpilotChatDeliveries, classpilotClassroomStates,
  classpilotStudentControlStates, classpilotSupervisionContexts, classpilotSupervisionStudents, polls, sessionSettings,
  studentSessions, classpilotCommands, classpilotCommandTargets, type ClasspilotSupervisionContext } from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { lockClasspilotStudentControlAuthorities, getSettingsForSchool, getActiveSessionsForStudents, hasCurrentClasspilotStudentControlAuthority } from "./storage.js";
import { requireScheduledClassroomContext, scheduledContextHasClassroomTools, scheduledClassroomBindingCapable, scheduledSupervisionSource } from "./classpilotActivityAuthority.js";
import { resolveChatPause } from "./classpilotChatChannelControl.js";
import { broadcastToStaffContextLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";

function activityError(message: string, code = "CLASSROOM_ACTIVITY_STALE", status = 409) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

export async function getScheduledClassroomSettings(schoolId: string, contextId: string, database: typeof db = db) {
  const [row] = await database.select().from(sessionSettings).where(and(eq(sessionSettings.schoolId, schoolId),
    eq(sessionSettings.supervisionContextId, contextId))).limit(1);
  return row;
}

export type ScheduledToggleContext = Pick<ClasspilotSupervisionContext,
  "id" | "scheduleProfileApplicationId" | "scheduleProfileDate" | "scheduleProfileBlockId" | "scheduledConflictId">;

/**
 * `messagingChannelEnabled` is the hard switch (school + activity chatEnabled);
 * `messagingEnabled` also folds in the soft pause. Teacher replies check the
 * channel only, so a paused class can still hear its teacher.
 */
export async function scheduledClassroomToggles(schoolId: string, context: ScheduledToggleContext, database: typeof db = db) {
  const settings = await getScheduledClassroomSettings(schoolId, context.id, database);
  const school = await getSettingsForSchool(schoolId, database);
  const messagingChannelEnabled = school?.studentMessagingEnabled !== false && settings?.chatEnabled !== false;
  const pause = resolveChatPause({ chatPaused: settings?.chatPaused === true, contextSource: scheduledSupervisionSource(context),
    pauseChatDuringTesting: school?.pauseChatDuringTesting });
  return { messagingEnabled: messagingChannelEnabled && !pause.messagesPaused, messagingChannelEnabled,
    messagesPaused: pause.messagesPaused, pauseReason: pause.pauseReason,
    handRaisingEnabled: school?.handRaisingEnabled !== false && settings?.raiseHandEnabled !== false,
    lifecycleRevision: settings?.lifecycleRevision ?? 0, settings };
}

/** Students currently assigned to a live scheduled testing block, for re-pushing FAB state after a school-wide pause change. */
export async function activeScheduledTestingStudentIds(schoolId: string, database: typeof db = db): Promise<string[]> {
  const rows = await database.select({ studentId: classpilotSupervisionStudents.studentId }).from(classpilotSupervisionStudents)
    .innerJoin(classpilotSupervisionContexts, and(eq(classpilotSupervisionContexts.schoolId, classpilotSupervisionStudents.schoolId),
      eq(classpilotSupervisionContexts.id, classpilotSupervisionStudents.contextId)))
    .where(and(eq(classpilotSupervisionStudents.schoolId, schoolId), isNull(classpilotSupervisionStudents.releasedAt),
      eq(classpilotSupervisionContexts.status, "active"), gt(classpilotSupervisionContexts.endsAt, new Date()),
      isNotNull(classpilotSupervisionContexts.scheduleProfileApplicationId), isNotNull(classpilotSupervisionContexts.scheduleProfileDate),
      isNotNull(classpilotSupervisionContexts.scheduleProfileBlockId)));
  return [...new Set(rows.map((row) => row.studentId))];
}

export async function updateScheduledClassroomSettings(options: {
  schoolId: string; contextId: string; actorId: string; expectedRevision: number; chatEnabled?: boolean; raiseHandEnabled?: boolean; chatPaused?: boolean; contextAuthorityRevision?: string;
}) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as typeof db;
    await assertClasspilotEntitled(options.schoolId, database, { lock: true });
    await tx.select({ id: classpilotSupervisionContexts.id }).from(classpilotSupervisionContexts)
      .where(and(eq(classpilotSupervisionContexts.schoolId, options.schoolId), eq(classpilotSupervisionContexts.id, options.contextId))).for("update");
    await requireScheduledClassroomContext({ schoolId: options.schoolId, supervisionContextId: options.contextId, actorId: options.actorId,
      contextAuthorityRevision: options.contextAuthorityRevision }, database);
    const current = await getScheduledClassroomSettings(options.schoolId, options.contextId, database);
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision !== (current?.lifecycleRevision ?? 0)) {
      throw activityError("Classroom settings changed; refresh before trying again", "SETTINGS_REVISION_CONFLICT");
    }
    const patch = { ...(options.chatEnabled !== undefined ? { chatEnabled: options.chatEnabled } : {}),
      ...(options.raiseHandEnabled !== undefined ? { raiseHandEnabled: options.raiseHandEnabled } : {}),
      ...(options.chatPaused !== undefined ? { chatPaused: options.chatPaused } : {}), updatedAt: new Date() };
    const [row] = current ? await tx.update(sessionSettings).set({ ...patch, lifecycleRevision: current.lifecycleRevision + 1 })
      .where(and(eq(sessionSettings.id, current.id), eq(sessionSettings.schoolId, options.schoolId))).returning()
      : await tx.insert(sessionSettings).values({ ...patch, schoolId: options.schoolId, sessionId: null,
        supervisionContextId: options.contextId, lifecycleRevision: 1 }).returning();
    return row!;
  });
}

export type ScheduledStudentAction = {
  schoolId: string; supervisionContextId: string; studentId: string; studentSessionId: string; deviceId: string;
  studentControlRevision: number;
};

/** One transaction binds every student tool to the original context and control revision. */
export async function withScheduledStudentAction<T>(options: ScheduledStudentAction,
  mutate: (database: typeof db, context: ClasspilotSupervisionContext) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as typeof db;
    await assertClasspilotEntitled(options.schoolId, database, { lock: true });
    await lockClasspilotStudentControlAuthorities(options.schoolId, [options.studentId], database);
    const context = await requireScheduledClassroomContext({ ...options, lock: true }, database);
    if (!(await scheduledClassroomBindingCapable(options))) throw activityError("Extension requires scheduled classroom support", "CLASSROOM_CAPABILITY_REQUIRED", 409);
    const [assignment] = await tx.select({ id: classpilotSupervisionStudents.id }).from(classpilotSupervisionStudents)
      .where(and(eq(classpilotSupervisionStudents.schoolId, options.schoolId), eq(classpilotSupervisionStudents.contextId, context.id),
        eq(classpilotSupervisionStudents.studentId, options.studentId), isNull(classpilotSupervisionStudents.releasedAt))).limit(1).for("share");
    const [binding] = await tx.select({ id: studentSessions.id }).from(studentSessions).innerJoin(students,
      and(eq(students.id, studentSessions.studentId), eq(students.schoolId, options.schoolId), eq(students.status, "active")))
      .where(and(eq(studentSessions.id, options.studentSessionId), eq(studentSessions.studentId, options.studentId),
        eq(studentSessions.deviceId, options.deviceId), eq(studentSessions.isActive, true), isNull(studentSessions.endedAt),
        sql`(${studentSessions.authKind} <> 'manual_shared' OR ${studentSessions.manualLeaseExpiresAt} > clock_timestamp())`)).limit(1).for("share");
    const [control] = await tx.select().from(classpilotStudentControlStates).where(and(
      eq(classpilotStudentControlStates.schoolId, options.schoolId), eq(classpilotStudentControlStates.studentId, options.studentId))).limit(1).for("share");
    if (!assignment || !binding || !Number.isSafeInteger(options.studentControlRevision)
      || control?.revision !== options.studentControlRevision || control.supervisionContextId !== context.id
      || control.teachingSessionId !== null || !control.hardExpiresAt || control.hardExpiresAt <= new Date()
      || (control.scheduledEndAt && control.scheduledEndAt <= new Date())) {
      throw activityError("Student classroom authority changed");
    }
    return mutate(database, context);
  });
}

export async function mutateScheduledStudentHand(options: ScheduledStudentAction & { raised: boolean }) {
  return withScheduledStudentAction(options, async (database, context) => {
    const toggles = await scheduledClassroomToggles(options.schoolId, context, database);
    if (options.raised && !toggles.handRaisingEnabled) throw activityError("Hand raising is disabled", "FAB_FEATURE_DISABLED", 403);
    const now = new Date();
    const [existing] = await database.select().from(classpilotActiveHands).where(and(eq(classpilotActiveHands.schoolId, options.schoolId),
      eq(classpilotActiveHands.supervisionContextId, context.id), eq(classpilotActiveHands.studentId, options.studentId), isNull(classpilotActiveHands.clearedAt))).limit(1);
    if (!options.raised) {
      if (existing) await database.update(classpilotActiveHands).set({ clearedAt: now, updatedAt: now }).where(eq(classpilotActiveHands.id, existing.id));
      return { context, hand: null };
    }
    const [hand] = existing ? await database.update(classpilotActiveHands).set({ raisedAt: now, expiresAt: context.endsAt,
      deviceId: options.deviceId, updatedAt: now }).where(eq(classpilotActiveHands.id, existing.id)).returning()
      : await database.insert(classpilotActiveHands).values({ schoolId: options.schoolId, teachingSessionId: null,
        supervisionContextId: context.id, studentId: options.studentId, deviceId: options.deviceId, raisedAt: now, expiresAt: context.endsAt }).returning();
    return { context, hand: hand! };
  });
}

export async function createScheduledStudentMessage(options: ScheduledStudentAction & { content: string; clientMessageId: string }) {
  if (!options.content.trim() || options.content.length > 500 || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(options.clientMessageId)) {
    throw activityError("A message of 1–500 characters and clientMessageId are required", "MESSAGE_INVALID", 400);
  }
  return withScheduledStudentAction(options, async (database, context) => {
    const toggles = await scheduledClassroomToggles(options.schoolId, context, database);
    if (!toggles.messagingChannelEnabled) throw activityError("Messaging is disabled", "FAB_FEATURE_DISABLED", 403);
    if (toggles.messagesPaused) {
      throw Object.assign(activityError("Messaging is paused", "CHAT_PAUSED", 403), { pauseReason: toggles.pauseReason });
    }
    const [existing] = await database.select().from(chatMessages).where(and(eq(chatMessages.schoolId, options.schoolId),
      eq(chatMessages.studentId, options.studentId), eq(chatMessages.studentSessionId, options.studentSessionId),
      eq(chatMessages.clientMessageId, options.clientMessageId))).limit(1);
    if (existing) {
      if (existing.supervisionContextId !== context.id || existing.sessionId !== null || existing.content !== options.content
        || existing.senderType !== "student") throw activityError("Message id was already used", "CLIENT_MESSAGE_CONFLICT");
      return { context, message: existing, created: false };
    }
    const [message] = await database.insert(chatMessages).values({ schoolId: options.schoolId, sessionId: null,
      supervisionContextId: context.id, studentId: options.studentId, studentSessionId: options.studentSessionId,
      deviceId: options.deviceId, clientMessageId: options.clientMessageId, senderId: options.studentId, senderType: "student",
      content: options.content, messageType: "message", deliveryStatus: "delivered", deliveredAt: new Date() }).returning();
    return { context, message: message!, created: true };
  });
}

export async function createScheduledTeacherReply(options: { schoolId: string; contextId: string; actorId: string; studentId: string; content: string; contextAuthorityRevision?: string }) {
  if (!options.content.trim() || options.content.length > 500) throw activityError("Message must contain 1–500 characters", "MESSAGE_INVALID", 400);
  return db.transaction(async (tx) => {
    const database = tx as unknown as typeof db;
    await assertClasspilotEntitled(options.schoolId, database, { lock: true });
    await lockClasspilotStudentControlAuthorities(options.schoolId, [options.studentId], database);
    const context = await requireScheduledClassroomContext({ schoolId: options.schoolId, supervisionContextId: options.contextId, actorId: options.actorId, lock: true,
      contextAuthorityRevision: options.contextAuthorityRevision }, database);
    const [assignment] = await tx.select({ id: classpilotSupervisionStudents.id }).from(classpilotSupervisionStudents)
      .where(and(eq(classpilotSupervisionStudents.schoolId, options.schoolId), eq(classpilotSupervisionStudents.contextId, context.id),
        eq(classpilotSupervisionStudents.studentId, options.studentId), isNull(classpilotSupervisionStudents.releasedAt))).limit(1).for("share");
    if (!assignment) throw activityError("Student is no longer in this classroom activity");
    // Teachers may still reach a paused class; only the hard channel switch stops replies.
    if (!(await scheduledClassroomToggles(options.schoolId, context, database)).messagingChannelEnabled) throw activityError("Messaging is disabled", "FAB_FEATURE_DISABLED", 403);
    const [message] = await tx.insert(chatMessages).values({ schoolId: options.schoolId, sessionId: null, supervisionContextId: context.id,
      studentId: options.studentId, senderId: options.actorId, senderType: "teacher", content: options.content,
      messageType: "message", deliveryStatus: "sent" }).returning();
    const [delivery] = await tx.insert(classpilotChatDeliveries).values({ schoolId: options.schoolId, chatMessageId: message!.id,
      teachingSessionId: null, supervisionContextId: context.id, studentId: options.studentId, expiresAt: context.endsAt }).returning();
    return { context, message: message!, delivery: delivery! };
  });
}

export async function publishScheduledClassroomEvent(context: ClasspilotSupervisionContext, payload: Record<string, unknown>): Promise<{ delivered: number; relayAccepted: boolean }> {
  const contextAuthorityRevision = String(context.classroomAuthorityRevision);
  const event = { ...payload, supervisionContextId: context.id, contextAuthorityRevision };
  const delivered = broadcastToStaffContextLocal(context.schoolId, context.id, event, context.assignedStaffId, contextAuthorityRevision);
  const relayAccepted = await publishWS({ kind: "staff-context", schoolId: context.schoolId, supervisionContextId: context.id,
    assignedStaffId: context.assignedStaffId, contextAuthorityRevision }, event);
  return { delivered, relayAccepted };
}

export async function authorizeScheduledTeacherStudentAction(options: {
  schoolId: string; contextId: string; actorId: string; studentId: string; dismissHand?: boolean; contextAuthorityRevision?: string;
}) {
  return db.transaction(async (tx) => {
    const database = tx as unknown as typeof db;
    await assertClasspilotEntitled(options.schoolId, database, { lock: true });
    await lockClasspilotStudentControlAuthorities(options.schoolId, [options.studentId], database);
    const context = await requireScheduledClassroomContext({ schoolId: options.schoolId, supervisionContextId: options.contextId,
      actorId: options.actorId, lock: true, contextAuthorityRevision: options.contextAuthorityRevision }, database);
    if (!(await hasCurrentClasspilotStudentControlAuthority({ schoolId: options.schoolId, studentId: options.studentId,
      supervisionContextId: context.id }, database))) throw activityError("Student classroom authority changed");
    const [control] = await tx.select({ revision: classpilotStudentControlStates.revision }).from(classpilotStudentControlStates)
      .where(and(eq(classpilotStudentControlStates.schoolId, options.schoolId), eq(classpilotStudentControlStates.studentId, options.studentId))).limit(1);
    const binding = (await getActiveSessionsForStudents(options.schoolId, [options.studentId], database))[0];
    if (options.dismissHand) await tx.update(classpilotActiveHands).set({ clearedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(classpilotActiveHands.schoolId, options.schoolId), eq(classpilotActiveHands.supervisionContextId, context.id),
        eq(classpilotActiveHands.studentId, options.studentId), isNull(classpilotActiveHands.clearedAt)));
    return { context, binding, controlRevision: control!.revision };
  });
}

export async function getScheduledClassroomHands(schoolId: string, contextId: string) {
  return db.select({ hand: classpilotActiveHands, student: students }).from(classpilotActiveHands)
    .innerJoin(students, and(eq(students.id, classpilotActiveHands.studentId), eq(students.schoolId, schoolId), eq(students.status, "active")))
    .innerJoin(classpilotSupervisionStudents, and(eq(classpilotSupervisionStudents.schoolId, schoolId),
      eq(classpilotSupervisionStudents.contextId, contextId), eq(classpilotSupervisionStudents.studentId, students.id), isNull(classpilotSupervisionStudents.releasedAt)))
    .innerJoin(classpilotStudentControlStates, and(eq(classpilotStudentControlStates.schoolId, schoolId),
      eq(classpilotStudentControlStates.studentId, students.id), eq(classpilotStudentControlStates.supervisionContextId, contextId)))
    .where(and(eq(classpilotActiveHands.schoolId, schoolId), eq(classpilotActiveHands.supervisionContextId, contextId),
      isNull(classpilotActiveHands.clearedAt), gt(classpilotActiveHands.expiresAt, new Date()))).limit(500);
}

export async function getScheduledClassroomTransientState(context: ClasspilotSupervisionContext) {
  const now = new Date();
  // Resolve the last completed action for each student. An attempted or
  // failed stop cannot erase a timer that another Chromebook still runs.
  const result = await db.execute<{ command_id: string; payload: Record<string, unknown>; completed_ms: number }>(sql`
    SELECT DISTINCT ON (target.student_id) command.id AS command_id, command.command_payload AS payload, extract(epoch from target.completed_at)::double precision * 1000 AS completed_ms
    FROM classpilot_command_targets target
    JOIN classpilot_commands command ON command.id=target.command_id AND command.school_id=target.school_id
    JOIN classpilot_supervision_contexts context ON context.id=command.supervision_context_id AND context.school_id=command.school_id
      AND context.classroom_authority_revision=${context.classroomAuthorityRevision} AND context.assigned_staff_id=${context.assignedStaffId}
    JOIN classpilot_student_control_states control ON control.school_id=target.school_id AND control.student_id=target.student_id
      AND control.supervision_context_id=${context.id} AND control.teaching_session_id IS NULL
      AND target.result->>'scheduledContextAuthorityRevision'=${String(context.classroomAuthorityRevision)}
    WHERE command.school_id=${context.schoolId} AND command.supervision_context_id=${context.id}
      AND command.teacher_id=${context.assignedStaffId} AND command.command_type='timer'
      AND target.status='completed' AND target.completed_at IS NOT NULL
    ORDER BY target.student_id, command.created_at DESC, command.id DESC LIMIT 501
  `);
  let timer: null | { commandId: string; message: string; endsAt: string; completedTargetCount: number; pendingTargetCount: number } = null;
  if (result.rows.length > 500) throw activityError("Classroom roster exceeds the complete-load limit", "CLASSROOM_ROSTER_LIMIT", 422);
  const active = result.rows.filter((row) => row.payload.action === "start" && typeof row.payload.seconds === "number"
    && row.completed_ms + row.payload.seconds * 1000 > now.getTime());
  if (active.length) {
    const endsAt = Math.min(context.endsAt.getTime(), Math.max(...active.map((row) => row.completed_ms + Number(row.payload.seconds) * 1000)));
    const latest = active.reduce((a, b) => a.completed_ms > b.completed_ms ? a : b);
    const pending = await db.select({ count: sql<number>`count(*)::integer` }).from(classpilotCommandTargets).where(and(
      eq(classpilotCommandTargets.schoolId, context.schoolId), eq(classpilotCommandTargets.commandId, latest.command_id),
      inArray(classpilotCommandTargets.status, ["requested", "sent", "received"])));
    if (endsAt > now.getTime()) timer = { commandId: latest.command_id, message: String(latest.payload.message || ""),
      endsAt: new Date(endsAt).toISOString(), completedTargetCount: active.length, pendingTargetCount: pending[0]?.count ?? 0 };
  }
  const [poll] = await db.select().from(polls).where(and(eq(polls.schoolId, context.schoolId),
    eq(polls.supervisionContextId, context.id), eq(polls.isActive, true),
    sql`EXISTS(SELECT 1 FROM classpilot_supervision_contexts context WHERE context.id=${context.id} AND context.school_id=${context.schoolId}
      AND context.classroom_authority_revision=${context.classroomAuthorityRevision} AND context.assigned_staff_id=${context.assignedStaffId})`,
    sql`(${polls.expiresAt} IS NULL OR ${polls.expiresAt} > ${now})`)).limit(1);
  return { contextAuthorityRevision: String(context.classroomAuthorityRevision), timer, poll: poll ?? null };
}

export async function persistScheduledClassroomStateRecords(options: {
  schoolId: string; contextId: string; actorId: string; commandId: string; commandType: string;
  payload: Record<string, unknown>; studentIds: string[]; endsAt: Date; now: Date;
}, database: typeof db) {
  if (!options.studentIds.length) return;
  const types: Record<string, string> = { "lock-screen": "screen-lock", "unlock-screen": "screen-lock",
    "apply-flight-path": "flight-path", "remove-flight-path": "flight-path", "apply-block-list": "block-list",
    "remove-block-list": "block-list", "attention-mode": "attention", "limit-tabs": "tab-limit", "temp-unblock": "temporary-allow" };
  const stateType = types[options.commandType];
  if (!stateType) return;
  const clearTypes = options.commandType === "apply-flight-path" ? ["screen-lock", "flight-path"] : [stateType];
  await database.update(classpilotClassroomStates).set({ clearedAt: options.now, updatedAt: options.now }).where(and(
    eq(classpilotClassroomStates.schoolId, options.schoolId), eq(classpilotClassroomStates.supervisionContextId, options.contextId),
    inArray(classpilotClassroomStates.studentId, options.studentIds), inArray(classpilotClassroomStates.stateType, clearTypes),
    isNull(classpilotClassroomStates.clearedAt)));
  if (options.commandType === "unlock-screen" || options.commandType.startsWith("remove-")
    || (options.commandType === "attention-mode" && options.payload.active === false)
    || (options.commandType === "limit-tabs" && options.payload.maxTabs === null)) return;
  const expiresAt = options.commandType === "temp-unblock"
    ? new Date(Math.min(options.endsAt.getTime(), options.now.getTime() + Number(options.payload.durationMinutes) * 60_000)) : options.endsAt;
  await database.insert(classpilotClassroomStates).values(options.studentIds.map((studentId) => ({
    schoolId: options.schoolId, teachingSessionId: null, supervisionContextId: options.contextId, studentId, stateType,
    stateKey: String(options.payload.flightPathId || options.payload.blockListId || options.payload.domain || "active"),
    payload: options.payload, commandId: options.commandId, appliedBy: options.actorId, appliedAt: options.now, expiresAt,
  })));
}

export async function releaseScheduledClassroomStudentTools(schoolId: string, contextId: string, studentIds: string[], now: Date, database: typeof db) {
  if (!studentIds.length) return;
  await database.update(classpilotActiveHands).set({ clearedAt: now, updatedAt: now }).where(and(eq(classpilotActiveHands.schoolId, schoolId),
    eq(classpilotActiveHands.supervisionContextId, contextId), inArray(classpilotActiveHands.studentId, studentIds), isNull(classpilotActiveHands.clearedAt)));
  await database.update(classpilotClassroomStates).set({ clearedAt: now, updatedAt: now }).where(and(eq(classpilotClassroomStates.schoolId, schoolId),
    eq(classpilotClassroomStates.supervisionContextId, contextId), inArray(classpilotClassroomStates.studentId, studentIds), isNull(classpilotClassroomStates.clearedAt)));
  await database.update(classpilotChatDeliveries).set({ state: "expired", lastError: "Student left classroom activity", updatedAt: now }).where(and(
    eq(classpilotChatDeliveries.schoolId, schoolId), eq(classpilotChatDeliveries.supervisionContextId, contextId),
    inArray(classpilotChatDeliveries.studentId, studentIds), inArray(classpilotChatDeliveries.state, ["queued", "leased", "attempted", "retry"])));
}

/** Called inside release/expiry's existing transaction, before returning ownership. */
export async function finalizeScheduledClassroomTools(schoolId: string, contextId: string, now: Date, database: typeof db) {
  await database.update(polls).set({ isActive: false, closedAt: now, updatedAt: now }).where(and(
    eq(polls.schoolId, schoolId), eq(polls.supervisionContextId, contextId), eq(polls.isActive, true)));
  await database.update(classpilotActiveHands).set({ clearedAt: now, updatedAt: now }).where(and(
    eq(classpilotActiveHands.schoolId, schoolId), eq(classpilotActiveHands.supervisionContextId, contextId), isNull(classpilotActiveHands.clearedAt)));
  await database.update(classpilotClassroomStates).set({ clearedAt: now, updatedAt: now }).where(and(
    eq(classpilotClassroomStates.schoolId, schoolId), eq(classpilotClassroomStates.supervisionContextId, contextId), isNull(classpilotClassroomStates.clearedAt)));
  await database.update(classpilotChatDeliveries).set({ state: "expired", lastError: "Classroom activity ended", updatedAt: now }).where(and(
    eq(classpilotChatDeliveries.schoolId, schoolId), eq(classpilotChatDeliveries.supervisionContextId, contextId),
    inArray(classpilotChatDeliveries.state, ["queued", "leased", "attempted", "retry"])));
}
