# Separate school-day load profile

The initial review baseline was `60f33dbcf93b6901ac038c2d0066f79fbd9632a4`;
the latest observed main head while recording this evidence was
`d4f3f232be7529ac4d584c2559768e6ad1b5421a`. Every measurement captures its own
candidate source revision and file hashes. The later main changes contain
deployment safety/docs and the equivalent dependency lock correction.

This profile measures two schools concurrently, each with 1,000,000 unique raw
heartbeats, using the corrected usage writer/reader. It does not replace the
immutable 500,000-grain stress fixture or its failed capacity result. Run it with
PowerShell 7.5 using `scripts/load/usage/run-local-school-day-scale.ps1` and a
fresh external `-OutputDirectory`. The shared guarded runner creates only its
generated loopback fixture, applies the unchanged 4 CPU/4 GiB PostgreSQL caps
and Node 512 MiB old-space cap, and removes that exact container afterward.
An existing nonempty output directory or file is rejected before any writes,
so rerunning a command cannot replace an earlier failure's evidence. The bulk
seed uses the registered per-student device and verifies exactly 500 valid
student/device/session bindings per school. Optional `-HoldFixtureForDiagnostics`
permits bounded local EXPLAIN work and retains the exact ownership cleanup.

The ten-second cadence is the actual ClassPilot source constant
`extension/service-worker.js:605` (`HEARTBEAT_INTERVAL_MS = 10000`).
The inspected ClassPilot revision was
`853af87168b548dad09a9de68d305d1b5e9d439a`; the source file SHA-256 was
`e69a241c7d26635a429c1653c3ef89cfd19b57e4b8ef10157f3345ed29870b7c`.
Each of 500 students has 2,000 observations over 5 hours 33 minutes. There are no duplicate
raw observations. Domains dwell for 3 minutes 20 seconds: eight domains per
student, 200 across the school. Stored classifications and teacher-intent
exemptions deliberately exercise all three retained categories within each
domain; this is a synthetic capacity workload, not observed school behavior.

Six 50-minute frozen lessons start hourly, leaving 10-minute passing gaps. A
five-student cohort rotates across six class groups. The frozen historical
rosters represent membership at each lesson; current-day enrollment/devices
retain their separate current cohort. This deliberately keeps a large small-
group class/teacher inventory. It does not claim that 100 teachers is typical
staffing for 500 students. Every student has one class at a time; passing time
counts for the student without a class. A class sees six five-student cohorts
(30 different students) over the day. The last period is partly observed.

| Per-school table or result | Expected count |
| --- | ---: |
| Students / current devices / student sessions | 500 each |
| Official classes / teachers / current teaching sessions | 100 each |
| Heavy-day teaching sessions / frozen roster rows | 600 / 3,000 |
| Historical teaching sessions / frozen roster rows | 36,100 / 180,500 |
| Total teaching sessions / frozen roster rows | 36,800 / 184,000 |
| Historical aggregate rows over 361 dense days | 541,500 |
| Heavy-day raw and unique observations | 1,000,000 each |
| Heavy-day retained aggregate grains | 84,000 |
| Heavy-day monitored seconds / heartbeat count | 10,002,500 / 1,000,000 |
| One student's monitored seconds / grains | 20,005 / 168 |
| Grade monitored seconds / grains | 2,000,500 / 16,800 |
| Class monitored seconds / grains / distinct students | 85,025 / 720 / 30 |

The historical reader fixture has 541,500 precomputed grains per school. It does
not measure a retained year repeating this heavy day: 365 such days would have
30,660,000 grains per school. Passing the offered maximum-range queries cannot
establish capacity for that denser retained history.

The independent oracle sums the declared observations and nonoverlapping frozen
windows. It checks category/heartbeat/student counts, grain counts, daily totals
and ranked domain sums at every scope. Expected domain lists are prepared before
timing, so the oracle does not create measured server load. The full 366-day
inclusive API range must be accepted and the next longer range rejected; the
365-day retention boundary, successful empty day and unavailable gap remain
distinct. Sixty-four actual reports run alongside both complete day rewrites
and four actual authenticated HTTP ingest clients. Post-phase raw observation
oracles, eight scoped CSV exports with strict audits, current-day scopes and
cross-school denials remain required.

Acceptance requires both whole rewrite operations, including connection
checkout, lock, delete, attribution, inserts, ledger write and commit, below
60 seconds. Every recorded API query must stay below 15 seconds and every API
checkout below 5 seconds, with no failures. Driver measurements conservatively
include client queue and event-loop delay. Successful local measurements do not
establish RDS I/O, fleet scheduling, Redis distribution, device behavior or
production rollout readiness. Dense AI-decision and tracking-exclusion capacity
remains unmeasured. The valid extreme 500,000-grain stress day remains a known
60-second write limitation even if this separate school-day profile passes.

