import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { getTableColumns } from "drizzle-orm";
import pg from "pg";
import { classpilotTeacherPreferences } from "../src/schema/classpilotTeacherPreferences.js";
import { CLASSPILOT_TEACHER_PREFERENCES_SCHEMA_SQL, CLASSPILOT_TEACHER_PREFERENCES_SQL, classpilotTeacherPreferencesMigration } from "../src/db/classpilotTeacherPreferencesMigration.js";
import { runSchoolPilotMigrationLedger } from "../src/db/migrationLedger.js";
import { schoolPilot27ExpandMigrations } from "../src/db/migrations27.js";

const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
const schema = `prefs_${suffix}`, role = `prefs_rls_${suffix}`;
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, options: `-c search_path=${schema} -c app.is_super=off` });
const schools = { a: randomUUID(), b: randomUUID(), future: randomUUID(), suspended: randomUUID(), expired: randomUUID(), noLicense: randomUUID(), deleted: randomUUID(), canceled: randomUUID(), inactive: randomUUID(), disabled: randomUUID(), nonActiveStatus: randomUUID() };
const authors = { valid: randomUUID(), invalid: randomUUID(), empty: randomUUID(), missing: randomUUID(), inactive: randomUUID(), parent: randomUUID(), huge: randomUUID() };

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Only local fixture databases are allowed");
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
    CREATE TABLE schools(id VARCHAR PRIMARY KEY,status TEXT DEFAULT 'active',is_active BOOLEAN DEFAULT true,disabled_at TIMESTAMP,plan_status TEXT DEFAULT 'active',deleted_at TIMESTAMP,active_until TIMESTAMP);
    CREATE TABLE users(id VARCHAR PRIMARY KEY);
    CREATE TABLE school_memberships(school_id TEXT,user_id TEXT,role TEXT,status TEXT DEFAULT 'active');
    CREATE TABLE product_licenses(school_id TEXT,product TEXT DEFAULT 'CLASSPILOT',status TEXT DEFAULT 'active',expires_at TIMESTAMP);
    CREATE TABLE teacher_settings(teacher_id TEXT UNIQUE,max_tabs_per_student TEXT,default_flight_path_id TEXT,allowed_domains TEXT[]);`);
  for (const id of Object.values(schools)) await admin.query("INSERT INTO schools(id) VALUES($1)", [id]);
  for (const id of Object.values(authors)) await admin.query("INSERT INTO users(id) VALUES($1)", [id]);
  await admin.query("UPDATE schools SET status='suspended' WHERE id=$1", [schools.suspended]);
  await admin.query("UPDATE schools SET deleted_at=now() WHERE id=$1", [schools.deleted]);
  await admin.query("UPDATE schools SET plan_status='canceled' WHERE id=$1", [schools.canceled]);
  await admin.query("UPDATE schools SET is_active=false WHERE id=$1", [schools.inactive]);
  await admin.query("UPDATE schools SET disabled_at=now() WHERE id=$1", [schools.disabled]);
  await admin.query("UPDATE schools SET status='inactive' WHERE id=$1", [schools.nonActiveStatus]);
  for (const id of Object.values(schools).filter(id => id !== schools.noLicense)) {
    await admin.query("INSERT INTO product_licenses(school_id,expires_at) VALUES($1,$2)", [id, id === schools.expired ? "2020-01-01" : null]);
  }
  for (const id of Object.values(schools).filter(id => id !== schools.future)) {
    await admin.query("INSERT INTO school_memberships(school_id,user_id,role) VALUES($1,$2,'teacher'),($1,$2,'school_admin')", [id, authors.valid]);
  }
  for (const [kind, id] of Object.entries(authors).filter(([kind]) => kind !== "valid")) {
    await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,$4)", [schools.a, id, kind === "parent" ? "parent" : "teacher", kind === "inactive" ? "inactive" : "active"]);
  }
  for (const [id, value] of [[authors.valid, " 7 "], [authors.invalid, "0"], [authors.empty, ""], [authors.inactive, "8"], [authors.parent, "9"], [authors.huge, "999999999999999999999999"]]) {
    await admin.query("INSERT INTO teacher_settings VALUES($1,$2,'keep-legacy-flight-path',ARRAY['keep.invalid'])", [id, value]);
  }
});
after(async () => {
  await pool.end();
  await admin.query("RESET ROLE");
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP ROLE IF EXISTS ${role}`);
  await admin.end();
});

