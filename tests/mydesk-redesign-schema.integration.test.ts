import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import pg from "pg";
import { MYDESK_SQL } from "../src/db/mydeskMigration.js";
import { MYDESK_IMPORTS_SQL } from "../src/db/mydeskImportsMigration.js";
import { MYDESK_WORKSPACE_SQL } from "../src/db/mydeskWorkspaceMigration.js";
import { SCHOOL_DISCIPLINE_SQL } from "../src/db/schoolDisciplineMigration.js";
import { MYDESK_GRADE_FILING_SQL, mydeskGradeFilingMigration } from "../src/db/mydeskGradeFilingMigration.js";
import { MYDESK_IMPORT_DESTINATION_SQL, mydeskImportDestinationMigration } from "../src/db/mydeskImportDestinationMigration.js";
import { SCHOOL_DISCIPLINE_REDESIGN_SQL, schoolDisciplineRedesignMigration } from "../src/db/schoolDisciplineRedesignMigration.js";
import { STUDENT_INFORMATION_REDESIGN_SQL, studentInformationRedesignMigration } from "../src/db/studentInformationRedesignMigration.js";
import { mydeskNotes, mydeskAttachments } from "../src/schema/mydesk.js";
import { mydeskPreferences } from "../src/schema/mydeskPreferences.js";
import { mydeskImports, mydeskImportItems, mydeskImportAssets } from "../src/schema/mydeskImports.js";
import { schoolDisciplineRecords, schoolDisciplineVersions, schoolDisciplineAttachments, schoolDisciplineAccess } from "../src/schema/schoolDiscipline.js";
import { studentContactProfiles, studentContactProfileVersions, studentInformationImports, studentInformationImportItems, studentInformationImportAssets } from "../src/schema/studentInformation.js";

const name = `redesign_fixture_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const changes = [[mydeskGradeFilingMigration, MYDESK_GRADE_FILING_SQL], [mydeskImportDestinationMigration, MYDESK_IMPORT_DESTINATION_SQL],
  [schoolDisciplineRedesignMigration, SCHOOL_DISCIPLINE_REDESIGN_SQL], [studentInformationRedesignMigration, STUDENT_INFORMATION_REDESIGN_SQL]] as const;
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  await client.connect(); await client.query(`CREATE SCHEMA ${name}; SET search_path TO ${name}; SET app.is_super='on';
    CREATE TABLE schools(id TEXT PRIMARY KEY); CREATE TABLE users(id VARCHAR PRIMARY KEY);
    CREATE TABLE school_memberships(school_id TEXT,user_id VARCHAR,role TEXT,status TEXT);
    CREATE TABLE groups(id VARCHAR PRIMARY KEY,school_id TEXT,UNIQUE(school_id,id));
    CREATE TABLE students(id VARCHAR PRIMARY KEY,school_id TEXT,UNIQUE(school_id,id));
    CREATE TABLE audit_logs(school_id TEXT,action TEXT,entity_type TEXT,entity_id TEXT,metadata JSONB);`);
  for (const sql of [MYDESK_SQL, MYDESK_IMPORTS_SQL, MYDESK_WORKSPACE_SQL, SCHOOL_DISCIPLINE_SQL]) await client.query(sql);
  for (const [, sql] of changes) await client.query(sql);
});
after(async () => { await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); await client.end(); });

test("all additive redesign migrations replay without touching historical checksums and match the complete typed schema", async () => {
  for (const [migration, sql] of changes) {
    assert.equal(migration.checksum, createHash("sha256").update(sql).digest("hex"));
    await client.query(sql);
  }
  for (const table of [mydeskNotes, mydeskAttachments, mydeskPreferences, mydeskImports, mydeskImportItems, mydeskImportAssets,
    schoolDisciplineRecords, schoolDisciplineVersions, schoolDisciplineAttachments, schoolDisciplineAccess,
    studentContactProfiles, studentContactProfileVersions, studentInformationImports, studentInformationImportItems, studentInformationImportAssets]) {
    const actual = await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2", [name, getTableName(table)]);
    assert.deepEqual(actual.rows.map(row => row.column_name).sort(), Object.values(getTableColumns(table)).map(column => column.name).sort(), getTableName(table));
    const rls = await client.query<{ enabled: boolean; forced: boolean; policies: string[] }>(`SELECT c.relrowsecurity enabled,c.relforcerowsecurity forced,
      ARRAY(SELECT p.polname::text FROM pg_policy p WHERE p.polrelid=c.oid) policies FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`, [name, getTableName(table)]);
    assert.deepEqual(rls.rows[0], { enabled: true, forced: true, policies: ["tenant_isolation"] });
  }
  assert.equal((await client.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname='school_discipline_membership_revoke' AND tgrelid='school_memberships'::regclass")).rows[0].n, 0);
});

test("grade-only targets preserve school and student filing when live references disappear; contact history cannot be edited", async () => {
  const school = randomUUID(), author = randomUUID(), student = randomUUID(), hash = "a".repeat(64);
  await client.query("INSERT INTO schools VALUES($1);", [school]); await client.query("INSERT INTO users VALUES($1)", [author]);
  await client.query("INSERT INTO school_memberships VALUES($1,$2,'teacher','active')", [school, author]);
  await client.query("INSERT INTO students VALUES($1,$2)", [student, school]);
  for (const kind of ["grade", "student"]) await client.query(`INSERT INTO mydesk_notes(school_id,author_id,client_request_id,request_fingerprint,target_kind,filing_grade_level,filing_school_year,student_id,filing_student_id,student_name,entry_date)
    VALUES($1,$2,$3,$4,$5,'5','configured-year',$6,$6,$7,'2026-09-26')`, [school, author, randomUUID(), hash, kind, kind === "student" ? student : null, kind === "student" ? "Snapshot student" : null]);
  const profile = (await client.query(`INSERT INTO student_contact_profiles(school_id,student_id,filing_student_id,student_name,updated_by,updated_by_name)
    VALUES($1,$2,$2,'Snapshot student',$3,'Reviewer') RETURNING id`, [school, student, author])).rows[0].id;
  await client.query(`INSERT INTO student_contact_profile_versions(school_id,author_id,profile_id,revision,request_id,request_fingerprint,data,changes,reason,author_name)
    VALUES($1,$2,$3,1,$4,$5,'{"contacts":[]}','[]','Reviewed source','Reviewer')`, [school, author, profile, randomUUID(), hash]);
  await assert.rejects(client.query("UPDATE student_contact_profile_versions SET reason='rewritten' WHERE profile_id=$1", [profile]), { code: "23514" });
  await client.query("DELETE FROM students WHERE id=$1", [student]);
  const saved = (await client.query("SELECT school_id,student_id,filing_student_id FROM student_contact_profiles WHERE id=$1", [profile])).rows[0];
  assert.deepEqual(saved, { school_id: school, student_id: null, filing_student_id: student });
  const notes = await client.query("SELECT school_id,student_id,filing_grade_level,filing_school_year FROM mydesk_notes WHERE school_id=$1", [school]);
  assert.equal(notes.rowCount, 2); for (const row of notes.rows) assert.deepEqual(row, { school_id: school, student_id: null, filing_grade_level: "5", filing_school_year: "configured-year" });
});
