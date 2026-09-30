import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { isDatabaseErrorCode } from "../src/util/databaseError.js";
import { passpilotAppointments } from "../src/schema/passpilotAppointments.js";
import { appointmentFixture, type AppointmentFixture, type AppointmentTenant } from "./helpers/passpilotAppointmentFixture.js";

// RLS_SERIAL: real restricted role, full current admission, separate fixture DB.
const enabled = process.env.RLS_GUC_ENABLED === "true";
process.env.NODE_ENV = "test"; process.env.REDIS_URL = "";
process.env.PASSPILOT_APPOINTMENTS_MODE = "on";
let f: AppointmentFixture; let a: AppointmentTenant; let b: AppointmentTenant;
before(async () => { if (enabled) { f = await appointmentFixture(); a = await f.createTenant(); b = await f.createTenant(true); } });
after(async () => { if (enabled) await f.close(); });
describe("appointments under forced tenant RLS", { skip: enabled ? false : "requires restricted RLS lane" }, () => {
  it("uses a non-owner role without bypass and mirrors every schema column", async () => {
    const role = await f.sql("SELECT rolsuper,rolbypassrls,(SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tableowner=current_user) AS owns FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, owns: 0 });
    const table = await f.sql("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='passpilot_appointments'");
    assert.deepEqual(table.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    assert.ok(process.env.RLS_ENABLED_TABLES?.split(",").includes("passpilot_appointments"));
    const columns = await f.sql("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='passpilot_appointments'");
    assert.deepEqual(columns.rows.map(row => row.column_name).sort(), Object.values(getTableColumns(passpilotAppointments)).map(column => column.name).sort());
  });
  it("allows same-school staff writes, denies unscoped reads and omits foreign rows", async () => {
    assert.equal((await f.create(a)).status, 201);
    assert.equal((await f.create(b)).status, 201);
    const unscoped = await f.pool.query("SELECT count(*)::int AS count FROM passpilot_appointments WHERE school_id=ANY($1::text[])", [[a.schoolId, b.schoolId]]);
    assert.equal(unscoped.rows[0].count, 0);
    const rows = await f.runWithTenantContext({ schoolId: a.schoolId }, () => f.db.select().from(passpilotAppointments));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.schoolId, a.schoolId);
    assert.equal((await f.call(a, a.admin, "GET", `/passpilot/appointments/${(await f.sql("SELECT id FROM passpilot_appointments WHERE school_id=$1", [b.schoolId])).rows[0].id}`)).status, 404);
  });
  it("enforces WITH CHECK and same-school/same-student parent linkage", async () => {
    const foreignInsert = sql`INSERT INTO passpilot_appointments(school_id,student_id,create_request_id,create_fingerprint,destination,starts_at,ends_at,school_timezone,retained_until)
      VALUES(${b.schoolId},${b.students[1]},gen_random_uuid(),repeat('0',64),'nurse',now(),now()+interval '1 hour','UTC',now()+interval '1 day')`;
    await assert.rejects(f.runWithTenantContext({ schoolId: a.schoolId }, () => f.db.execute(foreignInsert)),
      error => /row-level security/.test(String((error as Error).cause ?? error)));
    const wrongStudent = sql`INSERT INTO passpilot_appointments(school_id,student_id,create_request_id,create_fingerprint,destination,starts_at,ends_at,school_timezone,retained_until)
      VALUES(${a.schoolId},${b.students[1]},gen_random_uuid(),repeat('0',64),'nurse',now(),now()+interval '1 hour','UTC',now()+interval '1 day')`;
    await assert.rejects(f.runWithTenantContext({ schoolId: a.schoolId }, () => f.db.execute(wrongStudent)), error => isDatabaseErrorCode(error, "23503"));
    const appointment = (await f.create(a, 1)).body.appointment;
    const firstId = (await f.sql("SELECT id FROM passpilot_appointments WHERE school_id=$1 AND student_id=$2", [a.schoolId, a.students[0]])).rows[0].id;
    const pass = await f.activate(a, firstId); assert.equal(pass.status, 201, JSON.stringify(pass.body));
    await assert.rejects(f.runWithTenantContext({ schoolId: a.schoolId }, () => f.db.execute(sql`UPDATE passpilot_appointments SET pass_id=${pass.body.pass.id} WHERE id=${appointment.id}`)), error => isDatabaseErrorCode(error, "23503") || isDatabaseErrorCode(error, "23505"));
    const updated = await f.runWithTenantContext({ schoolId: a.schoolId }, () => f.db.execute(sql`UPDATE passpilot_appointments SET revision=revision+1 WHERE school_id=${b.schoolId}`));
    assert.equal(updated.rowCount, 0);
  });
  it("scopes current teacher reminders and activation under the restricted request role", async () => {
    const list = await f.call(b, b.teacher, "GET", "/passpilot/appointments"); assert.equal(list.status, 200);
    assert.equal(list.body.appointments.length, 1); assert.equal("staffNotes" in list.body.appointments[0]!, false);
    const id = list.body.appointments[0]!.id;
    assert.equal((await f.activate(b, id, {}, b.outsider)).status, 404);
    await f.sql("UPDATE groups SET teacher_id=$2 WHERE id=$1", [b.classId, b.outsider.id]);
    assert.equal((await f.activate(b, id)).status, 404);
    assert.equal((await f.activate(b, id, {}, b.outsider)).status, 201);
  });
  it("keeps the invoker completion trigger working with scheduling off without touching overdue passes", async () => {
    const row = (await f.sql("SELECT id,pass_id FROM passpilot_appointments WHERE school_id=$1 AND pass_id IS NOT NULL", [a.schoolId])).rows[0];
    await f.sql("UPDATE passes SET expires_at=now()-interval '1 hour' WHERE id=$1", [row.pass_id]);
    assert.equal((await f.sql("SELECT status FROM passpilot_appointments WHERE id=$1", [row.id])).rows[0].status, "activated");
    process.env.PASSPILOT_APPOINTMENTS_MODE = "off";
    const returned = await f.call(a, a.teacher, "PATCH", `/passpilot/passes/${row.pass_id}/return`, {}); assert.equal(returned.status, 200);
    assert.equal((await f.sql("SELECT status FROM passpilot_appointments WHERE id=$1", [row.id])).rows[0].status, "completed");
    const func = await f.sql("SELECT prosecdef FROM pg_proc WHERE proname='complete_passpilot_appointment_from_pass'");
    assert.equal(func.rows[0].prosecdef, false);
  });
});
