import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";

const ENABLED = process.env.RLS_GUC_ENABLED === "true";
const TABLES = [
  "student_safety_cases", "student_safety_alerts", "student_safety_case_events", "safety_url_exceptions", "safety_notification_outbox",
  "classpilot_school_schedules", "classpilot_supervision_contexts", "roster_integration_connections", "roster_integration_runs", "roster_integration_identities", "roster_integration_memberships",
  "classpilot_school_website_policies", "classpilot_school_website_deliveries", "classpilot_monitoring_expectations", "classpilot_monitoring_interruptions",
  "classpilot_monitoring_interruption_settings", "classpilot_monitoring_interruption_digests",
] as const;
const tag = `roadmap_rls_${randomUUID().replaceAll("-", "")}`;
const id = (school: "a" | "b", entity: string) => `${tag}_${school}_${entity}`;
const schoolIds = [id("a", "school"), id("b", "school")];
const adminPool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL, max: 1 });
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let admin: pg.PoolClient | undefined;
let app: pg.PoolClient | undefined;

async function tenant(schoolId = "") {
  assert.ok(app);
  await app.query("SELECT set_config('app.school_id',$1,false),set_config('app.is_super','',false)", [schoolId]);
}

before(async () => {
  if (!ENABLED) return;
  admin = await adminPool.connect(); app = await appPool.connect();
  await admin.query("SELECT set_config('app.is_super','on',false)");
  await admin.query("BEGIN");
  try {
    for (const side of ["a", "b"] as const) {
      const school = id(side, "school"), user = id(side, "user"), student = id(side, "student"), device = id(side, "device"), session = id(side, "session"), group = id(side, "group"), teaching = id(side, "teaching");
      await admin.query("INSERT INTO schools(id,name,domain,slug) VALUES($1,'Roadmap RLS',$2,$3)", [school, `${tag}-${side}.example.edu`, `${tag}-${side}`]);
      await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'RLS','Staff')", [user, `staff@${tag}-${side}.example.edu`]);
      await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [school, user]);
      await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'RLS','Student','active')", [student, school]);
      await admin.query("INSERT INTO devices(device_id,school_id,class_id) VALUES($1,$2,$2)", [device, school]);
      await admin.query("INSERT INTO student_sessions(id,student_id,device_id,auth_kind) VALUES($1,$2,$3,'managed_profile')", [session, student, device]);
      await admin.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'RLS class','teacher_created','active')", [group, school, user]);
      await admin.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [group, user]);
      await admin.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id) VALUES($1,$2,$3,$4)", [teaching, school, group, user]);
      await admin.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) VALUES($1,$2,$3,$4,now())", [school, teaching, group, student]);
      await admin.query("INSERT INTO student_safety_cases(id,school_id,student_id,title) VALUES($1,$2,$3,'RLS case')", [id(side, "case"), school, student]);
      await admin.query("INSERT INTO student_safety_alerts(id,school_id,student_id,case_id,fingerprint,source_type,source_id,concern,severity,first_seen_at,last_seen_at) VALUES($1::text,$2,$3,$4,$1::text,'browser',$1::text,'weapons','medium',now(),now())", [id(side, "alert"), school, student, id(side, "case")]);
      await admin.query("INSERT INTO student_safety_case_events(id,school_id,case_id,alert_id,kind) VALUES($1,$2,$3,$4,'observed')", [id(side, "event"), school, id(side, "case"), id(side, "alert")]);
      await admin.query("INSERT INTO safety_url_exceptions(id,school_id,fingerprint,url_ciphertext,created_by,created_from_alert_id) VALUES($1::text,$2,$1::text,'encrypted-test-only',$3,$4)", [id(side, "exception"), school, user, id(side, "alert")]);
      await admin.query("INSERT INTO safety_notification_outbox(id,school_id,case_id,alert_id,recipient,kind,alert_revision,due_at) VALUES($1,$2,$3,$4,$5,'initial',0,now())", [id(side, "outbox"), school, id(side, "case"), id(side, "alert"), `admin@${tag}-${side}.example.edu`]);
      await admin.query("INSERT INTO classpilot_school_schedules(school_id,config) VALUES($1,'{}'::jsonb)", [school]);
      await admin.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,ends_at,schedule_profile_application_id,schedule_profile_block_id,schedule_profile_date) VALUES($1,$2,'supervision_group','RLS testing',$3,$3,now()+interval '1 hour','shared-application','shared-block','2026-09-06')", [id(side, "profile_context"), school, user]);
      await admin.query("INSERT INTO roster_integration_connections(id,school_id,provider,name,provider_identity,created_by) VALUES($1::text,$2,'oneroster','RLS roster',$1::text,$3)", [id(side, "connection"), school, user]);
      await admin.query("INSERT INTO roster_integration_runs(id,school_id,connection_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [id(side, "run"), school, id(side, "connection")]);
      await admin.query("INSERT INTO roster_integration_identities(id,school_id,connection_id,entity_type,external_id,internal_id,last_run_id) VALUES($1::text,$2,$3,'student',$1::text,$4,$5)", [id(side, "identity"), school, id(side, "connection"), student, id(side, "run")]);
      await admin.query("INSERT INTO roster_integration_memberships(id,school_id,connection_id,group_id,member_id,member_type,role,last_run_id) VALUES($1,$2,$3,$4,$5,'student','student',$6)", [id(side, "membership"), school, id(side, "connection"), group, student, id(side, "run")]);
      await admin.query("INSERT INTO classpilot_school_website_policies(school_id) VALUES($1)", [school]);
      await admin.query("INSERT INTO classpilot_school_website_deliveries(id,school_id,policy_revision,student_id,student_session_id,device_id) VALUES($1,$2,0,$3,$4,$5)", [id(side, "delivery"), school, student, session, device]);
      await admin.query("INSERT INTO classpilot_monitoring_expectations(id,school_id,student_id,student_session_id,device_id,scope_type,scope_id,scope_name,scope_started_at,last_observed_at,last_checked_at,retention_expires_at) VALUES($1,$2,$3,$4,$5,'teaching_session',$6,'RLS class',now(),now(),now(),now()+interval '1 day')", [id(side, "expectation"), school, student, session, device, teaching]);
      await admin.query("INSERT INTO classpilot_monitoring_interruptions(id,expectation_id,school_id,student_id,student_session_id,device_id,scope_type,scope_id,scope_name,last_observed_at,detected_at,retention_expires_at) VALUES($1,$2,$3,$4,$5,$6,'teaching_session',$7,'RLS class',now(),now(),now()+interval '1 day')", [id(side, "interruption"), id(side, "expectation"), school, student, session, device, teaching]);
      await admin.query("INSERT INTO classpilot_monitoring_interruption_settings(school_id) VALUES($1)", [school]);
      await admin.query("INSERT INTO classpilot_monitoring_interruption_digests(id,school_id,local_date,recipient_user_id,due_at,retention_expires_at) VALUES($1,$2,'2026-09-05',$3,now(),now()+interval '1 day')", [id(side, "digest"), school, user]);
    }
    await admin.query("COMMIT");
  } catch (error) { await admin.query("ROLLBACK"); throw error; }
});

