import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { types } from 'node:util';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/services/classpilotHeartbeatPreparedReads.ts', import.meta.url), 'utf8');
function fixture() {
  let owned; let rls = true; let rejectQuery, decodeFailure, queryGate;
  let screenshotRows = [{ evidence: { stage: 'session_missing' } }];
  const calls = [], prepares = [];
  const client = { status: 'I', getTransactionStatus() { return this.status; } };
  const database = {
    async transaction(work) {
      calls.push('BEGIN'); client.status = 'T';
      try { const value = await work({ select() {} }); calls.push('COMMIT'); return value; }
      catch (error) { calls.push('ROLLBACK'); throw error; }
      finally { client.status = 'I'; }
    },
  };
  const builder = name => (db, values) => ({
    execute: async () => { calls.push([name, values, db]); if (rejectQuery) throw rejectQuery; return [{ ...values }]; },
    prepare(preparedName) {
      assert.equal(preparedName, ''); prepares.push([name, db]);
      return { execute: async bindings => {
        calls.push([name, bindings, db]); if (queryGate) await queryGate;
        if (rejectQuery) throw rejectQuery;
        return name === 'Screenshot' ? screenshotRows : [{ ...bindings }];
      } };
    },
  });
  const builders = Object.fromEntries(['School', 'License', 'Session', 'Control', 'Candidate'].map(name => ['heartbeat' + name + 'Query', builder(name)]));
  const exports = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'drizzle-orm') return { sql: { placeholder: name => ({ name }) } };
    if (name.endsWith('/tenantContext.js') && name.includes('/db/')) return { rlsGucEnabled: () => rls };
    if (name.endsWith('/tenantContext.js')) return { getOwnedTenantStore: () => owned };
    if (name.endsWith('classpilotHeartbeatReadQueries.js')) return builders;
    if (name.endsWith('classpilotHeartbeatScreenshotEvidence.js')) return {
      heartbeatScreenshotEvidenceQuery: builder('Screenshot'),
      decodeHeartbeatScreenshotEvidence(value) { if (decodeFailure) throw decodeFailure; return structuredClone(value); },
    };
    throw Error(name);
  } });
  const setSchool = schoolId => owned = { schoolId, client, db: database, isSuper: false };
  setSchool('school-a');
  return { api: exports, client, database, calls, prepares, setSchool,
    get store() { return owned; }, setRls(value) { rls = value; }, reject(error) { rejectQuery = error; },
    rows(value) { screenshotRows = value; }, decodeReject(error) { decodeFailure = error; }, gate(value) { queryGate = value; } };
}

test('prepared metadata is client/database scoped while every lease gets fresh values', async () => {
  const f = fixture();
  for (const school of ['school-a', 'school-b']) {
    f.setSchool(school);
    await f.api.withHeartbeatPreparedReadTransaction(f.database, school, async tx => {
      const result = await f.api.readHeartbeatSchool(tx, school);
      assert.equal(result[0].schoolId, school);
      await f.api.sealHeartbeatPreparedReads(tx);
      f.api.assertHeartbeatPreparedReadsSettled(tx);
    });
  }
  assert.equal(f.prepares.length, 1);
  assert.equal(f.calls.filter(x => x === 'COMMIT').length, 2);
});

test('recognized closed or wrong-tenant transactions never fall through to fresh reference SQL', async () => {
  const f = fixture(); let retained;
  await f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    retained = tx; await f.api.readHeartbeatSchool(tx, 'school-a'); await f.api.sealHeartbeatPreparedReads(tx);
  });
  const before = f.calls.length;
  assert.throws(() => f.api.readHeartbeatSchool(retained, 'school-a'), /no longer owned/);
  assert.equal(f.calls.length, before);
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    assert.throws(() => f.api.readHeartbeatSchool(tx, 'school-b'), /tenant mismatch/);
    await f.api.sealHeartbeatPreparedReads(tx);
  }), /tenant mismatch/);
});

test('captured store mutation and acknowledged external nesting are refused', async () => {
  const f = fixture();
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    f.store.db = {}; assert.throws(() => f.api.readHeartbeatSchool(tx, 'school-a'), /no longer owned/);
    await f.api.sealHeartbeatPreparedReads(tx);
  }), /no longer owned/);
  f.setSchool('school-a'); f.client.status = 'T';
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async () => assert.fail()), /exclusive owned root/);
});

