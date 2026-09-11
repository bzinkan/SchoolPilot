import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { CLASSPILOT_SUPERVISION_REPORTS_SQL } from "../src/db/classpilotSupervisionReportsMigration.js";
import {
  classpilotSupervisionContexts as contexts, classpilotSupervisionStudents as assignments,
  classpilotSupervisionReportSegments as reports, classpilotSupervisionStudentReports as details,
  classpilotSupervisionSummaryDeliveries as deliveries,
  type ClasspilotMonitoringEvent,
} from "../src/schema/index.js";
import type { ClasspilotActivityReportInput } from "../src/services/classpilotMonitoringReports.js";

process.env.REDIS_URL = "";
process.env.SENDGRID_API_KEY = "";
const cutoff = "2026-01-01T00:00:00.000Z";
const ids = { school: randomUUID(), otherSchool: randomUUID(), teacher: randomUUID(), replacement: randomUUID(), central: randomUUID(), student: randomUUID(), secondStudent: randomUUID() };
const at = (minutes: number) => new Date(Date.parse("2026-09-14T13:00:00.000Z") + minutes * 60_000);
let pool: import("pg").Pool;
let database: typeof import("../src/db.js").default;
let withTenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let lifecycle: typeof import("../src/services/classpilotSupervisionReportLifecycle.js");
let processor: typeof import("../src/services/classpilotSupervisionReports.js");
let storage: typeof import("../src/services/storage.js");
const scoped = <T>(fn: () => Promise<T>) => withTenant({ schoolId: ids.school }, fn);
const statement = (query: ReturnType<typeof sql>) => scoped(() => database.execute(query));
const allReports = () => scoped(() => database.select().from(reports).where(eq(reports.schoolId, ids.school)).orderBy(reports.windowStart));
const allDetails = () => scoped(() => database.select().from(details).where(eq(details.schoolId, ids.school)));
const allDeliveries = () => scoped(() => database.select().from(deliveries).where(eq(deliveries.schoolId, ids.school)));
const sync = (contextId: string, now: Date, isNew = false) => scoped(() => lifecycle.syncSupervisionActivityReports({ schoolId: ids.school, contextIds: [contextId], now, newContextIds: isNew ? [contextId] : [] }, database));
const materialize = (now: Date) => scoped(() => processor.materializeDueClasspilotSupervisionReports({ schoolId: ids.school, now, clock: () => now, dbInstance: database }));
const dispatch = (now: Date, transport?: import("../src/services/classpilotSupervisionReports.js").SupervisionSummaryTransport) => scoped(() => processor.dispatchDueClasspilotSupervisionSummaries({ schoolId: ids.school, now, clock: () => now, dbInstance: database, transport }));

async function context(options: { start?: Date; end?: Date; createdAt?: Date; capture?: boolean; students?: string[]; status?: "active" | "ended" } = {}) {
  const start = options.start || at(0), id = randomUUID();
  await scoped(() => database.insert(contexts).values({ id, schoolId: ids.school, contextType: "manual", name: "MAP testing", assignedStaffId: ids.teacher, createdBy: ids.teacher, startsAt: start, endsAt: options.end || at(105), createdAt: options.createdAt || start, updatedAt: options.createdAt || start, status: options.status || "active", endedAt: options.status === "ended" ? options.end || at(105) : null }));
  const students = options.students || [ids.student, ids.secondStudent];
  if (students.length) await scoped(() => database.insert(assignments).values(students.map((studentId) => ({ schoolId: ids.school, contextId: id, studentId, assignedBy: ids.teacher, assignedAt: options.createdAt || start }))));
  if (options.capture !== false) await sync(id, options.createdAt || start, true);
  return id;
}
async function end(contextId: string, now = at(105)) {
  await scoped(() => database.update(contexts).set({ status: "ended", endedAt: now, updatedAt: now }).where(eq(contexts.id, contextId)));
  await scoped(() => database.update(assignments).set({ releasedAt: now }).where(eq(assignments.contextId, contextId)));
  await sync(contextId, now);
}
async function ready(now = at(106)) { const id = await context(); await end(id); assert.equal((await materialize(now)).ready, 1); return id; }
const postgresCode = (code: string) => (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  return ("code" in error && error.code === code) || ("cause" in error && postgresCode(code)(error.cause));
};

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Supervision summary tests require a local fixture database.");
  process.env.DATABASE_URL_PRIVILEGED = process.env.DATABASE_URL;
  ({ default: database, pool } = await import("../src/db.js"));
  ({ runWithTenantContext: withTenant } = await import("../src/middleware/tenantContext.js"));
  lifecycle = await import("../src/services/classpilotSupervisionReportLifecycle.js");
  processor = await import("../src/services/classpilotSupervisionReports.js");
  storage = await import("../src/services/storage.js");
  await pool.query(CLASSPILOT_SUPERVISION_REPORTS_SQL);
  await pool.query(CLASSPILOT_SUPERVISION_REPORTS_SQL);
  const domain = `${ids.school}.example.edu`;
  await pool.query("INSERT INTO schools(id,name,domain,school_timezone) VALUES($1,'Supervision summaries',$3,'America/New_York'),($2,'Other school',$3,'America/New_York')", [ids.school, ids.otherSchool, domain]);
  for (const teacher of [ids.teacher, ids.replacement, ids.central]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Summary','Teacher')", [teacher, `${teacher}@${domain}`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, teacher]);
  }
  await statement(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode) VALUES(${ids.school},'Supervision summaries','test-only',false,'off')`);
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.student},${ids.school},'First','Student','active'),(${ids.secondStudent},${ids.school},'Second','Student','active')`);
});

