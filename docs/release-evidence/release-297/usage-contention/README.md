# Usage contention correction evidence

These records preserve development checks and failures before the final source
freeze. They do not establish capacity acceptance or authorize deployment.

Latest application `e95a2b56476b1225434c1b0f3907db46c9d84fe3` adds the per-student
exact-URL domain map measured below. [Implementation evidence](domain-map-implementation-e95a2b56/manifest.json)
preserves all three native attempts and the initial typecheck failure. Final
checks pass 1,906 unit cases, 25 owner and 12 restricted native cases with zero
skips, plus build/type/cast checks. All 1,243 captured source files are identical
before and after verification. The new native scenarios compare all nine
semantic grain columns to immutable b112 SQL and exercise actual atomic writes
and restricted tenant isolation. PostgreSQL/Redis container removal passed;
the runner requested exact-owner `--volumes` removal, but did not independently
enumerate anonymous-volume absence. The [fresh e95 image](candidate-artifact-e95a2b56/manifest.json)
passes an uncached build, a pinned scan with zero findings and embedded
compatibility checks. Its permanent export and identities are hash-verified.
No capacity run is accepted. The [e95 frontend binding](frontend-e95-binding-01/receipt.json)
verifies unchanged source blobs and retained artifact bytes.

The e95 CI rollout lane failed its live Eastern-clock equality probe across a
minute boundary. [The test-only correction](clock-minute-boundary-01/manifest.json)
retains the failed job and brackets the production helper call with independent
before/after clock values, logging all three. The real Git Bash probe passes;
forced minute/day transitions pass, the original equality fails at the forced
minute transition, and an incorrect clock result is still rejected. Production
`deploy.sh` is unchanged. Because the original failure did not log its two
values, its precise minute-boundary cause remains an inference. Complete CI
after this test correction is still required.

The [combined e95 diagnostic](linux-role-combined-e95-01/manifest.json) fails
capacity at 4,413/6,000 successful heartbeats, 949 failures, 638 in-flight refusals
and zero late offers (maximum offer lateness 44.39 ms). All 64 reports pass,
with maximum request duration 11.47 seconds. Whole worker operations take
12.284/30.984 seconds and each preserves the independent 84,000 grains,
10,002,500 seconds and one million observations. Current observations, coverage,
tenant isolation and eight audited exports agree with the independent checks.
Both drains complete with zero remaining owners or aborted responses; all six
containers and the recorded PostgreSQL anonymous volume are verified absent.
The coordinator exits 1 unforced for the failed run; other roles exit 0 unforced.

API CPU uses 65.736 seconds over 67.377 elapsed seconds; event-loop utilization
is 0.9725. Acquisitions fail 950 times, including 949 heartbeat paths and one
tenant-request path. The lock-screen HTTP 500 has only a matching generic
`errorType: Error` log. The one tenant-request checkout failure is consistent
with its cause, but no per-request exception or stack proves that attribution.
Final delivery retains 4,413 leases with 96,089 statements; driver-timed SQL
includes network/server/event-loop delays and cannot identify server CPU.
PostgreSQL records 317.283 MB WAL and 502.213 MB temporary data; no exact-operation
attribution follows from those instance counters. A bounded current-source API
CPU profile is next. Earlier b112 results are descriptive comparisons, not
repeated controlled attribution. The same-source premeasurement snapshot is
private; its later restore proof is separate from this immutable failed packet.

Preceding application `b11202fc305198d76e73c5e6d711b7dc9ed2d938` reuses five
public Drizzle SELECT definitions on an exclusively owned heartbeat connection.
Every execution retains fresh bindings, canonical decoding and database locks;
whole mandatory read tasks must settle before delivery. Recognized expired or
sealed transaction tokens cannot fall through to an unguarded reference read.
[Implementation evidence](heartbeat-prepared-reads-implementation-01/manifest.json)
preserves 1,906 passing unit tests with no skips, 50 owner and 50 restricted-role
native tests, four restricted private-recovery tests, and build/type/cast checks.
The initial failing test run and fixture setup failure remain in the packet.
The [final source binding](heartbeat-prepared-reads-implementation-01/final-binding.json)
records the trailing-whitespace cleanup and identical rebuilt JavaScript.
Full combined capacity has failed; zero capacity runs are accepted.
Its [fresh local candidate image](candidate-artifact-b11202fc/manifest.json)
passes `--pull --no-cache`, the pinned scan with zero findings, embedded
129-table/lifecycle compatibility checks and exact-owned cleanup. The permanent
image export is retained at
`C:/Users/zinka/.codex/artifacts/release297-candidate-b11202fc-01`.
No registry publication, deployment or accepted capacity is implied.
The [frontend binding](frontend-b112-binding-01/receipt.json) verifies all 632
tracked frontend input blobs still match the prior successful aggregate/build
receipt and the retained artifact hash is unchanged. This is an equivalence
check, not a new browser run or live backend/frontend acceptance.
CI at `4d0ae92f` subsequently found one remaining source assertion in the
ordinary database lane that expected the old inline entitlement queries.
[The follow-up](runtime-entitlement-selector-followup-01/manifest.json) retains
the failed job, updates the assertion to the canonical same-school shared-lock
builders and passes all 27 focused tests. Application bytes are unchanged.
[CI at review head `a109fd27`](ci-a109fd27-final-01/manifest.json) passes all 17
jobs and three security workflows, including rollout-tool validation. This
exact-head evidence does not include the new uncommitted role harness or
establish Usage capacity.

The [combined b112 diagnostic](linux-role-combined-b112-01/manifest.json) failed: 3,020 of
6,000 offered heartbeats succeeded, 2,095 failed and 885 were refused at the
in-flight ceiling; 199 offers were late. All 64 reports passed. Complete worker
operations took 25.049 and 47.561 seconds, including admission and cleanup.
There were 2,096 database acquisition failures: 2,095 on heartbeat paths and
one on the classroom lifecycle path, which failed before acceptance. Independent
totals, coverage, tenant isolation and eight audited CSV checks passed. Physical
owners drained and all six owned containers were removed. This is valid failed
diagnostic evidence, not an accepted capacity run or a proven connection leak.
Three consecutive final-source passes and the original comparison remain required.

The same run recorded 314.36 MB of PostgreSQL WAL and 467.85 MB of temporary
data. Samples show API WAL-write waits during bulk rollups and substantial
connection hold time. Driver-await durations include database wait, JavaScript
resumption and decoding; they are not database CPU time. Asynchronous PostgreSQL
statistics cannot establish exact write timing, and the failed lifecycle HTTP
500 lacks a retained exact exception. No leak, prepared-read regression or host
pause cause is established. The subsequent exact rollup plan investigation and
domain-map experiment are recorded below.

The [local candidate/fallback recovery proof](recovery-pair-b112-6e251/manifest.json) passed
for b112 candidate → 6e251 fallback → b112 candidate. Actual bundled image
functions preserved separate thread-close, school-hard-off and activity-hard-off
expiration, delivered history, and Stop Focus cleanup without removing other
restrictions. A separate source migration rehearsal retained 53 migration IDs
and 129 forced-RLS tables through re-entry. Both Usage modes stayed off. These
checks used synthetic fixtures; they do not establish the actual production
catalog, service-traffic rollback, Redis/browser behavior or recovery below the
Usage coverage correction. All failed setup attempts and independent cleanup
proof remain preserved.

