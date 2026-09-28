import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createApp } from '/app/dist/app.js';
import { pool, sessionPool } from '/app/dist/db.js';
import { myDeskObjectStore } from '/app/dist/services/mydeskFiles.js';
import { createPhysicalObjectStore, createStorageEvidence } from './physical-object-store.mjs';
import { startApiObservation } from './split-api-observation.mjs';
import { createServerProbeEvidence, createServerProbeRecorder, setApiProbeResponseHeaders } from './api-server-contract.mjs';

const origin = performance.now(), cpuStart = process.cpuUsage(), serverId = randomUUID();
const metrics = { role: 'api', serverId, imageDigest: process.env.EVIDENCE_IMAGE_DIGEST,
  sourceRevision: process.env.EVIDENCE_SOURCE_REVISION,
  serverSourceSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  contractSourceSha256: createHash('sha256').update(readFileSync(new URL('./api-server-contract.mjs', import.meta.url))).digest('hex'),
  storageSourceSha256: createHash('sha256').update(readFileSync(new URL('./physical-object-store.mjs', import.meta.url))).digest('hex'),
  limits: { cpu: Number(process.env.EVIDENCE_CPU), memoryBytes: Number(process.env.EVIDENCE_MEMORY) },
  actualCgroupLimits: { memoryBytes: Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8')),
    cpuMax: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim() },
  memorySamples: 0, peakCgroupMemoryBytes: 0, peakRssBytes: 0, kernelPeakMemoryBytes: 0,
  failure: null, storageIo: createStorageEvidence(), serverProbeEvidence: createServerProbeEvidence(serverId),
  measurement: 'Serving createApp process only; driver runs in a separate container and cgroup' };
assert.equal(metrics.limits.cpu, 1); assert.equal(metrics.limits.memoryBytes, 2 * 1024 ** 3);
assert.equal(metrics.actualCgroupLimits.memoryBytes, metrics.limits.memoryBytes);
const [quota, period] = metrics.actualCgroupLimits.cpuMax.split(/\s+/).map(Number);
assert.equal(quota / period, metrics.limits.cpu);
assert.match(metrics.imageDigest, /^sha256:[a-f0-9]{64}$/);
assert.match(metrics.sourceRevision, /^[a-f0-9]{40}$/);
assert.equal(process.env.MYDESK_MODE, 'on');
assert.equal(process.env.MYDESK_SEATING_MODE, 'on');
assert.equal(process.env.MYDESK_AI_IMPORT_MODE, 'on');
assert.equal(process.env.MYDESK_IMPORT_PIPELINE_VERSION, '2');
assert.equal(process.env.MYDESK_IMPORT_PIPELINE_WIDTH, '2');
assert.equal(process.env.STUDENT_INFORMATION_AI_IMPORT_MODE, 'off');
assert.notEqual(process.env.PAPERWORK_LIVE_PROVIDER, '1');
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL).hostname));
assert.equal(process.env.ADMIN_DATABASE_URL, undefined, 'Serving API cannot have fixture administrator credentials');
assert.equal(process.env.RLS_GUC_ENABLED, 'true');
const role = await pool.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
assert.deepEqual(role.rows[0], { current_user: process.env.RLS_TEST_ROLE, rolsuper: false, rolbypassrls: false });
const policies = await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relname IN ('mydesk_imports','mydesk_import_items','mydesk_import_assets','import_processing_stages') ORDER BY relname");
assert.equal(policies.rows.length, 4); assert.ok(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.owns_table));
Object.assign(myDeskObjectStore, await createPhysicalObjectStore('/app/evidence/split-objects', metrics.storageIo, origin));

