import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import { classpilotActiveHands, classpilotCommands, classpilotSupervisionContexts, classpilotCommandTargets, polls, pollResponses, sessionSettings } from "../schema/classpilot.js";
import { classpilotTimers, classpilotLessonActivities, classpilotLessonProgress, classpilotQuestions, classpilotPickerRounds, classpilotRoutineRuns, classpilotToolTemplates, classpilotToolHistory } from "../schema/classpilotTools.js";
import { classToolsPhase, requireClassToolsPhase } from "../config/classpilotClassTools.js";
import { helpInput, progressInput, shortText } from "./classpilotToolsValidation.js";
import { recordToolsHistory, requireToolsStudent, toolsError, toolsParent, toolsRoster, toolsWhere, withToolsStaff, withToolsStudent, type ToolsScope, type ToolsStudentScope } from "./classpilotToolsAuthority.js";
import { scheduledClassroomToggles } from "./classpilotScheduledClassroomTools.js";
import { requireScheduledClassroomContext } from "./classpilotActivityAuthority.js";
import { scanStudentChatMessage } from "./classpilotChatSafety.js";

const handWhere = (scope: Pick<ToolsScope, "schoolId" | "authority">) => toolsWhere(classpilotActiveHands, scope);
const studentActor = (scope: ToolsStudentScope): ToolsScope => ({ ...scope, actorId: scope.studentId });
const publicHand = (hand: typeof classpilotActiveHands.$inferSelect) => ({ id: hand.id, studentId: hand.studentId, status: hand.status, category: hand.category,
  explanation: hand.explanation, raisedAt: hand.raisedAt, acknowledgedAt: hand.acknowledgedAt, revision: hand.revision });
