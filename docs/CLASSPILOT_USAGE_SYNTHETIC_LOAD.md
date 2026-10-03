# Local Monitored Browser Time workload evidence

The local synthetic workload completed on September 30, 2026 against source `50fd8dad1601ca9af54e0fefe90793676170d61a`, based on corrected preparation revision `cd27927b`. It verifies the actual one-day aggregate writer and actual authenticated HTTP reporting/export routes under forced RLS. Production capacity and operational activation gates remain open.

## Fixture and execution

The fixture contains two synthetic schools, 500 students, two official classes with frozen teaching-session rosters, one million raw heartbeat rows, 500,000 distinct student/second observations, 10,000 AI decisions and 50,000 expired heartbeats. Every observation is duplicated across two synthetic devices. The independently calculated totals are 7,500,000 monitored seconds: 3,750,000 instructional, 1,875,000 off-task and 1,875,000 unknown. Newest AI decisions, teacher-intent exemptions, class attribution and all school/grade/class/student totals are checked.

The runner creates a unique empty local database from a schema-only copy of the already migrated synthetic usage test database. Only fixture setup uses a disposable privileged role. Application queries use a non-owner `NOSUPERUSER NOBYPASSRLS NOINHERIT` role. The relevant heartbeat, aggregate and completion tables have enabled and forced RLS. The API uses its normal 16-connection pool; a separate five-connection scheduler pool uses the existing 60-second statement timeout. Local worker queries use the normal worker `app.is_super` GUC. Actual HTTP administrator identity, school context, entitlement, license and role checks run; a foreign-school request is denied.

The driver and HTTP server share one Windows Node process. PostgreSQL 16.15 runs in local Docker with 128 MB shared buffers, 4 MB work memory and 100 maximum connections. Docker CPU and memory quotas are unset. Redis is disabled. Fixture insertion takes 40.67 seconds and is excluded from the writer/read/retention timings. The measured writer uses an empty exclusion list; exclusion correctness has separate regression coverage, but exclusion-heavy capacity is unmeasured here.

## Observed results and deadlines

| Operation | Local result | Comparison with existing limit |
|---|---:|---|
| Live day transaction | 30.57 s | At least 29.43 s below the 60 s per-statement limit |
| Final transaction overlapping 32 reads | 28.41 s | At least 31.59 s below the 60 s per-statement limit |
| Writer INSERT with EXPLAIN ANALYZE instrumentation | 43.56 s | 16.44 s (27.4%) below the 60 s per-statement limit |
| Sequential school / grade / class / student HTTP p95 | 55 / 56 / 31 / 52 ms | Eight samples per scope; nearest-rank p95 is the observed maximum |
| 32 concurrent school HTTP reads | p95/max 367 ms | Observed end-to-end maximum leaves at least 4.63 s below the 5 s API connection-acquisition limit and 14.63 s below the 15 s API statement limit |
| Audited CSV export | 36.86 ms, 993 bytes | Strict export audit row verified |
| Bounded retention | 1.41 s | 50,000 expired rows, ten non-empty 5,000-row batches plus one empty batch; 100 ms yield after each non-empty batch |
| Node RSS peak | 240.1 MiB | Includes driver and HTTP server; excludes PostgreSQL and Docker memory |
| Pool queue peak | API 16; scheduler 0 | Burst queued successfully; this is not evidence of zero queue pressure |

These comparisons bound the observed operation times. They do not redefine the deadlines or provide a production safety margin. API timings include authentication and multiple queries, so individual statement/acquisition durations were not measured separately. The writer's measured transaction and instrumented INSERT are separate runs and should not be averaged.

The actual INSERT plan uses the existing student/timestamp heartbeat index and spills several sorts to disk. The instrumented statement records 104,060 temporary read blocks and 138,337 temporary written blocks at the root, with external merge sorts using 137,048 / 75,792 / 92,032 / 60,408 KiB. The complete workload's asynchronous PostgreSQL statistics report approximately 2.03 GiB of temporary bytes in 24 files. These counters include two rewrites and a rolled-back instrumented INSERT, not one ordinary write. Frozen-session attribution performs substantial nested-loop work. The retained read plan is explicitly a representative day-grouping query; HTTP latency measures the actual reporting route. Neither the low read latency nor writer completion resolves RDS storage/I/O or large-school headroom.

Correctness assertions also cover successful empty-day completion distinct from an internal hole, snapshot-consistent reads while replacement runs, strict audited export, foreign-school denial and atomic aggregate/completion retention. The generated database and both roles were removed automatically, and a follow-up catalog check found none remaining.

## Reproduce safely

Use the local `schoolpilot-db` Docker container on port 5435 and a synthetic schema source already prepared with the corrected immutable migrations and RLS setup. The source database is never seeded, updated or deleted by this runner. Use a clean committed checkout with installed dependencies and an external evidence directory:

```powershell
node --test scripts/load/usage/local-usage-benchmark.test.mjs
pwsh -NoProfile -File scripts/load/usage/run-local-usage-benchmark.ps1 `
  -SchemaDatabase schoolpilot_redesign_usage_20260930 `
  -OutputDirectory C:\Users\zinka\AppData\Local\Temp\schoolpilot-usage-benchmark-new-run
```

The runner rebuilds the backend, records the exact source revision and hashes, creates only a fresh database matching its generated fixture prefix, gives each run fresh disposable role credentials through process environment, checks empty fixture/forced RLS/non-owner privileges, executes the workload, saves external JSON/log/schema/host evidence and cleans up. It refuses remote databases, wrong ports, a nonfixture target and missing explicit local opt-in. Evidence inside the checkout is rejected before fixture I/O. After the measured run, a runner-only follow-up tightened that output guard and partial-role cleanup and limited console output to benchmark events; workload source and application source are unchanged. Three guard/summary tests pass. Plain backend build passed for the measured run. No application, schema, runtime mode, lockfile or production resource changes belong to this slice.

The compact checked-in result is `scripts/load/usage/evidence-20260930.json`; full plans and local logs are retained externally under `C:\Users\zinka\AppData\Local\Temp\schoolpilot-usage-benchmark-20260930-run2`. The earlier run failed only because the fixture supplied `id` rather than the required JWT `userId`; the corrected harness now authenticates before inserting the large fixture.

## Gates still open

The hourly worker stops taking new usage work at UTC minute 25 before the minute-30 purge. This test calls the real one-day writer, not the entire heavy-job loop: the preceding daily-usage job, two concurrent school writers, all eligible schools, yesterday/today queue ordering, deadline deferral and fleet completion inside that budget require a separate production-equivalent workload. Do not extrapolate a supported school or Chromebook count from this run.

Long retained ranges, high domain/session cardinality, many overlapping sessions, exclusion-heavy days, larger AI histories, ingestion concurrent with aggregation, repeated cold/warm runs, Redis behavior, production-sized CPU/memory quotas, RDS IOPS/storage/temp-file pressure and contention with other scheduled work are unverified capacity gates. Managed Chromebook acceptance, all required CI, actual serving source/RLS admission, runtime Plan/review/Apply, operational alarm evidence and rollout/rollback verification remain separate gates. No historical backfill was performed or authorized. This evidence does not authorize production enablement.
