import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { schedulerPool, schedulerLockPool } from '/app/dist/services/schedulerDb.js';
import { createImportAiProcessor, MYDESK_IMPORT_PROMPT_VERSION } from '/app/dist/services/mydeskImportProcessing.js';
import { after, before, test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { createApp } from "/app/dist/app.js";
import pg from "pg";
import { z } from "zod";
import { pool, sessionPool } from "/app/dist/db.js";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "/app/dist/schema/index.js";
import sharp from "sharp";
import { myDeskObjectStore, myDeskSha256, } from "/app/dist/services/mydeskFiles.js";
import { runMyDeskImportJobs, } from "/app/dist/services/mydeskImportWorker.js";
import { cleanupMyDeskImports } from "/app/dist/services/mydeskImportCleanup.js";
import { renderImportSource, cropImportRegion, buildImportAttachment, MyDeskImportProcessingError, } from "/app/dist/services/mydeskImportProcessing.js";
import { importRegion } from "/app/dist/services/mydeskImportsValidation.js";
import { signUserToken } from "/app/dist/services/jwt.js";
import { createReadProbeEvidence, measureReadProbe, nearestRankPercentile } from './latency-metrics.mjs';
const schoolIds = [];
// Fixtures and DDL use the administrator connection; real HTTP handlers keep the restricted application pool.
const fixturePool = process.env.ADMIN_DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2 })
    : pool;
const fixtureDb = drizzle(fixturePool, { schema });
class PhysicalObjects extends Map {
    filename(key) { return '/app/evidence/split-objects/' + createHash('sha256').update(key).digest('hex'); }
    set(key, bytes) { writeFileSync(this.filename(key), bytes); return super.set(key, bytes.length); }
    get(key) { return this.has(key) ? readFileSync(this.filename(key)) : undefined; }
    has(key) { return existsSync(this.filename(key)); }
    delete(key) { if (existsSync(this.filename(key)))
        unlinkSync(this.filename(key)); return super.delete(key); }
}
mkdirSync('/app/evidence/split-objects', { recursive: true });
const objects = new PhysicalObjects();
const originalObjectStore = { ...myDeskObjectStore };
const metrics = { imageDigest: process.env.EVIDENCE_IMAGE_DIGEST, testSourceSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    measurementSourceSha256: createHash('sha256').update(readFileSync(new URL('./latency-metrics.mjs', import.meta.url))).digest('hex'),
    sourceRevision: process.env.EVIDENCE_SOURCE_REVISION, formatVersion: 2,
    providerMode: 'synthetic_transport', storageMode: 'physical_local_files', auth: 'ephemeral_local_jwt',
    database: 'disposable_local_postgres_restricted_rls', humanAcceptance: 'not_performed',
    limits: { cpu: Number(process.env.EVIDENCE_CPU), memoryBytes: Number(process.env.EVIDENCE_MEMORY) },
    memorySamples: 0, peakCgroupMemoryBytes: 0, peakRssBytes: 0, apiTimingsMs: [], statusCounts: {},
    readProbeEvidence: createReadProbeEvidence(),
    providerRequests: 0, workerRuns: 0, maxClaimedPerRunner: 0, maxQueueObserved: 0, cpu: null,
    limitations: ['Synthetic API behavior is not human acceptance.', 'Local isolated latency is not production API capacity.', 'Provider transport and object storage are synthetic/local; live provider timing and managed storage latency require separate evidence.', 'Inherited Docker localhost:4000 healthchecks do not apply to this ephemeral-port API/3999 worker harness; actual API pool/readiness and worker scheduler probes are evaluated separately.'] };
