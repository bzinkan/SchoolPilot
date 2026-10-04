# SchoolPilot/ClassPilot 2.9.7 deploy readiness

## October 4 preparation update

The [corrected approved production metadata inspection completed](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-60cd65-completed.json) on October 4 at 12:35 Eastern, with [independent closure and migration reconciliation](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-60cd65-independent.json). It observed 121 forced-RLS tables, 43 completed migration records with no incomplete records, DeSales's active ClassPilot entitlement and the required existing health-sentinel permissions. The temporary task stopped successfully and its definition was deregistered; no serving service or database record changed. Ordinary expansion adds ten required migrations for 53 completed entries and eight protected tables for 129. The optional staff-identity contract remains deferred. The synthetic production-source fixture has that additional optional record; it must not be described as an export of actual production state. Rehearsal from the observed starting state remains required. The new screenshot-evidence function is absent in production and must be installed and verified through its supported migration before candidate serving.

CI at `b6cadc74` passed compilation and builds but failed one harness unit test that read a historical Git object unavailable in the CI checkout. The test-only repair is integrated as `28f256d6`: it preserves the exact historical fixture and profile assertions, and [passes all 19 focused tests plus two syntax checks with Git unavailable](release-evidence/release-297/release-gate-policy-20261003/ci-historical-profile-fixture-pure-passed.json), with [independent replay](release-evidence/release-297/release-gate-policy-20261003/ci-historical-profile-fixture-independent.json). [All 20 resulting-head SchoolPilot checks and ten ClassPilot checks pass](release-evidence/release-297/release-gate-policy-20261003/ci-28f256d6-complete-independent.json). The six named database-health and four Redis regressions also pass individually without skips. No application, schema, artifact or release gate is changed by that repair. Any later preparation head and resulting main still require their own applicable checks.

The [compatible fallback preparation supplement](RELEASE_297_COMPATIBLE_FALLBACK_PREPARATION.md) documents the implemented registration adapter, exact artifact bindings, supported interfaces and genuinely future publication inputs. Local verification does not substitute for actual registry publication, inactive task registration or a protected recovery rehearsal.

The [bounded worker observation](release-evidence/release-297/release-gate-policy-20261003/readonly-worker-observation-20261004.json), with [independent replay](release-evidence/release-297/release-gate-policy-20261003/readonly-worker-observation-independent.json), used nine GETs and no SQL or cloud mutations. One fresh, fully parsed staff-identity scan reports one school scanned and zero integrity findings, failures or overlap. Both returned log pages include continuation tokens, so the original strict window-completion fields remain unverified. ECS provider health remains `UNKNOWN`. This positive existing-job event is not complete worker, capacity or deployment acceptance.

The existing 133/250-client and mixed-classroom campaigns below used the full 54-entry synthetic fixture. Their source and schema bindings remain intact. The new production-default 43-to-53 rehearsal and matched 133-client comparison must pass before the current-school release recommendation; the older metrics are not relabelled as measurements on the ordinary 53-entry configuration.

The [first production-default setup attempt failed](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-setup01-failed.json), with [independent failure and custody review](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-setup01-independent.json). The source schema constructor exited successfully, but the fixture attempted full RLS policy setup before the existing supervision-report migration created its three tables. No migration CLI or service ran. Exact owned resources are absent without forced cleanup; the failed probe's exit 1 remains recorded, so this is containment success rather than a graceful native pass. A narrowly reordered prospective attempt runs the actual baseline migrations before full policy verification; the original failure remains unchanged.

The [second setup attempt also remains failed](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-setup02-failed.json), with [independent custody review](release-evidence/release-297/release-gate-policy-20261003/production-default43-53-setup02-independent.json). The actual baseline CLI completed all 43 expected callbacks with the optional contract deferred, then duplicate temporary-file allocation stopped preparation before policy/native-ledger verification or candidate serving. Both owned containers exited 0 and all owned resources are absent without force. Logged callback completion does not replace native checksum/mode/status or schema verification. The next prospective derivative changes only unique environment/proof allocation and preserves both failures.

DeSales's 133-client workload has three fresh one-school passes on final application `ddc5996b`, with school-hours limits disabled and both new Usage modes off. All 798 offers per run persist with correct student/session bindings; authenticated own-school staff reads and foreign-school denials, full migration/RLS checks and unforced cleanup pass. Worst API CPU is 25.349% of its unchanged one-CPU quota and worst heartbeat p95 is 62.124 ms. [Retained results](release-evidence/release-297/release-gate-policy-20261003/lower-load-aaf95-ddc-sweep-failed.json) and [independent replay](release-evidence/release-297/release-gate-policy-20261003/lower-load-aaf95-independent-actual.json) distinguish these three passes from the failed overall campaign.