beforeEach(async () => {
  process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM = cutoff;
  process.env.CLASSPILOT_SUPERVISION_SUMMARY_EMAIL_ENABLED = "false";
  await statement(sql`DELETE FROM classpilot_monitoring_events WHERE school_id=${ids.school}`);
  await statement(sql`DELETE FROM classpilot_monitoring_interruptions WHERE school_id=${ids.school}`);
  await statement(sql`DELETE FROM student_sessions WHERE student_id IN (${ids.student},${ids.secondStudent})`);
  await statement(sql`DELETE FROM devices WHERE school_id=${ids.school}`);
  await statement(sql`DELETE FROM classpilot_student_control_states WHERE school_id=${ids.school}`);
  await statement(sql`DELETE FROM classpilot_supervision_students WHERE school_id=${ids.school}`);
  await statement(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id=${ids.school}`);
  await statement(sql`UPDATE settings SET central_email_recipient_user_id=NULL,retention_hours=720 WHERE school_id=${ids.school}`);
  await pool.query("UPDATE school_memberships SET status='active' WHERE school_id=$1", [ids.school]);
});

after(async () => {
  if (!pool) return;
  await withTenant({ isSuper: true }, async () => {
    await database.execute(sql`DELETE FROM classpilot_monitoring_interruptions WHERE school_id=${ids.school}`);
    await database.execute(sql`DELETE FROM classpilot_monitoring_events WHERE school_id=${ids.school}`);
    await database.execute(sql`DELETE FROM student_sessions WHERE student_id IN (${ids.student},${ids.secondStudent})`);
    await database.execute(sql`DELETE FROM devices WHERE school_id=${ids.school}`);
    for (const table of ["classpilot_monitoring_events", "classpilot_student_control_states", "classpilot_supervision_students", "classpilot_supervision_contexts", "students", "settings"])
      await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${ids.school}`);
  });
  await pool.query("DELETE FROM school_memberships WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM schools WHERE id IN($1,$2)", [ids.school, ids.otherSchool]);
  await pool.query("DELETE FROM users WHERE id IN($1,$2,$3)", [ids.teacher, ids.replacement, ids.central]);
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  const { sessionPool } = await import("../src/db.js");
  const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
  await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
});

test("9:00–10:45 testing closes once and waits thirty seconds before producing an honest unavailable report", async () => {
  const id = await context();
  await end(id); await sync(id, at(105.2));
  const [report] = await allReports(); assert.ok(report);
  assert.equal(report.state, "pending"); assert.equal(report.windowStart.toISOString(), at(0).toISOString());
  assert.equal(report.windowEnd?.toISOString(), at(105).toISOString());
  assert.equal(report.settleAt?.toISOString(), at(105.5).toISOString());
  assert.equal((await allDeliveries()).length, 1);
  assert.equal((await materialize(at(105.49))).claimed, 0);
  assert.equal((await materialize(at(105.5))).ready, 1);
  assert.equal((await materialize(at(106))).claimed, 0);
  assert.ok((await allDetails()).every((row) => row.result?.status === "unavailable" && row.result?.coveragePercent === null));
  const summary = (await allReports())[0]?.summary;
  assert.equal(summary?.startTime, "9:00 AM"); assert.equal(summary?.endTime, "10:45 AM");
  assert.equal(summary?.studentCount, 2);
  assert.doesNotMatch(JSON.stringify(summary), /deviceId|studentId|studentSessionId|accessToken|private=secret/);
});

test("handoff preserves outgoing ownership and gives the replacement only the remaining period", async () => {
  const id = await context();
  await sync(id, at(30));
  await scoped(() => database.update(contexts).set({ assignedStaffId: ids.replacement, updatedAt: at(30) }).where(eq(contexts.id, id)));
  await sync(id, at(30)); await end(id);
  const rows = await allReports(); assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.staffId, row.windowStart.toISOString(), row.windowEnd?.toISOString()]), [
    [ids.teacher, at(0).toISOString(), at(30).toISOString()], [ids.replacement, at(30).toISOString(), at(105).toISOString()],
  ]);
  for (const row of rows) {
    const children = (await allDetails()).filter((child) => child.reportId === row.id);
    assert.ok(children.every((child) => child.participationIntervals.every((interval) => interval.start === row.windowStart.toISOString() && interval.end === row.windowEnd?.toISOString())));
  }
  assert.deepEqual(new Set((await allDeliveries()).map((row) => row.recipientStaffId)), new Set([ids.teacher, ids.replacement]));
});

