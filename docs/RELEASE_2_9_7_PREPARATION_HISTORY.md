# Historical release-preparation checkpoints

These dated development checkpoints were moved verbatim from the operator
checklist after the b112 combined CI and recovery results were recorded. Their
statements about current source, pending checks and failed runs describe those
earlier checkpoints. They do not replace the
[current operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md). All original
evidence records and failed attempts remain intact.

Historical block SHA-256: `601c90c8017d962d879e73dd10765bec976e39794e091da43b5669424ba5f90b`.

Application `0e427e3ca9b82125e0bb8692176accad21f4f699` remains historical.
Its [Focus wire correction](release-evidence/release-297/usage-contention/focus-status-wire-297-01/manifest.json)
accepts the exact 2.9.7 package's `focusStatus` on heartbeat and WebSocket ACKs,
and compares validated status fields without depending on JSONB key order.
The regression failed before correction; 64 focused cases, 15 restricted-role
database cases and build/type/cast checks now pass. The
[strengthened synthetic lifecycle](release-evidence/release-297/usage-contention/focus-lifecycle-harness-01/manifest.json)
verifies exact public Focus state before accepting command completion; all 61
load-profile guards pass. Extension bytes are unchanged. The [fallback source
backport](release-evidence/release-297/usage-contention/rollback-focus-wire-01/manifest.json)
at `6e251f2d1eece2b98fa2325e1fa46bd2b8553420` passes 61 focused and 13
restricted-role cases plus build/type/cast and compatibility-floor checks.
Its [fresh local fallback image](release-evidence/release-297/usage-contention/rollback-artifact-6e251f2d/manifest.json)
now passes the uncached build, pinned vulnerability scan (zero findings),
embedded Focus/compatibility checks and cleanup. Both Usage modes must remain
off with this fallback; pairing it with the final candidate still needs rehearsal.
The fresh [unprofiled ingestion diagnostic](release-evidence/release-297/usage-contention/linux-role-ingest-unprofiled-0e427-01/manifest.json) fails at 5,139/6,000 successful
heartbeats, with 144 failures, 717 in-flight refusals and zero late offers.
API CPU remains saturated; all owners drained and all test containers were
removed. [Combined CI on `5d031512`](release-evidence/release-297/usage-contention/ci-5d031512-final-01/manifest.json)
passes all 17 CI jobs and three security workflows for `0e427e3c`. Accepted
combined capacity, the final candidate image and recovery pairing remain
pending; later application changes and merged main need their own checks.

The [resource-bounded combined diagnostic at `9630c009`](release-evidence/release-297/usage-contention/linux-role-combined-9630-01/manifest.json)
completed 2,704/6,000 heartbeats and 34/64 reports; the second complete historical
rollup took 57.768 seconds including admission wait, above the 48-second gate.
Historical and current-day totals, coverage and eight audited CSV checks passed.
All owned containers were removed, but a coordinator exit-receipt race left its
exit status unavailable; that run does not prove clean coordinator shutdown.
API CPU throttling, database write waits and pre-admission authentication failures
require further correction. They do not establish a connection leak. Its raw
pool counters also double-observe Promise checkout calls; the HTTP failures are
independent and remain failures.

[CI at `9630c009`](release-evidence/release-297/usage-contention/ci-9630c009-final-01/manifest.json)
passes all 17 jobs and three security workflows. The subsequent
[single-checkout instrumentation correction](release-evidence/release-297/usage-contention/fair-main-pool-public-connect-followup-01/manifest.json)
at `5d543f40` passes 54 focused cases, eight native cases, the application test
under both database roles and 1,864 unit cases (four conditional skips).
Its [local image](release-evidence/release-297/usage-contention/candidate-artifact-5d543f40/manifest.json)
passes the full pinned scan with zero findings and embedded compatibility checks.
Linux/amd64 manifest:
`sha256:b163e683f50d2303b1b8aff8d96dbbce6e5d20c3dab715357da67af7a5528d38`;
archive SHA-256:
`9adb8d976bae3c513ebaced258b9b4dc68f1cc338a6ecd73682666c81766efae`.
The permanent packet is
`C:/Users/zinka/.codex/artifacts/release297-candidate-5d543f40-01`.
These local artifacts are not pushed or deployed. The subsequent
[identity scheduling correction](release-evidence/release-297/usage-contention/fair-main-pool-user-identity-01/manifest.json)
at `6035239b` gives fresh credential-backed user lookups a separate fair turn,
alongside ordinary work and admitted reports, in the same pool. Identity is
rechecked after waiting; heartbeat entitlement retains its ordinary lane.
All 66 focused cases, native owner/restricted cases, build/type/cast checks and
1,868 unit cases pass (four conditional skips).
[CI on `2378e04e`](release-evidence/release-297/usage-contention/ci-2378e04e-final-01/manifest.json)
passes all 17 CI jobs and the three security workflows for those application
bytes. Actual-workload capacity, final images and recovery rehearsal remain
pending. The following development checkpoints retain their original
source-specific results; they do not supersede this current status.

## Historical development checkpoints

The following paragraphs retain the status at each named source checkpoint.
Use the current selection table below for release preparation; historical
images and passing checks do not select the final release source.

The [initial API connection scheduler correction](release-evidence/release-297/usage-contention/fair-main-pool-scheduler-01/manifest.json)
adds alternating FIFO admission for report and other main-pool requests when
Usage reporting is enabled. Default-off API, worker and session pools keep
native scheduling. The existing configured connection limits and deadlines
remain unchanged. Build/type/cast checks, 38 focused tests, eight native driver
cases and the actual application regression under owner and restricted roles
pass. Cancellation retains ownership until cleanup finishes. Native logical
pool limits are preserved; closing sockets are tracked through shutdown without
claiming a stricter physical-socket ceiling. At that checkpoint, combined
capacity and final-source checks were pending. The historical `9630c009` image
below includes this initial scheduler; it predates the later identity lane.

The [historical local `9630c009` candidate](release-evidence/release-297/usage-contention/candidate-artifact-9630c009/manifest.json) has passed the pinned full image scan with
zero findings and the embedded 129-table/lifecycle/default-off checks. Its
Linux/amd64 manifest is
`sha256:c3759c8b69acb47feb5dc1dc5416b77f9d5e1a2eccb76bbf1646c96d966a67c5`;
archive SHA-256 is
`0c87d73aae62c026bb7a7fb05259fec5325d3865b682e14d0241c3a2884c53f3`.
The local artifact packet is
`C:/Users/zinka/.codex/artifacts/release297-candidate-9630c009-01`, with manifest
`1afd8c43cb29934e9cd4bc05925e3e466f8c3cf56b981b2525fa81339e79299e`.
It has not been pushed to a registry or deployed. The separately archived
[per-role harness startup](release-evidence/release-297/usage-contention/linux-role-startup-01/manifest.json)
proves resource limits, pool readiness and clean shutdown on earlier source
`204ae93d` with zero traffic. It does not establish capacity for either source.

The [final `9fc4b0e` CI record](release-evidence/release-297/usage-contention/ci-9fc4b0e-final-01/manifest.json)
contains 16 successful jobs and one cancelled rollout-safety job, plus three
successful security workflows. The new source push superseded that run; it is
not a fully green checkpoint. The later `9630c009` CI result is recorded above.

The earlier [combined diagnostic at `204ae93d`](release-evidence/release-297/usage-contention/linux-combined-204-01/manifest.json)
fails acceptance: 4,840/6,000 heartbeats and 51/64 reports succeeded; 974
heartbeats failed, 186 offers were refused and 140 were late. Both historical
workers produced correct totals in 19.107/42.142 seconds, but 978 acquisition
failures and 10 aborted responses prevent acceptance. Current-day and CSV
correctness checks were not reached. Physical ownership returned to zero and
all owned fixtures were removed. The final unchanged-source check was not
reached; the record leaves that field unavailable. This shared-container Linux
diagnostic does not reproduce production CPU and memory limits per role.