test('an early unawaited query rejection remains sticky before delivery and commit', async () => {
  const f = fixture(); const failure = Error('read_failed'); f.reject(failure); let delivered = false;
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    void f.api.readHeartbeatSchool(tx, 'school-a'); await new Promise(resolve => setImmediate(resolve));
    await f.api.sealHeartbeatPreparedReads(tx); delivered = true;
  }), error => error === failure);
  assert.equal(delivered, false); assert.equal(f.calls.includes('COMMIT'), false);
});

test('sealing owns a chained orphan projection and refuses its next SELECT', async () => {
  const f = fixture(); let release; const gate = new Promise(resolve => release = resolve); let delivered = false;
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    void f.api.trackHeartbeatPreparedReadTask(tx, async () => {
      await f.api.readHeartbeatSchool(tx, 'school-a'); await gate;
      return f.api.readHeartbeatLicense(tx, 'school-a');
    });
    await new Promise(resolve => setImmediate(resolve));
    const seal = f.api.sealHeartbeatPreparedReads(tx); release(); await seal; delivered = true;
  }), /phase is closed/);
  assert.equal(delivered, false); assert.equal(f.calls.some(x => Array.isArray(x) && x[0] === 'License'), false);
  assert.equal(f.calls.includes('COMMIT'), false);
});

test('whole-task non-SELECT rejection blocks delivery even after its SELECT settled', async () => {
  const f = fixture(); const failure = Error('owner_projection_failed'); let delivered = false;
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    void f.api.trackHeartbeatPreparedReadTask(tx, async () => {
      await f.api.readHeartbeatSchool(tx, 'school-a'); throw failure;
    });
    await new Promise(resolve => setImmediate(resolve)); await f.api.sealHeartbeatPreparedReads(tx); delivered = true;
  }), error => error === failure);
  assert.equal(delivered, false); assert.equal(f.calls.includes('COMMIT'), false);
});

test('an optional catch cannot erase post-seal ownership failure before final delivery', async () => {
  const f = fixture(); let delivered = false;
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    await f.api.sealHeartbeatPreparedReads(tx);
    try { f.api.readHeartbeatSchool(tx, 'school-a'); } catch { /* Optional SQL rollback cannot reset mandatory state. */ }
    f.api.assertHeartbeatPreparedReadsSettled(tx); delivered = true;
  }), /phase is closed/);
  assert.equal(delivered, false); assert.equal(f.calls.includes('COMMIT'), false);
});

test('unregistered and RLS-off callers retain fresh reference builders', async () => {
  const f = fixture(); const foreign = { select() {} };
  await f.api.readHeartbeatSchool(foreign, 'school-a');
  f.setRls(false);
  await f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    await f.api.readHeartbeatSchool(tx, 'school-a'); await f.api.sealHeartbeatPreparedReads(tx);
  });
  assert.equal(f.prepares.length, 0);
});

const screenshotBinding = schoolId => ({ schoolId, studentId: schoolId + '-student',
  studentSessionId: schoolId + '-session', deviceId: schoolId + '-device' });

test('screenshot reader returns synchronous undefined only for genuine reference callers', async () => {
  for (const mode of ['unregistered', 'RLS-off', 'super']) {
    const f = fixture();
    if (mode === 'unregistered') {
      assert.equal(f.api.readHeartbeatScreenshotEvidenceIfOwned({ select() {} }, screenshotBinding('school-a')), undefined);
    } else {
      if (mode === 'RLS-off') f.setRls(false); else f.store.isSuper = true;
      await f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
        assert.equal(f.api.readHeartbeatScreenshotEvidenceIfOwned(tx, screenshotBinding('school-a')), undefined);
      });
    }
    assert.equal(f.prepares.length, 0); assert.equal(f.calls.some(call => Array.isArray(call)), false);
  }
});

