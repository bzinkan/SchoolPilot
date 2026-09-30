import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { emptySchoolSchedulingConfig } from "../../src/services/classpilotSchedulingRules.js";

export async function appointmentFixture() {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Only a local synthetic database is permitted");
  const system = new Client({ connectionString: process.env.DATABASE_URL });
  await system.connect(); await system.query("SELECT set_config('app.is_super','on',false)");
  const { pool, sessionPool } = await import("../../src/db.js");
  const { signUserToken } = await import("../../src/services/jwt.js");
  const { runWithTenantContext } = await import("../../src/middleware/tenantContext.js");
  const db = (await import("../../src/db.js")).default;
  const server = createServer((await import("../../src/app.js")).createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const tag = `appt_${Date.now()}`;
  type Person = { id: string; email: string };
  type Tenant = { schoolId: string; classId: string; admin: Person; teacher: Person; office: Person; outsider: Person; parent: Person; students: string[]; canonical: boolean };
  const tenants: Tenant[] = [];
  const userIds: string[] = [];
  const sql = (text: string, values: unknown[] = []) => system.query(text, values);
  async function createTenant(canonical = false) {
    const schoolId = randomUUID(), classId = randomUUID();
    await sql("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,$2,'active',true,'active','UTC')", [schoolId, tag]);
    await sql("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'PASSPILOT','active')", [schoolId]);
    await sql("INSERT INTO settings(school_id,school_name,ws_shared_key,passpilot_class_source,enable_tracking_hours,instructional_calendar,school_timezone) VALUES($1,$2,'fixture',$3,false,'{}','UTC')", [schoolId, tag, canonical ? "classpilot_groups" : "legacy_grades"]);
    async function person(role: string, label: string) {
      const id = randomUUID(), email = `${tag}-${id}@example.test`; userIds.push(id);
      await sql("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,$3,'Fixture')", [id, email, label]);
      await sql("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, id, role]);
      return { id, email };
    }
    const admin = await person("school_admin", "Admin"), teacher = await person("teacher", "Teacher"), office = await person("office_staff", "Office");
    const outsider = await person("teacher", "OtherTeacher"), parent = await person("parent", "GoPilotOffice");
    await sql("UPDATE school_memberships SET gopilot_role='office_staff' WHERE user_id=$1", [parent.id]);
    if (canonical) {
      await sql("BEGIN");
      try {
        await sql("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Appointment Class','admin_class','active')", [classId, schoolId, teacher.id]);
        await sql("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [classId, teacher.id]);
        await sql("COMMIT");
      } catch (error) { await sql("ROLLBACK"); throw error; }
    }
    else {
      await sql("INSERT INTO grades(id,school_id,name) VALUES($1,$2,'Appointment Class')", [classId, schoolId]);
      await sql("INSERT INTO teacher_grades(teacher_id,grade_id) VALUES($1,$2)", [teacher.id, classId]);
    }
    const students: string[] = [];
    for (let i = 0; i < 16; i++) {
      const id = randomUUID(); students.push(id);
      await sql("INSERT INTO students(id,school_id,first_name,last_name,status,grade_id) VALUES($1,$2,$3,'Fixture','active',$4)", [id, schoolId, `Student${i}`, canonical ? null : classId]);
      if (canonical) await sql("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [classId, id]);
      else await sql("INSERT INTO passpilot_grade_students(school_id,grade_id,student_id) VALUES($1,$2,$3)", [schoolId, classId, id]);
    }
    const tenant = { schoolId, classId, admin, teacher, office, outsider, parent, students, canonical }; tenants.push(tenant);
    await schedule(tenant);
    return tenant;
  }
  async function schedule(tenant: Tenant, patch: Record<string, unknown> = {}) {
    const year = new Date().getUTCFullYear();
    const config = { ...emptySchoolSchedulingConfig(), yearStart: `${year}-01-01`, yearEnd: `${year + 1}-06-30`,
      dateOverrides: { [new Date().toISOString().slice(0, 10)]: { instructional: true } }, ...patch };
    await sql("INSERT INTO classpilot_school_schedules(school_id,revision,config) VALUES($1,1,$2) ON CONFLICT(school_id) DO UPDATE SET config=excluded.config", [tenant.schoolId, config]);
  }
  function headers(tenant: Tenant, person: Person) {
    return { authorization: `Bearer ${signUserToken({ userId: person.id, email: person.email, isSuperAdmin: false })}`,
      "x-school-id": tenant.schoolId, "x-passpilot-class-model": "classpilot-groups-v1" };
  }
  type Body = { error?: string; code?: string; replayed?: boolean; appointment: { id: string; studentId: string; revision: number; status: string; staffNotes?: string | null; schoolTimezone: string; startsAt: string; endsAt: string; retainedUntil: string; passId: string | null };
    appointments: Body["appointment"][]; nextCursor: string | null; pass: { id: string; notes: string | null; status: string; ruleOverrideCode?: string } };
  async function call(tenant: Tenant, person: Person, method: string, path: string, body?: unknown) {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", ...headers(tenant, person) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Body, headers: response.headers };
  }
  function payload(tenant: Tenant, index = 0, patch: Record<string, unknown> = {}) {
    const now = Date.now();
    return { requestId: randomUUID(), studentId: tenant.students[index]!, destination: "nurse", staffNotes: "Confidential manager note",
      startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 3600000).toISOString(), ...patch };
  }
  const create = (tenant: Tenant, index = 0, patch: Record<string, unknown> = {}, person = tenant.admin) => call(tenant, person, "POST", "/passpilot/appointments", payload(tenant, index, patch));
  const activate = (tenant: Tenant, id: string, patch: Record<string, unknown> = {}, person = tenant.teacher) => call(tenant, person, "POST", `/passpilot/appointments/${id}/activate`, { expectedRevision: 1, classId: tenant.classId, ...patch });
  async function assignTeacher(tenant: Tenant, person: Person) {
    assert.ok(tenant.canonical);
    await sql("BEGIN");
    try {
      await sql("UPDATE groups SET teacher_id=$2,status='active' WHERE school_id=$3 AND id=$1", [tenant.classId, person.id, tenant.schoolId]);
      await sql("DELETE FROM group_teachers WHERE group_id=$1 AND role='primary' AND teacher_id<>$2", [tenant.classId, person.id]);
      await sql("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary') ON CONFLICT(group_id,teacher_id) DO UPDATE SET role='primary'", [tenant.classId, person.id]);
      await sql("COMMIT");
    } catch (error) { await sql("ROLLBACK"); throw error; }
  }
  async function reset() {
    const ids = tenants.map(t => t.schoolId);
    for (const table of ["passpilot_appointments", "passpilot_pass_denials", "passpilot_encounter_restrictions", "passpilot_pass_limits", "passpilot_destination_policies", "student_timeline_events", "passes", "student_attendance", "dismissal_queue", "dismissal_sessions", "audit_logs"]) await sql(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [ids]);
    await sql("UPDATE school_memberships SET status='active' WHERE school_id=ANY($1::text[])", [ids]);
    await sql("UPDATE schools SET status='active',is_active=true,school_timezone='UTC' WHERE id=ANY($1::text[])", [ids]);
    await sql("UPDATE product_licenses SET status='active' WHERE school_id=ANY($1::text[])", [ids]);
    await sql("UPDATE settings SET enable_tracking_hours=false,instructional_calendar='{}',school_timezone='UTC' WHERE school_id=ANY($1::text[])", [ids]);
    for (const t of tenants) {
      await schedule(t);
      if (t.canonical) await assignTeacher(t, t.teacher);
      else await sql("INSERT INTO teacher_grades(teacher_id,grade_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [t.teacher.id, t.classId]);
    }
    process.env.PASSPILOT_APPOINTMENTS_MODE = "on";
    process.env.PASSPILOT_RULES_MODE = "on";
  }
  async function close() {
    await reset();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const { schedulerPool, schedulerLockPool } = await import("../../src/services/schedulerDb.js");
    await Promise.allSettled([system.end(), pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
  return { sql, system, pool, db, runWithTenantContext, createTenant, schedule, assignTeacher, headers, call, payload, create, activate, reset, close, tenants, url };
}
export type AppointmentFixture = Awaited<ReturnType<typeof appointmentFixture>>;
export type AppointmentTenant = Awaited<ReturnType<AppointmentFixture["createTenant"]>>;
