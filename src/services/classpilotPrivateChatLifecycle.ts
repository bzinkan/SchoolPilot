import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { settings } from "../schema/shared.js";
import { classpilotPrivateChatThreads, classpilotSessionStudents, classpilotSupervisionStudents,
  sessionSettings, teachingSessions, classpilotSupervisionContexts, chatMessages, classpilotChatDeliveries,
  studentSessions, devices, type ChatMessage } from "../schema/classpilot.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";

export const PRIVATE_CHAT_LIFECYCLE_WRITER_VERSION = 1;
// The first dark deployment can roll back before lifecycle adoption: it never
// creates lifecycle state. After adoption the stored latch, not the flag, wins.
export const PRIVATE_CHAT_BRIDGE_VERSION = 1;
export type PrivateChatLifecycle = { threadId: string; schoolEpoch: number; activityEpoch: number; threadGeneration: number };
export type PrivateChatScope = { schoolId: string; studentId: string; teachingSessionId?: string | null; supervisionContextId?: string | null };

function lifecycleError(code: string, message: string, status = 409) {
  return Object.assign(new Error(message), { code, status, expose: true });
}

export function parsePrivateChatLifecycle(value: unknown): PrivateChatLifecycle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const token = value as Record<string, unknown>;
  if (Object.keys(token).sort().join(",") !== "activityEpoch,schoolEpoch,threadGeneration,threadId"
    || typeof token.threadId !== "string" || !token.threadId.trim() || token.threadId.length > 128
    || ![token.schoolEpoch,token.activityEpoch,token.threadGeneration].every(n => typeof n === "number" && Number.isSafeInteger(n) && n > 0)) return null;
  return { threadId: token.threadId, schoolEpoch: Number(token.schoolEpoch), activityEpoch: Number(token.activityEpoch), threadGeneration: Number(token.threadGeneration) };
}

export function samePrivateChatLifecycle(left: PrivateChatLifecycle | null, right: PrivateChatLifecycle | null): boolean {
  return !!left && !!right && left.threadId === right.threadId && left.schoolEpoch === right.schoolEpoch
    && left.activityEpoch === right.activityEpoch && left.threadGeneration === right.threadGeneration;
}

export function privateChatMessageLifecycle(message: Pick<ChatMessage,
  "privateChatThreadId" | "privateChatSchoolEpoch" | "privateChatActivityEpoch" | "privateChatGeneration">): PrivateChatLifecycle | null {
  return parsePrivateChatLifecycle({ threadId: message.privateChatThreadId, schoolEpoch: message.privateChatSchoolEpoch,
    activityEpoch: message.privateChatActivityEpoch, threadGeneration: message.privateChatGeneration });
}

export function privateChatMessageFields(token: PrivateChatLifecycle) {
  return { privateChatThreadId: token.threadId, privateChatSchoolEpoch: token.schoolEpoch,
    privateChatActivityEpoch: token.activityEpoch, privateChatGeneration: token.threadGeneration };
}

/** Call before acquiring student/parent locks. This separate, bounded UPDATE
 * latches enforcement without upgrading a settings SHARE lock mid-transaction. */
export async function latchPrivateChatLifecycle(schoolId: string): Promise<void> {
  if (!isClasspilotCapabilityActive("privateChatLifecycleV1", { schoolId })) return;
  await db.update(settings).set({ privateChatLifecycleRequired: true })
    .where(and(eq(settings.schoolId,schoolId),eq(settings.privateChatLifecycleRequired,false)));
}

export async function privateChatLifecycleRequired(schoolId: string, database: typeof db = db): Promise<boolean> {
  const [row] = await database.select({ required: settings.privateChatLifecycleRequired }).from(settings)
    .where(eq(settings.schoolId,schoolId)).limit(1);
  return row?.required === true || isClasspilotCapabilityActive("privateChatLifecycleV1", { schoolId });
}