The immutable b112 prepared snapshot remains private. Its separate
[native restore proof](snapshot-restore-b112-01/manifest.json) now verifies the
full schema after native PostgreSQL rendering, 53 migration entries, 129 forced
RLS tables, exact data/control/identity bindings, standard ANALYZE, closed
clients and a 16-minute authority-expiry horizon without refreshing timestamps
or credentials. Both failed validation attempts remain preserved. The restored
fixture was consumed by an isolated query diagnostic and its container removed; it cannot
qualify as a capacity run. Future restores require their own proof and fresh
password login/session prewarm, followed by the documented PostgreSQL restart.
This does not flush the host filesystem cache. The strict three-run acceptance
validator and its native receipt producers remain under development. Those
historical restore owners did not request anonymous-volume removal; their
cleanup receipts prove container absence only. The reusable owner must verify
exact owned-volume cleanup separately.

The [b112 rollup plan and URL-map experiment](rollup-domain-prototype-b112-01/manifest.json)
records an isolated actual-image rewrite in 13.443 seconds, with 84,000 stored
grains, 10,002,500 seconds and one million observations matching the independent
oracle. PostgreSQL execution was 13.366 seconds. Grain computation consumed
9.246 seconds inclusive; the WindowAgg's elapsed residual after its child sort
was about 4.524 seconds, which is not a regex-only CPU measurement. Roster winner
computation was about 119 ms. Writes generated 171.88 MB of WAL; the plan does
not partition heap, index and foreign-key WAL. No constraint/index change was
selected.

A separate rollback-only component comparison evaluates the unchanged domain
expression once per distinct exact URL per student. All nine semantic columns
match in both directions for all 84,000 grains; exclusion boundaries, 63 URL/
classification edge rows and 6,000 all-distinct URL rows also match. Warm grain
query times are 5.555/5.827 seconds for the prototype versus 9.050 seconds for
the warmed baseline (35.6–38.6% lower). The first baseline took 20.553 seconds;
its cause is not established and it is not used to claim the gain. These are
component timings, not a full writer or combined-capacity result.

The all-distinct normalization kernel regresses from 28.022 to 41.495 ms,
an increase of 13.473 ms (about 48%) across 6,000 rows. The selected implementation
therefore targets repeated URLs and is not a universal speedup. Production
integration, native regression checks and new full combined capacity evidence
remain required. Timeline/AI/roster semantics, writes, schema, RLS, cutoffs and
resource limits must remain unchanged. Both diagnostic fixtures were consumed
and removed; neither is reusable as a cold capacity run.

The [Linux prepared-query component comparison](heartbeat-prepared-linux-prototype-01/manifest.json)
uses exact `0e427e3c` runtime bytes, one API CPU, 2 GiB container memory and the
historical 512 MiB old-space cap. All 15 native tests pass; the preceding failed
fixture attempt, denied timing gate and cleanup receipts are retained. Across
three alternating rounds of 1,000 eight-read sequences, canonical median CPU
time is 3,963.9 ms versus 1,913.9 ms for five public Drizzle unnamed prepared
SELECTs with the raw fences unchanged. This is component evidence, not a full
heartbeat throughput forecast or accepted load run. The selected approach
retains the canonical encoders and result mappers. The faster raw-driver
alternative is not selected. [Earlier Windows experiments](heartbeat-prepared-windows-prototype-01/manifest.json)
remain separate because their timing variation and runtime differ.

The [candidate-default runtime diagnostic](linux-role-ingest-candidate-default-0e427-01/manifest.json)
also fails on unchanged `0e427e3c` application bytes: 5,116/6,000 offered
heartbeats succeeded, 260 failed and 624 were refused; zero offers were late.
The API recorded 260 acquisition failures, 67.347 CPU seconds over a
67.885-second phase and 0.99094 event-loop utilization. All connection and
request owners drained, the role processes exited zero, the coordinator
correctly exited one and all six owned containers were removed. Removing
the historical 512 MiB API old-space override did not resolve saturation.
The API's measured heap limit was 1,048 MiB under the unchanged 2 GiB
container limit; worker and driver heap limits were 524 MiB. This explicitly
named successor preserves the historical profile and original seeder.
Candidate-image startup defaults are verified locally; live ECS command or
environment overrides remain unverified. No capacity pass is claimed.
The private synthetic prepared snapshot is retained outside Git with its
source, schema, control and count evidence. Restore validation is required
before any new test can use it; it is not a production backup.

Preceding application `0e427e3c` includes the [Focus wire and semantic-equality
correction](focus-status-wire-297-01/manifest.json): 64 focused cases, 15
restricted-role database cases and build/type/cast checks pass. The actual
2.9.7 ZIP remains unchanged. [Lifecycle harness evidence](focus-lifecycle-harness-01/manifest.json)
records 61 passing guards and exact public state verification before synthetic
command completion. No browser enforcement or capacity pass is claimed.
[CI on `5d031512`](ci-5d031512-final-01/manifest.json) passes all 17 CI jobs and
three security workflows for application `0e427e3c`. Later application changes
and the resulting merged main still require their own checks.
The October 3 [unprofiled ingestion diagnostic on `0e427e3c`](linux-role-ingest-unprofiled-0e427-01/manifest.json) also fails:
5,139/6,000 offered heartbeats succeeded, 144 failed and 717 were refused at
the unchanged in-flight ceiling. Zero offers were late. API CPU was 70.991
seconds over a 71.138-second phase, with 0.99877 event-loop utilization;
144 physical checkout failures and zero SQL failures were recorded. All
request/connection owners drained, all three child processes exited zero,
the coordinator correctly exited one, and all six owned containers were
removed. The result establishes saturation without a CPU profiler, but
different application sources prevent a controlled profiler-overhead comparison.
The modest SELECT-construction trial remains unadopted. This ingestion-only
diagnostic is not one of the three required combined acceptance runs.

The [exact helper and workload bindings](role-harness02-unprofiled-0e427-01/manifest.json)
preserve the unchanged arrival contract, separate capped role containers,
restricted application role and the root-released cold-start nonce. The
[scanned local `0e427e3c` image](candidate-artifact-0e427e3c/manifest.json)
and 21-file permanent artifact are preserved. This diagnostic image used
documented build-cache reuse; it is not selected as the final release artifact.

[Fallback source `6e251f2d`](rollback-focus-wire-01/manifest.json) backports only
the Focus correction and corresponding regression evidence. The red baseline,
61 passing focused cases, 13 restricted-role cases, build/type/cast successes
and retained 129-table/lifecycle/default-off floor are preserved. Its
[fresh local image](rollback-artifact-6e251f2d/manifest.json) now passes an
uncached build, pinned scan with zero findings, embedded compatibility and
Focus checks, and cleanup. The image export and its distinct index, Linux
platform and configuration digests are preserved in the permanent artifact
directory. Both Usage modes must remain off. Final-source recovery pairing
and registry publication remain unperformed.

Current October 3 checkpoint: the [resource-bounded `9630c009` diagnostic](linux-role-combined-9630-01/manifest.json)
fails capacity: 2,704/6,000 heartbeats and 34/64 reports succeeded; complete
historical rollups took 39.326/57.768 seconds including admission wait.
Historical/current-day totals, coverage and eight audited CSV checks passed.
Pool instrumentation double-observes Promise acquisition calls in that source;
raw counter totals must not be described as unique acquisitions. HTTP failures
remain independently measured. CPU throttling and database write pressure are
observed, with no demonstrated ownership leak or deadlock. All owned containers
were removed; coordinator exit status was lost through a harness race and is
unavailable. Application source was unchanged at completion. This is diagnostic
evidence, not an accepted capacity run.

[Exact `9630c009` CI](ci-9630c009-final-01/manifest.json) passes all 17 jobs and
three security workflows. [Local full backend checks](fair-main-pool-final-backend-01/manifest.json)
pass 1,863 unit cases (four conditional skips) and 699 infrastructure cases.
The [subsequent public-connect correction](fair-main-pool-public-connect-followup-01/manifest.json)
at `5d543f40` removes duplicate instrumentation without changing lease ownership.
It passes 54 focused cases, eight native cases, both application database roles,
build/type/cast checks and 1,864 unit cases with four conditional skips.
Its [exact local image](candidate-artifact-5d543f40/manifest.json) passes the full
pinned scan and embedded compatibility checks. Neither that image nor earlier
artifacts establish accepted capacity, registry publication or deployment.

