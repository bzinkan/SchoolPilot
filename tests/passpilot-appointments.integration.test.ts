import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appointmentFixture, type AppointmentFixture, type AppointmentTenant } from "./helpers/passpilotAppointmentFixture.js";
import registry from "../src/config/rlsRegistry.json" with { type: "json" };

process.env.NODE_ENV = "test"; process.env.REDIS_URL = "";
process.env.PASSPILOT_APPOINTMENTS_MODE = "on"; process.env.PASSPILOT_RULES_MODE = "on";
process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = registry.inventories.passpilotAppointmentsPostExpand.tables.join(",");
let f: AppointmentFixture; let legacy: AppointmentTenant; let canonical: AppointmentTenant; let other: AppointmentTenant;
before(async () => { f = await appointmentFixture(); legacy = await f.createTenant(); canonical = await f.createTenant(true); other = await f.createTenant(); });
afterEach(async () => f.reset()); after(async () => f.close());
const count = async (table: string, schoolId: string) => Number((await f.sql(`SELECT count(*)::int AS count FROM ${table} WHERE school_id=$1`, [schoolId])).rows[0].count);
const get = (t: AppointmentTenant, id: string, person = t.teacher) => f.call(t, person, "GET", `/passpilot/appointments/${id}`);
async function created(t = legacy, index = 0, patch: Record<string, unknown> = {}) {
  const result = await f.create(t, index, patch); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.appointment;
}
describe("PassPilot appointments: staff authority, atomic activation and lifecycle", { concurrency: false }, () => {
  it("derives staff UI capabilities from current PassPilot authority and verified school settings", async () => {
    const teacher = await f.call(legacy, legacy.teacher, "GET", "/passpilot/appointments/capabilities");
    assert.equal(teacher.status, 200); assert.equal(teacher.body.teacherReminders, true); assert.equal(teacher.body.manager, false);
    assert.equal(teacher.body.schoolTimezone, "UTC"); assert.equal(teacher.body.schoolYearConfigured, true);
    for (const person of [legacy.admin, legacy.office]) {
      const result = await f.call(legacy, person, "GET", "/passpilot/appointments/capabilities");
      assert.equal(result.status, 200); assert.equal(result.body.manager, true); assert.equal(result.body.teacherReminders, false);
    }
    assert.equal((await f.call(legacy, legacy.parent, "GET", "/passpilot/appointments/capabilities")).status, 403);
    await f.schedule(legacy, { yearStart: null, yearEnd: null });
    assert.equal((await f.call(legacy, legacy.teacher, "GET", "/passpilot/appointments/capabilities")).body.schoolYearConfigured, false);
    process.env.PASSPILOT_APPOINTMENTS_MODE = "off";
    assert.equal((await f.call(legacy, legacy.teacher, "GET", "/passpilot/appointments/capabilities")).status, 404);
  });
  it("lists current-authority staff reminders for still-open windows starting yesterday", async () => {
    const now = Date.now(), startsAt = new Date(now - 23 * 3600000), endsAt = new Date(now + 1800000);
    await f.schedule(canonical, { dateOverrides: { [startsAt.toISOString().slice(0, 10)]: { instructional: true } } });
    const row = await created(canonical, 0, { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
    const params = new URLSearchParams({ from: new Date(now - 24 * 3600000).toISOString(), through: new Date(now + 86400000).toISOString(), status: "scheduled" });
    const list = await f.call(canonical, canonical.teacher, "GET", `/passpilot/appointments?${params}`);
    assert.equal(list.status, 200); assert.equal(list.body.appointments[0]!.id, row.id);
    assert.equal(list.body.appointments[0]!.studentName, "Student0 Fixture"); assert.equal("staffNotes" in list.body.appointments[0]!, false);
    await f.assignTeacher(canonical, canonical.outsider);
    assert.equal((await f.call(canonical, canonical.teacher, "GET", `/passpilot/appointments?${params}`)).body.appointments.length, 0);
  });
  it("preserves pre-activation pass returns for an old restricted writer without appointment grants", async () => {
    process.env.PASSPILOT_APPOINTMENTS_MODE = "off";
    assert.equal((await f.sql("SELECT count(*)::int AS count FROM passpilot_appointments")).rows[0].count, 0, "Pre-admission fixture must have no appointments");
    const role = `appt_old_writer_${randomUUID().replaceAll("-", "")}`;
    const passId = randomUUID();
    await f.sql("INSERT INTO passes(id,school_id,student_id,grade_id,destination,status,expires_at) VALUES($1,$2,$3,$4,'office','active',now()+interval '5 minutes')", [passId, legacy.schoolId, legacy.students[15], legacy.classId]);
    await f.sql(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,UPDATE ON passes TO ${role}`);
    try {
      for (const privileges of [[], ["SELECT"], ["UPDATE"]]) {
      await f.sql(`REVOKE ALL ON passpilot_appointments FROM ${role}`);
      if (privileges.length) await f.sql(`GRANT ${privileges.join(",")} ON passpilot_appointments TO ${role}`);
      await f.sql("UPDATE passes SET status='active' WHERE id=$1", [passId]);
      await f.sql("BEGIN"); await f.sql(`SET LOCAL ROLE ${role}`);
      await f.sql("SELECT set_config('app.is_super','off',true),set_config('app.school_id',$1,true)", [legacy.schoolId]);
      const actual = await f.sql("SELECT has_table_privilege(current_user,'passpilot_appointments','SELECT') AS can_select,has_table_privilege(current_user,'passpilot_appointments','UPDATE') AS can_update");
      assert.deepEqual(actual.rows[0], { can_select: privileges.includes("SELECT"), can_update: privileges.includes("UPDATE") });
      assert.equal((await f.sql("UPDATE passes SET status='returned',returned_at=now() WHERE id=$1 RETURNING status", [passId])).rows[0].status, "returned");
      await f.sql("COMMIT");
      }
    } finally { await f.sql("ROLLBACK"); await f.sql(`RESET ROLE; DROP OWNED BY ${role}; DROP ROLE ${role}`); }
    assert.equal((await f.sql("SELECT status FROM passes WHERE id=$1", [passId])).rows[0].status, "returned");
  });
  it("keeps off/missing-admission routes at 404, including anonymous requests", async () => {
    for (const mode of ["off", "invalid"]) {
      process.env.PASSPILOT_APPOINTMENTS_MODE = mode;
      const res = await fetch(f.url + "/passpilot/appointments"); assert.equal(res.status, 404);
    }
    process.env.PASSPILOT_APPOINTMENTS_MODE = "on";
    const old = process.env.RLS_ENABLED_TABLES; process.env.RLS_ENABLED_TABLES = "passes";
    try { assert.equal((await f.create(legacy)).status, 404); } finally { process.env.RLS_ENABLED_TABLES = old; }
  });
  it("allows existing managers, resolves multiple current roles, and rejects teachers/GoPilot-only office profiles", async () => {
    assert.equal((await f.create(legacy, 0, {}, legacy.teacher)).status, 403);
    assert.equal((await f.create(legacy, 0, {}, legacy.parent)).status, 403);
    assert.equal((await f.create(legacy, 0, {}, legacy.office)).status, 201);
    await f.sql("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [legacy.schoolId, legacy.admin.id]);
    try { assert.equal((await f.create(legacy, 1)).status, 201); }
    finally { await f.sql("DELETE FROM school_memberships WHERE user_id=$1 AND role='teacher'", [legacy.admin.id]); }
  });
  it("deduplicates concurrent manager creation and rejects changed-payload reuse", async () => {
    const body = f.payload(legacy);
    const results = await Promise.all([f.call(legacy, legacy.admin, "POST", "/passpilot/appointments", body), f.call(legacy, legacy.admin, "POST", "/passpilot/appointments", body)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
    assert.equal(results[0]!.body.appointment.id, results[1]!.body.appointment.id);
    assert.equal(await count("passpilot_appointments", legacy.schoolId), 1);
    assert.equal((await f.call(legacy, legacy.admin, "POST", "/passpilot/appointments", { ...body, staffNotes: "Changed" })).status, 409);
  });
  it("requires configured school year and captures only the verified school timezone", async () => {
    await f.schedule(legacy, { yearStart: null, yearEnd: null });
    const missing = await f.create(legacy); assert.equal(missing.status, 409); assert.equal(missing.body.code, "APPOINTMENT_SCHOOL_YEAR_REQUIRED");
    await f.schedule(legacy);
    assert.equal((await f.create(legacy, 0, { schoolTimezone: "Europe/London" })).status, 400);
    const appointment = await created(); assert.equal(appointment.schoolTimezone, "UTC");
  });
  it("omits private notes from current teachers, limits reads to current classes and prevents cross-school access", async () => {
    const appointment = await created();
    const teacher = await get(legacy, appointment.id); assert.equal(teacher.status, 200); assert.equal("staffNotes" in teacher.body.appointment, false);
    assert.equal((await get(legacy, appointment.id, legacy.admin)).body.appointment.staffNotes, "Confidential manager note");
    assert.equal((await get(legacy, appointment.id, legacy.outsider)).status, 404);
    assert.equal((await get(other, appointment.id, other.admin)).status, 404);
    await f.sql("DELETE FROM teacher_grades WHERE teacher_id=$1", [legacy.teacher.id]);
    assert.equal((await get(legacy, appointment.id)).status, 404);
    assert.equal((await f.activate(legacy, appointment.id)).status, 404);
  });
  it("paginates and filters staff reminders without private notes; administrator records require an explicit range", async () => {
    await created(); await created(legacy, 1); await created(legacy, 2);
    const list = await f.call(legacy, legacy.teacher, "GET", "/passpilot/appointments?limit=2");
    assert.equal(list.status, 200); assert.equal(list.body.appointments.length, 2); assert.ok(list.body.nextCursor);
    assert.ok(list.body.appointments.every(row => !("staffNotes" in row)));
    const next = await f.call(legacy, legacy.teacher, "GET", `/passpilot/appointments?limit=2&cursor=${list.body.nextCursor}`);
    assert.equal(next.body.appointments.length, 1); assert.equal(next.body.nextCursor, null);
    assert.equal((await f.call(legacy, legacy.teacher, "GET", "/passpilot/appointments?limit=101")).status, 400);
    const records = `/passpilot/appointments/students/${legacy.students[0]}/records?from=2026-01-01T00:00:00Z&through=2027-07-01T00:00:00Z`;
    assert.equal((await f.call(legacy, legacy.teacher, "GET", records)).status, 403);
    assert.equal((await f.call(legacy, legacy.admin, "GET", records.split("?")[0]!)).status, 400);
    const admin = await f.call(legacy, legacy.admin, "GET", records); assert.equal(admin.status, 200);
    assert.equal(admin.body.appointments[0]!.staffNotes, "Confidential manager note");
    assert.equal(admin.headers.get("cache-control"), "no-store");
  });
  it("activates legacy and official classes through canonical issuers, without copying private notes", async () => {
    for (const t of [legacy, canonical]) {
      const appointment = await created(t);
      const activated = await f.activate(t, appointment.id); assert.equal(activated.status, 201, JSON.stringify(activated.body));
      assert.equal(activated.body.appointment.status, "activated"); assert.equal(activated.body.pass.notes, null);
      assert.equal("staffNotes" in activated.body.appointment, false);
      const timeline = await f.sql("SELECT summary,metadata FROM student_timeline_events WHERE school_id=$1 AND source_id=$2", [t.schoolId, activated.body.pass.id]);
      assert.equal(timeline.rowCount, 1); assert.equal(JSON.stringify(timeline.rows).includes("Confidential manager note"), false);
    }
  });
  it("concurrent activation issues exactly one pass and duplicate activation returns that pass after completion", async () => {
    const appointment = await created(canonical);
    const results = await Promise.all([f.activate(canonical, appointment.id), f.activate(canonical, appointment.id)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 201]); assert.equal(results[0]!.body.pass.id, results[1]!.body.pass.id);
    assert.equal(await count("passes", canonical.schoolId), 1);
    const audits = await f.sql("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='passpilot.appointment.activated'", [canonical.schoolId]);
    assert.equal(audits.rows[0].count, 1);
    const returned = await f.call(canonical, canonical.teacher, "PATCH", `/passpilot/passes/${results[0]!.body.pass.id}/return`, {});
    assert.equal(returned.status, 200);
    const duplicate = await f.activate(canonical, appointment.id); assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.pass.id, results[0]!.body.pass.id); assert.equal(duplicate.body.pass.status, "returned"); assert.equal(duplicate.body.appointment.status, "completed");
    assert.equal(await count("passes", canonical.schoolId), 1);
    await f.assignTeacher(canonical, canonical.outsider);
    assert.equal((await f.activate(canonical, appointment.id)).status, 404, "Completed-pass replay must recheck current student authority");
  });
  it("serializes cancellation/activation and rejects stale edits without issuing a second pass", async () => {
    const a = await created();
    const results = await Promise.all([f.activate(legacy, a.id), f.call(legacy, legacy.admin, "POST", `/passpilot/appointments/${a.id}/cancel`, { expectedRevision: 1 })]);
    assert.equal(results.filter(r => r.status === 409).length, 1);
    assert.equal(results.filter(r => r.status === 200 || r.status === 201).length, 1);
    assert.ok(await count("passes", legacy.schoolId) <= 1);
    const b = await created(legacy, 1);
    const edit = await f.call(legacy, legacy.admin, "PATCH", `/passpilot/appointments/${b.id}`, { expectedRevision: 1, destination: "office" }); assert.equal(edit.status, 200);
    assert.equal((await f.activate(legacy, b.id)).status, 409);
    assert.equal((await f.activate(legacy, b.id, { expectedRevision: 2 })).status, 201);
  });
  it("keeps the appointment pending on capacity/rule failures, including direct-issuance races", async () => {
    await f.sql("INSERT INTO passpilot_destination_policies(school_id,destination,max_concurrent) VALUES($1,'nurse',1)", [legacy.schoolId]);
    const a = await created(), b = await created(legacy, 1);
    const results = await Promise.all([f.activate(legacy, a.id), f.activate(legacy, b.id)]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    const denied = results.find(r => r.status === 409)!; assert.equal(denied.body.code, "PASSPILOT_RULE_DESTINATION_CAPACITY");
    const pendingId = results[0]!.status === 409 ? a.id : b.id; assert.equal((await get(legacy, pendingId)).body.appointment.status, "scheduled");
    await f.reset();
    await f.sql("INSERT INTO passpilot_destination_policies(school_id,destination,max_concurrent) VALUES($1,'nurse',1)", [legacy.schoolId]);
    const c = await created();
    const race = await Promise.all([f.activate(legacy, c.id), f.call(legacy, legacy.teacher, "POST", "/passpilot/passes", { studentId: legacy.students[1], gradeId: legacy.classId, destination: "nurse" })]);
    assert.deepEqual(race.map(r => r.status).sort(), [201, 409]); assert.equal(await count("passes", legacy.schoolId), 1);
  });
  it("rolls back pass, linkage and timeline together if the strict activation audit fails", async () => {
    const a = await created();
    const name = `appt_audit_fail_${randomUUID().replaceAll("-", "")}`;
    await f.sql(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.school_id='${legacy.schoolId}' AND NEW.action='passpilot.appointment.activated' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      assert.equal((await f.activate(legacy, a.id)).status, 500); assert.equal(await count("passes", legacy.schoolId), 0);
      assert.equal(await count("student_timeline_events", legacy.schoolId), 0); assert.equal((await get(legacy, a.id)).body.appointment.status, "scheduled");
    } finally { await f.sql(`DROP TRIGGER ${name} ON audit_logs; DROP FUNCTION ${name}()`); }
    assert.equal((await f.activate(legacy, a.id)).status, 201);
  });
  it("rechecks known local-day absence/dismissal, closures, school hours and timezone changes", async () => {
    const a = await created(); const date = new Date().toISOString().slice(0, 10);
    await f.sql("INSERT INTO student_attendance(school_id,student_id,date,status,marked_by) VALUES($1,$2,$3,'absent',$4)", [legacy.schoolId, legacy.students[0], date, legacy.admin.id]);
    assert.equal((await f.activate(legacy, a.id)).body.code, "APPOINTMENT_STUDENT_UNAVAILABLE");
    await f.sql("DELETE FROM student_attendance WHERE school_id=$1", [legacy.schoolId]);
    const session = randomUUID(); await f.sql("INSERT INTO dismissal_sessions(id,school_id,date) VALUES($1,$2,$3)", [session, legacy.schoolId, date]);
    await f.sql("INSERT INTO dismissal_queue(school_id,session_id,student_id,status) VALUES($1,$2,$3,'released')", [legacy.schoolId, session, legacy.students[0]]);
    assert.equal((await f.activate(legacy, a.id)).body.code, "APPOINTMENT_STUDENT_UNAVAILABLE");
    await f.sql("DELETE FROM dismissal_queue WHERE school_id=$1", [legacy.schoolId]);
    await f.schedule(legacy, { dateOverrides: { [date]: { instructional: false } } });
    assert.equal((await f.activate(legacy, a.id)).body.code, "APPOINTMENT_SCHOOL_CLOSED");
    await f.schedule(legacy);
    await f.sql("UPDATE settings SET enable_tracking_hours=true,tracking_start_time='00:00',tracking_end_time='00:01' WHERE school_id=$1", [legacy.schoolId]);
    assert.equal((await f.activate(legacy, a.id)).body.code, "APPOINTMENT_SCHOOL_CLOSED");
    await f.sql("UPDATE settings SET enable_tracking_hours=false WHERE school_id=$1", [legacy.schoolId]);
    await f.sql("UPDATE schools SET school_timezone='America/Los_Angeles' WHERE id=$1", [legacy.schoolId]);
    assert.equal((await f.activate(legacy, a.id)).body.code, "APPOINTMENT_TIME_ZONE_CHANGED");
    assert.equal(await count("passes", legacy.schoolId), 0);
  });
  it("rechecks revoked authority after lock wait before inserting a pass", async () => {
    const a = await created(); const locker = await f.pool.connect();
    try {
      await locker.query("BEGIN"); await locker.query("SELECT set_config('app.is_super','on',true)");
      await locker.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [legacy.schoolId]);
      const pending = f.activate(legacy, a.id);
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiters = await f.sql("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
        if (waiters.rows[0].count > 0) break;
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        if (attempt === 99) assert.fail("Activation never reached the locked school");
      }
      // Preserve the deployed staff-integrity contract while revoking access.
      await locker.query("DELETE FROM teacher_grades WHERE grade_id=$1 AND teacher_id=$2", [legacy.classId, legacy.teacher.id]);
      await locker.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [legacy.schoolId, legacy.teacher.id]);
      await locker.query("COMMIT");
      const result = await pending; assert.equal(result.status, 403); assert.equal(await count("passes", legacy.schoolId), 0);
    } finally { await locker.query("ROLLBACK"); locker.release(); }
  });
  it("does not auto-issue ended/future windows; explicit ended activation persists missed", async () => {
    const future = await created(legacy, 0, { startsAt: new Date(Date.now() + 600000).toISOString() });
    assert.equal((await f.activate(legacy, future.id)).body.code, "APPOINTMENT_TOO_EARLY");
    const ended = await created(legacy, 1);
    await f.sql("UPDATE passpilot_appointments SET starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE id=$1", [ended.id]);
    const miss = await f.activate(legacy, ended.id); assert.equal(miss.status, 409); assert.equal(miss.body.code, "APPOINTMENT_MISSED");
    assert.equal((await f.sql("SELECT status FROM passpilot_appointments WHERE id=$1", [ended.id])).rows[0].status, "missed");
    assert.equal(await count("passes", legacy.schoolId), 0);
  });
  it("keeps encounter overrides confidential and commits administrator override evidence atomically", async () => {
    const [first, second] = [legacy.students[0]!, legacy.students[1]!].sort();
    await f.sql("INSERT INTO passpilot_encounter_restrictions(school_id,student_a_id,student_b_id) VALUES($1,$2,$3)", [legacy.schoolId, first, second]);
    const peer = await f.call(legacy, legacy.teacher, "POST", "/passpilot/passes", { studentId: legacy.students[1], gradeId: legacy.classId, destination: "office" }); assert.equal(peer.status, 201);
    const a = await created(); const teacher = await f.activate(legacy, a.id);
    assert.equal(teacher.status, 409); assert.equal(teacher.body.code, "PASSPILOT_RULE_NOT_AVAILABLE");
    assert.equal(JSON.stringify(teacher.body).includes("PASSPILOT_RULE_ENCOUNTER"), false);
    assert.equal((await f.activate(legacy, a.id, { overrideRuleCode: "PASSPILOT_RULE_ENCOUNTER" }, legacy.office)).status, 403);
    const admin = await f.activate(legacy, a.id, { overrideRuleCode: "PASSPILOT_RULE_ENCOUNTER" }, legacy.admin); assert.equal(admin.status, 201);
    assert.equal(admin.body.pass.ruleOverrideCode, "PASSPILOT_RULE_ENCOUNTER");
    assert.equal((await f.sql("SELECT count(*)::int AS count FROM passpilot_pass_denials WHERE school_id=$1 AND overridden", [legacy.schoolId])).rows[0].count, 1);
    const replay = await f.activate(legacy, a.id); assert.equal(replay.status, 200); assert.equal("ruleOverrideCode" in replay.body.pass, false);
    process.env.PASSPILOT_RULES_MODE = "off";
    assert.equal("ruleOverrideCode" in (await f.activate(legacy, a.id)).body.pass, false);
  });
  it("scrubs notes independently, leaves overdue passes open, and completes explicit returns when feature is off", async () => {
    const a = await created(); const active = await f.activate(legacy, a.id); assert.equal(active.status, 201);
    await f.sql("UPDATE passes SET expires_at=now()-interval '1 hour' WHERE id=$1", [active.body.pass.id]);
    await f.sql("UPDATE passpilot_appointments SET starts_at=now()-interval '4 hours',ends_at=now()-interval '3 hours',retained_until=now()-interval '2 hours' WHERE id=$1", [a.id]);
    const { maintainPasspilotAppointments } = await import("../src/services/passpilotAppointmentsLifecycle.js");
    process.env.PASSPILOT_APPOINTMENTS_MODE = "off";
    const maintenance = await maintainPasspilotAppointments(f.system); assert.equal(maintenance.scrubbed, 1); assert.equal(maintenance.deleted, 0);
    const stored = (await f.sql("SELECT status,staff_notes,revision FROM passpilot_appointments WHERE id=$1", [a.id])).rows[0];
    assert.equal(stored.status, "activated"); assert.equal(stored.staff_notes, null); assert.equal(stored.revision, 2);
    assert.equal((await f.sql("SELECT status FROM passes WHERE id=$1", [active.body.pass.id])).rows[0].status, "active");
    const returned = await f.call(legacy, legacy.teacher, "PATCH", `/passpilot/passes/${active.body.pass.id}/return`, {}); assert.equal(returned.status, 200);
    assert.equal((await f.sql("SELECT status FROM passpilot_appointments WHERE id=$1", [a.id])).rows[0].status, "completed");
    assert.equal((await maintainPasspilotAppointments(f.system)).deleted, 1);
  });
});
