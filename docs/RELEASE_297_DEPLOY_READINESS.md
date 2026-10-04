# SchoolPilot/ClassPilot 2.9.7 deploy readiness

Owner-adopted decision: 2026-10-03. This records authorized implementation and
preparation, not merge, deployment, Store submission/publication or activation.
The owner subsequently chose to wait for release readiness before submitting
ClassPilot to the Store.

> SchoolPilot/ClassPilot 2.9.7 may proceed with both new Usage modes off after passing final-source regression, classroom, current-school capacity and recovery checks. Usage activation requires its separate completed development, synthetic capacity acceptance and deployed observation. Historical single-task 100-heartbeat/second failures remain preserved and are not reclassified as passes.

## Current verified checkpoint

- Current application source is `ddc5996b3b8645859fa51a9613486db52c481b7f`.
  It incorporates exact Redis JSON/revision preservation and health checks that
  use the existing sentinel without schema CREATE permission. The canonical
  combined backend type check passes. [Redis component evidence](release-evidence/release-297/release-gate-policy-20261003/realtime-native-green-02.json)
  records 24 passes, including four native Redis regressions, with no skips.
  [Six native health tests](release-evidence/release-297/release-gate-policy-20261003/health-native-green-03.json)
  also pass; the type-only adjustment emits identical JavaScript to that proof.
  Final combined CI and measured classroom/capacity acceptance remain pending. Earlier application
  images and load measurements below are historical and do not certify this source.
- The [fresh local serving and compatible fallback artifacts](release-evidence/release-297/release-gate-policy-20261003/runtime-artifacts-ddc5996b-c578120d.json) pass pinned builds, compatibility checks and scans with zero HIGH/CRITICAL findings. The serving source is `ddc5996b`; fallback is `c578120d`. [Native schema continuity](release-evidence/release-297/release-gate-policy-20261003/runtime-schema-continuity-ddc5996b.json) verifies all 54 serving migration checksums and the fallback's unchanged 53-entry subset. It explicitly records 99 CRLF-only compiled differences rather than claiming raw byte equality.
- The [actual API/worker staged recovery](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-passed.json) and its [independent review](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-independent-review.json) pass 128-table bridge, 129-table lifecycle adoption, compatible fallback and candidate return. All four API health cycles pass without schema CREATE permission; eight service processes drain gracefully. The complete 54-entry ledger, screenshot function/ACL and expired chat/history are retained. Exact synthetic resources are absent. This is local protocol/service recovery, not exact Focus/combined Classroom, production catalog, ECS/ALB drain, capacity or Chromebook evidence.
- Historical application source `ed0265133d4a87fd3d2477dd90884535b749ee7d`: all 20
  reported checks pass, including backend, both database lanes, four frontend
  release shards and security. ClassPilot head
  `8069a9c9bd50352e187847158b356a69edc4e45d`: all 10 checks pass.
  The [read-only CI/package checkpoint](release-evidence/release-297/release-gate-policy-20261003/ready-checkpoint-ed026-20261004-01.json)
  records exact heads and links. The [fresh review-head checkpoint](release-evidence/release-297/release-gate-policy-20261003/ci-ca388d10-complete.json)
  verifies all 20 checks at `ca388d10` and all 10 ClassPilot checks, exact
  application/frontend input equivalence, packaged ancestry and unchanged ZIP.
  Resulting-main checks remain required after separately authorized merges.
- The [application correction record](release-evidence/release-297/release-gate-policy-20261003/application-correction-summary.json)
  records 2,032 local unit passes with no skips, the fresh candidate image with
  zero HIGH/CRITICAL findings, rebuilt frontend, 54-migration/129-table synthetic
  admission, and source migration re-entry. The corrected fallback source is
  `6d1f3a7e737ebd2e3e266f2f571cdea811db5e27`; its [fresh scan and focused checks](release-evidence/release-297/release-gate-policy-20261003/safe-fallback-6d1f3a7e-summary.json)
  and [candidate → fallback → candidate image recovery](release-evidence/release-297/release-gate-policy-20261003/recovery-ed026-6d1f3a7e-summary.json)
  pass. Recovery retains the full ledger, private-chat expiration/history,
  screenshot function permissions and exact offline Focus cleanup.
  These proofs do not establish capacity, production admission or deployment.
