import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import pg from "pg";
import { MYDESK_SQL, mydeskMigration } from "../src/db/mydeskMigration.js";
import { mydeskAttachments, mydeskNotes } from "../src/schema/mydesk.js";

const schema = `mydesk_fixture_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const hash = "a".repeat(64);
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Only a local fixture database is permitted");
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query("SET app.is_super='on'");
  await client.query(`
    CREATE TABLE schools(id TEXT PRIMARY KEY);
    CREATE TABLE users(id VARCHAR PRIMARY KEY);
    CREATE TABLE school_memberships(school_id TEXT NOT NULL, user_id VARCHAR NOT NULL);
    CREATE TABLE groups(id VARCHAR PRIMARY KEY, school_id TEXT NOT NULL, UNIQUE(school_id,id));
    CREATE TABLE students(id VARCHAR PRIMARY KEY, school_id TEXT NOT NULL, UNIQUE(school_id,id));
  `);
  await client.query(MYDESK_SQL);
});
after(async () => {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
});

async function fixture() {
  const schoolId = randomUUID(), otherSchoolId = randomUUID(), authorId = randomUUID(), colleagueId = randomUUID();
  const foreignAuthorId = randomUUID(), groupId = randomUUID(), studentId = randomUUID(), foreignGroupId = randomUUID();
  await client.query("INSERT INTO schools VALUES($1),($2)", [schoolId, otherSchoolId]);
  await client.query("INSERT INTO users VALUES($1),($2),($3)", [authorId, colleagueId, foreignAuthorId]);
  await client.query("INSERT INTO school_memberships VALUES($1,$2),($1,$3),($4,$5)", [schoolId, authorId, colleagueId, otherSchoolId, foreignAuthorId]);
  await client.query("INSERT INTO groups VALUES($1,$2),($3,$4)", [groupId, schoolId, foreignGroupId, otherSchoolId]);
  await client.query("INSERT INTO students VALUES($1,$2)", [studentId, schoolId]);
  return { schoolId, otherSchoolId, authorId, colleagueId, foreignAuthorId, groupId, studentId, foreignGroupId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function generalNote(f: Fixture, requestId = randomUUID(), authorId = f.authorId) {
  const result = await client.query<{ id: string }>(`INSERT INTO mydesk_notes(school_id,author_id,client_request_id,request_fingerprint,entry_date,body)
    VALUES($1,$2,$3,$4,'2026-09-25','Fixture note') RETURNING id`, [f.schoolId, authorId, requestId, hash]);
  return result.rows[0]!.id;
}
async function reserve(f: Fixture, noteId: string, requestId = randomUUID(), authorId = f.authorId) {
  return client.query<{ id: string }>(`INSERT INTO mydesk_attachments(school_id,author_id,note_id,client_request_id,storage_key,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [f.schoolId, authorId, noteId, requestId, `mydesk/${f.schoolId}/${randomUUID()}`, hash]);
}

