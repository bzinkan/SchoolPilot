import assert from 'node:assert/strict';
import test from 'node:test';
import { localHeartbeatPrefixIndexSource, redactHeartbeatPrefixIndexOutput } from '../scripts/test/heartbeat-prefix-index-native.mjs';

test('owned native index runner admits only the existing explicit loopback PostgreSQL ports', () => {
  for (const host of ['localhost','127.0.0.1','[::1]']) for (const port of ['5432','5435']) {
    assert.equal(localHeartbeatPrefixIndexSource(`postgres://user:synthetic@${host}:${port}/source`).hostname,host);
  }
  for (const invalid of ['', 'not a URL', 'https://localhost:5435/source', 'postgres://user@rds.example:5435/source',
    'postgres://user@localhost:5433/source', 'postgres://user@localhost/source',
    'postgres://user@localhost:5435/source?host=rds.example', 'postgres://user@localhost:5435/source#redirect']) {
    assert.throws(() => localHeartbeatPrefixIndexSource(invalid));
  }
});

test('native fixture logs redact all credential URLs and standalone password sentinels', () => {
  const secret = 'SYNTHETIC_PASSWORD';
  const source = `postgres://user:${secret}@localhost:5435/source`;
  const target = `postgresql://user:${secret}@localhost:5435/owned`;
  const output = redactHeartbeatPrefixIndexOutput(`failed ${source} and ${target} password=${secret}`, [source, target, secret]);
  assert.ok(!output.includes(secret)); assert.ok(!output.includes('postgres://')); assert.ok(!output.includes('postgresql://'));
  assert.ok(output.includes('[REDACTED'));
});

test('quoted credentials cannot leave a password suffix behind URI redaction', () => {
  const password = "SYNTHETIC'INDEX_PASSWORD";
  const url = `postgres://user:${password}@localhost:5435/source`;
  for (const secrets of [[],[url,password]]) {
    const output=redactHeartbeatPrefixIndexOutput(url,secrets);
    assert.ok(!output.includes('INDEX_PASSWORD'));
    assert.ok(!output.includes('localhost'));
  }
});