The exact local `204ae93d` candidate built and passed the pinned full scan with
zero findings. Its Linux/amd64 manifest is
`sha256:7d20930a7105d0e805eb7c221a81973998a02930de8185684b1b5acf083b4b9b`;
the exported archive SHA-256 is
`d7fcd3d8b7b55d2719262f92231153ae46ff81e0d5b653d16a5b7f8acbc02b8a`.
Embedded 129-table/lifecycle compatibility checks and default-off Usage pass.
The permanent local artifact manifest is
`1428153e1985b0fee87b5142efea9b4f28ccfdbd6f7a4afd3bad05064d498a57`.
This image is retained for local validation; its build and scan do not override
the failed capacity result or establish registry/deployment identities.

The later [204ae93d CI checkpoint](release-evidence/release-297/usage-contention/ci-204ae93d.json)
passes security workflows and 16 CI jobs but fails the rollout-safety startup-probe
test: the monitor records a generic exception instead of the expected fatal
reason. Root cause and a verified correction remain pending.
The [test-only diagnostic follow-up](release-evidence/release-297/usage-contention/rollout-failure-diagnostics/manifest.json)
preserves bounded, redacted mock failure output before cleanup and uploads it in
CI. Five evidence assertions and 169 targeted rollout assertions pass locally;
the original exception did not reproduce. The full CI suite remains unchanged
and must pass on the new head. Production monitor behavior is unchanged.

The [next CI/checkpoint record](release-evidence/release-297/usage-contention/test-lane-listing-flush/manifest.json)
retains `35712eb`'s 15 successful CI jobs, two failures and three successful
security workflows. The infrastructure failure is reproduced and corrected:
lane listing now waits for piped stdout to flush before exiting. Local checks
pass 1,825 unit cases (four existing skips) and 699 infrastructure cases on
unchanged source. The other failure identifies a test generator that was no
longer live at binding validation; its exact underlying cause is not established.
The [fixture lifetime correction](release-evidence/release-297/usage-contention/rollout-live-harness-lifetime/manifest.json)
passes the full 380-assertion rollout suite, 15 lifecycle assertions and five
failure-evidence assertions. Mock generators now publish actual readiness and
remain owned until atomic release or verified rollback containment. Production
monitoring and rollback behavior are unchanged. Fresh complete CI remains
required; neither historical exception is relabeled as a known resolved cause.

The subsequent [Linux ingestion CPU diagnostic](release-evidence/release-297/usage-contention/linux-ingest-cpu-01/manifest.json)
fails with 5,832 successful offers and 168 refused offers out of 6,000, despite
zero request/acquisition failures and clean drain/cleanup. It omits concurrent
reports and rollups, so it cannot count as combined capacity. Its [clipped CPU
analysis](release-evidence/release-297/usage-contention/linux-ingest-cpu-analysis/manifest.json)
guides further measurement; no deployment recommendation follows from it.

A later [ingestion-only SQL-shape diagnostic](release-evidence/release-297/usage-contention/linux-ingest-sql-shape-01/manifest.json) delivered all 6,000 heartbeats with
no refused, failed or late offers and no acquisition failures. The source was
still the historical `d6492333`, and reports and rollups were absent. It improves
attribution without establishing combined capacity or a deployment green light.

The preceding [owned inbox correction](release-evidence/release-297/usage-contention/heartbeat-owned-inbox/manifest.json)
reuses the final heartbeat tenant connection without removing the locked inbox
eligibility check. Expiry uses the database's current clock after foreground
delivery; process-local suppression updates only after commit and connection
cleanup. Forty-eight focused cases and 19 native cases under each database role
pass, including durable claim rollback and preservation of required preparation
writes. The load gate requires zero optional inbox failures. This reduces an
equivalent recovery from 33 to 27 SQL statements and two connections to one;
it is not capacity acceptance. The new combined load run remains required.

The subsequent [inbox owner projection](release-evidence/release-297/usage-contention/inbox-projection/manifest.json)
reduces authority discovery from five queries to two, retaining its fresh row
lock, database-clock checks, canonical ownership ranking and all delivery fences.
Twenty-seven focused and 21 owner plus 21 restricted-role native cases pass.
The full build, type/cast checks and 1,824 unit cases pass on unchanged source;
four conditional skips remain explicit. The full equivalent recovery now uses
24 statements and one lease. Measured capacity and new-head CI remain required.

[Combined checks11](release-evidence/release-297/usage-contention/combined-checks-attempt-11/manifest.json)
pass the build and 699 infrastructure cases; four unit VM-context failures are
retained. The [test-only follow-up12](release-evidence/release-297/usage-contention/combined-checks-attempt-12/manifest.json)
passes types/casts and 1,823 unit cases, with four named conditional skips.
The comparison proves the two changed tests do not alter the application or any
of the 60 infrastructure-selected files and their selector. Final-source capacity
and fresh remote CI remain required.

<!-- End of the verbatim historical block. -->


## Archived checklist-preface-and-status — superseded as current state on October 7