export async function lockPrivateChatChannel(scope: PrivateChatScope, database: typeof db) {
  if (!!scope.teachingSessionId === !!scope.supervisionContextId) throw lifecycleError("PRIVATE_CHAT_SCOPE_INVALID", "One classroom authority is required",400);
  if (scope.teachingSessionId) {
    await database.select({id:teachingSessions.id}).from(teachingSessions).where(and(eq(teachingSessions.schoolId,scope.schoolId),
      eq(teachingSessions.id,scope.teachingSessionId))).for("key share");
  } else {
    await database.select({id:classpilotSupervisionContexts.id}).from(classpilotSupervisionContexts).where(and(
      eq(classpilotSupervisionContexts.schoolId,scope.schoolId),eq(classpilotSupervisionContexts.id,scope.supervisionContextId!))).for("key share");
  }
  const [school] = await database.select().from(settings).where(eq(settings.schoolId,scope.schoolId)).limit(1).for("share");
  if (!school) throw lifecycleError("PRIVATE_CHAT_SETTINGS_UNAVAILABLE", "School messaging settings are unavailable");
  const parent = scope.teachingSessionId ? eq(sessionSettings.sessionId,scope.teachingSessionId)
    : eq(sessionSettings.supervisionContextId,scope.supervisionContextId!);
  const [activity] = await database.select().from(sessionSettings).where(and(eq(sessionSettings.schoolId,scope.schoolId),parent)).limit(1).for("share");
  return {required:school.privateChatLifecycleRequired || isClasspilotCapabilityActive("privateChatLifecycleV1",{schoolId:scope.schoolId}),
    enabled:school.studentMessagingEnabled !== false && activity?.chatEnabled !== false};
}

/** Caller owns entitlement + student authority locks. Parent -> school settings
 * -> activity settings -> thread -> delivery is the shared lock order. */
