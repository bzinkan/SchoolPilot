import assert from 'node:assert/strict';

export const RELEASE_PG_APPLICATION_NAMES = Object.freeze({ api: 'usage_release_api', worker: 'usage_release_worker', observer: 'usage_release_observer' });
export const POSTGRES_PRESSURE_SAMPLE_INTERVAL_MS = 1000;
export const POSTGRES_PRESSURE_MAX_SAMPLES = 180;

// Only fixed configuration and aggregate PostgreSQL counters. No SQL text,
// connection strings, identities, table contents or settings mutation.
export const POSTGRES_PRESSURE_SQL = `SELECT clock_timestamp()::text AS observed_at,
  jsonb_build_object(
    'server_version_num', current_setting('server_version_num'),
    'fsync', current_setting('fsync'), 'synchronous_commit', current_setting('synchronous_commit'),
    'full_page_writes', current_setting('full_page_writes'), 'wal_sync_method', current_setting('wal_sync_method'),
    'wal_compression', current_setting('wal_compression'), 'max_wal_size', current_setting('max_wal_size'),
    'checkpoint_timeout', current_setting('checkpoint_timeout'), 'shared_buffers', current_setting('shared_buffers'),
    'track_wal_io_timing', current_setting('track_wal_io_timing'), 'track_io_timing', current_setting('track_io_timing')
  ) AS settings,
  (SELECT jsonb_build_object('stats_reset', stats_reset::text,
    'wal_records', wal_records::text, 'wal_fpi', wal_fpi::text, 'wal_bytes', wal_bytes::text,
    'wal_buffers_full', wal_buffers_full::text, 'wal_write', wal_write::text, 'wal_sync', wal_sync::text,
    'wal_write_time', wal_write_time::text, 'wal_sync_time', wal_sync_time::text) FROM pg_stat_wal) AS wal,
  (SELECT jsonb_build_object('stats_reset', stats_reset::text,
    'checkpoints_timed', checkpoints_timed::text, 'checkpoints_req', checkpoints_req::text,
    'checkpoint_write_time', checkpoint_write_time::text, 'checkpoint_sync_time', checkpoint_sync_time::text,
    'buffers_checkpoint', buffers_checkpoint::text, 'buffers_clean', buffers_clean::text,
    'maxwritten_clean', maxwritten_clean::text, 'buffers_backend', buffers_backend::text,
    'buffers_backend_fsync', buffers_backend_fsync::text, 'buffers_alloc', buffers_alloc::text) FROM pg_stat_bgwriter) AS bgwriter,
  (SELECT jsonb_build_object('stats_reset', stats_reset::text,
    'xact_commit', xact_commit::text, 'xact_rollback', xact_rollback::text,
    'blks_read', blks_read::text, 'blks_hit', blks_hit::text,
    'tup_returned', tup_returned::text, 'tup_fetched', tup_fetched::text,
    'tup_inserted', tup_inserted::text, 'tup_updated', tup_updated::text, 'tup_deleted', tup_deleted::text,
    'temp_files', temp_files::text, 'temp_bytes', temp_bytes::text, 'deadlocks', deadlocks::text,
    'blk_read_time', blk_read_time::text, 'blk_write_time', blk_write_time::text)
    FROM pg_stat_database WHERE datname = current_database()) AS database`;

export const POSTGRES_ROLE_WAITS_SQL = `SELECT
  CASE WHEN application_name IN ('usage_release_api','usage_release_worker','usage_release_observer')
    THEN application_name ELSE 'other' END AS role,
  COALESCE(state,'unknown') AS state, COALESCE(wait_event_type,'none') AS wait_type,
  COALESCE(wait_event,'none') AS wait_event, COUNT(*)::int AS count
FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`;