The first run at `6b797ffa3596f7b046998ff5d5c8fffb1da7c273` failed and is
preserved in `scripts/load/usage/evidence-school-day-failed-20260930.json`.
Both 84,000-grain writers reached the 60-second server timeout (63-second
client wall time), with zero committed heavy aggregates or completion. Seven
of 64 reports returned 500: three report SQL cancellations and four checkout
failures; the API collector recorded six checkout failures overall and two
ingest clients received 500. Report SQL peaked at 22,107 ms. Read-only
attribution afterward took 15,121 ms. The measured phase wrote 3,660,749,240
temporary bytes across 162 files, which may contribute to concurrent pressure;
this does not isolate a single cause. Post-phase raw oracles, all scoped CSVs
and audits, successful empty/gap/expired semantics and cross-school denials
passed. Bulk historical device IDs in this first run were synthetic; the
follow-on fixture binds them to registered student devices without changing
raw count, schedule, categories, domains or quotas. This initial failure is
not a school-day capacity pass and remains immutable.

The second run at `2ed5107027f93290625405a359aa61a34d790b8a` passed and is
preserved in `scripts/load/usage/evidence-school-day-passed-20260930.json`.
It ran from `2026-09-30T23:20:34.440Z` to `23:25:58.758Z`; the accepted
concurrent phase is measured separately from fixture preparation and diagnostic
EXPLAIN. Both complete writers committed 84,000 rows, 10,002,500 seconds,
1,000,000 observations and one completion row per school. All 64 reports
returned 200 and matched the independent scope/category/domain oracle. All
recorded API statements and acquisitions succeeded.

| Measured operation | Slowest observed | Existing deadline | Margin below deadline |
| --- | ---: | ---: | ---: |
| Complete heavy-day worker operation | 46,857 ms | 60,000 ms | 21.9% |
| Report SQL, full supported date range | 4,414 ms | 15,000 ms | 70.6% |
| API connection acquisition (5,836 calls) | 267 ms | 5,000 ms | 94.7% |

School report HTTP maxima were 4,743/4,726 ms; grade 3,372/3,380 ms,
class 571/566 ms and student 355/735 ms. The four authenticated ingest clients
made 906 requests (905 successful writes and one accepted 204), with 453/452
observations stored through the two post-phase cutoffs. Current-day raw oracles,
eight CSVs with strict audits, tenant denials, successful empty days and
unavailable/expired gaps passed. Peak Node RSS was 288.9 MiB; this is an
observation, not an RSS quota. PostgreSQL retained the exact 4 CPU/4 GiB caps,
forced RLS and a non-owner, non-superuser, non-bypass application role. The
runner exited zero and removed its exact generated container and volumes after
bounded read-only diagnostics.

The production reader and writer file hashes are identical between these two
school-day runs. The second fixture changes bulk device IDs to registered
bindings, validates those bindings before timing, and adds the fresh-output
guard and optional diagnostic hold. Counts, session schedule, categories,
domains, oracle, deadlines and resource caps are unchanged. Both used fresh
containers and ANALYZE. This comparison does not isolate a cause for their
timing difference; cache, storage and planner variability remain possible.
One passing local run does not establish repeatable fleet capacity or erase
the preceding failure or the still-failing 500,000-grain stress profile.

Additional read-only, warm serial EXPLAIN comparisons on the second fixture
matched all returned school/grade rows. An unadopted empty-AI/exclusion guard
prototype reduced attribution from 11,092 to 9,213 ms; a report preaggregation
prototype reduced the school query from 2,721 to 1,664 ms and grade query from
474 to 360 ms. These diagnostics were outside the measured concurrent phase,
used the same restricted role and did not write fixture data. They are not
capacity results or production changes. Full plans and execution/resource
metadata remain in the external run14 evidence directory; the committed
result includes the actual accepted attribution plan and all measured API
families. Dense AI/exclusion, fleet/device and operational gates remain open.

A fresh repeat at `6401cf2256033e0e28a3c8759fc2815686bd9d75` stopped during
second-school fixture preparation with SQLSTATE `57014`, before any measured
phase. Its immutable record is
`scripts/load/usage/evidence-school-day-preparation-failure-20260930.json`.
It has no worker/query/correctness acceptance measurements; the earlier
collector does not identify which preparation statement timed out. This is a
preparation failure, not evidence for or against measured workload headroom.
The runner cleaned its exact generated container and storage. Subsequent
preparation labels record the stage and bound the large privileged raw seed to
50 school-global student ordinals (100,000 observations) per statement. The
independent window test covers all 500 ordinals once, including partial batches.
The eventual observation set, timestamps, domain/categories, valid device
bindings and measured application queries/concurrency remain unchanged; no
deadline or cap is extended. ANALYZE and complete cardinality/binding checks
still precede timing. The original preparation failure is never overwritten.

