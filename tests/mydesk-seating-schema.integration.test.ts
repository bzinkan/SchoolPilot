import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { getTableColumns } from "drizzle-orm";
import { mydeskSeatingCharts } from "../src/schema/mydeskSeating.js";
import { MYDESK_SEATING_SQL, mydeskSeatingMigration } from "../src/db/mydeskSeatingMigration.js";

const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
const schema = `seating_fixture_${suffix}`, role = `seating_probe_${suffix}`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const hash = "a".repeat(64);
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  await client.connect(); await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
  await client.query("SET app.is_super='on'");
  await client.query(`CREATE TABLE schools(id TEXT PRIMARY KEY); CREATE TABLE users(id VARCHAR PRIMARY KEY);
    CREATE TABLE school_memberships(school_id TEXT NOT NULL,user_id VARCHAR NOT NULL);
    CREATE TABLE groups(id VARCHAR PRIMARY KEY,school_id TEXT NOT NULL,UNIQUE(school_id,id));`);
  await client.query(MYDESK_SEATING_SQL);
  await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
});
after(async () => {
  await client.query("RESET ROLE"); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`DROP ROLE IF EXISTS ${role}`); await client.end();
});
async function fixture() {
  const f = { school: randomUUID(), otherSchool: randomUUID(), author: randomUUID(), colleague: randomUUID(), outsider: randomUUID(), group: randomUUID(), otherGroup: randomUUID() };
  await client.query("INSERT INTO schools VALUES($1),($2)", [f.school, f.otherSchool]);
  await client.query("INSERT INTO users VALUES($1),($2),($3)", [f.author, f.colleague, f.outsider]);
  await client.query("INSERT INTO school_memberships VALUES($1,$2),($1,$3),($4,$5)", [f.school, f.author, f.colleague, f.otherSchool, f.outsider]);
  await client.query("INSERT INTO groups VALUES($1,$2),($3,$4)", [f.group, f.school, f.otherGroup, f.otherSchool]);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function chart(f: Fixture, request = randomUUID(), author = f.author, current = false) {
  return (await client.query<{ id: string }>(`INSERT INTO mydesk_seating_charts(school_id,author_id,client_request_id,request_fingerprint,
    group_id,filing_group_id,group_name,name,roster_revision,is_current) VALUES($1,$2,$3,$4,$5,$5,'Science snapshot','Front rows',$4,$6) RETURNING id`,
  [f.school, author, request, hash, f.group, current])).rows[0]!.id;
}

test("seating migration replays and repairs bootstrap FKs without losing typed columns or defaults", async () => {
  await client.query(`ALTER TABLE mydesk_seating_charts DROP CONSTRAINT mydesk_seating_charts_group_fk;
    ALTER TABLE mydesk_seating_charts ADD CONSTRAINT mydesk_seating_charts_group_fk FOREIGN KEY(school_id,group_id) REFERENCES groups(school_id,id)`);
  await client.query(MYDESK_SEATING_SQL);
  assert.equal(mydeskSeatingMigration.checksum, createHash("sha256").update(MYDESK_SEATING_SQL).digest("hex"));
  const columns = await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='mydesk_seating_charts'", [schema]);
  assert.deepEqual(columns.rows.map(row => row.column_name).sort(), Object.values(getTableColumns(mydeskSeatingCharts)).map(column => column.name).sort());
  const fk = await client.query<{ definition: string }>("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='mydesk_seating_charts'::regclass AND conname='mydesk_seating_charts_group_fk'");
  assert.ok(fk.rows[0]!.definition.endsWith("ON DELETE SET NULL (group_id)"));
  const f = await fixture(), id = await chart(f);
  const defaults = await client.query("SELECT layout,roster_snapshot,mutation_receipts,revision,is_current FROM mydesk_seating_charts WHERE id=$1", [id]);
  assert.deepEqual(defaults.rows[0], { layout: { version: 1, seats: [] }, roster_snapshot: [], mutation_receipts: [], revision: 1, is_current: false });
});

test("create request deduplication and one current chart are scoped to each author and class", async () => {
  const f = await fixture(), request = randomUUID(); await chart(f, request, f.author, true);
  await assert.rejects(chart(f, request), { code: "23505" });
  await assert.rejects(chart(f, randomUUID(), f.author, true), { code: "23505" });
  assert.ok(await chart(f, request, f.colleague, true));
  assert.ok(await chart(f));
});

test("cross-school group/author references fail and deleted live classes preserve private snapshots", async () => {
  const f = await fixture(), id = await chart(f);
  await assert.rejects(chart(f, randomUUID(), f.outsider), { code: "23514" });
  await assert.rejects(client.query("UPDATE mydesk_seating_charts SET group_id=$2 WHERE id=$1", [id, f.otherGroup]), { code: "23503" });
  await client.query("UPDATE mydesk_seating_charts SET roster_snapshot=$2::jsonb WHERE id=$1", [id, JSON.stringify([{ id: randomUUID(), name: "Saved student" }])]);
  await client.query("DELETE FROM groups WHERE id=$1", [f.group]);
  const row = (await client.query("SELECT school_id,group_id,filing_group_id,group_name,roster_snapshot FROM mydesk_seating_charts WHERE id=$1", [id])).rows[0];
  assert.equal(row.school_id, f.school); assert.equal(row.group_id, null); assert.equal(row.filing_group_id, f.group);
  assert.equal(row.group_name, "Science snapshot"); assert.equal(row.roster_snapshot[0].name, "Saved student");
});

test("database bounds layouts and operational receipts and requires atomic private-content scrubbing", async () => {
  const f = await fixture(), id = await chart(f, randomUUID(), f.author, true);
  for (const layout of [{ seats: [] }, { version: 1, seats: {} }, { version: 1, seats: Array.from({ length: 101 }, () => ({})) }]) {
    await assert.rejects(client.query("UPDATE mydesk_seating_charts SET layout=$2::jsonb WHERE id=$1", [id, JSON.stringify(layout)]), { code: "23514" });
  }
  await assert.rejects(client.query("UPDATE mydesk_seating_charts SET roster_snapshot=$2::jsonb WHERE id=$1", [id, JSON.stringify(Array.from({ length: 1001 }, () => ({ id: randomUUID(), name: "Saved student" })))]), { code: "23514" });
  await assert.rejects(client.query("UPDATE mydesk_seating_charts SET roster_snapshot=$2::jsonb WHERE id=$1", [id, JSON.stringify([{ id: randomUUID(), name: "x".repeat(1048576) }])]), { code: "23514" });
  await assert.rejects(client.query("UPDATE mydesk_seating_charts SET group_name=$2 WHERE id=$1", [id, "x".repeat(501)]), { code: "23514" });
  for (const name of ["", "x".repeat(121)]) await assert.rejects(client.query("UPDATE mydesk_seating_charts SET name=$2 WHERE id=$1", [id, name]), { code: "23514" });
  await assert.rejects(client.query("UPDATE mydesk_seating_charts SET roster_revision='invalid' WHERE id=$1", [id]), { code: "23514" });
  const receipt = { id: randomUUID(), fingerprint: hash, revision: 1, kind: "update" };
  await client.query("UPDATE mydesk_seating_charts SET mutation_receipts=$2::jsonb WHERE id=$1", [id, JSON.stringify(Array.from({ length: 100 }, () => receipt))]);
  await assert.rejects(client.query("UPDATE mydesk_seating_charts SET mutation_receipts=$2::jsonb WHERE id=$1", [id, JSON.stringify(Array.from({ length: 101 }, () => receipt))]), { code: "23514" });
  await assert.rejects(client.query("UPDATE mydesk_seating_charts SET deleted_at=now() WHERE id=$1", [id]), { code: "23514" });
  await client.query(`UPDATE mydesk_seating_charts SET deleted_at=now(),is_current=false,group_id=NULL,name='',group_name='',
    layout='{"version":1,"seats":[]}'::jsonb,roster_snapshot='[]'::jsonb,roster_revision='' WHERE id=$1`, [id]);
  assert.ok(await chart(f, randomUUID(), f.author, true), "deletion releases only this author's current slot");
});

test("forced tenant RLS denies unscoped reads and cross-school writes by a non-owner role", async () => {
  const f = await fixture(), id = await chart(f);
  const catalog = await client.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='mydesk_seating_charts'::regclass");
  assert.deepEqual(catalog.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  await client.query(`SET ROLE ${role}`);
  try {
    await client.query("SELECT set_config('app.school_id','',false),set_config('app.is_super','off',false)");
    assert.equal((await client.query("SELECT id FROM mydesk_seating_charts")).rowCount, 0);
    await client.query("SELECT set_config('app.school_id',$1,false)", [f.school]);
    assert.equal((await client.query("SELECT id FROM mydesk_seating_charts WHERE id=$1", [id])).rowCount, 1);
    await client.query("SELECT set_config('app.school_id',$1,false)", [f.otherSchool]);
    assert.equal((await client.query("SELECT id FROM mydesk_seating_charts WHERE id=$1", [id])).rowCount, 0);
    await assert.rejects(chart(f), { code: "42501" });
  } finally { await client.query("RESET ROLE"); await client.query("SET app.is_super='on'"); }
});