export async function scanToolSubmission(scope: ToolsStudentScope, id: string, text: string) {
  if (!text) return;
  // Reuse lexical classification and audit handling. New submission types do
  // not expand the established provider policy beyond class chat.
  await scanStudentChatMessage({ ...scope, ...scope.authority, messageId: id, content: text }, { mode: () => "off" });
}
export async function mutateStudentHelp(scope: ToolsStudentScope, action: "request" | "withdraw", raw: unknown) {
  requireClassToolsPhase(scope.schoolId, 2);
  const input = action === "request" ? helpInput.parse(raw) : null;
  return withToolsStudent(scope, action === "request" ? "hand-raise" : "hand-lower", async (database, expiresAt) => {
    if (input && scope.authority.supervisionContextId) {
      const context = await requireScheduledClassroomContext({ schoolId: scope.schoolId, supervisionContextId: scope.authority.supervisionContextId }, database);
      if (!(await scheduledClassroomToggles(scope.schoolId, context, database)).handRaisingEnabled) throw toolsError("Help requests are disabled", "FAB_FEATURE_DISABLED", 403);
    }
    let [existing] = await database.select().from(classpilotActiveHands).where(and(handWhere(scope), eq(classpilotActiveHands.studentId, scope.studentId), isNull(classpilotActiveHands.clearedAt))).limit(1).for("update");
    if (existing && (!existing.expiresAt || existing.expiresAt <= new Date())) {
      await database.update(classpilotActiveHands).set({ status: "withdrawn", clearedAt: new Date(), revision: existing.revision + 1 }).where(eq(classpilotActiveHands.id, existing.id));
      existing = undefined;
    }
    if (!input) {
      if (existing) {
        await database.update(classpilotActiveHands).set({ status: "withdrawn", clearedAt: new Date(), updatedAt: new Date(), revision: existing.revision + 1 }).where(eq(classpilotActiveHands.id, existing.id));
        await recordToolsHistory(database, studentActor(scope), "help_withdrawn", existing.id);
      }
      return null;
    }
    const [hand] = existing
      ? await database.update(classpilotActiveHands).set({ ...input, deviceId: scope.deviceId, expiresAt, updatedAt: new Date(), revision: existing.revision + 1 }).where(eq(classpilotActiveHands.id, existing.id)).returning()
      : await database.insert(classpilotActiveHands).values({ ...toolsParent(scope), studentId: scope.studentId, deviceId: scope.deviceId, ...input, expiresAt }).returning();
    await recordToolsHistory(database, studentActor(scope), "help_requested", hand!.id);
    return publicHand(hand!);
  });
}
export async function updateHelp(scope: ToolsScope, id: string, expectedRevision: number, action: "acknowledge" | "helped") {
  requireClassToolsPhase(scope.schoolId, 2);
  return withToolsStaff(scope, async database => {
    const [hand] = await database.select().from(classpilotActiveHands).where(and(handWhere(scope), eq(classpilotActiveHands.id, id), isNull(classpilotActiveHands.clearedAt), gt(classpilotActiveHands.expiresAt, new Date()))).limit(1).for("update");
    if (!hand || hand.revision !== expectedRevision) throw toolsError("Help request changed", "HELP_REVISION_CONFLICT");
    await requireToolsStudent(scope, hand.studentId, database);
    if (action === "acknowledge" && hand.status !== "waiting") throw toolsError("Help request is already acknowledged", "HELP_ALREADY_ACKNOWLEDGED");
    const [updated] = await database.update(classpilotActiveHands).set({ status: action === "acknowledge" ? "acknowledged" : "helped",
      acknowledgedAt: hand.acknowledgedAt || new Date(), ...(action === "helped" ? { clearedAt: new Date() } : {}), revision: hand.revision + 1, updatedAt: new Date() }).where(eq(classpilotActiveHands.id, id)).returning();
    await recordToolsHistory(database, scope, `help_${action}`, id);
    return publicHand(updated!);
  });
}
export async function submitQuestion(scope: ToolsStudentScope, clientRequestId: string, raw: unknown) {
  requireClassToolsPhase(scope.schoolId, 2);
  const question = shortText.parse(raw);
  return withToolsStudent(scope, "hand-raise", async database => {
    if (scope.authority.supervisionContextId) {
      const context = await requireScheduledClassroomContext({ schoolId: scope.schoolId, supervisionContextId: scope.authority.supervisionContextId }, database);
      if (!(await scheduledClassroomToggles(scope.schoolId, context, database)).handRaisingEnabled) throw toolsError("Student questions are disabled", "FAB_FEATURE_DISABLED", 403);
    }
    const [existing] = await database.select().from(classpilotQuestions).where(and(eq(classpilotQuestions.schoolId, scope.schoolId), eq(classpilotQuestions.studentId, scope.studentId), eq(classpilotQuestions.clientRequestId, clientRequestId))).limit(1);
    if (existing) {
      const parent = toolsParent(scope);
      if (existing.question !== question || existing.teachingSessionId !== parent.teachingSessionId || existing.supervisionContextId !== parent.supervisionContextId) throw toolsError("Submission identity was already used", "QUESTION_ID_CONFLICT");
      return { question: existing, created: false };
    }
    const pending = await database.select({ id: classpilotQuestions.id }).from(classpilotQuestions).where(and(toolsWhere(classpilotQuestions, scope), eq(classpilotQuestions.studentId, scope.studentId), isNull(classpilotQuestions.endedAt))).limit(5);
    if (pending.length >= 5) throw toolsError("Wait for your teacher to answer a question before adding another", "QUESTION_LIMIT", 429);
    const [row] = await database.insert(classpilotQuestions).values({ ...toolsParent(scope), studentId: scope.studentId, clientRequestId, question }).returning();
    await recordToolsHistory(database, studentActor(scope), "question_submitted", row!.id);
    return { question: row!, created: true };
  });
}
export async function updateQuestion(scope: ToolsScope, id: string, expectedRevision: number, patch: { groupLabel?: string; answer?: string; resolve?: boolean }) {
  requireClassToolsPhase(scope.schoolId, 2);
  return withToolsStaff(scope, async database => {
    const [question] = await database.select().from(classpilotQuestions).where(and(toolsWhere(classpilotQuestions, scope), eq(classpilotQuestions.id, id))).limit(1).for("update");
    if (!question || question.revision !== expectedRevision || question.endedAt) throw toolsError("Question changed", "QUESTION_REVISION_CONFLICT");
    await requireToolsStudent(scope, question.studentId, database);
    const [updated] = await database.update(classpilotQuestions).set({ ...(patch.groupLabel !== undefined ? { groupLabel: patch.groupLabel } : {}),
      ...(patch.answer !== undefined ? { answer: patch.answer } : {}), ...(patch.resolve ? { endedAt: new Date() } : {}), revision: question.revision + 1, updatedAt: new Date() }).where(eq(classpilotQuestions.id, id)).returning();
    await recordToolsHistory(database, scope, patch.resolve ? "question_resolved" : "question_updated", id);
    return updated!;
  });
}
export async function updateLessonProgress(scope: ToolsStudentScope, raw: unknown) {
  requireClassToolsPhase(scope.schoolId, 3);
  const input = progressInput.parse(raw);
  return withToolsStudent(scope, "engagement", async database => {
    const [activity] = await database.select().from(classpilotLessonActivities).where(and(toolsWhere(classpilotLessonActivities, scope), eq(classpilotLessonActivities.id, input.activityId), isNull(classpilotLessonActivities.endedAt), gt(classpilotLessonActivities.expiresAt, new Date()))).limit(1).for("share");
    if (!activity) throw toolsError("Lesson activity has ended", "ACTIVITY_ENDED");
    if (!await hasToolAssignment(database, scope, activity.startCommandId)) throw toolsError("This lesson activity was not assigned to this student session", "ACTIVITY_TARGET_STALE", 403);
    if (input.completedItemIds?.some(id => !activity.checklist.some(item => item.id === id))) throw toolsError("Checklist changed. Refresh before trying again.", "CHECKLIST_CHANGED");
    const [existing] = await database.select().from(classpilotLessonProgress).where(and(eq(classpilotLessonProgress.schoolId, scope.schoolId), eq(classpilotLessonProgress.lessonActivityId, activity.id), eq(classpilotLessonProgress.studentId, scope.studentId))).limit(1).for("update");
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw toolsError("Progress changed. Refresh before trying again.", "PROGRESS_REVISION_CONFLICT");
    const patch = { ...(input.status !== undefined ? { status: input.status } : {}), ...(input.completedItemIds !== undefined ? { completedItemIds: [...new Set(input.completedItemIds)] } : {}), updatedAt: new Date(), revision: (existing?.revision ?? 0) + 1 };
    const [progress] = existing ? await database.update(classpilotLessonProgress).set(patch).where(eq(classpilotLessonProgress.id, existing.id)).returning()
      : await database.insert(classpilotLessonProgress).values({ ...toolsParent(scope), studentId: scope.studentId, lessonActivityId: activity.id, ...patch }).returning();
    await recordToolsHistory(database, studentActor(scope), "progress_updated", activity.id);
    return progress!;
  });
}