The bounded-preparation repeat at
`571de4bb7abfe83db6010582a258474bb964123e` completed preparation and **failed**
the measured phase. Its immutable record is
`scripts/load/usage/evidence-school-day-repeat-failed-20260930.json`.
Both heavy insertions canceled at 60,032 ms and rolled back all heavy aggregates
and completion rows. Six of 64 reports returned 500: two report-query and four
transaction-family `57014` errors. Report SQL peaked at 15,140 ms and transaction
calls at 34,869 ms; API acquisition had no failures and a 208 ms maximum.
All post-phase independent raw/scope/CSV/audit, tenant and empty/gap/expired checks
passed. The capped fixture was cleaned up. Preparation batching changed no
measured application code or offered workload; the production source hashes
still match the isolated earlier pass. Consequently reproducible school-day
headroom is **not established**. The pass, both measured failures and the
separate preparation failure remain visible; subsequent query corrections must
receive correctness/RLS review and fresh unchanged-cap measurements.

The approved fast paths in draft PR #586 were measured at profile revision
`6b5725da91ebe1503984d98ca2bc34c247928750`. This fresh run passed, preserved
byte-for-byte in `scripts/load/usage/evidence-school-day-fast-paths-passed-20261001.json`.
It ran from `2026-10-01T00:32:31.135Z` to `00:41:20.807Z`; preparation
took 385,123 ms outside the 60,096 ms concurrent phase. The device-bound
fixture, independent oracle, concurrency, resource caps, constraints and
deadlines are identical to the preceding bounded-preparation repeat. Only
the reviewed reader/writer queries and their regression tests change runtime
behavior. Deployment-only foundation reconciliation changes neither usage
runtime nor the workload. The initial review main was `60f33dbcf93b6901ac038c2d0066f79fbd9632a4`;
the reconciled main was `d4f3f232be7529ac4d584c2559768e6ad1b5421a`.

| Measured operation | Slowest observed | Existing deadline | Margin below deadline |
| --- | ---: | ---: | ---: |
| Complete heavy-day worker operation | 52,864 ms | 60,000 ms | 11.9% |
| Report SQL, full supported date range | 9,031 ms | 15,000 ms | 39.8% |
| API connection acquisition (2,890 calls) | 642 ms | 5,000 ms | 87.2% |

Both writers committed all 84,000 grains, 10,002,500 seconds, one million
observations and one completion row per school. All 64 reports returned 200;
all measured SQL families and acquisitions had zero failures. The four
authenticated ingest clients offered 437 requests: 436 returned 200 and one
returned the accepted 204; 218 observations per school were stored through
the post-phase cutoffs. All independent raw/category/domain/scope/CSV/audit,
cross-school and empty/gap/expired checks passed. Peak Node RSS was 280.3 MiB.
The temporary I/O counters increased by 3,139,556,622 bytes across 199 files.
The subsequent read-only attribution plan took 8,016 ms; the frozen original
baseline attribution still reached its 60-second timeout. These diagnostics
are outside the accepted concurrent phase. The runner exited zero and removed
the exact generated capped fixture and volumes.

The measured production files match PR #586 exactly. Their LF file SHA-256
values are writer `63c8b5e2b20ae8f1b4a396b9b926523ff38c9cac16f88665865a73838c7f57c0`,
reader `70154cd4947ab9da998fd24d9c4e52a3a7ef0696c27135fa2ecaa3a7dddebc0c`
and unchanged heartbeat route `a4422a3f1a92245560fe1fab88282193a4c740e727a7b1f6cc8e842805bc30ea`.
Git blobs and runtime semantics are identical across the two branches;
Windows checkout line endings can produce different filesystem hashes.

Full external evidence is at
`C:/Users/zinka/AppData/Local/Temp/schoolpilot-usage-school-day-20260930-run17-fast-paths`.
The raw/committed JSON SHA-256 is `35fc4167585e3fe52bc0f9aa4f0fe3f79b99afb945eb2b2ab6ad3fce6e34688c`,
execution metadata is `ac9109b1e8a60fc48bc84596a1d99f28cfc345c932cb0618cf4c7fd6f7938bd0`
and resource-cap metadata is `a21234603f7ac3bf23945b8e2ad0b4122e1f913754bb400dec4721c3171c6025`.

