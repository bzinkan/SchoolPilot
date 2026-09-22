import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { CLASSPILOT_SCHEDULED_CLASSROOM_SQL } from "../src/db/classpilotScheduledClassroomMigration.js";
import { CLASSPILOT_TOOLS_SQL } from "../src/db/classpilotToolsMigration.js";

process.env.REDIS_URL = "";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;
const ids = { school: randomUUID(), otherSchool: randomUUID(), teacher: randomUUID(), nextTeacher: randomUUID(), student: randomUUID(), device: randomUUID() };
let database: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let storage: typeof import("../src/services/storage.js");
let tools: typeof import("../src/services/classpilotScheduledClassroomTools.js");
let authority: typeof import("../src/services/classpilotActivityAuthority.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let context: import("../src/schema/classpilot.js").ClasspilotSupervisionContext;
let bindingId: string;
let classTools: typeof import("../src/services/classpilotClassTools.js");
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);
const statement = (query: ReturnType<typeof sql>) => inSchool(() => database.execute(query));
const control = () => inSchool(() => storage.getClasspilotStudentControlState(ids.school, ids.student));
const action = async () => ({ schoolId: ids.school, supervisionContextId: context.id, studentId: ids.student,
  studentSessionId: bindingId, deviceId: ids.device, studentControlRevision: (await control())!.revision });
const rejection = (code: string) => (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  return ("code" in error && error.code === code) || ("cause" in error && rejection(code)(error.cause));
};

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Scheduled tools require the local fixture");
  process.env.DATABASE_URL_PRIVILEGED = process.env.DATABASE_URL;
  ({ default: database, pool } = await import("../src/db.js"));
  ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
  storage = await import("../src/services/storage.js");
  tools = await import("../src/services/classpilotScheduledClassroomTools.js");
  authority = await import("../src/services/classpilotActivityAuthority.js");
  await pool.query(CLASSPILOT_SCHEDULED_CLASSROOM_SQL);
  await pool.query(CLASSPILOT_TOOLS_SQL);
  // The schema-only CI lane has no legacy parent guards yet. Scheduled
  // classroom SQL installs four of the five FAB guards; install the remaining
  // poll-response guard from its actual bootstrap SQL so subsequent catalog
  // probes see a complete FAB contract, without unrelated staff contracts.
  const bootstrap = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const responseGuard = bootstrap.match(/await pool\.query\(`\s*(CREATE OR REPLACE FUNCTION classpilot_bind_poll_response_school\(\)[\s\S]*?)`\);/);
  assert.ok(responseGuard?.[1], "canonical poll-response parent guard must be available");
  assert.ok(!responseGuard[1].includes("${"), "fixture SQL must not require template interpolation");
  await pool.query(responseGuard[1]);
  classTools = await import("../src/services/classpilotClassTools.js");
  process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON = JSON.stringify({ [ids.school]: 5 });
  await pool.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Scheduled tools',$3,'active','active'),($2,'Other tools',$3,'active','active')", [ids.school, ids.otherSchool, `${ids.school}.example.edu`]);
  for (const id of [ids.teacher, ids.nextTeacher]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Scheduled','Teacher')", [id, `${id}@${ids.school}.example.edu`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, id]);
  }
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  await statement(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode,pause_chat_during_testing) VALUES(${ids.school},'Scheduled tools','test-only',false,'off',false)`);
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.student},${ids.school},'Test','Student','active')`);
  await inSchool(async () => {
    await storage.createDevice({ schoolId: ids.school, deviceId: ids.device, classId: "default", deviceName: "Test Chromebook" });
    bindingId = (await storage.startStudentSessionWithReplacements(ids.school, ids.student, ids.device,
      { authKind: "manual_shared", sessionRecoveryTokenHash: "b".repeat(64) })).session.id;
    context = await storage.createSupervisionContextWithStudents({ context: { schoolId: ids.school, name: "Scheduled testing",
      contextType: "coverage_group", assignedStaffId: ids.teacher, createdBy: ids.teacher, startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000), scheduleProfileApplicationId: randomUUID(), scheduleProfileBlockId: randomUUID(),
      scheduleProfileDate: new Date().toISOString().slice(0, 10) }, studentIds: [ids.student], assignedBy: ids.teacher });
  });
  const { writeClasspilotRealtimeStatus, setClasspilotRealtimeStatusCommandForTests } = await import("../src/services/classpilotRealtimeStatus.js");
  const shared = new Map<string, string>();
  setClasspilotRealtimeStatusCommandForTests(async (args) => {
    if (args[0] === "MGET") return args.slice(1).map((key) => shared.get(key) ?? null);
    if (args[0] === "EVAL" && args[3] && args[5]?.startsWith("{")) { shared.set(args[3], args[5]); return args[5]; }
    return undefined;
  });
  await writeClasspilotRealtimeStatus({ schoolId: ids.school, studentId: ids.student, studentSessionId: bindingId, deviceId: ids.device,
    heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities: ["scopedAuthorityChecksV1", "scheduledClassroomV1", ...capabilities] });
});