The higher-load campaign remains failed: 500 clients exceeded CPU and latency limits; the second 340-client confirmation exceeded the 50% CPU selection margin. Its third confirmation was held. A [new three-run 250-client confirmation passes](release-evidence/release-297/release-gate-policy-20261003/lower-250-aaf95-ddc-confirmation-passed.json), with [full independent replay](release-evidence/release-297/release-gate-policy-20261003/lower-250-independent-actual.json). All 4,500 offers persist correctly, all 36 scoped staff reads/denials and final native/log/cleanup checks pass; worst CPU is 40.954% and worst heartbeat p95 is 81.179 ms. The selected supported limit is 250 clients for this Usage-off heartbeat/staff-read profile; deployment remains DeSales's 133 clients, with its separately accepted classroom block. Measured production/candidate comparison, broader fleet capacity and Usage acceptance remain pending. Raw acquisition counters are unavailable in this unwrapped black-box profile; complete request outcomes, final captured-connectivity intervals and retained logs provide the explicitly indirect check.

The earlier production catalog inspection [failed before task launch](release-evidence/release-297/release-gate-policy-20261003/catalog-inspection-90304-failed-before-launch.json). The retained tagged ECS definition reproduces an environment-order mismatch against the old exact projection; the first verification response was not retained. Its temporary definition is inactive, no database task launched, and serving services and database records were unchanged. That failure remains archived after the corrected inspection above; it is not relabelled a pass. [Fresh service metadata](release-evidence/release-297/release-gate-policy-20261003/readonly-production-20261004-05.json) and [backup/headroom observations](release-evidence/release-297/release-gate-policy-20261003/readonly-backup-headroom-20261004-05.json) are Sunday low-load checks, not school-day capacity or successful restore evidence.

Reviewed operator preparation and the guarded inactive-compatible-fallback adapter are integrated through `27f16309`, with [independent preceding integration review](release-evidence/release-297/release-gate-policy-20261003/harness-integration-dd1f6666-independent-review.json). The environment-order follow-up [passes all 28 focused cases and two syntax checks](release-evidence/release-297/release-gate-policy-20261003/compatible-fallback-environment-order-pure-passed.json), with [independent source/proof review](release-evidence/release-297/release-gate-policy-20261003/compatible-fallback-environment-order-independent-review.json). Registry publication and task registration remain unexecuted. Application, schema, build, infrastructure and frontend application inputs are unchanged from `ddc5996b`; the frontend test tree is not claimed identical. The earlier [green `b5d59130` checkpoint](release-evidence/release-297/release-gate-policy-20261003/ci-b5d59130-complete.json) remains historical alongside the exact `28f256d6` checkpoint above. Merges, deployment, Store submission and activation remain separately authorized operations. The release has no deployment green light yet.

The [combined primary preparation suites](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-dd1f6666-pure.json), with [independent replay](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-dd1f6666-independent-review.json), pass 181 unique tests with zero failures, cancellations, skips or TODOs, in 17.559 seconds at the unchanged 20-second per-file limit. Exact owned processes are absent without force. This verifies the merged harness, report-cost checks and original 24-case fallback adapter; the subsequent 28-case adapter suite covers the new order correction. The exact 28f checkpoint now passes; later preparation heads and resulting main still require their own applicable checks.

## Earlier bound preparation evidence

The shared distinct-report slice is integrated as `1091eaeb` from reviewed `e330c39a`. [Source binding](release-evidence/release-297/release-gate-policy-20261003/harness-integration-1091-source-binding.json) verifies the 11 identical reviewed Git blobs and unchanged application/schema/build/infrastructure inputs; CRLF-only working differences remain explicit. The [focused component proof](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-shared-pure-passed-02.json) passes 48 unique cases and 11 syntax checks, with [independent review](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-shared-independent-review.json). The [full primary aggregate](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-1091-pure.json) passes all 139 unique cases (133 harness plus six report-cost cases), no skips/cancellations/TODOs, in 14.496 seconds with the configured 20-second test timeout, with [independent aggregate/source review](release-evidence/release-297/release-gate-policy-20261003/harness-integrated-1091-independent-review.json). The [earlier dependency failure](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-shared-pure-failed-01.json) remains failed. At that historical 1091 checkpoint, helper/protocol-native verification, distinct-report capacity and new-head CI remained pending. Later native proofs and the exact 28f CI checkpoint are recorded above; actual distinct-report capacity remains pending, and later heads still require applicable checks.

