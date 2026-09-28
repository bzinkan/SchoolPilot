import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableColumns } from "drizzle-orm";
import pg from "pg";
import * as schema from "../src/schema/index.js";
import { IMPORT_PROCESSING_STAGES_SQL, importProcessingStagesMigration } from "../src/db/importProcessingStagesMigration.js";
import { schoolPilot27ExpandMigrations } from "../src/db/migrations27.js";
import { runSchoolPilotMigrationLedger } from "../src/db/migrationLedger.js";
import { withDurableImportStage, cancelImportProcessingStages, invalidateImportItemStages, reconcileImportStageCheckpoint, type ImportStageOptions } from "../src/services/importProcessingStages.js";
import { snapshotRuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";

const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
const fixture = `stages_${suffix}`, role = `stages_rls_${suffix}`;
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max:4, options:`-c search_path=${fixture} -c app.is_super=on` });
const database = drizzle(pool,{schema});
const actor = {schoolId:randomUUID(),authorId:randomUUID()};
const other = {schoolId:randomUUID(),authorId:randomUUID()};
const delay = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
const latch = () => { let release!:()=>void; const promise = new Promise<void>(resolve=>{release=resolve;}); return {promise,release}; };
async function run(kind:ImportStageOptions["kind"]="paperwork", owner=actor) {
  const id=randomUUID(),lease=randomUUID();
  const table=kind==="paperwork"?"mydesk_imports":"student_information_imports";
  await pool.query(`INSERT INTO ${table}(id,school_id,author_id,status,lease_id,lease_until,expires_at,processing_version) VALUES($1,$2,$3,'processing',$4,now()+interval '5 minutes',now()+interval '7 days',2)`,[id,owner.schoolId,owner.authorId,lease]);
  return {runId:id,kind,parentLeaseId:lease,generation:1,provider:true,stageKey:"detect:page1",database};
}

