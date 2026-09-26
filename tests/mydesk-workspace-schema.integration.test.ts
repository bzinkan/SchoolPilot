import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import pg from "pg";
import { MYDESK_IMPORTS_SQL } from "../src/db/mydeskImportsMigration.js";
import { MYDESK_WORKSPACE_SQL, mydeskWorkspaceMigration } from "../src/db/mydeskWorkspaceMigration.js";
import { SCHOOL_DISCIPLINE_SQL, schoolDisciplineMigration } from "../src/db/schoolDisciplineMigration.js";
import { mydeskPreferences } from "../src/schema/mydeskPreferences.js";
import { schoolDisciplineRecords, schoolDisciplineVersions, schoolDisciplineAttachments, schoolDisciplineAccess } from "../src/schema/schoolDiscipline.js";

const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`, schema = `workspace_fixture_${suffix}`, role = `workspace_probe_${suffix}`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const tables = [mydeskPreferences, schoolDisciplineRecords, schoolDisciplineVersions, schoolDisciplineAttachments, schoolDisciplineAccess];
const hash = "a".repeat(64);
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Only a local fixture database is permitted");
  await client.connect(); await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; SET app.is_super='on'`);
  await client.query(`CREATE TABLE schools(id TEXT PRIMARY KEY); CREATE TABLE users(id VARCHAR PRIMARY KEY);
    CREATE TABLE school_memberships(school_id TEXT NOT NULL,user_id VARCHAR NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE audit_logs(school_id TEXT,action TEXT,entity_type TEXT,entity_id TEXT,metadata JSONB);`);
  await client.query(MYDESK_IMPORTS_SQL); await client.query(MYDESK_WORKSPACE_SQL); await client.query(SCHOOL_DISCIPLINE_SQL);
  await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
});
after(async () => {
  await client.query("RESET ROLE"); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await client.query(`DROP ROLE IF EXISTS ${role}`); await client.end();
});
async function fixture() {
  const school = randomUUID(), other = randomUUID(), author = randomUUID(), foreign = randomUUID();
  await client.query("INSERT INTO schools VALUES($1),($2)", [school, other]);
  await client.query("INSERT INTO users VALUES($1),($2)", [author, foreign]);
  await client.query("INSERT INTO school_memberships VALUES($1,$2,'school_admin','active'),($3,$4,'teacher','active')", [school, author, other, foreign]);
  return { school, other, author, foreign };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function record(f: Fixture, request = randomUUID()) {
  return (await client.query(`INSERT INTO school_discipline_records(school_id,submitted_by,submitted_by_name,client_request_id,request_fingerprint,source_note_id)
    VALUES($1,$2,'Stored teacher',$3,$4,$5) RETURNING id`, [f.school, f.author, request, hash, randomUUID()])).rows[0].id as string;
}
async function version(f: Fixture, recordId: string, request = randomUUID()) {
  return (await client.query(`INSERT INTO school_discipline_versions(school_id,record_id,number,kind,client_request_id,request_fingerprint,snapshot)
    VALUES($1,$2,1,'submission',$3,$4,$5::jsonb) RETURNING id`, [f.school, recordId, request, hash, JSON.stringify({ studentId: randomUUID(), studentName: "Stored student", classId: randomUUID(), className: "Past class", category: "referral", title: "", body: "Reported event", entryDate: "2026-09-26" })])).rows[0].id as string;
}
async function attachment(f: Fixture, versionId: string) {
  return client.query(`INSERT INTO school_discipline_attachments(school_id,version_id,storage_key,content_type,byte_size,sha256)
    VALUES($1,$2,$3,'image/jpeg',123,$4) RETURNING id`, [f.school, versionId, `mydesk/${randomUUID()}`, hash]);
}

test("additive migrations replay and all five table columns agree with the typed schema", async () => {
  await client.query(MYDESK_WORKSPACE_SQL); await client.query(SCHOOL_DISCIPLINE_SQL);
  for (const [migration, sql] of [[mydeskWorkspaceMigration, MYDESK_WORKSPACE_SQL], [schoolDisciplineMigration, SCHOOL_DISCIPLINE_SQL]] as const) {
    assert.equal(migration.mode, "transactional"); assert.equal(migration.checksum, createHash("sha256").update(sql).digest("hex"));
  }
  for (const table of tables) {
    const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2", [schema, getTableName(table)]);
    assert.deepEqual(columns.rows.map(row => row.column_name).sort(), Object.values(getTableColumns(table)).map(column => column.name).sort());
    const policy = await client.query(`SELECT c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced,
      p.polname::text AS name,pg_get_expr(p.polqual,p.polrelid) AS using,pg_get_expr(p.polwithcheck,p.polrelid) AS check
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_policy p ON p.polrelid=c.oid WHERE n.nspname=$1 AND c.relname=$2`, [schema, getTableName(table)]);
    assert.equal(policy.rowCount, 1); const actual=policy.rows[0]; assert.equal(actual.enabled,true); assert.equal(actual.forced,true); assert.equal(actual.name,"tenant_isolation");
    assert.equal(actual.using,actual.check); assert.match(actual.using,/school_id.*app.school_id.*app.is_super/);
  }
});

test("preferences are one school/author record with bounded JSON; import snapshots remain independently frozen", async () => {
  const f=await fixture();
  await client.query("INSERT INTO mydesk_preferences(school_id,author_id,preferred_classes) VALUES($1,$2,$3)",[f.school,f.author,{"5":"class-five"}]);
  await assert.rejects(client.query("INSERT INTO mydesk_preferences(school_id,author_id) VALUES($1,$2)",[f.school,f.author]),{code:"23505"});
  await assert.rejects(client.query("INSERT INTO mydesk_preferences(school_id,author_id) VALUES($1,$2)",[f.school,f.foreign]),{code:"23514"});
  for(const value of [[],null,{key:"x".repeat(9000)}]) await assert.rejects(client.query("UPDATE mydesk_preferences SET preferred_classes=$3::jsonb WHERE school_id=$1 AND author_id=$2",[f.school,f.author,JSON.stringify(value)]),{code:"23514"});
  const frozen={revision:1,preferredClasses:{"5":"class-five"}};
  const run=await client.query(`INSERT INTO mydesk_imports(school_id,author_id,client_request_id,request_fingerprint,expected_source_count,expires_at,upload_expires_at,preferences_snapshot)
    VALUES($1,$2,$3,$4,1,now()+interval '7 days',now()+interval '24 hours',$5) RETURNING id`,[f.school,f.author,randomUUID(),hash,frozen]);
  await client.query("UPDATE mydesk_preferences SET preferred_classes=$3,revision=2 WHERE school_id=$1 AND author_id=$2",[f.school,f.author,{"5":"another-class"}]);
  assert.deepEqual((await client.query("SELECT preferences_snapshot FROM mydesk_imports WHERE id=$1",[run.rows[0].id])).rows[0].preferences_snapshot,frozen);
  await assert.rejects(client.query("UPDATE mydesk_imports SET source_note_id=$2 WHERE id=$1",[run.rows[0].id,randomUUID()]),{code:"23514"});
});

test("publication keys, same-school evidence parents and immutable versions retain independent school evidence",async()=>{
  const f=await fixture(), request=randomUUID(), id=await record(f,request), v=await version(f,id); await attachment(f,v);
  await assert.rejects(record(f,request),{code:"23505"});
  await assert.rejects(version({...f,school:f.other},id),{code:"23503"});
  await assert.rejects(attachment({...f,school:f.other},v),{code:"23503"});
  await assert.rejects(client.query("DELETE FROM school_discipline_records WHERE id=$1",[id]),{code:"23503"});
  await assert.rejects(client.query("UPDATE school_discipline_versions SET snapshot='[]' WHERE id=$1",[v]),{code:"23514"});
  await client.query("UPDATE school_discipline_versions SET state='published',published_at=now() WHERE id=$1",[v]);
  await assert.rejects(client.query("UPDATE school_discipline_versions SET snapshot='{}' WHERE id=$1",[v]),{code:"23514"});
  const second=await version(f,id); await assert.rejects(client.query("UPDATE school_discipline_versions SET state='published' WHERE id=$1",[second]),{code:"23505"});
  const foreignKeys=await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='school_discipline_records'::regclass AND contype='f'");
  assert.ok(foreignKeys.rows.every(row=>!row.definition.includes("mydesk_notes")),"Private source deletion must not cascade into school records");
});

test("last qualifying membership permanently revokes an explicit grant and audits identifiers only",async()=>{
  const f=await fixture(); await client.query("INSERT INTO school_discipline_access(school_id,user_id,enabled) VALUES($1,$2,true)",[f.school,f.author]);
  await client.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2",[f.school,f.author]);
  const revoked=(await client.query("SELECT enabled,revision FROM school_discipline_access WHERE school_id=$1",[f.school])).rows[0]; assert.deepEqual(revoked,{enabled:false,revision:1});
  await client.query("UPDATE school_memberships SET status='active' WHERE school_id=$1 AND user_id=$2",[f.school,f.author]);
  assert.equal((await client.query("SELECT enabled FROM school_discipline_access WHERE school_id=$1",[f.school])).rows[0].enabled,false);
  const audit=(await client.query("SELECT action,metadata FROM audit_logs WHERE school_id=$1",[f.school])).rows[0];
  assert.deepEqual(audit,{action:"discipline.access.auto_revoked",metadata:{userId:f.author,reason:"membership_changed"}});
});

test("every new table denies unscoped and foreign-school reads/writes for a restricted role",async()=>{
  const f=await fixture(), id=await record(f), v=await version(f,id); await attachment(f,v);
  await client.query("INSERT INTO mydesk_preferences(school_id,author_id) VALUES($1,$2)",[f.school,f.author]);
  await client.query("INSERT INTO school_discipline_access(school_id,user_id,enabled) VALUES($1,$2,true)",[f.school,f.author]);
  await client.query(`SET ROLE ${role}`);
  try {
    await client.query("SELECT set_config('app.school_id','',false),set_config('app.is_super','off',false)");
    for(const table of tables) assert.equal((await client.query(`SELECT id FROM ${getTableName(table)}`)).rowCount,0);
    await client.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2",[f.school,f.author]);
    assert.equal((await client.query("SELECT current_setting('app.school_id',true) AS scope")).rows[0].scope,"","Global membership housekeeping must restore the caller's tenant scope");
    assert.equal((await client.query("SELECT current_setting('app.is_super',true) AS scope")).rows[0].scope,"off","Revocation must not elevate the super GUC");
    await client.query("SELECT set_config('app.school_id',$1,false)",[f.school]);
    assert.equal((await client.query("SELECT enabled FROM school_discipline_access WHERE school_id=$1",[f.school])).rows[0].enabled,false,"Unscoped global membership writes must still permanently revoke the tenant grant");
    for(const table of tables) assert.equal((await client.query(`SELECT id FROM ${getTableName(table)} WHERE school_id=$1`,[f.school])).rowCount,1);
    await client.query("SELECT set_config('app.school_id',$1,false)",[f.other]);
    for(const table of tables) assert.equal((await client.query(`SELECT id FROM ${getTableName(table)} WHERE school_id=$1`,[f.school])).rowCount,0);
    await assert.rejects(record(f),{code:"42501"}); await assert.rejects(version(f,id),{code:"42501"}); await assert.rejects(attachment(f,v),{code:"42501"});
    await assert.rejects(client.query("INSERT INTO mydesk_preferences(school_id,author_id) VALUES($1,$2)",[f.school,f.author]),{code:"42501"});
    await assert.rejects(client.query("INSERT INTO school_discipline_access(school_id,user_id) VALUES($1,$2)",[f.school,f.author]),{code:"42501"});
  } finally { await client.query("RESET ROLE; SET app.is_super='on'"); }
});