The [fresh final-source Usage attempt `df9199c13d82`](release-evidence/release-297/release-gate-policy-20261003/usage-native-ddc5996b-df919-failed-03.json) failed: 2,655/6,000 heartbeats succeeded, 3,345 returned HTTP 503, and 56 offers were late. All 64 generator reports and 26 original lifecycle events passed, but final independent current-day/coverage/CSV/audit oracles were not reached. One heavy worker completed in 39.268 seconds; the second hit PostgreSQL statement timeout. [Status/ownership review](release-evidence/release-297/release-gate-policy-20261003/usage-native-df919-status-ownership-review.json) verifies admission denials match the 503 count, no acquisition failures and complete unforced drain. [Worker budget review](release-evidence/release-297/release-gate-policy-20261003/usage-native-df919-worker-budget-review.json) records the shared FIFO admission and 60-second whole-operation budget, including waiting; no standalone 60-second SQL execution is established. The retained CPU capture also failed its unchanged timing guard. All five PostgreSQL errors remain included. This is a failed capacity attempt with zero accepted cold runs and two later attempts held. Host interference, a connection leak and a causal query bottleneck are unproven. Both new Usage modes remain off; the strict dark comparison and operational/live gates still block a release green light. Targeted fresh-fixture diagnostics are preparation, not replacement acceptance.

Owner-adopted decision: 2026-10-03. This records authorized implementation and
preparation, not merge, deployment, Store submission/publication or activation.
The owner subsequently chose to wait for release readiness before submitting
ClassPilot to the Store.

> SchoolPilot/ClassPilot 2.9.7 may proceed with both new Usage modes off after passing final-source regression, classroom, current-school capacity and recovery checks. Usage activation requires its separate completed development, synthetic capacity acceptance and deployed observation. Historical single-task 100-heartbeat/second failures remain preserved and are not reclassified as passes.

## Current verified checkpoint

- The reviewed distinct-report modules and mandatory post-load native verification are integrated through `5a03c900` (`edb3bfb3`, `0a974013`, `b8030be4`, `5a03c900`). [Integration binding](release-evidence/release-297/release-gate-policy-20261003/harness-integration-5a03-source-binding.json) verifies all 13 reviewed Git blobs and unchanged application, schema, build and infrastructure inputs. All 13 primary working files differ from their canonical Git blobs only by CRLF; the six host files also differ from the reviewed host working-file hashes only by CRLF. This is recorded rather than claiming raw byte equality. Local verification passed 150 test executions with zero failures/skips, including 27 duplicate executions (123 unique cases). The [host component record](release-evidence/release-297/release-gate-policy-20261003/usage-post-load-native-host967-summary.json) separately records 118 unique checks including report-cost coverage. That checkpoint predates the shared-profile slice and 139 unique aggregate passes recorded above; native verification and new-head CI remain required.
- A [fresh final-source Usage fixture](release-evidence/release-297/release-gate-policy-20261003/usage-fresh-fixture-ddc5996b-summary.json) and [independent input review](release-evidence/release-297/release-gate-policy-20261003/usage-fresh-fixture-ddc5996b-independent-review.json) verify two synthetic schools, 2,000,002 stored observations (one actual ingest preflight per school), all 54 migrations, 129 admitted RLS tables, canonical schema identity and restricted native restoration. Exact cleanup is unforced. Preparation is not capacity acceptance. The first cold invocation failed before measured traffic because its clean source clone lacked restoration dependencies; its original `cleanupPassed=false` remains, with separate exact resource-absence evidence. The [narrow invocation repair review](release-evidence/release-297/release-gate-policy-20261003/usage-runner-dependency-repair-independent-review.json) binds the already-verified restoration clone, isolated dependency preflight and a new campaign. Workload, original profile, application/helper bytes and resource/deadline limits are unchanged. No Usage capacity pass or release green light is claimed.
- Current application source is `ddc5996b3b8645859fa51a9613486db52c481b7f`.
  It incorporates exact Redis JSON/revision preservation and health checks that
  use the existing sentinel without schema CREATE permission. The canonical
  combined backend type check passes. [Redis component evidence](release-evidence/release-297/release-gate-policy-20261003/realtime-native-green-02.json)
  records 24 passes, including four native Redis regressions, with no skips.
  [Six native health tests](release-evidence/release-297/release-gate-policy-20261003/health-native-green-03.json)
  also pass; the type-only adjustment emits identical JavaScript to that proof.
  [Combined CI at review head `dd6d54c0`](release-evidence/release-297/release-gate-policy-20261003/ci-dd6d54c0-complete.json)
  passes all 20 SchoolPilot checks and all 10 unchanged ClassPilot checks. It verifies
  application/build input equivalence and the ten named native Redis/health cases.
  The three-run classroom acceptance below passes; the strict dark comparison
  and separate Usage capacity acceptance remain pending. Earlier application
  images and load measurements below are historical and do not certify this source.
