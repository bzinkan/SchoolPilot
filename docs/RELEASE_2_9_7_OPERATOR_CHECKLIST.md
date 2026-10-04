# Coordinated SchoolPilot release and ClassPilot 2.9.7

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

Application `ed026513` passes 2,032 local unit tests without skips and all 20
reported CI checks. Its fresh local API/worker image has zero HIGH/CRITICAL scan
findings; the frontend is rebuilt and the 54-migration/129-table synthetic schema
is verified. Exact hashes and verification limits are in the [application record](release-evidence/release-297/release-gate-policy-20261003/application-correction-summary.json)
and [CI/package checkpoint](release-evidence/release-297/release-gate-policy-20261003/ready-checkpoint-ed026-20261004-01.json).
The corrected safe fallback passes its scan and [actual image recovery](release-evidence/release-297/release-gate-policy-20261003/recovery-ed026-6d1f3a7e-summary.json).
New paired/current-school acceptance and three continuous classroom runs remain
pending. Usage capacity has zero accepted runs and both new Usage modes remain off.
The owner is waiting to submit ClassPilot until preparation is complete.

## Historical preparation checkpoints

Historical October 3 checkpoint: **Usage capacity has no accepted passing run**.
The new [screenshot-reader implementation](release-evidence/release-297/usage-contention/heartbeat-screenshot-reader-implementation-01/manifest.json)
passes 2,012 unit tests, 95 owner-role and 95 restricted-role database tests,
four private-chat checks, and build/type/cast checks. The initial full-unit
failure and its test-only Windows newline correction remain preserved. All
application and native-test inputs are identical between the passing database
run and final unit run. The reader retains tenant isolation, separate database
snapshots, locks and final authority checks while reducing client round trips.
Its additive 54th migration is included in the [814844f3 candidate image](release-evidence/release-297/usage-contention/candidate-artifact-814844f3/manifest.json),
which passes the uncached build, pinned scan with zero findings and compatibility
checks. The [local recovery rehearsal](release-evidence/release-297/usage-contention/recovery54-814844f3-01/manifest.json)
passes candidate -> compatible fallback -> candidate, preserving all 54 migrations,
private-chat expiration and exact Focus cleanup. This is synthetic recovery,
not verification of the current production catalog or service-traffic rollback.

The first [registered candidate capacity attempt](release-evidence/release-297/usage-contention/capacity-8148-attempt-01/manifest.json)
on `814844f344a45159152415b0fb6d7027f05b093e` **fails**: 3,042/6,000
heartbeats succeed, 2,266 return 500, 692 are refused and 408 offers are late.
Reports pass 48/64; complete workers finish in 15.647/38.266 seconds. Independent
totals, coverage, tenant isolation and eight audited CSVs agree for the observations
actually persisted, but the classroom lifecycle fails. All owners drain and the
six exact containers plus PostgreSQL volume are verified absent. All 13 receipts,
the failed journal entry and the seed-only premeasurement abort remain preserved.
Fewer client queries did not establish capacity: the run also recorded increased
WAL waits and runtime pauses, whose causes are not yet isolated.

Final CI on 814844f3 passes 16/17 jobs and all three security workflows. The
remaining responsive-layout test race has a [test-only synchronization correction](release-evidence/release-297/usage-contention/frontend2-resize-814844f3-01/manifest.json)
with controlled red/green proof and all three targeted browser cases passing.
An unrelated local shard navigation-buffer failure is retained; new-head CI is
still required. Three consecutive accepted capacity runs and the original
comparison remain outstanding. No deployment green light is given.

A [subsequent same-source diagnostic](release-evidence/release-297/usage-contention/diagnostic-8148-pressure-01/manifest.json)
passes all 64 reports and finishes workers in 11.774/29.633 seconds, but only
4,334/6,000 heartbeats succeed. The classroom lifecycle times out after precise
acknowledgement; an aborted response fails API drain verification, so post-load
current-day/CSV correctness is not run. All fixture resources are removed.
Its extra resource sampler produces no samples due to a separately reproduced
AWK compatibility error. That diagnostic cannot establish a host cause or count
as an accepted capacity run. Usage throughput remains unresolved.