after(async () => {
  try {
  if (admin) {
    await admin.query("BEGIN");
    for (const table of [...TABLES].reverse().filter(table => table !== "student_safety_cases" && table !== "student_safety_alerts" && table !== "student_safety_case_events")) await admin.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    for (const table of ["student_safety_case_events", "student_safety_alerts", "student_safety_cases", "classpilot_session_students", "teaching_sessions"]) await admin.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    await admin.query("DELETE FROM group_teachers WHERE group_id=ANY($1::text[])", [[id("a", "group"), id("b", "group")]]);
    await admin.query("DELETE FROM groups WHERE school_id=ANY($1::text[])", [schoolIds]);
    await admin.query("DELETE FROM student_sessions WHERE student_id=ANY($1::text[])", [[id("a", "student"), id("b", "student")]]);
    for (const table of ["devices", "students", "school_memberships"]) await admin.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    // Staff history is deliberately retained by the canonical lifecycle guards.
    await admin.query("UPDATE schools SET status='suspended',is_active=false,deleted_at=now() WHERE id=ANY($1::text[])", [schoolIds]);
    await admin.query("COMMIT");
  }
  } catch (error) { await admin?.query("ROLLBACK"); throw error; }
  finally {
  app?.release(); admin?.release();
  await Promise.all([appPool.end(), adminPool.end()]);
  }
});

