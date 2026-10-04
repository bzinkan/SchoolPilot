import assert from 'node:assert/strict';
import { pause } from './application.mjs';

function timestampNs(value) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
  assert.ok(match);
  const milliseconds = Date.parse(match[1] + 'Z'); assert.ok(Number.isFinite(milliseconds));
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
export function finalPostgresReady(log, { fresh, startedAt }) {
  assert.equal(typeof log, 'string');
  const marker = 'PostgreSQL init process complete; ready for start up.';
  const start = timestampNs(startedAt), records = [];
  for (const line of log.split(/\r?\n/)) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\s+(.*)$/);
    if (match) { const at = timestampNs(match[1]); if (at >= start) records.push({ at, text: match[2] }); }
  }
  const markers = records.filter(record => record.text.trim() === marker).map(record => record.at);
  const initializedAt = markers.reduce((latest, at) => latest === null || at > latest ? at : latest, null);
  if (fresh && initializedAt === null) return false;
  // Docker stdout/stderr can be concatenated out of chronology. Compare
  // exact Docker nanosecond timestamps, never channel byte order.
  return records.some(record => (!fresh || record.at > initializedAt) && /\bLOG:\s+database system is ready to accept connections\s*$/.test(record.text));
}

// First observe the owned final postmaster readiness. A pre-readiness
// connection attempt can itself emit FATAL while PostgreSQL is starting.
// Whole private logs remain classified without any FATAL exclusion.
export async function waitForPostgresReady({ docker, id, owner, database, startedAt, fresh, wait = pause }) {
  let ready = false, attempts = 0;
  for (; attempts < 60; attempts++) {
    const log = await docker(['logs', '--timestamps', '--since', startedAt, id]);
    if (finalPostgresReady(log, { fresh, startedAt })) {
      await docker(['exec', id, 'pg_isready', '-h', '127.0.0.1', '-p', '5437', '-U', owner, '-d', database]);
      ready = true; break;
    }
    await wait(500);
  }
  assert.equal(ready, true, 'Owned final PostgreSQL postmaster did not become ready within the existing readiness attempts');
  return { finalPostmasterReadinessObserved: true, attempts: attempts + 1, connectionProbeAfterFinalReadiness: true };
}