const metricStart = performance.now(), cpuStart = process.cpuUsage();
const sample = () => {
    metrics.memorySamples++;
    metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss);
    try {
        const current = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
        if (!Number.isFinite(current) || current <= 0) throw Error('MEMORY_UNAVAILABLE');
        metrics.peakCgroupMemoryBytes = Math.max(metrics.peakCgroupMemoryBytes, current);
    }
    catch {
        metrics.splitAbort = { code: 'MEMORY_UNAVAILABLE' };
        writeFileSync('/app/evidence/split-metrics.json', JSON.stringify(metrics, null, 2));
        process.exit(86);
    }
};
const sampler = setInterval(() => { sample(); if(metrics.peakCgroupMemoryBytes >= Number(process.env.EVIDENCE_MEMORY)*.85) { metrics.capacity={status:'aborted',failure:'MEMORY_85_PERCENT'}; writeFileSync('/app/evidence/split-metrics.json',JSON.stringify(metrics,null,2)); process.exit(86); } }, 100);
sampler.unref();
sample();
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
    const start = performance.now();
    const response = await realFetch(...args);
    if (String(args[0]).startsWith('http://127.0.0.1:')) {
        if (metrics.apiTimingsMs.length >= 4096) throw new Error('LATENCY_SAMPLE_LIMIT');
        metrics.apiTimingsMs.push(performance.now() - start);
        metrics.statusCounts[response.status] = (metrics.statusCounts[response.status] || 0) + 1;
    }
    return response;
};
const deletedKeys = [];
const assetSchema = z
    .object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    contentType: z.string().nullable(),
    pageCount: z.number().nullable(),
    parentAssetId: z.string().nullable(),
    pageNumber: z.number().nullable(),
})
    .passthrough();
