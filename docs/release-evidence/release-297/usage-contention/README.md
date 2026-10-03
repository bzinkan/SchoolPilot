# Usage contention correction evidence

These records preserve development checks and failures before the final source
freeze. They do not establish capacity acceptance or authorize deployment.

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

Release acceptance additionally requires three consecutive successful combined
release-enabled capacity runs on unchanged application source/schema, the
retained comparison profile, final combined CI, local artifacts and migration/
recovery evidence. Deployed observation and live classroom validation are later
operational gates. Managed-Chromebook testing remains waived, not passed.