This exact canonical text retains its dated checkpoint; use the [generated current status](RELEASE_2_9_7_OPERATOR_CHECKLIST.md#current-release-status) for current preparation. Its original current/pending/authorization wording is historical. Canonical block SHA-256: `a1d617ad8546591f3c937194f1d60b3ce982e433121f49953b75f3d647279b1c`. Only line endings are normalized.

<!-- historical-block:checklist-preface-and-status:start -->
**Latest merge status:** the owner authorized reviewed release merges after final CI. [ClassPilot #123 is merged with five green resulting-main checks and unchanged package bytes](release-evidence/release-297/release-gate-policy-20261003/classpilot-merged-main-03a9-passed.json). SchoolPilot #603 is held on its concrete test-only mock timing correction and the artifact-preparation follow-up; fresh combined-head/main checks remain required. Use the [latest follow-up](RELEASE_297_DEPLOY_READINESS.md#october-4-merge-and-operator-tool-follow-up) and [artifact-only interfaces](RELEASE_ARTIFACT_PREPARATION.md). Historical no-merge statements below describe their dated checkpoints. Publication, deployment and activation remain separate operations.

**October 4 update:** use [current deploy-readiness evidence](RELEASE_297_DEPLOY_READINESS.md#october-4-preparation-update), the [operator preparation addendum](RELEASE_297_OPERATOR_PREPARATION_AUDIT.md) and the [compatible fallback supplement](RELEASE_297_COMPATIBLE_FALLBACK_PREPARATION.md). The selected 250-client heartbeat/staff-read envelope retains its full-manifest fixture scope; deployment remains DeSales's 133 clients. The corrected, separately approved catalog inspection completed with 121 protected tables and 43 completed production migrations. The source-derived ordinary 43-to-53 migration/service recovery and restricted restoration now have accepted completed components, with original failures preserved. All three fresh candidate comparison runs on that 53-entry schema pass, but the strict comparison remains FAILED on the older baseline's latency and unstable controls. The [current-school gate amendment](RELEASE_297_DEPLOY_READINESS.md#approved-current-school-gate-correction) is separately owner-approved, and its bounded numerical criteria pass. It adds no merge, deployment, publication or activation permission. The missing unused 128-table preparation path is implemented and independently reviewed. All 20 SchoolPilot checks pass at `30b87475` and all ten ClassPilot checks at unchanged `8069a9c9`; later preparation heads/main still need checks. Published/registered recovery artifacts and operational gates remain pending. Both new Usage modes stay off. Historical checkpoints retain their original outcomes and do not establish a deployment green light.

The shared distinct-report slice is integrated as `1091eaeb` from reviewed `e330c39a`. [Source binding](release-evidence/release-297/release-gate-policy-20261003/harness-integration-1091-source-binding.json) verifies the 11 identical reviewed Git blobs and unchanged application/schema/build/infrastructure inputs; CRLF-only working differences remain explicit. The [focused component proof](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-shared-pure-passed-02.json) passes 48 unique cases and 11 syntax checks, with [independent review](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-shared-independent-review.json). The [full primary aggregate](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-1091-pure.json) passes all 139 unique cases (133 harness plus six report-cost cases), no skips/cancellations/TODOs, in 14.496 seconds with the configured 20-second test timeout, with [independent aggregate/source review](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-1091-independent-review.json). The [earlier dependency failure](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-shared-pure-failed-01.json) remains failed. At that historical 1091 checkpoint, helper/protocol-native verification, distinct-report capacity and new-head CI remained pending. Later native proofs and the exact 28f CI checkpoint are recorded above; actual distinct-report capacity remains pending, and later heads still require applicable checks.

The [fresh final-source Usage attempt `df9199c13d82`](release-evidence/release-297/release-gate-policy-20261003/usage-native-ddc5996b-df919-failed-03.json) failed: 2,655/6,000 heartbeats succeeded, 3,345 returned HTTP 503, and 56 offers were late. All 64 generator reports and 26 original lifecycle events passed, but final independent current-day/coverage/CSV/audit oracles were not reached. One heavy worker completed in 39.268 seconds; the second hit PostgreSQL statement timeout. [Status/ownership review](release-evidence/release-297/release-gate-policy-20261003/usage-native-df919-status-ownership-review.json) verifies admission denials match the 503 count, no acquisition failures and complete unforced drain. [Worker budget review](release-evidence/release-297/release-gate-policy-20261003/usage-native-df919-worker-budget-review.json) records the shared FIFO admission and 60-second whole-operation budget, including waiting; no standalone 60-second SQL execution is established. The retained CPU capture also failed its unchanged timing guard. All five PostgreSQL errors remain included. This is a failed capacity attempt with zero accepted cold runs and two later attempts held. Host interference, a connection leak and a causal query bottleneck are unproven. Both new Usage modes remain off. The original strict dark comparison remains FAILED; the later approved bounded DeSales numerical criteria pass. Final CI, artifacts and operational/live gates still prevent a deployment green light. Targeted fresh-fixture diagnostics are preparation, not replacement acceptance.

Status: release stabilization and separate Usage activation work in progress.
The owner's October 3 amended [release policy and acceptance gates](RELEASE_297_DEPLOY_READINESS.md)
are authoritative for current preparation; earlier dated checkpoints below
preserve their original outcomes and superseded gate wording. No deployment green
light, merge, production deployment, capability activation or Store publication
is recorded by this document. The current release inventory is
[here](RELEASE_2_9_7_PR_INVENTORY.md). Preserve the historical September 30 evidence;
its 2.10.0 package results do not certify this successor.

The dated October 2 [read-only production snapshot](release-evidence/release-297/readonly-production-20261002.json)
records existing-service health, the bounded metrics window and verification
limits at its recorded time. It is not current health verification, candidate
capacity evidence or approval for an operational window.
The historical [combined CI checkpoint](release-evidence/release-297/ci-app-checkpoint-d69322ef.json)
preserves exact successful logs, test counts, conditional skips, source-tree
equivalence and deployment-tool results. The current Usage contention changes
have separate [incremental evidence](release-evidence/release-297/usage-contention/README.md)
and still require frozen-source acceptance. Earlier CI does not cover them.
A conditional skip is not a passed test.

## Current preparation status

Current application source is `ddc5996b3b8645859fa51a9613486db52c481b7f`.

The [three full 900-second classroom runs](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-passed-block.json) and [complete independent review](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-independent-review.json) pass on application `ddc5996b` and frozen helper `7238c17c`, with both new Usage modes off. All 36,309 heartbeat offers have exact persisted bindings; 180 commands and 90 private messages pass native recipient/lifecycle checks. All 45 minute acceptance sets pass. Worst minute p95 is 115.317 ms and highest API minute CPU is 24.7454%; exact physical API loss precedes reconnect and all resources clean up without force. This is current-school synthetic classroom acceptance. The strict dark comparison, separate Usage capacity, broader 800-client capacity and operational/live gates remain separate.

The [fresh read-only production observation](release-evidence/release-297/release-gate-policy-20261003/readonly-production-20261004-03.json) finds unchanged serving versions/settings, one API and one worker, a healthy API target, and 121 configured admission tables. RDS is available with 14-day backup retention and a restorable point about three minutes before the check. Sunday metrics do not establish school-day capacity; actual catalog/ledger/privileges, successful restore evidence and an approved operational window remain unverified. No production database connection or cloud mutation occurred.
The combined standard backend type check passes. The narrow Redis correction
passes [24 component checks, including four native regressions](release-evidence/release-297/release-gate-policy-20261003/realtime-native-green-02.json),
and the [restricted-role health correction](release-evidence/release-297/release-gate-policy-20261003/health-native-green-03.json)
passes six native checks. [Fresh serving/fallback builds and scans](release-evidence/release-297/release-gate-policy-20261003/runtime-artifacts-ddc5996b-c578120d.json) pass with zero HIGH/CRITICAL findings. The [actual API/worker staged recovery](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-passed.json) passes bridge, adoption, compatible fallback and return, preserving all 54 completed migrations, function permissions and chat expiration. Eight services drain gracefully and the exact synthetic resources are absent. Its synthetic schema/protocol limitations remain explicit; it does not verify the production catalog or ECS/ALB drain. [Combined CI at `dd6d54c0`](release-evidence/release-297/release-gate-policy-20261003/ci-dd6d54c0-complete.json) passes all 20 SchoolPilot checks and all 10 unchanged ClassPilot checks. Measured release acceptance remains pending.
Earlier application images and measurements do not certify the revised source.

The [fresh capability-on 34/s run](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-native-c1a09-ddc-summary.json), bound to `ddc5996b`, passes all 2,040 offers and exact persistence/recipient checks, p95 179.874 ms and 55.386% fixed-window API CPU. Its [native oracle preparation proof](release-evidence/release-297/release-gate-policy-20261003/classroom-native-oracle-c1a09-ddc-proof.json) separately verifies produced delivery/thread rows and rejects wrong-binding mutations. Both new Usage modes are off. Neither accepts a failed continuous mixed attempt or replaces the required dark comparison/three mixed passes.

The [refreshed helper-13 normal-load check](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-native-7238-ddc-summary.json) passes all 2,040 offers and exact persistence, p95 162.860 ms and fixed-window CPU 54.886%, with eight commands/four messages, complete error coverage and unforced cleanup. The [short native loss-boundary proof](release-evidence/release-297/release-gate-policy-20261003/classroom-loss-boundary-7238-ddc-native-proof.json) verifies all 399 requests/rows and physical API0 absence before reconnect. It is preparation-only and cannot replace a full 900-second run. The complete three-run block and independent evidence review above now pass.

The [next native mixed attempt remains failed](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-c1a09-ddc-failed-summary.json): all 12,103 offers and exact persistence, 60 commands/30 messages and cleanup pass; one loss-minute ordinary offer went to API0 instead of a declared survivor. Two subsequent attempts were held. The correction from `7238c17c`, integrated as `15100dc3`, uses exact declared offsets for routing, records actual dispatch, requires independently counted pre-loss ingress and clean physical shutdown before reconnect. [All 81 focused checks and exact generated-wrapper red/green](release-evidence/release-297/release-gate-policy-20261003/harness-boundary-7238c17c-public-summary.json) pass. Native preparation, the refreshed normal-load check and the separate fresh full mixed acceptance above now pass. The historical individual skew is inferred, not recorded. No failed run is accepted and no workload/limit is reduced.

Historical application `ed026513` passes 2,032 local unit tests without skips and all 20
reported CI checks. Its fresh local API/worker image has zero HIGH/CRITICAL scan
findings; the frontend is rebuilt and the 54-migration/129-table synthetic schema
is verified. Exact hashes and verification limits are in the [application record](release-evidence/release-297/release-gate-policy-20261003/application-correction-summary.json)
and [CI/package checkpoint](release-evidence/release-297/release-gate-policy-20261003/ready-checkpoint-ed026-20261004-01.json).
The [fresh review-head checkpoint](release-evidence/release-297/release-gate-policy-20261003/ci-ca388d10-complete.json)
also verifies all 20 SchoolPilot checks at `ca388d10`, all 10 ClassPilot checks,
and unchanged application/frontend/package inputs. Resulting-main checks remain
required after separately authorized merges.
The corrected safe fallback passes its scan and [actual image recovery](release-evidence/release-297/release-gate-policy-20261003/recovery-ed026-6d1f3a7e-summary.json).
The earlier [staged service rehearsal remains failed overall](release-evidence/release-297/release-gate-policy-20261003/staging128129-partial-05.json).
Its actual 128-admission bridge, worker appointment maintenance and SQL drains are
verified; that attempt did not establish 129-adoption/fallback. The earlier synthetic advertised-capability
telemetry setup is recorded as a limitation, not accepted client support.
The [subsequent real-heartbeat staging attempt](release-evidence/release-297/release-gate-policy-20261003/staging128129-failed-06.json)
also failed overall. A [native Redis diagnostic](release-evidence/release-297/release-gate-policy-20261003/realtime-native-regression-ed026.json)
confirms valid empty snapshots become unreadable and same-millisecond revisions
lose ordering; its failed cleanup import remains recorded. Snapshot and
health-monitor compatibility corrections are integrated with native proof. Fresh source-bound serving/fallback scans and complete local service recovery now pass; later review heads and resulting main still require CI, and the remaining comparison/operational gates still require acceptance.
The ed026 artifacts and previous measurements remain historical evidence.
New paired/current-school comparison remains pending; the three continuous classroom runs now pass as recorded above. Usage capacity has zero accepted runs and both new Usage modes remain off.
The [initial continuous mixed block](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-6afc8-failed-held.json)
retains two failed attempts and an unreserved third attempt. Its positive
classroom fixture included an idle school; a new reviewed harness revision and
fresh three-pass campaign are required. Completed heartbeat traffic is partial
evidence and does not accept the failed classroom checks.
The [new harness correction](release-evidence/release-297/release-gate-policy-20261003/harness-active-audience-631fb338-summary.json)
passes 53 focused checks, including regressions that fail on the preceding
harness. It is integrated as `0691cdb8`; helper refresh and measured acceptance
are still pending.
The [October 4 synthetic fixture and restricted-role restoration](release-evidence/release-297/release-gate-policy-20261003/usage-oct4-snapshot-preparation.json)
pass preparation checks; their authority expires at 11:12:21 Eastern that day.
They do not count as a capacity run or a production catalog inspection.
The owner is waiting to submit ClassPilot until preparation is complete.

<!-- historical-block:checklist-preface-and-status:end -->


## Archived checklist-selection — superseded as current state on October 7

This exact canonical text retains its dated checkpoint; use the [generated current status](RELEASE_2_9_7_OPERATOR_CHECKLIST.md#current-release-status) for current preparation. Its original current/pending/authorization wording is historical. Canonical block SHA-256: `faeb5c60d551169909f155c76b8b2b5f489a2d0feaa43a256c4ed9abec5beb9f`. Only line endings are normalized.

<!-- historical-block:checklist-selection:start -->
## Current release selection and evidence

The current application source is `ddc5996b`; the earlier prepared artifacts are
bound to `ed026513` and are historical. Runtime corrections require refreshed
serving and fallback images. Selection for execution still requires accepted
release gates, final review-head and resulting-main checks, recovery and fresh
production verification. Historical images and failed campaigns remain intact.

| Item | Current selection / evidence limitation |
|---|---|
| SchoolPilot baseline | `996d965f0b044f8fc4d4bbc399c5ab3781fbac04`; origin/main remains separate from the open integration PR |
| Integration branch | `codex/release-stabilization-297`; [SchoolPilot #603](https://github.com/bzinkan/SchoolPilot/pull/603); preserve and later reconcile incorporated review branches |
| Application source / CI | `ddc5996b3b8645859fa51a9613486db52c481b7f`; standard backend type check passes. [Combined CI at dd6d54c0](release-evidence/release-297/release-gate-policy-20261003/ci-dd6d54c0-complete.json) passes all 20 SchoolPilot and 10 ClassPilot checks, with exact application/build input binding and ten named native runtime regressions. Later harness/test/documentation heads and approved resulting main also need checks and equivalence proof. The [ca388d10 checkpoint](release-evidence/release-297/release-gate-policy-20261003/ci-ca388d10-complete.json) remains historical. |
| Current correction / local checks | [2,032 unit passes, no skips](release-evidence/release-297/release-gate-policy-20261003/application-correction-summary.json). Bounded Usage heartbeat admission, pool fairness, delta rollup writes and tenant-owned atomic cleanup/audit are included. |
| Local API / worker candidate | Source `ddc5996b`; index `sha256:8ae47ef898382883c20406c83a97728168d115d47345b7790701cb266fd7c835`; amd64 manifest `sha256:fdd0296f74621dba2b74ceae242e171d681a965e9fb8b65fdcbb72db9502d05d`. Build/scan pass with zero HIGH/CRITICAL findings including unfixed. [Exact local artifact/operator bindings](release-evidence/release-297/release-gate-policy-20261003/runtime-operator-artifact-facts.json) distinguish index, platform and config. Local preparation is not registry publication, a deployed task pair or release approval. |
| Compatible fallback | Source `c578120d980d4c2405a72f4f40b2d3c29a07e20b`; index `sha256:2fd61fdbda527a0f72cdd947db719531b92e0e5b14cebe5bff2cbd8c62abfd08`; amd64 manifest `sha256:405f738bc0da4baa99b6e892dd827459cf98c216dbc09232bd3c29d5fcac33a1`. The fresh scan and actual staged recovery pass. Its declared 53 migrations preserve all 54 completed database entries and the added screenshot function. Both new Usage modes must remain off. The old production image is invalid after lifecycle adoption. |
| Schema / recovery | [Actual API/worker staging and recovery passes](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-passed.json), with [independent review](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-independent-review.json): all 54 ledger entries, screenshot function body/ACL and chat expiration/history retained; eight actual services drain gracefully. Sixteen containers, two volumes and network are absent. Synthetic copied-ledger/schema and protocol clients do not establish production migration history, Chrome/SSO, exact Focus/combined Classroom acceptance or ECS/ALB drain. The [historical image-function recovery](release-evidence/release-297/release-gate-policy-20261003/recovery-ed026-6d1f3a7e-summary.json) remains separate. |
| Frontend | Fresh ed026 lint/build artifact SHA-256 `7a262bf6704928194ec43cc9da0523084a935a24a040c4de20b2c7a06c321675`. All four frontend release CI shards pass for the application. No frontend was published. |
| ClassPilot integration / CI | [ClassPilot #123](https://github.com/bzinkan/ClassPilot/pull/123), #119 → #120 → #121 → #122 ancestry. Documentation-only head `8069a9c9bd50352e187847158b356a69edc4e45d` has all 10 checks passing, including Chrome 120/133/152/stable. PR remains open/draft. |
| Extension identity / package | `iggbfegfcjkfieoemeolfmfnapepalca`; version 2.9.7; packaged source `065be165b5df704d84eb716e3fb914c1fed17f98`; ZIP SHA-256 `82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`. Unchanged 24-file verification passes; copy is at C:/GitHub/ClassPilot/dist/ClassPilot-v2.9.7.zip. |
| Heartbeat retry compatibility | [Four packaged-function controls pass](release-evidence/release-297/release-gate-policy-20261003/packaged-heartbeat-retry-297-summary.json): heartbeat retries at most twice, honors 503 Retry-After, cancels retired auth and excludes overlapping heartbeats. No ZIP bytes changed. |
| Store state | Last public observation: 2.9.6, updated September 27. Pending developer submissions remain unverified. Repeat both checks immediately before separately authorized upload; submission is held. |
| Release capacity | [Fresh helper-13/ddc5996b capability-on34/s](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-native-7238-ddc-summary.json) passes all 2,040 offers and exact recipient/persistence, p95 162.860 ms and fixed-window CPU 54.886%. The [short native physical-loss proof](release-evidence/release-297/release-gate-policy-20261003/classroom-loss-boundary-7238-ddc-native-proof.json) passes all 399 requests/rows, but cannot replace full acceptance. Historical [candidate sole133 measurements](release-evidence/release-297/release-gate-policy-20261003/sole-f8af7-completed-failed.json) do not accept the failed strict paired comparison; the normal comparison remains incomplete/failed. Three full mixed passes and their independent review now pass; the dark production-capability comparison remains pending. All prior failures remain preserved. |
| Usage capacity | Zero accepted runs. Separate three-API campaign and deployed observation gate Usage activation. A faster unchanged-grain component is not capacity acceptance. DeSales is the only live school; all load schools are synthetic. |
| Live pilot / validation | DeSales screenshot showed 133 students; current production UUID, eligibility and participating clients remain unverified. No live acceptance has started. Require at least 30 sample-bearing minutes after separately authorized staged release. Managed two-Chromebook gate remains waived_not_passed. |
| Deployed / activated | No changes performed by this release preparation |

The [structured PR inventory](release-evidence/release-2.9.7-pr-inventory.json)
records exact heads, dependency bases, disposition and inclusion proofs. Its
checkpoint is a review snapshot, not a final artifact identity. Final evidence
must retain failed attempts and identify their source, environment and repair;
never substitute a later passing run for an earlier failure.

For the new 2.9.7 profiles, the legacy field names `RequiredMergeSha` and
`classPilotMergeSha` identify the **exact packaged source** above. They do not
prove a merge. Preserve that commit through a separately authorized merge and
record the actual merge commit independently. After that merge, the version tag
must point to the packaged ancestor, not to a different build. Before any upload
or activation, run these checks in the ClassPilot repository and verify the ZIP
hash against the value above:

```powershell
git fetch origin main --tags
git merge-base --is-ancestor 065be165b5df704d84eb716e3fb914c1fed17f98 origin/main
git rev-parse 'v2.9.7^{commit}'
Get-FileHash -Algorithm SHA256 -LiteralPath .\dist\ClassPilot-v2.9.7.zip
```

Require the ancestry command to exit zero and the tag output to equal that exact
40-character source SHA. The runtime receipt compares pinned literals; it does
not resolve the ClassPilot tag itself. A missing tag, squash/rebase that loses
the source ancestry, changed source or changed ZIP requires reconciliation and
new acceptance/bindings. These checks do not authorize creating or publishing a
tag, and no 2.9.7 tag or merged status is claimed here.

<!-- historical-block:checklist-selection:end -->


## Archived readiness-preface — superseded as current state on October 7

This exact canonical text retains its dated checkpoint; use the [generated current status](RELEASE_2_9_7_OPERATOR_CHECKLIST.md#current-release-status) for current preparation. Its original current/pending/authorization wording is historical. Canonical block SHA-256: `99ed209e5c239f1d419cea91125bd1fee5a57d1ad2bcc85294aadb9186fefc2c`. Only line endings are normalized.

<!-- historical-block:readiness-preface:start -->
## October 4 merge and operator-tool follow-up

The owner subsequently authorized merging the reviewed release work once its final CI passes. [ClassPilot #123](https://github.com/bzinkan/ClassPilot/pull/123) is merged at `03a9c3633d1e1f7d763ea5cf910f870994400e02`; [resulting-main evidence](release-evidence/release-297/release-gate-policy-20261003/classpilot-merged-main-03a9-passed.json) records all five checks passing, an empty release-to-main source diff and the unchanged 2.9.7 ZIP. Incorporated ClassPilot #120–#122 are closed, with their branches retained; #119 was automatically merged. This authorizes neither deployment nor Store publication.

SchoolPilot #603 remains held. Its `caacdf5f` checks finish with 19 successes and a [rollout-safety failure](https://github.com/bzinkan/SchoolPilot/actions/runs/37235213540/job/111532897509): the first mock sample took 13.4 seconds and met a ten-second completion minimum before the intended three stale observations. The [retained diagnosis](release-evidence/release-297/release-gate-policy-20261003/ci-caacdf5f-runtime-stale-failed.json) and [focused verification](release-evidence/release-297/release-gate-policy-20261003/ci-runtime-stale-fence-focused.json) cover the original one-sample false-positive, corrected third-observation failure, four other negative cases, unchanged fresh control and eleven source assertions. The external proof aggregation initially failed on scalar `.Count`; an additive retained-record replay verifies the completed cases without re-execution and preserves that failure. The test-only correction is integrated as `112741c8`; it fences cumulative acceptance with the existing owned-child watchdog and retains the failure thresholds and iteration limits. Production monitor code and timeouts remain unchanged. The combined correction and [artifact-only preparation tool](RELEASE_ARTIFACT_PREPARATION.md) require new-head CI before merge; resulting-main checks and application equivalence then follow. Original CI failures remain preserved.

The old candidate-rehearsal flags are retired, and the capacity-acceptance route is paused. Neither prepares release artifacts. The supported replacement separates publication and unused-definition registration from migration, service rollout and activation, each with its own actual source-bound plan and authorization. The immutable-image publication workflow remains disabled. No registry publication, unused registration, deployment or activation is recorded here.

The artifact adapter's [corrected mocked suite](release-evidence/release-297/release-gate-policy-20261003/artifact-preparation-pure02-passed.json) passes all 24 cases and two syntax checks in 5.307 seconds within the unchanged 20-second bound, with zero skips/cancellations and exact unforced process absence. Its [first attempt](release-evidence/release-297/release-gate-policy-20261003/artifact-preparation-pure01-failed.json) remains FAILED at 15/24: the existing validator correctly rejected request-level ECS tags placed inside a response's taskDefinition. The narrow fix separates those shapes without changing the validator. All AWS, Docker and GitHub operations in these tool tests are mocked; no real artifact publication or registration is accepted. Final combined-head and main CI remain required.

Independent final reviews clear the [artifact source and both retained pure attempts](release-evidence/release-297/release-gate-policy-20261003/artifact-preparation-independent.json) and the [test-only monitor correction and retained outcomes](release-evidence/release-297/release-gate-policy-20261003/ci-runtime-stale-fence-independent.json). The artifact controller is integrated as `6f386e39` from `28ec1e4a`; the monitor correction is integrated as `112741c8` from `3ff9869e`. Application, schema, package, build, infrastructure and CI workflow inputs remain unchanged from DDC. The previously reviewed frontend browser-test delta remains explicitly separate from frontend application inputs.

## October 4 preparation update

The final application passes three fresh candidate runs on the ordinary 53-entry schema at DeSales's 133-client load. Migration/service recovery, restricted restoration and the compatible-definition preparation tool have accepted local evidence. The matched eight-run comparison is complete but its unchanged strict gate remains FAILED because the retained production baseline misses latency acceptance and its latency controls are unstable. The owner has approved the bounded current-school gate correction below. Its numerical criteria pass for DeSales with both new Usage modes off; the original strict comparison remains FAILED. This is readiness-criteria approval, not a deployment green light. Final preparation-head CI and separately authorized merge/publication/registration/operational gates remain required.

The [corrected approved production metadata inspection completed](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-60cd65-completed.json) on October 4 at 12:35 Eastern, with [independent closure and migration reconciliation](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-60cd65-independent.json). It observed 121 forced-RLS tables, 43 completed migration records with no incomplete records, DeSales's active ClassPilot entitlement and the required existing health-sentinel permissions. The temporary task stopped successfully and its definition was deregistered; no serving service or database record changed. Ordinary expansion adds ten required migrations for 53 completed entries and eight protected tables for 129. The optional staff-identity contract remains deferred. The historical full-manifest fixture includes that additional optional record; the new source-derived rehearsal below starts at the observed 43-entry vector and excludes it. Neither fixture is an export of actual production DDL. The new screenshot-evidence function is absent in production and must be installed and verified through its supported migration before candidate serving.

CI at `b6cadc74` passed compilation and builds but failed one harness unit test that read a historical Git object unavailable in the CI checkout. The test-only repair is integrated as `28f256d6`: it preserves the exact historical fixture and profile assertions, and [passes all 19 focused tests plus two syntax checks with Git unavailable](release-evidence/release-297/release-gate-policy-20261003/ci-historical-profile-fixture-pure-passed.json), with [independent replay](release-evidence/release-297/release-gate-policy-20261003/ci-historical-profile-fixture-independent.json). [All 20 resulting-head SchoolPilot checks and ten ClassPilot checks pass](release-evidence/release-297/release-gate-policy-20261003/ci-28f256d6-complete-independent.json). The six named database-health and four Redis regressions also pass individually without skips. No application, schema, artifact or release gate is changed by that repair. Any later preparation head and resulting main still require their own applicable checks.

The [compatible fallback preparation supplement](RELEASE_297_COMPATIBLE_FALLBACK_PREPARATION.md) documents the implemented registration adapter, exact artifact bindings, supported interfaces and genuinely future publication inputs. Local verification does not substitute for actual registry publication, inactive task registration or a protected recovery rehearsal.

The [subsequent documentation head `30b87475` also completes all 20 named checks successfully](release-evidence/release-297/release-gate-policy-20261003/ci-30b87475-complete-independent.json). This is an exact-head metadata checkpoint; the detailed ten native health/Redis results remain bound to the earlier `28f256d6` proof. Later preparation heads and resulting main require their own applicable checks.

The [bounded worker observation](release-evidence/release-297/release-gate-policy-20261003/readonly-worker-observation-20261004.json), with [independent replay](release-evidence/release-297/release-gate-policy-20261003/readonly-worker-observation-independent.json), used nine GETs and no SQL or cloud mutations. One fresh, fully parsed staff-identity scan reports one school scanned and zero integrity findings, failures or overlap. Both returned log pages include continuation tokens, so the original strict window-completion fields remain unverified. ECS provider health remains `UNKNOWN`. This positive existing-job event is not complete worker, capacity or deployment acceptance.

The existing 133/250-client and mixed-classroom campaigns below used the full 54-entry synthetic fixture. Their source and schema bindings remain intact. The new production-default 43-to-53 rehearsal now has accepted completed components and stable restored exports, as recorded below. Its completed matched 133-client block and the later approved bounded decision below supply current-school numerical acceptance; the older metrics are not relabelled as measurements on the ordinary 53-entry configuration.

The [first production-default setup attempt failed](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-setup01-failed.json), with [independent failure and custody review](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-setup01-independent.json). The source schema constructor exited successfully, but the fixture attempted full RLS policy setup before the existing supervision-report migration created its three tables. No migration CLI or service ran. Exact owned resources are absent without forced cleanup; the failed probe's exit 1 remains recorded, so this is containment success rather than a graceful native pass. A narrowly reordered prospective attempt runs the actual baseline migrations before full policy verification; the original failure remains unchanged.

The [second setup attempt also remains failed](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-setup02-failed.json), with [independent custody review](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-setup02-independent.json). The actual baseline CLI completed all 43 expected callbacks with the optional contract deferred, then duplicate temporary-file allocation stopped preparation before policy/native-ledger verification or candidate serving. Both owned containers exited 0 and all owned resources are absent without force. Logged callback completion does not replace native checksum/mode/status or schema verification. The next prospective derivative changes only unique environment/proof allocation and preserves both failures.

The [third attempt remains failed overall](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-attempt03-partial-failed.json), with [independent review of its completed components](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-attempt03-independent.json). It verifies actual 43-to-53 migration callbacks and native checksum/mode/status vectors, 121/129 protected tables, both source-derived schema exports, repeat migration, compatible fallback retaining 53 records, and candidate return. All four actual API/worker phases pass their protocol oracles and full API health cycles; all eight services drain with exit zero, no OOM, no force and no remaining named SQL connections. A later schema-restoration assertion fails before the restored dump or restricted-role proof is retained. Its cause is unproven; schema restoration and a ready handoff are not accepted. All 27 owned containers, two volumes and the network are absent without force. A separate focused restore can supply the missing component while preserving this attempt's FAILED status. These local synthetic checks do not establish actual production schema equivalence, ECS drain, browser acceptance or capacity.

The [focused restore-only attempt 04 also remains FAILED](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-restore04-failed.json), before restricted probing or candidate restoration, with [independent custody closure](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-restore04-custody-independent.json). Its [retained raw-dump comparison](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-restore04-diff-independent.json) identifies exactly three existing CHECK lines whose first adjacent AND comparisons lose redundant inner grouping during PostgreSQL restoration. All predicates, constants and other canonical SQL bytes remain equal, including unchanged NULL behavior; the strict original fingerprint still fails. The sole owned PostgreSQL container exits zero and its volume/network are absent without force. A prospective source-derived stable export must retain this failure and the original dumps, permit only those three exact old/new lines, and pass a second native restoration with the unchanged strict fingerprint and full restricted-role checks. No generic SQL normalization or acceptance-policy change is permitted.

The [first stable-export attempt 05 remains FAILED](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-restore05-failed.json), with [independent custody closure](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-restore05-custody-independent.json). Its exact three-line fence passes, then the first restricted probe's synthetic school INSERT fails with PostgreSQL `42P08` because a reused parameter has conflicting text/varchar contexts. No second or candidate restore or accepted handoff exists. All owned resources are absent without force; the failed probe exits 1, so `gracefulCleanupPassed=false` remains recorded. A subsequent derivative changes only explicit school-ID parameter casts in the two synthetic INSERTs. Application code, fence, canonical helper, native assertions, resources and deadlines remain unchanged.

The [fresh stable-export attempt 06 passes](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-stable-restore06-passed.json), with [independent composition and custody review](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-composed06-independent.json). Both arms pass the exact three-line first-restoration fence and a second native restoration using the unchanged strict fingerprint. All four restricted-role probes pass their own-school, cross-school, unscoped, rollback and GUC-cleanup assertions. The restored baseline has 43 completed migrations and 121 protected tables; the candidate has 53 and 129. Both defer the optional staff contract. The candidate retains the required screenshot function body and ACL. All five owned containers exit zero, with no OOM or forced cleanup, and their volume, network and executor are absent. This composes the completed migration/service phases from attempt 03 with the missing restoration proof; attempts 03, 04 and 05 remain FAILED. These are source-derived synthetic exports, not dumps of actual production DDL. The [comparison input review](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-comparison-input-independent.json) verifies unchanged sources, declared options and acceptance rules before measurement.

The first matched fixed-order comparison [stops after failed baseline A1](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-comparison-A1-independent-failed.json), with seven later attempts held and no candidate measurement. All 798 baseline heartbeat offers succeed with exact persistence, no late offers and complete unforced cleanup. Its p95 is 1,812.536 ms, so latency acceptance fails. The external coordinator then incorrectly rejects the canonical `V2_NUMERICAL_ACCEPTANCE_FAILED` code before its intended metric-only diagnostic classification. Independent review verifies that latency is the only failed check; all safety, source, error-capture and cleanup guards pass. This baseline remains FAILED. The [two-line external classifier correction](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-comparison-classifier02-passed.json), with [independent replay](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-comparison-classifier02-independent.json), passes seven meaningful regressions and two syntax checks, including the actual retained A1 and rejected safety/code mutations. All four owned test processes are absent. This permits only the declared metric-only diagnostic continuation; canonical acceptance and strict comparison remain unchanged. Measured baseline CPU is 74.4171%; the original validator already exempts baseline CPU. At that classifier checkpoint no new CPU or latency waiver was approved; the later bounded owner decision is separately recorded below.

The [fresh fixed eight-run block completes](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-fixed8-complete-failed.json) in the unchanged `A,A,A,B,B,A,A,B` order. All 6,384 offers return HTTP 200 and persist exactly, with zero late offers or invalid bindings and no errors in the complete captured logs. Every source/safety/custody and unforced cleanup check passes. All three candidate runs with 53 migrations and 129 protected tables pass independently: 2,394 successful offers, p95 38.066/40.559/47.656 ms and fixed-window CPU 20.334/21.155/20.788%. All five baseline runs with 43 migrations and 121 protected tables remain canonical latency failures, with p95 1,445.867–3,237.122 ms and CPU 70.582–78.514%. Unchanged strict closure rejects its `runPassed===true` prerequisite; subsequent comparison checks are not executed or claimed passed. Independent descriptive arithmetic across the three declared pairs yields median CPU-per-success ratio 0.282355 and p95 ratio 0.024318. Conservative worst-candidate/best-baseline ratios across all eight are 0.300200 and 0.032960. Baseline CPU controls meet their 1.05 limit (ratio 1.034785), while p95 controls differ by 1,791.255 ms against 50 ms. Host interference and the cause of latency variation remain unproven. These measurements establish three candidate absolute passes, not an accepted strict comparison or broader capacity.

The [final read-only ClassPilot package check](release-evidence/release-297/release-gate-policy-20261003/classpilot-297-final-package-source-verification.json) confirms both 376,052-byte 2.9.7 ZIP copies retain SHA-256 `82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`. All 24 entries match the clean reviewed source at `8069a9c9`, whose extension files equal the packaged ancestor. No package rebuild occurred. The unsigned ZIP has no manifest key; the Store item ID is retained release provenance, not independently derived signed identity. Installed identity and capabilities still require live verification.

The compatible inactive controller now also supplies the previously missing [unused 128-table anchor preparation](RELEASE_297_UNUSED_ANCHOR128_PREPARATION.md), integrated as `fc079f27` from reviewed `add281b1`. [All 45 mocked cases and two syntax checks pass](release-evidence/release-297/release-gate-policy-20261003/unused-anchor128-pure-passed.json), with [independent source/custody review](release-evidence/release-297/release-gate-policy-20261003/unused-anchor128-independent.json) and [isolated source-commit binding](release-evidence/release-297/release-gate-policy-20261003/unused-anchor128-source-commit.json). The new path changes only the unused candidate definitions' exact admission list through 121→125→126→127→128. Existing fallback operations remain unchanged. Actual registry publication, input capture, Plans and registration remain separately authorized future operations. Before private-lifecycle adoption, prepare a matching 129-table fallback from the healthy dark 129-table serving pair; the 128-table fallback must not be reused after 129 adoption. Application/Docker/frontend/extension inputs are unchanged.

DeSales's 133-client workload has three fresh one-school passes on final application `ddc5996b`, with school-hours limits disabled and both new Usage modes off. All 798 offers per run persist with correct student/session bindings; authenticated own-school staff reads and foreign-school denials, full migration/RLS checks and unforced cleanup pass. Worst API CPU is 25.349% of its unchanged one-CPU quota and worst heartbeat p95 is 62.124 ms. [Retained results](release-evidence/release-297/release-gate-policy-20261003/lower-load-aaf95-ddc-sweep-failed.json) and [independent replay](release-evidence/release-297/release-gate-policy-20261003/lower-load-aaf95-independent-actual.json) distinguish these three passes from the failed overall campaign.

The higher-load campaign remains failed: 500 clients exceeded CPU and latency limits; the second 340-client confirmation exceeded the 50% CPU selection margin. Its third confirmation was held. A [new three-run 250-client confirmation passes](release-evidence/release-297/release-gate-policy-20261003/lower-250-aaf95-ddc-confirmation-passed.json), with [full independent replay](release-evidence/release-297/release-gate-policy-20261003/lower-250-independent-actual.json). All 4,500 offers persist correctly, all 36 scoped staff reads/denials and final native/log/cleanup checks pass; worst CPU is 40.954% and worst heartbeat p95 is 81.179 ms. The selected supported limit is 250 clients for this Usage-off heartbeat/staff-read profile; deployment remains DeSales's 133 clients, with its separately accepted classroom block. The later ordinary-schema production/candidate measurements and approved bounded DeSales decision are recorded above and below. Broader fleet capacity and Usage acceptance remain pending. Raw acquisition counters are unavailable in this unwrapped black-box profile; complete request outcomes, final captured-connectivity intervals and retained logs provide the explicitly indirect check.

The earlier production catalog inspection [failed before task launch](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-90304-failed-before-launch.json). The retained tagged ECS definition reproduces an environment-order mismatch against the old exact projection; the first verification response was not retained. Its temporary definition is inactive, no database task launched, and serving services and database records were unchanged. That failure remains archived after the corrected inspection above; it is not relabelled a pass. [Fresh service metadata](release-evidence/release-297/release-gate-policy-20261003/readonly-production-20261004-05.json) and [backup/headroom observations](release-evidence/release-297/release-gate-policy-20261003/readonly-backup-headroom-20261004-05.json) are Sunday low-load checks, not school-day capacity or successful restore evidence.

Reviewed operator preparation and the guarded inactive-compatible-fallback adapter are integrated through `27f16309`, with [independent preceding integration review](release-evidence/release-297/release-gate-policy-20261003/harness-integration-dd1f6666-independent-review.json). The environment-order follow-up [passes all 28 focused cases and two syntax checks](release-evidence/release-297/release-gate-policy-20261003/compatible-fallback-environment-order-pure-passed.json), with [independent source/proof review](release-evidence/release-297/release-gate-policy-20261003/compatible-fallback-environment-order-independent-review.json). Registry publication and task registration remain unexecuted. Application, schema, build, infrastructure and frontend application inputs are unchanged from `ddc5996b`; the frontend test tree is not claimed identical. The earlier [green `b5d59130` checkpoint](release-evidence/release-297/release-gate-policy-20261003/ci-b5d59130-complete.json) remains historical alongside the exact `28f256d6` checkpoint above. Merges, deployment, Store submission and activation remain separately authorized operations. The release has no deployment green light yet.

The [combined primary preparation suites](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-dd1f6666-pure.json), with [independent replay](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-dd1f6666-independent-review.json), pass 181 unique tests with zero failures, cancellations, skips or TODOs, in 17.559 seconds at the unchanged 20-second per-file limit. Exact owned processes are absent without force. This verifies the merged harness, report-cost checks and original 24-case fallback adapter; the subsequent 28-case adapter suite covers the new order correction. The exact 28f checkpoint now passes; later preparation heads and resulting main still require their own applicable checks.

<!-- historical-block:readiness-preface:end -->


## Archived operator-preparation-audit — superseded as current state on October 7

This exact canonical text retains its dated checkpoint; use the [generated current status](RELEASE_2_9_7_OPERATOR_CHECKLIST.md#current-release-status) for current preparation. Its original current/pending/authorization wording is historical. Canonical block SHA-256: `de44420551839a31035b4599e2d8923b652ff44a5f5d973696744abad7082e5b`. Only line endings are normalized.

<!-- historical-block:operator-preparation-audit:start -->
**Later October 4 checkpoint:** the [current readiness record](RELEASE_297_DEPLOY_READINESS.md#october-4-preparation-update) supersedes the pending-status rows below for the bounded production catalog inspection, supported-load selection and review-head CI. The separately approved inspection completed with 121 protected tables and 43 completed production migrations; ordinary candidate expansion requires 53, with the optional staff-identity contract still deferred. Exact `30b87475` CI is green, and three 250-client Usage-off headroom confirmations retain their original full-manifest scope. Source-derived ordinary migration/service recovery and restricted restoration now have accepted composed components. The eight-run comparison is complete: three candidate absolute passes, five baseline latency failures and failed strict closure. The [separate owner approval](release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json) adopts the bounded DeSales criteria, whose numerical checks pass; all original strict failures remain unchanged. No operational permission is added. The [compatible fallback supplement](RELEASE_297_COMPATIBLE_FALLBACK_PREPARATION.md) records both implemented registration paths and the required 129-table recovery target before lifecycle adoption. Later preparation heads/main and actual published/registered recovery artifacts remain future gates. The original `b5d59130` checkpoint and receipt remain unchanged; no deployment, publication, merge or activation occurred.

This additive checkpoint reconciles release review head `b5d591307bcda1e492b0320b2c66f5662f8fec76` with application source `ddc5996b3b8645859fa51a9613486db52c481b7f`. It supplements the [operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md) and [source PR inventory](RELEASE_2_9_7_PR_INVENTORY.md). The [bound checkpoint](release-evidence/release-297/release-gate-policy-20261003/operator-preparation-audit-b5d59130.json) records receipt hashes, source inclusion provenance and uncompleted gates. Earlier checkpoints remain unchanged.

No merge, deployment, registry push, production database inspection, Store publication or activation is authorized or claimed here. Current-school synthetic acceptance, broader capacity, Usage acceptance and live validation remain separate.

| Preparation status | Recorded state |
|---|---|
| Implemented | Classroom release source is incorporated into #603/#123; Usage code is present with unresolved capacity |
| Tested | Exact-head CI, three current-school classroom runs and local staged recovery pass; separate Usage capacity fails |
| Packaged | Local serving/fallback images, retained frontend archive and exact 2.9.7 ZIP are bound below |
| Deployed | This prepared release has not been deployed |
| Activated and live validated | Pending separate authorized current-school operations and observations |

## Current source, checks and package

| Item | Exact preparation result |
|---|---|
| SchoolPilot integration | [#603](https://github.com/bzinkan/SchoolPilot/pull/603), open draft, review head `b5d591307bcda1e492b0320b2c66f5662f8fec76`; all 20 reported checks completed successfully at the October 4 12:46:59 UTC observation |
| SchoolPilot application | `ddc5996b3b8645859fa51a9613486db52c481b7f`; exact application/schema/package/build inputs agree with the review head. The frontend tree differs only by the reviewed browser test file, with its application inputs unchanged |
| ClassPilot integration | [#123](https://github.com/bzinkan/ClassPilot/pull/123), open draft, `8069a9c9bd50352e187847158b356a69edc4e45d`; all ten reported checks completed successfully |
| Packaged extension source | `065be165b5df704d84eb716e3fb914c1fed17f98` is an ancestor of #123; its extension tree is identical. Later changes are documentation only |
| ClassPilot package | `C:/GitHub/ClassPilot/dist/ClassPilot-v2.9.7.zip`, 376,052 bytes, SHA-256 `82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`; version `2.9.7`, extension ID `iggbfegfcjkfieoemeolfmfnapepalca`; no rebuild |
| Retained frontend artifact | Preparation source `ed026513`, archive SHA-256 `7a262bf6704928194ec43cc9da0523084a935a24a040c4de20b2c7a06c321675`; current frontend application inputs remain equal. This audit reads the preparation receipt and source-binding evidence; it does not rebuild or rehash the archive |

The exact CI observation is `C:/Users/zinka/.codex/artifacts/release297-ready-ci-b5d59130-01/observation-05-receipt.json`, SHA-256 `a20706c6fbb25d72ada30e01cf8a6e05033350e04fdfe44a31130483fb76b565`. Independent replay is SHA-256 `9d03efd226cf3e29f1f972b13c92697eb52cc92ba30fe14909f9e5aaf403df97`. These are review-head checks; resulting-main checks are required after separately authorized merges. A later review head needs its own CI observation.

On October 4, the operator reported the Store's published version is 2.9.6 with no pending reviews or drafts. This is `operator_report` evidence from the current conversation, not an automated Store/developer-dashboard observation. The operator intends to submit 2.9.7 once ready and reports a usual 20–30-minute turnaround; that is an estimate, not a release guarantee or upload/publication authorization. Recheck the listing and pending-submission state immediately before upload.

## Prepared serving and recovery artifacts

The [artifact facts](release-evidence/release-297/release-gate-policy-20261003/runtime-operator-artifact-facts.json) retain all scan, archive, base, configuration and platform-manifest hashes. Digest types must remain explicit:

| Artifact | Source | Local index digest | Platform-manifest digest |
|---|---|---|---|
| Serving API/worker | `ddc5996b3b8645859fa51a9613486db52c481b7f` | `sha256:8ae47ef898382883c20406c83a97728168d115d47345b7790701cb266fd7c835` | `sha256:fdd0296f74621dba2b74ceae242e171d681a965e9fb8b65fdcbb72db9502d05d` |
| Compatible fallback | `c578120d980d4c2405a72f4f40b2d3c29a07e20b` | `sha256:2fd61fdbda527a0f72cdd947db719531b92e0e5b14cebe5bff2cbd8c62abfd08` | `sha256:405f738bc0da4baa99b6e892dd827459cf98c216dbc09232bd3c29d5fcac33a1` |

Both local builds/scans pass with zero findings, including unfixed HIGH/CRITICAL, against the same pinned runtime base. Both include the Redis snapshot and restricted-role health corrections. They are local preparation artifacts; this does not establish ECR publication, final registry identity or production task-definition compatibility.

The [actual-service rehearsal](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-passed.json), SHA-256 `cca18d0e2d122a2f21ffa6f66b7160636f0dfe6ebc1ffeb8c7f43c5ff5879c98`, passes dark admission 128 → admission 129 adoption → compatible fallback → candidate return. All four actual API/worker pairs run; four full API health-monitor cycles pass; eight services drain with exit zero, no OOM/force and no remaining named SQL connections. Actual authenticated heartbeat/accepted capability checks and WebSocket bootstrap/acknowledgement pass. Full 54-entry completed ledger, screenshot function body/scoped EXECUTE, private-chat expiration and history remain intact.

The fallback declares the original 53 migrations and intentionally omits only the additive screenshot-evidence declaration; it preserves all 54 completed database records and the function/ACL on re-entry. Neither admission nor historical checksums may be reduced. The earlier production `7af9d0dd` image is invalid as a rollback after private-chat lifecycle adoption. Preserve compatible servers while offline cleanup remains unresolved.

The rehearsal uses synthetic protocol clients and a synthetic schema/copied ledger. It proves neither Chrome/SSO enrollment nor actual production migration history, catalog, ECS/ALB target drain or capacity. Preserve the explicit 99 CRLF-only emitted-byte differences: native migration/checksum continuity is established; raw historical application-byte equality is not claimed.

## PR dispositions

All 60 tracked source PRs are retained: 18 already merged, 40 included and two superseded. The [current reconciliation](release-evidence/release-297/release-gate-policy-20261003/source-pr-inventory-current-reconciliation.json) records unchanged tracked heads at its own observation. Its source `44c1932f` is an ancestor of review head `b5d59130`; this audit retains that inclusion provenance without a new remote query of the 60 source PRs or replay of every original hunk. The subsequent product-input diff is exactly `classpilotRealtimeStatus.ts`, `healthDbRoundTrip.ts` and `healthMonitor.ts`; those reviewed corrections have separate native and staged-service evidence. Frontend source and migration inputs are unchanged across that interval.

The original structured proofs remain intact. For #564, #574 and #586, use the reconciliation's explicit implementation ancestry/files/hunks; their historical whole-patch/base explanations are insufficient and are not promoted to valid proofs. Historical `mergeCommit` fields on open PRs do not establish a completed merge.

Merge #603 as the coordinated SchoolPilot integration after separate authorization; reconcile the included/superseded source PRs only after it lands. Do not merge each overlapping stack independently. ClassPilot #119–#122 are incorporated into separate #123; the provisional 2.10.0 packaging history is retained, while the selected artifact is 2.9.7. No source PR was independently closed or merged by this audit. Unrelated Observe implementation remains excluded; #602 retains only its previously included browser-test synchronization correction.

## Acceptance and observed production

| Gate | Current result |
|---|---|
| Current-school classroom workload, Usage off | Three consecutive 900-second native runs pass on final application source; all 36,309 offers have exact persisted bindings, 180 commands and 90 private messages pass, all 45 minute sets pass, unforced cleanup complete |
| Actual-service recovery | Passed locally as bounded above |
| Normal-load/headroom recommendation | Separate lower-load evidence/decision is still pending at this checkpoint. No earlier strict comparison failure is reclassified |
| Broader 800-client survival/capacity | Unaccepted |
| New Usage capacity/activation | Zero accepted cold runs; the 6,000-offer attempt failed with 2,655 HTTP 200, 3,345 admission 503 and 56 late offers. Partial reports/worker results do not establish complete acceptance |
| Live DeSales classroom observation | Pending; at least 30 minutes of sample-bearing evidence on the actual current task pair is required |
| Two managed Chromebooks | Waived, not passed |

The fresh metadata-only observation at October 4 13:46 UTC records one API and one worker, API container `HEALTHY` with one healthy ALB target, worker container health `UNKNOWN`, unchanged serving source/image `7af9d0dd`/`c87433cd` and 121 configured RLS tables. All 28 whitelisted flags per service match the prior baseline; full environment equality is false because the new capture includes additional metadata keys. RDS is available, has 14-day backup retention and a restorable point about 125 seconds old at its separate check. These Sunday observations do not establish school-day headroom, actual database catalog/roles, successful restore or detailed application health.

The operator also reported on October 4 that DeSales's school-hours limits are disabled. This is `operator_report` evidence and matches the existing synthetic fixture's `enable_tracking_hours=false`; it is not an observed production database row. The actual school settings, UUID and catalog still require the authorized read. The separate formatter optimization is therefore not presented as a repair for this fixture's failing Usage workload.

Scheduled API minimum remains three on weekdays 05:45–16:00 America/New_York and one otherwise, maximum six. A minimum change does not force the actual running count. Preserve the ordinary weekday 04:45–05:59 exclusion and record the separately approved execution interval. Metadata, flags, backups and window must be refreshed immediately before the relevant action.

<!-- historical-block:operator-preparation-audit:end -->
