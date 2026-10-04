# SchoolPilot / ClassPilot 2.9.7 release inventory

The shared distinct-report slice is integrated as `1091eaeb` from reviewed `e330c39a`. [Source binding](release-evidence/release-297/release-gate-policy-20261003/harness-integration-1091-source-binding.json) verifies the 11 identical reviewed Git blobs and unchanged application/schema/build/infrastructure inputs; CRLF-only working differences remain explicit. The [focused component proof](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-shared-pure-passed-02.json) passes 48 unique cases and 11 syntax checks, with [independent review](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-shared-independent-review.json). The [full primary aggregate](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-1091-pure.json) passes all 139 unique cases (133 harness plus six report-cost cases), no skips/cancellations/TODOs, in 14.496 seconds with the configured 20-second test timeout, with [independent aggregate/source review](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-1091-independent-review.json). The [earlier dependency failure](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-shared-pure-failed-01.json) remains failed. New helper/protocol-native verification, actual distinct-report capacity and new-head CI remain pending.

The [fresh final-source Usage attempt `df9199c13d82`](release-evidence/release-297/release-gate-policy-20261003/usage-native-ddc5996b-df919-failed-03.json) failed: 2,655/6,000 heartbeats succeeded, 3,345 returned HTTP 503, and 56 offers were late. All 64 generator reports and 26 original lifecycle events passed, but final independent current-day/coverage/CSV/audit oracles were not reached. One heavy worker completed in 39.268 seconds; the second hit PostgreSQL statement timeout. [Status/ownership review](release-evidence/release-297/release-gate-policy-20261003/usage-native-df919-status-ownership-review.json) verifies admission denials match the 503 count, no acquisition failures and complete unforced drain. [Worker budget review](release-evidence/release-297/release-gate-policy-20261003/usage-native-df919-worker-budget-review.json) records the shared FIFO admission and 60-second whole-operation budget, including waiting; no standalone 60-second SQL execution is established. The retained CPU capture also failed its unchanged timing guard. All five PostgreSQL errors remain included. This is a failed capacity attempt with zero accepted cold runs and two later attempts held. Host interference, a connection leak and a causal query bottleneck are unproven. Both new Usage modes remain off; the strict dark comparison and operational/live gates still block a release green light. Targeted fresh-fixture diagnostics are preparation, not replacement acceptance.

The owner adopted the October 3 [split release and Usage gates](RELEASE_297_DEPLOY_READINESS.md). Current application source `ddc5996b3b8645859fa51a9613486db52c481b7f` incorporates Redis serialization/revision and least-privilege health corrections. Their [24 Redis component passes](release-evidence/release-297/release-gate-policy-20261003/realtime-native-green-02.json) and [six native health passes](release-evidence/release-297/release-gate-policy-20261003/health-native-green-03.json) have no skips; the combined standard backend type check passes. Fresh [serving/fallback scans](release-evidence/release-297/release-gate-policy-20261003/runtime-artifacts-ddc5996b-c578120d.json) and [actual API/worker staged recovery](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-passed.json) pass. [Combined CI at review head `dd6d54c0`](release-evidence/release-297/release-gate-policy-20261003/ci-dd6d54c0-complete.json) passes all 20 SchoolPilot and all 10 unchanged ClassPilot checks. A [fresh capability-on 34/s check](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-native-c1a09-ddc-summary.json) passes 2,040 exact offers; the paired/current-school comparison remains pending, and the three complete mixed passes below now pass. Historical application `ed026513` and its [earlier checkpoint](release-evidence/release-297/release-gate-policy-20261003/ready-checkpoint-ed026-20261004-01.json) remain distinct. Historical Usage, staging and mixed-workload failures remain intact.

The [three full 900-second classroom runs](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-passed-block.json) and [complete independent review](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-independent-review.json) pass on application `ddc5996b` and frozen helper `7238c17c`, with both new Usage modes off. All 36,309 heartbeat offers have exact persisted bindings; 180 commands and 90 private messages pass native recipient/lifecycle checks. All 45 minute acceptance sets pass. Worst minute p95 is 115.317 ms and highest API minute CPU is 24.7454%; exact physical API loss precedes reconnect and all resources clean up without force. This is current-school synthetic classroom acceptance. The strict dark comparison, separate Usage capacity, broader 800-client capacity and operational/live gates remain separate.