Earlier checkpoints below preserve their source-specific results and failures.

The [identity scheduling correction](fair-main-pool-user-identity-01/manifest.json)
at `6035239b` adds a third fair lane only for fresh user identity lookups.
Reports retain their own lane, heartbeat entitlement remains ordinary work,
and limits/deadlines/ownership are unchanged. Regression results are red on
the previous scheduler, then 66 focused passes, eight native driver cases,
owner/restricted application passes and 1,868 unit passes with four conditional
skips. Build/type/cast checks pass. This corrects the observed pre-admission
identity starvation; it does not establish heartbeat throughput or remove
other authorization work from the ordinary queue.
[CI on `2378e04e`](ci-2378e04e-final-01/manifest.json) passes all 17 CI jobs and
three security workflows for these application bytes; full capacity acceptance
remains required.

The subsequent [resource-bounded ingestion CPU diagnostic at `5d543f40`](linux-role-ingest-cpu-5d54-01/manifest.json)
fails without concurrent reports or historical rollups: 4,158/6,000 heartbeat
offers succeed, 1,087 fail and 755 are refused. The actual driver records zero
late offers (maximum 35 ms). API CPU totals 67.94 seconds over a 68.07-second
measurement and 1,087 acquisition failures occur. SQL sampling predominantly
finds API client waits, with no recorded lock-wait group. The profile supports
reducing repeated query construction and transport work; it does not justify
caching permission results or weakening authority fences. The corrected host
receipt truthfully records coordinator exit 1, with unforced child shutdown and
all six owned containers removed. This profiled diagnostic cannot count as
combined acceptance. Raw data and the explicitly documented 1-microsecond
profile-timestamp anomaly remain preserved.

[Harness version 02 and driver calibration](linux-role-harness02-calibration-01/manifest.json)
preserve the coordinator exit-receipt correction, owned profile-output proof,
and both failed artificial burst-stress calibrations. The driver-only change
to two CPUs leaves API/worker/PG resources unchanged. Those artificial stress
cases explain driver behavior and do not add a new release prerequisite;
actual offered traffic, deadlines, correctness and original acceptance gates
remain authoritative.

The [fair main-pool scheduler](fair-main-pool-scheduler-01/manifest.json) preserves
the complete prototype failure history and final typed integration proof.
Report and other acquisitions use alternating FIFO queues in the existing API
pool when Usage reporting is admitted and on. Worker/session pools and the
reporting-off API are unchanged. Build, type and cast checks pass; focused tests
pass 38/38, native driver tests 8/8, and the actual application test passes once
under each owner/restricted role with no skips. It verifies tenant GUC cleanup,
ordering and report cancellation ownership. The configured logical connection
cap and five-second caller deadline remain unchanged. Closing sockets retain
native pg behavior and are tracked until actual end; no stricter socket ceiling
or performance improvement is claimed. Full combined checks and capacity on
this new application source are pending.

The [per-role startup archive](linux-role-startup-01/manifest.json) preserves
154 verified records, including three failed build preparations and the
successful resource-bounded startup on `204ae93d`. API main/session pools warmed
to 16/2 and worker to five; all four role containers exited cleanly and all six
owned containers were removed. It sent no workload requests or rollups.
Capacity remains unproven. The [final `9fc4b0e` CI record](ci-9fc4b0e-final-01/manifest.json)
records 16 successful jobs, one superseded/cancelled rollout job and three
successful security workflows; cancellation is not a passed full CI run.

The [exact `9630c009` local candidate](candidate-artifact-9630c009/manifest.json)
passes the pinned full security scan with zero findings and embedded
compatibility/default-off checks. Its verified image archive is preserved in
the permanent local artifact directory; the Git record retains hashed build,
scan and compatibility receipts. It is not a registry or deployment artifact,
and build/scan success does not establish capacity.

The earlier [Linux combined diagnostic at `204ae93d`](linux-combined-204-01/manifest.json)
fails: 4,840/6,000 heartbeats succeed, with 974 failed requests, 186 refused and
140 late offers; 51/64 reports succeed. Both historical workers return correct
totals in 19.107/42.142 seconds. There are 978 acquisition failures and 10 aborted
responses, so the drain gate fails even though physical ownership reaches zero.
Current-day and audited CSV checks are not reached; final source-equivalence
completion is also unavailable rather than asserted. Owned Docker cleanup passes.
The raw result SHA-256 is
`35071a7294b217a32fadba258ddc34291c9c194a2f33d109720b24c88352adf6`.
The accompanying exact image passes the pinned full scan with zero findings and
embedded compatibility checks. No performance improvement is inferred from this
mixed failure, and no deployment or capacity approval follows.

[CI at `204ae93d`](ci-204ae93d.json) passes all three security workflows and
16 CI jobs. The rollout-safety job fails because the startup-probe test records
`monitor_exception` instead of its expected specific fatal reason. Investigation
is ongoing; the failing run is retained and is not classified as a flake.

The [test-only failure-evidence follow-up](rollout-failure-diagnostics/manifest.json)
retains bounded, redacted mock logs before cleanup and uploads them on CI failure.
Five diagnostics assertions and 169 targeted startup/start-gate assertions pass;
the original exception did not reproduce and remains unidentified. CI now checks
the capture contract before running the full existing suite, with all original
assertions. The production monitor is unchanged.

The [subsequent `35712eb` CI record and listing correction](test-lane-listing-flush/manifest.json)
preserve 15 successful CI jobs, two failed jobs and three successful security
workflows. Infrastructure governance exposed truncated lane-list output on Linux:
the runner exited before its piped stdout had flushed. Awaiting the write fixes
the exact Linux reproduction; its new regression is red against the old runner
and green against the correction. Windows passes both and is not claimed as a
red reproduction. The corrected local checkpoint passes 1,825 unit cases
(four existing skips) and all 699 infrastructure cases on 1,171 unchanged source
files. The separate rollout fixture failure now has captured diagnostics: its
configured generator binding was no longer live when the monitor checked it.
The evidence does not establish whether expiry or another binding mismatch
caused that condition.

The [four-fixture lifetime correction](rollout-live-harness-lifetime/manifest.json)
keeps each mock generator alive until owner release or verified rollback
containment. Readiness binds its actual process identity; release is atomic.
The full default rollout suite passes 380 assertions, with 15 lifecycle and five
failure-evidence assertions also passing. The targeted helper failure remains
preserved. No production monitor, rollback behavior or timeout changes are
included. Fresh full CI remains required; the original binding subcause and
older monitor exception are not retroactively declared resolved.

The [inbox owner projection](inbox-projection/manifest.json) reduces the teaching
inbox authority reads from five to two while retaining the fresh control-row
lock, current database clock, canonical roster ranking and every delivery fence.
It adds a content-free inbox-attempt counter. Twenty-seven focused cases and
21 native cases under each role pass. The subsequent full build, type/cast
checks and 1,824 unit cases pass on 1,170 unchanged source files; four conditional
skips remain named. The equivalent full recovery now uses 24 SQL statements and
one lease, versus the original 33 statements/two leases and preceding fused
27 statements/one lease. This is query-count evidence, not measured capacity.

The [92307780 CI checkpoint](ci-92307780.json) passes all four workflows and all
17 CI jobs. Its application/build inputs match `d6492333`; later application
changes require their own checks. Conditional skips remain skips.