test("a stale worker clock cannot close a newer context or replacement supervisor's period", async () => {
  const id = await context();
  await sync(id, at(-1));
  assert.equal((await allReports()).length, 1); assert.equal((await allReports())[0]?.state, "active");
  assert.equal((await allDetails()).length, 2); assert.equal((await allDeliveries()).length, 0);
  await scoped(() => database.update(contexts).set({ assignedStaffId: ids.replacement, updatedAt: at(30) }).where(eq(contexts.id, id)));
  await sync(id, at(30));
  await scoped(() => lifecycle.reconcileSupervisionActivityReports({ schoolId: ids.school, now: at(29) }, database));
  const rows = await allReports(); assert.equal(rows.length, 2);
  assert.equal(rows[0]?.windowEnd?.toISOString(), at(30).toISOString());
  assert.equal(rows[1]?.staffId, ids.replacement); assert.equal(rows[1]?.state, "active"); assert.equal(rows[1]?.windowEnd, null);
  assert.equal((await allDeliveries()).length, 1);
});

test("partial release and rejoin retain separate student windows; final departure closes without ending other students early", async () => {
  const id = await context();
  await scoped(() => database.update(assignments).set({ releasedAt: at(15) }).where(and(eq(assignments.contextId, id), eq(assignments.studentId, ids.student))));
  await sync(id, at(15)); assert.equal((await allReports())[0]?.state, "active"); assert.equal((await allDeliveries()).length, 0);
  await scoped(() => database.insert(assignments).values({ schoolId: ids.school, contextId: id, studentId: ids.student, assignedBy: ids.teacher, assignedAt: at(30) }));
  await sync(id, at(30));
  await scoped(() => database.update(assignments).set({ releasedAt: at(60) }).where(and(eq(assignments.contextId, id), sql`${assignments.releasedAt} IS NULL`)));
  await sync(id, at(70));
  const [report] = await allReports(); assert.ok(report); assert.equal(report.closureReason, "last_student_departed"); assert.equal(report.windowEnd?.toISOString(), at(60).toISOString());
  const first = (await allDetails()).find((row) => row.studentId === ids.student)!;
  assert.deepEqual(first.participationIntervals.map(({ start, end }) => [start, end]), [[at(0).toISOString(), at(15).toISOString()], [at(30).toISOString(), at(60).toISOString()]]);
  const second = (await allDetails()).find((row) => row.studentId === ids.secondStudent)!;
  assert.deepEqual(second.participationIntervals.map(({ start, end }) => [start, end]), [[at(0).toISOString(), at(60).toISOString()]]);
});

test("extension retains its report; late expiry clips activity at the real end and settles from detection", async () => {
  const id = await context(); const originalId = (await allReports())[0]?.id; assert.ok(originalId);
  await scoped(() => database.update(contexts).set({ endsAt: at(120), updatedAt: at(90) }).where(eq(contexts.id, id)));
  await sync(id, at(106)); assert.equal((await allReports())[0]?.state, "active");
  await sync(id, at(135));
  const [report] = await allReports(); assert.ok(report); assert.equal(report.id, originalId);
  assert.equal(report.windowEnd?.toISOString(), at(120).toISOString()); assert.equal(report.settleAt?.toISOString(), at(135.5).toISOString());
  assert.ok((await allDetails()).every((row) => row.participationIntervals[0]?.end === at(120).toISOString()));
});

test("late activation starts at actual creation, and rollout adopts only currently supervised work without backfill", async () => {
  const id = await context({ createdAt: at(10) }); assert.equal((await allReports())[0]?.windowStart.toISOString(), at(10).toISOString());
  await end(id);
  const adopted = await context({ start: at(120), end: at(180), capture: false }); await sync(adopted, at(150));
  const row = (await allReports()).find((report) => report.contextId === adopted)!;
  assert.equal(row.partialAdoption, true); assert.equal(row.windowStart.toISOString(), at(150).toISOString());
  await end(adopted, at(180));
  const ended = await context({ start: at(190), end: at(200), capture: false, status: "ended" }); await sync(ended, at(210));
  assert.equal((await allReports()).filter((report) => report.contextId === ended).length, 0);
});

test("no capture occurs before activation, for empty work, or for a future context that has not started", async () => {
  delete process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM;
  await context({ students: [] }); assert.equal((await allReports()).length, 0);
  process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM = "not-a-date"; assert.equal(lifecycle.supervisionActivityReportingEnabled(at(0)), false);
  process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM = cutoff;
  const empty = await context({ students: [] }); await sync(empty, at(10)); assert.equal((await allReports()).length, 0);
  const future = await context({ start: at(120), end: at(180), capture: false }); await sync(future, at(10), true); assert.equal((await allReports()).length, 0);
});

