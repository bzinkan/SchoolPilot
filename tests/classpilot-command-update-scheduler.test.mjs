import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real private scheduler without opening sockets, a DB, or Redis.
const source = readFileSync(new URL('../src/realtime/websocket.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const MAX_CONCURRENT_COMMAND_UPDATE_PUBLICATIONS = 2;');
const end = source.indexOf('  // --- Redis cross-instance message delivery ---', start);
assert.ok(start >= 0 && end > start);
const scheduler = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const dependencyNames = ['setTimeout', 'clearTimeout', 'performance', 'runWithTenantContext',
  'updateClasspilotCommandSummary', 'withClasspilotCommandBroadcastLock', 'recordCommandHotPathPhase',
  'publicClasspilotCommand', 'classpilotCommandDeliveryPolicy', 'summarizeClasspilotCommandTargets',
  'publishOrderedWS', 'recordLocalOrderedDelivery', 'broadcastToStaffSessionLocal', 'sendToStaffUserLocal',
  'webSocketWork', 'errorMonitor', 'wasTenantPoolAcquisitionFailureReported',
  'registerClasspilotCommandUpdateScheduler', 'stopWebSocketProducers', 'wss'];
const createScheduler = new Function('dependencies',
  `const { ${dependencyNames.join(', ')} } = dependencies;\n${scheduler}\n` +
  'return { schedule: scheduleCommandUpdate, close: stopCommandUpdates, states: commandUpdateStates };');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function sharedBackend() {
  return { revision: 0, acceptedRevision: 0, committedAcks: 1, publications: [],
    publish: async function (_target, payload, options) {
      const revision = Number(options.revision);
      this.publications.push({ revision, payload });
      if (revision === 1 && this.firstPublication) await this.firstPublication.promise;
      if (revision <= this.acceptedRevision) return { status: 'stale', subscriberCount: 0 };
      this.acceptedRevision = revision;
      return { status: 'accepted', subscriberCount: 1 };
    } };
}
function harness(backend) {
  let now = 0, id = 0;
  const timers = new Map(), raw = new Set(), local = [], errors = [], phases = [], snapshots = [];
  const api = createScheduler({
    setTimeout(fn, delay) { const timer = { id: ++id, at: now + delay, fn, unref() {} }; timers.set(timer.id, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer.id); }, performance: { now: () => now },
    runWithTenantContext: async (_context, fn) => fn(), updateClasspilotCommandSummary: async () => {},
    withClasspilotCommandBroadcastLock: async (commandId, schoolId, callback) => {
      const revision = String(++backend.revision);
      const command = { id: commandId, schoolId, commandType: 'open-tab', teachingSessionId: 'classroom',
        teacherId: 'teacher', expiresAt: null, committedAcks: backend.committedAcks };
      snapshots.push({ revision, committedAcks: command.committedAcks });
      return callback(command, revision);
    },
    recordCommandHotPathPhase: (phase, _duration, options) => phases.push({ phase, ...options }),
    publicClasspilotCommand: command => command, classpilotCommandDeliveryPolicy: () => 'transient',
    summarizeClasspilotCommandTargets: command => ({ committedAcks: command.committedAcks }),
    publishOrderedWS: (...args) => backend.publish(...args), recordLocalOrderedDelivery: () => true,
    broadcastToStaffSessionLocal: (...args) => local.push(args), sendToStaffUserLocal: (...args) => local.push(args),
    webSocketWork: { canStart: () => true, track(promise) { raw.add(promise); promise.finally(() => raw.delete(promise)); return promise; } },
    errorMonitor: { trackError: (...args) => errors.push(args) }, wasTenantPoolAcquisitionFailureReported: () => false,
    registerClasspilotCommandUpdateScheduler: () => {}, stopWebSocketProducers: new Set(), wss: { once() {} },
  });
  return { ...api, local, errors, phases, snapshots, raw,
    delays: () => [...timers.values()].map(timer => timer.at - now),
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const timer = [...timers.values()].sort((a, b) => a.at - b.at)[0];
        if (!timer || timer.at > target) break;
        now = timer.at; timers.delete(timer.id); timer.fn(); await flush();
      }
      now = target; await flush();
    } };
}