const itemSchema = z.object({
    id: z.string(),
    ordinal: z.number(),
    revision: z.number(),
    regions: z.array(importRegion),
    subjectNames: z.array(z.string()),
    groupId: z.string().nullable(),
    studentId: z.string().nullable(),
    rosterRevision: z.string().nullable(),
    category: z.string(),
    title: z.string(),
    body: z.string(),
    entryDate: z.string().nullable(),
    warnings: z.array(z.string()),
    reviewed: z.boolean(),
    excluded: z.boolean(),
    extractionStatus: z.string(),
    approvedAssetId: z.string().nullable(),
    noteId: z.string().nullable(),
    disciplineFields: z.object({ referral: z.boolean(), detentionAssignment: z.object({ dates: z.array(z.string()) }).passthrough().nullable() }).nullable(),
    disciplineRecordId: z.string().nullable(),
});
const runSchema = z.object({
    id: z.string(),
    status: z.string(),
    destination: z.enum(["notes", "discipline"]),
    revision: z.number(),
    processingVersion: z.number(),
    selectedGroupIds: z.array(z.string()),
    pageDecisions: z.array(z.object({ assetId: z.string(), excluded: z.boolean() })),
    expiresAt: z.string(),
    uploadExpiresAt: z.string(),
    pageCount: z.number(),
    attempts: z.number(),
    lastErrorCode: z.string().nullable(),
    assets: z.array(assetSchema),
    items: z.array(itemSchema),
    commitReceipt: z
        .object({
        notes: z.array(z.object({ itemId: z.string(), noteId: z.string() })),
        records: z.array(z.object({ itemId: z.string(), recordId: z.string() })).optional(),
    })
        .nullable(),
});
const runEnvelope = z.object({ import: runSchema });
let photo;
let server, baseUrl;
before(async () => {
    process.env.MYDESK_MODE = "on";
    process.env.MYDESK_SEATING_MODE = "on";
    process.env.MYDESK_AI_IMPORT_MODE = "on";
    assert.equal(process.env.MYDESK_IMPORT_PIPELINE_VERSION, "2");
    assert.equal(process.env.MYDESK_IMPORT_PIPELINE_WIDTH, "2");
    assert.equal(process.env.STUDENT_INFORMATION_AI_IMPORT_MODE, "off");
    assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
    if (process.env.ADMIN_DATABASE_URL)
        assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.ADMIN_DATABASE_URL).hostname));
    if (process.env.PAPERWORK_LIVE_PROVIDER === '1' && process.env.PAPERWORK_SCENARIO !== 'integrated')
        throw new Error('Live provider is reserved for integrated-only mode.');
    photo = await sharp({
        create: { width: 800, height: 1000, channels: 3, background: "white" },
    })
        .jpeg()
        .toBuffer();
    mock.method(myDeskObjectStore, "put", async (key, bytes) => {
        objects.set(key, Buffer.from(bytes));
    });
    mock.method(myDeskObjectStore, "get", async (key) => {
        const bytes = objects.get(key);
        if (!bytes)
            throw new Error("fixture object missing");
        return Buffer.from(bytes);
    });
    mock.method(myDeskObjectStore, "delete", async (key) => {
        deletedKeys.push(key);
        objects.delete(key);
    });
    if (process.env.RLS_GUC_ENABLED === "true") {
        assert.match(process.env.RLS_TEST_ROLE || "", /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/);
        await fixturePool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${process.env.RLS_TEST_ROLE}"`);
        const role = await pool.query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
        assert.deepEqual(role.rows[0], {
            current_user: process.env.RLS_TEST_ROLE,
            rolsuper: false,
            rolbypassrls: false,
        });
        const policies = await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relname IN ('mydesk_imports','mydesk_import_items','mydesk_import_assets','import_processing_stages') ORDER BY relname");
        assert.equal(policies.rows.length, 4);
        assert.ok(policies.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity && !row.owns_table));
    }
    const app = createApp();
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
    if (server)
        await new Promise((resolve) => server.close(() => resolve()));
    const client = await fixturePool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL app.is_super='on'");
        // Canonical lifecycle guards retain school/user roots even in the CI schema.
        await client.query("UPDATE schools SET deleted_at=now() WHERE id=ANY($1::text[])", [schoolIds]);
        for (const table of [
            "classpilot_evidence_capture_requests",
            "evidence_artifacts",
            "school_discipline_attachments",
            "school_discipline_versions",
            "school_discipline_records",
            "import_processing_stages",
            "mydesk_import_items",
            "mydesk_import_assets",
            "mydesk_imports",
            "mydesk_preferences",
            "mydesk_seating_charts",
            "mydesk_attachments",
            "mydesk_notes",
            "audit_logs",
        ])
            await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
        for (const table of ["group_students", "group_teachers"])
            await client.query(`DELETE FROM ${table} WHERE group_id IN (SELECT id FROM groups WHERE school_id=ANY($1::text[]))`, [schoolIds]);
        for (const table of [
            "groups",
            "students",
            "settings",
            "school_memberships",
            "product_licenses",
        ])
            await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
        await client.query("COMMIT");
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        mock.restoreAll();
        clearInterval(sampler);
        sample();
        metrics.durationMs = performance.now() - metricStart;
        metrics.cpu = process.cpuUsage(cpuStart);
        const sorted = metrics.apiTimingsMs.sort((a, b) => a - b);
        metrics.api = { sampleCount: sorted.length, p50Ms: nearestRankPercentile(sorted, .5), p95Ms: nearestRankPercentile(sorted, .95), maxMs: sorted.at(-1) ?? null };
        delete metrics.apiTimingsMs;
        metrics.remainingPhysicalObjects = readdirSync('/app/evidence/split-objects').length;
        writeFileSync('/app/evidence/' + process.env.PAPERWORK_SCENARIO + '-metrics.json', JSON.stringify(metrics, null, 2));
        client.release();
        await Promise.all([
            pool.end(),
            sessionPool.end(), schedulerPool.end(), schedulerLockPool.end(),
            ...(fixturePool !== pool ? [fixturePool.end()] : []),
        ]);
    }
});
async function fixtureTransaction(operation) {
    const client = await fixturePool.connect();
    try {
        await client.query("BEGIN");
        await operation(client);
        await client.query("COMMIT");
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}
async function fixture() {
    const f = {
        schoolId: randomUUID(),
        teacherId: randomUUID(),
        colleagueId: randomUUID(),
        adminId: randomUUID(),
        officeId: randomUUID(),
        superId: randomUUID(),
        outsideSuperId: randomUUID(),
        groupId: randomUUID(),
        studentId: randomUUID(),
    };
    schoolIds.push(f.schoolId);
    await fixtureTransaction(async (client) => {
        await client.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'My Desk fixture','active',true,'active','UTC')", [f.schoolId]);
        await client.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [f.schoolId]);
        for (const [id, role] of [
            [f.teacherId, "teacher"],
            [f.colleagueId, "teacher"],
            [f.adminId, "school_admin"],
            [f.officeId, "office_staff"],
            [f.superId, "teacher"],
            [f.outsideSuperId, null],
        ]) {
            await client.query("INSERT INTO users(id,email,first_name,last_name,is_super_admin) VALUES($1,$2,'Notebook','Author',$3)", [id, `${id}@example.test`, id === f.superId || id === f.outsideSuperId]);
            if (role)
                await client.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [f.schoolId, id, role]);
        }
        await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Science','teacher_created','active')", [f.groupId, f.schoolId, f.teacherId]);
        await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary'),($1,$3,'co-teacher')", [f.groupId, f.teacherId, f.colleagueId]);
        await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'co-teacher')", [f.groupId, f.superId]);
        await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'First','Student','active')", [f.studentId, f.schoolId]);
        await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [f.groupId, f.studentId]);
    });
    return f;
}
async function request(f, path, method = "GET", body, authorId = f.teacherId, cookie) {
    const headers = {
        "x-school-id": f.schoolId,
        "content-type": "application/json",
        authorization: `Bearer ${signUserToken({ userId: authorId, email: `${authorId}@example.test`, authVersion: 1 })}`,
    };
    if (cookie)
        headers.cookie = cookie;
    const response = await fetch(baseUrl + (path.startsWith("/api/") ? path : "/api/mydesk" + path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = response.headers
        .get("content-type")
        ?.includes("application/json")
        ? JSON.parse(text)
        : text;
    return { status: response.status, data, text, headers: response.headers };
}
async function getRun(f, id) {
    const r = await request(f, `/imports/${id}`);
    assert.equal(r.status, 200, r.text);
    return runEnvelope.parse(r.data).import;
}
async function createRun(f, selectedGroupIds = [f.groupId], expectedSourceCount = 1, destination) {
    const r = await request(f, "/imports", "POST", {
        clientRequestId: randomUUID(),
        selectedGroupIds,
        expectedSourceCount,
        ...(destination ? { destination } : {}),
    });
    assert.equal(r.status, 201, r.text);
    return runEnvelope.parse(r.data).import;
}
async function start(f, run) {
    const r = await request(f, `/imports/${run.id}/process`, "POST", {
        requestId: randomUUID(),
        revision: run.revision,
        protocolVersion: 2,
    });
    assert.equal(r.status, 200, r.text);
    return runEnvelope.parse(r.data).import;
}
async function changeItem(f, run, itemId, patch) {
    const item = run.items.find((i) => i.id === itemId);
    const r = await request(f, `/imports/${run.id}/items/${itemId}`, "PATCH", {
        requestId: randomUUID(),
        revision: run.revision,
        protocolVersion: 2,
        itemRevision: item.revision,
        ...patch,
    });
    assert.equal(r.status, 200, r.text);
    return runEnvelope.parse(r.data).import;
}
async function disciplineFixture() {
    const f = await fixture();
    await fixturePool.query("UPDATE groups SET group_type='admin_class',grade_level='5' WHERE id=$1", [f.groupId]);
    await fixturePool.query("UPDATE students SET grade_level='5' WHERE id=$1", [f.studentId]);
    return f;
}
test('split topology maximum imports ordinary uploads and scheduler overlap', { timeout: 900000 }, async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const { padSyntheticPdf } = await import('/app/dist/cli/measureMyDeskProcessing.js');
  const { processClaimedMyDeskImport } = await import('/app/dist/services/mydeskImportWorker.js');
  const { eq } = await import('drizzle-orm');
  const { cleanupMyDesk } = await import('/app/dist/services/mydeskCleanup.js');
  const pdf = async count => { const doc=await PDFDocument.create(); const font=await doc.embedFont(StandardFonts.Helvetica); for(let page=0;page<count;page++) { const p=doc.addPage([612,792]); for(let form=0;form<3;form++) { const y=750-form*240; p.drawRectangle({x:20,y:y-220,width:570,height:215,borderWidth:1}); p.drawText(`SYNTHETIC CAPACITY FORM page ${page+1}`,{x:35,y:y-25,size:13,font}); for(let line=0;line<8;line++) p.drawText('Synthetic test data only. No actual student or provider response.',{x:35,y:y-50-line*19,size:10,font}); } } return Buffer.from(await doc.save({useObjectStreams:false})); };
  const single=await pdf(1), multi=await pdf(16);
  const photo24=await sharp({create:{width:6000,height:4000,channels:3,background:'#eeeeee'}}).jpeg({quality:94}).timeout({seconds:15}).toBuffer();
  const sources=[{bytes:padSyntheticPdf(multi,10485760),type:'application/pdf'},...Array.from({length:3},()=>({bytes:padSyntheticPdf(single,10485760),type:'application/pdf'})),{bytes:Buffer.concat([photo24,Buffer.alloc(10485760-photo24.length)]),type:'image/jpeg'}];
  const actors=await Promise.all([disciplineFixture(),disciplineFixture()]);
  const rpc=async(path,body={})=>{const response=await realFetch('http://127.0.0.1:3999'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
  const { startApiObservation }=await import('/app/evidence/split-api-observation.mjs');
  const apiObservation=await startApiObservation(metrics);
  await rpc('/observe/start',{actor:actors[0]});
  const endpointPaths=['/api/mydesk/capabilities','/api/classpilot/groups','/api/classpilot/teacher/settings'];
  const baseline=[],baselineByEndpoint=Object.fromEntries(endpointPaths.map(path=>[path,[]]));
  const loadedByEndpoint=Object.fromEntries(endpointPaths.map(path=>[path,[]]));
  let probePhase='warmup';
  const probe=async(index,buckets)=>{
    apiObservation.assertReady();
    const path=endpointPaths[index%endpointPaths.length];
    const {response,durationMs}=await measureReadProbe(metrics.readProbeEvidence,{path,phase:probePhase},
      ()=>request(actors[0],path),{now:()=>performance.now(),originMs:metricStart});
    assert.equal(response.status,200);buckets[path].push(durationMs);return durationMs;
  };
  for(let i=0;i<6;i++) await probe(i,Object.fromEntries(endpointPaths.map(path=>[path,[]])));
  probePhase='baseline';
  const baselineStarted=performance.now();
  while(performance.now()-baselineStarted<60000) {baseline.push(await probe(baseline.length,baselineByEndpoint));await new Promise(resolve=>setTimeout(resolve,500));}
  await rpc('/observe/loaded');
  const baseline95=nearestRankPercentile(baseline,.95);
  assert.notEqual(baseline95,null);
  let failingWindows=0;const windows=[];
  const uploadBytes=async(f,path,bytes,type)=>{ const response=await fetch(baseUrl+'/api/mydesk'+path,{method:'PUT',headers:{'x-school-id':f.schoolId,'content-type':type,authorization:`Bearer ${signUserToken({userId:f.teacherId,email:`${f.teacherId}@example.test`,authVersion:1})}`},body:bytes}); assert.equal(response.status,200); await response.arrayBuffer(); };
  const uploadPacket=async f=>{ let run=await createRun(f,[f.groupId],5,'discipline'); for(const source of sources) { const reservation=await request(f,`/imports/${run.id}/assets`,'POST',{clientRequestId:randomUUID(),filename:'synthetic-capacity',contentType:source.type,size:source.bytes.length,sha256:myDeskSha256(source.bytes)}); assert.equal(reservation.status,201); await uploadBytes(f,`/imports/${run.id}/assets/${reservation.data.asset.id}/content`,source.bytes,source.type); } run=await getRun(f,run.id); assert.equal(run.pageCount,20); return start(f,run); };
  const loaded=[]; let complete=false, operationFailure=null;
  const sampleApi=async()=>{ while(!complete) { loaded.push(await probe(loaded.length,loadedByEndpoint)); apiObservation.assertReady();
      if(loaded.length%20===0){const p95=nearestRankPercentile(loaded.slice(-20),.95);const exceeded=p95>baseline95*1.2;failingWindows=exceeded?failingWindows+1:0;windows.push({throughSample:loaded.length,p95Ms:p95,exceeded});if(failingWindows>=3){metrics.splitAbort={code:'SUSTAINED_API_P95_REGRESSION',baselineP95Ms:baseline95,thresholdMultiplier:1.2,windowSize:20,consecutiveWindows:3,windows};writeFileSync('/app/evidence/split-metrics.json',JSON.stringify(metrics,null,2));process.exit(88);}}
      await new Promise(resolve=>setTimeout(resolve,500)); } };
  probePhase='uploading';
  const health=sampleApi().catch(()=>{
    metrics.splitAbort={code:'API_OBSERVATION_FAILED'};
    writeFileSync('/app/evidence/split-metrics.json',JSON.stringify(metrics,null,2));
    // The outer controller removes this run's isolated containers/network. Stop load immediately.
    process.exit(88);
  }); const started=performance.now();
  const ordinaryNotes=[];
  const ordinary=async f=>{ const created=await request(f,'/notes','POST',{clientRequestId:randomUUID(),targetKind:'general',entryDate:'2026-09-20'}); assert.equal(created.status,201); const note=created.data.note; ordinaryNotes.push({f,note}); for(const source of [{bytes:sources[1].bytes,type:'application/pdf'},{bytes:photo24,type:'image/jpeg'}]) { const reserved=await request(f,`/notes/${note.id}/attachments`,'POST',{clientRequestId:randomUUID(),filename:'synthetic-ordinary',contentType:source.type,size:source.bytes.length,sha256:myDeskSha256(source.bytes)}); assert.equal(reserved.status,201); await uploadBytes(f,`/notes/${note.id}/attachments/${reserved.data.attachment.id}/content`,source.bytes,source.type); } };
  let finalRuns=[];
  try {
    const queued=await Promise.all(actors.map(uploadPacket));
    probePhase='preparing';
    const processing=(async()=>{
      const results=await rpc('/initial',{runIds:queued.map(run=>run.id)});
      assert.equal(results.length,2);
      for(const result of results) assert.equal(result.status,'review');
      await Promise.all(queued.map(async(run,index)=>{
        const ready=await getRun(actors[index],run.id);
        assert.equal(ready.processingVersion,2);
        assert.equal(ready.items.length,50);
        const pages=ready.assets.filter(a=>a.kind==='page'); assert.equal(pages.length,20);
        await changeItem(actors[index],ready,ready.items.at(-1).id,{regions:pages.map(page=>({assetId:page.id,x:.05,y:.05,width:.9,height:.2,rotation:0}))});
      }));
    })();
    const results=await Promise.allSettled([processing,...actors.map(ordinary)]);
    const failed=results.find(result=>result.status==='rejected'); if(failed) throw failed.reason;
    // The queued continuation rebuilds now use the unmodified global claim path.
    probePhase='continuations';
    await rpc('/queued');
    finalRuns=await Promise.all(actors.map((f,index)=>getRun(f,queued[index].id)));
    for(const run of finalRuns) {
      assert.equal(run.status,'review'); assert.equal(run.items.length,50); assert.equal(run.items.at(-1).regions.length,20);
      for(const item of run.items) {
        assert.equal(item.extractionStatus,'ready');
        assert.equal(run.assets.find(asset=>asset.id===item.approvedAssetId)?.status,'ready');
      }
      const asset=run.assets.find(a=>a.id===run.items.at(-1).approvedAssetId); assert.equal(asset.contentType,'application/pdf');
    }
    const pendingStages=await fixturePool.query("SELECT count(*)::int count FROM import_processing_stages WHERE status NOT IN ('completed','cancelled')");
    assert.equal(pendingStages.rows[0].count,0);
  } catch(error) { operationFailure=error; }
  finally {
    complete=true;
    try { await health; metrics.workerObservation=await rpc('/observe/stop'); }
    finally { await apiObservation.stop(); }
  }
  const p95=samples=>nearestRankPercentile(samples,.95);
  const baselineP95=p95(baseline), loadedP95=p95(loaded);
  const endpointTimings=endpointPaths.map(path=>({path,baselineCount:baselineByEndpoint[path].length,loadedCount:loadedByEndpoint[path].length,baselineP95Ms:p95(baselineByEndpoint[path]),loadedP95Ms:p95(loadedByEndpoint[path])}));
  metrics.capacity={status:operationFailure?'failed':'completed',processingMs:performance.now()-started,packets:finalRuns.length,sourceFiles:10,inputBytes:104857600,pages:40,forms:100,continuationRegions:40,ordinaryUploads:4,provider:'synthetic transport through real image preparation/parser',routing:'actual createApp middleware/auth/routing; ephemeral bearer tokens',endpointTimings,baselineApi:{count:baseline.length,p95Ms:baselineP95},loadedApi:{count:loaded.length,p95Ms:loadedP95},apiP95ChangeFraction:loadedP95/baselineP95-1,topology:'Separate exact-image API and worker with inspected CPU/memory limits; disposable isolated Postgres',claimSetup:'actual global claim transactions for initial work and continuation rebuilds',productionReadiness:false};
  if(operationFailure) throw operationFailure;
  probePhase='cleanup';
  for(let i=0;i<finalRuns.length;i++) { const response=await request(actors[i],`/imports/${finalRuns[i].id}`,'DELETE',{requestId:randomUUID(),revision:finalRuns[i].revision,protocolVersion:2}); assert.equal(response.status,200); }
  for(const {f,note} of ordinaryNotes) { const current=await request(f,`/notes/${note.id}`); const deleted=await request(f,`/notes/${note.id}`,'DELETE',{revision:current.data.note.revision}); assert.equal(deleted.status,200); }
  await cleanupMyDeskImports({database:fixtureDb,limit:200}); await cleanupMyDesk({database:fixtureDb,limit:200});
  const remaining=await fixturePool.query("SELECT count(*)::int n FROM mydesk_imports WHERE status IN ('queued','processing')"); assert.equal(remaining.rows[0].n,0);
  metrics.capacity.queueDrained=true; metrics.capacity.latencyWindows=windows; metrics.workerMetrics=await rpc('/metrics'); await rpc('/shutdown');
  const validPeak=(peak,limit)=>Number.isFinite(peak)&&peak>0&&Number.isFinite(limit)&&limit>0&&peak<limit*.70;
  metrics.kernelPeakMemoryBytes=Number(readFileSync('/sys/fs/cgroup/memory.peak','utf8'));
  metrics.releaseCriteria={latencyWithin20Percent:loadedP95<=baselineP95*1.2&&endpointTimings.every(row=>row.loadedP95Ms<=row.baselineP95Ms*1.2),adequateSamples:baseline.length>=100&&loaded.length>=100&&endpointTimings.every(row=>row.baselineCount>=30&&row.loadedCount>=30),apiMemoryBelow70Percent:validPeak(metrics.kernelPeakMemoryBytes,metrics.limits.memoryBytes),workerMemoryBelow70Percent:validPeak(metrics.workerMetrics.kernelPeakMemoryBytes,metrics.workerMetrics.limits.memoryBytes),providerWithinTwo:metrics.workerMetrics.providerPeak<=2,ledgerUsed:metrics.workerMetrics.completedStages>0,completeCleanup:readdirSync('/app/evidence/split-objects').length===0};
  metrics.releaseCriteria.accepted=Object.values(metrics.releaseCriteria).every(Boolean);
  assert.equal(metrics.releaseCriteria.accepted,true,JSON.stringify(metrics.releaseCriteria));
});
