import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/storage.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('storage.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set(['withClasspilotStudentControlDeliveryAuthorityCore',
  'withClasspilotStudentControlDeliveryAuthority', 'withClasspilotHeartbeatDeliveryAuthority',
  'withClasspilotStudentWebSocketBootstrapAuthority', 'assertClasspilotHeartbeatDeliveryCurrent']);
const declarations = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && names.has(statement.name?.text)).map(statement => statement.getText(parsed).replace(/^export /, ''));
// The old implementation is deliberately usable as the heartbeat entry point
// so expiry tests demonstrate its behavior, rather than a missing-export error.
const executable = ts.transpileModule(declarations.join('\n') + `\n({
  heartbeat: typeof withClasspilotHeartbeatDeliveryAuthority === 'function'
    ? withClasspilotHeartbeatDeliveryAuthority : withClasspilotStudentControlDeliveryAuthority,
  generic: withClasspilotStudentControlDeliveryAuthority,
  bootstrap: withClasspilotStudentWebSocketBootstrapAuthority,
});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function fixture({ entitled = true, bound = true, reason = 'license_inactive', sqlFailure = false, initialBinding = true } = {}) {
  const order = [], queries = [];
  let held = false, sent = 0;
  const transaction = {
    async execute(query) {
      assert.equal(held, true); order.push('final-clock'); queries.push(query);
      if (sqlFailure) throw new Error('synthetic required SQL failure');
      return { rows: [{ entitled, bound, denialReason: reason }] };
    },
    select() { return { from() { return { where() { return { limit: async () => [] }; } }; } }; },
  };
  const tag = (parts, ...values) => ({ text: parts.join('?'), values });
  const bindingError = class extends Error {};
  const functions = runInNewContext(executable, {
    db: { async transaction(work) {
      held = true; order.push('begin');
      try { const result = await work(transaction); order.push('commit'); return result; }
      catch (error) { order.push('rollback'); throw error; }
      finally { held = false; order.push('released'); }
    } },
    sql: tag, studentSessions: {}, students: {}, devices: {}, schools: {},
    classpilotChatDeliveries: {}, and: (...values) => values, eq: (...values) => values, inArray: (...values) => values,
    classpilotEntitledSchoolPredicate: value => ({ entitlement: value }),
    currentStudentSessionAuthorityPredicate: () => 'canonical-current-session-clock',
    assertClasspilotEntitled: async () => { assert.equal(held, true); order.push('admission-entitlement'); },
    lockClasspilotStudentControlAuthorities: async () => { order.push('student-lock'); },
    lockClasspilotSsoPolicyDeliveryAuthority: async () => { order.push('sso-lock'); },
    hasExactClasspilotTelemetryBinding: async () => { order.push('binding'); return initialBinding; },
    scheduledContextHasClassroomTools: () => false,
    latchPrivateChatLifecycle: async () => { order.push('lifecycle-latch'); },
    ClasspilotTeacherChatBindingLostError: bindingError,
    assertClasspilotSynchronousAuthorityResult: value => assert.ok(!(value instanceof Promise)),
  });
  const invoke = (kind = 'heartbeat', prepareError = false) => functions[kind](
    { schoolId: 'school-a', studentId: 'student-a', studentSessionId: 'session-a', deviceId: 'device-a', freezeSsoPolicy: true },
    async () => { assert.equal(held, true); order.push('prepared'); if (prepareError) throw new Error('required preparation failed'); return 'snapshot'; },
    (_rows, prepared) => { assert.equal(held, true); assert.equal(prepared, 'snapshot'); sent++; order.push('http'); return 'HTTP200'; });
  return { invoke, order, queries, state: () => ({ held, sent }) };
}

for (const reason of ['school_inactive', 'license_inactive']) test(`heartbeat rejects ${reason} crossing after preparation with canonical403 before response`, async () => {
  const f = fixture({ entitled: false, reason });
  await assert.rejects(f.invoke(), error => error.status === 403 && error.code === 'CLASSPILOT_NOT_ENTITLED' && error.reason === reason);
  assert.equal(f.state().sent, 0); assert.equal(f.state().held, false);
  assert.ok(f.order.indexOf('prepared') < f.order.indexOf('final-clock'));
  assert.ok(f.order.includes('rollback'));
});

test('heartbeat final manual binding expiry yields unauthorized and never sends the prepared state', async () => {
  const f = fixture({ bound: false }); const result = await f.invoke();
  assert.equal(result.authorized, false); assert.equal(f.state().sent, 0);
  assert.ok(f.order.includes('rollback'));
});

test('heartbeat required final SQL failure propagates and cannot authorize delivery', async () => {
  const f = fixture({ sqlFailure: true });
  await assert.rejects(f.invoke(), /required SQL failure/);
  assert.equal(f.state().sent, 0); assert.equal(f.state().held, false);
});

test('valid heartbeat uses one final combined statement under original locks immediately before synchronous HTTP', async () => {
  const f = fixture(); const result = await f.invoke();
  assert.equal(result.authorized, true); assert.equal(f.queries.length, 1);
  assert.deepEqual(f.order, ['begin', 'admission-entitlement', 'student-lock', 'binding', 'sso-lock', 'prepared', 'final-clock', 'http', 'commit', 'released']);
  assert.match(f.queries[0].text, /FOR SHARE/);
  assert.ok(f.queries[0].values.includes('school-a'));
  assert.ok(f.queries[0].values.includes('student-a'));
  assert.ok(f.queries[0].values.includes('session-a'));
  assert.ok(f.queries[0].values.includes('device-a'));
});

for (const kind of ['generic', 'bootstrap']) test(`${kind} retains its original two binding fences and does not opt into heartbeat behavior`, async () => {
  const f = fixture({ entitled: false, bound: false }); const result = await f.invoke(kind);
  assert.equal(result.authorized, true); assert.equal(f.state().sent, 1); assert.equal(f.queries.length, 0);
  assert.equal(f.order.filter(item => item === 'binding').length, 2);
  assert.ok(f.order.indexOf('prepared') < f.order.lastIndexOf('binding'));
  assert.ok(f.order.lastIndexOf('binding') < f.order.indexOf('http'));
  assert.equal(f.order[0], kind === 'bootstrap' ? 'lifecycle-latch' : 'begin');
});

test('initial binding denial and required preparation failure never reach final delivery', async () => {
  const denied = fixture({ initialBinding: false });
  assert.equal((await denied.invoke()).authorized, false); assert.equal(denied.queries.length, 0);
  assert.equal(denied.order.includes('prepared'), false);
  const failed = fixture(); await assert.rejects(failed.invoke('heartbeat', true), /preparation failed/);
  assert.equal(failed.queries.length, 0); assert.equal(failed.state().sent, 0); assert.equal(failed.state().held, false);
});

test('only the heartbeat response route selects the fixed wrapper; login retains generic delivery', () => {
  const devices = readFileSync(new URL('../src/routes/classpilot/devices.ts', import.meta.url), 'utf8');
  const start = devices.indexOf('const finalDelivery = await runWithTenantContext');
  const end = devices.indexOf('return finalDelivery.value;', start);
  assert.ok(start >= 0 && end > start);
  assert.match(devices.slice(start, end), /withClasspilotHeartbeatDeliveryAuthority\(/);
  assert.match(devices.slice(0, start), /const delivery = await withClasspilotStudentControlDeliveryAuthority\(/);
});