test("two workers deduplicate delivery and the central copy does not duplicate the same email", async () => {
  await statement(sql`UPDATE settings SET central_email_recipient_user_id=${ids.teacher} WHERE school_id=${ids.school}`);
  await ready(); assert.equal((await allDeliveries()).length, 1);
  const sent: string[] = [];
  const transport: import("../src/services/classpilotSupervisionReports.js").SupervisionSummaryTransport = async (message) => { sent.push(message.deliveryId || "missing"); return { status: "sent", providerMessageId: "accepted-test" }; };
  const results = await Promise.all([dispatch(at(106), transport), dispatch(at(106), transport)]);
  assert.equal(results.reduce((count, result) => count + result.sent, 0), 1); assert.equal(sent.length, 1);
  assert.equal((await dispatch(at(120), transport)).claimed, 0);
});

test("an optional distinct central recipient gets a separate copy with the same immutable period", async () => {
  await statement(sql`UPDATE settings SET central_email_recipient_user_id=${ids.central} WHERE school_id=${ids.school}`);
  await ready(); assert.equal((await allDeliveries()).length, 2);
  const messages: import("../src/services/email.js").SessionSummaryEmailOptions[] = [];
  await dispatch(at(106), async (message) => { messages.push(message); return { status: "sent", providerMessageId: "accepted-test" }; });
  assert.equal(messages.length, 2); assert.ok(messages.some((message) => message.copyNotice?.includes("Central Email Copy")));
  assert.ok(messages.every((message) => message.startTime === "9:00 AM" && message.endTime === "10:45 AM"));
});

test("an unavailable configured central recipient records failure without preventing the supervisor's summary", async () => {
  await statement(sql`UPDATE settings SET central_email_recipient_user_id=${ids.central} WHERE school_id=${ids.school}`);
  await pool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [ids.school, ids.central]);
  await ready(); const rows = await allDeliveries(); assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.recipientKind === "central")?.state, "failed");
  assert.equal(rows.find((row) => row.recipientKind === "supervisor")?.state, "queued");
  assert.equal((await dispatch(at(106), async () => ({ status: "sent", providerMessageId: "supervisor-only" }))).sent, 1);
});

test("transient failures retry once due while ambiguous submission is never automatically resent", async () => {
  await ready(); let attempts = 0;
  const transport: import("../src/services/classpilotSupervisionReports.js").SupervisionSummaryTransport = async () => { attempts++; return attempts === 1 ? { status: "transient_failure", error: "try later" } : { status: "unknown", error: "connection lost" }; };
  assert.equal((await dispatch(at(106), transport)).retry, 1);
  assert.equal((await dispatch(at(106.5), transport)).claimed, 0);
  assert.equal((await dispatch(at(107), transport)).unknown, 1);
  assert.equal((await dispatch(at(180), transport)).claimed, 0); assert.equal(attempts, 2);
});

test("missing configuration, development no-op, and revoked recipients cannot count as delivered", async () => {
  await ready(); assert.equal((await dispatch(at(106))).claimed, 0);
  process.env.CLASSPILOT_SUPERVISION_SUMMARY_EMAIL_ENABLED = "true";
  assert.equal((await dispatch(at(106))).failed, 1); assert.equal((await allDeliveries())[0]?.sentAt, null);
  await scoped(() => database.update(deliveries).set({ state: "queued", nextAttemptAt: at(107) }).where(eq(deliveries.schoolId, ids.school)));
  assert.equal((await dispatch(at(107), async () => ({ status: "sent", providerMessageId: "development-noop" }))).failed, 1);
  await scoped(() => database.update(deliveries).set({ state: "queued", nextAttemptAt: at(108) }).where(eq(deliveries.schoolId, ids.school)));
  await pool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [ids.school, ids.teacher]);
  let sent = false;
  assert.equal((await dispatch(at(108), async () => { sent = true; return { status: "sent", providerMessageId: "must-not-send" }; })).failed, 1);
  assert.equal(sent, false);
});

test("forced RLS isolates all report tables and rejects a foreign-school parent", async () => {
  await ready();
  // Local CI fixtures connect as postgres, which bypasses even forced RLS.
  // Exercise the installed policies as a dedicated non-bypass runtime role.
  const role = `cp_summary_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON classpilot_supervision_report_segments,classpilot_supervision_student_reports,classpilot_supervision_summary_deliveries TO ${role}`);
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.is_super','',true),set_config('app.school_id',$1,true)", [ids.school]);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM classpilot_supervision_report_segments")).rows[0].n, 1);
    await client.query("SELECT set_config('app.school_id',$1,true)", [ids.otherSchool]);
    for (const table of ["classpilot_supervision_report_segments", "classpilot_supervision_student_reports", "classpilot_supervision_summary_deliveries"])
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  } finally {
    await client.query("ROLLBACK");
    await client.query(`DROP OWNED BY ${role}`);
    await client.query(`DROP ROLE ${role}`);
    client.release();
  }
  const [report] = await allReports(); assert.ok(report);
  await assert.rejects(withTenant({ schoolId: ids.otherSchool }, () => database.insert(details).values({ schoolId: ids.otherSchool, reportId: report.id, studentId: ids.student, studentNameSnapshot: "Not authorized" })), postgresCode("23503"));
  const result = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('classpilot_supervision_report_segments','classpilot_supervision_student_reports','classpilot_supervision_summary_deliveries')");
  assert.equal(result.rows.length, 3); assert.ok(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
});