before(async()=>{
  assert.ok(["localhost","127.0.0.1","::1"].includes(new URL(process.env.DATABASE_URL || "").hostname),"Only local fixture databases are allowed");
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${fixture}; SET search_path TO ${fixture};
    CREATE TABLE schools(id TEXT PRIMARY KEY); CREATE TABLE users(id VARCHAR PRIMARY KEY);
    CREATE TABLE mydesk_imports(id VARCHAR PRIMARY KEY,school_id TEXT NOT NULL,author_id VARCHAR NOT NULL,status TEXT NOT NULL,lease_id UUID,lease_until TIMESTAMPTZ,expires_at TIMESTAMPTZ NOT NULL,deleted_at TIMESTAMPTZ,UNIQUE(school_id,author_id,id));
    CREATE TABLE student_information_imports(LIKE mydesk_imports INCLUDING ALL);
    ALTER TABLE student_information_imports DROP COLUMN deleted_at;
    CREATE TABLE mydesk_import_items(id VARCHAR PRIMARY KEY);`);
  for(const owner of [actor,other]) {
    await admin.query("INSERT INTO schools VALUES($1)",[owner.schoolId]);
    await admin.query("INSERT INTO users VALUES($1)",[owner.authorId]);
  }
  const applied=await runSchoolPilotMigrationLedger({pool,migrations:[importProcessingStagesMigration],applicationSha:"fixture"});
  assert.equal(applied[0]?.status,"applied");
});
after(async()=>{
  await pool.end();
  await admin.query("RESET ROLE");
  await admin.query(`DROP SCHEMA IF EXISTS ${fixture} CASCADE; DROP ROLE IF EXISTS ${role}`);
  await admin.end();
});

test("ledger migration matches typed schema, skips replay, and retains legacy packet defaults",async()=>{
  const opts=await run();
  await pool.query("UPDATE mydesk_imports SET processing_version=DEFAULT,status='queued' WHERE id=$1",[opts.runId]);
  const row=(await pool.query("SELECT processing_version,progress_revision FROM mydesk_imports WHERE id=$1",[opts.runId])).rows[0];
  assert.deepEqual(row,{processing_version:1,progress_revision:1});
  const columns=(await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='import_processing_stages'",[fixture])).rows.map(r=>r.column_name).sort();
  assert.deepEqual(columns,Object.values(getTableColumns(schema.importProcessingStages)).map(c=>c.name).sort());
  assert.equal(importProcessingStagesMigration.checksum,createHash("sha256").update(IMPORT_PROCESSING_STAGES_SQL).digest("hex"));
  assert.ok(schoolPilot27ExpandMigrations.some(m=>m.id===importProcessingStagesMigration.id));
  const retry=await runSchoolPilotMigrationLedger({pool,migrations:[importProcessingStagesMigration],applicationSha:"later"});
  assert.equal(retry[0]?.status,"skipped");
  await assert.rejects(pool.query("UPDATE mydesk_imports SET processing_version=3 WHERE id=$1",[opts.runId]),{code:"23514"});
  await pool.query("INSERT INTO mydesk_import_items(id,document_order) VALUES('order',999)");
  await assert.rejects(pool.query("UPDATE mydesk_import_items SET document_order=1000"),{code:"23514"});
});

test("provider admission caps paperwork and contacts together and frees slots without waiting for siblings",async()=>{
  const paper=await run(),contact=await run("student-information");
  const first=latch(),second=latch(),third=latch();
  let active=0,peak=0;
  const starts:string[]=[];
  const task=(options:ImportStageOptions,key:string,gate:ReturnType<typeof latch>)=>withDurableImportStage(actor,{...options,stageKey:key},async(_signal,fence)=>{
    active++;peak=Math.max(peak,active);starts.push(key);
    assert.equal(pool.waitingCount,0);
    await gate.promise;
    await database.transaction(tx=>fence(tx));
    active--;return key;
  });
  const a=task(paper,"detect:a",first),b=task(paper,"detect:b",second);
  while(starts.length<2) await delay(10);
  const c=task(contact,"extract:c",third);
  await delay(300);assert.equal(starts.length,2);
  first.release();await a;
  while(starts.length<3) await delay(10);
  assert.equal(active,2,"The freed slot admits the waiting contact while the other paperwork call remains active");
  assert.equal(peak,2);
  second.release();third.release();
  await Promise.all([b,c]);
  assert.equal((await pool.query("SELECT count(*)::int count FROM import_processing_stages WHERE lease_until>now()")).rows[0].count,0);
});

test("a draining legacy worker reserves a global provider slot during the rolling upgrade",async()=>{
  const legacy=await run(),modern=await run("student-information");
  await pool.query("UPDATE mydesk_imports SET processing_version=1 WHERE id=$1",[legacy.runId]);
  const entered=latch(),finish=latch();let secondStarted=false;
  const first=withDurableImportStage(actor,modern,async()=>{entered.release();await finish.promise;return 1;});
  await entered.promise;
  const second=withDurableImportStage(actor,{...modern,stageKey:"extract:second"},async()=>{secondStarted=true;return 2;});
  await delay(300);assert.equal(secondStarted,false);
  await pool.query("UPDATE mydesk_imports SET status='review',lease_id=NULL,lease_until=NULL WHERE id=$1",[legacy.runId]);
  while(!secondStarted) await delay(10);
  finish.release();await Promise.all([first,second]);
});

test("completed checkpoints skip work and failed stages retain independent bounded retry attempts",async()=>{
  snapshotRuntimePerformanceMetrics({reset:true});
  const options=await run();let calls=0;
  const work=async()=>{calls++;return "done";};
  assert.equal((await withDurableImportStage(actor,options,work)).status,"completed");
  assert.equal((await withDurableImportStage(actor,options,work)).status,"skipped");
  assert.equal(calls,1);
  for(let attempt=1;attempt<=3;attempt++) {
    const result=await withDurableImportStage(actor,{...options,stageKey:"extract:retry"},async()=>{throw Object.assign(new Error("synthetic"),{code:"PROVIDER_TIMEOUT"});});
    assert.equal(result.status,attempt===3?"failed":"retry");
    const row=(await pool.query("SELECT attempts,last_error_code,next_attempt_at FROM import_processing_stages WHERE import_id=$1 AND stage_key='extract:retry'",[options.runId])).rows[0];
    assert.equal(row.attempts,attempt);assert.equal(row.last_error_code,"PROVIDER_TIMEOUT");
    await pool.query("UPDATE import_processing_stages SET next_attempt_at=now()-interval '1 second' WHERE import_id=$1",[options.runId]);
  }
  const exhausted=await withDurableImportStage(actor,{...options,stageKey:"extract:retry"},work);
  assert.equal(exhausted.status,"failed");assert.equal(calls,1);
  const legacy=await withDurableImportStage(actor,{...options,stageKey:"detect:legacy",initialAttempts:3},work);
  assert.equal(legacy.status,"failed");assert.equal(calls,1);
  const metrics=snapshotRuntimePerformanceMetrics({reset:true});
  assert.equal(metrics.counters.importStageCompleted,1);
  assert.equal(metrics.counters.importStageRetry,2);
  assert.equal(metrics.counters.importStageFailed,1);
  assert.equal(metrics.timings.importStageAdmissionMs?.count,4);
  assert.equal(metrics.timings.importDetectionMs?.count,1);
  assert.equal(metrics.timings.importExtractionMs?.count,3);
  assert.ok((metrics.timings.importExtractionMs?.totalMs ?? 0)>0);
});

test("cancellation fences evidence writes and holds provider ownership until the transport settles",async()=>{
  const options=await run();const entered=latch(),finish=latch();
  const pending=withDurableImportStage(actor,options,async(_signal,fence)=>{entered.release();await finish.promise;await database.transaction(tx=>fence(tx));return "late";});
  const rejected=assert.rejects(pending,{code:"MYDESK_IMPORT_JOB_CANCELLED"});
  await entered.promise;
  await database.transaction(tx=>cancelImportProcessingStages(tx,actor,options.runId));
  const row=(await pool.query("SELECT status,lease_until>now() AS held FROM import_processing_stages WHERE import_id=$1",[options.runId])).rows[0];
  assert.deepEqual(row,{status:"cancelled",held:true});
  finish.release();await rejected;
  assert.equal((await pool.query("SELECT lease_until FROM import_processing_stages WHERE import_id=$1",[options.runId])).rows[0].lease_until,null);
});

test("worker shutdown leaves a retryable checkpoint, while invalid input fails without three provider calls",async()=>{
  const options=await run(),controller=new AbortController();
  const result=await withDurableImportStage(actor,{...options,signal:controller.signal},async(signal)=>{
    controller.abort();
    signal.throwIfAborted();
  });
  assert.equal(result.status,"retry");
  const row=(await pool.query("SELECT status,attempts FROM import_processing_stages WHERE import_id=$1",[options.runId])).rows[0];
  assert.deepEqual(row,{status:"retry",attempts:1});
  const invalid=await withDurableImportStage(actor,{...options,stageKey:"detect:invalid"},async()=>{
    throw Object.assign(new Error("synthetic invalid input"),{code:"FORM_LIMIT",retryable:false});
  });
  assert.equal(invalid.status,"failed");
  assert.equal((await pool.query("SELECT attempts FROM import_processing_stages WHERE import_id=$1 AND stage_key='detect:invalid'",[options.runId])).rows[0].attempts,1);
});

test("shutdown while a stage claim commits prevents its provider callback from starting", async () => {
  const options = await run(), controller = new AbortController();
  let started = false;
  const abortAfterClaim = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof database.transaction>) => {
        const result = await target.transaction(...args);
        if (result && typeof result === "object" && "status" in result && result.status === "claimed") controller.abort();
        return result;
      };
    },
  });
  const result = await withDurableImportStage(actor, { ...options, database: abortAfterClaim, signal: controller.signal }, async () => {
    started = true;
  });
  assert.equal(result.status, "retry");
  assert.equal(started, false);
  const row = (await pool.query("SELECT status, lease_until FROM import_processing_stages WHERE import_id=$1", [options.runId])).rows[0];
  assert.deepEqual(row, { status: "retry", lease_until: null });
});

test("expired stage tokens cannot write and changed geometry supersedes only that item's generations",async()=>{
  const options=await run();
  await assert.rejects(withDurableImportStage(actor,options,async(_signal,fence)=>{
    await pool.query("UPDATE import_processing_stages SET request_deadline=now()-interval '1 second' WHERE import_id=$1",[options.runId]);
    await database.transaction(tx=>fence(tx));
  }),{code:"MYDESK_IMPORT_JOB_CANCELLED"});
  const item={...options,stageKey:"extract:item"};
  await withDurableImportStage(actor,item,async()=>1);
  await database.transaction(tx=>invalidateImportItemStages(tx,actor,options.runId,"item"));
  assert.equal((await withDurableImportStage(actor,{...item,generation:2},async()=>2)).status,"completed");
  const rows=(await pool.query("SELECT generation,status FROM import_processing_stages WHERE import_id=$1 AND stage_key='extract:item' ORDER BY generation",[options.runId])).rows;
  assert.deepEqual(rows,[{generation:1,status:"cancelled"},{generation:2,status:"completed"}]);
});

test("stage ownership FKs and forced tenant policies prevent cross-school/author attachment",async()=>{
  const options=await run();
  const insert="INSERT INTO import_processing_stages(school_id,author_id,kind,import_id,paperwork_import_id,stage_key,generation,provider) VALUES($1,$2,'paperwork',$3,$3,'detect:scope',1,true)";
  await assert.rejects(pool.query(insert,[other.schoolId,other.authorId,options.runId]),{code:"23503"});
  await assert.rejects(pool.query(insert,[actor.schoolId,other.authorId,options.runId]),{code:"23503"});
  await assert.rejects(pool.query("INSERT INTO import_processing_stages(school_id,author_id,kind,import_id,stage_key,generation,provider) VALUES($1,$2,'paperwork',$3,'detect:none',1,true)",[actor.schoolId,actor.authorId,options.runId]),{code:"23514"});
  await pool.query(insert,[actor.schoolId,actor.authorId,options.runId]);
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA ${fixture} TO ${role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${fixture} TO ${role}; SET ROLE ${role}`);
  try {
    await admin.query("SELECT set_config('app.is_super','off',false),set_config('app.school_id','',false)");
    assert.equal((await admin.query("SELECT id FROM import_processing_stages")).rowCount,0);
    await admin.query("SELECT set_config('app.school_id',$1,false)",[other.schoolId]);
    assert.equal((await admin.query("SELECT id FROM import_processing_stages")).rowCount,0);
    await assert.rejects(admin.query(insert,[actor.schoolId,actor.authorId,options.runId]),{code:"42501"});
    await admin.query("SELECT set_config('app.school_id',$1,false)",[actor.schoolId]);
    assert.ok((await admin.query("SELECT id FROM import_processing_stages")).rowCount!>0);
  } finally {await admin.query("RESET ROLE");}
});

test("proven domain checkpoints reconcile interrupted completion without reviving cancelled generations",async()=>{
  const options=await run();
  await withDurableImportStage(actor,options,async()=>{throw Object.assign(new Error("synthetic after checkpoint interruption"),{code:"CONNECTION_LOST"});});
  await database.transaction(tx=>reconcileImportStageCheckpoint(tx,actor,{...options,maxGeneration:1}));
  assert.equal((await withDurableImportStage(actor,options,async()=>"must not run")).status,"skipped");
  await assert.rejects(database.transaction(tx=>reconcileImportStageCheckpoint(tx,other,{...options,maxGeneration:1})),{code:"MYDESK_IMPORT_JOB_CANCELLED"});
  await pool.query("UPDATE import_processing_stages SET status='cancelled' WHERE import_id=$1",[options.runId]);
  await database.transaction(tx=>reconcileImportStageCheckpoint(tx,actor,{...options,maxGeneration:1}));
  assert.equal((await pool.query("SELECT status FROM import_processing_stages WHERE import_id=$1",[options.runId])).rows[0].status,"cancelled");
});