test("migration is replayable and PostgreSQL columns match the typed schema", async () => {
  // Model the NO ACTION foreign keys emitted by the Drizzle bootstrap.
  await client.query(`ALTER TABLE mydesk_notes DROP CONSTRAINT mydesk_notes_group_fk;
    ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_group_fk FOREIGN KEY(school_id,group_id) REFERENCES groups(school_id,id);
    ALTER TABLE mydesk_notes DROP CONSTRAINT mydesk_notes_student_fk;
    ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_student_fk FOREIGN KEY(school_id,student_id) REFERENCES students(school_id,id);`);
  await client.query(MYDESK_SQL);
  const repaired = await client.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='mydesk_notes'::regclass AND conname IN ('mydesk_notes_group_fk','mydesk_notes_student_fk') ORDER BY conname`);
  assert.ok(repaired.rows[0]!.definition.endsWith("ON DELETE SET NULL (group_id)"));
  assert.ok(repaired.rows[1]!.definition.endsWith("ON DELETE SET NULL (student_id)"));
  assert.equal(mydeskMigration.mode, "transactional");
  assert.equal(mydeskMigration.checksum, createHash("sha256").update(MYDESK_SQL).digest("hex"));
  for (const table of [mydeskNotes, mydeskAttachments]) {
    const result = await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2", [schema, getTableName(table)]);
    assert.deepEqual(result.rows.map(row => row.column_name).sort(), Object.values(getTableColumns(table)).map(column => column.name).sort());
    const policies = await client.query<{ enabled: boolean; forced: boolean; policies: string[] }>(`SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
      ARRAY(SELECT polname::text FROM pg_policy WHERE polrelid=c.oid) AS policies FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`, [schema, getTableName(table)]);
    assert.deepEqual(policies.rows[0], { enabled: true, forced: true, policies: ["tenant_isolation"] });
  }
});

test("deleting live group/student references preserves school and Past classes snapshots", async () => {
  const f = await fixture();
  const row = await client.query<{ id: string }>(`INSERT INTO mydesk_notes(school_id,author_id,client_request_id,request_fingerprint,target_kind,group_id,filing_group_id,group_name,student_id,filing_student_id,student_name,entry_date)
    VALUES($1,$2,$3,$4,'student',$5,$5,'Past maths',$6,$6,'Student snapshot','2026-09-25') RETURNING id`, [f.schoolId, f.authorId, randomUUID(), hash, f.groupId, f.studentId]);
  await client.query("DELETE FROM groups WHERE id=$1", [f.groupId]);
  await client.query("DELETE FROM students WHERE id=$1", [f.studentId]);
  const actual = await client.query<{ school_id: string; group_id: string | null; student_id: string | null; filing_group_id: string; filing_student_id: string; group_name: string; student_name: string }>(
    "SELECT school_id,group_id,student_id,filing_group_id,filing_student_id,group_name,student_name FROM mydesk_notes WHERE id=$1", [row.rows[0]!.id]);
  assert.deepEqual(actual.rows[0], { school_id: f.schoolId, group_id: null, student_id: null, filing_group_id: f.groupId, filing_student_id: f.studentId, group_name: "Past maths", student_name: "Student snapshot" });
  await assert.rejects(client.query(`INSERT INTO mydesk_notes(school_id,author_id,client_request_id,request_fingerprint,target_kind,filing_student_id,student_name,entry_date)
    VALUES($1,$2,$3,$4,'student',$5,'Missing class','2026-09-25')`, [f.schoolId, f.authorId, randomUUID(), hash, f.studentId]), { code: "23514" });
});

test("cross-school references and cross-author attachments are rejected by database constraints", async () => {
  const f = await fixture(), noteId = await generalNote(f);
  await assert.rejects(reserve(f, noteId, randomUUID(), f.colleagueId), { code: "23503" });
  await assert.rejects(generalNote(f, randomUUID(), f.foreignAuthorId), { code: "23514" });
  await assert.rejects(client.query(`INSERT INTO mydesk_notes(school_id,author_id,client_request_id,request_fingerprint,target_kind,group_id,filing_group_id,group_name,entry_date)
    VALUES($1,$2,$3,$4,'class',$5,$5,'Foreign class','2026-09-25')`, [f.schoolId, f.authorId, randomUUID(), hash, f.foreignGroupId]), { code: "23503" });
});

test("save and reservation request keys prevent duplicate retries without spanning notebooks", async () => {
  const f = await fixture(), requestId = randomUUID(), photoRequest = randomUUID();
  const noteId = await generalNote(f, requestId);
  await assert.rejects(generalNote(f, requestId), { code: "23505" });
  assert.ok(await generalNote(f, requestId, f.colleagueId));
  await reserve(f, noteId, photoRequest);
  await assert.rejects(reserve(f, noteId, photoRequest), { code: "23505" });
});

test("ready files need verified content and deleting the note cannot discard cleanup keys", async () => {
  const f = await fixture(), noteId = await generalNote(f);
  const photo = await reserve(f, noteId), photoId = photo.rows[0]!.id;
  await assert.rejects(client.query("UPDATE mydesk_attachments SET status='ready' WHERE id=$1", [photoId]), { code: "23514" });
  await client.query("UPDATE mydesk_attachments SET status='ready',content_type='image/jpeg',byte_size=123,input_sha256=$2,sha256=$2 WHERE id=$1", [photoId, hash]);
  assert.equal((await client.query<{ committed_at: Date | null }>("SELECT committed_at FROM mydesk_attachments WHERE id=$1", [photoId])).rows[0]!.committed_at, null);
  await assert.rejects(client.query("DELETE FROM mydesk_notes WHERE id=$1", [noteId]), { code: "23503" });
  await client.query("UPDATE mydesk_attachments SET status='delete_pending',next_cleanup_at=now() WHERE id=$1", [photoId]);
  await assert.rejects(client.query("DELETE FROM mydesk_notes WHERE id=$1", [noteId]), { code: "23503" });
});

test("tenant RLS denies unscoped/cross-school content to a non-owner role", async () => {
  const f = await fixture(), noteId = await generalNote(f); await reserve(f, noteId);
  const role = `mydesk_probe_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  await client.query("BEGIN");
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SET LOCAL app.is_super='off'");
    await client.query("SET LOCAL app.school_id=''");
    assert.equal((await client.query("SELECT id FROM mydesk_notes")).rowCount, 0);
    assert.equal((await client.query("SELECT id FROM mydesk_attachments")).rowCount, 0);
    await client.query("SELECT set_config('app.school_id',$1,true)", [f.otherSchoolId]);
    assert.equal((await client.query("SELECT id FROM mydesk_notes WHERE id=$1", [noteId])).rowCount, 0);
    await client.query("SELECT set_config('app.school_id',$1,true)", [f.schoolId]);
    assert.equal((await client.query("SELECT id FROM mydesk_notes WHERE id=$1", [noteId])).rowCount, 1);
    assert.equal((await client.query("SELECT id FROM mydesk_attachments WHERE note_id=$1", [noteId])).rowCount, 1);
    await assert.rejects(client.query("UPDATE mydesk_attachments SET school_id=$2 WHERE note_id=$1", [noteId, f.otherSchoolId]), /row-level security/);
  } finally { await client.query("ROLLBACK"); }
});
