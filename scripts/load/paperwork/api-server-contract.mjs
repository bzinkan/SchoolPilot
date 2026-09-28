import assert from 'node:assert/strict';
import { CAPACITY_READ_PATHS } from './latency-metrics.mjs';

export function assertApiServerMetrics(metrics, expected) {
  assert.equal(metrics.role, 'api', 'Metrics must come from the serving API process');
  assert.equal(metrics.serverId, expected.serverId, 'API process identity changed');
  assert.equal(metrics.imageDigest, expected.imageDigest, 'API image identity changed');
  assert.deepEqual(metrics.limits, { cpu: expected.cpu, memoryBytes: expected.memoryBytes });
  assert.equal(metrics.actualCgroupLimits.memoryBytes, expected.memoryBytes, 'API cgroup memory differs');
  const [quota, period, ...extra] = metrics.actualCgroupLimits.cpuMax.split(/\s+/).map(Number);
  assert.equal(extra.length, 0); assert.ok(quota > 0 && period > 0);
  assert.equal(quota / period, expected.cpu, 'API cgroup CPU differs');
  assert.deepEqual(metrics.observedPoolCaps, { main: 16, session: 2 });
  assert.equal(metrics.failure, null);
  assert.ok(Number.isSafeInteger(metrics.memorySamples) && metrics.memorySamples > 0);
  for (const field of ['peakCgroupMemoryBytes', 'peakRssBytes', 'kernelPeakMemoryBytes']) {
    assert.ok(Number.isSafeInteger(metrics[field]) && metrics[field] > 0, `Missing API ${field}`);
  }
  assert.equal(metrics.serverProbeEvidence.role, 'api');
  assert.equal(metrics.serverProbeEvidence.serverId, metrics.serverId);
  assert.equal(metrics.serverProbeEvidence.invalid, false);
  assert.equal(metrics.apiPoolObservation.notReadySamples, 0);
  assert.deepEqual(metrics.apiPoolObservation.errors, []);
  assert.deepEqual(metrics.apiPoolObservation.profile, { role: 'api', main: 16, session: 2, scheduler: 0, schedulerLock: 0 });
  return metrics;
}

export function createServerProbeEvidence(serverId) {
  return { version: 1, role: 'api', serverId, header: 'x-capacity-probe-id', maxSamples: 4096, invalid: false, samples: [] };
}

export function setApiProbeResponseHeaders(req, res, { serverId, assertReady }) {
  res.setHeader('x-capacity-server-id', serverId);
  if (req.headers['x-capacity-probe-id'] !== undefined) {
    assertReady(); res.setHeader('x-capacity-api-ready', '1');
  }
}

// Called before createApp, so authenticated middleware and the complete response
// are timed by the server without retaining identities, query strings, or bytes.
export function createServerProbeRecorder(evidence, { now = () => performance.now(), onFailure = () => {} } = {}) {
  const used = new Set();
  return (req, res) => {
    const raw = req.headers['x-capacity-probe-id'];
    if (raw === undefined) return;
    const path = String(req.url).split('?')[0];
    const id = typeof raw === 'string' && /^[1-9][0-9]{0,3}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id) || id > evidence.maxSamples || used.has(id) || req.method !== 'GET' ||
        !CAPACITY_READ_PATHS.includes(path) || evidence.samples.length >= evidence.maxSamples) {
      evidence.invalid = true; onFailure('INVALID_API_PROBE'); throw new Error('INVALID_API_PROBE');
    }
    used.add(id);
    const started = now();
    const row = { id, path, method: 'GET', status: null, durationMs: null, completed: false };
    evidence.samples.push(row);
    let done = false;
    const finish = complete => {
      if (done) return; done = true;
      row.status = res.statusCode; row.durationMs = now() - started; row.completed = complete;
    };
    res.once('finish', () => finish(true));
    res.once('close', () => finish(false));
  };
}

export function matchServerReadProbes(clientSamples, serverEvidence) {
  assert.equal(serverEvidence.version, 1); assert.equal(serverEvidence.role, 'api');
  assert.equal(serverEvidence.header, 'x-capacity-probe-id'); assert.equal(serverEvidence.maxSamples, 4096);
  assert.equal(serverEvidence.invalid, false);
  assert.ok(Array.isArray(clientSamples) && clientSamples.length > 0 && clientSamples.length <= 4096);
  assert.equal(serverEvidence.samples.length, clientSamples.length, 'Client/server probe counts differ');
  const byId = new Map();
  for (const row of serverEvidence.samples) {
    assert.ok(Number.isSafeInteger(row.id) && row.id > 0 && row.id <= 4096);
    assert.ok(!byId.has(row.id), 'Duplicate server probe'); byId.set(row.id, row);
    assert.equal(row.method, 'GET'); assert.ok(CAPACITY_READ_PATHS.includes(row.path));
    assert.equal(row.status, 200); assert.equal(row.completed, true);
    assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0);
  }
  const seen = new Set();
  return clientSamples.map(client => {
    assert.ok(Number.isSafeInteger(client.id) && !seen.has(client.id), 'Missing/duplicate client probe identity'); seen.add(client.id);
    const server = byId.get(client.id); assert.ok(server, 'Client probe has no server observation');
    assert.equal(server.path, client.path); assert.equal(server.status, client.status);
    assert.ok(Number.isFinite(client.durationMs) && client.durationMs >= 0);
    return { id: client.id, path: client.path, phase: client.phase, clientMs: client.durationMs,
      serverMs: server.durationMs, clientMinusServerMs: client.durationMs - server.durationMs };
  });
}