export async function readClassTools(scope: ToolsScope) {
  return withToolsStaff(scope, async database => {
    const phase = classToolsPhase(scope.schoolId);
    const roster = await toolsRoster(scope, database);
    if (roster.length > 500) throw toolsError("Classroom roster exceeds the complete-load limit", "CLASSROOM_ROSTER_LIMIT", 422);
    const visibleIds = new Set(roster.map(row => row.studentId));
    const [timer] = await database.select().from(classpilotTimers).where(and(toolsWhere(classpilotTimers, scope), isNull(classpilotTimers.endedAt), gt(classpilotTimers.expiresAt, new Date()))).limit(1);
    const [activity] = await database.select().from(classpilotLessonActivities).where(and(toolsWhere(classpilotLessonActivities, scope), isNull(classpilotLessonActivities.endedAt), gt(classpilotLessonActivities.expiresAt, new Date()))).limit(1);
    const hands = await database.select().from(classpilotActiveHands).where(and(handWhere(scope), isNull(classpilotActiveHands.clearedAt), gt(classpilotActiveHands.expiresAt, new Date()))).orderBy(asc(classpilotActiveHands.raisedAt));
    const questions = await database.select().from(classpilotQuestions).where(and(toolsWhere(classpilotQuestions, scope), isNull(classpilotQuestions.endedAt))).orderBy(asc(classpilotQuestions.createdAt)).limit(2500);
    const progress = activity ? await database.select().from(classpilotLessonProgress).where(and(eq(classpilotLessonProgress.schoolId, scope.schoolId), eq(classpilotLessonProgress.lessonActivityId, activity.id))) : [];
    const [picker] = await database.select().from(classpilotPickerRounds).where(and(toolsWhere(classpilotPickerRounds, scope), isNull(classpilotPickerRounds.endedAt))).limit(1);
    const [routine] = await database.select().from(classpilotRoutineRuns).where(and(toolsWhere(classpilotRoutineRuns, scope), isNull(classpilotRoutineRuns.endedAt), eq(classpilotRoutineRuns.teacherId, scope.actorId))).limit(1);
    const templates = await database.select().from(classpilotToolTemplates).where(and(eq(classpilotToolTemplates.schoolId, scope.schoolId), eq(classpilotToolTemplates.teacherId, scope.actorId))).orderBy(asc(classpilotToolTemplates.name)).limit(100);
    const [prompt] = await database.select().from(polls).where(and(eq(polls.schoolId, scope.schoolId), scope.authority.teachingSessionId ? eq(polls.sessionId, scope.authority.teachingSessionId) : eq(polls.supervisionContextId, scope.authority.supervisionContextId!), eq(polls.isActive, true), gt(polls.expiresAt, new Date()))).limit(1);
    const responses = prompt ? await database.select({ studentId: pollResponses.studentId, selectedOption: pollResponses.selectedOption, textResponse: pollResponses.textResponse, respondedAt: pollResponses.createdAt }).from(pollResponses).where(and(eq(pollResponses.schoolId, scope.schoolId), eq(pollResponses.pollId, prompt.id), isNull(pollResponses.supersededAt))) : [];
    const activeTimer = timer && (timer.pausedRemainingMs != null || (timer.deadline && timer.deadline > new Date())) ? timer : null;
    const targets = async (commandId?: string | null) => commandId ? (await database.select({ studentId: classpilotCommandTargets.studentId, status: classpilotCommandTargets.status, errorMessage: classpilotCommandTargets.errorMessage }).from(classpilotCommandTargets).where(and(eq(classpilotCommandTargets.schoolId, scope.schoolId), eq(classpilotCommandTargets.commandId, commandId)))).map(row => ({ ...row, studentName: roster.find(student => student.studentId === row.studentId) ? `${roster.find(student => student.studentId === row.studentId)!.firstName} ${roster.find(student => student.studentId === row.studentId)!.lastName}` : "Student no longer in this classroom" })) : [];
    const routineOutcomes = routine ? await Promise.all(routine.outcomes.map(async outcome => ({ ...outcome, targets: await targets(outcome.commandIds.at(-1)) }))) : [];
    return { phase, roster, timer: activeTimer, activity, progress: progress.filter(row => visibleIds.has(row.studentId)),
      help: hands.filter(row => visibleIds.has(row.studentId)).map(publicHand), questions: questions.filter(row => visibleIds.has(row.studentId)), picker, routine, templates,
      routineOutcomes, prompt: prompt ?? null, responses: responses.filter(row => visibleIds.has(row.studentId)), promptTargets: await targets(prompt?.startCommandId),
      timerTargets: await targets(activeTimer?.startCommandId), activityTargets: await targets(activity?.startCommandId) };
  }, false, true);
}