The [Linux combined diagnostic](load-linux-combined-01/manifest.json), on the
same `d6492333` application, completed all 5,652 started heartbeats but refused
348 of the 6,000 offers and recorded five late offers. Only 38 of 64 reports
succeeded. Both historical workers returned correct totals in 15.582/36.344
seconds, with zero database acquisition failures. Twenty-three aborted responses
prevented drain certification despite zero physical owners; current-day and CSV
checks did not run. Owned-resource cleanup passed separately. API CPU use was
82.221 seconds over 69.510 seconds elapsed. This is failed diagnostic evidence,
not capacity acceptance: API/worker/generator were separate Linux processes in
one unrestricted container, with the existing pools, heaps and database limits.
Network/runtime topology and completed work differ from Windows, so this does
not isolate a causal performance improvement. The [helper preparation record](linux-diagnostic-preparation/manifest.json)
retains exact runtime/source bindings, failed preparation attempts and cleanup
proof. Its external-only fields describe creation before this verified archive
copy; no helper image was published.

The [Linux ingestion CPU diagnostic](linux-ingest-cpu-01/manifest.json) also
fails its full 6,000-offer traffic requirement: 5,832 requests succeeded and
168 offers were refused, with zero failed requests, late offers or acquisition
failures. Both drains completed without aborts, child shutdown was clean, the
CPU profile was flushed and all owned containers were removed. Source `d6492333`
remained clean and unchanged. Ingestion ran without concurrent reports or
rollups, so this cannot establish combined capacity. API CPU use was 80.288
seconds and event-loop utilization 0.9781.

The [clipped profile analysis](linux-ingest-cpu-analysis/manifest.json) covers
66.807 seconds from API reset through drained snapshot. Disjoint sampled-wall
categories include Drizzle 17.15%, application 12.08%, PostgreSQL driver 8.88%,
GC 4.84% and harness 2.05%; these are not CPU-time percentages or savings
forecasts. Inclusive SELECT preparation overlaps other stacks and must not be
added to them. Most query preparation loses its application caller across async
boundaries, so no specific additional application rewrite is justified by this
profile alone. Analysis01 is retained but superseded by analysis02's harness-path
classification correction. The next diagnostic measures synchronous query
construction by bounded, content-free shape without changing application logic.

That subsequent [SQL-shape diagnostic](linux-ingest-sql-shape-01/manifest.json)
on `d6492333` delivered 6,000 of 6,000
heartbeats, with zero refused, failed or late offers and zero acquisition
failures. Maximum heartbeat duration was 8.487 seconds. Attribution was complete
across 31 shapes, with no collector or original-method errors. SQL construction
took 4.681 seconds of synchronous elapsed time and SELECT preparation 5.284
seconds; these measurements overlap and must not be added. Collector bookkeeping
took 1.298 seconds. This ingestion-only result used no CPU profiler, reports or
rollups and remains diagnostic-only, with capacity explicitly unaccepted. Source
cleanliness, unchanged source, physical drain and owned-container cleanup passed.
The frozen per-shape analysis identifies only 1.050 seconds of preparation for
the largest individual shape across all 6,000 requests. It supports measuring
the current combined workload before considering a broader compilation cache;
it does not establish an achievable performance gain. The archive's external-only
fields describe its creation before this verified repository copy.

[Combined09](load-combined-09/manifest.json), on clean `d6492333`, remains failed:
3,677 of 6,000 offers succeeded, 1,911 started requests failed and 412 offers were
refused, with zero late offers. Thirty of 64 reports succeeded; six returned 500
and 28 timed out. There were 1,957 connection-acquisition failures. Both historical
workers returned correct totals in 17.983/38.501 seconds. Telemetry and inbox
failure counters were zero, but 17 aborted responses prevented drain certification
despite all physical ownership gauges returning to zero. Current-day and audited
CSV checks did not run. Owned containers and children are independently absent.
This is saturation evidence, not proof of a lease leak or accepted capacity.

The [exact local d649 candidate artifact](candidate-artifact-d6492333/manifest.json)
passes an uncached build, all-severity pinned scan with zero findings, and embedded
129-table/lifecycle compatibility checks. The [local migration rehearsal](rehearsal-d649-5c01/manifest.json)
passes reconstructed baseline → d649 → compatible 5c01 fallback → d649, retaining
53 migration IDs and 129 tenant tables. Its empty baseline already adopted the
staff identity contract; this proves idempotent re-entry, not the live catalog or
an unadopted production transition. Neither artifact preparation nor rehearsal
establishes capacity or authorizes deployment.

The [d649 CI assertion follow-up](runtime-security-clock-followup/manifest.json)
retains the ordinary isolation job's 1,478 passes, one failure and eight skips.
The failure asserted the old literal clock and callback formatting. Its narrow
test-only correction verifies both transaction/current entry points and their
clock mapping; the full 27-case suite passes. All 904 captured application/build
inputs remain unchanged. The subsequent `92307780` checkpoint passes; the
original failed job is not relabeled as passing.

The latest [combined checks, attempt11](combined-checks-attempt-11/manifest.json),
pass the application build, type/cast checks and all 699 infrastructure tests.
Its four unit VM-context failures remain recorded. The [test-only follow-up,
attempt12](combined-checks-attempt-12/manifest.json), passes 1,823 unit tests and
types/casts, with four named conditional skips. The source comparison proves
exactly two test-only changes, unchanged application inputs and all 60 selected
infrastructure tests plus their selector, and attempt12's final source matches
attempt11's final source. Neither run is capacity acceptance.

[Combined08](load-combined-08/manifest.json) on clean `ff6b4c96` also failed:
2,692/6,000 heartbeat successes, 26/64 reports, 3,008 acquisition failures, no
late offers and no optional telemetry failures. Workers returned correct totals
in 17.881/41.721 seconds. Eleven aborted responses prevented drain certification
despite zero remaining physical owners; forced child termination and the absent
current-day/CSV checks are retained. All owned containers/processes are absent.
The lease-sharing correction reduced SQL/secondary checkouts but has not met
capacity acceptance.

The subsequent [ingestion-only CPU diagnostic](ingest-cpu-bcb2b33c-01/manifest.json)
on clean `bcb2b33c` also fails: 5,148/6,000 offers succeeded, 232 started
requests failed and 620 offers were refused; none were late. There were 232
database acquisition failures and 5,254 persisted observations. Both children
drained cleanly, with zero aborted responses and no remaining owners. The API
used 82.062 CPU seconds during the 67.879-second phase, with event-loop
utilization 0.999640. The phase-clipped profile attributes 15.547 seconds to
Drizzle, 6.341 seconds to the PostgreSQL driver and 2.833 seconds to garbage
collection. These mutually exclusive sample categories identify work to reduce;
they do not prove a connection leak or forecast capacity after a change. This
diagnostic cannot replace the three required passing combined runs.

The [owned-inbox correction](heartbeat-owned-inbox/manifest.json) moves the full
inbox query and claim into the heartbeat's existing locked transaction, after
foreground transport and before its mandatory final fence. A private current-clock
path preserves expiry/supervision checks; the generic inbox API retains its
original transaction semantics. The route publishes its recovery cache only
after commit and tenant release, including early finish/close and student changes.
An optional failure rolls back only its savepoint and increments a cumulative
counter; any nonzero or missing counter fails capacity acceptance. Forty-eight
focused checks, 19 native cases under each role and 20 diagnostics/acceptance
checks pass. A native command-path comparison reduces 33 statements/two physical
leases to 27 statements/one lease. This is not a capacity result. Failed fixture,
selector and stale-build declaration checks remain in the archive.