- [Teardown-accounting validators](release-evidence/release-297/release-gate-policy-20261003/harness-physical-settlement-9fd96ea1-summary.json) pass 40 checks. Their historical application/frontend binding is ed026; [CI at 2110e269](release-evidence/release-297/release-gate-policy-20261003/ci-2110e269-complete.json) passes all 20 checks and covers that harness correction. The earlier [2c31d0f6 checkpoint](release-evidence/release-297/release-gate-policy-20261003/ci-2c31d0f6-complete.json) remains historical.
- The [active-audience and PostgreSQL readiness correction](release-evidence/release-297/release-gate-policy-20261003/harness-active-audience-631fb338-summary.json), integrated as `0691cdb8`, passes all 53 focused checks with no skips. Both regressions fail against the preceding frozen harness. It preserves application/schema bytes, offering counts, profile limits and historical failures; refreshed helpers and fresh measured runs remain required.
- The [separate operational fixture](release-evidence/release-297/release-gate-policy-20261003/health-operational-fixture-20975334.json), integrated as `87a98be7`, passes 57 focused checks. It owner-creates the existing global health sentinel and grants only runtime DML/sequence access. The unchanged migration schema and the full operational schema each retain their own fingerprints. This is setup evidence, not a health or capacity pass.
- [Operational artifact custody](release-evidence/release-297/release-gate-policy-20261003/health-operational-custody-c73f8f39.json), integrated as `9e80cd33`, raises the focused suite to 60 passes and rejects altered, missing or escaped SQL artifacts. Historical schema/snapshot receipts remain unchanged.
- Fresh CI at `72578c05` exposed a test journal-reader sharing violation while its supervisor owned the append handle. The [focused Windows regression](release-evidence/release-297/release-gate-policy-20261003/aws-journal-reader-sharing-regression.json) proves the preceding reader fails, the shared reader returns identical retained records, and malformed/partial/hash/sequence errors still reject. The full safety lane must rerun; this correction changes only its test reader.
- The [screenshot test-fixture regression](release-evidence/release-297/release-gate-policy-20261003/screenshot-fixture-abi-regression.json) restores dispatch by the unchanged Redis command argument contract instead of a removed Lua implementation literal. Native Redis behavior remains separately tested. [Report browser cancellation](release-evidence/release-297/release-gate-policy-20261003/report-export-browser-cancellation.json) passes all ten cases; a test-loader variant removing the actual failure-handler abort is rejected even after login navigation. The original network cancellation, no-download and UI assertions remain. Both corrections affect tests only; final CI must cover their combined head.
- [Three candidate sole-school runs](release-evidence/release-297/release-gate-policy-20261003/sole-f8af7-completed-failed.json) pass all 798 offers at p95 44–54 ms and 22–25% API CPU, but the strict paired comparison is unaccepted because every baseline misses its absolute latency limit and A/A controls fail stability. [The 34/s comparison](release-evidence/release-297/release-gate-policy-20261003/normal-f8af7-incomplete-failed-summary.json) stopped after its failed baseline; no host cause is established.
- The [capability-on 34/s run with the current helper](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-6afc8-summary.json) passes all 2,040 offers, exact recipient/persistence checks, p95 about 309 ms and 54.2% API CPU. The earlier [f8 helper run](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-f8af7-summary.json) also passed at about 118 ms and 51% CPU; neither substitutes for three continuous mixed runs or a production-capability dark comparison. Those and the separate Usage campaign remain pending.
- The [first continuous mixed block remains failed](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-6afc8-failed-held.json): two unchanged attempts completed all declared heartbeat offers and cleaned up normally, but mandatory classroom checks failed because the positive fixture also targeted the idle synthetic school. The third attempt was held before reservation. The server correctly refused controls after that school's signal expired. The new harness revision must derive positive recipients from the declared active clients while retaining foreign-school checks; these failed attempts cannot count toward the required three passes.
- The [fresh October 4 fixture and restricted restoration](release-evidence/release-297/release-gate-policy-20261003/usage-oct4-snapshot-preparation.json) pass preparation checks with two million observations, the exact application, 54 migrations and 129 RLS tables. Its authority expires at 11:12:21 Eastern on October 4. The [October 3 preparation](release-evidence/release-297/release-gate-policy-20261003/usage-oct3-snapshot-preparation.json) and failed October 4 CLI-discovery attempt remain unchanged. Fixture preparation does not establish capacity acceptance.
- The [earlier actual-services staging attempt remains failed overall](release-evidence/release-297/release-gate-policy-20261003/staging128129-partial-05.json). Its 128-admission bridge verifies legacy WebSocket delivery/ACK, announcements, real worker appointment maintenance, zero lifecycle adoption and both service SQL drains. That attempt did not establish 129 adoption/fallback: the synthetic client lacked a real authenticated heartbeat support record. Its failure remains preserved alongside the fresh passing rehearsal above.
- The [next staging attempt](release-evidence/release-297/release-gate-policy-20261003/staging128129-failed-06.json) reached an authenticated heartbeat but failed its shared snapshot lookup. The [native Redis diagnostic](release-evidence/release-297/release-gate-policy-20261003/realtime-native-regression-ed026.json) confirms pre-existing empty-array corruption and same-millisecond revision rounding in all three snapshot mutations. Its own cleanup-import failure is retained, so it is diagnostic evidence rather than accepted recovery. Narrow snapshot and health-monitor permission corrections are integrated and have native proof. Final candidate/fallback artifacts and source-bound acceptance must be refreshed; ed026 evidence remains historical.
- The old registered campaign is closed using the byte-identical frozen validator.
  Canonical campaign hash: 10772ca928db810eda736c260f450cbe97ab76d1f130e7124c8e7e5e72815e92.
  Closed journal hash: 0fa077d62df01d2423c629738e0e76695532ed44ba4ab02ed413aa18327c6604.
  Its capacity result remains false.