test("real storage create, extend, handoff, student transfer and release hooks preserve reporting boundaries", async () => {
  const start = new Date(Date.now() - 1000), finish = new Date(Date.now() + 3_600_000);
  const make = (staffId: string, studentIds: string[]) => scoped(() => storage.createSupervisionContextWithStudents({
    context: { schoolId: ids.school, contextType: "manual", name: "Live Coverage", assignedStaffId: staffId, createdBy: staffId, startsAt: start, endsAt: finish }, studentIds, assignedBy: staffId,
  }));
  const first = await make(ids.teacher, [ids.student, ids.secondStudent]);
  const initial = (await allReports())[0]; assert.ok(initial); assert.equal(initial.state, "active");
  await scoped(() => storage.extendSupervisionContext({ schoolId: ids.school, contextId: first.id, endsAt: new Date(finish.getTime() + 60_000) }));
  assert.equal((await allReports())[0]?.id, initial.id);
  await scoped(() => storage.extendSupervisionContext({ schoolId: ids.school, contextId: first.id, assignedStaffId: ids.replacement }));
  let rows = await allReports(); assert.equal(rows.length, 2); assert.equal(rows[0]?.state, "pending"); assert.equal(rows[1]?.staffId, ids.replacement);
  assert.equal(rows[0]?.windowEnd?.toISOString(), rows[1]?.windowStart.toISOString());
  const second = await make(ids.teacher, [ids.student]);
  rows = await allReports(); assert.equal(rows.find((row) => row.contextId === first.id && row.staffId === ids.replacement)?.state, "active");
  await scoped(() => storage.assignStudentsToSupervisionContext({ schoolId: ids.school, contextId: second.id, studentIds: [ids.secondStudent], assignedBy: ids.teacher }));
  rows = await allReports(); assert.equal(rows.find((row) => row.contextId === first.id && row.staffId === ids.replacement)?.state, "pending");
  const source = rows.find((row) => row.contextId === first.id && row.staffId === ids.replacement)!;
  const target = rows.find((row) => row.contextId === second.id)!;
  const children = await allDetails();
  for (const studentId of [ids.student, ids.secondStudent]) {
    const departed = children.find((row) => row.reportId === source.id && row.studentId === studentId)!;
    const arrived = children.find((row) => row.reportId === target.id && row.studentId === studentId)!;
    const departure = departed.participationIntervals[0], arrival = arrived.participationIntervals[0];
    assert.ok(departure); assert.ok(arrival); assert.equal(departure.end, arrival.start);
  }
  await scoped(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: second.id, studentIds: [ids.student] }));
  assert.equal((await allReports()).find((row) => row.id === target.id)?.state, "active");
  await scoped(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: second.id }));
  assert.ok((await allReports()).every((row) => row.state === "pending"));
  assert.equal((await allDeliveries()).length, 3);
});

test("failed actual activation rolls back both supervision and reporting rows", async () => {
  await pool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [ids.school, ids.teacher]);
  await assert.rejects(scoped(() => storage.createSupervisionContextWithStudents({ context: {
    schoolId: ids.school, contextType: "manual", name: "Must not start", assignedStaffId: ids.teacher, createdBy: ids.teacher,
    startsAt: new Date(), endsAt: new Date(Date.now() + 60_000),
  }, studentIds: [ids.student], assignedBy: ids.teacher })));
  assert.equal((await allReports()).length, 0); assert.equal((await allDeliveries()).length, 0);
  assert.equal((await scoped(() => database.select().from(contexts).where(eq(contexts.schoolId, ids.school)))).length, 0);
});

