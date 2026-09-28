import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';
import { myDeskObjectStore } from '/app/dist/services/mydeskFiles.js';
import { renderImportSource, cropImportRegion, buildImportAttachment, createImportAiProcessor } from '/app/dist/services/mydeskImportProcessing.js';
import { claimMyDeskImportJobs, processClaimedMyDeskImport, runMyDeskImportJobs } from '/app/dist/services/mydeskImportWorker.js';
import { schedulerPool, schedulerLockPool } from '/app/dist/services/schedulerDb.js';
import { pool, sessionPool } from '/app/dist/db.js';
import { startSchedulerOverlap } from './scheduler-overlap.mjs';
import { databasePoolLimits } from '/app/dist/config/databasePools.js';

if (new URL(process.env.DATABASE_URL).hostname !== '127.0.0.1' || process.env.ANTHROPIC_API_KEY)
  throw Error('Disposable local database and synthetic provider required');
assert.equal(process.env.MYDESK_IMPORT_PIPELINE_VERSION, '2');
assert.equal(process.env.MYDESK_IMPORT_PIPELINE_WIDTH, '2');
assert.equal(process.env.STUDENT_INFORMATION_AI_IMPORT_MODE, 'off');
const directory = '/app/evidence/split-objects';
mkdirSync(directory, { recursive: true });
const filename = key => directory + '/' + createHash('sha256').update(key).digest('hex');
myDeskObjectStore.put = async (key, bytes) => { writeFileSync(filename(key), Buffer.from(bytes)); };
myDeskObjectStore.get = async key => readFileSync(filename(key));
myDeskObjectStore.delete = async key => { if (existsSync(filename(key))) unlinkSync(filename(key)); };
const metrics = {
  imageDigest: process.env.EVIDENCE_IMAGE_DIGEST,
  limits: { cpu: Number(process.env.EVIDENCE_CPU), memoryBytes: Number(process.env.EVIDENCE_MEMORY) },
  providerMode: 'synthetic_transport', storageMode: 'physical_local_files', processingVersion: 2, pipelineWidth: 2,
  providerRequests: 0, providerActive: 0, providerPeak: 0, initialClaims: 0,
  globalQueueRuns: 0, maxGlobalClaimed: 0, completedStages: 0,
  peakCgroupMemoryBytes: 0, memorySamples: 0, failure: null,
};
metrics.poolProfile = databasePoolLimits();
assert.deepEqual(metrics.poolProfile, { role: 'worker', main: 2, session: 1, scheduler: 5, schedulerLock: 8 });
metrics.observedPoolCaps = { main: pool.options.max, session: sessionPool.options.max, scheduler: schedulerPool.options.max, schedulerLock: schedulerLockPool.options.max };
assert.deepEqual(metrics.observedPoolCaps, { main: 2, session: 1, scheduler: 5, schedulerLock: 8 });
metrics.actualCgroupLimits = { memoryBytes: Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8')), cpuMax: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim() };
assert.equal(metrics.actualCgroupLimits.memoryBytes, metrics.limits.memoryBytes);
const [quota, period] = metrics.actualCgroupLimits.cpuMax.split(' ').map(Number);
assert.equal(quota / period, metrics.limits.cpu);
const started = performance.now(), cpuStart = process.cpuUsage();
const save = () => {
  metrics.durationMs = performance.now() - started;
  metrics.cpu = process.cpuUsage(cpuStart);
  metrics.kernelPeakMemoryBytes = Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'));
  writeFileSync('/app/evidence/split-worker-metrics.json', JSON.stringify(metrics, null, 2));
};
const memoryTimer = setInterval(() => {
  metrics.memorySamples++;
  let current;
  try {
    current = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    if (!Number.isFinite(current) || current <= 0) throw Error('MEMORY_UNAVAILABLE');
  } catch {
    metrics.failure = 'MEMORY_UNAVAILABLE';
    writeFileSync('/app/evidence/split-worker-metrics.json', JSON.stringify(metrics, null, 2));
    process.exit(86);
  }
  metrics.peakCgroupMemoryBytes = Math.max(metrics.peakCgroupMemoryBytes, current);
  if (metrics.peakCgroupMemoryBytes >= metrics.limits.memoryBytes * .85) {
    metrics.failure = 'MEMORY_85_PERCENT'; save(); process.exit(86);
  }
}, 100);
const saveTimer = setInterval(save, 1000);
const extraction = {
  subjectNames: ['First Student'], entryDate: '2026-09-20', category: 'detention', title: 'Form record',
  body: 'The form reports a classroom incident. Detention was assigned.', warnings: [], disciplineFields: null,
};
const processor = (maximum = false) => {
  let detection = 0;
  return { renderImportSource, cropImportRegion, buildImportAttachment, ...createImportAiProcessor(async request => {
    metrics.providerRequests++; metrics.providerActive++;
    metrics.providerPeak = Math.max(metrics.providerPeak, metrics.providerActive);
    assert.ok(metrics.providerActive <= 2, 'PROVIDER_CAP_EXCEEDED');
    try {
      // Short, deterministic provider occupancy exercises shared permits without making this a provider benchmark.
      await new Promise(resolve => setTimeout(resolve, 50));
      const detecting = Boolean(request.output_config.format.schema.properties.regions);
      const count = detecting ? (maximum ? (++detection <= 10 ? 3 : 2) : 1) : 0;
      const result = detecting ? { regions: Array.from({ length: count }, (_, n) => ({ x: 0, y: n / 3, width: 1, height: 1 / 3, rotation: 0 })) } : extraction;
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result) }] };
    } finally { metrics.providerActive--; }
  }) };
};
let observation, initialStarted = false;
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'CAPACITY_RPC_FAILURE';
const server = createServer(async (req, res) => {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65536) throw Error('RPC_BODY_LIMIT'); chunks.push(chunk); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    let result;
    if (req.url === '/ready') result = { ready: true };
    else if (req.url === '/observe/start') {
      if (observation) throw Error('OBSERVATION_ALREADY_STARTED');
      observation = startSchedulerOverlap({ fixturePool: schedulerPool, actor: body.actor, metrics }); result = { started: true };
    } else if (req.url === '/observe/loaded') { observation.setPhase('loaded'); result = { loaded: true }; }
    else if (req.url === '/observe/stop') { await observation.stop(); save(); result = metrics.schedulerOverlap; }
    else if (req.url === '/initial') {
      assert.equal(initialStarted, false); initialStarted = true;
      assert.equal(body.runIds?.length, 2);
      const claims = await claimMyDeskImportJobs();
      assert.deepEqual(claims.map(row => row.id).sort(), [...body.runIds].sort());
      assert.ok(claims.every(row => row.processingVersion === 2));
      metrics.initialClaims += claims.length; metrics.maxGlobalClaimed = Math.max(metrics.maxGlobalClaimed, claims.length);
      result = await Promise.all(claims.map(claim => processClaimedMyDeskImport(claim, { processor: processor(true) })));
    } else if (req.url === '/queued') {
      metrics.globalQueueRuns++; result = await runMyDeskImportJobs({ processor: processor() });
      metrics.maxGlobalClaimed = Math.max(metrics.maxGlobalClaimed, result.length);
      metrics.completedStages = Number((await schedulerPool.query("SELECT count(*) n FROM import_processing_stages WHERE status='completed'")).rows[0].n);
    } else if (req.url === '/metrics') { save(); result = metrics; }
    else if (req.url === '/shutdown') {
      save(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"stopped":true}');
      setTimeout(async () => {
        clearInterval(memoryTimer); clearInterval(saveTimer); server.close();
        await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]); process.exit(0);
      }, 50); return;
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  } catch (error) {
    metrics.failure = safeCode(error); save();
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: metrics.failure }));
  }
});
server.listen(3999, '127.0.0.1', save);
