import { randomInt } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { schools } from "../schema/core.js";
import { students, studentAttendance } from "../schema/students.js";
import { classpilotCommandTargets, polls, pollResponses } from "../schema/classpilot.js";
import { classpilotPickerRounds, classpilotToolTemplates, classpilotLessonActivities, classpilotLessonProgress, classpilotToolHistory } from "../schema/classpilotTools.js";
import { requireClassToolsPhase } from "../config/classpilotClassTools.js";
import { localDateInTimeZone } from "../util/schoolTime.js";
import { parseTemplateContent } from "./classpilotToolsValidation.js";
import { recordToolsHistory, toolsError, toolsParent, toolsRoster, toolsWhere, withToolsStaff, type ToolsScope } from "./classpilotToolsAuthority.js";
import { getActiveSessionsForStudents } from "./storage.js";

export async function updatePicker(scope: ToolsScope, input: { action: "pick" | "pass" | "reset" | "exclude"; expectedRevision: number; excludedStudentIds?: string[]; volunteerPollId?: string }) {
  requireClassToolsPhase(scope.schoolId, 4);
  return withToolsStaff(scope, async database => {
    const roster = await toolsRoster(scope, database);
    const rosterIds = new Set(roster.map(row => row.studentId));
    if (input.excludedStudentIds?.some(id => !rosterIds.has(id))) throw toolsError("An excluded student is no longer in this classroom", "PICKER_ROSTER_CHANGED");
    const [current] = await database.select().from(classpilotPickerRounds).where(and(toolsWhere(classpilotPickerRounds, scope), isNull(classpilotPickerRounds.endedAt))).limit(1).for("update");
    if ((current?.revision ?? 0) !== input.expectedRevision) throw toolsError("Participation round changed", "PICKER_REVISION_CONFLICT");
    const excluded = input.excludedStudentIds ?? current?.excludedStudentIds ?? [];
    const used = input.action === "reset" ? [] : current?.usedStudentIds ?? [];
    const [school] = await database.select({ timeZone: schools.schoolTimezone }).from(schools).where(eq(schools.id, scope.schoolId)).limit(1);
    const absent = await database.select({ id: studentAttendance.studentId }).from(studentAttendance).where(and(eq(studentAttendance.schoolId, scope.schoolId),
      eq(studentAttendance.date, localDateInTimeZone(new Date(), school?.timeZone)), inArray(studentAttendance.status, ["absent", "early_dismissal"])));
    const unavailable = new Set([...excluded, ...used, ...absent.map(row => row.id)]);
    let eligible = roster.filter(row => !unavailable.has(row.studentId));
    if (input.volunteerPollId) {
      const [prompt] = await database.select().from(polls).where(and(eq(polls.schoolId, scope.schoolId), eq(polls.id, input.volunteerPollId), eq(polls.purpose, "volunteer"),
        scope.authority.teachingSessionId ? eq(polls.sessionId, scope.authority.teachingSessionId) : eq(polls.supervisionContextId, scope.authority.supervisionContextId!))).limit(1);
      if (!prompt) throw toolsError("Volunteer prompt not found", "VOLUNTEER_PROMPT_REQUIRED");
      const answers = await database.select({ id: pollResponses.studentId }).from(pollResponses).where(and(eq(pollResponses.schoolId, scope.schoolId), eq(pollResponses.pollId, prompt.id), eq(pollResponses.selectedOption, 0), isNull(pollResponses.supersededAt)));
      const volunteers = new Set(answers.map(row => row.id)); eligible = eligible.filter(row => volunteers.has(row.studentId));
    }
    const selectedStudentId = input.action === "pick" && eligible.length > 0 ? eligible[randomInt(eligible.length)]!.studentId : null;
    if (input.action === "pick" && !selectedStudentId) throw toolsError("Everyone eligible has had a turn. Start a new round or change exclusions.", "PICKER_ROUND_COMPLETE");
    // Picking consumes the turn immediately; pass never puts someone back in the round.
    const patch = { excludedStudentIds: excluded, usedStudentIds: selectedStudentId ? [...used, selectedStudentId] : used, selectedStudentId,
      revision: (current?.revision ?? 0) + 1, updatedAt: new Date() };
    const [row] = current ? await database.update(classpilotPickerRounds).set(patch).where(eq(classpilotPickerRounds.id, current.id)).returning()
      : await database.insert(classpilotPickerRounds).values({ ...toolsParent(scope), ...patch }).returning();
    await recordToolsHistory(database, scope, `picker_${input.action}`, row!.id);
    return row!;
  });
}