describe("ClassPilot roadmap forced tenant isolation", { skip: !ENABLED }, () => {
  it("uses a non-superuser, non-bypass role and actual forced policies on every new tenant table", async () => {
    assert.ok(app);
    const role = (await app.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    const policies = await app.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,p.polqual IS NOT NULL AS has_using,p.polwithcheck IS NOT NULL AS has_check FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_policy p ON p.polrelid=c.oid AND p.polname='tenant_isolation' WHERE n.nspname='public' AND c.relname=ANY($1::text[])", [TABLES]);
    assert.equal(policies.rowCount, TABLES.length);
    for (const row of policies.rows) assert.ok(row.relrowsecurity && row.relforcerowsecurity && row.has_using && row.has_check, `${row.relname} must enforce reads and writes`);
  });

  it("reveals no feature rows before a tenant context exists", async () => {
    await tenant(); assert.ok(app);
    for (const table of TABLES) assert.deepEqual((await app.query(`SELECT school_id FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds])).rows, [], table);
  });

  it("reads and updates the current school's rows while hiding other-school updates and deletes", async () => {
    await tenant(schoolIds[0]); assert.ok(app);
    for (const table of TABLES) {
      assert.deepEqual((await app.query(`SELECT school_id FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds])).rows, [{ school_id: schoolIds[0] }], table);
      assert.equal((await app.query(`UPDATE ${table} SET school_id=school_id WHERE school_id=$1`, [schoolIds[0]])).rowCount, 1, `${table}: own update`);
      assert.equal((await app.query(`UPDATE ${table} SET school_id=school_id WHERE school_id=$1`, [schoolIds[1]])).rowCount, 0, `${table}: foreign update`);
      assert.equal((await app.query(`DELETE FROM ${table} WHERE school_id=$1`, [schoolIds[1]])).rowCount, 0, `${table}: foreign delete`);
    }
  });

  it("WITH CHECK rejects foreign-tenant configuration creation and reassignment", async () => {
    await tenant(schoolIds[0]); assert.ok(app);
    const client = app;
    for (const [table, columns, values] of [
      ["classpilot_school_schedules", "school_id,config", "$1,'{}'::jsonb"],
      ["classpilot_school_website_policies", "school_id", "$1"],
      ["classpilot_monitoring_interruption_settings", "school_id", "$1"],
    ]) {
      await assert.rejects(client.query(`INSERT INTO ${table}(${columns}) VALUES(${values})`, [schoolIds[1]]), { code: "42501" }, `${table}: foreign insert`);
      await assert.rejects(client.query(`UPDATE ${table} SET school_id=$1 WHERE school_id=$2`, [schoolIds[1], schoolIds[0]]), { code: "42501" }, `${table}: reassignment`);
    }
  });

  it("rejects mixed-school parent tuples even through the privileged fixture connection", async () => {
    assert.ok(admin);
    await assert.rejects(admin.query("UPDATE student_safety_alerts SET case_id=$1 WHERE id=$2", [id("b", "case"), id("a", "alert")]), { code: "23503" });
    await assert.rejects(admin.query("UPDATE roster_integration_identities SET internal_id=$1 WHERE id=$2", [id("b", "student"), id("a", "identity")]), { code: "23514" });
    await assert.rejects(admin.query("UPDATE classpilot_school_website_deliveries SET student_session_id=$1 WHERE id=$2", [id("b", "session"), id("a", "delivery")]), { code: "23514" });
    await assert.rejects(admin.query("UPDATE classpilot_monitoring_expectations SET student_session_id=$1 WHERE id=$2", [id("b", "session"), id("a", "expectation")]), { code: "23514" });
    await assert.rejects(admin.query("UPDATE classpilot_monitoring_interruptions SET scope_id=$1 WHERE id=$2", [id("b", "teaching"), id("a", "interruption")]), { code: "23514" });
  });

  it("isolates scheduled testing identities and activation receipts without changing the schedule revision", async () => {
    await tenant(schoolIds[0]); assert.ok(app);
    const client = app;
    const outcome = { applicationId: "shared-application", blockId: "shared-block", date: "2026-09-06", status: "started", code: "WINDOW_STARTED", contextId: id("a", "profile_context"), updatedAt: new Date().toISOString() };
    assert.equal((await client.query("UPDATE classpilot_school_schedules SET profile_activation_outcomes=$1::jsonb WHERE school_id=$2", [JSON.stringify({ receipt: outcome }), schoolIds[0]])).rowCount, 1);
    assert.equal((await client.query("UPDATE classpilot_school_schedules SET profile_activation_outcomes=$1::jsonb WHERE school_id=$2", [JSON.stringify({ receipt: outcome }), schoolIds[1]])).rowCount, 0);
    assert.deepEqual((await client.query("SELECT revision,profile_activation_outcomes FROM classpilot_school_schedules WHERE school_id=ANY($1::text[])", [schoolIds])).rows, [{ revision: 0, profile_activation_outcomes: { receipt: outcome } }]);
    assert.deepEqual((await client.query("SELECT id FROM classpilot_supervision_contexts WHERE schedule_profile_application_id='shared-application' AND schedule_profile_block_id='shared-block'", [])).rows, [{ id: id("a", "profile_context") }]);
    await assert.rejects(client.query("INSERT INTO classpilot_supervision_contexts(school_id,context_type,name,assigned_staff_id,created_by,ends_at,schedule_profile_application_id,schedule_profile_block_id,schedule_profile_date) VALUES($1,'supervision_group','Foreign testing',$2,$2,now()+interval '1 hour','another-application','shared-block','2026-09-06')", [schoolIds[1], id("b", "user")]), { code: "42501" });
  });
});
