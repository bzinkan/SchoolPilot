import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import { SAFETY_CENTER_SQL, SAFETY_CENTER_TENANT_TABLES } from "../src/db/safetyCenterMigration.js";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll("-", "");
const schema = `safety_migration_${suffix}`;
const role = `safety_reader_${suffix}`;

before(async () => {
  await client.connect();
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path=${schema},public`);
  await client.query(`
    CREATE TABLE schools(id text PRIMARY KEY);
    CREATE TABLE students(id text PRIMARY KEY,school_id text NOT NULL,UNIQUE(school_id,id));
    CREATE TABLE student_safety_cases(id text PRIMARY KEY,school_id text NOT NULL,student_id text NOT NULL,
      status text NOT NULL DEFAULT 'open',opened_at timestamptz NOT NULL,closed_at timestamptz);
    CREATE TABLE student_timeline_events(id text PRIMARY KEY,school_id text NOT NULL,case_id text);
    CREATE TABLE evidence_artifacts(id text PRIMARY KEY,school_id text NOT NULL,case_id text,packet_bytes bytea);
    CREATE TABLE classpilot_evidence_capture_requests(id text PRIMARY KEY,school_id text NOT NULL,case_id text);
    INSERT INTO schools VALUES('A'),('B');
    INSERT INTO students VALUES('student-A','A'),('student-B','B');
    INSERT INTO student_safety_cases(id,school_id,student_id,opened_at) VALUES
      ('old','A','student-A','2026-01-01'),('duplicate','A','student-A','2026-01-02'),('foreign','B','student-B','2026-01-01');
    INSERT INTO student_timeline_events VALUES('event','A','duplicate');
    INSERT INTO evidence_artifacts VALUES('packet','A','duplicate',decode('000102ff','hex'));
    INSERT INTO classpilot_evidence_capture_requests VALUES('capture','A','duplicate');
  `);
  await client.query(SAFETY_CENTER_SQL);
  await client.query(`CREATE ROLE ${role} NOSUPERUSER NOLOGIN;
    GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role};`);
});
after(async () => { await client.query("ROLLBACK").catch(() => {}); await client.end(); });

async function rejectsSql(statement: string, code: string) {
  await client.query("SAVEPOINT expected_failure");
  try { await assert.rejects(client.query(statement), (error: unknown) => error instanceof Error && "code" in error && error.code === code); }
  finally { await client.query("ROLLBACK TO SAVEPOINT expected_failure"); await client.query("RELEASE SAVEPOINT expected_failure"); }
}
const alertInsert = (id: string, school: string, student: string, caseId: string) => `INSERT INTO student_safety_alerts
  (id,school_id,student_id,case_id,fingerprint,source_type,source_id,concern,severity,first_seen_at,last_seen_at)
  VALUES('${id}','${school}','${student}','${caseId}','${id}','browser','source','weapons','medium',now(),now())`;

describe("Safety Center additive migration and actual tenant policies", () => {
  it("consolidates old cases, retains redirects and leaves exported bytes unchanged on replay", async () => {
    await client.query(SAFETY_CENTER_SQL);
    assert.deepEqual((await client.query("SELECT id,status,merged_into FROM student_safety_cases WHERE school_id='A' ORDER BY id")).rows,
      [{ id: "duplicate", status: "closed", merged_into: "old" }, { id: "old", status: "open", merged_into: null }]);
    for (const table of ["student_timeline_events", "evidence_artifacts", "classpilot_evidence_capture_requests"])
      assert.equal((await client.query(`SELECT case_id FROM ${table} WHERE school_id='A'`)).rows[0].case_id, "old");
    assert.equal((await client.query("SELECT encode(packet_bytes,'hex') AS bytes FROM evidence_artifacts")).rows[0].bytes, "000102ff");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM student_safety_case_events WHERE kind='case_merged'")).rows[0].count, 1);
    await rejectsSql("INSERT INTO student_safety_cases(id,school_id,student_id,opened_at) VALUES('another','A','student-A',now())", "23505");
  });

  it("rejects mismatched school/student/case parents and case-alert references", async () => {
    await client.query(alertInsert("alert-A", "A", "student-A", "old"));
    await client.query(alertInsert("alert-B", "B", "student-B", "foreign"));
    await rejectsSql(alertInsert("bad-case", "A", "student-A", "foreign"), "23503");
    await rejectsSql(alertInsert("bad-student", "A", "student-B", "old"), "23503");
    await rejectsSql("INSERT INTO student_safety_case_events(school_id,case_id,alert_id,kind) VALUES('A','old','alert-B','review')", "23503");
    await rejectsSql("INSERT INTO safety_notification_outbox(school_id,case_id,alert_id,recipient,kind,alert_revision,due_at) VALUES('A','old','alert-B','admin@example.test','initial',0,now())", "23503");
  });

  it("enforces deny-by-default, tenant reads, WITH CHECK, and FORCE RLS on the migrated tables", async () => {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.school_id','',true),set_config('app.is_super','',true)");
    for (const table of SAFETY_CENTER_TENANT_TABLES)
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0);
    await client.query("SELECT set_config('app.school_id','A',true)");
    assert.deepEqual((await client.query("SELECT id FROM student_safety_alerts")).rows, [{ id: "alert-A" }]);
    await rejectsSql(alertInsert("forbidden", "B", "student-B", "foreign"), "42501");
    await client.query("RESET ROLE");
    for (const table of SAFETY_CENTER_TENANT_TABLES) {
      const catalog = (await client.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass", [table])).rows[0];
      assert.deepEqual(catalog, { relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("keeps approved URL configuration after its case and alert provenance expire", async () => {
    await client.query("INSERT INTO safety_url_exceptions(id,school_id,fingerprint,url_ciphertext,created_from_alert_id,created_by) VALUES('rule','A','url-hash','encrypted-fixture','alert-A','admin-A')");
    await client.query("DELETE FROM student_safety_cases WHERE id='old'");
    assert.deepEqual((await client.query("SELECT school_id,created_from_alert_id,url_ciphertext,revoked_at FROM safety_url_exceptions WHERE id='rule'")).rows,
      [{ school_id: "A", created_from_alert_id: null, url_ciphertext: "encrypted-fixture", revoked_at: null }]);
  });
});
