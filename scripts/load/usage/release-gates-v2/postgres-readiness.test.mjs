import test from 'node:test';
import assert from 'node:assert/strict';
import { finalPostgresReady, waitForPostgresReady } from './postgres-readiness.mjs';
const startedAt = '2026-10-04T04:00:00.000000001Z';
const initial = '2026-10-04T04:00:01.000000001Z LOG: database system is ready to accept connections';
const marker = '2026-10-04T04:00:02.000000001Z PostgreSQL init process complete; ready for start up.';
const final = '2026-10-04T04:00:03.000000001Z LOG: database system is ready to accept connections';
test('final post-init readiness cannot mistake temporary readiness or channel order', () => {
  assert.equal(finalPostgresReady(initial, { fresh: true, startedAt }), false);
  assert.equal(finalPostgresReady(marker + '\n' + initial, { fresh: true, startedAt }), false);
  assert.equal(finalPostgresReady(marker + '\n' + final + '\n' + initial, { fresh: true, startedAt }), true);
  assert.equal(finalPostgresReady('LOG: database system is ready to accept connections', { fresh: true, startedAt }), false);
});
test('native setup attempts no connection until final postmaster readiness is observed', async () => {
  const logs = [initial, marker + '\n' + initial, marker + '\n' + final];
  let polls = 0, connections = 0, waits = 0;
  const docker = async args => {
    if (args[0] === 'logs') { assert.deepEqual(args.slice(1), ['--timestamps', '--since', startedAt, 'owned']); return logs[polls++]; }
    assert.equal(polls, 3, 'A premature connection would produce a startup FATAL');
    assert.equal(args[0], 'exec'); connections++; return 'accepting connections';
  };
  const result = await waitForPostgresReady({ docker, id: 'owned', owner: 'synthetic-owner', database: 'synthetic-db', startedAt, fresh: true, wait: async ms => { assert.equal(ms, 500); waits++; } });
  assert.equal(result.connectionProbeAfterFinalReadiness, true);
  assert.equal(connections, 1); assert.equal(waits, 2);
});
test('restart readiness ignores earlier starts and preserves the existing bounded attempts', async () => {
  const later = '2026-10-04T05:00:00.000000001Z';
  assert.equal(finalPostgresReady(final, { fresh: false, startedAt: later }), false);
  let logs = 0, connections = 0, waits = 0;
  await assert.rejects(waitForPostgresReady({ docker: async args => { if (args[0] === 'logs') { logs++; return final; } connections++; }, id: 'owned', owner: 'synthetic-owner', database: 'synthetic-db', startedAt: later, fresh: false, wait: async () => { waits++; } }));
  assert.equal(logs, 60); assert.equal(waits, 60); assert.equal(connections, 0);
});
