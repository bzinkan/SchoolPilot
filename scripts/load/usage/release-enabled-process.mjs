import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { assertLocalScaleFixture, apiStatementKind } from './local-usage-scale.mjs';
import { assertEnabledReleaseRuntime } from './release-enabled-profile.mjs';
import pg from 'pg';
import { measureMethod } from './release-enabled-instrumentation.mjs';

assertLocalScaleFixture(process.env);
assert.ok(process.send, 'Isolated fixture children require an owning IPC parent');
const role = process.env.USAGE_RELEASE_ROLE;
assert.ok(['api', 'worker'].includes(role));
assert.equal(process.env.SCHEDULER_ENABLED, role === 'worker' ? 'true' : 'false');
const diagnostics = await import('../../../dist/services/usageCapacityDiagnostics.js');
const protocol = await import('../../../dist/services/classpilotProtocol.js');
assertEnabledReleaseRuntime(protocol, process.env);
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
let lastUtilization = performance.eventLoopUtilization();
let cpuStart = process.cpuUsage();
let measurementStartedHrtimeMicroseconds;
let metrics;
const fresh = () => ({ acquisitions: { count: 0, failures: 0, maxMs: 0 }, statements: {}, peakWaiting: 0, peakHeld: 0 });
const reset = () => { metrics = fresh(); delay.reset(); lastUtilization = performance.eventLoopUtilization(); cpuStart = process.cpuUsage(); measurementStartedHrtimeMicroseconds = Number(process.hrtime.bigint() / 1000n); diagnostics.resetUsageCapacityDiagnostics(); };
reset();
const record = (row, durationMs, error) => { row.count++; row.maxMs = Math.max(row.maxMs, durationMs); if (error) row.failures++; };
const observed = new WeakSet();
// Capture ALS attribution before pg can dispatch callbacks in a socket context.
const instrument = (pool, lazy = false) => {
  const options = pool.options;
  measureMethod(lazy ? pg.Pool.prototype : pool, 'connect', (duration, error) => record(metrics.acquisitions, duration, error),
    { appliesTo: receiver => !lazy || receiver.options === options });
  pool.on('connect', client => {
    if (observed.has(client)) return; observed.add(client);
    measureMethod(client, 'query', (duration, error, input, operation) => {
      const kind = apiStatementKind(typeof input === 'string' ? input : input?.text || '');
      const key = `${operation}/${kind}`;
      record(metrics.statements[key] ??= { count: 0, failures: 0, maxMs: 0 }, duration, error);
      diagnostics.recordUsageCapacityTiming('sqlMs', duration, operation);
      if (error) diagnostics.recordUsageCapacityCounter('sqlFailure', operation);
    }, { capture: diagnostics.getUsageCapacityOperation });
  });
};
let server, wss, mainPool, sessionPool, schedulerPool, websocket, redis, timer;
let flush = async () => {};
let quiesce = async () => {};
let admission;
if (role === 'api') {
  const db = await import('../../../dist/db.js');
  mainPool = db.pool; sessionPool = db.sessionPool;
  instrument(mainPool); instrument(sessionPool);
  assert.equal(mainPool.options.max, 16); assert.equal(sessionPool.options.max, 2);
  const { createApp } = await import('../../../dist/app.js');
  ({ classpilotUsageAdmission: admission } = await import('../../../dist/services/classpilotUsageAdmission.js'));
  websocket = await import('../../../dist/realtime/websocket.js');
  redis = await import('../../../dist/realtime/ws-redis.js');
  const batch = await import('../../../dist/services/heartbeatClassificationBatcher.js');
  flush = batch.flushHeartbeatClassificationBatches;
  quiesce = batch.drainHeartbeatClassificationBatches;
  server = createServer(createApp()); wss = websocket.setupWebSocket(server);
  const prewarmed = await db.prewarmMainPool(); assert.equal(prewarmed, 16);
  db.startApiPoolReadiness();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const deadline = Date.now() + 10_000;
  while (!redis.isRedisBroadcastReady() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(redis.isRedisBroadcastReady(), true, 'Owned Redis publisher/subscriber must be ready before measurement');
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/readyz`); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok' });
  timer = setInterval(() => { metrics.peakWaiting = Math.max(metrics.peakWaiting, mainPool.waitingCount); metrics.peakHeld = Math.max(metrics.peakHeld, mainPool.totalCount - mainPool.idleCount); }, 20); timer.unref();
  process.send({ kind: 'ready', pid: process.pid, base, pools: { api: 16, session: 2 }, prewarmed, readiness: true, redis: true });
} else {
  ({ schedulerPool } = await import('../../../dist/services/schedulerDb.js'));
  assert.equal(schedulerPool.options.max, 5); instrument(schedulerPool, true);
  assert.equal((await schedulerPool.query('SELECT current_setting(\'app.is_super\') AS scoped')).rows[0].scoped, 'on');
  timer = setInterval(() => { metrics.peakWaiting = Math.max(metrics.peakWaiting, schedulerPool.waitingCount); metrics.peakHeld = Math.max(metrics.peakHeld, schedulerPool.totalCount - schedulerPool.idleCount); }, 20); timer.unref();
  process.send({ kind: 'ready', pid: process.pid, pools: { worker: 5 } });
}

const snapshot = () => ({ database: metrics, operations: diagnostics.getUsageCapacityDiagnostics(), measurementStartedHrtimeMicroseconds,
  snapshotHrtimeMicroseconds: Number(process.hrtime.bigint() / 1000n),
  ...(admission ? { reportAdmission: admission.diagnostics() } : {}), cpuMicroseconds: process.cpuUsage(cpuStart),
  eventLoop: { p50Ms: delay.percentile(50) / 1e6, p95Ms: delay.percentile(95) / 1e6, maxMs: delay.max / 1e6,
    utilization: performance.eventLoopUtilization(lastUtilization).utilization }, rssBytes: process.memoryUsage().rss });
process.on('message', async request => {
  if (!request || typeof request.id !== 'number') return;
  try {
    let value;
    if (request.operation === 'reset') { reset(); admission?.resetDiagnostics(); value = true; }
    else if (request.operation === 'snapshot') value = snapshot();
    else if (request.operation === 'drain' || request.operation === 'quiesce') {
      if (request.operation === 'quiesce') await quiesce();
      else await flush();
      if (role === 'api') await (await import('../../../dist/middleware/tenantContext.js')).drainTenantContextReleases();
      value = true;
    }
    else if (request.operation === 'rollup' && role === 'worker') {
      const rollup = await import('../../../dist/services/classpilotUsageRollup.js');
      const started = performance.now();
      value = await diagnostics.runWithUsageCapacityOperation('usage_worker', () => rollup.rollupClasspilotUsageDay(schedulerPool, {
        schoolId: request.value.schoolId, day: rollup.classpilotUsageRollupDay(request.value.date, 'America/New_York'),
        windowEndUtc: new Date(request.value.cutoff), exclusions: [],
      }));
      value = { ...value, durationMs: performance.now() - started };
    } else if (request.operation === 'shutdown') {
      clearInterval(timer); delay.disable();
      if (role === 'api') {
        websocket.stopWebSocketWork(); for (const client of wss.clients) client.terminate();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await websocket.drainWebSocketWork(); await flush();
        const db = await import('../../../dist/db.js'); db.stopApiPoolReadiness(); await db.drainApiPoolReadiness();
        await (await import('../../../dist/middleware/tenantContext.js')).drainTenantContextReleases();
        await (await import('../../../dist/services/errorMonitor.js')).default.disposeAndWait();
        await redis.disposeWSRedis(); await Promise.all([mainPool.end(), sessionPool.end()]);
      } else {
        await (await import('../../../dist/services/errorMonitor.js')).default.disposeAndWait();
        await schedulerPool.end();
      }
      await Promise.all([new Promise(resolve => process.stdout.write('', resolve)), new Promise(resolve => process.stderr.write('', resolve))]);
      process.send({ id: request.id, value: snapshot() }, () => process.exit(0)); return;
    } else throw new Error('Unknown fixture operation');
    process.send({ id: request.id, value });
  } catch (error) {
    process.send({ id: request.id, error: { name: error.name, code: error.code || 'FIXTURE_OPERATION_FAILED', message: error.message } });
  }
});
process.on('disconnect', () => process.exit(1));
