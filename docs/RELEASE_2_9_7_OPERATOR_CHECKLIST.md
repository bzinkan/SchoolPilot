# Coordinated SchoolPilot release and ClassPilot 2.9.7

Status: release stabilization and capacity acceptance in progress. No deployment green
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

The latest [owned inbox correction](release-evidence/release-297/usage-contention/heartbeat-owned-inbox/manifest.json)
reuses the final heartbeat tenant connection without removing the locked inbox
eligibility check. Expiry uses the database's current clock after foreground
delivery; process-local suppression updates only after commit and connection
cleanup. Forty-eight focused cases and 19 native cases under each database role
pass, including durable claim rollback and preservation of required preparation
writes. The load gate requires zero optional inbox failures. This reduces an
equivalent recovery from 33 to 27 SQL statements and two connections to one;
it is not capacity acceptance. The new combined load run remains required.

[Combined checks11](release-evidence/release-297/usage-contention/combined-checks-attempt-11/manifest.json)
pass the build and 699 infrastructure cases; four unit VM-context failures are
retained. The [test-only follow-up12](release-evidence/release-297/usage-contention/combined-checks-attempt-12/manifest.json)
passes types/casts and 1,823 unit cases, with four named conditional skips.
The comparison proves the two changed tests do not alter the application or any
of the 60 infrastructure-selected files and their selector. Final-source capacity
and fresh remote CI remain required.

The owner approved 2.9.7 and explicitly replaced the two-managed-Chromebook
prerequisite with documented live validation. Record that prerequisite as
`waived_not_passed`, never as passed. This exception applies to precise resources
and Focus only and must bind the final source, serving image, extension identity,
ZIP hash and automated evidence. It does not waive confidentiality, authority,
recipient, enforcement, tenancy or deployment health checks.

## Release identities and evidence