export async function saveToolTemplate(scope: ToolsScope, input: { id?: string; expectedRevision?: number; name: string; kind: string; content: unknown }) {
  requireClassToolsPhase(scope.schoolId, input.kind === "routine" ? 5 : 2);
  const content = parseTemplateContent(input.kind, input.content);
  return withToolsStaff(scope, async database => {
    const rows = await database.select().from(classpilotToolTemplates).where(and(eq(classpilotToolTemplates.schoolId, scope.schoolId), eq(classpilotToolTemplates.teacherId, scope.actorId))).limit(101);
    const existing = input.id ? rows.find(row => row.id === input.id) : null;
    if (input.id && (!existing || existing.revision !== input.expectedRevision)) throw toolsError("Template changed", "TEMPLATE_REVISION_CONFLICT");
    if (!existing && rows.length >= 100) throw toolsError("Remove a template before saving another", "TEMPLATE_LIMIT", 422);
    const patch = { name: input.name, kind: input.kind, content, revision: (existing?.revision ?? 0) + 1, updatedAt: new Date() };
    const [row] = existing ? await database.update(classpilotToolTemplates).set(patch).where(and(eq(classpilotToolTemplates.id, existing.id), eq(classpilotToolTemplates.schoolId, scope.schoolId), eq(classpilotToolTemplates.teacherId, scope.actorId))).returning()
      : await database.insert(classpilotToolTemplates).values({ schoolId: scope.schoolId, teacherId: scope.actorId, ...patch }).returning();
    await recordToolsHistory(database, scope, "template_saved", row!.id);
    return row!;
  });
}
export async function deleteToolTemplate(scope: ToolsScope, id: string, expectedRevision: number) {
  return withToolsStaff(scope, async database => {
    const rows = await database.delete(classpilotToolTemplates).where(and(eq(classpilotToolTemplates.id, id), eq(classpilotToolTemplates.schoolId, scope.schoolId), eq(classpilotToolTemplates.teacherId, scope.actorId), eq(classpilotToolTemplates.revision, expectedRevision))).returning({ id: classpilotToolTemplates.id });
    if (!rows.length) throw toolsError("Template changed", "TEMPLATE_REVISION_CONFLICT");
    await recordToolsHistory(database, scope, "template_deleted", id);
  });
}
export async function readToolsHistory(scope: ToolsScope, cursor?: { createdAt: Date; id: string }) {
  return withToolsStaff(scope, async database => {
    const rows = await database.select().from(classpilotToolHistory).where(and(toolsWhere(classpilotToolHistory, scope), cursor ? or(lt(classpilotToolHistory.createdAt, cursor.createdAt), and(eq(classpilotToolHistory.createdAt, cursor.createdAt), lt(classpilotToolHistory.id, cursor.id))) : undefined))
      .orderBy(desc(classpilotToolHistory.createdAt), desc(classpilotToolHistory.id)).limit(101);
    const page = rows.slice(0, 100); const last = page.at(-1);
    return { events: page, nextCursor: rows.length > 100 && last ? { createdAt: last.createdAt, id: last.id } : null };
  }, true, true);
}