after(async () => {
  if (!pool) return;
  await tenant({ isSuper: true }, async () => {
    for (const table of ["audit_logs", "classpilot_tool_history", "classpilot_routine_runs", "classpilot_tool_templates", "classpilot_picker_rounds", "classpilot_questions", "classpilot_lesson_progress", "classpilot_lesson_activities", "classpilot_timers", "poll_responses", "polls", "classpilot_chat_deliveries", "chat_messages", "classpilot_active_hands", "session_settings",
      "classpilot_classroom_states", "classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states",
      "classpilot_supervision_students", "classpilot_supervision_contexts", "classpilot_session_staff", "classpilot_session_students", "teaching_sessions", "groups", "student_sessions", "devices", "student_attendance", "students", "settings"]) {
      if (table === "student_sessions") await database.execute(sql`DELETE FROM student_sessions WHERE student_id=${ids.student}`);
      else await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${ids.school}`);
    }
  });
  await pool.query("DELETE FROM product_licenses WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM school_memberships WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM schools WHERE id IN($1,$2)", [ids.school, ids.otherSchool]);
  await pool.query("DELETE FROM users WHERE id IN($1,$2)", [ids.teacher, ids.nextTeacher]);
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  (await import("../src/services/classpilotRealtimeStatus.js")).setClasspilotRealtimeStatusCommandForTests(undefined);
  const scheduler = await import("../src/services/schedulerDb.js");
  await Promise.all([pool.end(), (await import("../src/db.js")).sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});


const staffScope = () => ({ schoolId: ids.school, actorId: ids.teacher, authority: { supervisionContextId: context.id }, contextAuthorityRevision: String(context.classroomAuthorityRevision) });
const studentScope = async () => ({ ...(await action()), authority: { supervisionContextId: context.id } });
const capabilities = ["helpRequestsV1", "questionParkingV1", "timerControlsV1", "lessonActivitiesV1", "exitTicketsV1"];
const snapshot = () => inSchool(async () => classTools.readStudentToolsSnapshot(await studentScope(), database, capabilities));
const createCommand = (commandType: string, commandPayload: Record<string, unknown>, extra: NonNullable<Parameters<typeof storage.createClasspilotCommandWithTargets>[2]> = {}) => inSchool(() => storage.createClasspilotCommandWithTargets({ schoolId: ids.school, teacherId: ids.teacher,
  teachingSessionId: null, supervisionContextId: context.id, targetScope: "context", commandType, commandPayload },
  [{ commandId: "reserved", schoolId: ids.school, studentId: ids.student, supervisionContextId: context.id, studentSessionId: bindingId, deviceId: ids.device }],
  { authority: { schoolId: ids.school, actorId: ids.teacher, supervisionContextId: context.id, contextAuthorityRevision: String(context.classroomAuthorityRevision) }, ...extra }));

test("help preserves queue time and acknowledged state; student withdrawal is private and revisioned", async () => {
  const first = await inSchool(async () => classTools.mutateStudentHelp(await studentScope(), "request", { category: "assignment", explanation: "Need another example" }));
  assert.ok(first);
  const ack = await inSchool(() => classTools.updateHelp(staffScope(), first.id, first.revision, "acknowledge"));
  const edited = await inSchool(async () => classTools.mutateStudentHelp(await studentScope(), "request", { category: "technical", explanation: "Actually the page froze" }));
  assert.equal(edited!.raisedAt.getTime(), first.raisedAt.getTime()); assert.equal(edited!.status, "acknowledged");
  assert.equal((await snapshot())!.help!.status, "acknowledged");
  await assert.rejects(inSchool(() => classTools.updateHelp(staffScope(), first.id, ack.revision, "helped")), rejection("HELP_REVISION_CONFLICT"));
  await inSchool(async () => classTools.mutateStudentHelp(await studentScope(), "withdraw", null));
  assert.equal((await snapshot())!.help, null);
});

test("questions retry idempotently and staff answers appear only to their submitting student", async () => {
  const clientRequestId = randomUUID();
  const create = () => inSchool(async () => classTools.submitQuestion(await studentScope(), clientRequestId, "Why does this work?"));
  const first = await create(); assert.equal(first.created, true); assert.equal((await create()).created, false);
  await inSchool(() => classTools.updateQuestion(staffScope(), first.question.id, 1, { groupLabel: "Examples", answer: "We will work through it together." }));
  assert.equal((await snapshot())!.questions[0]!.answer, "We will work through it together.");
  await assert.rejects(inSchool(() => classTools.readClassTools({ ...staffScope(), actorId: ids.nextTeacher })), rejection("CLASS_TOOLS_AUTHORITY_STALE"));
});

test("timer controls reject stale revisions and racing pauses; stop tombstones the student snapshot", async () => {
  const started = await createCommand("timer", { action: "start", seconds: 120 });
  const payload = started.commandPayload as { timerId: string; revision: number };
  const results = await Promise.allSettled([createCommand("timer", { action: "pause", timerId: payload.timerId, expectedRevision: 1 }), createCommand("timer", { action: "pause", timerId: payload.timerId, expectedRevision: 1 })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const paused = (await snapshot())!.timer!; assert.equal(paused.deadline, null); assert.ok(paused.pausedRemainingMs! > 0);
  await createCommand("timer", { action: "extend", seconds: 60, timerId: payload.timerId, expectedRevision: 2 });
  assert.ok((await snapshot())!.timer!.pausedRemainingMs! > 120000);
  await createCommand("timer", { action: "resume", timerId: payload.timerId, expectedRevision: 3 });
  await createCommand("timer", { action: "stop", timerId: payload.timerId, expectedRevision: 4 });
  assert.equal((await snapshot())!.timer, null);
});

test("lesson checklist edits retain only unchanged items without changing explicit work status", async () => {
  await createCommand("lesson-activity", { action: "start", title: "Practice", instructions: "Solve both", resources: [], checklist: [{ id: "a", text: "First" }, { id: "b", text: "Second" }] });
  const activity = (await snapshot())!.activity!;
  await inSchool(async () => classTools.updateLessonProgress(await studentScope(), { activityId: activity.activityId, expectedRevision: 0, status: "working", completedItemIds: ["a", "b"] }));
  await createCommand("lesson-activity", { action: "update", activityId: activity.activityId, expectedRevision: 1, title: "Practice", instructions: "New directions", resources: [], checklist: [{ id: "a", text: "First" }, { id: "b", text: "Different second" }] });
  const updated = (await snapshot())!.activity!;
  assert.deepEqual(updated.progress.completedItemIds, ["a"]); assert.equal(updated.progress.status, "working");
  await assert.rejects(inSchool(async () => classTools.updateLessonProgress(await studentScope(), { activityId: activity.activityId, expectedRevision: 1, status: "finished" })), rejection("PROGRESS_REVISION_CONFLICT"));
  await createCommand("lesson-activity", { action: "start", title: "Next task", instructions: "", resources: [], checklist: [] });
  assert.equal((await snapshot())!.activity!.progress.status, "not_reported");
  assert.equal((await snapshot())!.help, null);
});

test("presentation is a separate private-data-free projection and new tables force RLS", async () => {
  const projection = await inSchool(() => classTools.readToolsPresentation(staffScope()));
  assert.deepEqual(Object.keys(projection).sort(), ["activity", "poll", "timer"]);
  const json = JSON.stringify(projection); for (const value of [ids.student, ids.device, bindingId, "Why does this work?", "We will work through it together."]) assert.ok(!json.includes(value));
  const rows = await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1)", [["classpilot_timers","classpilot_lesson_activities","classpilot_lesson_progress","classpilot_questions","classpilot_picker_rounds","classpilot_tool_templates","classpilot_routine_runs","classpilot_tool_history"]]);
  assert.equal(rows.rows.length, 8); assert.ok(rows.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
  const client = await pool.connect();
  const role = `cp_tools_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" NOSUPERUSER NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(`GRANT SELECT ON classpilot_questions TO "${role}"`);
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query("SELECT set_config('app.school_id',$1,true),set_config('app.is_super','off',true)", [ids.otherSchool]);
    assert.equal((await client.query('SELECT * FROM classpilot_questions WHERE school_id=$1',[ids.school])).rows.length, 0);
    await client.query("SELECT set_config('app.school_id',$1,true)", [ids.school]);
    assert.equal((await client.query('SELECT * FROM classpilot_questions WHERE school_id=$1',[ids.school])).rows.length, 1);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test("short-text prompts race with polls, retain the first submission, and close explicitly", async () => {
  const firstId = randomUUID(), secondId = randomUUID();
  const first = { action: "start" as const, pollId: firstId, purpose: "exit_ticket" as const, responseType: "short_text" as const, question: "What is still confusing?", options: [] };
  const second = { action: "start" as const, pollId: secondId, question: "Ready?", options: ["Yes", "No"] };
  const results = await Promise.allSettled([createCommand("poll", first, { pollMutation: first }), createCommand("poll", second, { pollMutation: second })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const current = (await inSchool(() => classTools.readClassTools(staffScope()))).prompt!;
  if (current.id !== firstId) {
    await createCommand("poll", { action: "close", pollId: current.id }, { pollMutation: { action: "close", pollId: current.id } });
    await createCommand("poll", first, { pollMutation: first });
  }
  const bound = await action();
  assert.equal((await inSchool(() => storage.createPollResponseFirstWrite({ ...bound, pollId: firstId, textResponse: "Equivalent fractions" }))).disposition, "created");
  assert.equal((await inSchool(() => storage.createPollResponseFirstWrite({ ...bound, pollId: firstId, textResponse: "Equivalent fractions" }))).disposition, "replayed");
  assert.equal((await inSchool(() => storage.createPollResponseFirstWrite({ ...bound, pollId: firstId, textResponse: "Changed answer" }))).disposition, "conflict");
  assert.equal((await inSchool(() => classTools.readToolsPresentation(staffScope()))).poll, null);
  await createCommand("poll", { action: "close", pollId: firstId }, { pollMutation: { action: "close", pollId: firstId } });
  await assert.rejects(inSchool(() => storage.createPollResponseFirstWrite({ ...bound, pollId: firstId, textResponse: "Late answer" })), rejection("POLL_NOT_ACTIVE"));
});

test("routine steps commit once, prompts are prepared explicitly, and successful targets cannot be retried", async () => {
  const planning = await import("../src/services/classpilotToolsPlanning.js");
  const routines = await import("../src/services/classpilotToolsRoutines.js");
  const template = await inSchool(() => planning.saveToolTemplate(staffScope(), { name: "Independent work", kind: "routine", content: { title: "Practice", steps: [
    { kind: "timer", title: "Practice time", payload: { seconds: 60 } },
    { kind: "exit_ticket", title: "Reflect", payload: { question: "What did you learn?", purpose: "exit_ticket", responseType: "short_text", options: [] } }
  ] } }));
  const run = await inSchool(() => routines.startRoutine(staffScope(), template.id, [ids.student]));
  const reserve = { runId: run.id, expectedRevision: 1, step: 0 };
  const results = await Promise.allSettled([createCommand("timer", { action: "start", seconds: 60 }, { routineReservation: reserve }), createCommand("timer", { action: "start", seconds: 60 }, { routineReservation: reserve })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const state = await inSchool(() => classTools.readClassTools(staffScope()));
  assert.equal(state.routine!.currentStep, 1); assert.equal(state.routine!.revision, 2);
  await inSchool(() => routines.advanceRoutine(staffScope(), run.id, { action: "next", expectedRevision: 2 }));
  const prepared = await inSchool(() => classTools.readClassTools(staffScope()));
  assert.equal(prepared.prompt, null); assert.equal(prepared.routine!.currentStep, 1); assert.equal(prepared.routine!.outcomes.at(-1)!.state, "prepared");
  const commandId = prepared.routine!.outcomes[0]!.commandIds[0]!;
  await statement(sql`UPDATE classpilot_command_targets SET status='completed' WHERE school_id=${ids.school} AND command_id=${commandId}`);
  await assert.rejects(inSchool(() => routines.advanceRoutine(staffScope(), run.id, { action: "retry", step: 0, expectedRevision: 3 })), rejection("ROUTINE_RETRY_UNAVAILABLE"));
  await inSchool(() => routines.advanceRoutine(staffScope(), run.id, { action: "skip", expectedRevision: 3 }));
  await inSchool(() => routines.advanceRoutine(staffScope(), run.id, { action: "end", expectedRevision: 4 }));
  await createCommand("timer", { action: "stop" });
});

test("an eligible lesson retry restores only its original exact binding", async () => {
  const planning = await import("../src/services/classpilotToolsPlanning.js");
  const routines = await import("../src/services/classpilotToolsRoutines.js");
  const content = { title: "Retry lesson", instructions: "Try this", resources: [], checklist: [] };
  const template = await inSchool(() => planning.saveToolTemplate(staffScope(), { name: "Retry lesson", kind: "routine", content: { title: "Retry", steps: [{kind:"instructions",title:"Directions",payload:content}] } }));
  const run = await inSchool(() => routines.startRoutine(staffScope(), template.id, [ids.student]));
  const original = await createCommand("lesson-activity", { action: "start", ...content }, { routineReservation: { runId:run.id,expectedRevision:1,step:0 } });
  await statement(sql`UPDATE classpilot_command_targets SET status='failed' WHERE school_id=${ids.school} AND command_id=${original.id}`);
  assert.equal((await snapshot())!.activity, null);
  await createCommand("lesson-activity", { action:"start",...content }, { routineReservation: {runId:run.id,expectedRevision:2,step:0,replayCommandId:original.id} });
  assert.equal((await snapshot())!.activity!.title, "Retry lesson");
  assert.equal((await inSchool(() => classTools.readClassTools(staffScope()))).routine!.currentStep, 1);
  await inSchool(() => routines.advanceRoutine(staffScope(), run.id, {action:"end",expectedRevision:3}));
});

test("canonical delivery rechecks negotiated tool capabilities without treating supported targets as unsupported", async () => {
  const { executeClasspilotCommand } = await import("../src/services/classpilotCommandDispatcher.js");
  const result = await inSchool(() => executeClasspilotCommand({ schoolId: ids.school, actorId: ids.teacher, supervisionContextId: context.id,
    contextAuthorityRevision: String(context.classroomAuthorityRevision), commandType: "lesson-activity", targetScope: "students",
    rawCommandPayload: {action:"start",title:"Canonical delivery",instructions:"Practice",resources:[],checklist:[]},
    targets:[{studentId:ids.student,studentName:"Test Student",studentSessionId:bindingId,deviceId:ids.device,available:true,stateAuthorized:true}] }));
  assert.ok(result.command.targets.length === 1);
  assert.notEqual(result.command.targets[0]!.status, "unavailable");
  assert.ok(!result.command.targets[0]!.errorMessage?.includes("Unsupported client"));
  assert.equal((await snapshot())!.activity!.title, "Canonical delivery");
});

test("Class tools retention counts first, then removes old authored content without deleting templates", async () => {
  const { purgeClassToolsRetentionForSchool } = await import("../src/services/scheduler.js");
  const old = new Date(Date.now() - 40 * 86400000), cutoff = new Date(Date.now() - 30 * 86400000);
  await statement(sql`UPDATE classpilot_questions SET created_at=${old},ended_at=${old} WHERE school_id=${ids.school}`);
  await statement(sql`UPDATE classpilot_lesson_activities SET created_at=${old},ended_at=${old} WHERE school_id=${ids.school} AND title='Practice'`);
  const questionCount = async () => Number((await statement(sql`SELECT count(*) AS count FROM classpilot_questions WHERE school_id=${ids.school}`)).rows[0]!.count);
  await purgeClassToolsRetentionForSchool({schoolId:ids.school,cutoff,mode:"count"}); assert.equal(await questionCount(),1);
  await purgeClassToolsRetentionForSchool({schoolId:ids.school,cutoff,mode:"delete"}); assert.equal(await questionCount(),0);
  assert.ok(Number((await statement(sql`SELECT count(*) AS count FROM classpilot_tool_templates WHERE school_id=${ids.school}`)).rows[0]!.count)>0);
  assert.equal((await snapshot())!.activity!.title,"Canonical delivery");
});

test("participation excludes absence and manual exclusions, consumes passes, and resets rounds", async () => {
  const { updatePicker } = await import("../src/services/classpilotToolsPlanning.js");
  const { localDateInTimeZone } = await import("../src/util/schoolTime.js");
  await statement(sql`UPDATE schools SET school_timezone='America/New_York' WHERE id=${ids.school}`);
  await statement(sql`INSERT INTO student_attendance(school_id,student_id,date,status,marked_by) VALUES(${ids.school},${ids.student},${localDateInTimeZone(new Date(),'America/New_York')},'absent',${ids.teacher})`);
  await assert.rejects(inSchool(() => updatePicker(staffScope(),{action:"pick",expectedRevision:0})),rejection("PICKER_ROUND_COMPLETE"));
  await statement(sql`DELETE FROM student_attendance WHERE school_id=${ids.school}`);
  await inSchool(() => updatePicker(staffScope(),{action:"exclude",expectedRevision:0,excludedStudentIds:[ids.student]}));
  await assert.rejects(inSchool(() => updatePicker(staffScope(),{action:"pick",expectedRevision:1})),rejection("PICKER_ROUND_COMPLETE"));
  const selected=await inSchool(() => updatePicker(staffScope(),{action:"pick",expectedRevision:1,excludedStudentIds:[]}));
  assert.equal(selected.selectedStudentId,ids.student);
  await inSchool(() => updatePicker(staffScope(),{action:"pass",expectedRevision:2}));
  await assert.rejects(inSchool(() => updatePicker(staffScope(),{action:"pick",expectedRevision:3})),rejection("PICKER_ROUND_COMPLETE"));
  await inSchool(() => updatePicker(staffScope(),{action:"reset",expectedRevision:3}));
  assert.equal((await inSchool(() => updatePicker(staffScope(),{action:"pick",expectedRevision:4}))).selectedStudentId,ids.student);
});

test("follow-ups preserve the preview audience and individual unavailable outcomes", async () => {
  const planning = await import("../src/services/classpilotToolsPlanning.js");
  const activity = (await inSchool(() => classTools.readClassTools(staffScope()))).activity!;
  const movedId = randomUUID();
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${movedId},${ids.school},'Moved','Student','inactive')`);
  await statement(sql`INSERT INTO classpilot_command_targets(school_id,command_id,supervision_context_id,student_id,status) VALUES(${ids.school},${activity.startCommandId},${context.id},${movedId},'unavailable')`);
  const preview = await inSchool(() => planning.previewToolsFollowUp(staffScope(), {kind:'work_status',resourceId:activity.id,status:'not_reported'}));
  assert.equal(preview.recipients.length,2);
  assert.equal(preview.recipients.find(row=>row.studentId===movedId)!.available,false);
  const sent = await inSchool(() => planning.sendToolsFollowUp(staffScope(), {kind:'work_status',resourceId:activity.id,targetStudentIds:preview.recipients.map(row=>row.studentId),commandType:'open-tab',commandPayload:{url:'https://example.edu/practice'}}));
  assert.equal(sent.command.targets.length,2);
  assert.equal(sent.command.targets.find((row: {studentId:string;status:string})=>row.studentId===movedId)!.status,'unavailable');
  assert.equal(JSON.stringify(sent.command).includes('deviceId'),false);
  await assert.rejects(inSchool(() => planning.sendToolsFollowUp(staffScope(), {kind:'work_status',resourceId:activity.id,targetStudentIds:[randomUUID()],commandType:'open-tab',commandPayload:{url:'https://example.edu/practice'}})),rejection('FOLLOW_UP_RECIPIENTS_INVALID'));
});

test("manual follow-ups record inactive original recipients without allowing arbitrary roster expansion", async () => {
  const groupId = randomUUID(), sessionId = randomUUID(), removedId = randomUUID();
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${removedId},${ids.school},'Removed','Student','inactive')`);
  await statement(sql`INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES(${groupId},${ids.school},${ids.teacher},'Follow-up class','teacher_created','active')`);
  await statement(sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,session_mode,roster_snapshot_completed_at) VALUES(${sessionId},${ids.school},${groupId},${ids.teacher},'live',now())`);
  await statement(sql`INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role) VALUES(${ids.school},${sessionId},${ids.teacher},'primary')`);
  await statement(sql`INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id) VALUES(${ids.school},${sessionId},${groupId},${removedId})`);
  const command: Parameters<typeof storage.createClasspilotCommandWithTargets>[0] = {schoolId:ids.school,teacherId:ids.teacher,teachingSessionId:sessionId,supervisionContextId:null,targetScope:'students',commandType:'open-tab',commandPayload:{url:'https://example.edu/practice'}};
  const targets = [{commandId:'reserved',schoolId:ids.school,teachingSessionId:sessionId,studentId:removedId,status:'unavailable' as const}];
  const original = await inSchool(() => storage.createClasspilotCommandWithTargets(command,targets));
  const options = {authority:{schoolId:ids.school,actorId:ids.teacher,teachingSessionId:sessionId}};
  await assert.rejects(inSchool(() => storage.createClasspilotCommandWithTargets(command,targets,options)),rejection('COMMAND_TARGET_ROSTER_STALE'));
  const followUp = await inSchool(() => storage.createClasspilotCommandWithTargets(command,targets,{...options,originalTargetCommandId:original.id}));
  assert.equal(followUp.targets[0]!.status,'unavailable');
  assert.match(followUp.targets[0]!.errorMessage!,/authority changed/);
  await assert.rejects(inSchool(() => storage.createClasspilotCommandWithTargets(command,[{...targets[0]!,studentId:ids.student}],{...options,originalTargetCommandId:original.id})),rejection('COMMAND_TARGET_ROSTER_STALE'));
});

test("rollback stop cleans up timers and an owner change hides former activity assignments", async () => {
  await createCommand("timer", { action:"start",seconds:60 });
  process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON = "{}";
  await createCommand("timer", { action:"stop" });
  process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON = JSON.stringify({ [ids.school]:5 });
  assert.equal((await snapshot())!.timer, null);
  const activity = (await snapshot())!.activity!;
  const planning = await import("../src/services/classpilotToolsPlanning.js");
  const routines = await import("../src/services/classpilotToolsRoutines.js");
  const content = {title:'Private routine',steps:[{kind:'timer',title:'Practice',payload:{seconds:60}}]};
  const template = await inSchool(() => planning.saveToolTemplate(staffScope(),{name:'Original teacher',kind:'routine',content}));
  const priorRun = await inSchool(() => routines.startRoutine(staffScope(),template.id,[ids.student]));
  await statement(sql`UPDATE classpilot_supervision_contexts SET assigned_staff_id=${ids.nextTeacher} WHERE school_id=${ids.school} AND id=${context.id}`);
  assert.equal((await snapshot())!.activity, null);
  await assert.rejects(inSchool(async () => classTools.updateLessonProgress(await studentScope(), {activityId:activity.activityId,expectedRevision:0,status:"working"})), rejection("ACTIVITY_TARGET_STALE"));
  assert.ok((await statement(sql`SELECT ended_at FROM classpilot_routine_runs WHERE school_id=${ids.school} AND id=${priorRun.id}`)).rows[0]!.ended_at);
  const nextScope = {...staffScope(),actorId:ids.nextTeacher,contextAuthorityRevision:String(context.classroomAuthorityRevision+1)};
  assert.equal((await inSchool(()=>classTools.readClassTools(nextScope))).templates.length,0);
  const nextTemplate = await inSchool(() => planning.saveToolTemplate(nextScope,{name:'Replacement teacher',kind:'routine',content}));
  const nextRun = await inSchool(() => routines.startRoutine(nextScope,nextTemplate.id,[ids.student]));
  assert.notEqual(nextRun.id,priorRun.id);
});