| Item | Required record / current state |
|---|---|
| SchoolPilot baseline | `996d965f0b044f8fc4d4bbc399c5ab3781fbac04`, freshly fetched October 2, 2026 |
| Integration branch | `codex/release-stabilization-297`; [SchoolPilot #603](https://github.com/bzinkan/SchoolPilot/pull/603), preserve original review branches |
| ClassPilot lineage | #119 → #120 → #121 → #122, consolidated with stabilization in [ClassPilot #123](https://github.com/bzinkan/ClassPilot/pull/123) |
| Extension identity | `iggbfegfcjkfieoemeolfmfnapepalca`; version 2.9.7 |
| Public Store observation | October 2 public listing: 2.9.6, updated September 27. Pending developer submissions are not established by a public listing. |
| Remote review source / CI | [Completed CI at `bcb2b33c`](release-evidence/release-297/usage-contention/ci-bcb2b33c.json) has 15 successful jobs, including all frontend shards/build, restricted-role isolation and AWS rollout safety; Gitleaks, Trivy and CodeQL pass. The backend infrastructure selector and four ordinary-database PassPilot fixtures fail. The [Docker selector correction](release-evidence/release-297/usage-contention/deploy-docker-selector-followup/manifest.json) passes 147 local tests; the [midnight fixture correction](release-evidence/release-297/usage-contention/passpilot-midnight-fixture/manifest.json) passes 19 full-suite and five exact-midnight replay cases. New-head and approved merged-main checks remain required. |
| Current contention correction / local checks | [Combined09](release-evidence/release-297/usage-contention/combined-checks-attempt-09/manifest.json) passed the application build and all 672 infrastructure tests, preserving failed stale-selector and test-typing checks. [Combined10](release-evidence/release-297/usage-contention/combined-checks-attempt-10/manifest.json) passes type/cast checks and 1,801 unit cases, with zero failures and four named conditional skips. Application bytes and infrastructure inputs are unchanged across that test-only repair. [Heartbeat foreground fusion](release-evidence/release-297/usage-contention/heartbeat-foreground-fusion/manifest.json) passes 23 owner and 23 restricted-role cases plus 40 focused checks. New-head CI and concurrent capacity remain required. |
| API / worker artifacts | Final corrected candidate rebuild remains pending. Rollback `5c01944ed1afb4241e270469c6477121bf48cd84` includes the [mandatory final heartbeat expiry fence](release-evidence/release-297/usage-contention/rollback-heartbeat-fence/manifest.json). Its [uncached local image](release-evidence/release-297/usage-contention/rollback-artifact-5c01944e/index.json) has zero pinned-Trivy findings and verified 129-table admission, lifecycle writer1/bridge1/relay1 and both Usage modes off. Image index: `sha256:64894a414707c58ac413c60d9c4bf7133466272c5423e50296bc4d88b9292ee2`; Linux/amd64: `sha256:269bfbc07e0f76adc79604b7a45ab18623dc7b9e2d6c77d913a696adb995de38`; export SHA-256: `ad8e6839d4afdb85a9171fcc27b499b60487603d0a2a0e7fef0e3806bfb22060`. Final candidate → rollback → candidate rehearsal, registry identities and task bindings remain separate. |
| Migration rehearsal | [Reconstructed-baseline rehearsal at `0431f043`](release-evidence/release-297/usage-contention/rehearsal-0431-faf5275c/index.json) passed baseline → candidate → patched `faf5275c` rollback → candidate, retaining 53 migration IDs and 129 tenant tables. The baseline had already applied the staff-identity contract; the explicit-flag step was idempotent re-entry. Actual production catalog/ledger verification, populated RLS checks and reconciliation with any later candidate source remain separate. Earlier rehearsal records are preserved. |
| Extension candidate source | `065be165b5df704d84eb716e3fb914c1fed17f98`; reviewed candidate, not an asserted merge or publication |
| Extension ZIP | `82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`; 24-file verifier passed; full native/package/Chrome acceptance recorded separately |
| Extension review-head CI | Documentation-only head `8069a9c9bd50352e187847158b356a69edc4e45d`: [reconciled read-only check](release-evidence/release-297/usage-contention/extension-ci-reconciled-20261003.json) records all 10 checks successful and GitHub `CLEAN`. The [previously cancelled sibling run](https://github.com/bzinkan/ClassPilot/actions/runs/37048477885) passed on rerun, including Chrome 120, 133, 152 and stable. The PR remains open/draft. [Source/ZIP reverification](release-evidence/release-297/usage-contention/extension-reverification.json) confirms unchanged packaged bytes; CI is not publication or live acceptance. |
| Frontend aggregate | [Current frontend source-bound evidence](release-evidence/release-297/usage-contention/frontend-final-source.json): 739 Node-runner cases passed with zero skips, plus direct browser scripts; build and lint passed with 29 existing lint warnings. Artifact SHA-256 `7fc1c93fc9b861cb4db299c6bbf5686f7cd4e71dc9689e2327983c172c41110f`. Reconcile its recorded frontend blobs with the eventual final release commit; this does not certify later backend changes. |
| Live pilot / validation | User confirmed St. Francis DeSales, Cincinnati (`desalescincy.org`), with 133 students, three administrators and nine teachers shown in the supplied screenshot. Production school UUID and current eligibility remain unverified. Live validation has not started; minimum 30 minutes with nonzero samples for every required lifecycle category. |
| Usage capacity | Held off. [Combined08 at ff6b4c96](release-evidence/release-297/usage-contention/load-combined-08/manifest.json) failed: 2,692/6,000 heartbeat successes, 26/64 reports, 3,008 acquisition failures, zero optional telemetry failures and zero late offers. Historical workers returned correct totals in 17.881/41.721 seconds. Eleven aborted responses prevented drain certification; forced termination and absent current-day/CSV checks remain explicit. The subsequent [ingestion-only CPU diagnostic at bcb2b33c](release-evidence/release-297/usage-contention/ingest-cpu-bcb2b33c-01/manifest.json) drains cleanly but fails: 5,148 successes, 232 failed requests, 620 refused offers and 232 acquisition failures. Its API uses 82.062 CPU seconds during the 67.879-second phase. Profiling does not establish capacity. Three consecutive final-source combined passes and the comparison rerun remain pending. Both workload schools are synthetic; DeSales is the only live school. |
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
- Require three consecutive cold, release-enabled final-source/schema runs
  before requesting release execution. Every complete worker operation must
  finish within 48 seconds at the unchanged 60-second limit. Use two schools,
  one million stored observations per school, all 64 concurrent reports across
  four waves, and all 6,000 authenticated offers at 100/second with complete drain
  and no rejected, failed or excessively late traffic. Require no database
  acquisition failures and agreement on independent totals, stored observations,
  coverage, tenant isolation and audited CSV. Rerun the retained comparison
  profile once. Preserve all failed attempts and the measured capacity envelope.

The current release decision requires completed Usage development and synthetic
acceptance before requesting execution. Its deployed shadow/rollup observation
still gates later reporting activation. A failed confidentiality, authority,
recipient or enforcement check always blocks the affected release.

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