test('screenshot query metadata is reused but caller tuples and decoded values stay fresh across A-B-A', async () => {
  const f = fixture(); const results = [];
  for (const school of ['school-a', 'school-b', 'school-a']) {
    f.setSchool(school);
    await f.api.withHeartbeatPreparedReadTransaction(f.database, school, async tx => {
      const input = screenshotBinding(school), expected = { ...input };
      const result = f.api.readHeartbeatScreenshotEvidenceIfOwned(tx, input);
      assert.ok(types.isPromise(result)); input.studentId = 'mutated-after-call';
      results.push(await result); await f.api.sealHeartbeatPreparedReads(tx);
      const calls = f.calls.filter(call => Array.isArray(call) && call[0] === 'Screenshot');
      assert.deepEqual({ ...calls.at(-1)[1] }, expected);
    });
  }
  assert.equal(f.prepares.length, 1); assert.equal(f.prepares[0][0], 'Screenshot');
  assert.notStrictEqual(results[0], results[2]);
  assert.equal(f.calls.filter(call => call === 'COMMIT').length, 3);
});

test('caught screenshot tenant mismatch is sticky, executes no SQL and never becomes reference fallback', async () => {
  const f = fixture();
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    assert.throws(() => f.api.readHeartbeatScreenshotEvidenceIfOwned(tx, screenshotBinding('school-b')), /tenant mismatch/);
    await f.api.sealHeartbeatPreparedReads(tx);
  }), /tenant mismatch/);
  assert.equal(f.prepares.length, 0); assert.deepEqual(f.calls, ['BEGIN', 'ROLLBACK']);
});

test('recognized sealed and closed screenshot readers stay poisoned before any additional query', async () => {
  const f = fixture(); let retained;
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    retained = tx; await f.api.readHeartbeatScreenshotEvidenceIfOwned(tx, screenshotBinding('school-a'));
    await f.api.sealHeartbeatPreparedReads(tx);
    assert.throws(() => f.api.readHeartbeatScreenshotEvidenceIfOwned(tx, screenshotBinding('school-a')), /phase is closed/);
    f.api.assertHeartbeatPreparedReadsSettled(tx);
  }), /phase is closed/);
  const before = f.calls.length;
  assert.throws(() => f.api.readHeartbeatScreenshotEvidenceIfOwned(retained, screenshotBinding('school-a')), /no longer owned/);
  assert.equal(f.calls.length, before); assert.equal(f.calls.filter(call => Array.isArray(call)).length, 1);
});

for (const cause of ['SQL', 'decoder', 'zero rows', 'two rows']) test(`caught screenshot ${cause} failure remains sticky before delivery`, async () => {
  const f = fixture(), error = new Error('mandatory_' + cause); let delivered = false;
  if (cause === 'SQL') f.reject(error);
  if (cause === 'decoder') f.decodeReject(error);
  if (cause === 'zero rows') f.rows([]);
  if (cause === 'two rows') f.rows([{ evidence: {} }, { evidence: {} }]);
  await assert.rejects(f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    try { await f.api.readHeartbeatScreenshotEvidenceIfOwned(tx, screenshotBinding('school-a')); } catch {}
    await f.api.sealHeartbeatPreparedReads(tx); delivered = true;
  }), cause === 'zero rows' || cause === 'two rows' ? /row count/ : candidate => candidate === error);
  assert.equal(delivered, false); assert.equal(f.calls.includes('COMMIT'), false);
});

test('unawaited screenshot function retains ownership through settlement and caller rollback', async () => {
  const f = fixture(); let release; const gate = new Promise(resolve => { release = resolve; }); f.gate(gate);
  let completed = false;
  const operation = f.api.withHeartbeatPreparedReadTransaction(f.database, 'school-a', async tx => {
    void f.api.readHeartbeatScreenshotEvidenceIfOwned(tx, screenshotBinding('school-a'));
    throw new Error('caller_abort');
  }).finally(() => { completed = true; });
  void operation.catch(() => {});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false); assert.equal(f.calls.includes('ROLLBACK'), false);
    release(); await assert.rejects(operation, /caller_abort/);
    assert.equal(f.calls.at(-1), 'ROLLBACK'); assert.equal(f.client.status, 'I');
  } finally { release(); await Promise.allSettled([operation]); }
});