The preceding load-tested application is `e95a2b56476b1225434c1b0f3907db46c9d84fe3`.
Its [exact-URL domain-map correction](release-evidence/release-297/usage-contention/domain-map-implementation-e95a2b56/manifest.json)
normalizes repeated URLs once per student while preserving per-observation
classification, timing, tenant scope and atomic writes. Final local checks pass
1,906 unit tests, 25 owner-role and 12 restricted-role native tests, all without
skips, plus build/type/cast checks. All 1,243 captured source files stayed
byte-identical across verification. The measured repeated-URL grain component
improves by 36–39%; the all-distinct normalization kernel increases from 28.022
to 41.495 ms per 6,000 rows. Neither result establishes complete capacity.
The [fresh e95 image](release-evidence/release-297/usage-contention/candidate-artifact-e95a2b56/manifest.json)
passes its uncached build, pinned scan with zero findings and compatibility
checks. The e95 CI rollout clock probe failed; its [test-only correction](release-evidence/release-297/usage-contention/clock-minute-boundary-01/manifest.json)
passes local real-clock and deterministic boundary checks without changing
production deployment code. [Follow-up CI at `97dad081`](release-evidence/release-297/usage-contention/ci-97dad081-final-01/manifest.json)
passes all 17 CI jobs and three security workflows for this application.

The [combined e95 diagnostic](release-evidence/release-297/usage-contention/linux-role-combined-e95-01/manifest.json)
still fails capacity: 4,413 of 6,000 heartbeats succeeded, 949 failed and 638
were refused at the in-flight ceiling, with zero late offers. All 64 reports
passed; whole workers took 12.284 and 30.984 seconds. Independent totals,
coverage, tenant isolation and eight audited CSV checks passed. API CPU used
65.736 seconds over 67.377 elapsed seconds, with event-loop utilization 0.973;
950 acquisitions failed. The first classroom lock-screen request returned 500.
Its generic error log and one tenant-request acquisition failure are consistent
with contention, but do not prove that request's exact cause. Both owners drained,
all six containers were removed, and the recorded PostgreSQL volume was verified
absent. Zero capacity runs are accepted.

The [subsequent ingestion-only CPU diagnostic](release-evidence/release-297/usage-contention/linux-role-ingest-cpu-e95-01/manifest.json)
fails at 5,081/6,000 successful offers, 478 failures, 441 in-flight refusals and
zero late offers. API CPU is 68.140 seconds over a 68.523-second measurement
window. All owners drain and all six containers plus the recorded PostgreSQL
volume are removed. Three raw authority fences account for 1.905 seconds of
sampled construction work; that is not a throughput forecast. Bounded metadata
reuse and narrower heartbeat projections are under investigation. The earlier
zero-offer Redis namespace startup failure remains preserved separately.

The later [restored-fixture combined diagnostic](release-evidence/release-297/usage-contention/restored-combined-e95-01/manifest.json)
also fails: 4,730/6,000 successful heartbeats, 976 failures, 294 refusals, seven
late offers and 977 acquisition failures. All 64 reports pass; whole workers
take 13.987/30.616 seconds. Numeric/coverage/CSV checks pass but the classroom
lifecycle fails. Its actual 13 owner receipts and complete cleanup are retained.
The candidate validator needs the observed single-API preflight-drain shape
and strict 6,000 HTTP-200/persisted-observation agreement; the diagnostic is
not relabeled as accepted. The required passing-run count remains zero.

The [strict candidate harness](release-evidence/release-297/usage-contention/role-candidate-harness-01/manifest.json)
is committed at `0650decf` with 378 passing guard tests and no skips. It now
checks modern HTTP-200/capability/persistence agreement and actual preflight
gauges, and preserves every registered attempt. A three-file EOF-only follow-up
has separate hash/equivalence evidence. Candidate-mode execution is now verified
by the failed 814844f3 attempt above. Three accepted runs remain outstanding;
these harness checks do not establish capacity.