/** A retry grants access only to the original exact binding and classroom owner. */
async function hasToolAssignment(database: typeof db, scope: ToolsStudentScope, commandId: string) {
  const [context] = scope.authority.supervisionContextId ? await database.select({ revision: classpilotSupervisionContexts.classroomAuthorityRevision }).from(classpilotSupervisionContexts)
    .where(and(eq(classpilotSupervisionContexts.schoolId, scope.schoolId), eq(classpilotSupervisionContexts.id, scope.authority.supervisionContextId))).limit(1) : [];
  const [target] = await database.select({ id: classpilotCommandTargets.id }).from(classpilotCommandTargets)
    .innerJoin(classpilotCommands, and(eq(classpilotCommands.id, classpilotCommandTargets.commandId), eq(classpilotCommands.schoolId, scope.schoolId)))
    .where(and(toolsWhere(classpilotCommands, scope),
      or(eq(classpilotCommands.id, commandId), sql`${classpilotCommands.commandPayload}->>'replayOfCommandId'=${commandId}`),
      eq(classpilotCommandTargets.schoolId, scope.schoolId), eq(classpilotCommandTargets.studentId, scope.studentId),
      eq(classpilotCommandTargets.studentSessionId, scope.studentSessionId), eq(classpilotCommandTargets.deviceId, scope.deviceId),
      inArray(classpilotCommandTargets.status, ["requested", "sent", "received", "completed"]),
      scope.authority.supervisionContextId ? sql`${classpilotCommandTargets.result}->>'scheduledContextAuthorityRevision'=${String(context?.revision ?? '')}` : undefined)).limit(1);
  return Boolean(target);
}

