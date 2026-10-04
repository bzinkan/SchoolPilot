# Release 2.9.7 operator preparation addendum — October 4

**Later October 4 checkpoint:** the [current readiness record](RELEASE_297_DEPLOY_READINESS.md#october-4-preparation-update) supersedes the pending-status rows below for the bounded production catalog inspection, supported-load selection and review-head CI. The separately approved inspection completed with 121 protected tables and 43 completed production migrations; ordinary candidate expansion requires 53, with the optional staff-identity contract still deferred. Exact `28f256d6` CI is green, and three 250-client Usage-off headroom confirmations pass. The production-default migration/recovery rehearsal and matched comparison remain pending. The [compatible fallback supplement](RELEASE_297_COMPATIBLE_FALLBACK_PREPARATION.md) records the implemented registration adapter. The original `b5d59130` checkpoint and its receipt remain unchanged; no deployment, publication, merge or activation occurred.

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

## Supported execution sequence and unresolved inputs

The following is reviewed procedure text only. Do not execute it before release acceptance and separate merge/deployment authorization. Use a separate clean resulting-main checkout equal to `origin/main`; retain original checkouts, review branches and Observe work. Leave the immutable-image workflow disabled and the public-ECS/no-NAT posture intact.

The existing controller scans each exact legacy build before ECR login/push, then verifies the pushed manifest/config before task registration. Retain its emitted image/scan/registry/source/task-definition evidence for every invocation. Prepared local hashes do not substitute for those later outputs.

From the historical configured 121-table baseline, use only missing catalog-verified bundles, one operation at a time, in this order:

```bash
./scripts/deploy.sh production --backend --activate-emergency --enable-rls-table passpilot_destination_policies,passpilot_pass_limits,passpilot_encounter_restrictions,passpilot_pass_denials
./scripts/deploy.sh production --backend --activate-emergency --enable-rls-table classpilot_usage_rollups
./scripts/deploy.sh production --backend --activate-emergency --enable-rls-table classpilot_usage_rollup_days
./scripts/deploy.sh production --backend --activate-emergency --enable-rls-table passpilot_appointments
```

After each operation, verify actual API/worker source/image, completed ledger, exact admission, target/service health and errors. At 128, require the compatible dark API/worker writer/bridge/relay pair, private lifecycle issuance off, and complete drain of incompatible tasks **and old ALB targets**. Only then, with a compatible recovery packet available, admit threads:

```bash
./scripts/deploy.sh production --backend --activate-emergency --enable-rls-table classpilot_private_chat_threads
```

Do not repeat an already-admitted bundle or shrink admission during recovery. Both `CLASSPILOT_USAGE_ROLLUP_MODE` and `CLASSPILOT_DIGITAL_USAGE_MODE` remain `off`. New precise, Focus and private lifecycle issuance initially remains off; compatible enforcement, existing controls, announcements and required cleanup continue under their contracts. An initial dark backend deployment is distinct from enabling teacher-facing capabilities.

The prepared bounded production catalog inspector command and exact plan/bundle hashes are already in the [operator checklist](RELEASE_2_9_7_OPERATOR_CHECKLIST.md#migration-and-deployment-order); Execute requires separate authorization. They must be re-planned on source/context/window drift. Inspect the actual ledger, admission, runtime roles and screenshot function/ACL, and verify the original `public._health_sentinel` layout with runtime SELECT/INSERT/DELETE and sequence USAGE; do not grant broad schema CREATE. Its operational table remains outside the 54 migrations/129 RLS inventory.

The execution packet is intentionally incomplete until the following concrete inputs exist. None is filled with a guessed value or a runnable placeholder:

| Required input/output | How it is completed |
|---|---|
| Accepted release envelope | Bind the final lower-load/headroom conclusion and existing classroom/recovery evidence to the final application/schema. Usage remains a separate unaccepted gate |
| Resulting-main source and CI | Obtain separate #603/#123 merge authorization, then record resulting main SHAs/green full checks and application/package equivalence. Any application change invalidates affected acceptance/artifacts |
| Per-stage registry/task definitions | Record each supported deploy invocation's resolved registry/platform digest, scanned-image binding and exact API/worker task-definition ARNs/configurations after separate deployment authorization |
| Compatible production recovery target | Prepare and review exact registry publication/source/floor proof and API/worker recovery definitions for the compatible image; record a supported, source-bound recovery command. The local fallback image alone and pre-adoption production ARN are insufficient |
| Production admission/ledger/role/sentinel proof | Execute the separately approved bounded catalog plan or obtain an approved operator export; generate only the actually missing admission operations |
| Approved operational interval and current headroom/backups | Refresh metadata/suspension state/provider health, actual database limits/workload context, backup/restore evidence and exact America/New_York window |
| Verified DeSales identity and governed activation plans | Resolve the actual school UUID/domain/license through authorized reads. Generate Plan manifests with exact serving source/digest/API/worker ARNs, evidence/waiver files and reviewed hash; retain actual plan hashes before Apply |
| Frontend publication binding | Reverify final frontend application inputs and retain the supported frontend build/hash, S3 sync and completed targeted CloudFront invalidation receipts after separate authorization |
| Store publication and installed-client evidence | Recheck listing **and pending submissions** immediately before authorized upload; stop if a higher version prevents 2.9.7. Bind exact ZIP upload and actual installed identity/version/accepted capabilities, including open pages |
| Current-school activation and observation | Enable three pilots separately, complete combined live observation, then promote accepted capabilities individually with fresh evidence for each changed serving pair |

Use `deploy-product-runtime-config.ps1` with its `-Action/-ConfigPath/-OutDir/-ManifestPath/-ManifestHash` contract for Library, Rules, appointments and Reports. Use `deploy-classpilot-runtime-config.ps1` with `-Operation/-ProfilePath/-ExternalEvidenceRoot/-PlanPath/-ExpectedPlanSha256` and exact expected source/image/task-definition parameters for the classroom pilots. Their plan inputs differ; neither a generic example UUID nor an old plan hash is an execution packet. Local catalog preparation is not production execution permission.

Immediately contain wrong recipients, authority leakage, widened restrictions, revived expired replies, failed cleanup or unhealthy services. Disable new issuance using the governed plan, retain compatible writer/bridge/relay and cleanup servers, and use only the reviewed compatible recovery target. Precise rollback follows disable → clear incompatible persisted resources → compatible image; Focus cleanup removes only Focus; Usage rollback below its correction requires both new modes off and coverage invalidation before reuse. Keep migrations, audit history and historical inventories. Extension repair/revert requires a higher version, normally 2.9.8, with any locally installed 2.10.0 candidate checked separately; uploading 2.9.6 does not downgrade 2.9.7.

Usage activation additionally requires three accepted cold capacity passes, distinct authenticated-report and broader survival evidence, three clean deployed shadow school days and one complete rollup-observation school day with Digital Usage off. SFU, TURN, paid provisioning, legacy deletion and unrelated Observe remain excluded. The separate formatter branch remains unintegrated and is not a Usage repair.
