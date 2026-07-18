# Heartbeat Index Pivot: Activation and Recovery

This document supports the staged, unmerged heartbeat-index contingency. It is
not an authorization to deploy it. Keep the branch undeployed unless an
otherwise-valid private Waf/800 run fails only the RDS CPU gate, the one-minute
RDS CPU Maximum is 65%–85% inclusive, Performance Insights shows heartbeat
INSERT/UPDATE statements leading, and the evidence below still shows the six
candidate indexes are unused.

Above 85%, when heartbeat writes do not lead Performance Insights, or when any
catalog/evidence precondition is uncertain, do not merge this pivot. Follow the
separately approved RDS-capacity path. Activating this build invalidates the
current certification chain and requires a fresh Waf/500 → Waf/800 chain.

## Pre-merge evidence

Capture two read-only snapshots: one before and one after a representative
observation window that includes normal school traffic, the `:30` heartbeat
purge, and the school-local `02:00` rollup. Do not reset PostgreSQL statistics.
Store the snapshots with the failed gate evidence, not in Git.

```sql
SELECT
  now() AS observed_at,
  datid,
  datname,
  stats_reset
FROM pg_stat_database
WHERE datname = current_database();

SELECT
  now() AS observed_at,
  relid AS table_oid,
  indexrelid AS index_oid,
  indexrelname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch,
  pg_relation_size(indexrelid) AS index_bytes
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND relname = 'heartbeats'
  AND indexrelname IN (
    'heartbeats_timestamp_idx',
    'heartbeats_student_id_idx',
    'heartbeats_student_email_idx',
    'heartbeats_device_id_idx',
    'heartbeats_email_timestamp_idx',
    'heartbeats_school_email_idx'
  )
ORDER BY indexrelname;

SELECT
  now() AS observed_at,
  relid AS table_oid,
  n_tup_ins,
  n_tup_upd,
  n_tup_hot_upd,
  n_dead_tup,
  last_analyze,
  last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND relname = 'heartbeats';
```

Both snapshots must contain exactly six candidate rows. The database OID,
`stats_reset`, heartbeat table OID, each name-to-index-OID mapping, and all six
names must be identical across snapshots. Every cumulative counter
(`idx_scan`, tuple read/fetch, insert, update, and HOT update) must be monotonic.
Calculate candidate `idx_scan` deltas and the HOT ratio from deltas, not
cumulative totals: `Δn_tup_hot_upd / NULLIF(Δn_tup_upd, 0)`.

`pg_stat_reset_single_table_counters()` can reset one table or index without
reliably changing `pg_stat_database.stats_reset`. The evidence therefore also
requires an operator attestation that no privileged per-relation statistics
reset ran during the window. Stable OIDs and nondecreasing counters are
mandatory corroboration, not a substitute for that attestation. Stop and
re-audit on any reset, counter decrease, OID/name replacement, missing/extra
candidate, nonzero candidate `idx_scan` delta, or incomplete observation
window.

Also attach the one-minute RDS CPU Maximum series and tokenized Performance
Insights top-SQL evidence. Historical data is diagnostic only; it cannot seed a
certification chain or independently authorize this change.

The defensible guaranteed benefit is lower index maintenance for heartbeat
INSERTs. Do not promise the same reduction for classification UPDATEs: HOT
updates do not add index entries, and non-HOT update cost depends on the
observed HOT ratio and the columns changed.

## Migration contract

`applyHeartbeatIndexPivotOnline()` runs only from `runStartupMigrations()` when
`RUN_MIGRATIONS_ONLY=true`. Scaled API and worker startup never execute it. The
helper:

- takes a nonblocking session advisory lock and bounds both statement and lock
  waits;
- fails before DDL unless the PK, `(student_id, timestamp)`,
  `(school_id, timestamp DESC)`, and
  `(school_id, device_id, timestamp DESC)` survivors are exact and valid;
- never repairs a missing, invalid, or wrong-shape survivor during pivot
  activation; fresh databases receive the exact school/timestamp survivor from
  the post-pivot Drizzle schema before this one-off helper runs;
- validates table, schema, owner, constraint relationship, access method,
  columns, ordering, included columns, predicate/expression absence, and
  `pg_index` health before changing a named index;
- creates and verifies `public.devices_school_id_idx` concurrently;
- issues six separate schema-qualified `DROP INDEX CONCURRENTLY IF EXISTS`
  statements, allowing a timed-out partial run to resume without a blocking
  fallback;
- verifies all six removals, re-verifies the survivors and device index, then
  analyzes `public.heartbeats` and `public.devices`.

A migration timeout or failed postcondition fails the deployment. Do not mark a
warning as success and do not run these statements from the six scaled service
tasks.

## Post-deploy verification

The migration log must report both the descending heartbeat-history index and
the index pivot ready. Then query the catalog from the one-off migrations path:

```sql
SELECT
  table_class.relname AS table_name,
  idx.relname AS index_name,
  i.indisvalid,
  i.indisready,
  i.indislive,
  pg_get_indexdef(i.indexrelid) AS definition
FROM pg_class AS idx
JOIN pg_index AS i ON i.indexrelid = idx.oid
JOIN pg_class AS table_class ON table_class.oid = i.indrelid
JOIN pg_namespace AS ns ON ns.oid = idx.relnamespace
WHERE ns.nspname = 'public'
  AND idx.relname IN (
    'heartbeats_pkey',
    'heartbeats_student_timestamp_idx',
    'heartbeats_school_timestamp_idx',
    'heartbeats_school_device_timestamp_idx',
    'heartbeats_timestamp_idx',
    'heartbeats_student_id_idx',
    'heartbeats_student_email_idx',
    'heartbeats_device_id_idx',
    'heartbeats_email_timestamp_idx',
    'heartbeats_school_email_idx',
    'devices_school_id_idx'
  )
ORDER BY idx.relname;
```

The four heartbeat survivors and `devices_school_id_idx` must be present,
ready, live, valid, and exact. The six redundant names must be absent. Only
after that catalog check may a fresh Waf/500 → Waf/800 chain start.

## Exact restoration SQL

Application rollback does not recreate removed indexes. If the build is rolled
back or a reader audit discovers a dependency, run each command separately
from a reviewed one-off database session outside a transaction. Do not add a
non-concurrent fallback and do not use `IF NOT EXISTS`, which could conceal an
invalid or structurally different same-name index.

```sql
CREATE INDEX CONCURRENTLY heartbeats_timestamp_idx ON public.heartbeats USING btree (timestamp);
CREATE INDEX CONCURRENTLY heartbeats_student_id_idx ON public.heartbeats USING btree (student_id);
CREATE INDEX CONCURRENTLY heartbeats_student_email_idx ON public.heartbeats USING btree (student_email);
CREATE INDEX CONCURRENTLY heartbeats_device_id_idx ON public.heartbeats USING btree (device_id);
CREATE INDEX CONCURRENTLY heartbeats_email_timestamp_idx ON public.heartbeats USING btree (student_email, timestamp);
CREATE INDEX CONCURRENTLY heartbeats_school_email_idx ON public.heartbeats USING btree (school_id, student_email);
ANALYZE public.heartbeats;
```

After every create, verify the exact definition and `indisvalid`, `indisready`,
and `indislive` before continuing. `devices_school_id_idx` is additive and may
remain through an application rollback; remove it only through a separate
reviewed catalog-change decision.