/** Exact-bound FAB snapshots contain only the current student's private data. */
export async function readStudentToolsSnapshot(scope: ToolsStudentScope, database: typeof db = db, capabilities: readonly string[] = []) {
  const phase = classToolsPhase(scope.schoolId);
  if (phase < 2) return null;
  const parent = toolsParent(scope);
  const settings = await database.execute<{ tools_revision: number }>(sql`SELECT tools_revision FROM session_settings WHERE school_id=${scope.schoolId} AND session_id IS NOT DISTINCT FROM ${parent.teachingSessionId} AND supervision_context_id IS NOT DISTINCT FROM ${parent.supervisionContextId}`);
  const [hand] = await database.select().from(classpilotActiveHands).where(and(handWhere(scope), eq(classpilotActiveHands.studentId, scope.studentId), isNull(classpilotActiveHands.clearedAt), gt(classpilotActiveHands.expiresAt, new Date()))).limit(1);
  const questions = await database.select({ id: classpilotQuestions.id, question: classpilotQuestions.question, answer: classpilotQuestions.answer, revision: classpilotQuestions.revision, resolvedAt: classpilotQuestions.endedAt }).from(classpilotQuestions).where(and(toolsWhere(classpilotQuestions, scope), eq(classpilotQuestions.studentId, scope.studentId))).orderBy(desc(classpilotQuestions.createdAt)).limit(20);
  const has = (capability: string) => capabilities.includes(capability);
  const assigned = (commandId: string) => hasToolAssignment(database, scope, commandId);
  const [timer] = has("timerControlsV1") ? await database.select().from(classpilotTimers).where(and(toolsWhere(classpilotTimers, scope), isNull(classpilotTimers.endedAt), gt(classpilotTimers.expiresAt, new Date()))).limit(1) : [];
  const [activity] = phase >= 3 && has("lessonActivitiesV1") ? await database.select().from(classpilotLessonActivities).where(and(toolsWhere(classpilotLessonActivities, scope), isNull(classpilotLessonActivities.endedAt), gt(classpilotLessonActivities.expiresAt, new Date()))).limit(1) : [];
  const currentActivity = activity && await assigned(activity.startCommandId) ? activity : null;
  const [progress] = currentActivity ? await database.select({ status: classpilotLessonProgress.status, completedItemIds: classpilotLessonProgress.completedItemIds, revision: classpilotLessonProgress.revision }).from(classpilotLessonProgress).where(and(eq(classpilotLessonProgress.schoolId, scope.schoolId), eq(classpilotLessonProgress.lessonActivityId, currentActivity.id), eq(classpilotLessonProgress.studentId, scope.studentId))).limit(1) : [];
  const currentTimer = timer && (timer.pausedRemainingMs !== null || timer.deadline && timer.deadline > new Date()) && await assigned(timer.startCommandId) ? timer : null;
  return { phase, revision: Number(settings.rows[0]?.tools_revision ?? 0), capabilities: capabilities.filter(value => ["helpRequestsV1", "questionParkingV1", "timerControlsV1", "lessonActivitiesV1", "exitTicketsV1"].includes(value)),
    help: has("helpRequestsV1") && hand ? publicHand(hand) : null, questions: has("questionParkingV1") ? questions : [],
    timer: currentTimer ? { timerId: currentTimer.id, revision: currentTimer.revision, deadline: currentTimer.deadline, pausedRemainingMs: currentTimer.pausedRemainingMs, expiresAt: currentTimer.expiresAt, message: currentTimer.message } : null,
    activity: currentActivity ? { activityId: currentActivity.id, revision: currentActivity.revision, title: currentActivity.title, instructions: currentActivity.instructions, resources: currentActivity.resources, checklist: currentActivity.checklist, expiresAt: currentActivity.expiresAt,
      progress: progress ?? { status: "not_reported", completedItemIds: [], revision: 0 } } : null };
}

