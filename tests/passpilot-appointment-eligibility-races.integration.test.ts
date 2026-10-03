import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { appointmentFixture, type AppointmentFixture, type AppointmentTenant } from "./helpers/passpilotAppointmentFixture.js";
import registry from "../src/config/rlsRegistry.json" with { type: "json" };

process.env.NODE_ENV = "test"; process.env.REDIS_URL = "";
process.env.PASSPILOT_APPOINTMENTS_MODE = "on"; process.env.PASSPILOT_RULES_MODE = "on";
process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = registry.inventories.passpilotAppointmentsPostExpand.tables.join(",");
let f: AppointmentFixture, school: AppointmentTenant;
before(async () => { f = await appointmentFixture(); school = await f.createTenant(true); });
afterEach(async () => f.reset()); after(async () => f.close());
async function waitFor(predicate: () => Promise<boolean>, message: string, timeout = 5000) {
  const until = Date.now() + timeout;
  do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < until);
  assert.fail(message);
}
const studentWait = async () => (await f.sql("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%students%for update%' AND pid<>pg_backend_pid()")).rows[0].count > 0;
async function heldStatement(pid: number, fragment: string) {
  return (await f.sql("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE $2", [pid, `%${fragment}%`])).rows[0].count > 0;
}
async function blocker() {
  const connection = new Client({ connectionString: process.env.DATABASE_URL }); await connection.connect();
  await connection.query("BEGIN"); await connection.query("SELECT set_config('app.is_super','on',true)");
  const pid = Number((await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  return { connection, pid };
}
async function appointment() { const created = await f.create(school); assert.equal(created.status, 201); return created.body.appointment; }
async function attendance(bulk = false) {
  const { markStudentAbsent, markStudentsAbsentBulk } = await import("../src/services/storage.js");
  const fields = { date: new Date().toISOString().slice(0, 10), status: "absent", markedBy: school.admin.id };
  return f.runWithTenantContext({ schoolId: school.schoolId }, async () => bulk
    ? await markStudentsAbsentBulk(school.schoolId, [school.students[0]!], fields)
    : await markStudentAbsent({ schoolId: school.schoolId, studentId: school.students[0]!, ...fields }));
}
async function barrier(table: "passes" | "student_attendance") {
  const name = `appt_barrier_${randomUUID().replaceAll("-", "")}`, key = randomUUID();
  await f.sql(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.school_id='${school.schoolId}' THEN PERFORM pg_advisory_xact_lock(hashtext('${key}')); END IF; RETURN NEW; END$$; CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  const locked = await blocker(); await locked.connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  return { ...locked, clean: async () => { await locked.connection.query("ROLLBACK"); await locked.connection.end(); await f.sql(`DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}()`); } };
}

describe("Appointment eligibility serializes with attendance and dismissal writers", { concurrency: false }, () => {
  for (const bulk of [false, true]) {
  it(`keeps a ${bulk ? "bulk" : "single"} absence insert uncommitted while canonical issuance owns the student's eligibility decision`, async () => {
    const row = await appointment(), gate = await barrier("passes");
    let absenceCommitted = false;
    const activation = f.activate(school, row.id);
    let absence: ReturnType<typeof attendance> | undefined;
    try {
      await waitFor(() => heldStatement(gate.pid, 'insert into "passes"'), "Activation must reach the real canonical pass insert barrier");
      absence = attendance(bulk).then(result => { absenceCommitted = true; return result; });
      await waitFor(async () => absenceCommitted || await studentWait(), "The attendance writer must reach the student lock");
      assert.equal(absenceCommitted, false, "An absence must not commit between eligibility validation and pass issuance");
      assert.equal(await studentWait(), true);
      assert.equal((await f.sql("SELECT count(*)::int AS count FROM student_attendance WHERE school_id=$1", [school.schoolId])).rows[0].count, 0);
      await gate.connection.query("COMMIT");
      assert.equal((await activation).status, 201); await absence;
    } finally { await gate.connection.query("ROLLBACK"); await Promise.allSettled([activation, ...(absence ? [absence] : [])]); await gate.clean(); }
  });
  it(`waits for a ${bulk ? "bulk" : "single"} absence writer, then denies activation after that absence commits`, async () => {
    const row = await appointment(), gate = await barrier("student_attendance");
    const absence = attendance(bulk); let activation: ReturnType<AppointmentFixture["activate"]> | undefined;
    let activated = false;
    try {
      await waitFor(() => heldStatement(gate.pid, 'insert into "student_attendance"'), "Real attendance writer must reach its insert barrier");
      activation = f.activate(school, row.id).then(result => { activated = true; return result; });
      await waitFor(async () => activated || (await f.sql("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%students%for share%' AND pid<>pg_backend_pid()")).rows[0].count > 0,
        "Activation must wait for the real attendance writer's student lock");
      assert.equal(activated, false, "Activation must not issue while the earlier absence writer is uncommitted");
      await gate.connection.query("COMMIT"); await absence;
      const result = await activation; assert.equal(result.status, 409); assert.equal(result.body.code, "APPOINTMENT_STUDENT_UNAVAILABLE");
      assert.equal((await f.sql("SELECT count(*)::int AS count FROM passes WHERE school_id=$1", [school.schoolId])).rows[0].count, 0);
    } finally { await gate.connection.query("ROLLBACK"); await Promise.allSettled([absence, ...(activation ? [activation] : [])]); await gate.clean(); }
  });
  }
  it("does not reverse dismissal's session then student lock order when rejecting an already-released student", async () => {
    const row = await appointment(), sessionId = randomUUID(), queueId = randomUUID();
    await f.sql("INSERT INTO dismissal_sessions(id,school_id,date,status) VALUES($1,$2,$3,'active')", [sessionId, school.schoolId, new Date().toISOString().slice(0, 10)]);
    await f.sql("INSERT INTO dismissal_queue(id,school_id,session_id,student_id,position,status) VALUES($1,$2,$3,$4,1,'released')", [queueId, school.schoolId, sessionId, school.students[0]]);
    const locked = await blocker(); await locked.connection.query("SELECT id FROM dismissal_sessions WHERE id=$1 FOR UPDATE", [sessionId]);
    const activation = f.activate(school, row.id); let result: Awaited<typeof activation> | undefined;
    const finished = activation.then(value => { result = value; });
    try {
      await waitFor(async () => Boolean(result) || await heldStatement(locked.pid, 'dismissal_queue'), "Activation must make its real dismissal eligibility read");
      // This is the same second lock used by releaseQueueEntry/dismissQueueEntry.
      // It must succeed while the writer still owns the session lock.
      await locked.connection.query("SET LOCAL statement_timeout='1500ms'");
      await locked.connection.query("SELECT id FROM students WHERE school_id=$1 AND id=$2 FOR UPDATE", [school.schoolId, school.students[0]]);
      await finished; assert.equal(result!.status, 409); assert.equal(result!.body.code, "APPOINTMENT_STUDENT_UNAVAILABLE");
      await locked.connection.query("COMMIT");
    } finally { await locked.connection.query("ROLLBACK"); await locked.connection.end(); await finished; }
  });
});
