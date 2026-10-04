import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { moduleFromApplication, pause } from './application.mjs';

// Both arms import exactly these common serving modules. No query/pool wrappers
// and no candidate-only instrumentation are injected into the baseline arm.
const db = await moduleFromApplication('db.js');
const { createApp } = await moduleFromApplication('app.js');
const protocol = await moduleFromApplication('services/classpilotProtocol.js');
protocol.assertClasspilotCapabilityRolloutsEnv(process.env);
const websocket = await moduleFromApplication('realtime/websocket.js');
const redis = await moduleFromApplication('realtime/ws-redis.js');
const batch = await moduleFromApplication('services/heartbeatClassificationBatcher.js');
const tenant = await moduleFromApplication('middleware/tenantContext.js');
assert.equal(db.pool.options.max, 16); assert.equal(db.sessionPool.options.max, 2);
assert.equal(await db.prewarmMainPool(), 16);
db.startApiPoolReadiness();
let responses = 0, aborted = 0, seenHeartbeatOffers=0, cpuStart = process.cpuUsage(), started = performance.now();
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
let utilization = performance.eventLoopUtilization();
const server = createServer(createApp()), wss = websocket.setupWebSocket(server);
server.prependListener('request', (_request, response) => {
  if(_request.url?.split('?')[0]==='/api/classpilot/device/heartbeat')seenHeartbeatOffers++;
  responses++; let ended = false;
  const finish = () => { if (ended) return; ended = true; responses--; if (!response.writableFinished) aborted++; };
  response.once('finish', finish); response.once('close', finish);
});
await new Promise(resolve => server.listen(Number(process.env.RELEASE297_API_PORT), '127.0.0.1', resolve));
const readyDeadline = Date.now() + 10_000;
while (!redis.isRedisBroadcastReady() && Date.now() < readyDeadline) await pause(25);
assert.equal(redis.isRedisBroadcastReady(), true);
const base = 'http://127.0.0.1:' + server.address().port;
assert.equal((await fetch(base + '/readyz')).status, 200);
const snapshot = () => ({ cpuMicroseconds: process.cpuUsage(cpuStart), elapsedMs: performance.now() - started,
  responses, aborted, seenHeartbeatOffers, pools: [db.pool, db.sessionPool].map(pool => ({ waiting: pool.waitingCount, held: pool.totalCount - pool.idleCount })),
  tenantReleases: tenant.getTenantContextReleaseSnapshot?.() ?? null,
  eventLoop: { maxMs: delay.max / 1e6, p95Ms: delay.percentile(95) / 1e6, utilization: performance.eventLoopUtilization(utilization).utilization } });
async function drain() {
  const deadline = Date.now() + 20_000; let idle = 0;
  while (Date.now() < deadline) {
    // Baseline has producer flush, candidate has a non-disabling drain. Neither
    // phase reset calls the permanent batch shutdown method.
    await (batch.drainHeartbeatClassificationBatches ?? batch.flushHeartbeatClassificationProducers)();
    await websocket.drainWebSocketWork?.(); await tenant.drainTenantContextReleases?.();
    const state = snapshot();
    if (!state.responses && state.pools.every(pool => pool.waiting === 0 && pool.held === 0) && !(state.tenantReleases?.pending > 0)) idle++; else idle = 0;
    if (idle >= 2) return { complete: aborted === 0, snapshot: state, abortedResponses: aborted,
      ownershipCoverage: 'common runtime producers, WebSocket work when exported, tenant releases, pool and response gauges',
      preHandlerCallbackCompletionClaimed: false };
    await pause(25);
  }
  return { complete: false, snapshot: snapshot(), failure: 'DRAIN_DEADLINE' };
}
process.send({ kind: 'ready', pid: process.pid, base, pools: { api: 16, session: 2 }, readiness: true, redis: true });
process.on('message', async request => {
  try {
    let value;
    if (request.operation === 'reset') { assert.equal(responses, 0); assert.equal(aborted, 0); seenHeartbeatOffers=0; cpuStart = process.cpuUsage(); started = performance.now(); delay.reset(); utilization = performance.eventLoopUtilization(); value = true; }
    else if (request.operation === 'snapshot') value = snapshot();
    else if (request.operation === 'drain' || request.operation === 'quiesce') value = await drain();
    else if (request.operation === 'shutdown') {
      value = await drain(); assert.equal(value.complete, true);
      websocket.stopWebSocketWork?.(); for (const socket of wss.clients) socket.terminate();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await batch.flushHeartbeatClassificationBatches(); db.stopApiPoolReadiness(); await db.drainApiPoolReadiness();
      await tenant.drainTenantContextReleases?.(); await (await moduleFromApplication('services/errorMonitor.js')).default.disposeAndWait();
      await redis.disposeWSRedis(); await Promise.all([db.pool.end(), db.sessionPool.end()]); delay.disable();
      process.send({ id: request.id, value }, () => process.exit(0)); return;
    } else throw Error('Unknown blackbox API operation');
    process.send({ id: request.id, value });
  } catch (error) { process.send({ id: request.id, error: { code: error.code || 'BLACKBOX_API_FAILED', name: error.name } }); }
});