test("scheduled-class Coverage claim and teacher resolution capture one supervisor period and one delivery", async () => {
  const classId = randomUUID(), occurrenceId = randomUUID(), conflictId = randomUUID();
  const now = new Date(), finish = new Date(now.getTime() + 3_600_000), date = now.toISOString().slice(0, 10);
  await statement(sql`INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES(${classId},${ids.school},${ids.teacher},'Coverage needed','admin_class','active')`);
  try {
    await statement(sql`INSERT INTO classpilot_scheduled_conflicts(id,school_id,group_id,teacher_id,scheduled_date,block_start_time,block_end_time,status)
      VALUES(${conflictId},${ids.school},${classId},${ids.teacher},${date},'09:00','10:00','coverage_needed')`);
    await statement(sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,session_mode,scheduled_conflict_id,scheduled_state,scheduled_date,scheduled_start_at,scheduled_end_at,scheduled_timezone)
      VALUES(${occurrenceId},${ids.school},${classId},${ids.teacher},${now.toISOString()}::timestamptz,'scheduled_report',${conflictId},'active',${date},${now.toISOString()}::timestamptz,${finish.toISOString()}::timestamptz,'America/New_York')`);
    const claimed = await scoped(() => storage.claimScheduledCoverageStudents({ schoolId: ids.school, scheduledConflictId: conflictId, className: "Coverage needed", assignedStaffId: ids.replacement, actorId: ids.replacement, studentIds: [ids.student], endsAt: finish }));
    const [active] = await allReports(); assert.ok(active);
    assert.equal(active.contextId, claimed.context.id); assert.equal(active.contextType, "scheduled_coverage"); assert.equal(active.staffId, ids.replacement); assert.equal(active.state, "active");
    assert.equal((await allDeliveries()).length, 0);
    const released = await scoped(() => storage.releaseScheduledConflictSupervision({ schoolId: ids.school, scheduledConflictId: conflictId, releaseReason: "scheduled_teacher_started" }));
    assert.equal(released.length, 1);
    const [closed] = await allReports(); assert.ok(closed?.windowEnd);
    assert.equal(closed.id, active.id); assert.equal(closed.state, "pending"); assert.ok(closed.windowEnd > closed.windowStart);
    assert.ok(closed.windowStart >= now); assert.ok(closed.windowEnd < finish);
    assert.equal(closed.windowEnd.toISOString(), released[0]?.releasedAt?.toISOString());
    const [student] = await allDetails(); assert.ok(student);
    assert.deepEqual(student.participationIntervals.map(({ start, end }) => [start, end]), [[closed.windowStart.toISOString(), closed.windowEnd.toISOString()]]);
    assert.equal((await scoped(() => storage.releaseScheduledConflictSupervision({ schoolId: ids.school, scheduledConflictId: conflictId }))).length, 0);
    const queued = await allDeliveries(); assert.equal(queued.length, 1); assert.equal(queued[0]?.recipientStaffId, ids.replacement); assert.equal(queued[0]?.state, "waiting_report");
  } finally {
    await statement(sql`DELETE FROM classpilot_student_control_states WHERE school_id=${ids.school}`);
    await statement(sql`DELETE FROM classpilot_supervision_students WHERE school_id=${ids.school}`);
    await statement(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id=${ids.school}`);
    await statement(sql`DELETE FROM teaching_sessions WHERE id=${occurrenceId}`);
    await statement(sql`DELETE FROM classpilot_scheduled_conflicts WHERE id=${conflictId}`);
    await statement(sql`DELETE FROM groups WHERE id=${classId}`);
  }
});