The [Docker command-selector follow-up](deploy-docker-selector-followup/manifest.json)
preserves the failed CI assertion and 147 passing local tests. Its two test-only
changes recognize host-pinned Docker mutations while continuing to check every
publication step's preflight ordering. New CI remains required.

At the [completed bcb2b33c CI checkpoint](ci-bcb2b33c.json), 15 jobs pass,
including all frontend shards/build, restricted-role isolation and AWS rollout
safety. The backend infrastructure selector and four ordinary-database PassPilot
cases fail. The [PassPilot fixture correction](passpilot-midnight-fixture/manifest.json)
preserves the original failures at 00:00:15 America/Los_Angeles: subtracting one
minute seeded yesterday's pass instead of the intended same-day active pass.
The corrected full 19-case suite and five-case exact-midnight replay pass on a
stable source snapshot. Actual previous-day behavior remains covered.

The [fixed-query prototype](fixed-query-prototype-deferred/manifest.json) is
deferred and absent from application source. Its guarded implementation saved
only about 0.8 seconds arithmetically across 6,000 offers in isolated compilation
benchmarks; that did not justify adding a new compiler/encoder contract. All
experimental source, passing and failed checks, and CPU follow-up analyses are
retained. No native or capacity result is attributed to that experiment.

The [historical fallback image](rollback-artifact-5c01944e/index.json) is built from
clean `5c01944e`, including the final heartbeat expiry fence. Its uncached build,
full pinned scan and embedded compatibility checks pass, with zero findings.
Registry publication remains unperformed. The local d649/5c01 migration re-entry
is recorded above; actual production task bindings remain unverified.

The [foreground/final-delivery correction](heartbeat-foreground-fusion/manifest.json)
reuses the owned authority proof for eligible teaching-session updates and adds
a mandatory final school/license/session clock check. Forty focused tests and
23 native cases under each database role pass. The native ordinary-path probe
reduces 25 SQL statements/two checkouts to 19 statements/one checkout; this
small probe is not a capacity result. [Combined09](combined-checks-attempt-09/manifest.json)
passes the build and 672 infrastructure tests while retaining failed stale test
selectors and two diagnostic typing errors. [Combined10](combined-checks-attempt-10/manifest.json)
passes type/cast checks and 1,801 unit cases, with four named conditional skips,
after test-only repairs. Application bytes are unchanged between those checks.

[Combined attempt07](load-combined-07/manifest.json) on clean `7cf86cf1` failed:
3,268/6,000 heartbeat offers succeeded, 1,155 started requests failed, 1,577 were
refused and none were late. Reports passed 32/64; API acquisition failures total
1,679. Both historical workers returned correct totals in 16.363/39.855 seconds.
All physical ownership gauges reached zero, but 66 aborted responses caused
`DRAIN_UNVERIFIABLE_ABORT`, correctly refusing completion certification. The
harness then terminated the API child; its unsuccessful graceful-cleanup record
is retained even though subsequent inspection found no owned processes or
containers. Current-day correctness and CSV checks did not run. A separate
[post-run source observation](load-combined-07/post-run-source-manifest.json)
records the clean unchanged commit without fabricating the missing normal finish
receipt. Final-delivery leases accounted for 554.4 aggregate seconds, foreground
telemetry 312.9 and reports 11.1; saturation remains unresolved.

The [CI query-detector repair](ci-query-detectors/manifest.json) preserves the
failed backend and RLS job logs at `7cf86cf1`. Query case/whitespace and multiline
middleware wrappers invalidated older test matchers. The corrected detectors
still assert the complete query shape and parameters, both binding reads, and
actual controlled expiry/fault races. All 68 private-chat cases pass under each
database role with explicit restricted-role posture verification. The first
marker-omission attempt remains separately recorded. The school-arrival
middleware contract also fails before and passes after its assertion update.
The [completed CI checkpoint](ci-7cf86cf1.json) records 14 successful and three
failed jobs, with Gitleaks, Trivy and CodeQL successful. The separate
[cross-tenant/header follow-up](ci-query-detectors/cross-tenant-header-followup/manifest.json)
preserves its failed job, two local import-configuration failures, and the
corrected 27-case contract suite. Local repairs do not retroactively pass CI.

The [final control/SSO projection](final-control-sso-projection/manifest.json)
replaces two fresh reads with one parameterized statement while preserving all
17 control fields, timestamp decoding and independent missing-row defaults.
Thirteen focused checks and nine native cases under each database role pass.
The initial test-spy ownership failure and a stale-dist type-check failure are
retained. Combined09's successful build covers this application change;
these focused checks do not establish a capacity improvement.

The [live-binding query correction](live-binding-query/manifest.json) preserves
the exact parameterized predicates, database-clock lease checks and shared locks
on all three joined tables. It removes query-builder compilation from the hot
live branch; historical/tombstone paths and both delivery fences are unchanged.
SQL equivalence checks pass 2/2, with 15 native owner and 15 restricted-role
cases passing, including actual competing writers and expiry after preparation.
The isolated compilation benchmark is not a capacity result.

The [preceding compatible fallback image](rollback-artifact-ed5599de/index.json)
is built from clean `ed5599de0191b4b9961ed907586e1fc153ebd63b`. The uncached
build and pinned Trivy scan pass with zero findings at every severity. Embedded
129-table admission, lifecycle writer/bridge/relay, SSO, monitoring lease,
Stop Focus and classification-ordering checks pass. Both Usage modes remain
off. The first external inspector's regex failure and its repair are retained;
this local artifact does not establish production compatibility or replace
the final candidate → fallback → candidate migration rehearsal.
The [final-clock correctness backport](rollback-heartbeat-fence/manifest.json)
advances fallback source to `5c01944ed1afb4241e270469c6477121bf48cd84`;
its new image must be verified independently. Generic and WebSocket delivery
behavior remains unchanged, with 75 focused and 12 native cases under each
database role passing, along with build/type/cast checks.

The [complete-server-drain correction](complete-server-drain/manifest.json)
retains a baseline false-pass regression. Full heartbeat handlers and known
Promise-returning middleware remain owned through Redis waits, queued checkouts,
COMMIT and RESET, even after HTTP completion or disconnect. Reset preserves
outstanding operations and leases. Acceptance requires two yielded zero-owner
observations, complete fixed-label diagnostics and no late handler failures.
The [preflight follow-up](complete-server-drain/preflight-abort-followup/manifest.json)
also rejects missing or nonzero abort evidence before reset; physical idle alone
does not establish completion of untracked callback work after an abort.
Twelve focused checks and all 54 workload guards pass. The initial type-check
failures and stale source-layout assertion are preserved separately. Offered
traffic, pool ceilings, database deadlines and the 48-second worker gate remain
unchanged.

[Combined checks attempt07](combined-checks-attempt-07/manifest.json) passed
build, test-type and cast checks but retained one stale limiter-layout assertion
failure. The [full unit rerun](combined-checks-attempt-08/manifest.json) passes
1,775 cases with zero failures and four documented conditional skips. Application
bytes are unchanged from the passing build/type checks; only the limiter test
and two drain harness files changed. The source hashes remain identical across
each run. New-head CI and concurrent capacity remain separate requirements.

[Combined attempt 06](load-combined-06/manifest.json), on clean unchanged
`25ba868685fa4aa5010023b55f3705a5e525e6fd`, remains failed capacity evidence:
3,668/6,000 heartbeats succeeded, 749 failed, 1,583 were refused at the in-flight
limit, and 69 offers were late. Reports passed 36/64. The API recorded 979
checkout failures and 144 optional telemetry failures; all tracked leases were
released after drain. Final delivery accounted for 585.6 aggregate lease-seconds,
foreground telemetry 329.1, persistence 169.6 and reports 12.8. These show
saturation without establishing a leaked connection. Large pauses occurred in
both API and generator processes; causation between them is not established.
Both bulk workers returned correct totals in 17.603/39.566 seconds including
queueing. Current-day totals/classifications, unavailable coverage and eight
audited CSV exports now pass the independent checks. There were 4,073 persisted
observations, a separate count from acknowledged requests. The first classroom
command returned 503. No result from this run counts toward the three passes.