export async function lockPrivateChatLifecycle(scope: PrivateChatScope, database: typeof db) {
  if (!!scope.teachingSessionId === !!scope.supervisionContextId) throw lifecycleError("PRIVATE_CHAT_SCOPE_INVALID", "One classroom authority is required", 400);
  let assignmentId: string | undefined;
  if (scope.teachingSessionId) {
    await database.select({id:teachingSessions.id}).from(teachingSessions).where(and(eq(teachingSessions.schoolId,scope.schoolId),
      eq(teachingSessions.id,scope.teachingSessionId))).for("key share");
    const [assignment] = await database.select({id:classpilotSessionStudents.id}).from(classpilotSessionStudents).where(and(
      eq(classpilotSessionStudents.schoolId,scope.schoolId),eq(classpilotSessionStudents.studentId,scope.studentId),
      eq(classpilotSessionStudents.teachingSessionId,scope.teachingSessionId))).limit(1);
    assignmentId = assignment?.id;
  } else {
    await database.select({id:classpilotSupervisionContexts.id}).from(classpilotSupervisionContexts).where(and(
      eq(classpilotSupervisionContexts.schoolId,scope.schoolId),eq(classpilotSupervisionContexts.id,scope.supervisionContextId!))).for("key share");
    const [assignment] = await database.select({id:classpilotSupervisionStudents.id}).from(classpilotSupervisionStudents).where(and(
      eq(classpilotSupervisionStudents.schoolId,scope.schoolId),eq(classpilotSupervisionStudents.studentId,scope.studentId),
      eq(classpilotSupervisionStudents.contextId,scope.supervisionContextId!),isNull(classpilotSupervisionStudents.releasedAt))).limit(1);
    assignmentId = assignment?.id;
  }
  if (!assignmentId) throw lifecycleError("PRIVATE_CHAT_AUTHORITY_STALE", "Student classroom assignment changed");
  const [school] = await database.select({epoch:settings.privateChatEpoch,required:settings.privateChatLifecycleRequired,
    enabled:settings.studentMessagingEnabled}).from(settings).where(eq(settings.schoolId,scope.schoolId)).limit(1).for("share");
  if (!school) throw lifecycleError("PRIVATE_CHAT_SETTINGS_UNAVAILABLE", "School messaging settings are unavailable");
  const parentCondition = scope.teachingSessionId ? eq(sessionSettings.sessionId,scope.teachingSessionId)
    : eq(sessionSettings.supervisionContextId,scope.supervisionContextId!);
  let [activity] = await database.select().from(sessionSettings).where(and(eq(sessionSettings.schoolId,scope.schoolId),parentCondition)).limit(1).for("share");
  if (!activity) {
    await database.insert(sessionSettings).values({schoolId:scope.schoolId,sessionId:scope.teachingSessionId ?? null,
      supervisionContextId:scope.supervisionContextId ?? null}).onConflictDoNothing();
    [activity] = await database.select().from(sessionSettings).where(and(eq(sessionSettings.schoolId,scope.schoolId),parentCondition)).limit(1).for("share");
  }
  const threadCondition = and(eq(classpilotPrivateChatThreads.schoolId,scope.schoolId),eq(classpilotPrivateChatThreads.studentId,scope.studentId),
    eq(classpilotPrivateChatThreads.authorityAssignmentId,assignmentId));
  let [thread] = await database.select().from(classpilotPrivateChatThreads).where(threadCondition).limit(1).for("update");
  if (!thread) {
    await database.insert(classpilotPrivateChatThreads).values({schoolId:scope.schoolId,studentId:scope.studentId,
      teachingSessionId:scope.teachingSessionId ?? null,supervisionContextId:scope.supervisionContextId ?? null,
      authorityAssignmentId:assignmentId}).onConflictDoNothing();
    [thread] = await database.select().from(classpilotPrivateChatThreads).where(threadCondition).limit(1).for("update");
  }
  if (!thread || !activity) throw lifecycleError("PRIVATE_CHAT_STATE_UNAVAILABLE", "Private chat state is unavailable");
  return { token: {threadId:thread.id,schoolEpoch:school.epoch,activityEpoch:activity.privateChatEpoch,threadGeneration:thread.generation},
    required: school.required || isClasspilotCapabilityActive("privateChatLifecycleV1", {schoolId:scope.schoolId}),
    enabled: school.enabled !== false && activity.chatEnabled !== false };
}

export async function privateChatBindingSupported(scope: Pick<PrivateChatScope,"schoolId"|"studentId">, database: typeof db = db): Promise<boolean> {
  const [binding] = await database.select({id:studentSessions.id,deviceId:studentSessions.deviceId}).from(studentSessions)
    .innerJoin(devices,and(eq(devices.deviceId,studentSessions.deviceId),eq(devices.schoolId,scope.schoolId)))
    .where(and(eq(studentSessions.studentId,scope.studentId),eq(studentSessions.isActive,true),isNull(studentSessions.endedAt),
      sql`(${studentSessions.authKind} <> 'manual_shared' OR ${studentSessions.manualLeaseExpiresAt} > clock_timestamp())`)).limit(1);
  if (!binding) return false;
  const {readClasspilotRealtimeStatusBatch,classpilotRealtimeFresh} = await import("./classpilotRealtimeStatus.js");
  const snapshots = await readClasspilotRealtimeStatusBatch(scope.schoolId,[{studentId:scope.studentId,studentSessionId:binding.id,deviceId:binding.deviceId}]);
  const hit = snapshots.get(scope.studentId);
  return hit?.status === "hit" && classpilotRealtimeFresh(hit.snapshot) && hit.snapshot.acceptedCapabilities?.includes("privateChatLifecycleV1") === true;
}