This is one passing measurement of the revised queries, not proof of repeatable
fleet capacity. The earlier isolated pass, both measured school-day failures,
preparation failure and 500,000-grain stress failure remain immutable. This
profile has no in-window AI decisions; its new presence guard cannot establish
the nonempty lookup's capacity. A separately named 10,000-decision-per-school
scenario is required to measure that path. Dense AI/exclusion histories, the
30.66-million-grain retained year, RDS, fleet, device and operational gates
remain open.

An unchanged repeat at `01bf34bc8c4522e9393c66033187f5546e859912` also passed,
preserved byte-for-byte in
`scripts/load/usage/evidence-school-day-fast-paths-repeat-passed-20261001.json`.
It ran from `2026-10-01T01:06:59.660Z` to `01:12:28.820Z`; preparation
took 185,448 ms outside the 60,106 ms concurrent phase. All production and
measured harness hashes, declared workload, limits, constraints and caps match
the preceding fast-path pass. The intervening commit adds only that run's
immutable evidence and documentation. The schema-only dump differs solely in
its generated psql restrict/unrestrict nonce; its DDL is identical.

Both complete workers committed the same 84,000 grains, 10,002,500 seconds,
one million observations and one completion row per school in 28,042/28,387 ms.
All 64 reports returned 200, every measured SQL/acquisition succeeded and all
independent correctness/CSV/audit/tenant/atomicity gates passed. Report SQL
peaked at 4,160 ms; 6,546 acquisitions peaked at 414 ms. The four ingest clients
offered 1,039 requests (1,038 returned 200 and one accepted 204), with 519
observations per school stored through the post-phase cutoffs. Peak Node RSS
was 287.6 MiB. Temporary counters increased by 3,134,741,916 bytes across 196
files. Subsequent read-only attribution took 7,375 ms; the frozen original
baseline again reached the 60-second timeout. Cleanup completed with exit zero.

Across these two passes, the conservative observed margins remain those of
the slower run: worker 7,136 ms / 11.9%, report SQL 5,969 ms / 39.8% and
acquisition 4,358 ms / 87.2%. The worker range is 28,042–52,864 ms and fixture
preparation also varied substantially. Identical source/DDL and fresh capped
containers do not isolate a cause; storage, cache and planning variation remain
possible. These are two successful local repeats of the empty-AI school-day
profile, not a guarantee for a broader workload or RDS/fleet environment.
Every earlier failure and the 500,000-grain/dense-year limits remain explicit;
the separately named nonempty-AI scenario has not yet been measured.

External repeat evidence is at
`C:/Users/zinka/AppData/Local/Temp/schoolpilot-usage-school-day-20260930-run18-fast-paths-repeat`.
The raw/committed JSON SHA-256 is `f2742ac51cc865f3928f0b1fb9c75f46c7b587389581ec26960e67c7c1f5d39e`,
execution metadata is `b538d93dfc5fb02c93823c29c6831dcabc7a8dd087046dd6c21bd9b661ebc86e`
and resource-cap metadata is the same `a21234603f7ac3bf23945b8e2ad0b4122e1f913754bb400dec4721c3171c6025`.

A separate scenario named `six-lessons-200-domains-1m-unique-10k-ai` is available
through `scripts/load/usage/run-local-school-day-ai-scale.ps1`, using a fresh
external output directory. It retains the same raw observations, device
bindings, sessions, 84,000-grain arithmetic oracle, reader history, concurrent
work and all resource/deadline/constraint/cleanup gates. The original school-day
and stress entry points retain their original workloads; both measured empty-AI
harness revisions remain recoverable in the commits named above.

Before timing, the new scenario inserts exactly 20 decisions per student at
samples 0, 100, ..., 1900: 10,000 per school, one every 16 minutes 40 seconds.
Each decision binds that school's exact existing student, device, heartbeat and
URL, with a created-at timestamp one second after the observation and the same
category/teacher intent. This deliberately leaves the independent category and
grain oracle unchanged while making the school's in-window presence predicate
true. SQL validation requires all 10,000 distinct heartbeat bindings, 500
students with exactly 20 decisions each, zero mismatched fields and forced RLS
on the AI table before ANALYZE and the concurrent phase. Counts/bindings and the
separate scenario name are retained in its result.

This measures matching-category nonempty-AI lookup performance; it does not by
itself prove overridden-category semantics or negative AI-row visibility. Those
remain covered by the real SQL/reference and restricted-role regression suites;
the scheduler worker intentionally uses its established privileged GUC. A sparse
10,000-row decision history also cannot establish dense AI/exclusion capacity.
No capacity result for this separately named scenario is claimed before an
actual capped run completes. Its measurement is held until the next coordinated
quiet window.