The [same-source CPU diagnostic](ingest-cpu-25ba8686-01/manifest.json) preserves
all 6,000 offers: 4,382 succeeded, 162 failed, 1,456 were refused and none were
late. It is failed diagnostic evidence, with original dirty-source flags intact;
the application files matched `25ba8686`, while archived evidence was untracked.
Within the measured 70.041-second sample window, Drizzle accounts for 18.123
seconds exclusive (25.9%), the PostgreSQL driver 6.391 seconds, native socket
writev 6.160 seconds and harness instrumentation 1.434 seconds. Inclusive stack
totals overlap these figures and must not be added. Three final-delivery leases
were still active at the phase snapshot even though later shutdown completed.
The next acceptance harness must verify server work through commit and cleanup.
The [CI record at `25ba8686`](ci-25ba8686.json) passed all four required workflows;
it does not supersede either failed workload or cover subsequent source edits.

[Combined attempt 05](load-combined-05/manifest.json), on clean source
`59f0e43110779b298df51cdba9ef7ff3de22e6a4`, failed: 1,592 of 6,000 heartbeat
offers succeeded, 2,534 started requests failed and 1,874 offers reached the
in-flight ceiling. Reports passed 25/64. Both bulk workers returned correct
totals in 18.935/41.883 seconds including queueing. The API recorded 3,140
connection-acquisition failures. It persisted 3,353 observations, a separate
count from successfully acknowledged requests. The first classroom command
failed with HTTP 500, and 272 unexpected classifications stopped the current-day
oracle. Canonical control preparation now exercises actual classroom telemetry;
this is not a controlled comparison isolating the preceding heartbeat projection.
Background telemetry held 4,861 leases and ran 58,140 statements. Inspection found
that awaited optional publication can prevent historical classification from
being registered after persistence; individual affected rows cannot be recovered
from the removed fixture. The strict oracle remains unchanged. All original
evidence is retained and no capacity pass is claimed.

The [CI record for that same source](ci-59f0e431.json) passed all four required
workflows and all 17 CI jobs. It does not replace the failed load acceptance.
The [fresh owner-projection proof](telemetry-owner-projection/manifest.json)
records 11 passing owner and 11 passing restricted-role cases, including actual
lock waits, cross-school isolation and canonical helper equivalence. It reduces
discovery from three statements to one and separately verifies atomic initial
classification fields. The tiny-fixture EXPLAIN record is not capacity evidence.
All earlier fixture failures are retained.

The [classification and ordering correction](classification-delivery-immediate/manifest.json)
preserves the original failing cases and 47 passing focused checks. An independent
47-case differential agrees with the prior canonical classifier. Historical
classification is registered before optional publication, and current effects
wait until the full foreground update has settled. Only server-derived,
deterministic educational results without safety alerts are stored with the
original INSERT; its returned fields must confirm persistence before asynchronous
work is skipped. Other classifications retain their safety and authority checks.
The [compatible correctness-only backport](rollback-classification-correctness/manifest.json)
is pushed as `ed5599de0191b4b9961ed907586e1fc153ebd63b`: 24 focused tests and
build/type/cast checks pass. It excludes the performance changes. Neither source
has completed the next combined capacity run or final artifact rehearsal.

The [cumulative telemetry gate](optional-telemetry-phase-counter/manifest.json)
requires zero optional publication failures across the whole load phase. Minute
summary resets cannot clear this evidence, and missing counters fail acceptance.
All three publication failure paths are covered; 14 focused checks and 49 load
guards pass. Offered traffic, pool limits, timeouts and report ranges are unchanged.

[Combined checks, attempt 06](combined-checks-attempt-06/manifest.json) records
the successful production build, cast check and full unit suite: 1,769 passed,
zero failed, four explicitly named conditional skips. All 1,155 source-file hashes
matched before and after. The overall attempt remains failed because the new
native test asserted a transaction as a pool-bearing database type. Its separate
test-only typing correction and native rerun do not rewrite that failed record.
The [type/native follow-up](telemetry-owner-projection-type-followup/manifest.json)
passes the type/cast checks and repeats all 11 owner and 11 restricted cases.
Its source comparison confirms only that RLS-lane test changed; application
bytes and every unit-selected test are identical to the passing build/unit run.

The [earlier combined unit and TypeScript checks](combined-checks-attempt-05/manifest.json)
follow the Stop Focus transport correction: 1,752 passes, zero failures and four
named conditional skips, with all 1,152 source files unchanged during the run.
The [compatible rollback backport](rollback-stop-focus/manifest.json) is committed
as `ff94f21e6cc91075e7e82f0d28b434ef43f4a118`; its three focused regressions fail
before and pass after, and its type/build checks pass. A fresh image and final
candidate-schema re-entry remain pending. These checks do not turn the failed
preflight or earlier load attempts into accepted capacity.

The first frozen correction checkpoint is
`cb66014d70a275405a5469257b37debe8d20ea18`. Its new records below preserve exact
source identities; later harness/documentation corrections require their own
source binding and do not turn a failed launch into measured capacity.

- [Frozen unit suite](unit-cb66014d.json): 1,705 passed, zero failed and four
  explicitly listed integration-dependent skips. Skips are not passing tests.
- [Exact local API/worker candidate](candidate-artifact-cb66014d/index.json):
  build, exported image hash, pinned Trivy scan and embedded writer/bridge/relay
  and 129-table registry checks. The large image archive remains outside Git;
  registry publication, production task bindings and capacity are separate.
- [Local upgrade and rollback re-entry](rehearsal-cb66014d/index.json): the
  synthetic baseline expands from 44 to 53 migration IDs and retains 129 tenant
  tables through repeats and compatible rollback re-entry. Baseline legacy
  bootstrap had **already applied the staff-identity contract**; the step named
  contract adoption was idempotent re-entry, not an unadopted-to-adopted test.
  This reconstructed empty schema does not establish the actual production
  catalog, a populated RLS test or a production restore.
- [Combined load launch 01](load-launch-01-cb66014d.json): retained launcher
  failure from two Docker executable matches. It failed before fixture creation
  or capacity measurement; a corrected harness needs a fresh recorded attempt.
- [Combined capacity attempt 02](load-combined-02/manifest.json): real workload
  at `9f1580615d72f6b0647abac27677773b03a88269` failed. Only 1,355 of 6,000
  heartbeat offers succeeded; 3,345 started requests failed and 1,300 offers were
  refused at the in-flight ceiling. Reports passed 17/64. Workers finished in
  15,540.9899/15,723.4094 ms with correct independent totals, but these successes
  do not override failed traffic and lifecycle acceptance. Full sanitized logs,
  metrics, schema and resource metadata are retained; the populated fixture
  identity snapshot is hash-only. Owned processes/containers drained and shared
  local database/Redis containers remained healthy. A worker instrumentation
  defect means its zero acquisition counts are **not** evidence of zero worker
  acquisition failures. Post-run review also found that pre-measurement drain
  permanently shut down the classification batcher, disabling normal batching
  during the measured workload. The failures are real observations of that
  altered configuration, not a representative measurement of normal batching
  or proof of a product-only bottleneck. Both harness defects require correction
  and a fresh run; original logs, metrics and hash records remain unchanged.