export async function preparePrivateChatMessage(scope: PrivateChatScope, expected: unknown, database: typeof db) {
  const channel = await lockPrivateChatChannel(scope,database);
  if (!channel.enabled) throw lifecycleError("FAB_FEATURE_DISABLED", "Messaging is turned off",403);
  if (!channel.required) {
    if (expected !== undefined) throw lifecycleError("PRIVATE_CHAT_LIFECYCLE_STALE", "Chat changed; refresh before sending again");
    return {};
  }
  const state = await lockPrivateChatLifecycle(scope,database);
  if (!state.enabled) throw lifecycleError("FAB_FEATURE_DISABLED", "Messaging is turned off",403);
  if (state.required) {
    if (!isClasspilotCapabilityActive("privateChatLifecycleV1",{schoolId:scope.schoolId})) throw lifecycleError("PRIVATE_CHAT_DISABLED", "New private messages are disabled");
    if (!samePrivateChatLifecycle(parsePrivateChatLifecycle(expected),state.token)) throw lifecycleError("PRIVATE_CHAT_LIFECYCLE_STALE", "Chat changed; refresh before sending again");
    if (!(await privateChatBindingSupported(scope,database))) throw lifecycleError("PRIVATE_CHAT_UPDATE_REQUIRED", "The student's extension needs an update");
  } else if (expected !== undefined && !samePrivateChatLifecycle(parsePrivateChatLifecycle(expected),state.token)) {
    throw lifecycleError("PRIVATE_CHAT_LIFECYCLE_STALE", "Chat changed; refresh before sending again");
  }
  return privateChatMessageFields(state.token);
}

export async function closePrivateChatLifecycle(scope: PrivateChatScope, expected: unknown, actorId: string, database: typeof db) {
  const channel = await lockPrivateChatChannel(scope,database);
  if (!channel.required) {
    if (expected !== undefined) throw lifecycleError("PRIVATE_CHAT_LIFECYCLE_STALE", "Chat changed; refresh before ending it");
    await database.execute(sql`INSERT INTO audit_logs (school_id,user_id,action,entity_type,entity_id,metadata)
      VALUES (${scope.schoolId},${actorId},'classpilot.chat.closed','student',${scope.studentId},
        ${JSON.stringify({teachingSessionId:scope.teachingSessionId ?? null,supervisionContextId:scope.supervisionContextId ?? null})}::jsonb)`);
    return undefined;
  }
  const state = await lockPrivateChatLifecycle(scope,database);
  if ((state.required || expected !== undefined) && !samePrivateChatLifecycle(parsePrivateChatLifecycle(expected),state.token)) {
    throw lifecycleError("PRIVATE_CHAT_LIFECYCLE_STALE", "Chat changed; refresh before ending it");
  }
  const [thread] = await database.update(classpilotPrivateChatThreads).set({generation:sql`${classpilotPrivateChatThreads.generation}+1`,updatedAt:new Date()})
    .where(and(eq(classpilotPrivateChatThreads.schoolId,scope.schoolId),eq(classpilotPrivateChatThreads.id,state.token.threadId))).returning();
  const token = {...state.token,threadGeneration:thread!.generation};
  // The generation fence is immediately authoritative; materialization is bounded.
  await database.execute(sql`INSERT INTO audit_logs (school_id,user_id,action,entity_type,entity_id,metadata)
    VALUES (${scope.schoolId},${actorId},'classpilot.chat.closed','student',${scope.studentId},
      ${JSON.stringify({teachingSessionId:scope.teachingSessionId ?? null,supervisionContextId:scope.supervisionContextId ?? null,threadId:token.threadId,generation:token.threadGeneration})}::jsonb)`);
  return token;
}

