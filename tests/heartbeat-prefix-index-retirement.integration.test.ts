import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import type { HeartbeatPrefixIndexExecutor } from "../src/db/heartbeatPrefixIndexRetirement.js";

const connectionString=process.env.HEARTBEAT_PREFIX_INDEX_TEST_DATABASE_URL;
const candidates=["heartbeats_student_id_idx","heartbeats_student_email_idx"];

function executor(client: Pick<pg.PoolClient,"query">): HeartbeatPrefixIndexExecutor {
  return { query: async (text,values) => { const result=await client.query(text,values); return {rows:result.rows}; } };
}

test("native heartbeat prefix-index retirement preserves rows and rejects unexpected catalog states", {skip:!connectionString,timeout:45000}, async t => {
  assert.ok(connectionString);
  const url=new URL(connectionString);
  assert.ok(["postgres:","postgresql:"].includes(url.protocol));
  assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname));
  assert.ok(["5432","5435"].includes(url.port) && !url.search && !url.hash);
  const matched=/^\/schoolpilot_heartbeat_prefix_index_([a-f0-9]{12})$/.exec(url.pathname);
  assert.ok(matched,"An explicitly owned empty index fixture is required");
  const marker=`schoolpilot:heartbeat-prefix-index-test:${matched[1]}`;
  assert.equal(process.env.HEARTBEAT_PREFIX_INDEX_TEST_OWNERSHIP,marker);
  const pool=new pg.Pool({connectionString,max:3,connectionTimeoutMillis:5000,statement_timeout:15000,options:"-c lock_timeout=2000"});
  const client=await pool.connect().catch(async error => { await pool.end(); throw error; });
  const owned=async () => {
    const row=(await client.query(`SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker
      FROM pg_database WHERE datname=current_database()`)).rows[0];
    assert.equal(row?.name,url.pathname.slice(1)); assert.equal(row?.marker,marker);
  };
  try {
    await owned();
    const existing=await client.query(`SELECT count(*)::int AS count FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','i','I','S')`);
    assert.equal(existing.rows[0]?.count,0,"Never change an existing populated/schema-bearing database");
    const {retireHeartbeatPrefixIndexesOnline:retire}=await import("../dist/db/heartbeatPrefixIndexRetirement.js");
    const {heartbeatPrefixIndexRetirementMigration:migration}=await import("../dist/db/heartbeatPrefixIndexRetirementMigration.js");
    const {runSchoolPilotMigrationLedger}=await import("../dist/db/migrationLedger.js");
    await client.query(`CREATE TABLE public.heartbeats(id text PRIMARY KEY,school_id text,device_id text,student_id text,student_email text,"timestamp" timestamp NOT NULL,payload text);
      INSERT INTO public.heartbeats VALUES
        ('one','school','device-a','student-a','first@example.invalid','2026-11-01 15:00:00','retained-one'),
        ('two','school','device-a','student-a','first@example.invalid','2026-11-01 15:00:10','retained-two'),
        ('three','school','device-b','student-b',NULL,'2026-11-01 15:00:20','retained-three'),
        ('four','school','device-c',NULL,'legacy@example.invalid','2026-11-01 15:00:30','retained-four');
      CREATE INDEX heartbeats_student_id_idx ON public.heartbeats(student_id);
      CREATE INDEX heartbeats_student_email_idx ON public.heartbeats(student_email);
      CREATE INDEX heartbeats_student_timestamp_idx ON public.heartbeats(student_id,"timestamp");
      CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(student_email,"timestamp");
      CREATE INDEX heartbeats_school_timestamp_idx ON public.heartbeats(school_id,"timestamp" DESC);
      CREATE INDEX heartbeats_school_device_timestamp_idx ON public.heartbeats(school_id,device_id,"timestamp" DESC);
      CREATE INDEX heartbeats_school_device_student_timestamp_idx ON public.heartbeats(school_id,device_id,student_id,"timestamp" DESC)`);
    const rows=async () => (await client.query('SELECT id,school_id,device_id,student_id,student_email,"timestamp"::text,payload FROM public.heartbeats ORDER BY id')).rows;
    const indexes=async () => (await client.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='heartbeats' ORDER BY indexname")).rows;
    const beforeRows=await rows(), beforeIndexes=await indexes();
    await t.test("the real nontransactional ledger performs only the two concurrent retirements",async () => {
      await owned();
      const result=await runSchoolPilotMigrationLedger({pool,migrations:[migration],applicationSha:"native-heartbeat-index-fixture"});
      assert.equal(result[0]?.status,"applied");
      assert.deepEqual(await rows(),beforeRows);
      assert.deepEqual(await indexes(),beforeIndexes.filter(row=>!candidates.includes(row.indexname)));
      assert.deepEqual((await client.query("SELECT id FROM public.heartbeats WHERE student_id='student-a' ORDER BY timestamp DESC")).rows,[{id:"two"},{id:"one"}]);
      assert.deepEqual((await client.query("SELECT id FROM public.heartbeats WHERE student_email IS NULL ORDER BY timestamp DESC")).rows,[{id:"three"}]);
      await retire(executor(client));
      const rerun=await runSchoolPilotMigrationLedger({pool,migrations:[migration],applicationSha:"native-heartbeat-index-fixture"});
      assert.equal(rerun[0]?.status,"skipped"); assert.deepEqual(await rows(),beforeRows);
    });

    await client.query(`CREATE INDEX heartbeats_student_id_idx ON public.heartbeats(student_id);
      CREATE INDEX heartbeats_student_email_idx ON public.heartbeats(student_email)`);
    const intact=async () => {
      const names=(await indexes()).map(row=>row.indexname);
      for (const name of candidates) assert.ok(names.includes(name),"the first candidate must survive an unexpected second definition");
      assert.deepEqual(await rows(),beforeRows);
      assert.equal((await client.query("SHOW statement_timeout")).rows[0]?.statement_timeout,"15s");
      assert.equal((await client.query("SHOW lock_timeout")).rows[0]?.lock_timeout,"2s");
    };
    const badReplacements: Array<[string,string]>=[
      ["reversed keys",'CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats("timestamp",student_email)'],
      ["partial predicate",'CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(student_email,"timestamp") WHERE student_email IS NOT NULL'],
      ["expression",'CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(lower(student_email),"timestamp")'],
      ["INCLUDE column",'CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(student_email,"timestamp") INCLUDE(id)'],
      ["nondefault operator class",'CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(student_email text_pattern_ops,"timestamp")'],
      ["nondefault collation",'CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(student_email COLLATE "C","timestamp")'],
      ["different null/sort order",'CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(student_email DESC NULLS FIRST,"timestamp")'],
      ["unique replacement",'CREATE UNIQUE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(student_email,"timestamp")'],
    ];
    for (const [label,sql] of badReplacements) await t.test(`native preflight rejects ${label} before either drop`,async () => {
      await owned();
      await client.query("DROP INDEX public.heartbeats_email_timestamp_idx");
      await client.query(sql);
      await assert.rejects(retire(executor(client)));
      await intact();
      await client.query('DROP INDEX public.heartbeats_email_timestamp_idx; CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(student_email,"timestamp")');
    });
    await t.test("a same-named table is rejected instead of being treated as an absent candidate",async () => {
      await owned();
      await client.query("DROP INDEX public.heartbeats_student_email_idx; CREATE TABLE public.heartbeats_student_email_idx(id integer)");
      await assert.rejects(retire(executor(client)));
      assert.ok((await indexes()).some(row=>row.indexname===candidates[0]));
      assert.deepEqual(await rows(),beforeRows);
      await client.query("DROP TABLE public.heartbeats_student_email_idx; CREATE INDEX heartbeats_student_email_idx ON public.heartbeats(student_email)");
    });
    await t.test("a correctly named candidate on another table cannot authorize the first drop",async () => {
      await owned();
      await client.query("DROP INDEX public.heartbeats_student_email_idx; CREATE TABLE public.decoy(student_email text); CREATE INDEX heartbeats_student_email_idx ON public.decoy(student_email)");
      await assert.rejects(retire(executor(client)));
      assert.ok((await indexes()).some(row=>row.indexname===candidates[0]));
      assert.deepEqual(await rows(),beforeRows);
      await client.query("DROP INDEX public.heartbeats_student_email_idx; DROP TABLE public.decoy; CREATE INDEX heartbeats_student_email_idx ON public.heartbeats(student_email)");
    });
    await t.test("absent candidates still require every valid replacement",async () => {
      await owned();
      await retire(executor(client));
      await client.query("DROP INDEX public.heartbeats_email_timestamp_idx");
      await assert.rejects(retire(executor(client)),/replacement|missing/i);
      assert.deepEqual(await rows(),beforeRows);
      await client.query('CREATE INDEX heartbeats_email_timestamp_idx ON public.heartbeats(student_email,"timestamp")');
      await retire(executor(client));
      assert.deepEqual(await indexes(),beforeIndexes.filter(row=>!candidates.includes(row.indexname)));
    });
  } finally { client.release(); await pool.end(); }
});