test("existing history and event views give each supervisor only their tenure, and expired tracking cannot fall back to the latest owner", async () => {
  const now = new Date(), start = new Date(now.getTime() - 3_600_000), handoff = new Date(now.getTime() - 1_800_000), finish = new Date(now.getTime() - 60_000);
  const id = await context({ start, end: finish, capture: false, students: [ids.student] });
  await sync(id, start, true);
  await scoped(() => database.update(contexts).set({ assignedStaffId: ids.replacement, updatedAt: handoff }).where(eq(contexts.id, id)));
  await sync(id, handoff); await end(id, finish);
  const history = await import("../src/services/classpilotStudentData.js");
  const authority = (actorId: string) => scoped(() => history.getClasspilotStudentHistoryAuthority({ schoolId: ids.school, studentId: ids.student, actorId, now, retentionCutoff: new Date(now.getTime() - 86_400_000), dbInstance: database }));
  assert.deepEqual((await authority(ids.teacher)).windows, [{ start, end: handoff }]);
  assert.deepEqual((await authority(ids.replacement)).windows, [{ start: handoff, end: finish }]);
  assert.equal(await scoped(() => storage.isAuthorizedClasspilotSupervisionStaff(ids.school, id, ids.teacher)), true);
  // Event ownership is evaluated before pagination using the same recorded intervals.
  const { supervisionEventOwnershipSql } = await import("../src/services/classpilotSupervisionHistory.js");
  for (const [staffId, expected] of [[ids.teacher, [true, false]], [ids.replacement, [false, true]]] as const) {
    const result = await scoped(() => database.execute<{ allowed: boolean }>(sql`
      SELECT ${supervisionEventOwnershipSql({ schoolId: ids.school, contextId: id, staffId,
        studentId: sql`${ids.student}`, occurredAt: sql`event.at`, now })} AS allowed
      FROM (VALUES (${new Date(start.getTime() + 60_000).toISOString()}::timestamptz),(${new Date(handoff.getTime() + 60_000).toISOString()}::timestamptz)) AS event(at) ORDER BY event.at`));
    assert.deepEqual(result.rows.map((row) => row.allowed), expected);
  }
  const deviceId = `summary-history-${randomUUID()}`, studentSessionId = randomUUID();
  const beforeHandoff = new Date(handoff.getTime() - 1), incidentIds = [randomUUID(), randomUUID()];
  await statement(sql`INSERT INTO devices(school_id,class_id,device_id,device_name) VALUES(${ids.school},${ids.school},${deviceId},'Summary history fixture')`);
  await statement(sql`INSERT INTO student_sessions(id,student_id,device_id,started_at,last_seen_at,auth_kind,is_active) VALUES(${studentSessionId},${ids.student},${deviceId},${start.toISOString()}::timestamptz,${finish.toISOString()}::timestamptz,'managed_profile',false)`);
  for (const [index, occurredAt] of [beforeHandoff, handoff].entries()) {
    await statement(sql`INSERT INTO classpilot_monitoring_interruptions(id,expectation_id,school_id,student_id,student_session_id,device_id,scope_type,scope_id,scope_name,last_observed_at,detected_at,retention_expires_at)
      VALUES(${incidentIds[index]!},${randomUUID()},${ids.school},${ids.student},${studentSessionId},${deviceId},'supervision_context',${id},'MAP testing',${new Date(occurredAt.getTime() - 61_000).toISOString()}::timestamptz,${occurredAt.toISOString()}::timestamptz,${new Date(now.getTime() + 86_400_000).toISOString()}::timestamptz)`);
    await statement(sql`INSERT INTO classpilot_monitoring_events(school_id,student_id,student_session_id,supervision_context_id,source_event_id,origin,event_type,occurred_at,retention_expires_at)
      VALUES(${ids.school},${ids.student},${studentSessionId},${id},${incidentIds[index]!},'extension','navigation_changed',${occurredAt.toISOString()}::timestamptz,${new Date(now.getTime() + 86_400_000).toISOString()}::timestamptz)`);
  }
  const interruptions = await import("../src/services/classpilotMonitoringInterruptions.js");
  for (const [actorId, expectedId] of [[ids.teacher, incidentIds[0]], [ids.replacement, incidentIds[1]]] as const) {
    const options = { schoolId: ids.school, actorId, isAdmin: false, now };
    assert.deepEqual((await scoped(() => interruptions.getMonitoringInterruptionSummary(options))).counts, { open: 1, last24Hours: 1 });
    for (const filter of ["open", "recent"] as const) {
      const page = await scoped(() => interruptions.listMonitoringInterruptionHistory({ ...options, filter }));
      assert.deepEqual(page.incidents.map((row) => row.id), [expectedId]);
    }
    assert.deepEqual((await scoped(() => interruptions.listMonitoringInterruptions(options))).incidents.map((row) => row.id), [expectedId]);
    const events = await scoped(() => storage.listClasspilotMonitoringEvents({ schoolId: ids.school, scope: { kind: "supervision_context", id }, supervisionStaffId: actorId, limit: 1 }));
    assert.deepEqual(events.map((row) => row.event.sourceEventId), [expectedId]);
  }
  const adminOptions = { schoolId: ids.school, actorId: ids.central, isAdmin: true, now };
  assert.deepEqual((await scoped(() => interruptions.getMonitoringInterruptionSummary(adminOptions))).counts, { open: 2, last24Hours: 2 });
  assert.equal((await scoped(() => interruptions.listMonitoringInterruptionHistory({ ...adminOptions, filter: "recent" }))).incidents.length, 2);
  await scoped(() => database.update(reports).set({ expiresAt: now }).where(eq(reports.schoolId, ids.school)));
  await scoped(() => lifecycle.purgeExpiredSupervisionActivityReports({ schoolId: ids.school, now }, database));
  assert.deepEqual((await authority(ids.replacement)).windows, []); assert.deepEqual((await authority(ids.teacher)).windows, []);
  assert.equal(await scoped(() => storage.isAuthorizedClasspilotSupervisionStaff(ids.school, id, ids.replacement)), false);
  assert.deepEqual((await scoped(() => interruptions.getMonitoringInterruptionSummary({ schoolId: ids.school, actorId: ids.replacement, isAdmin: false, now }))).counts, { open: 0, last24Hours: 0 });
});

test("retention stops queued mail and clears student data while retaining a non-PII ownership tombstone", async () => {
  const id = await ready(); const [report] = await allReports(); assert.ok(report); assert.ok(report.expiresAt);
  assert.equal(await scoped(() => lifecycle.purgeExpiredSupervisionActivityReports({ schoolId: ids.school, now: report.expiresAt! }, database)), 1);
  assert.equal((await allDetails()).length, 0);
  const retained = (await allReports())[0]; assert.ok(retained); assert.equal(retained.contextId, id); assert.equal(retained.staffId, null); assert.equal(retained.summary, null); assert.equal(retained.state, "expired");
  assert.ok((await allDeliveries()).every((row) => row.state === "expired" && row.recipientEmail === null));
  let sent = false; await dispatch(report.expiresAt, async () => { sent = true; return { status: "sent" }; }); assert.equal(sent, false);
});