- [Three consecutive full classroom runs pass](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-passed-block.json), with [complete independent review](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-independent-review.json), [campaign closure review](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-closure-review.json) and [public-summary verification](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-7238-ddc-public-summary-review.json). Each 900-second run binds application `ddc5996b`, helper source `7238c17c`, the unchanged schema and Usage off. All 36,309 offers have exact persisted bindings; 180 commands and 90 private messages pass native recipient/lifecycle checks. All 45 minute acceptance sets pass; worst minute p95 is 115.317 ms and highest per-API minute CPU is 24.7454%. Actual API0 disappearance precedes reconnect by 345/322/176 ms, and cleanup is complete and unforced. This accepts the current-school synthetic classroom block only. Dark comparison, broader 800-client capacity, Usage and live validation remain separate gates.
- [Fresh read-only production metadata](release-evidence/release-297/release-gate-policy-20261003/readonly-production-20261004-03.json), observed about 06:15 Eastern on October 4, finds the unchanged `7af9d0dd`/`c87433cd` serving pair, one API and one worker, a healthy API target, 121 configured admission tables and unchanged settings. RDS is available with 14-day backup retention and a restorable point about three minutes earlier. Five-minute Sunday metrics are low-load observations. Actual catalog/ledger/privileges, successful restore evidence and an approved operational window remain unverified; no database connection or cloud mutation occurred.
- The [historical distinct-report RPC test timeout](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-rpc-pure-failed-02.json) remains failed at its original 20-second limit. [Bounded stage evidence](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-rpc-duplicate-preparation-red.json) localizes the stall to duplicate-preparation error construction after imports and initial preparation complete. A Boolean assertion preserves the rejection and prevents rendering the prepared private state. The [corrected full suite](release-evidence/release-297/release-gate-policy-20261003/usage-distinct-rpc-pure-passed-03.json) passes 38/38 tests and all three syntax checks with zero skips at the unchanged 20-second limit; exact owned processes are absent. This is the pre-integration component record; its source slice is now included as recorded above. Actual distinct-report native endpoints/capacity remain unverified. No prior failure is accepted or erased.
- The [fresh local serving and compatible fallback artifacts](release-evidence/release-297/release-gate-policy-20261003/runtime-artifacts-ddc5996b-c578120d.json) pass pinned builds, compatibility checks and scans with zero HIGH/CRITICAL findings. The serving source is `ddc5996b`; fallback is `c578120d`. [Native schema continuity](release-evidence/release-297/release-gate-policy-20261003/runtime-schema-continuity-ddc5996b.json) verifies all 54 serving migration checksums and the fallback's unchanged 53-entry subset. It explicitly records 99 CRLF-only compiled differences rather than claiming raw byte equality.
- The [actual API/worker staged recovery](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-passed.json) and its [independent review](release-evidence/release-297/release-gate-policy-20261003/staging128129-ddc5996b-independent-review.json) pass 128-table bridge, 129-table lifecycle adoption, compatible fallback and candidate return. All four API health cycles pass without schema CREATE permission; eight service processes drain gracefully. The complete 54-entry ledger, screenshot function/ACL and expired chat/history are retained. Exact synthetic resources are absent. This is local protocol/service recovery, not exact Focus/combined Classroom, production catalog, ECS/ALB drain, capacity or Chromebook evidence.
- The [new native classroom oracle proof](release-evidence/release-297/release-gate-policy-20261003/classroom-native-oracle-c1a09-ddc-proof.json) rejects the preceding incorrect recipient interpretation on actual produced rows and verifies exact message/outbox/thread parents, delivery attempts, lifecycle fences and retained history. Wrong-binding/cardinality/generation mutations still reject. The [fresh capability-on 34/s check](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-native-c1a09-ddc-summary.json), bound to `ddc5996b`, succeeds on all 2,040 offers with zero refused/late offers or invalid persisted bindings, p95 179.874 ms and 55.386% fixed-window API CPU. Both Usage modes are off. This is one normal-load check; the dark comparison remains required, while the full mixed passes are recorded above.
- [The refreshed capability-on 34/s check on helper 13](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-native-7238-ddc-summary.json), bound to `7238c17c`/`ddc5996b`, passes all 2,040 HTTP/persisted offers, zero failures/refused/late/invalid bindings, p95 162.860 ms and fixed-window API CPU 54.886%. Its eight commands/four messages, error coverage and exact unforced cleanup pass. The [short native loss-boundary proof](release-evidence/release-297/release-gate-policy-20261003/classroom-loss-boundary-7238-ddc-native-proof.json) separately passes 266 ordinary/133 reconnect offers and 399 exact persisted bindings; actual API0 ingress is 107 and physical absence precedes reconnect by 160 ms. This 20-second preparation proof does not replace the three 900-second runs, dark comparison, Usage or live acceptance.
- The [next native mixed attempt remains failed](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-native-c1a09-ddc-failed-summary.json): all 11,970 ordinary offers and 133 reconnect offers succeeded with exact persistence, 60 commands/30 messages passed the native binding oracle, and cleanup passed. One loss-minute ordinary offer reached API0 instead of a declared survivor, so the distribution check failed and subsequent attempts were held. Routing used wall-clock time while minute membership used declared offsets; the exact historical per-offer skew is inferred because dispatch timestamps were not retained. Harness correction `7238c17c`, integrated as `15100dc3`, binds routing to declared offsets and physical shutdown to independently counted arrivals; actual dispatch timestamps are now retained. [All 81 focused checks pass](release-evidence/release-297/release-gate-policy-20261003/harness-boundary-7238c17c-public-summary.json), with the actual preceding generated wrapper red and corrected wrapper green at the simulated boundary. The native preparation, refreshed normal-load check and new three-pass campaign above now pass. No count, latency, deadline or service resource limit was relaxed.
- The [reviewed bounded production inspector revision 02](release-evidence/release-297/release-gate-policy-20261003/production-metadata-inspector02-preparation.json) passes 18 Node, 23 PowerShell, nine mocked orchestration, 13 native SQL and two exact-serving-image offline cases. It adds metadata-only health-sentinel layout, public-schema USAGE and runtime DML/sequence checks. Plan `90304b10360df6cc8d01b60cb1ccc9bcb29776e17d211d23243b14e741ea0d32` performed only AWS metadata reads. No inspector task or production SQL was executed; actual catalog/roles and separate exact-plan/window authorization remain required. The first inspector bundle/plan stay historical and unchanged.
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
- Fresh CI at `72578c05` exposed a test journal-reader sharing violation while its supervisor owned the append handle. The [focused Windows regression](release-evidence/release-297/release-gate-policy-20261003/aws-journal-reader-sharing-regression.json) proves the preceding reader fails, the shared reader returns identical retained records, and malformed/partial/hash/sequence errors still reject. The full safety lane subsequently passes in the current dd6 checkpoint; later heads/main still require CI. This correction changes only its test reader.
- The [screenshot test-fixture regression](release-evidence/release-297/release-gate-policy-20261003/screenshot-fixture-abi-regression.json) restores dispatch by the unchanged Redis command argument contract instead of a removed Lua implementation literal. Native Redis behavior remains separately tested. [Report browser cancellation](release-evidence/release-297/release-gate-policy-20261003/report-export-browser-cancellation.json) passes all ten cases; a test-loader variant removing the actual failure-handler abort is rejected even after login navigation. The original network cancellation, no-download and UI assertions remain. Both corrections affect tests only and are covered by the current dd6 CI checkpoint; later review heads and resulting main still require CI.
- [Three candidate sole-school runs](release-evidence/release-297/release-gate-policy-20261003/sole-f8af7-completed-failed.json) pass all 798 offers at p95 44–54 ms and 22–25% API CPU, but the strict paired comparison is unaccepted because every baseline misses its absolute latency limit and A/A controls fail stability. [The 34/s comparison](release-evidence/release-297/release-gate-policy-20261003/normal-f8af7-incomplete-failed-summary.json) stopped after its failed baseline; no host cause is established.
- The [historical capability-on 34/s run on helper 6afc8](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-6afc8-summary.json) passes all 2,040 offers, exact recipient/persistence checks, p95 about 309 ms and 54.2% API CPU. The earlier [f8 helper run](release-evidence/release-297/release-gate-policy-20261003/classroom-normal-f8af7-summary.json) also passed at about 118 ms and 51% CPU; neither substitutes for three continuous mixed runs or a production-capability dark comparison. At that checkpoint both remained pending. The fresh mixed block now passes above; the dark comparison and separate Usage campaign remain pending.
- The [first continuous mixed block remains failed](release-evidence/release-297/release-gate-policy-20261003/classroom-mixed-6afc8-failed-held.json): two unchanged attempts completed all declared heartbeat offers and cleaned up normally, but mandatory classroom checks failed because the positive fixture also targeted the idle synthetic school. The third attempt was held before reservation. The server correctly refused controls after that school's signal expired. The new harness revision must derive positive recipients from the declared active clients while retaining foreign-school checks; these failed attempts cannot count toward the required three passes.
- The [fresh October 4 fixture and restricted restoration](release-evidence/release-297/release-gate-policy-20261003/usage-oct4-snapshot-preparation.json) pass preparation checks with two million observations, the exact application, 54 migrations and 129 RLS tables. Its authority expires at 11:12:21 Eastern on October 4. The [October 3 preparation](release-evidence/release-297/release-gate-policy-20261003/usage-oct3-snapshot-preparation.json) and failed October 4 CLI-discovery attempt remain unchanged. Fixture preparation does not establish capacity acceptance.
- The [earlier actual-services staging attempt remains failed overall](release-evidence/release-297/release-gate-policy-20261003/staging128129-partial-05.json). Its 128-admission bridge verifies legacy WebSocket delivery/ACK, announcements, real worker appointment maintenance, zero lifecycle adoption and both service SQL drains. That attempt did not establish 129 adoption/fallback: the synthetic client lacked a real authenticated heartbeat support record. Its failure remains preserved alongside the fresh passing rehearsal above.
- The [next staging attempt](release-evidence/release-297/release-gate-policy-20261003/staging128129-failed-06.json) reached an authenticated heartbeat but failed its shared snapshot lookup. The [native Redis diagnostic](release-evidence/release-297/release-gate-policy-20261003/realtime-native-regression-ed026.json) confirms pre-existing empty-array corruption and same-millisecond revision rounding in all three snapshot mutations. Its own cleanup-import failure is retained, so it is diagnostic evidence rather than accepted recovery. Narrow snapshot and health-monitor permission corrections are integrated and have native proof. Fresh candidate/fallback artifacts and classroom acceptance pass above; ed026 evidence remains historical.
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
  The [October 4 official public listing observation](release-evidence/release-297/release-gate-policy-20261003/public-store-version-20261004.json) still shows 2.9.6; pending submissions remain unverified. Both must be rechecked immediately before any authorized upload.
  Four [actual packaged-function retry checks](release-evidence/release-297/release-gate-policy-20261003/packaged-heartbeat-retry-297-summary.json)
  verify bounded 503 retries, Retry-After, retired-auth cancellation and in-flight
  heartbeat exclusion. No extension bytes changed; these are not browser capacity
  or managed-device results.

## Release profiles and acceptance

Keep both new Usage modes off. Use matching observed production capabilities,
logical fixture bindings and pinned runtime bases for black-box baseline/candidate
comparisons, retaining each source's own required schema and admission inventory.
An actual production image is preferred; a rebuilt baseline is a source comparison.

The operator's supported-load direction narrows this release to DeSales's 133
clients and selects a separately measured heartbeat/staff-read envelope with
headroom. The original 340-client/34-per-second comparison and 100-per-second
overload profiles remain historical diagnostics; they are not claimed accepted.
The accepted three-run 250-client envelope above does not amend the comparative
numeric rules or establish a broader classroom/fleet limit.

For the current-school comparison, run two baseline controls and three alternating
pairs in the frozen order `A,A,A,B,B,A,A,B`, using the unchanged sole-133 profile:
133 clients/798 offers over 60 seconds all pinned to one API. Every offer must
succeed, with zero refused/late offers or observed acquisition failures,
independently correct persisted bindings and complete unforced drain.
Heartbeat p95 must be at most 500 ms;
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
health/catalog/history/flags/headroom/backups/schedules/window. The October 4 bounded
catalog inspection above is complete; any later freshness inspection needs its own
exact plan and operational-window authorization. The old production image cannot be
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