- Fresh October 3 metadata identifies serving source
  7af9d0dd5bc2bd3e13b96d35a577725e07f8b678, API-emergency:163 and worker:179,
  image sha256:c87433cdf3d88e0c291a50d1ae74fbc116f167048f7db9d6c2d1d0ebfc52b9e8,
  one running API and worker, 121 admitted tables and unsuspended autoscaling.
  Receipt hash: 6caf8d541571eeccb6fde8ef674bff7579d7b44af521512a74742f939d0b2b4a.
  This does not verify the production catalog, migration history, backups or capacity.
- The configured API minimum is three weekdays 05:45–16:00 America/New_York,
  one otherwise, maximum six. The 16:00 action lowers the minimum; it does not
  force exactly one running task. The October 2 gate wording was unrelated to scaling.
- ClassPilot ZIP version 2.9.7, SHA-256
  82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575,
  376052 bytes, copied without rebuilding to C:/GitHub/ClassPilot/dist/ClassPilot-v2.9.7.zip.
  Public listing still showed 2.9.6 when checked; pending submissions remain unverified.
  Four [actual packaged-function retry checks](release-evidence/release-297/release-gate-policy-20261003/packaged-heartbeat-retry-297-summary.json)
  verify bounded 503 retries, Retry-After, retired-auth cancellation and in-flight
  heartbeat exclusion. No extension bytes changed; these are not browser capacity
  or managed-device results.

## Release profiles and acceptance

Keep both new Usage modes off. Use matching observed production capabilities,
logical fixture bindings and pinned runtime bases for black-box baseline/candidate
comparisons, retaining each source's own required schema and admission inventory.
An actual production image is preferred; a rebuilt baseline is a source comparison.

Run two baseline controls, then three alternating pairs per declared workload:
133 clients/798 offers over 60 seconds all pinned to one API; 340 clients/2040
offers at 34/s; and 100/s diagnostic overload. The first two require every offer
to succeed, zero refused/late/acquisition failures, independently correct persisted
bindings and complete unforced drain. Heartbeat p95 must be at most 500 ms;
candidate whole-window CPU mean must be below 60% quota. Median paired CPU/success
ratio must be at most 1.05 and p95 ratio at most 1.10 with at most 50 ms increase.
No individual pair may exceed a 10% CPU increase or 100 ms p95 increase. Noise
that crosses the rule is inconclusive; retain a complete fixed repeat block.
Saturation is diagnostic, while authority, recipient, confidentiality and recovery
failures block release at every offering.