test("ledger copies valid preferences once into eligible memberships and leaves future memberships inheriting", async () => {
  const result = await runSchoolPilotMigrationLedger({ pool, migrations: [classpilotTeacherPreferencesMigration], applicationSha: "fixture" });
  assert.equal(result[0]?.status, "applied");
  const rows = (await admin.query("SELECT school_id,teacher_id,max_tabs_per_student FROM classpilot_teacher_preferences")).rows;
  assert.equal(rows.length, 6, "Two eligible memberships plus four inherited defaults; duplicate roles are deduplicated");
  for (const school of [schools.a, schools.b]) assert.equal(rows.find(row => row.school_id === school && row.teacher_id === authors.valid)?.max_tabs_per_student, 7);
  for (const teacher of [authors.invalid, authors.empty, authors.missing, authors.huge]) assert.equal(rows.find(row => row.teacher_id === teacher)?.max_tabs_per_student, null);
  assert.ok(rows.every(row => [schools.a, schools.b].includes(row.school_id)));
  assert.equal((await pool.query("SELECT current_setting('app.is_super',true) AS scope")).rows[0].scope, "off");
  await admin.query("UPDATE classpilot_teacher_preferences SET max_tabs_per_student=12 WHERE school_id=$1 AND teacher_id=$2", [schools.a, authors.valid]);
  await admin.query("INSERT INTO school_memberships(school_id,user_id,role) VALUES($1,$2,'teacher')", [schools.future, authors.valid]);
  const retry = await runSchoolPilotMigrationLedger({ pool, migrations: [classpilotTeacherPreferencesMigration], applicationSha: "later" });
  assert.equal(retry[0]?.status, "skipped");
  await admin.query(CLASSPILOT_TEACHER_PREFERENCES_SCHEMA_SQL);
  assert.equal((await admin.query("SELECT 1 FROM classpilot_teacher_preferences WHERE school_id=$1", [schools.future])).rowCount, 0);
  assert.equal((await admin.query("SELECT max_tabs_per_student FROM classpilot_teacher_preferences WHERE school_id=$1 AND teacher_id=$2", [schools.a, authors.valid])).rows[0].max_tabs_per_student, 12);
  assert.deepEqual((await admin.query("SELECT max_tabs_per_student,default_flight_path_id,allowed_domains FROM teacher_settings WHERE teacher_id=$1", [authors.valid])).rows[0], {
    max_tabs_per_student: " 7 ", default_flight_path_id: "keep-legacy-flight-path", allowed_domains: ["keep.invalid"],
  });
});

test("schema bounds, one-owner uniqueness, and same-school membership hold independently of application validation", async () => {
  const parameters = [schools.a, authors.valid];
  await assert.rejects(admin.query("INSERT INTO classpilot_teacher_preferences(school_id,teacher_id) VALUES($1,$2)", parameters), { code: "23505" });
  await assert.rejects(admin.query("INSERT INTO classpilot_teacher_preferences(school_id,teacher_id) VALUES($1,$2)", [schools.b, authors.missing]), { code: "23514" });
  for (const value of [0, 101, -1]) await assert.rejects(admin.query("UPDATE classpilot_teacher_preferences SET max_tabs_per_student=$3 WHERE school_id=$1 AND teacher_id=$2", [...parameters, value]), { code: "23514" });
  await assert.rejects(admin.query("UPDATE classpilot_teacher_preferences SET revision=0 WHERE school_id=$1 AND teacher_id=$2", parameters), { code: "23514" });
  for (const value of [1, 100, null]) await admin.query("UPDATE classpilot_teacher_preferences SET max_tabs_per_student=$3 WHERE school_id=$1 AND teacher_id=$2", [...parameters, value]);
});

test("typed schema, immutable ledger contract, and forced tenant RLS match", async () => {
  const columns = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='classpilot_teacher_preferences'", [schema])).rows.map(row => row.column_name).sort();
  assert.deepEqual(columns, Object.values(getTableColumns(classpilotTeacherPreferences)).map(column => column.name).sort());
  assert.equal(classpilotTeacherPreferencesMigration.checksum, createHash("sha256").update(CLASSPILOT_TEACHER_PREFERENCES_SQL).digest("hex"));
  assert.ok(schoolPilot27ExpandMigrations.some(migration => migration.id === classpilotTeacherPreferencesMigration.id));
  const policy = (await admin.query(`SELECT c.relrowsecurity enabled,c.relforcerowsecurity forced,p.polname,pg_get_expr(p.polqual,p.polrelid) AS using,pg_get_expr(p.polwithcheck,p.polrelid) AS check
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_policy p ON p.polrelid=c.oid WHERE n.nspname=$1 AND c.relname='classpilot_teacher_preferences'`, [schema])).rows[0];
  assert.equal(policy.enabled, true); assert.equal(policy.forced, true); assert.equal(policy.polname, "tenant_isolation"); assert.equal(policy.using, policy.check);
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}; SET ROLE ${role}`);
  try {
    await admin.query("SELECT set_config('app.is_super','off',false),set_config('app.school_id','',false)");
    assert.equal((await admin.query("SELECT * FROM classpilot_teacher_preferences")).rowCount, 0);
    await admin.query("SELECT set_config('app.school_id',$1,false)", [schools.b]);
    assert.equal((await admin.query("SELECT * FROM classpilot_teacher_preferences")).rowCount, 1);
    assert.equal((await admin.query("UPDATE classpilot_teacher_preferences SET max_tabs_per_student=8 WHERE school_id=$1", [schools.a])).rowCount, 0);
    await assert.rejects(admin.query("INSERT INTO classpilot_teacher_preferences(school_id,teacher_id) VALUES($1,$2)", [schools.future, authors.valid]), { code: "42501" });
  } finally { await admin.query("RESET ROLE"); }
});