export async function isPrivateChatMessageCurrent(message: ChatMessage, database: typeof db): Promise<boolean> {
  if (!message.studentId) return false;
  const token = privateChatMessageLifecycle(message);
  // Unadopted schools retain the old delivery contract until the compatible
  // bridge is serving everywhere. Activation permanently retires legacy rows.
  if (!token) {
    const channel = await lockPrivateChatChannel({schoolId:message.schoolId,studentId:message.studentId,
      teachingSessionId:message.sessionId,supervisionContextId:message.supervisionContextId},database);
    if (!channel.required) return true;
  }
  const state = await lockPrivateChatLifecycle({schoolId:message.schoolId,studentId:message.studentId,
    teachingSessionId:message.sessionId,supervisionContextId:message.supervisionContextId},database);
  return state.enabled && (token ? samePrivateChatLifecycle(token,state.token) : !state.required && state.token.threadGeneration === 1 && state.token.schoolEpoch === 1 && state.token.activityEpoch === 1);
}

export async function isPrivateChatMessageExpired(messageId: string, schoolId: string, database: typeof db = db): Promise<boolean> {
  const [expired] = await database.select({id:chatMessages.id}).from(chatMessages).where(and(
    eq(chatMessages.id,messageId),eq(chatMessages.schoolId,schoolId),PRIVATE_CHAT_EXPIRED_SQL)).limit(1);
  return !!expired;
}

export async function readPrivateChatLifecycleState(scope: PrivateChatScope, database: typeof db = db) {
  if (!(await privateChatLifecycleRequired(scope.schoolId,database))) return undefined;
  return database.transaction(async (tx) => {
    const connection = tx as unknown as typeof db;
    const [school] = await tx.select({schoolEpoch:settings.privateChatEpoch}).from(settings).where(eq(settings.schoolId,scope.schoolId)).limit(1);
    if (!scope.teachingSessionId && !scope.supervisionContextId) return {schoolEpoch:school?.schoolEpoch ?? 1,threads:[]};
    const state = await lockPrivateChatLifecycle(scope,connection);
    return {schoolEpoch:state.token.schoolEpoch,threads:[{...state.token,teachingSessionId:scope.teachingSessionId ?? null,
      supervisionContextId:scope.supervisionContextId ?? null}]};
  });
}

export async function teacherPrivateChatLifecycles(scope: Omit<PrivateChatScope,"studentId">) {
  await latchPrivateChatLifecycle(scope.schoolId);
  const required = await privateChatLifecycleRequired(scope.schoolId);
  if (!required) return {privateChatLifecycleRequired:false,privateChatLifecycles:[]};
  const roster = scope.teachingSessionId
    ? await db.select({studentId:classpilotSessionStudents.studentId}).from(classpilotSessionStudents).where(and(
      eq(classpilotSessionStudents.schoolId,scope.schoolId),eq(classpilotSessionStudents.teachingSessionId,scope.teachingSessionId)))
    : await db.select({studentId:classpilotSupervisionStudents.studentId}).from(classpilotSupervisionStudents).where(and(
      eq(classpilotSupervisionStudents.schoolId,scope.schoolId),eq(classpilotSupervisionStudents.contextId,scope.supervisionContextId!),isNull(classpilotSupervisionStudents.releasedAt)));
  const result = [];
  for (const {studentId} of roster) {
    const snapshot = await readPrivateChatLifecycleState({...scope,studentId});
    const {teachingSessionId,supervisionContextId,...privateChatLifecycle} = snapshot!.threads[0]!;
    result.push({studentId,teachingSessionId,supervisionContextId,privateChatLifecycle,
      supported:isClasspilotCapabilityActive("privateChatLifecycleV1",{schoolId:scope.schoolId}) && await privateChatBindingSupported({...scope,studentId})});
  }
  return {privateChatLifecycleRequired:true,privateChatLifecycles:result};
}

export async function projectPrivateChatMessages(messages: ChatMessage[], database: typeof db = db) {
  if (!messages.length) return messages;
  const ids = messages.map(message=>message.id);
  const expired = await database.select({id:chatMessages.id}).from(chatMessages).where(and(
    eq(chatMessages.schoolId,messages[0]!.schoolId),inArray(chatMessages.id,ids),PRIVATE_CHAT_EXPIRED_SQL));
  const expiredIds = new Set(expired.map(row=>row.id));
  return messages.map(message => expiredIds.has(message.id) && !["seen","delivered"].includes(message.deliveryStatus)
    ? {...message,privateChatExpired:true,deliveryStatus:"expired" as const} : {...message,privateChatExpired:false});
}