/** No private DTO is reused here. No student IDs, free text responses or names. */
export async function readToolsPresentation(scope: ToolsScope) {
  requireClassToolsPhase(scope.schoolId, 4);
  return withToolsStaff(scope, async database => {
    const [timer] = await database.select({ deadline: classpilotTimers.deadline, pausedRemainingMs: classpilotTimers.pausedRemainingMs, revision: classpilotTimers.revision }).from(classpilotTimers).where(and(toolsWhere(classpilotTimers, scope), isNull(classpilotTimers.endedAt), gt(classpilotTimers.expiresAt, new Date()))).limit(1);
    const [activity] = await database.select({ title: classpilotLessonActivities.title, instructions: classpilotLessonActivities.instructions, resources: classpilotLessonActivities.resources, checklist: classpilotLessonActivities.checklist }).from(classpilotLessonActivities).where(and(toolsWhere(classpilotLessonActivities, scope), isNull(classpilotLessonActivities.endedAt), gt(classpilotLessonActivities.expiresAt, new Date()))).limit(1);
    const [prompt] = await database.select({ id: polls.id, question: polls.question, options: polls.options }).from(polls).where(and(eq(polls.schoolId, scope.schoolId), scope.authority.teachingSessionId ? eq(polls.sessionId, scope.authority.teachingSessionId) : eq(polls.supervisionContextId, scope.authority.supervisionContextId!), eq(polls.isActive, true), eq(polls.responseType, "choice"), gt(polls.expiresAt, new Date()))).limit(1);
    const aggregate = prompt ? await database.select({ option: pollResponses.selectedOption, count: sql<number>`count(*)::integer` }).from(pollResponses).where(and(eq(pollResponses.schoolId, scope.schoolId), eq(pollResponses.pollId, prompt.id), isNull(pollResponses.supersededAt))).groupBy(pollResponses.selectedOption) : [];
    return { timer: timer ?? null, activity: activity ?? null, poll: prompt ? { question: prompt.question, options: prompt.options.map((label, index) => ({ label, count: aggregate.find(row => row.option === index)?.count ?? 0 })) } : null };
  }, false, true);
}