- [Full-traffic ingestion CPU diagnostic](load-ingest-cpu-01/manifest.json)
  retains the failed `3624196c` run, complete sanitized V8 profile, selected
  stacks, analysis script and exact hashes. Normal classification batching was
  restored, but only 4,522 of 6,000 offers succeeded; 362 started requests failed
  and 1,116 offers reached the in-flight limit. The API remained CPU-saturated,
  with 282 pool acquisition failures and no SQL statement failures. This
  profiled ingestion-only run is diagnostic: reports, heavy workers and the
  classroom lifecycle were not exercised, and it cannot establish capacity.
- [Batching preflight correction](batching-preflight-fix/manifest.json) preserves
  two failing-before regressions, all 60 passing focused checks with no skips,
  the successful type check, and exact dirty-source byte hashes. The full suite
  includes the CPU-profile and worker-proxy guards. Preflight now drains pending
  work without putting the batcher into permanent shutdown; actual shutdown
  retains its terminal flush. These checks repair the test workload and do not
  establish capacity acceptance. Red/type records explicitly identify their
  structured tool-transcript provenance; the complete green log is retained.
- [Report admission and cancellation](reports-manifest.json) indexes ordinary
  and restricted-role PostgreSQL tests, strict audit failure, queued revocation,
  cookie-session invalidation and focused unit checks. The initial failed native
  attempt is retained alongside its corrections.
- [Heartbeat and ownership diagnostics](heartbeat-manifest.json) retains focused
  tests, the original teardown failure and corrected cleanup. Native heartbeat
  results here used an owner role; they are not restricted-role proof.
- [Interface and unit checkpoints](ui-and-unit-incremental.json) retains the
  manual-retry/CSV overload checks, frontend build/lint and an earlier unit run.
  Each entry records which later source changes it does not certify.
- [Review-container observation](pr-review-checkpoint.json) records exact remote
  #603/#123 heads and all reported check entries. The earlier green SchoolPilot
  head does not certify the uncommitted contention corrections; ClassPilot's
  successful run and cancelled sibling-run entries remain separately visible in that historical record. The [October 3 reconciliation](extension-ci-reconciled-20261003.json) records the same ClassPilot head with all 10 checks passing and GitHub `CLEAN` after sibling run `37048477885` passed on rerun.
- [Historical rollback artifact](rollback-artifact/index.json) binds the preserved
  external image archive, source, scan and synthetic compatibility proof. Both
  Usage modes must remain off on that pre-correction source. No registry upload
  or production task-definition binding is implied. It is superseded for normal
  rollback by the SSO lock-order correction below; disabling Usage does not
  prevent the pending-private-reply bootstrap deadlock.
- [Patched rollback artifact](rollback-artifact-faf5275c/index.json) binds exact
  source `faf5275ccf422dda602b2238c247a306c28ba508`, its local image, scan and
  17 focused plus 9 owner and 9 restricted-role native test results. It retains
  writer/bridge/relay version 1 and all 129 admission entries. Both Usage modes
  stay off. The [0431 checkpoint rehearsal](rehearsal-0431-faf5275c/index.json) passed baseline expansion and patched rollback/candidate re-entry, with identical migration ledger and relation/RLS snapshots across re-entry. Actual production catalog, later candidate reconciliation and deployable bindings remain separate gates; historical images are retained unchanged.
- [Monitoring-corrected rollback](rollback-artifact-2bbcdb37/index.json) supersedes
  the designated `faf5275c` fallback with exact source
  `2bbcdb370eeeb182553097a2bd049e32bec93f9b`. Only the additional active-lease
  monitoring correction is included; both Usage modes stay off. Its regression
  fails before the backport and all 28 focused checks pass afterward. The clean
  image build, scan, export, embedded protections and synthetic admission checks
  pass. Final candidate-schema re-entry and deployable registry/task bindings
  remain pending; all previous artifacts are retained.
- [Bounded production metadata inspector](production-metadata-inspector/index.json)
  preserves the external source/wrapper, 32 local mock/native cases, exact
  serving-image offline checks and a concrete read-only AWS Plan. No inspector
  task, database query or cloud mutation was performed. Exact-plan execution
  remains separately authorized. Its hashed catalog, full ledger and fixed-domain
  pilot identity projection cannot replace a restorable schema-only export.
- [Status/configuration hot-path checks](hot-path-root/manifest.json) record 24
  passing checks for exact status expiration/capacity and immediate configuration
  revocation. The configuration optimization caches only parsing of identical
  bytes, never school/client authorization. These are focused checks, not load
  acceptance.
- [JWT and optional Focus CPU correction](jwt-focus-cpu/manifest.json) retains
  failing-before evidence, fixture/type repairs and 41 passing focused tests.
  Key material is parsed once; every JWT signature, algorithm and time claim is
  still checked. Present Focus data remains validated on all three paths.
- [Combined unit checks](hot-path-unit/manifest.json) record 1,721 passes and four
  named conditional skips. The first run saw a test edit and is not frozen-source
  evidence; the second verified all 1,141 recorded source files unchanged.
  Later type-only test assertions have their focused rerun above and require
  final-head CI. Neither run establishes synthetic capacity.
- [Complete CI at `3624196c`](ci-3624196c.json) passed before these CPU changes.
  The next corrected head requires its own checks; this earlier success is not
  transferred to changed application bytes.
- [Extension reverification](extension-reverification.json) verifies unchanged
  source and exact 2.9.7 ZIP without rebuilding or claiming a fresh browser run.
- [Ingress deadline follow-up](reports-ingress-manifest.json) retains the real
  session-store deadline checks and their failed fixture attempt.
- [Combined unit attempt](unit-attempt-01.json) retains the outdated limiter-order
  assertion failure and identifies the required full rerun.
- [Production schema access](production-schema-read-feasibility.json) records
  the observed private database access boundary. A local reconstructed baseline
  is not an actual production catalog export; that verification requires the
  separately authorized inspection task or an approved operator export.

- [Tenant metadata reuse](reports-metadata-manifest.json) verifies that reusing
  immutable ORM setup preserves fresh school authority, GUC cleanup, RLS and
  transaction boundaries on the same physical client. Owner and restricted-role
  native cases pass; the original CI lock-observer failure remains archived.
- [Private-chat and SSO lock order](sso-private-lock/manifest.json) preserves
  actual PostgreSQL `40P01` failures before the correction in both database roles,
  followed by successful native races and 48 focused checks. The WebSocket
  bootstrap now takes its existing SSO fence before private settings locks;
  ordinary heartbeat query counts are unchanged.
- [Combined unit suite after these corrections](unit-metadata-sso.json) records
  1,710 passing cases, no failures and four conditional skips. Its 1,139 source
  file hashes were captured before the run and verified unchanged afterward.
  This does not replace full CI, database lanes or frozen capacity acceptance.

Manifest entries contain raw and sanitized log hashes. Gzip logs retain complete
sanitized output; transcript-only attempts are explicitly identified where no
separate raw log was saved. No production database contents or credentials are
included. The earlier cold-load failures remain in their original records one
directory above and are not replaced by these focused tests.

- [Combined attempt at `0431f043`](load-combined-03/manifest.json) preserves
  the failed full workload: 3,602 of 6,000 offered heartbeats succeeded and
  34 of 64 reports passed. Both heavy workers and later correctness checks
  passed, but the classroom lifecycle failed. Sampled WAL flush waits occupied
  nearly the full API pool during the strongest contention; they do not show
  an authority-lock deadlock or establish the underlying host I/O cause.
- [Isolated ingestion at the same source](load-ingest-0431-01/manifest.json)
  preserves all 6,000 offers: 5,803 completed and persisted, with 197 refused at
  the unchanged in-flight cap. No pool acquisitions or SQL statements failed,
  but the API event loop remained 99.885% utilized. The retained comparison
  shows far fewer WAL wait samples without the concurrent workers and reports.
  This diagnostic failed acceptance and does not certify those omitted paths.