const sample = () => {
  metrics.memorySamples++;
  metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss);
  const memory = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
  assert.ok(Number.isSafeInteger(memory) && memory > 0, 'MEMORY_UNAVAILABLE');
  metrics.peakCgroupMemoryBytes = Math.max(metrics.peakCgroupMemoryBytes, memory);
  metrics.kernelPeakMemoryBytes = Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'));
  metrics.durationMs = performance.now() - origin; metrics.cpu = process.cpuUsage(cpuStart);
};
const save = () => { sample(); writeFileSync('/app/evidence/split-api-server-metrics.json', JSON.stringify(metrics, null, 2)); };
const fail = code => { metrics.failure ??= code; save(); };
const sampler = setInterval(() => {
  try { sample(); if (metrics.peakCgroupMemoryBytes >= metrics.limits.memoryBytes * .85) { fail('MEMORY_85_PERCENT'); process.exit(86); } }
  catch { metrics.failure ??= 'MEMORY_UNAVAILABLE'; writeFileSync('/app/evidence/split-api-server-metrics.json', JSON.stringify(metrics, null, 2)); process.exit(86); }
}, 100); sampler.unref(); sample();
let observation, stoppingObservation, starting = false, stopped = false, shuttingDown = false;
const stopObservation = () => stoppingObservation ??= (async () => { if (observation) await observation.stop(); stopped = true; save(); })();
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-capacity-server-id': serverId }); res.end(JSON.stringify(body)); };
const recorder = createServerProbeRecorder(metrics.serverProbeEvidence, { onFailure: fail });
const app = createApp();
async function control(req, res) {
  req.resume();
  const action = req.url.slice('/__capacity/'.length);
  if (req.method === 'GET' && action === 'ready') return json(res, metrics.failure ? 503 : 200, { ready: !metrics.failure, role: 'api', serverId });
  if (req.method !== 'POST') return json(res, 405, { code: 'CONTROL_METHOD' });
  if (action === 'start') {
    if (starting || observation || stopped) return json(res, 409, { code: 'OBSERVATION_ALREADY_STARTED' });
    starting = true;
    observation = await startApiObservation(metrics, { failureFile: '/app/evidence/split-api-server-metrics.json' });
    save(); return json(res, 200, { started: true, role: 'api', serverId });
  }
  if (action === 'assert') {
    if (!observation || stopped) return json(res, 409, { code: 'OBSERVATION_NOT_ACTIVE' });
    observation.assertReady(); sample();
    return json(res, metrics.failure ? 503 : 200, { ready: !metrics.failure, failure: metrics.failure, role: 'api', serverId });
  }
  if (action === 'metrics') { sample(); return json(res, 200, { metrics }); }
  if (action === 'stop') { if (!observation) return json(res, 409, { code: 'OBSERVATION_NOT_ACTIVE' }); await stopObservation(); return json(res, 200, { stopped: true, metrics }); }
  if (action === 'shutdown') { json(res, 200, { stopping: true }); setImmediate(() => { void shutdown(); }); return; }
  return json(res, 404, { code: 'UNKNOWN_CONTROL' });
}
const server = createServer((req, res) => {
  if (req.url.startsWith('/__capacity/')) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return json(res, 403, { code: 'CONTROL_LOOPBACK_ONLY' });
    void control(req, res).catch(() => { fail('API_CONTROL_FAILED'); if (!res.headersSent) json(res, 503, { code: 'API_CONTROL_FAILED' }); }); return;
  }
  try {
    recorder(req, res); setApiProbeResponseHeaders(req, res, { serverId, assertReady() {
      assert.ok(observation && !stopped, 'OBSERVATION_NOT_ACTIVE'); observation.assertReady();
      assert.equal(metrics.failure, null);
    } });
    app(req, res);
  }
  catch { fail('API_REQUEST_INSTRUMENTATION_FAILED'); if (!res.headersSent) json(res, 503, { code: 'API_REQUEST_INSTRUMENTATION_FAILED' }); }
});
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  const force = setTimeout(() => { save(); process.exit(1); }, 5000); force.unref();
  try {
    await stopObservation(); clearInterval(sampler);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await Promise.all([pool.end(), sessionPool.end()]); save(); clearTimeout(force); process.exit(metrics.failure ? 1 : 0);
  } catch { fail('API_SHUTDOWN_FAILED'); process.exit(1); }
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
process.once('exit', () => { clearInterval(sampler); save(); });
await new Promise(resolve => server.listen(3998, '127.0.0.1', resolve));
save();