Candidate classroom profiles require precise restrictions, Focus and private-chat
lifecycle on, Usage off. Three consecutive 15-minute mixed runs cover a five-minute
133-client/one-API phase, five minutes with three APIs sharing the database, and
five minutes after controlled loss to two APIs. Preserve sticky affinity and record
reconnect offers separately. Exercise screenshots, authenticated staff reads,
frozen recipients, selection/authority changes, restriction-before-lesson sequencing,
Attention page preservation, exact Focus/Stop Focus, private close/off/send/claim/ACK,
announcements, reconnect and session cleanup. A separate capability-on 34/s normal
check must also pass. Expected negative probes are distinct from failed valid work.

New profiles have new contract hashes and journals. Their offering, deadlines,
row-count and last-offer bounds derive from the declared contract. Verify nondefault
rate propagation. Preserve the original profile/contract and fix lifecycle polling
in the new revision, not by weakening recorded acceptance.

Quiet-host generator/canary evidence is independent of application outcomes.
After two independently invalid preparation rehearsals, move unchanged workload
and service limits to an existing Linux host; do not provision paid resources.
Do not exclude application latency or WAL stalls as presumed host failures.

## Separate Usage activation work

Implement eight active heartbeat requests per API, 32 queued, 250 ms admission
wait after cryptographic verification and before the first database checkout.
Overload answers 503/CLASSPILOT_HEARTBEAT_BUSY with Retry-After: 1. Admission and
heartbeat/staff identity pool fairness operate when either admitted new Usage mode
is on. Preserve existing pool ceilings, deadlines, limiter order, legacy paths,
transaction ownership and SQL/cleanup settlement.

Recompute with disjoint changed-row UPDATE, missing-row INSERT and vanished-row
DELETE in the existing transaction/advisory lock. Preserve atomic completion,
monotonic processed cutoff, empty days, unavailable dates, retention, tenant scope
and school-local boundaries. Unchanged rollup rows stay untouched; ledger WAL is
legitimate. Measure distinct reports/query plans before any parallelism change.
No persistent cache, new aggregate table, single-lease/delivery fusion, timeout
increase or durability change is approved.

Declare a separate three-API/shared-database Usage campaign: two synthetic schools,
one million stored observations each, 6000 offers at 100/s fleet-wide, all 64
reports plus distinct-report checks, complete workers within 48 seconds, independent
current-day/totals/coverage/CSV/tenant agreement, no acquisition/statement failures
and complete unforced drain. Require three consecutive cold final-source/schema
passes. Cold restart clears PostgreSQL buffers, not host filesystem caches.

Before broader capacity is claimed, test 800 active clients with concurrent
classroom/report/worker traffic, three-to-two loss and a repeat that routes all
lost-task reconnects to one survivor. Record per-task load rather than assuming
equal distribution. The original single-task comparison remains diagnostic; the
new comparison is the paired production-source/candidate release comparison.

## Operator packet and staged execution

Reconcile included/superseded/excluded PRs. Bind final CI, scanned API/worker image,
frontend hash, immutable admissions/migrations, compatible recovery image and
extension ZIP ancestry. Rehearse candidate to compatible fallback to candidate.
Retain original checkouts and Observe; preserve public ECS/no NAT and the disabled
immutable-image workflow.

After separately approved merges through SchoolPilot #603 and ClassPilot #123,
verify resulting-main CI/application equivalence, final digests and fresh production
health/catalog/history/flags/headroom/backups/schedules/window. The bounded catalog
inspector still needs separate authorization. The old production image cannot be
used after private-chat lifecycle adoption. Operator commands must use supported
tooling and contain no unexplained placeholders when execution is requested.

Deploy compatible dark backend/admission stages, drain incompatible writers, verify
health, publish frontend, and smoke Library/Rules/appointments/reports. Recheck Store
listing and pending submissions before the owner's separately authorized upload.
Confirm installed extension identity/version/capabilities, then enable current-school
classroom pilots individually and observe at least 30 sample-bearing minutes.
Promote capabilities individually with evidence bound to each current task pair.
Two-Chromebook validation remains waived_not_passed.

Usage follows accepted synthetic capacity, three clean deployed daily-shadow school
days and a complete new-rollup observation school day with Digital Usage off before
reporting activation. Retain weekday 04:45–05:59 Eastern ordinary-deploy protection
and record the approved dated window. Contain recipient/authority/restriction/chat/
cleanup/health defects immediately. SFU, TURN, paid provisioning, legacy deletion
and unrelated Observe are excluded.
