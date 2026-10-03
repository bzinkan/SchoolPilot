import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/services/storage.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function withClasspilotStudentControlDeliveryAuthorityCore<');
const end = source.indexOf('export async function withClasspilotStudentWebSocketBootstrapAuthority<', start);
assert.ok(start > 0 && end > start);
const executable = ts.transpileModule(source.slice(start, end).replaceAll('export ', '') + '\nwithClasspilotHeartbeatDeliveryAuthority;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
function fixture(fault?: string) {
  const order: string[] = [], counters: string[] = []; let held = false, http = 0, reads = 0;
  const tx = { async execute(query: string) {
    assert.equal(held, true); order.push(query.includes('AS entitled') ? 'final-fence' : query);
    if (fault && query === fault) throw Error('cleanup failure');
    return { rows: query.includes('AS entitled') ? [{ entitled: true, bound: fault !== 'binding', denialReason: 'license_inactive' }] : [{ allowed: true }] };
  } };
  const fn: (binding: object, prepare: () => void, deliver: (claimed: unknown, prepared: unknown, inbox: unknown) => boolean, recovery: undefined, foreground: undefined, request: object | undefined) => Promise<{ authorized: boolean }> = runInNewContext(executable, {
    db: { async transaction(work: (db: typeof tx) => Promise<unknown>) { held = true; order.push('begin'); try { const result = await work(tx); if (fault === 'commit') throw Error('COMMIT failed'); return result; } finally { held = false; order.push('release'); } } },
    sql(strings: TemplateStringsArray, ...values: unknown[]) { return strings.reduce((text, part, index) => text + part + (index < values.length ? String(values[index]) : ''), '').trim(); },
    schools: {}, studentSessions: {}, devices: {}, students: {},
    classpilotEntitledSchoolPredicate() { return 'entitled'; }, currentStudentSessionAuthorityPredicate() { return 'current'; },
    async assertClasspilotEntitled() {}, async lockClasspilotStudentControlAuthorities() {}, async lockClasspilotSsoPolicyDeliveryAuthority() {},
    async hasExactClasspilotTelemetryBinding() { return true; }, assertClasspilotSynchronousAuthorityResult() {},
    ClasspilotTeacherChatBindingLostError: class extends Error {},
    normalizeClasspilotPendingMessageExclusions(values: string[] = []) { return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, 500); },
    recordUsageCapacityCounter(name: string) { counters.push(name); },
    async getPendingMessagesForStudentWithAuthorityLocked(binding: { excludeMessageIds: string[] }, owned: object, clock: string) {
      assert.equal(held, true); assert.equal(owned, tx); assert.equal(clock, 'current'); reads++; order.push('inbox');
      if (fault === 'query' || fault?.startsWith('ROLLBACK')) throw Error('optional body failure');
      assert.deepEqual(Array.from(binding.excludeMessageIds), ['legacy']); return [{ id: 'message' }];
    },
  });
  let outcome: unknown;
  const run = (requested = true) => fn({ schoolId: 'school', studentId: 'student', studentSessionId: 'login', deviceId: 'device' },
    () => { order.push('prepare'); }, (_claimed, _prepared, inbox) => { assert.equal(held, true); http++; outcome = inbox; order.push('http'); return true; },
    undefined, undefined, requested ? { excludeMessageIds: [' legacy ', 'legacy'] } : undefined);
  return { run, order, counters, snapshot: () => ({ held, http, reads, outcome }) };
}
test('optional inbox is inside the owned transaction before mandatory final fence and sync HTTP', async () => {
  const f = fixture(); assert.equal((await f.run()).authorized, true);
  assert.deepEqual(f.order, ['begin', 'prepare', 'SAVEPOINT classpilot_heartbeat_inbox', 'inbox', 'RELEASE SAVEPOINT classpilot_heartbeat_inbox', 'final-fence', 'http', 'release']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.snapshot().outcome)), { checked: true, messages: [{ id: 'message' }] });
});
test('no requested recovery performs no inbox SQL', async () => { const f = fixture(); await f.run(false); assert.equal(f.snapshot().reads, 0); });
test('optional body error is visible, restores its savepoint, and never claims a checked inbox', async () => {
  const f = fixture('query'); await f.run(); assert.deepEqual(f.counters, ['heartbeatOptionalInboxFailures']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.snapshot().outcome)), { checked: false });
  assert.ok(f.order.indexOf('ROLLBACK TO SAVEPOINT classpilot_heartbeat_inbox') < f.order.indexOf('final-fence'));
});
for (const fault of ['ROLLBACK TO SAVEPOINT classpilot_heartbeat_inbox', 'RELEASE SAVEPOINT classpilot_heartbeat_inbox', 'commit']) test(`${fault} failure never resolves as committed`, async () => {
  const f = fixture(fault); await assert.rejects(f.run()); assert.equal(f.snapshot().held, false);
  assert.equal(f.snapshot().http, fault === 'commit' ? 1 : 0);
});
test('mandatory final binding failure cannot deliver selected inbox rows', async () => { const f = fixture('binding'); assert.equal((await f.run()).authorized, false); assert.equal(f.snapshot().http, 0); });