const COUNTERS = Object.freeze({
  wal: ['wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full', 'wal_write', 'wal_sync'],
  bgwriter: ['checkpoints_timed', 'checkpoints_req', 'buffers_checkpoint', 'buffers_clean', 'maxwritten_clean', 'buffers_backend', 'buffers_backend_fsync', 'buffers_alloc'],
  database: ['xact_commit', 'xact_rollback', 'blks_read', 'blks_hit', 'tup_returned', 'tup_fetched', 'tup_inserted', 'tup_updated', 'tup_deleted', 'temp_files', 'temp_bytes', 'deadlocks'],
});
const TIMINGS = Object.freeze({ wal: ['wal_write_time', 'wal_sync_time'], bgwriter: ['checkpoint_write_time', 'checkpoint_sync_time'], database: ['blk_read_time', 'blk_write_time'] });

export function postgresPressureSnapshot(row) {
  assert.ok(row && typeof row.observed_at === 'string' && Number.isFinite(Date.parse(row.observed_at)));
  assert.ok(row.settings && ['on', 'off'].includes(row.settings.track_wal_io_timing) && ['on', 'off'].includes(row.settings.track_io_timing));
  const snapshot = { observedAt: row.observed_at, settings: { ...row.settings } };
  for (const [group, keys] of Object.entries(COUNTERS)) {
    const raw = row[group];
    assert.ok(raw && (raw.stats_reset === null || typeof raw.stats_reset === 'string'));
    const counters = Object.fromEntries(keys.map(key => {
      assert.match(raw[key], /^\d+$/, `Invalid ${group}/${key} counter`);
      return [key, raw[key]]; // Preserve integer precision beyond Number.MAX_SAFE_INTEGER.
    }));
    const timingAvailable = group === 'bgwriter' || row.settings[group === 'wal' ? 'track_wal_io_timing' : 'track_io_timing'] === 'on';
    const timingsMs = timingAvailable ? Object.fromEntries(TIMINGS[group].map(key => {
      assert.match(raw[key], /^\d+(?:\.\d+)?$/, `Invalid ${group}/${key} timing`);
      const value = Number(raw[key]); assert.ok(Number.isFinite(value)); return [key, value];
    })) : null;
    snapshot[group] = { statsReset: raw.stats_reset, counters, timingAvailable, timingsMs };
  }
  return snapshot;
}

export async function readPostgresPressure(pool) {
  const result = await pool.query(POSTGRES_PRESSURE_SQL);
  assert.equal(result.rows.length, 1);
  return postgresPressureSnapshot(result.rows[0]);
}

export function postgresPressureDelta(baseline, final, samples = []) {
  const sequence = [baseline, ...samples, final];
  const settingsStable = sequence.every(snapshot => JSON.stringify(snapshot.settings) === JSON.stringify(baseline.settings));
  const groups = {};
  for (const [group, keys] of Object.entries(COUNTERS)) {
    const resetConsistent = sequence.every(snapshot => snapshot[group].statsReset === baseline[group].statsReset);
    const countersMonotonic = sequence.slice(1).every((snapshot, index) => keys.every(key =>
      BigInt(snapshot[group].counters[key]) >= BigInt(sequence[index][group].counters[key])));
    const timingAvailable = sequence.every(snapshot => snapshot[group].timingAvailable);
    const timingsMonotonic = !timingAvailable || sequence.slice(1).every((snapshot, index) => TIMINGS[group].every(key =>
      snapshot[group].timingsMs[key] >= sequence[index][group].timingsMs[key]));
    const valid = resetConsistent && countersMonotonic && timingsMonotonic && settingsStable;
    groups[group] = { valid, resetConsistent, countersMonotonic, timingsMonotonic, timingAvailable,
      counters: valid ? Object.fromEntries(keys.map(key => [key, (BigInt(final[group].counters[key]) - BigInt(baseline[group].counters[key])).toString()])) : null,
      timingsMs: valid && timingAvailable ? Object.fromEntries(TIMINGS[group].map(key => [key, final[group].timingsMs[key] - baseline[group].timingsMs[key]])) : null };
  }
  return { valid: settingsStable && Object.values(groups).every(group => group.valid), settingsStable, groups,
    semantics: 'Read-only counters from the owned PostgreSQL instance; statistics are asynchronously published and are not exact per-operation attribution. WAL/bgwriter counters are instance-wide; database counters cover this fixture. Timing disabled means unavailable, never a measured zero.' };
}