test("shortening current retention blocks queued delivery before the original report expiry and clears its details", async () => {
  await ready(); const now = at(105 + 2 * 1440);
  const [report] = await allReports(); assert.ok(report?.expiresAt); assert.ok(report.expiresAt > now);
  await statement(sql`UPDATE settings SET retention_hours=24 WHERE school_id=${ids.school}`);
  let sent = false;
  assert.equal((await dispatch(now, async () => { sent = true; return { status: "sent" }; })).claimed, 0); assert.equal(sent, false);
  assert.equal(await scoped(() => lifecycle.purgeExpiredSupervisionActivityReports({ schoolId: ids.school, now }, database)), 1);
  assert.equal((await allDetails()).length, 0); assert.equal((await allReports())[0]?.state, "expired");
});

function activityInput(): ClasspilotActivityReportInput {
  return { roster: [{ studentId: ids.student, studentName: "First Student", capturedAt: at(0) }],
    authenticatedSessions: [{ id: "auth", studentId: ids.student, startedAt: at(-10), endedAt: at(120), lastSeenAt: at(120) }],
    heartbeats: [], aiDecisions: [], evidenceArtifacts: [], exclusions: [], monitoringEvents: [],
    trackingPolicy: { enableTrackingHours: false, trackingStartTime: null, trackingEndTime: null, trackingDays: [], schoolTimezone: "America/New_York", afterHoursMode: "off" } };
}
function event(minutes: number): ClasspilotMonitoringEvent {
  return { id: randomUUID(), schoolId: ids.school, studentId: ids.student, deviceId: null, studentSessionId: "auth", teachingSessionId: null, supervisionContextId: "context", sourceEventId: randomUUID(), schemaVersion: 1, origin: "extension", eventType: "navigation_changed", occurredAt: at(minutes), receivedAt: at(minutes), normalizedDomain: "example.edu", sanitizedPath: null, title: null, metadata: {}, retentionExpiresAt: at(1440) };
}

test("metrics, safety labels and events exclude absent student windows and honor adjacent handoff boundaries", () => {
  const input = activityInput();
  input.heartbeats = [0, 15, 29, 30, 60, 104, 105].map((minutes) => ({ id: `heartbeat-${minutes}`, studentId: ids.student, timestamp: at(minutes), activeTabUrl: `https://at-${minutes}.example/path?private=secret`, aiCategory: "non-educational", safetyAlert: "violence" }));
  input.monitoringEvents = [0, 15, 29, 30, 60, 104, 105].map(event);
  const window = { windowStart: at(0), windowEnd: at(105), reportVersion: 2 };
  const [result] = processor.materializeSupervisionStudents(window, input, new Map([[ids.student, [{ start: at(0), end: at(15) }, { start: at(30), end: at(105) }]] ]));
  assert.ok(result);
  assert.equal(result.eligibleSeconds, 90 * 60); assert.equal(result.heartbeatCount, 4);
  assert.equal(result.eventCounts.navigation_changed, 4);
  assert.deepEqual(result.safetyAlerts.map((alert) => alert.occurredAt), [0, 30, 60, 104].map((minute) => at(minute).toISOString()));
  assert.ok(result.topDomains.every((domain) => !["at-15.example", "at-29.example", "at-105.example"].includes(domain.domain)));
  const [incoming] = processor.materializeSupervisionStudents({ ...window, windowStart: at(30) }, input, new Map([[ids.student, [{ start: at(30), end: at(105) }]]]));
  assert.ok(incoming);
  assert.equal(incoming.eligibleSeconds, 75 * 60); assert.equal(incoming.safetyAlerts.length, 3);
});

test("roster capture, missing authentication and intentionally disabled monitoring keep distinct meanings", () => {
  const input = activityInput(); assert.ok(input.roster[0]); input.roster[0].capturedAt = at(30);
  input.heartbeats = [0, 30].map((minute) => ({ id: randomUUID(), studentId: ids.student, timestamp: at(minute), activeTabUrl: "https://example.edu", aiCategory: null, safetyAlert: "violence" }));
  const window = { windowStart: at(0), windowEnd: at(105), reportVersion: 2 };
  const participation = new Map([[ids.student, [{ start: at(0), end: at(105) }]]]);
  const [captured] = processor.materializeSupervisionStudents(window, input, participation);
  assert.ok(captured);
  assert.equal(captured.eligibleSeconds, 75 * 60); assert.equal(captured.safetyAlerts.length, 1);
  input.authenticatedSessions = [];
  const [unavailable] = processor.materializeSupervisionStudents(window, input, participation); assert.ok(unavailable); assert.equal(unavailable.status, "unavailable"); assert.equal(unavailable.coveragePercent, null);
  input.trackingPolicy = { ...input.trackingPolicy, enableTrackingHours: true, trackingDays: ["Tuesday"], trackingStartTime: "08:00", trackingEndTime: "15:00" };
  assert.equal(processor.materializeSupervisionStudents(window, input, participation)[0]?.status, "not_expected");
});
