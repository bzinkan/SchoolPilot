import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/storage.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('storage.ts', source, ts.ScriptTarget.ES2022, true);
const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === 'withClasspilotHeartbeatDeliveryAuthority');
assert.ok(declaration, 'Execute the actual heartbeat-only wrapper');
const executable = ts.transpileModule(declaration.getText(parsed).replace(/^export /, '')
  + '\nwithClasspilotHeartbeatDeliveryAuthority;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const teachingProof = () => ({
  authority: { kind: 'teaching_session', teachingSessionId: 'original-class', controlRevision: 7 },
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(projection) {
  let held = false, reads = 0, published = 0, http = 0;
  const bindings = [], queries = [];
  const connection = { execute: async query => {
    assert.equal(held, true, 'Optional SQL must retain its transaction owner');
    queries.push(query); return { rows: [{ allowed: 1 }] };
  } };
  const run = runInNewContext(executable, {
    withClasspilotStudentControlDeliveryAuthorityCore: async (binding, prepare, deliver, _recover, beforeDelivery) => {
      held = true; bindings.push({ ...binding });
      try {
        const prepared = await prepare(connection);
        await beforeDelivery(connection, prepared);
        http++;
        return { authorized: true, value: deliver([], prepared) };
      } finally { held = false; }
    },
    getClasspilotScreenshotAuthorityProjection: async (binding, transaction) => {
      reads++; assert.equal(transaction, connection); assert.equal(held, true);
      return projection({ binding, held: () => held });
    },
    sql: (parts, ...values) => ({ text: parts.join('?').trim(), values }),
    classpilotStudentControlStates: {}, teachingSessions: {}, studentSessions: {},
    classpilotSupervisionStudents: {}, classpilotSupervisionContexts: {},
    classpilotEntitledSchoolPredicate: () => 'entitled',
    currentStudentSessionAuthorityPredicate: () => 'current-exact-binding',
  });
  const binding = { schoolId: 'original-school', studentId: 'original-student',
    studentSessionId: 'original-binding', deviceId: 'original-device' };
  const foreground = { teachingSessionId: 'original-class', controlRevision: 7,
    publish: async () => { assert.equal(held, true); published++; },
    onFailure: () => assert.fail('No failure expected') };
  return { run: prepare => run(binding, prepare, () => 'HTTP200', undefined, foreground),
    binding, foreground, bindings, queries, state: () => ({ held, reads, published, http }) };
}

test('caller mutation cannot replace the retained exact binding, raw grant or publication target', async () => {
  const raw = teachingProof(), f = fixture(async ({ binding }) => {
    assert.equal(binding.schoolId, 'original-school'); return raw;
  });
  const result = await f.run(async (_connection, read) => {
    f.binding.schoolId = 'replacement-school';
    f.binding.studentSessionId = 'replacement-binding';
    f.foreground.teachingSessionId = 'replacement-class';
    f.foreground.controlRevision = 99;
    f.foreground.publish = async () => assert.fail('Mutable callback replacement must not run');
    const publicProjection = await read();
    publicProjection.authority.teachingSessionId = 'forged-class';
    publicProjection.authority.controlRevision = 99;
  });
  assert.equal(result.foreground.status, 'settled');
  assert.equal(result.foreground.succeeded, true);
  assert.equal(f.state().published, 1);
  assert.equal(f.bindings[0].schoolId, 'original-school');
  assert.equal(f.bindings[0].studentSessionId, 'original-binding');
  const temporal = f.queries.find(query => query.text.startsWith('SELECT'));
  assert.ok(temporal.values.includes('original-school'));
  assert.ok(temporal.values.includes('original-class'));
  assert.ok(temporal.values.includes('original-binding'));
  assert.ok(!temporal.values.some(value => typeof value === 'string'
    && /replacement|forged/.test(value)));
});

test('an initiated but unawaited authority reader settles before its transaction can release', async () => {
  const gate = deferred(), observations = [];
  const f = fixture(async ({ held }) => {
    observations.push(held());
    await gate.promise;
    observations.push(held());
    return teachingProof();
  });
  let readerResult, escapedReader, completed = false;
  const result = f.run(async (_connection, read) => {
    escapedReader = read;
    // Model an internal caller error without creating an unhandled rejection.
    readerResult = read().then(value => ({ value }), error => ({ error }));
    return 'preparation ended without awaiting its initiated reader';
  }).finally(() => { completed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'A pending multi-query projection still owns the transaction');
    assert.equal(f.state().http, 0);
    assert.equal(f.state().held, true);
    gate.resolve();
    const final = await result;
    assert.equal(final.foreground.status, 'fallback', 'An outlived read cannot supply a grant');
    assert.match((await readerResult).error.message, /outlived preparation/);
    assert.deepEqual(observations, [true, true]);
    const reads = f.state().reads;
    await assert.rejects(escapedReader(), /after preparation/);
    assert.equal(f.state().reads, reads, 'An escaped reader cannot start any post-release SQL');
    assert.equal(f.state().published, 0);
    assert.equal(f.state().held, false);
  } finally {
    gate.resolve();
    await Promise.allSettled([result, readerResult]);
  }
});