- [PostgreSQL pressure instrumentation](postgres-pressure-instrumentation/manifest.json)
  records 13 passing focused checks and actual read-only local PostgreSQL
  validation of fixed API/worker connection labels and aggregate statistics.
  The next run can distinguish role-specific waits and WAL/checkpoint counter
  changes. Disabled I/O timing is recorded as unavailable; no database settings,
  pool limits or acceptance limits were changed.
- [Worker admission trial](worker-admission/manifest.json) retains a failing
  before-source entrypoint probe, 42 passing focused checks and 20 passing
  isolated owner-database checks. The production rollup entrypoint now permits
  one writer plus one waiter per pool and counts queueing and cleanup in its
  60-second success budget. A real PostgreSQL timeout after the day DELETE
  preserved prior aggregates and coverage, preserved an inherited stricter
  timeout and allowed subsequent work. Cleanup remains owned until finished;
  an overrun is a failure. The unchanged 48-second full-operation capacity gate
  still needs combined-load evidence. The first probe setup failure and shared
  test-type debt from concurrently edited files remain explicitly recorded.

- [Owned monitoring context](monitoring-owned-context/manifest.json) records
  35 passing focused checks, including the one-client starvation regression.
  Fresh monitoring policy reads reuse only the currently owned, same-school
  tenant lease. Stale, releasing, differently scoped and super contexts cannot
  reuse it.
- [Heartbeat reply recovery](heartbeat-recovery/manifest.json) records 39
  passing focused checks and 68 native cases in each of the owner and restricted
  database roles, with no skips. Optional private-reply recovery now shares the
  mandatory final heartbeat authority transaction, retaining its exact binding,
  lifecycle, SSO and final-delivery checks. Savepoint recovery covers claim and
  socket failures without undoing required preparation; failed cleanup remains
  fail-closed. Earlier failing attempts are retained. These checks do not prove
  the combined capacity target.

- [Combined checks, first attempt](combined-checks-attempt-01/manifest.json)
  retains the complete failed unit run: 1,742 passed, two static contract
  assertions failed, and four conditional cases skipped. Build, test types and
  cast checks passed; all 1,147 source-file hashes matched before and after.
  The two assertion updates require a new full unit run. This attempt remains
  failed evidence regardless of the later result.
- [Combined checks, second attempt](combined-checks-attempt-02/manifest.json)
  records 1,744 passing unit cases, no failures and four conditional skips, with
  all 1,147 source files unchanged during the run. Only the static late-signin
  contract test changed since the passing build, type and cast checks above.
  The outer PowerShell command still exited 1 during later receipt formatting;
  its error is preserved, and the reconstructed receipt explicitly distinguishes
  that failure from the completed passing test suite. This does not establish
  load capacity or final-head CI.

- [Combined attempt at `8069560d`](load-combined-04/manifest.json) retains the
  failed complete workload: 4,696 of 6,000 heartbeats and 36 of 64 reports
  passed, with 716 API checkout failures. Both workers met 48 seconds including
  admission queueing. API CPU remained high while SQL and WAL waits improved.
  Separate follow-up investigations found an oracle timestamp-precision defect
  and missing canonical control initialization in the lifecycle fixture; neither
  excuses the independent capacity failures. The original one-second mismatch
  cannot be conclusively attributed because its raw timestamps were not retained.
- [Heartbeat query construction benchmarks](heartbeat-context-compile-benchmarks/manifest.json)
  compare narrow projections and fixed parameterized SQL without executing
  database queries. These support a focused optimization trial, not a capacity
  claim; timestamp decoding and authority checks still require native validation.
- [Joined heartbeat persistence context](heartbeat-persistence-context/manifest.json)
  records 15 passing owner cases and eight passing restricted-role cases, with
  no skips. One fresh query matches the previous three reads, including all
  control fields, timestamp decoding, caller-transaction changes, tenant
  isolation and navigation privacy. Two invalid fixture attempts are preserved;
  neither changed database constraints. Separate plans over 2,001 control rows
  use the school/student index and do not establish full-load capacity. Final
  combined build/type checks and capacity acceptance remain required.

- [Current-day oracle precision](oracle-microseconds/manifest.json) preserves
  the failing boundary regression and six native PostgreSQL numeric parity
  cases. Exact microsecond text and integer arithmetic replace lossy Date
  parsing, with aggregate equality unchanged. The [fixture invariant checks](oracle-microseconds/invariants-manifest.json)
  add 34 passing focused checks and 12 native synthetic SQL cases, rejecting
  changed classification or frozen membership before applying the one-grain
  oracle. Original combined04 remains failed: its raw failing observation was
  not retained, so this proof does not retrospectively validate that aggregate.

- [CI at `8069560d`](ci-8069560d.json) completed with 15 successful jobs and
  two failures. The [runtime-security follow-up](runtime-security-static-followup/manifest.json)
  preserves the ordinary database lane's 1,400 passes, one outdated static
  assertion failure and eight skips. The corrected assertion checks the shared
  SSO lock before screenshot preparation; all 27 local follow-up cases pass.
  Its first failed local invocation, which omitted required environment, is
  retained. The independent dependency audit failure is recorded separately.
  These repairs still require fresh final-source CI.

- [Combined checks, third attempt](combined-checks-attempt-03/manifest.json)
  preserves successful clean install, build, type/cast checks and both audit
  gates, plus a failed unit run caused by an inappropriate dummy database URL
  enabling an optional native case. The [fourth attempt](combined-checks-attempt-04/manifest.json)
  removes that environment mistake and records 1,752 passes, zero failures and
  four conditional skips. All 1,151 source-file hashes match across both runs.
  It also retains all 48 passing load-guard checks. Production dependency audit
  found no vulnerabilities; the full audit retained four moderate findings and
  no high or critical findings. These remain local checks, with final-source CI
  and capacity acceptance separate.

- [Rollback351 image preparation](rollback-artifact-351422d7/index.json)
  retains both exact source builds, scans and export hashes. The first reused a
  cached Alpine package layer with a fixable libpng finding of unknown severity.
  The second rebuilt without layer caching, installed the fixed package and has
  zero pinned-Trivy findings. Embedded 129-table and writer1/bridge1/relay1 checks
  passed. Both images remain intermediate: the newly discovered Stop Focus
  exact-binding correction must be backported before selecting final rollback
  source and completing migration re-entry. Both Usage modes stay off.

- [Lifecycle preflight at `5a2c0996`](load-preflight-5a2c0996-01/manifest.json)
  preserves the failed diagnostic run. The first school passed precise and
  Focus synthetic ACKs, private-chat closure/expiry and reconnect checks, then
  Stop Focus lacked its required exact transport binding. This was a server
  frame defect: the remaining snapshot did not supply a binding either. The
  second school and full capacity workload were not exercised.
- [Stop Focus V2 cleanup correction](stop-focus-v2-cleanup/manifest.json)
  records three failing regressions followed by 18 passing focused cases.
  The exact ClassPilot 2.9.7 binding parser and full-authority gate reject the
  original server frame and accept the fixed frame, while rejecting stale,
  conflicting and incomplete variants. Both native runs passed 14 restricted
  Focus integration cases, including actual socket delivery with Focus disabled,
  preservation of other controls, and offline cleanup; 15 owner-backed pure
  cases also passed. The strict load harness is unchanged. Parser/native checks
  do not establish browser enforcement or capacity acceptance.

Release acceptance additionally requires three consecutive successful combined
release-enabled capacity runs on unchanged application source/schema, the
retained comparison profile, final combined CI, local artifacts and migration/
recovery evidence. Deployed observation and live classroom validation are later
operational gates. Managed-Chromebook testing remains waived, not passed.