export async function readToolsHistoryItem(scope: ToolsScope, kind: "activity" | "prompt", id: string) {
  return withToolsStaff(scope, async database => {
    if (kind === "activity") {
      const [activity] = await database.select().from(classpilotLessonActivities).where(and(toolsWhere(classpilotLessonActivities, scope), eq(classpilotLessonActivities.id, id))).limit(1);
      if (!activity) throw toolsError("Activity is no longer retained", "TOOLS_HISTORY_NOT_FOUND", 404);
      const progress = await database.select({ studentId: classpilotLessonProgress.studentId, status: classpilotLessonProgress.status, completedItemIds: classpilotLessonProgress.completedItemIds }).from(classpilotLessonProgress).where(and(eq(classpilotLessonProgress.schoolId, scope.schoolId), eq(classpilotLessonProgress.lessonActivityId, id)));
      return { activity, progress };
    }
    const [prompt] = await database.select().from(polls).where(and(eq(polls.schoolId, scope.schoolId), eq(polls.id, id), scope.authority.teachingSessionId ? eq(polls.sessionId, scope.authority.teachingSessionId) : eq(polls.supervisionContextId, scope.authority.supervisionContextId!))).limit(1);
    if (!prompt) throw toolsError("Response prompt is no longer retained", "TOOLS_HISTORY_NOT_FOUND", 404);
    const responses = await database.select({ studentId: pollResponses.studentId, firstName: students.firstName, lastName: students.lastName, selectedOption: pollResponses.selectedOption, textResponse: pollResponses.textResponse, submittedAt: pollResponses.createdAt }).from(pollResponses)
      .innerJoin(students, and(eq(students.id, pollResponses.studentId), eq(students.schoolId, scope.schoolId)))
      .where(and(eq(pollResponses.schoolId, scope.schoolId), eq(pollResponses.pollId, prompt.id), isNull(pollResponses.supersededAt))).orderBy(pollResponses.createdAt).limit(500);
    return { prompt, responses };
  }, true, true);
}

export async function previewToolsFollowUp(scope: ToolsScope, input: { kind: "work_status" | "answer"; resourceId: string; status?: string; selectedOption?: number }) {
  requireClassToolsPhase(scope.schoolId, 3);
  return withToolsStaff(scope, async database => {
    let startCommandId: string; let chosen: string[];
    if (input.kind === "work_status") {
      const [activity] = await database.select().from(classpilotLessonActivities).where(and(toolsWhere(classpilotLessonActivities, scope), eq(classpilotLessonActivities.id, input.resourceId))).limit(1);
      if (!activity) throw toolsError("Lesson activity not found", "ACTIVITY_NOT_FOUND", 404);
      startCommandId = activity.startCommandId;
      const rows = await database.select().from(classpilotLessonProgress).where(and(eq(classpilotLessonProgress.schoolId, scope.schoolId), eq(classpilotLessonProgress.lessonActivityId, activity.id)));
      chosen = rows.filter(row => row.status === input.status).map(row => row.studentId);
      if (input.status === "not_reported") {
        const targets = await database.select({ id: classpilotCommandTargets.studentId }).from(classpilotCommandTargets).where(and(eq(classpilotCommandTargets.schoolId, scope.schoolId), eq(classpilotCommandTargets.commandId, startCommandId)));
        chosen = targets.filter(target => !rows.some(row => row.studentId === target.id && row.status !== "not_reported")).map(target => target.id);
      }
    } else {
      const [prompt] = await database.select().from(polls).where(and(eq(polls.schoolId, scope.schoolId), eq(polls.id, input.resourceId),
        scope.authority.teachingSessionId ? eq(polls.sessionId, scope.authority.teachingSessionId) : eq(polls.supervisionContextId, scope.authority.supervisionContextId!))).limit(1);
      if (!prompt?.startCommandId || prompt.responseType !== "choice" || !Number.isInteger(input.selectedOption)) throw toolsError("Select an answer group", "PROMPT_GROUP_INVALID", 400);
      startCommandId = prompt.startCommandId;
      chosen = (await database.select({ id: pollResponses.studentId }).from(pollResponses).where(and(eq(pollResponses.schoolId, scope.schoolId), eq(pollResponses.pollId, prompt.id), eq(pollResponses.selectedOption, input.selectedOption!), isNull(pollResponses.supersededAt)))).map(row => row.id);
    }
    if (!chosen.length) return { recipients: [] };
    const currentIds = new Set((await toolsRoster(scope, database)).map(row => row.studentId));
    const targets = await database.select({ studentId: classpilotCommandTargets.studentId, firstName: students.firstName, lastName: students.lastName, status: classpilotCommandTargets.status })
      .from(classpilotCommandTargets).innerJoin(students, and(eq(students.id, classpilotCommandTargets.studentId), eq(students.schoolId, scope.schoolId)))
      .where(and(eq(classpilotCommandTargets.schoolId, scope.schoolId), eq(classpilotCommandTargets.commandId, startCommandId), inArray(classpilotCommandTargets.studentId, chosen)));
    return { recipients: targets.map(row => ({ studentId: row.studentId, name: `${row.firstName} ${row.lastName}`, available: currentIds.has(row.studentId), reason: currentIds.has(row.studentId) ? null : "Student is no longer under this classroom authority" })) };
  }, false, true);
}