test('newer accepted snapshot covers an older stale publication without retry, error or stale local fanout', async () => {
  const backend = sharedBackend(); backend.firstPublication = deferred();
  const old = harness(backend), newer = harness(backend);
  old.schedule('school', 'command'); await old.advance(50);
  backend.committedAcks = 2;
  newer.schedule('school', 'command'); await newer.advance(50);
  assert.equal(backend.acceptedRevision, 2);
  assert.equal(newer.local[0][2].summary.committedAcks, 2);
  backend.firstPublication.resolve(); await flush();
  assert.equal(old.local.length, 0);
  assert.equal(old.errors.length, 0);
  assert.deepEqual(old.delays(), []);
  assert.equal(old.states.size, 0); assert.equal(old.raw.size, 0);
  assert.equal(old.phases.at(-1).success, true);
});

test('ACK arriving after capture keeps one normal 50ms refresh after stale, with a fresh snapshot', async () => {
  const backend = sharedBackend(); backend.firstPublication = deferred();
  const old = harness(backend), newer = harness(backend);
  old.schedule('school', 'command'); await old.advance(50);
  backend.committedAcks = 2; newer.schedule('school', 'command'); await newer.advance(50);
  backend.committedAcks = 3; old.schedule('school', 'command'); old.schedule('school', 'command');
  backend.firstPublication.resolve(); await flush();
  assert.deepEqual(old.delays(), [50]); assert.equal(old.errors.length, 0);
  await old.advance(49); assert.equal(old.snapshots.length, 1);
  await old.advance(1); assert.equal(old.snapshots.length, 2);
  assert.equal(old.local.length, 1); assert.equal(old.local[0][2].summary.committedAcks, 3);
  assert.equal(old.states.size, 0); assert.equal(old.raw.size, 0);
});

for (const status of ['unknown', 'not_admitted']) {
  test(`${status} retains bounded backoff and never falls back to local fanout`, async () => {
    const backend = sharedBackend(); backend.publish = async () => ({ status, subscriberCount: 0 });
    const owner = harness(backend); owner.schedule('school', 'command'); await owner.advance(50);
    for (const delay of [250, 500, 1000]) { assert.deepEqual(owner.delays(), [delay]); await owner.advance(delay); }
    assert.deepEqual(owner.delays(), []); assert.equal(owner.snapshots.length, 4);
    assert.equal(owner.errors.length, 4); assert.equal(owner.local.length, 0);
    assert.equal(owner.raw.size, 0); assert.equal(owner.states.size, 0);
  });
}

test('accepted publication without subscribers still fails and retries', async () => {
  const backend = sharedBackend(); backend.publish = async () => ({ status: 'accepted', subscriberCount: 0 });
  const owner = harness(backend); owner.schedule('school', 'command'); await owner.advance(50);
  assert.deepEqual(owner.delays(), [250]); assert.equal(owner.errors.length, 1);
  assert.equal(owner.phases.at(-1).success, false); owner.close(); assert.deepEqual(owner.delays(), []);
});

test('shutdown retains pending raw publication and never rearms a dirty stale result', async () => {
  const backend = sharedBackend(); backend.firstPublication = deferred(); backend.acceptedRevision = 2;
  const owner = harness(backend); owner.schedule('school', 'command'); await owner.advance(50);
  owner.schedule('school', 'command'); owner.close(); assert.equal(owner.raw.size, 1);
  backend.firstPublication.resolve(); await flush();
  assert.equal(owner.raw.size, 0); assert.equal(owner.states.size, 0);
  assert.deepEqual(owner.delays(), []); assert.equal(owner.errors.length, 0); assert.equal(owner.local.length, 0);
});