The preceding application was `b11202fc305198d76e73c5e6d711b7dc9ed2d938`.
Its [owned heartbeat SELECT preparation](release-evidence/release-297/usage-contention/heartbeat-prepared-reads-implementation-01/manifest.json)
passes 1,906 unit tests without skips, 50 owner and 50 restricted native tests,
four restricted private-chat cases, and build/type/cast checks. It caches query
metadata only, preserves fresh authority checks, and seals mandatory work before
delivery. The [final binding](release-evidence/release-297/usage-contention/heartbeat-prepared-reads-implementation-01/final-binding.json)
documents a whitespace-only cleanup with identical compiled JavaScript.
Its [fresh local candidate image](release-evidence/release-297/usage-contention/candidate-artifact-b11202fc/manifest.json)
passes an uncached build, a pinned scan with zero findings and embedded
compatibility checks. Full capacity acceptance remains blocked.
[CI's remaining inline-query assertion](release-evidence/release-297/usage-contention/runtime-entitlement-selector-followup-01/manifest.json)
is corrected with 27 focused passes and no application change. At review head
[`a109fd27`](release-evidence/release-297/usage-contention/ci-a109fd27-final-01/manifest.json), all 17 CI jobs and three security workflows pass, including
backend, frontend/browser, both database lanes and rollout-tool validation. The failed
earlier ordinary database job remains preserved.

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

The earlier
[candidate-default ingestion diagnostic](release-evidence/release-297/usage-contention/linux-role-ingest-candidate-default-0e427-01/manifest.json)
on `0e427e3c` failed at 5,116/6,000 successes; removing the test-only old-space
override did not resolve saturation. Runtime defaults do not prove live ECS
settings. The following paragraphs retain preceding checkpoint evidence.

Earlier development checkpoints are preserved verbatim in the
[preparation history](RELEASE_2_9_7_PREPARATION_HISTORY.md); their pending-work
statements do not override the current selections below.

## Agreed live-validation boundary

The owner approved 2.9.7 and explicitly replaced the two-managed-Chromebook
prerequisite with documented live validation. Record that prerequisite as
`waived_not_passed`, never as passed. This exception applies to precise resources
and Focus only and must bind the final source, serving image, extension identity,
ZIP hash and automated evidence. It does not waive confidentiality, authority,
recipient, enforcement, tenancy or deployment health checks.

## Current release selection and evidence

The prepared application artifact is bound to `ed026513`; later changes affect
harness/tests/documentation only. Selection for execution still requires accepted
release gates, final review-head and resulting-main checks, recovery and fresh
production verification. Historical images and failed campaigns remain intact.

| Item | Current selection / evidence limitation |
|---|---|
| SchoolPilot baseline | `996d965f0b044f8fc4d4bbc399c5ab3781fbac04`; origin/main remains separate from the open integration PR |
| Integration branch | `codex/release-stabilization-297`; [SchoolPilot #603](https://github.com/bzinkan/SchoolPilot/pull/603); preserve and later reconcile incorporated review branches |
| Application source / CI | `ed0265133d4a87fd3d2477dd90884535b749ee7d`; [all 20 reported checks pass](release-evidence/release-297/release-gate-policy-20261003/ready-checkpoint-ed026-20261004-01.json). Later harness/documentation heads need fresh CI; approved resulting main needs its own checks and application equivalence proof. |
| Current correction / local checks | [2,032 unit passes, no skips](release-evidence/release-297/release-gate-policy-20261003/application-correction-summary.json). Bounded Usage heartbeat admission, pool fairness, delta rollup writes and tenant-owned atomic cleanup/audit are included. |
| Local API / worker candidate | Fresh ed026 image: index `sha256:ba6959ee552da2882eed57b857d026fc2c8fa1dc00ea79d67f6a000b4534d63f`, amd64 manifest `sha256:1edf606c00d4abd931745449bb0b2d65770f424f80ba9e46f391d7c9718ca72d`. Pinned scanner reports zero HIGH/CRITICAL findings, including unfixed. Local preparation is not registry publication, a deployed task pair or release approval. |
| Compatible fallback | `6d1f3a7e737ebd2e3e266f2f571cdea811db5e27`; [focused/native checks and zero-finding scan pass](release-evidence/release-297/release-gate-policy-20261003/safe-fallback-6d1f3a7e-summary.json). Local image index `sha256:f010658f7d38448f65e248b99437fad79a05fad86a90a42667ef28732767c387`, amd64 manifest `sha256:e9980ae29fab107c2be86386059d35f180449cf85901ea832d911b9aef543114`. Both new Usage modes must remain off. The old production image is invalid after lifecycle adoption. |
| Schema / recovery | [Actual candidate → safe fallback → candidate recovery passes](release-evidence/release-297/release-gate-policy-20261003/recovery-ed026-6d1f3a7e-summary.json): all 54 ledger entries, screenshot function body/ACL, chat expiration/history and exact Focus cleanup retained. Five containers and one volume removed gracefully. This is synthetic restricted-role image-function recovery; production catalog/data, Redis/browser delivery and service-traffic rollback remain separate. |
| Frontend | Fresh ed026 lint/build artifact SHA-256 `7a262bf6704928194ec43cc9da0523084a935a24a040c4de20b2c7a06c321675`. All four frontend release CI shards pass for the application. No frontend was published. |
| ClassPilot integration / CI | [ClassPilot #123](https://github.com/bzinkan/ClassPilot/pull/123), #119 → #120 → #121 → #122 ancestry. Documentation-only head `8069a9c9bd50352e187847158b356a69edc4e45d` has all 10 checks passing, including Chrome 120/133/152/stable. PR remains open/draft. |
| Extension identity / package | `iggbfegfcjkfieoemeolfmfnapepalca`; version 2.9.7; packaged source `065be165b5df704d84eb716e3fb914c1fed17f98`; ZIP SHA-256 `82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`. Unchanged 24-file verification passes; copy is at C:/GitHub/ClassPilot/dist/ClassPilot-v2.9.7.zip. |
| Heartbeat retry compatibility | [Four packaged-function controls pass](release-evidence/release-297/release-gate-policy-20261003/packaged-heartbeat-retry-297-summary.json): heartbeat retries at most twice, honors 503 Retry-After, cancels retired auth and excludes overlapping heartbeats. No ZIP bytes changed. |
| Store state | Last public observation: 2.9.6, updated September 27. Pending developer submissions remain unverified. Repeat both checks immediately before separately authorized upload; submission is held. |
| Release capacity | Paired sole-school/34-per-second comparison and three continuous 15-minute mixed-classroom passes are pending. Real-image preparation smokes and [37 harness checks](release-evidence/release-297/release-gate-policy-20261003/harness-frozen-44c1932f-summary.json) are preparation-only. Original single-task 100/s failures remain diagnostic failures. |
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

## Acceptance before an operator green light

- Run backend build/type checks, test type/cast ratchets, unit, ordinary database,
  restricted-role RLS, infrastructure and governed runtime suites on final source.
  Run complete migration tests against the converged schema as well as the
  ordinary CI fixture. Distinguish fixture setup failures from product failures.
- Run all four frontend release shards and the aggregate release command,
  including Classroom coverage, frontend build and lint. Preserve assertions;
  PDF failures must be repaired rather than skipped.
- Prove frozen dialog recipients, loss of selection, signed-out Select All,
  offline Stop Focus with issuance off, authority changes, partial failures,
  exact tab references, duplicate URLs and restriction-before-lesson ordering.
- Prove Attention preserves pages while school/precise restrictions remain;
  title-only changes do not invalidate Focus; URL/replacement/closure do.
- Prove private close/send/off/claim/ACK races using real database locks,
  authoritative reconnect, worker restart, reclaims and student binding changes.
  Delivered history remains; expired pending replies never revive. Announcements
  work during private hard-off. Unsupported clients show an update requirement.
- Verify retained-override confidentiality with Rules on/off, all public response
  paths and exports, current/historical authorization, atomic appointments,
  capacity/cancel races, timezone boundaries and reports/CSV denominators and audit.
- Run source and exact-ZIP checks across the existing supported Chrome matrix,
  including pages already open across an update. Record source, manifest version,
  extension ID, ZIP hash and actual outcomes together.
- Require the [amended release gates](RELEASE_297_DEPLOY_READINESS.md): paired
  production-source/candidate checks with both new Usage modes off, current-school
  mixed classroom checks with the three new capabilities on, and compatible
  recovery/artifact evidence on final source. Preserve every failed attempt.
- Before either new Usage mode is activated, separately complete the declared
  three-API/shared-database campaign: three consecutive cold passes, two schools,
  one million stored observations each, 6,000 offers at 100/second fleet-wide,
  all 64 reports plus distinct-report checks, workers within 48 seconds, full
  correctness/drain and no acquisition or statement-deadline failures. Complete
  three-to-two sticky-client survival before claiming broader capacity. The
  historical single-task comparison stays diagnostic, with its failures intact.

Owner-adopted release decision, October 3, 2026:

> SchoolPilot/ClassPilot 2.9.7 may proceed with both new Usage modes off after passing final-source regression, classroom, current-school capacity and recovery checks. Usage activation requires its separate completed development, synthetic capacity acceptance and deployed observation. Historical single-task 100-heartbeat/second failures remain preserved and are not reclassified as passes.

Deployed daily-shadow/new-rollup observation still gates later reporting
activation. A failed confidentiality, authority, recipient, enforcement or
recovery check always blocks the affected release.

## Read actual production before execution

The read-only October 2 snapshot found API 3/3 on
`schoolpilot-production-api-emergency:163`, worker 1/1 on
`schoolpilot-production-scheduler-worker:179`, both at source
`7af9d0dd5bc2bd3e13b96d35a577725e07f8b678` and image
`sha256:c87433cdf3d88e0c291a50d1ae74fbc116f167048f7db9d6c2d1d0ebfc52b9e8`.
Both had GUC enabled and 121 admitted tables. That image is not the compatible
rollback target after private lifecycle adoption. RDS reported available with
14-day backup retention and a recent restorable time; that is not restore-test
evidence. Re-read everything below at execution time.

```powershell
git fetch origin main
git status --porcelain
git rev-parse HEAD origin/main
aws ecs describe-services --cluster schoolpilot-production-cluster --services schoolpilot-production-api schoolpilot-production-scheduler-worker
aws rds describe-db-instances --db-instance-identifier schoolpilot-production-db --query 'DBInstances[0].{Status:DBInstanceStatus,BackupRetentionDays:BackupRetentionPeriod,LatestRestorableTime:LatestRestorableTime,DeletionProtection:DeletionProtection}'
```

Resolve each task definition from the service response; record its digest,
`GIT_SHA`, GUC/admission, capability registry, product flags, network configuration,
desired/running/pending counts and deployment status. Inspect target health,
`/readyz`, recent errors, worker health and CPU/memory/database connection/storage
headroom. The public website's `/readyz` can return the frontend HTML with status
200; that is not a readiness result. Confirm the ALB uses `/readyz` and inspect
its target states. For a task-specific readiness fetch, use the verified API
origin through the existing permitted network path and require HTTP 200,
`application/json`, parsed `{ "status": "ok" }` and `Cache-Control: no-store`.
Do not open origin access to make this check pass. The October 2 workstation
could read public `/health` but could not directly reach origin readiness; the
ALB reported three healthy targets against `/readyz`. Record that limitation,
not an independently fetched readiness body. Record backup readiness and a specific approved America/New_York
operational interval. Do not infer permission from an old freeze note. Retain the
weekday 04:45–05:59 deployment safeguards and public-ECS/no-NAT configuration.

Check the public Store listing **and the developer dashboard's publication and
pending-submission state** immediately before upload. If a higher version prevents
2.9.7, stop and report it. Publication does not prove client installation.

## Migration and deployment order

Image preparation does not require merging. Build and scan a local candidate
from the frozen review source, bind its image/archive hashes, and rehearse the
additive migrations plus compatible rollback re-entry locally. Keep those proofs
distinct from registry publication and production task-definition bindings.
Before execution, reconcile the artifact source with approved merged main and
passing checks; if the merge changes application bytes, regenerate affected
artifacts and acceptance. The prepared rollback image is local only: no ECR
publication or live task-definition compatibility is established by its synthetic
release-floor proof. Keep both Usage modes off when using that rollback source.

Use a separate clean main worktree after the integration PR is reviewed and
merged; original checkouts and draft Observe work remain untouched. Main must
match origin and required CI must pass. Use the documented `scripts/deploy.sh`
procedure; no hand-edited task definitions. The immutable-image workflow is
opt-in and currently disabled. Keep `IMMUTABLE_RELEASE_IMAGE_ENABLED` disabled
until the `release-image` environment, `AWS_RELEASE_IMAGE_ROLE_ARN` and
repository-scoped GitHub OIDC trust are provisioned and verified. While disabled,
use the deploy script's guarded legacy build path and record its resolved source
SHA and digest. Do not enable the flag merely to obtain a green workflow. An
enabled immutable path supplies both `--immutable-image-sha` and
`--immutable-image-digest` for the exact green image. The legacy path rebuilds;
verify and scan that exact resulting image before execution rather than treating
the prepared local image's scan as proof for different bytes.

Reconcile the live catalog and migration ledger before forming admission plans.
The [read-only access feasibility record](release-evidence/release-297/usage-contention/production-schema-read-feasibility.json)
establishes that this workstation had no verified existing path to obtain the
full private production catalog and ledger. A separately authorized bounded
inspection task, or an operator export through an approved existing path, is
required. The [locally validated bounded inspector](release-evidence/release-297/usage-contention/production-metadata-inspector/index.json) now has a concrete read-only plan: external `release297-production-metadata-plan-01/plan.json`, SHA-256 `b883e407163ec798fb7ae6cdf58ab2aaf20a8751e03a9d60d7fda4a13431c604`. Preparation verified syntax, 32 local cases across mock orchestration and native SQL, and the exact serving image offline. Plan performed only AWS metadata reads; no task or production database query was executed. Separate approval of the exact plan and operational window is required. Its catalog fingerprints, full ledger and fixed-domain pilot lookup are not a restorable schema export. Do not substitute the reconstructed local rehearsal for that evidence
or derive school UUIDs from a name/domain screenshot. Verify the named DeSales
school's UUID, domain and current licensing/eligibility through authorized
production reads before generating any pilot plan.
Preserve all historical inventory entries and migration checksums. From the
observed 121-table baseline, the missing reviewed bundles are:

| Order | Exact `--enable-rls-table` argument | Resulting table count |
|---|---|---|
| 1 | `passpilot_destination_policies,passpilot_pass_limits,passpilot_encounter_restrictions,passpilot_pass_denials` | 125 |
| 2 | `classpilot_usage_rollups` | 126 |
| 3 | `classpilot_usage_rollup_days` | 127 |
| 4 | `passpilot_appointments` | 128 |
| 5 | `classpilot_private_chat_threads` | 129 |

Registry bundle names are labels, not CLI aliases. Preserve the exact ordered
CSV above. These are expected deltas, not permission to repeat an already-admitted bundle.
The tool accepts one reviewed bundle per operation; re-read both services between
operations. First deploy and fully drain to the compatible dark writer/bridge/relay
while the private lifecycle capability remains off and the thread table is not
yet admitted. In this reversible stage, unadopted schools create no private
thread/token/generation state and have no permanent-expiration guarantee yet.
Then admit the final thread bundle only when both exact rollback source images
contain the compatible writer, bridge and relay. The final admission is
`classpilotPrivateChatLifecyclePostExpand`; require identical full admission on
API and worker before capability activation. Run additive migrations using the
candidate's exact image before service rollout. Verify health and admission before
publishing the frontend. Do not shrink admission on rollback.

The screenshot-reader candidate adds the immutable
`classpilot-heartbeat-screenshot-evidence-v1-20261003` migration, bringing its full
ledger to 54 entries without changing the 129-table inventory. The API verifies
the exact `public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text)`
body, invoker execution, volatility, search path and scoped EXECUTE permission
through its actual runtime credential before serving. PUBLIC EXECUTE must remain
revoked. The supported migration task uses the API credential; a distinct
runtime role must have its exact grant verified rather than inferred. The local
fixture CLI is prohibited in production. Preserve this additive function and
the historical migration during compatible rollback; the final candidate/image
recovery rehearsal must include the 54-entry schema.

Private lifecycle adoption is a durable compatibility floor. Once admitted,
capability off does not permit a legacy writer or removal of its migration/table.
Prepare a known-good compatible containment/rollback image before activation;
retain it while any offline cleanup is unresolved. The deploy guard verifies each
source image digest against its exact source SHA, the compatible writer/bridge/relay
and full candidate admission. A failed partial rollout retains that compatible
source pair; the original pre-release image is not a lifecycle rollback target.
Compatibility must also include the receiving Redis lifecycle fence
(`PRIVATE_CHAT_RELAY_VERSION = 1`). Writer/bridge markers alone do not establish
that delayed replies are safe. Serving candidates and rollback projections must
retain this fence even with private issuance disabled.

## Runtime and Store sequence

1. Verify the dark compatible API/worker pair, completed migrations and admission;
   publish the matched frontend after health checks pass. Refresh participating
   teachers' already-open SchoolPilot dashboards and verify the served frontend
   assets belong to the release before activating the new chat lifecycle.
   Publishing new assets does not replace JavaScript already running in a tab.
2. Release Library, corrected Rules, appointments and Reports v2 independently
   using `scripts/deploy-product-runtime-config.ps1` Plan → reviewed Apply → verify.
   Respect each mode's authorization, schema and readiness checks. Keep both
   Usage rollup/reporting activation paths off pending their separate evidence.
3. Upload only the independently verified ClassPilot 2.9.7 ZIP. Recheck Store
   state immediately beforehand and preserve the exact uploaded bytes/hash.
4. Confirm participating clients report the installed 2.9.7 version, correct
   extension identity and accepted capabilities. Do not infer support from a
   version string alone or silently route unsupported recipients through an older
   private-chat path. For pages left open during an update, verify the content
   script owner actually changed. Native 2.9.6 upgrade tests require a safe manual
   page reload fallback; do not label that seamless adoption or enable controls
   against stale pages.
5. Use `scripts/deploy-classpilot-runtime-config.ps1` to prepare pilot profiles
   for the verified St. Francis DeSales, Cincinnati school UUID. Confirm its
   `desalescincy.org` identity and eligibility; do not use either synthetic load
   school or guess a UUID. Bind precise/Focus waiver receipts to the exact reviewed
   source, image and ZIP. Enable all three pilots below and let the final
   API/worker pair converge before starting combined classroom acceptance.
   Pilot and global promotion are separate operations.
6. Complete the full live checklist below before **any** global promotion, then
   promote one capability from the actual current-school pilot and its evidence.
   Each Apply changes the task definitions/runtime fingerprint and invalidates
   the prior pair's receipt for subsequent promotion. After convergence, collect
   a fresh qualifying observation window and receipt before the next promotion;
   repeat for the third. Do not relabel earlier samples or copy their timestamps.
   Global availability
   includes future eligible schools; licensing and negotiated client capabilities
   remain mandatory. Observe is not activated by these profiles.

Use governed JSON configurations for Library (`CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE`),
Rules (`PASSPILOT_RULES_MODE`), appointments (`PASSPILOT_APPOINTMENTS_MODE`) and
Reports (`PASSPILOT_REPORTS_MODE=v2`). Never set capabilities or RLS through the
product setter. Generate exact plan manifests only after source/image/serving
state is final; stale plans must be regenerated.

| Capability | Current-school profile | Later global profile |
|---|---|---|
| Private chat lifecycle | `private-chat-lifecycle-pilot` | `private-chat-lifecycle-global-on` |
| Precise restrictions | `precise-restriction-resources-pilot` | `precise-restriction-resources-global-on` |
| Focus | `focus-tab-pilot` | `focus-tab-global-on` |

Each pilot profile is `{"schemaVersion":7,"mode":"<pilot profile>","pilotSchoolId":"<verified DeSales school UUID>"}`.
Its global successor is `{"schemaVersion":7,"mode":"<global profile>"}` and
must omit `pilotSchoolId`. There is no combined global profile or generic unpin
bypass for these capabilities. Each promotion receipt requires at least 30
minutes of positive, sample-bearing observations on its exact current pair,
reviewed within 30 minutes after the window and fresh within two hours at
Plan/Apply. The supported sequential process therefore needs at least three
qualifying observation windows, including the initial full classroom window.
All three pilots must pass the combined user acceptance gate before the first
promotion, even though a per-capability receipt only enforces its own categories.

Require the existing protocol-v3 and repaired-capability prerequisites. Private
lifecycle also requires global student-chat idempotency and the full 129-table
writer/bridge/relay floor. Precise/Focus Plan takes release evidence, production
confirmation and the managed-validation waiver; their global profiles also take
fresh pilot evidence. Private global takes pilot evidence and production
confirmation, without the precise/Focus waiver. Apply consumes the plan-bound
copies; do not substitute evidence files after review.

Product configurations use exactly `{"schemaVersion":1,"environment":{...}}`.
Values below are strings except JSON `null`; omitted names retain live values.
Keep each independent change in a separate reviewed configuration.

| Product change | Exact environment entries |
|---|---|
| Library current-school pilot | `CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE: "on"`, `CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: "<current-school UUID>"` |
| Library global availability after its acceptance | `CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS: null` with mode already `on` |
| Corrected Rules | `PASSPILOT_RULES_MODE: "on"` |
| Appointments | `PASSPILOT_APPOINTMENTS_MODE: "on"` |
| Reports | `PASSPILOT_REPORTS_MODE: "v2"` |

Appointments require the preserved admission, writer-v2/grant checks and a
configured school year; Reports require report-v2 and authority-fence-v1 serving
support. The product tool uses `-Action`, `-ConfigPath`, `-OutDir` and Apply's
`-ManifestHash`. The capability tool uses `-Operation`, `-ProfilePath`,
`-ExternalEvidenceRoot` and Apply's `-ExpectedPlanSha256`. Use their documented
exact-source/image/task-definition and confirmation parameters; these are not
interchangeable CLI contracts and this table is not an approved production plan.

## Independent product live checks

Use approved sample records in the verified DeSales school. Record timestamps, roles,
opaque record IDs, actual outcomes and evidence hashes privately. Release each
feature through its own governed gate; the classroom pilot does not certify it.
Do not place real student identities or confidential test content in public PRs.

| Feature | Required observed outcomes |
|---|---|
| Library | Exercise a Flight Path and Block List: another teacher cannot see a private original; after sharing, they can apply it and make a private copy, but cannot edit the original. Verify the administrator Official transition and that an administrator cannot publish another teacher's private item. |
| Rules and confidentiality | Observe limit/capacity and encounter denials plus an authorized administrator override. Teacher and office override attempts fail. Verify retained overridden passes, reads and returns omit encounter metadata for teacher, office and kiosk in both governed Rules-on and Rules-off states, while authorized administrator evidence remains available. |
| Appointments | Verify PassPilot-only school-year setup, manager create/edit/cancel, current-teacher reminders and manual activation. Duplicate activation links the same pass; explicit return completes the appointment, overdue remains open and an unused window becomes missed without issuance. An unauthorized teacher cannot read or activate it. Notes are visible to current school managers, including authorized office staff, omitted from teacher DTOs and never copied to the linked pass. |
| Reports v2 | With teacher, office and administrator roles, compare a known authorized filtered cohort to its CSV and committed export audit. Verify completed-overdue and currently-overdue counts separately, retained-only coverage, exact filters and formula-safe cells. Teacher/office reporting must omit encounter override evidence; permitted administrator audit access remains. Appointment note access follows its separate manager contract. |

## Classroom live acceptance record

Bind the record to the verified DeSales school UUID and `desalescincy.org` before
selecting any live recipients. Record start/end timestamps, school, exact API/worker task definitions, image and
source, runtime fingerprints, extension source/version/ID/ZIP and participating
opaque student bindings in private evidence. Do not place student identities or
message content in a public PR. Observe for **at least 30 minutes with actual
samples** and record successes/failures per selected student.

| Exercise | Evidence of success |
|---|---|
| Sign-in and selection | Correct student binding; signed-out students excluded from immediate Select All; dialog audience stays frozen through roster changes |
| Attention on/off | Existing pages survive; overlay clears; school and precise restrictions still apply; valid prior Focus resumes only for its original target |
| Precise / lesson opening | Reviewed resource boundary enforced; failed installation retains previous valid policy; only confirmed students open the lesson |
| Focus / Bring Forward / Stop | Exact referenced tab; title-only change succeeds; URL/replacement stale reference refused; offline Stop Focus remains available with issuance off |
| Private chat close/off | Pending replies expire; reopening/on does not revive them; fresh messages require current thread/epochs; delivered history retained |
| Announcements | Actual announcement delivery while private messaging is off, independent of private expiration |
| Reconnect and cleanup | Worker restart, browser reconnect, sign-out/student change and end-session preserve authority and remove only intended state |
| Health | Sample-bearing API/worker/database/roster health throughout; no wrong recipient, broadened scope, authority leak or revived message |

A successful HTTP response alone is insufficient. Global promotion requires the
actual accepted effects, exact recipient bindings and complete lifecycle samples.
Usage separately requires three clean deployed shadow school days and then one
full school day of rollup observation before reporting activation. Preserve
unavailable/partial/live/final coverage; measured zero means no browser activity
observed, not zero device use.

## Containment and completion

On a wrong recipient, authority leak, broadened restriction, revived expired
message, failed cleanup or unhealthy rollout: stop new issuance, contain the
affected feature and perform exact-bound cleanup. Keep compatible serving
artifacts available while offline cleanup remains unresolved. Stop Focus clears
only Focus. Precise rollback is disable → clear incompatible persisted resources
→ compatible image. Usage rollback below its correction requires both modes off
and coverage invalidation before reuse. Never delete migrations or audit history.

Prepare an extension repair/revert as a higher version, normally 2.9.8. Uploading
2.9.6 does not downgrade installed 2.9.7 clients. Separately identify any locally
installed provisional 2.10.0 copies; 2.9.7 does not update those by version order.

Completion requires reconciled PR dispositions, exact immutable artifacts and
automated evidence, actual deployment and live-validation records, and the final
activated profile state. Keep implemented, tested, packaged, deployed and
activated distinct. SFU implementation, TURN changes, paid provisioning, legacy
deletion and unrelated Observe work remain outside this release.

Sources: [Store listing](https://chromewebstore.google.com/detail/classpilot/iggbfegfcjkfieoemeolfmfnapepalca),
[Chrome update lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle),
[Chrome version ordering](https://developer.chrome.com/docs/extensions/reference/manifest/version).