/** The submitted audience is the exact preview, even if statuses subsequently change. */
export async function sendToolsFollowUp(scope: ToolsScope, input: { kind: "work_status" | "answer"; resourceId: string; targetStudentIds: string[]; commandType: "teacher-message" | "open-tab"; commandPayload: Record<string, unknown> }) {
  requireClassToolsPhase(scope.schoolId, 3);
  const prepared = await withToolsStaff(scope, async database => {
    const [resource] = input.kind === "work_status"
      ? await database.select({ startCommandId: classpilotLessonActivities.startCommandId }).from(classpilotLessonActivities).where(and(toolsWhere(classpilotLessonActivities, scope), eq(classpilotLessonActivities.id, input.resourceId))).limit(1)
      : await database.select({ startCommandId: polls.startCommandId }).from(polls).where(and(eq(polls.schoolId, scope.schoolId), eq(polls.id, input.resourceId), scope.authority.teachingSessionId ? eq(polls.sessionId, scope.authority.teachingSessionId) : eq(polls.supervisionContextId, scope.authority.supervisionContextId!))).limit(1);
    if (!resource?.startCommandId) throw toolsError("Original activity is no longer available", "FOLLOW_UP_UNAVAILABLE", 404);
    const original = await database.select({ studentId: classpilotCommandTargets.studentId, firstName: students.firstName, lastName: students.lastName }).from(classpilotCommandTargets)
      .innerJoin(students, and(eq(students.id, classpilotCommandTargets.studentId), eq(students.schoolId, scope.schoolId)))
      .where(and(eq(classpilotCommandTargets.schoolId, scope.schoolId), eq(classpilotCommandTargets.commandId, resource.startCommandId)));
    const selected = [...new Set(input.targetStudentIds)];
    if (!selected.length || selected.some(id => !original.some(row => row.studentId === id))) throw toolsError("Follow-up recipients changed", "FOLLOW_UP_RECIPIENTS_INVALID", 400);
    const current = new Set((await toolsRoster(scope, database)).map(row => row.studentId));
    const bindings = await getActiveSessionsForStudents(scope.schoolId, selected, database);
    return { startCommandId: resource.startCommandId, targets: selected.map(studentId => {
      const student = original.find(row => row.studentId === studentId)!;
      const binding = bindings.find(row => row.studentId === studentId);
      const available = current.has(studentId) && Boolean(binding);
      return { studentId, studentName: `${student.firstName} ${student.lastName}`, studentSessionId: available ? binding!.id : null,
        deviceId: available ? binding!.deviceId : null, available, stateAuthorized: current.has(studentId),
        unavailableReason: current.has(studentId) ? "Student is not signed in to the extension" : "Student is no longer under this classroom authority" };
    }) };
  });
  const { executeClasspilotCommand } = await import("./classpilotCommandDispatcher.js");
  const result = await executeClasspilotCommand({ schoolId: scope.schoolId, actorId: scope.actorId, ...scope.authority,
    contextAuthorityRevision: scope.contextAuthorityRevision, targetScope: "students", targets: prepared.targets,
    originalTargetCommandId: prepared.startCommandId, commandType: input.commandType, rawCommandPayload: input.commandPayload });
  const { publicClasspilotCommand } = await import("./classpilotCommandPublic.js");
  return { ...result, command: publicClasspilotCommand(result.command) };
}