The [current read-only reconciliation](release-evidence/release-297/release-gate-policy-20261003/source-pr-inventory-current-reconciliation.json) confirms all 60 tracked PR heads are unchanged. Three historical whole-patch/base proofs (#564, #574 and #586) are replaced for current review by explicit implementation ancestry, exact files and retained hunks; no implementation omission was found. Open-PR historical mergeCommit fields do not establish a completed merge. The original inventory remains unchanged.

New corrections incorporated directly into #603 include bounded heartbeat admission,
Usage-aware pool fairness, changed/missing/vanished rollup writes, and tenant-owned
cleanup/retention/audit transactions. They preserve the 54 migrations and 129-table
inventory. Redis and health corrections are also incorporated directly through
`c73db8ea` and `ddc5996b`. The refreshed fallback source is
`c578120d980d4c2405a72f4f40b2d3c29a07e20b`, preserving the preceding
`6d1f3a7e737ebd2e3e266f2f571cdea811db5e27` and adding only those runtime fixes,
native tests and lane registrations. Its new build, scan and actual-service recovery pass;
both Usage modes must stay off.
No additional source PR has been independently merged or closed by this work.

This is an inclusion inventory, not merge, deployment, or activation evidence. The structured record preserves full commits, base dependencies and inclusion proofs. Checkpoint 60bb2338157a9f0c313ebffae3f42a69ac3e3345 is based on main 996d965f0b044f8fc4d4bbc399c5ab3781fbac04. Preserve original review branches; reconcile their PRs only after the single integration PR lands.

[Operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md) · [Exact commits and proofs](release-evidence/release-2.9.7-pr-inventory.json)

Historical October 3 preparation: [CI on `9630c009`](release-evidence/release-297/usage-contention/ci-9630c009-final-01/manifest.json)
is fully green, but its [resource-bounded Usage diagnostic](release-evidence/release-297/usage-contention/linux-role-combined-9630-01/manifest.json)
fails capacity (2,704/6,000 heartbeats, 34/64 reports, second complete worker
57.768 seconds including queue wait). The subsequent `5d543f40` instrumentation
correction has focused/native/full-unit evidence and a scanned local image.
The `6035239b` identity scheduling correction now passes focused/native checks
and 1,868 unit cases (four conditional skips). CI on `2378e04e` passes for those
application bytes; final-source capacity acceptance remains pending. No release
execution is approved. The source-PR inclusion table is unchanged; the older
development checkpoints below are historical and do not establish current readiness.

## Historical preparation checkpoints

The latest [screenshot-reader correction in #603](release-evidence/release-297/usage-contention/heartbeat-screenshot-reader-implementation-01/manifest.json)
passes 2,012 unit cases, 190 owner/restricted database cases, four private-chat
cases and build/type/cast checks. Its immutable 54th migration and startup
permission checks retain the existing 129-table RLS inventory. Failed attempts
remain preserved. The [814844f3 image](release-evidence/release-297/usage-contention/candidate-artifact-814844f3/manifest.json)
passes build/scan/compatibility checks and its [local recovery pair](release-evidence/release-297/usage-contention/recovery54-814844f3-01/manifest.json)
passes with the complete 54-migration ledger. The first [registered candidate run](release-evidence/release-297/usage-contention/capacity-8148-attempt-01/manifest.json)
fails: 3,042/6,000 successful heartbeats, 48/64 reports, workers 15.647/38.266
seconds, and a failed classroom lifecycle. Correctness for persisted data and
cleanup pass; zero capacity runs are accepted. CI passes 16/17 jobs plus all
three security workflows. The one frontend race has a [test-only fix](release-evidence/release-297/usage-contention/frontend2-resize-814844f3-01/manifest.json)
verified locally; new-head CI, three cold capacity passes and the original
comparison are still required. The source-PR inclusion table is unchanged.

Preceding load-tested application `e95a2b56476b1225434c1b0f3907db46c9d84fe3` adds an exact-URL
domain map per student, preserving classification, timing, tenant scope and
atomic coverage. Its [local evidence](release-evidence/release-297/usage-contention/domain-map-implementation-e95a2b56/manifest.json)
passes 1,906 unit tests, 25 owner and 12 restricted database tests without skips,
plus build/type/cast checks. Native parity compares all nine semantic columns
against immutable b112 SQL. The repeated-URL prototype improves, while its
all-distinct kernel becomes slower; neither is capacity acceptance. The [fresh image](release-evidence/release-297/usage-contention/candidate-artifact-e95a2b56/manifest.json)
passes build/scan/compatibility checks. [Follow-up CI at `97dad081`](release-evidence/release-297/usage-contention/ci-97dad081-final-01/manifest.json)
passes all 17 CI jobs and three security workflows after a
[test-only rollout clock correction](release-evidence/release-297/usage-contention/clock-minute-boundary-01/manifest.json).
Combined capacity remains unaccepted.
[Frontend equivalence](release-evidence/release-297/usage-contention/frontend-e95-binding-01/receipt.json)
confirms the retained artifact and all 632 input blobs are unchanged.

The [first combined e95 run](release-evidence/release-297/usage-contention/linux-role-combined-e95-01/manifest.json)
still fails capacity: 4,413/6,000 heartbeats succeeded, 949 failed, 638 were
refused and none were late. All 64 reports and independent correctness/CSV checks
pass; whole workers take 12.284/30.984 seconds. API CPU is nearly saturated,
950 acquisitions fail and the first classroom command returns 500. All owners
drain and exact fixture cleanup is retained. No passing capacity run is accepted.
The [current-source ingestion CPU diagnostic](release-evidence/release-297/usage-contention/linux-role-ingest-cpu-e95-01/manifest.json)
also fails: 5,081/6,000 offers succeed, 478 fail and 441 are refused; none are
late. Its clipped profile identifies bounded construction and row-processing
costs, without proving a sufficient capacity correction. All owners and fixture
resources are cleaned up; both this failure and the preceding zero-offer setup
failure are retained. Narrow metadata/projection experiments are next.

The [later restored-fixture combined run](release-evidence/release-297/usage-contention/restored-combined-e95-01/manifest.json)
retains all 13 actual owner receipts and verified fixture cleanup. It still
fails capacity: 4,730/6,000 heartbeats succeed, 976 fail, 294 are refused and
seven offers are late. All 64 reports pass; whole workers finish in
13.987/30.616 seconds. Correctness checks pass; the classroom lifecycle fails.
The candidate validator is being corrected to accept the actual single-API
preflight-drain shape and require 6,000 HTTP-200 results with matching raw,
persisted and rollup counts. Neither that correction nor receipt completeness
turns this failed diagnostic into an accepted run.

Preceding application `b11202fc305198d76e73c5e6d711b7dc9ed2d938` adds owned
heartbeat SELECT metadata reuse with fresh values and mandatory-work sealing.
[Regression evidence](release-evidence/release-297/usage-contention/heartbeat-prepared-reads-implementation-01/manifest.json)
records 1,906 unit passes with no skips, 50 owner and 50 restricted native passes,
four restricted private-recovery passes, and build/type/cast checks. Its
[final source binding](release-evidence/release-297/usage-contention/heartbeat-prepared-reads-implementation-01/final-binding.json)
preserves the post-test whitespace correction and compiled equivalence. At
[review head `a109fd27`](release-evidence/release-297/usage-contention/ci-a109fd27-final-01/manifest.json), all 17 CI jobs and three security workflows pass. No release execution is recorded.

The [combined b112 diagnostic](release-evidence/release-297/usage-contention/linux-role-combined-b112-01/manifest.json) failed: 3,020 of
6,000 offered heartbeats succeeded, 2,095 failed and 885 were refused at the
in-flight ceiling; 199 offers were late. All 64 reports passed. Complete worker
operations took 25.049 and 47.561 seconds, including admission and cleanup.
There were 2,096 database acquisition failures: 2,095 on heartbeat paths and
one on the classroom lifecycle path, which failed before acceptance. Independent
totals, coverage, tenant isolation and eight audited CSV checks passed. Physical
owners drained and all six owned containers were removed. This is valid failed
diagnostic evidence, not an accepted capacity run or a proven connection leak.
Three consecutive final-source passes and the original comparison remain required.

The [local candidate/fallback recovery proof](release-evidence/release-297/usage-contention/recovery-pair-b112-6e251/manifest.json) passed
for b112 candidate → 6e251 fallback → b112 candidate. Actual bundled image
functions preserved separate thread-close, school-hard-off and activity-hard-off
expiration, delivered history, and Stop Focus cleanup without removing other
restrictions. A separate source migration rehearsal retained 53 migration IDs
and 129 forced-RLS tables through re-entry. Both Usage modes stayed off. These
checks used synthetic fixtures; they do not establish the actual production
catalog, service-traffic rollback, Redis/browser behavior or recovery below the
Usage coverage correction. All failed setup attempts and independent cleanup
proof remain preserved.

Application `0e427e3c` additionally corrects both Focus ACK wire surfaces and
JSONB-order-dependent status writes. Its [64 focused and 15 restricted database
passes](release-evidence/release-297/usage-contention/focus-status-wire-297-01/manifest.json)
and [61 lifecycle/profile guard passes](release-evidence/release-297/usage-contention/focus-lifecycle-harness-01/manifest.json)
are local evidence. [Combined CI on `5d031512`](release-evidence/release-297/usage-contention/ci-5d031512-final-01/manifest.json)
passes all 17 CI jobs and three security workflows for this application. Its
[unprofiled ingestion diagnostic](release-evidence/release-297/usage-contention/linux-role-ingest-unprofiled-0e427-01/manifest.json) fails at 5,139/6,000 successful heartbeats,
with 144 failures, 717 in-flight refusals and zero late offers. CPU saturation
persists; completed drain and cleanup do not establish capacity acceptance.

| Item | Selected source / limitation |
|---|---|
| Application | The [screenshot-reader correction](release-evidence/release-297/usage-contention/heartbeat-screenshot-reader-implementation-01/manifest.json) in #603 passes local full-unit/native/build/type/cast checks. [Baseline `0915dd93`](release-evidence/release-297/usage-contention/ci-0915dd93-final-01/manifest.json) passes all 17 CI jobs and three security workflows, including the strict role harness; it excludes this new reader and migration. Current-source CI and capacity remain pending. |
| Earlier completed full CI | [`2378e04e`](release-evidence/release-297/usage-contention/ci-2378e04e-final-01/manifest.json); all 17 CI jobs and three security workflows pass for the preceding `6035239b` application, without the later Focus correction. |
| Local candidate image | [`e95a2b56`](release-evidence/release-297/usage-contention/candidate-artifact-e95a2b56/manifest.json) passes a fresh uncached build, pinned scan with zero findings, compatibility checks and cleanup. Its Linux/amd64 manifest is `sha256:3b0816f59a00612b0bfb41e2b45e4767dbac2f7eba873d6354035cb24e523593`. Completed actual-image recovery used the preceding b112 candidate; final release selection requires capacity, follow-up CI and a current recovery binding. Earlier images remain historical. |
| Compatible fallback | Source [`6e251f2d1eece2b98fa2325e1fa46bd2b8553420`](release-evidence/release-297/usage-contention/rollback-focus-wire-01/manifest.json) includes the tested Focus backport and retains the compatibility floor. Its [fresh local image and scan](release-evidence/release-297/usage-contention/rollback-artifact-6e251f2d/manifest.json) pass with zero findings, verified embedded compatibility and cleanup. Both Usage modes must remain off. The [b112/6e251 local recovery pair](release-evidence/release-297/usage-contention/recovery-pair-b112-6e251/manifest.json) passes the recorded source re-entry and adopted-state function checks; production service-traffic rollback is not established. The `5c01944e`, `ed5599de` and `351422d7` image artifacts remain historical. |
| Operational readiness | No accepted Usage capacity run and no release execution approved. Follow the [operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md) for the remaining gates and separate authorizations. |

## Historical preparation checkpoints

The following results and pending-work statements describe their recorded
checkpoints. They do not replace the current selections above.

The initial [API connection scheduler](release-evidence/release-297/usage-contention/fair-main-pool-scheduler-01/manifest.json)
has passed focused, native-driver and restricted-role regression checks; its
combined capacity acceptance is pending. It applies only when Usage reporting
is enabled and retains existing pool limits and deadlines. The preceding
application source `204ae93d` and subsequent test/evidence-only checkpoints remain
historical. Their [combined Linux diagnostic](release-evidence/release-297/usage-contention/linux-combined-204-01/manifest.json)
fails capacity (4,840/6,000 heartbeat offers, 51/64 reports, 978 acquisition
failures), while its exact local image scan and compatibility checks pass.
[CI and the listing correction](release-evidence/release-297/usage-contention/test-lane-listing-flush/manifest.json)
retain the two CI failures recorded at that checkpoint and the verified Linux stdout-flush repair;
1,825 local unit cases and 699 infrastructure cases pass, with four existing
unit skips. The [rollout-fixture correction](release-evidence/release-297/usage-contention/rollout-live-harness-lifetime/manifest.json)
passes all 380 default-suite assertions with production behavior unchanged.
At that checkpoint, fresh full CI and capacity acceptance were pending.
The source-PR inclusion table is unchanged.

The subsequent [inbox owner projection](release-evidence/release-297/usage-contention/inbox-projection/manifest.json)
reduces repeated authority reads while preserving locks and delivery fences.
Build/type/cast checks, 1,824 unit cases, 27 focused cases and 21 native cases
under each database role pass; four conditional unit skips remain explicit.
At that checkpoint, this application change still needed its own CI and
measured capacity acceptance.

[CI at `92307780`](release-evidence/release-297/usage-contention/ci-92307780.json)
passes all four workflows and all 17 CI jobs, covering the `d6492333`
application. The [Linux combined diagnostic](release-evidence/release-297/usage-contention/load-linux-combined-01/manifest.json)
still fails capacity: 5,652/6,000 offers succeeded, 348 were refused, five were
late, and 38/64 reports succeeded. Zero acquisition failures and workers below
48 seconds do not override those failures or the 23 aborted responses. Later
application changes need fresh acceptance; Usage remains off.

At the historical `bcb2b33c` checkpoint, [CI](release-evidence/release-297/usage-contention/ci-bcb2b33c.json)
records 15 passing jobs and two failed jobs; both failures have retained local
repairs. [Combined attempt08](release-evidence/release-297/usage-contention/load-combined-08/manifest.json)
and the [subsequent ingestion diagnostic](release-evidence/release-297/usage-contention/ingest-cpu-bcb2b33c-01/manifest.json)
remain failed capacity evidence. The [owned inbox correction](release-evidence/release-297/usage-contention/heartbeat-owned-inbox/manifest.json)
has focused and owner/restricted-role regression evidence; combined capacity and
new-head CI were still required at that checkpoint. The retained compatible fallback is
`5c01944ed1afb4241e270469c6477121bf48cd84`, with its own
[local image and scan evidence](release-evidence/release-297/usage-contention/rollback-artifact-5c01944e/index.json).
Neither candidate nor fallback has been deployed by this preparation work.

[Combined09 at d6492333](release-evidence/release-297/usage-contention/load-combined-09/manifest.json)
is later failed capacity evidence (3,677/6,000 heartbeat offers, 30/64 reports).
Its [exact local candidate image](release-evidence/release-297/usage-contention/candidate-artifact-d6492333/manifest.json)
passes the full pinned scan and compatibility checks, and the
[d649/5c01 rehearsal](release-evidence/release-297/usage-contention/rehearsal-d649-5c01/manifest.json)
passes local migration re-entry. Production catalog verification, capacity and
fresh final-source CI remain separate requirements.

The [October 2, 22:59 UTC review-container observation](release-evidence/release-297/usage-contention/pr-review-checkpoint.json)
records SchoolPilot #603 open/draft at `08802d020a3c51beea504140f923126ab518aac6`
with 20 successful reported checks. That source predates the current Usage
contention correction; final frozen-source checks and capacity acceptance remain
pending. ClassPilot #123 remains open/draft at
`8069a9c9bd50352e187847158b356a69edc4e45d`: the [October 3 reconciliation](release-evidence/release-297/usage-contention/extension-ci-reconciled-20261003.json) records all 10 checks successful and GitHub `CLEAN`. Sibling run `37048477885` passed on rerun; historical cancelled entries remain in the earlier checkpoint. Neither container is merged.
The 60 source PR records below retain their historical reviewed heads and inclusion
proofs; this observation does not independently refresh every source PR's state.

Subsequent stabilization remains inside #603. The [0431f043 CI checkpoint](release-evidence/release-297/usage-contention/ci-0431f043.json) passed all four required workflows. Later corrections reuse only currently owned monitoring leases, consolidate optional heartbeat reply recovery under final authority, and admit one bulk Usage writer per worker pool. [Historical combined local checks](release-evidence/release-297/usage-contention/combined-checks-attempt-02/manifest.json) passed 1,744 unit cases with four explicit conditional skips; the preceding build/type/cast checks passed. Failed load runs and the failed static-assertion run remain preserved. Final combined capacity and new-head CI are still pending.

The later [8069560d CI checkpoint](release-evidence/release-297/usage-contention/ci-8069560d.json) failed on a newly disclosed development dependency advisory and one stale screenshot-authority static assertion; 15 jobs passed. [Combined load attempt 04](release-evidence/release-297/usage-contention/load-combined-04/manifest.json) also failed. Follow-up work narrows fresh heartbeat reads, prepares canonical class ownership before the cold restart, and preserves PostgreSQL microseconds in the independent current-day oracle. Each failure and its repair has separate evidence; these changes do not certify capacity or a later source automatically.

[Local checks after these changes](release-evidence/release-297/usage-contention/combined-checks-attempt-04/manifest.json) passed 1,752 unit cases and all 48 load guards. Clean install, build, test-type and cast checks passed on identical source bytes; four conditional unit skips remain explicit. The six narrow production dependency updates cleared all production audit findings. The original unit environment failure and its separate native index-parser verification are retained. Remote CI and measured capacity still require this final source.

The [release-enabled preflight at `5a2c0996`](release-evidence/release-297/usage-contention/load-preflight-5a2c0996-01/manifest.json) exposed a real Stop Focus delivery defect after canonical fixture preparation succeeded. The server omitted the full V2 binding after clearing the final feature-gated restriction. The [narrow server correction](release-evidence/release-297/usage-contention/stop-focus-v2-cleanup/manifest.json) preserves strict harness checks and the unchanged ClassPilot 2.9.7 package. Produced-frame regressions, exact extension authority checks and restricted-role cleanup tests pass. [Combined unit verification](release-evidence/release-297/usage-contention/combined-checks-attempt-05/manifest.json) passed 1,752 cases with four named conditional skips on 1,152 unchanged source files. New-head CI, combined capacity and final artifacts remain pending.

The [CI checkpoint at `59f0e431`](release-evidence/release-297/usage-contention/ci-59f0e431.json) passed all four required workflows, including all 17 CI jobs. Its [combined capacity attempt 05](release-evidence/release-297/usage-contention/load-combined-05/manifest.json) nevertheless failed: 1,592/6,000 heartbeat successes, 25/64 successful reports and 3,140 API acquisition failures. Both workers met the 48-second bound. Canonical classroom ownership now exercises telemetry that the earlier incomplete fixture missed; this is not a controlled performance comparison. The strict current-day oracle also rejected 272 unclassified observations. Subsequent corrections register historical classification before optional telemetry, preserve publication ordering, persist deterministic educational classification atomically, and reduce fresh owner discovery from three statements to one. Final combined verification and capacity acceptance remain required.

The [historical combined checks](release-evidence/release-297/usage-contention/combined-checks-attempt-06/manifest.json) passed the production build, cast check and 1,769 unit tests, with four named conditional skips. The attempt retains its native-test typing failure. A [separate test-only repair](release-evidence/release-297/usage-contention/telemetry-owner-projection-type-followup/manifest.json) passes test types/casts and 11 owner plus 11 restricted cases; application bytes and unit-selected tests are unchanged. The [cumulative telemetry acceptance gate](release-evidence/release-297/usage-contention/optional-telemetry-phase-counter/manifest.json) adds 14 focused and 49 load-guard passes, with zero optional publication failures required over the entire phase. Capacity and new-head CI remain pending.

[Combined attempt06 at `25ba8686`](release-evidence/release-297/usage-contention/load-combined-06/manifest.json) remains failed capacity evidence: 3,668/6,000 heartbeat successes, 36/64 reports, 979 API acquisition failures and 144 telemetry failures. Both workers meet 48 seconds; current-day classification/totals, coverage and eight audited CSVs now pass. All tracked leases return to zero after drain. The same-source ingestion CPU diagnostic retains all 6,000 offers and is diagnostic only; it does not replace the required three consecutive combined passes. Final capacity, artifacts and release execution remain incomplete.

The historical [live-binding query correction](release-evidence/release-297/usage-contention/live-binding-query/manifest.json) preserves exact predicates and locks, with 15 owner and 15 restricted-role cases passing. [Complete server-drain tracking](release-evidence/release-297/usage-contention/complete-server-drain/manifest.json) retains ownership after HTTP completion and rejects aborted preflight uncertainty. The [earlier full unit rerun](release-evidence/release-297/usage-contention/combined-checks-attempt-08/manifest.json) passes 1,775 tests with zero failures and four named conditional skips; preceding build/type/cast checks cover identical application bytes. All 54 workload guards pass. Their subsequent [combined attempt07](release-evidence/release-297/usage-contention/load-combined-07/manifest.json) failed: 3,268/6,000 heartbeat offers and 32/64 reports succeeded, with 1,679 acquisition failures. Physical ownership reached zero, but 66 aborted responses prevented drain certification; current-day/CSV checks did not run. [CI at `7cf86cf1`](release-evidence/release-297/usage-contention/ci-7cf86cf1.json) finished with 14 successful and three failed jobs; security workflows passed. Source-layout detector repairs and the later control/SSO and telemetry changes need new-head acceptance.

The separately prepared fallback source at the Stop Focus checkpoint is `ff94f21e6cc91075e7e82f0d28b434ef43f4a118`
on `codex/release297-compatible-rollback-sso`: the reviewed `08802d02` floor plus
the private-chat/SSO lock-order correction, monitoring lease-reuse fix and
[six narrow production dependency updates](release-evidence/release-297/usage-contention/production-dependency-audit/rollback-followup-manifest.json).
Both Usage modes stay off. The [preceding source/image evidence](release-evidence/release-297/usage-contention/rollback-artifact-2bbcdb37/index.json)
is historical. The [exact351 source image evidence](release-evidence/release-297/usage-contention/rollback-artifact-351422d7/index.json)
retains both builds: the uncached second build installed the fixed Alpine libpng
package and passed pinned Trivy with zero findings. The newly discovered Stop Focus
exact-binding repair has its [narrow fallback backport](release-evidence/release-297/usage-contention/rollback-stop-focus/manifest.json): three regressions fail before and pass after, and type/build checks pass. At that checkpoint a new exact image and final-schema re-entry were still required; the `351422d7` artifacts remain intermediate preparation. The subsequent historical image is recorded below.
The historical classification-delivery fallback was
`ed5599de0191b4b9961ed907586e1fc153ebd63b`. It is superseded by the retained
`5c01944e` fallback above, which also includes the final heartbeat entitlement
and exact-binding fence. The `ed5599de` image is not the current fallback selection.
Its [classification-delivery backport](release-evidence/release-297/usage-contention/rollback-classification-correctness/manifest.json)
changes only the historical-classification/publication barrier, its fixed failure
counter and regression. Five baseline failures are retained; 24 focused cases and
build/type/cast checks pass. It does not include the performance projections or
immediate-classification optimization. Its [historical exact uncached image](release-evidence/release-297/usage-contention/rollback-artifact-ed5599de/index.json) passed the pinned full scan with zero findings and embedded compatibility checks. At that checkpoint, final candidate-schema migration re-entry was still required. This fallback is not another merged source PR. Registry publication and production
task bindings remain separate. Historical artifacts are retained.

## Source PR inclusion inventory

| PR | Disposition | Exact reviewed head | Dependency base | Scope |
|---|---|---|---|---|
| [SchoolPilot #547](https://github.com/bzinkan/SchoolPilot/pull/547) | already merged | `45dd3333ffb043c797ac095387c0c87e5d31a238` | main | Keep the AI assistant's Flight Path list to the teacher's own paths |
| [SchoolPilot #548](https://github.com/bzinkan/SchoolPilot/pull/548) | already merged | `22c183c450b5d1f1a1aef72ba4772f546e3132ab` | main | Harden the shadow daily usage rollup so set-based can be promoted (roadmap PR 10a) |
| [SchoolPilot #549](https://github.com/bzinkan/SchoolPilot/pull/549) | already merged | `eda5c1f2576c06608de16fe8ca5296c954d716d8` | main | Add the competitive roadmap and the legacy Live View/TURN media audit |
| [SchoolPilot #550](https://github.com/bzinkan/SchoolPilot/pull/550) | already merged | `1dae1ff1e8ca30aca4fde3185f65bfdd0e2eccc3` | main | Withhold precise restriction resources so a rollback past PR 2 never widens a Waypoint (roadmap PR 2-pre) |
| [SchoolPilot #551](https://github.com/bzinkan/SchoolPilot/pull/551) | already merged | `7efe17119507edfe9e0be3274e35eb77d5bba346` | main | Guard retained TURN identity with prevent_destroy and refuse legacy Live View signaling by default |
| [SchoolPilot #552](https://github.com/bzinkan/SchoolPilot/pull/552) | already merged | `f63e5d87524d4d0cf591de58e0caea5bd1d82174` | main | Add a governed production setter for the wave-1 product flags |
| [SchoolPilot #553](https://github.com/bzinkan/SchoolPilot/pull/553) | already merged | `eb4293011bb8cc73dfad4339d67689de7bd59969` | main | Add a School Library for shared and official Flight Paths and Block Lists |
| [SchoolPilot #554](https://github.com/bzinkan/SchoolPilot/pull/554) | already merged | `296b7f204b47be1aafb04ddd875e72b8c01750e4` | main | PassPilot issuance rules: capacity, daily/period limits, encounter restrictions, admin override (roadmap PR 7) |
| [SchoolPilot #555](https://github.com/bzinkan/SchoolPilot/pull/555) | already merged | `87fdeb128b9a7531e6f159754687982876b757be` | main | Add precise restriction resources and preciseRestrictionResourcesV1 on the server (roadmap PR 2) |
| [SchoolPilot #556](https://github.com/bzinkan/SchoolPilot/pull/556) | already merged | `c94dff4b4e1250f8d97a0afbc7ed44fca9545dcf` | main | Add Monitored Browser Time rollups, retention and the admin Digital Usage API (dark) |
| [SchoolPilot #557](https://github.com/bzinkan/SchoolPilot/pull/557) | already merged | `cebf305b9fdcd994bd51a64a4f5acf030b40a8d0` | main | Move the transitive engine.io to 6.6.11 for GHSA-2gc4-cqfq-p2gv |
| [SchoolPilot #558](https://github.com/bzinkan/SchoolPilot/pull/558) | already merged | `fe89219c2dca7a85a73e9de2381a376c03ad6362` | main | Record wave-1 roadmap status and the real PR 2-pre activation rule |
| [SchoolPilot #559](https://github.com/bzinkan/SchoolPilot/pull/559) | already merged | `a84101283819f0fb34ffde525666669cbf7dadc1` | main | Harden the precise restriction matcher and clear CLI (roadmap PR 2 follow-up) |
| [SchoolPilot #560](https://github.com/bzinkan/SchoolPilot/pull/560) | superseded | `aafdddd98ca575f4bbc377e4c4bef80ee3c224f4` | main | Reconcile remaining roadmap and release preparation gates |
| [SchoolPilot #561](https://github.com/bzinkan/SchoolPilot/pull/561) | included | `2798431612be182aeca42a5bf3fe65be20cfada6` | main | Propose Present to Class hosting security and budget decision |
| [SchoolPilot #562](https://github.com/bzinkan/SchoolPilot/pull/562) | superseded | `ac4675e828cdde8f3b825be191e90e2a442b793c` | main | Refresh transitive Axios to clear current security advisories |
| [SchoolPilot #563](https://github.com/bzinkan/SchoolPilot/pull/563) | included | `69a191ddd50af030ceee6a7490016a263143ff28` | codex/roadmap-stacked-ci | Fix Monitored Browser Time coverage and processed cutoffs |
| [SchoolPilot #564](https://github.com/bzinkan/SchoolPilot/pull/564) | included | `157da0c1249ad279628b48e78f0f23a0e2b6b320` | main | Run CI and security checks for stacked roadmap PRs |
| [SchoolPilot #565](https://github.com/bzinkan/SchoolPilot/pull/565) | included | `7f413fd564f6370e4374570486dd208daefc1f6a` | codex/roadmap-corrected-base | Define Focus and Bring Forward server and extension contract |
| [SchoolPilot #566](https://github.com/bzinkan/SchoolPilot/pull/566) | included | `9055393d016d21ca96703a3ff90e0caeee1d7e90` | codex/roadmap-stacked-ci | Conceal retained encounter overrides in all public pass responses |
| [SchoolPilot #567](https://github.com/bzinkan/SchoolPilot/pull/567) | included | `ccdbb755f079fd2ebc9dd4e3156ba99e32a7cfb1` | codex/roadmap-corrected-base | Preview normalized restriction scopes and broader website access |
| [SchoolPilot #568](https://github.com/bzinkan/SchoolPilot/pull/568) | included | `34c93eb86e7ce72b7af611254609b96ca882d809` | codex/roadmap-corrected-base | Add administrator Monitored Browser Time page with truthful coverage |
| [SchoolPilot #569](https://github.com/bzinkan/SchoolPilot/pull/569) | included | `16a50cd33f5acff85a0de101c96076bc4d4e934d` | codex/roadmap-corrected-base | Measure corrected usage rollups with guarded local synthetic load |
| [SchoolPilot #570](https://github.com/bzinkan/SchoolPilot/pull/570) | included | `b47355358a5d9bc7e29cc047104c2b281c538dbb` | codex/roadmap-corrected-base | Add atomic manual PassPilot appointments and retained lifecycle |
| [SchoolPilot #571](https://github.com/bzinkan/SchoolPilot/pull/571) | included | `ae2dc2fa9e62906b4d76227d174c8278ae04b570` | codex/precise-restriction-previews | Review precise resource and Classroom scopes before authoring |
| [SchoolPilot #572](https://github.com/bzinkan/SchoolPilot/pull/572) | included | `cae164a2a578c4a0886531d6dd0a25e6878d6769` | codex/focus-command-contract | Add exact Focus commands and atomic Open + Focus continuation |
| [SchoolPilot #573](https://github.com/bzinkan/SchoolPilot/pull/573) | included | `91eead05e8a3d5c822426bcd4b5279dd55f05011` | codex/passpilot-appointments-api | Serialize appointment eligibility with attendance and dismissal |
| [SchoolPilot #574](https://github.com/bzinkan/SchoolPilot/pull/574) | included | `9250fab903d16b41769d86ec12086dfef21f9a12` | codex/passpilot-appointments-api | Add PassPilot-only canonical school-year setup |
| [SchoolPilot #575](https://github.com/bzinkan/SchoolPilot/pull/575) | included | `e7d0a7b470d8e8b95c7936a14cb43c98dd4e602b` | codex/focus-commands-api | Add exact teacher Focus and Bring Forward controls |
| [SchoolPilot #576](https://github.com/bzinkan/SchoolPilot/pull/576) | included | `0f58534af0ec8c168ebcd9fba271e7f8acf3bd22` | codex/roadmap-corrected-base | Drain Student Information browser handlers before teardown |
| [SchoolPilot #577](https://github.com/bzinkan/SchoolPilot/pull/577) | included | `173f768a9f8ca83ca641eb6496cf17ef92921c45` | codex/classroom-actions-interface-base | Add reviewed Classroom actions with pinned policy and confirmed students |
| [SchoolPilot #578](https://github.com/bzinkan/SchoolPilot/pull/578) | already merged | `d2c047c27698990b25892bbce79200ba91920f8b` | main | Tolerate a replaced task's draining ALB target and require CI in the deploy gate |
| [SchoolPilot #579](https://github.com/bzinkan/SchoolPilot/pull/579) | included | `6efc27f4de187b4e43c923df31d6139c081727f7` | codex/passpilot-staff-interface-base | Add staff appointment scheduling and current-class reminders |
| [SchoolPilot #580](https://github.com/bzinkan/SchoolPilot/pull/580) | already merged | `27879128ccfe09ae1469d0b6252ea5b37e36059f` | main | Refresh transitive Axios to 1.20.0 for current security advisories |
| [SchoolPilot #581](https://github.com/bzinkan/SchoolPilot/pull/581) | included | `5e2fb408413abe50be6e79a5dd43071286de077b` | codex/roadmap-corrected-base | Keep kiosk metrics HTTP assertions within one minute |
| [SchoolPilot #582](https://github.com/bzinkan/SchoolPilot/pull/582) | included | `7b2ecdfaf9f5b38c89bb7a2fb974067843c92a83` | codex/focus-commands-api | Fence reviewed Classroom lessons and acknowledged opening |
| [SchoolPilot #583](https://github.com/bzinkan/SchoolPilot/pull/583) | included | `d1069bdd55e8a5b52231aef08dda5fdd257a229c` | codex/passpilot-staff-interface-base | PassPilot Reports v2: scoped aggregates and audited CSV |
| [SchoolPilot #584](https://github.com/bzinkan/SchoolPilot/pull/584) | included | `b1e4e6ea1e13ef81349a18bf697338c3b48ff8bd` | codex/passpilot-reports-v2-api | Add scoped server-backed PassPilot Reports v2 interface |
| [SchoolPilot #585](https://github.com/bzinkan/SchoolPilot/pull/585) | included | `a65a82283c4c44fcb8d1e32746010117ac7d6810` | codex/passpilot-reports-v2-api | test(passpilot): keep restricted reminder fixture stable at midnight |
| [SchoolPilot #586](https://github.com/bzinkan/SchoolPilot/pull/586) | included | `157c47baef24f65176da5bbc694309fe6cdeff03` | codex/usage-synthetic-load | Reduce usage attribution and report query work |
| [SchoolPilot #587](https://github.com/bzinkan/SchoolPilot/pull/587) | included | `b9fdbf3a46d0eda49b6c3d6e69eed8b1efd47eb9` | codex/roadmap-corrected-base | Keep kiosk issuance fixtures inside an active schedule window |
| [SchoolPilot #588](https://github.com/bzinkan/SchoolPilot/pull/588) | included | `328a814993e9c6ce79c172817e6d8e83c58b426b` | codex/roadmap-corrected-base | Fence preview fixture phases after paint and native capture completion |
| [SchoolPilot #589](https://github.com/bzinkan/SchoolPilot/pull/589) | included | `ed03deef647c80f59c9e9b35d56d66d0d08aecab` | codex/roadmap-corrected-base | Keep narrow Class tools usable and await actual browser state |
| [SchoolPilot #590](https://github.com/bzinkan/SchoolPilot/pull/590) | included | `f4742aaa87c1c8decc6c0b2a8dd368958a82a66f` | codex/roadmap-corrected-base | Make load harness fixture readiness and latency cohorts explicit |
| [SchoolPilot #591](https://github.com/bzinkan/SchoolPilot/pull/591) | included | `5d628383f6df9c7fad6d27e7a11e4d7af4ec28e7` | codex/usage-query-performance-api | Measure capped two-school usage profiles and preserve capacity limits |
| [SchoolPilot #592](https://github.com/bzinkan/SchoolPilot/pull/592) | included | `53e9a426d642046ec042d0cd157a8ca01b0062b3` | codex/usage-school-day-profile | Seed canonical primary assignments in usage fixtures |
| [SchoolPilot #593](https://github.com/bzinkan/SchoolPilot/pull/593) | included | `deecce0c3478b8b34424fef5748fd8df826515e5` | codex/roadmap-corrected-base | Fix concurrent ClassPilot device creation without rebinding |
| [SchoolPilot #594](https://github.com/bzinkan/SchoolPilot/pull/594) | included | `708bdd6fca9ecfa66ff1cfca97a9d9ce1b929bd5` | codex/student-device-upsert-concurrency | test(classpilot): retain auth fixture lifecycle roots |
| [SchoolPilot #595](https://github.com/bzinkan/SchoolPilot/pull/595) | included | `cffd1ed55fdda7f71f1ab1d7c94d769f26d4d015` | main | Freeze recipients for classroom actions and never widen a cleared selection |
| [SchoolPilot #596](https://github.com/bzinkan/SchoolPilot/pull/596) | included | `a7cb6f941e5f3a965a12c6eab6f9f18fce3fffe8` | main | Let teachers start a message with any student |
| [SchoolPilot #597](https://github.com/bzinkan/SchoolPilot/pull/597) | included | `dbaa4cdda517da49ede343043aa9ad994ac37a28` | main | Show the class roster in Messages |
| [SchoolPilot #598](https://github.com/bzinkan/SchoolPilot/pull/598) | already merged | `37c2dbacd9169477c03f961cecfc25cb73de7e75` | main | Record public ECS tasks and NAT removal in the production Terraform profile |
| [SchoolPilot #599](https://github.com/bzinkan/SchoolPilot/pull/599) | already merged | `13e3401c6c7f4797a534ca53d6357100e13db2f1` | main | Accept the AWS provider's computed leaves in the NatRollback inverse check |
| [SchoolPilot #600](https://github.com/bzinkan/SchoolPilot/pull/600) | already merged | `da1689f3704746993174eaea1c0c801c8b24b3f2` | main | Record that production has no NAT gateways and what that requires |
| [SchoolPilot #601](https://github.com/bzinkan/SchoolPilot/pull/601) | included | `f13cc336a028509bee57026a9770ce7e09ba3200` | main | Refuse live teacher replies while messaging is switched off |
| [SchoolPilot #602](https://github.com/bzinkan/SchoolPilot/pull/602) | included | `6990e10b3bc620ca3c07a4e9df8cb87b1e109f7a` | main | Hold the denial refresh until the Observe denial banner is seen |
| [ClassPilot #119](https://github.com/bzinkan/ClassPilot/pull/119) | included | `fffac0e0dc90704bccafcb9f230b9639ec9bba52` | main | Enforce precise resources with atomic policy rollback |
| [ClassPilot #120](https://github.com/bzinkan/ClassPilot/pull/120) | included | `d6cb334a6546cc06c744870382bdb5710f9d5934` | codex/precise-focus-candidate | Implement exact Focus and Bring Forward lifecycle |
| [ClassPilot #121](https://github.com/bzinkan/ClassPilot/pull/121) | included | `3a9ece517d521632f1accbb5a51ff3fcf1934162` | codex/focus-enforcement | Prepare precise and Focus candidate 2.10.0 |
| [ClassPilot #122](https://github.com/bzinkan/ClassPilot/pull/122) | included | `2aa6df988a78cb5860cef2c0866cab46566ffec5` | codex/precise-focus-release | Fix 2.10.0 Attention and lesson regressions and harden teacher chat delivery |

The coordinated review containers are [SchoolPilot #603](https://github.com/bzinkan/SchoolPilot/pull/603) and [ClassPilot #123](https://github.com/bzinkan/ClassPilot/pull/123). They are additional to the 60 source PRs above. Their open/draft state is recorded in the structured inventory; neither is merged. The exact 2.9.7 packaged source is `065be165b5df704d84eb716e3fb914c1fed17f98`, independently of later documentation-only ClassPilot commits.

#597 incorporates #595/#596 and their conflict resolutions once. The final integration retains #601/#602 and the complete roadmap. #574 and #586 have explicit conflict/fixture equivalence records. #562 is superseded by merged #580. #560 is reconciled by current release documentation while its historical evidence remains intact. #561 is a decision document only. ClassPilot #119→#120→#121→#122 remain intact in the separate 2.9.7 lineage.

Original checkouts and draft Observe work are excluded from mutations. SFU implementation, TURN changes, paid provisioning and legacy deletion remain excluded.
