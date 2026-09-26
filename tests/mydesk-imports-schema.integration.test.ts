import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { getTableColumns } from "drizzle-orm";
import { mydeskImports, mydeskImportAssets, mydeskImportItems } from "../src/schema/mydeskImports.js";
import { MYDESK_IMPORTS_SQL, mydeskImportsMigration } from "../src/db/mydeskImportsMigration.js";
import { MYDESK_WORKSPACE_SQL } from "../src/db/mydeskWorkspaceMigration.js";

const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
const schema = `import_fixture_${suffix}`, role = `import_probe_${suffix}`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const hash = "a".repeat(64);
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  await client.connect(); await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; SET app.is_super='on'`);
  await client.query(`CREATE TABLE schools(id TEXT PRIMARY KEY); CREATE TABLE users(id VARCHAR PRIMARY KEY);
    CREATE TABLE school_memberships(school_id TEXT NOT NULL,user_id VARCHAR NOT NULL);`);
  await client.query(MYDESK_IMPORTS_SQL);
  await client.query(MYDESK_WORKSPACE_SQL);
  await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
});
after(async () => {
  await client.query("RESET ROLE"); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`DROP ROLE IF EXISTS ${role}`); await client.end();
});
async function fixture() {
  const f = { school: randomUUID(), otherSchool: randomUUID(), author: randomUUID(), colleague: randomUUID(), outsider: randomUUID() };
  await client.query("INSERT INTO schools VALUES($1),($2)", [f.school, f.otherSchool]);
  await client.query("INSERT INTO users VALUES($1),($2),($3)", [f.author, f.colleague, f.outsider]);
  await client.query("INSERT INTO school_memberships VALUES($1,$2),($1,$3),($4,$5)", [f.school, f.author, f.colleague, f.otherSchool, f.outsider]);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function imported(f: Fixture, request = randomUUID(), author = f.author) {
  return (await client.query<{ id: string }>(`INSERT INTO mydesk_imports(school_id,author_id,client_request_id,request_fingerprint,expected_source_count,expires_at,upload_expires_at)
    VALUES($1,$2,$3,$4,1,now()+interval '7 days',now()+interval '24 hours') RETURNING id`, [f.school, author, request, hash])).rows[0]!.id;
}
async function asset(f: Fixture, importId: string, request = randomUUID(), author = f.author) {
  return (await client.query<{ id: string }>(`INSERT INTO mydesk_import_assets(school_id,author_id,import_id,client_request_id,request_fingerprint,kind,storage_key)
    VALUES($1,$2,$3,$4,$5,'source',$6) RETURNING id`, [f.school, author, importId, request, hash, `mydesk/${randomUUID()}`])).rows[0]!.id;
}
async function item(f: Fixture, importId: string, request = randomUUID(), author = f.author) {
  return (await client.query<{ id: string }>(`INSERT INTO mydesk_import_items(school_id,author_id,import_id,client_request_id,ordinal)
    VALUES($1,$2,$3,$4,0) RETURNING id`, [f.school, author, importId, request])).rows[0]!.id;
}

test("import migration replays, installs canonical checks after bootstrap and agrees with typed schema", async () => {
  await client.query("ALTER TABLE mydesk_imports DROP CONSTRAINT mydesk_imports_state");
  await client.query(MYDESK_IMPORTS_SQL);
  assert.equal(mydeskImportsMigration.checksum, createHash("sha256").update(MYDESK_IMPORTS_SQL).digest("hex"));
  for (const [name, table] of [["mydesk_imports", mydeskImports], ["mydesk_import_assets", mydeskImportAssets], ["mydesk_import_items", mydeskImportItems]] as const) {
    const columns = await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2", [schema, name]);
    assert.deepEqual(columns.rows.map(row => row.column_name).sort(), Object.values(getTableColumns(table)).map(column => column.name).sort());
  }
  const f = await fixture(), id = await imported(f);
  const row = (await client.query("SELECT status,revision,attempts,page_count,selected_group_ids,page_decisions,mutation_receipts,commit_receipt,quota_usage,model_version,prompt_version FROM mydesk_imports WHERE id=$1", [id])).rows[0];
  assert.deepEqual(row, { status: "uploading", revision: 1, attempts: 0, page_count: 0, selected_group_ids: [], page_decisions: [], mutation_receipts: [], commit_receipt: null, quota_usage: [], model_version: null, prompt_version: null });
  await assert.rejects(client.query("UPDATE mydesk_imports SET status='published' WHERE id=$1", [id]), { code: "23514" });
});

test("request deduplication and child ownership are bound to the exact school, author and import", async () => {
  const f = await fixture(), request = randomUUID(), id = await imported(f, request);
  await assert.rejects(imported(f, request), { code: "23505" });
  assert.ok(await imported(f, request, f.colleague));
  await assert.rejects(imported(f, randomUUID(), f.outsider), { code: "23514" });
  const childRequest = randomUUID(); await asset(f, id, childRequest); await item(f, id, childRequest);
  await assert.rejects(asset(f, id, childRequest), { code: "23505" });
  await assert.rejects(item(f, id, childRequest), { code: "23505" });
  await assert.rejects(asset(f, id, randomUUID(), f.colleague), { code: "23503" });
  await assert.rejects(item(f, id, randomUUID(), f.colleague), { code: "23503" });
  await assert.rejects(asset({ ...f, school: f.otherSchool }, id), { code: "23503" });
  await assert.rejects(client.query("DELETE FROM mydesk_imports WHERE id=$1", [id]), { code: "23503" });
});

test("source-parent and approved-crop references cannot cross an author or import boundary", async () => {
  const f = await fixture(), first = await imported(f), second = await imported(f), colleague = await imported(f, randomUUID(), f.colleague);
  const page = await asset(f, first), wrongRunPage = await asset(f, second), wrongAuthorPage = await asset(f, colleague, randomUUID(), f.colleague);
  const crop = await asset(f, first), draft = await item(f, first);
  await client.query("UPDATE mydesk_import_assets SET parent_asset_id=$2 WHERE id=$1", [crop, page]);
  await client.query("UPDATE mydesk_import_items SET approved_asset_id=$2 WHERE id=$1", [draft, crop]);
  for (const denied of [wrongRunPage, wrongAuthorPage]) {
    await assert.rejects(client.query("UPDATE mydesk_import_assets SET parent_asset_id=$2 WHERE id=$1", [crop, denied]), { code: "23503" });
    await assert.rejects(client.query("UPDATE mydesk_import_items SET approved_asset_id=$2 WHERE id=$1", [draft, denied]), { code: "23503" });
  }
});

test("import queue metadata, receipts and page budgets reject malformed or unbounded values", async () => {
  const f = await fixture(), id = await imported(f);
  for (const update of ["revision=0", "expected_source_count=0", "expected_source_count=6", "attempts=-1", "page_count=21", "request_fingerprint='bad'", "last_error_code='raw private error text'", "lease_id=gen_random_uuid()", "model_version='private model text'", "prompt_version=repeat('x',129)"])
    await assert.rejects(client.query(`UPDATE mydesk_imports SET ${update} WHERE id=$1`, [id]), { code: "23514" });
  for (const [field, value] of [["selected_group_ids", {}], ["selected_group_ids", Array(21).fill("group")],
    ["page_decisions", null], ["page_decisions", Array(21).fill({ assetId: randomUUID(), excluded: false })],
    ["quota_usage", {}], ["quota_usage", Array(9).fill({ date: "2026-09-25", pages: 1 })], ["quota_usage", [{ date: "x".repeat(4096), pages: 1 }]],
    ["mutation_receipts", Array(101).fill({})], ["commit_receipt", []], ["commit_receipt", { data: "x".repeat(16384) }]] as const)
    await assert.rejects(client.query(`UPDATE mydesk_imports SET ${field}=$2::jsonb WHERE id=$1`, [id, JSON.stringify(value)]), { code: "23514" });
  await client.query("UPDATE mydesk_imports SET status='processing',lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes',page_count=20,quota_date=current_date WHERE id=$1", [id]);
  const usage = [{ date: "2026-09-25", pages: 20 }, { date: "2026-09-26", pages: 3 }];
  await client.query("UPDATE mydesk_imports SET quota_usage=$2::jsonb,model_version='claude-sonnet-5',prompt_version='mydesk-import-v1' WHERE id=$1", [id, JSON.stringify(usage)]);
  await client.query("UPDATE mydesk_imports SET status='completed',lease_id=NULL,lease_until=NULL,commit_receipt=$2::jsonb WHERE id=$1", [id, JSON.stringify({ requestId: randomUUID(), fingerprint: hash, notes: [] })]);
  assert.equal((await client.query("SELECT page_count FROM mydesk_imports WHERE id=$1", [id])).rows[0].page_count, 20, "completion preserves quota accounting");
  assert.deepEqual((await client.query("SELECT quota_usage,model_version,prompt_version FROM mydesk_imports WHERE id=$1", [id])).rows[0], { quota_usage: usage, model_version: "claude-sonnet-5", prompt_version: "mydesk-import-v1" });
});

test("draft shape is bounded and suggestions do not require live student or class rows", async () => {
  const f = await fixture(), run = await imported(f), id = await item(f, run);
  await client.query("UPDATE mydesk_import_items SET group_id=$2,student_id=$3 WHERE id=$1", [id, randomUUID(), randomUUID()]);
  for (const update of ["ordinal=50", "revision=0", "category='discipline_action'", "title=repeat('x',161)", "body=repeat('x',5001)",
    "group_id=repeat('x',129)", "roster_revision='bad'", "review_fingerprint='bad'", "extraction_status='published'"])
    await assert.rejects(client.query(`UPDATE mydesk_import_items SET ${update} WHERE id=$1`, [id]), { code: "23514" });
  for (const [field, value] of [["regions", {}], ["regions", Array(21).fill({})], ["subject_names", ["x".repeat(16384)]], ["warnings", Array(21).fill("warning")]] as const)
    await assert.rejects(client.query(`UPDATE mydesk_import_items SET ${field}=$2::jsonb WHERE id=$1`, [id, JSON.stringify(value)]), { code: "23514" });
});

test("asset readiness and permanent promotion require valid metadata while retaining cleanup tombstones", async () => {
  const f = await fixture(), run = await imported(f), id = await asset(f, run);
  for (const update of ["status='ready'", "kind='external'", "byte_size=10485761", "sha256='bad'", "width=4097", "page_count=21", "cleanup_attempts=-1", "lease_id=gen_random_uuid()"])
    await assert.rejects(client.query(`UPDATE mydesk_import_assets SET ${update} WHERE id=$1`, [id]), { code: "23514" });
  await client.query("UPDATE mydesk_import_assets SET content_type='image/jpeg',byte_size=123,sha256=$2,status='ready' WHERE id=$1", [id, hash]);
  await assert.rejects(client.query("UPDATE mydesk_import_assets SET status='promoted' WHERE id=$1", [id]), { code: "23514" });
  await client.query("UPDATE mydesk_import_assets SET kind='approved',status='promoted',attachment_id=$2 WHERE id=$1", [id, randomUUID()]);
  await assert.rejects(client.query("UPDATE mydesk_import_assets SET lease_id=gen_random_uuid(),lease_until=now() WHERE id=$1", [id]), { code: "23514" });
  const deleting = await asset(f, run);
  await client.query("UPDATE mydesk_import_assets SET status='deleted',deleted_at=now(),next_cleanup_at=now()+interval '1 day' WHERE id=$1", [deleting]);
  const marker = (await client.query("SELECT storage_key,next_cleanup_at FROM mydesk_import_assets WHERE id=$1", [deleting])).rows[0];
  assert.ok(marker.storage_key); assert.ok(marker.next_cleanup_at);
});

test("all three import tables enforce forced RLS for a real restricted non-owner role", async () => {
  const f = await fixture(), run = await imported(f); await asset(f, run); await item(f, run);
  const tables = ["mydesk_imports", "mydesk_import_assets", "mydesk_import_items"];
  const catalog = await client.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[])", [schema, tables]);
  assert.equal(catalog.rowCount, 3); assert.ok(catalog.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
  await client.query(`SET ROLE ${role}`);
  try {
    await client.query("SELECT set_config('app.school_id','',false),set_config('app.is_super','off',false)");
    for (const table of tables) assert.equal((await client.query(`SELECT id FROM ${table}`)).rowCount, 0);
    await client.query("SELECT set_config('app.school_id',$1,false)", [f.school]);
    for (const table of tables) assert.equal((await client.query(`SELECT id FROM ${table} WHERE school_id=$1`, [f.school])).rowCount, 1);
    await client.query("SELECT set_config('app.school_id',$1,false)", [f.otherSchool]);
    for (const table of tables) assert.equal((await client.query(`SELECT id FROM ${table} WHERE school_id=$1`, [f.school])).rowCount, 0);
    await assert.rejects(imported(f), { code: "42501" });
    await assert.rejects(asset(f, run), { code: "42501" });
    await assert.rejects(item(f, run), { code: "42501" });
  } finally { await client.query("RESET ROLE; SET app.is_super='on'"); }
});