/** SQL predicate also makes status projections truthful before the worker catches up. */
export const PRIVATE_CHAT_EXPIRED_SQL = sql`EXISTS (
 SELECT 1 FROM settings cs WHERE cs.school_id=chat_messages.school_id
 AND (cs.private_chat_lifecycle_required OR chat_messages.private_chat_thread_id IS NOT NULL) AND (
   (chat_messages.private_chat_thread_id IS NULL AND (
     cs.private_chat_lifecycle_required OR cs.student_messaging_enabled=false OR cs.private_chat_epoch>1
     OR EXISTS (SELECT 1 FROM session_settings legacy_activity WHERE legacy_activity.school_id=chat_messages.school_id
       AND legacy_activity.session_id IS NOT DISTINCT FROM chat_messages.session_id
       AND legacy_activity.supervision_context_id IS NOT DISTINCT FROM chat_messages.supervision_context_id
       AND (legacy_activity.private_chat_epoch>1 OR legacy_activity.chat_enabled=false))
     OR EXISTS (SELECT 1 FROM classpilot_private_chat_threads legacy_thread WHERE legacy_thread.school_id=chat_messages.school_id
       AND legacy_thread.student_id=chat_messages.student_id AND legacy_thread.teaching_session_id IS NOT DISTINCT FROM chat_messages.session_id
       AND legacy_thread.supervision_context_id IS NOT DISTINCT FROM chat_messages.supervision_context_id AND legacy_thread.generation>1)))
   OR (chat_messages.private_chat_thread_id IS NOT NULL AND (
     cs.student_messaging_enabled=false OR cs.private_chat_epoch<>chat_messages.private_chat_school_epoch OR NOT EXISTS (
       SELECT 1 FROM classpilot_private_chat_threads ct JOIN session_settings ca ON ca.school_id=ct.school_id
         AND ca.session_id IS NOT DISTINCT FROM ct.teaching_session_id AND ca.supervision_context_id IS NOT DISTINCT FROM ct.supervision_context_id
       WHERE ct.school_id=chat_messages.school_id AND ct.id=chat_messages.private_chat_thread_id
         AND ct.generation=chat_messages.private_chat_generation AND ca.private_chat_epoch=chat_messages.private_chat_activity_epoch
         AND ca.chat_enabled IS DISTINCT FROM false
         AND (ct.teaching_session_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM classpilot_supervision_students assignment WHERE assignment.school_id=ct.school_id
             AND assignment.id=ct.authority_assignment_id AND assignment.student_id=ct.student_id
             AND assignment.context_id=ct.supervision_context_id AND assignment.released_at IS NULL)))))))`;

export async function expirePrivateChatDeliveries(database: typeof db, limit = 250): Promise<number> {
  const result = await database.execute(sql`WITH stale AS (
    SELECT d.id FROM classpilot_chat_deliveries d JOIN chat_messages ON chat_messages.id=d.chat_message_id AND chat_messages.school_id=d.school_id
    WHERE d.state IN ('queued','leased','attempted','retry') AND ${PRIVATE_CHAT_EXPIRED_SQL}
    ORDER BY d.created_at LIMIT ${Math.min(1000,Math.max(1,limit))} FOR UPDATE OF d SKIP LOCKED
  ) UPDATE classpilot_chat_deliveries d SET state='expired',updated_at=now(),lease_owner=NULL,lease_expires_at=NULL,
    last_error='Private chat ended or messaging was switched off' FROM stale WHERE d.id=stale.id RETURNING d.id`);
  return result.rowCount ?? 0;
}
