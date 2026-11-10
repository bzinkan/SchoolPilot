// Bounded protocol comparison on 127.0.0.1. No AWS, database, Linux runner,
// production URL, credentials or persisted student data are used.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { createDeviceTelemetryDispatcher, DeviceTelemetryDelivery } from '../../src/services/classpilotDeviceTelemetry.ts';

const args = process.argv.slice(2);
function integer(name, fallback, max) {
  const raw = args.find(x => x.startsWith(`--${name}=`));
  const n = raw ? Number(raw.split('=')[1]) : fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}; use 1..${max}`);
  return n;
}
const clients = integer('clients', 40, 2000);
const rounds = integer('rounds', 2, 5);
const binding = index => ({ schoolId: 'synthetic-school', deviceId: `synthetic-device-${index}`,
  studentId: `synthetic-student-${index}`, studentSessionId: `synthetic-session-${index}` });
const dispatcher = createDeviceTelemetryDispatcher({
  verifyToken(token) {
    const m = /^synthetic-token-(\d+)$/.exec(token);
    if (!m) throw new Error('Invalid synthetic token');
    const b = binding(Number(m[1]));
    return { ...b, sessionId: b.studentSessionId };
  },
  allowed: () => true,
  execute: async (_kind, context) => context.reply(200, { ok: true, marker: context.payload.marker }),
});
const makeFrame = (index, round) => ({ type: 'device-telemetry', operationId: randomUUID(), kind: 'heartbeat',
  studentToken: `synthetic-token-${index}`, payload: { marker: `${index}:${round}`, clientProtocolVersion: 3 } });
let httpRequests = 0;
let upgrades = 0;
const sockets = new Set();
const server = http.createServer(async (req, res) => {
  httpRequests++;
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const index = Number(url.searchParams.get('index'));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const delivery = new DeviceTelemetryDelivery();
    const outcome = await dispatcher(JSON.parse(Buffer.concat(chunks).toString()), {
      binding: binding(index), sourceIp: '127.0.0.1', delivery, reply: x => x,
    });
    res.writeHead(outcome.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(outcome.body), () => delivery.finish());
  } catch { res.writeHead(500).end(); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
server.on('upgrade', (req, socket, head) => {
  upgrades++;
  const index = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('index'));
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('error', () => {});
    ws.on('message', async raw => {
      const frame = JSON.parse(raw.toString());
      const delivery = new DeviceTelemetryDelivery();
      const outcome = await dispatcher(frame, { binding: binding(index), sourceIp: '127.0.0.1',
        delivery, reply: x => x });
      ws.send(JSON.stringify({ type: 'device-telemetry-result', operationId: frame.operationId,
        kind: frame.kind, ...outcome, exactBinding: { studentId: binding(index).studentId,
          studentSessionId: binding(index).studentSessionId } }), error => error ? delivery.close() : delivery.finish());
    });
  });
});
const summarize = times => {
  const sorted = [...times].sort((a, b) => a - b);
  return { successfulOperations: sorted.length, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1) };
};
async function batches(items, size, operation) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(operation));
}
const deadline = setTimeout(() => { console.error('Local protocol comparison exceeded 45 seconds'); process.exit(1); }, 45000);
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const operations = Array.from({ length: clients * rounds }, (_, i) => ({ index: i % clients, round: Math.floor(i / clients) }));
  const httpTimes = [];
  await batches(operations, 32, async ({ index, round }) => {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/telemetry?index=${index}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(makeFrame(index, round)),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    if (response.status !== 200 || body.marker !== `${index}:${round}`) throw new Error('HTTP result mismatch');
    httpTimes.push(performance.now() - started);
  });
  const peers = new Map();
  await batches(Array.from({ length: clients }, (_, i) => i), 100, async index => {
    const peer = new WebSocket(`ws://127.0.0.1:${port}/ws?index=${index}`);
    sockets.add(peer);
    await once(peer, 'open');
    peers.set(index, peer);
  });
  const wsTimes = [];
  // Each client has one heartbeat in flight. Keep rounds ordered per socket;
  // otherwise multiple one-shot listeners would consume the same first reply.
  for (let currentRound = 0; currentRound < rounds; currentRound++) {
  await batches(operations.filter(item => item.round === currentRound), 100, async ({ index, round }) => {
    const peer = peers.get(index);
    const frame = makeFrame(index, round);
    const received = once(peer, 'message', { signal: AbortSignal.timeout(5000) });
    const started = performance.now();
    peer.send(JSON.stringify(frame));
    const [data] = await received;
    const reply = JSON.parse(data.toString());
    if (reply.operationId !== frame.operationId || reply.status !== 200 || reply.body.marker !== `${index}:${round}`
      || reply.exactBinding.studentSessionId !== binding(index).studentSessionId) throw new Error('WebSocket result mismatch');
    wsTimes.push(performance.now() - started);
  });
  }
  const result = { scope: 'Windows loopback protocol comparison only; no database or AWS capacity evidence',
    clients, rounds, http: { ...summarize(httpTimes), recurringHttpRequests: httpRequests },
    websocket: { ...summarize(wsTimes), recurringHttpRequests: 0, upgrades },
    databaseExercised: false, awsCapacityAccepted: false };
  console.log(args.includes('--json') ? JSON.stringify(result) : JSON.stringify(result, null, 2));
} finally {
  clearTimeout(deadline);
  for (const socket of sockets) socket.terminate();
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
