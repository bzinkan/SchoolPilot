import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('local comparison exercises reused sockets and reports its limited evidence scope', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/local/device-telemetry-loopback.mjs',
    '--clients=4', '--rounds=2', '--json'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.clients, 4);
  assert.equal(result.http.successfulOperations, 8);
  assert.equal(result.websocket.successfulOperations, 8);
  assert.equal(result.http.recurringHttpRequests, 8);
  assert.equal(result.websocket.recurringHttpRequests, 0);
  assert.equal(result.websocket.upgrades, 4);
  assert.equal(result.databaseExercised, false);
  assert.equal(result.awsCapacityAccepted, false);
});
