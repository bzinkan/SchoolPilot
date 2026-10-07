# Release 2.9.7 operator preparation addendum — October 4

The [current index](releases/release297/current-release.json) and [generated operator status](RELEASE_2_9_7_OPERATOR_CHECKLIST.md#current-release-status) supersede this dated checkpoint as current state. The [October 4 audit is archived verbatim](RELEASE_2_9_7_PREPARATION_HISTORY.md#archived-operator-preparation-audit--superseded-as-current-state-on-october-7), including its source/package identities, observations, original failures and then-pending PR statuses. Immutable receipts remain unchanged.

The retained procedure below is historical preparation guidance. Reconcile it with the current index and exact operator packet before preparing current source-bound plans; no consumed authorization or stale value may be reused.

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

The bounded production catalog inspection completed under separately approved plan `60cd65f7` on October 4 at 12:35 Eastern, with its exact ledger, admission, runtime role and health-sentinel metadata retained in the approved private receipt. The screenshot function is absent at that starting point. That approval and window are consumed; any later inspection must be re-planned and separately authorized on source/context/window drift. The original `public._health_sentinel` layout has runtime SELECT/INSERT/DELETE and sequence USAGE; do not grant broad schema CREATE. Its operational table remains outside the migration/RLS inventory.

The execution packet is intentionally incomplete until the following concrete inputs exist. None is filled with a guessed value or a runnable placeholder:

| Required input/output | How it is completed |
|---|---|
| Accepted release envelope | Bind the final lower-load/headroom conclusion and existing classroom/recovery evidence to the final application/schema. Usage remains a separate unaccepted gate |
| Resulting-main source and CI | #603/#123 and listed successors are merged; see the current index. Review stabilization PRs separately, record final resulting main and green applicable checks, and refresh application/package equivalence. Application changes invalidate affected acceptance/artifacts |
| Per-stage registry/task definitions | Record each supported deploy invocation's resolved registry/platform digest, scanned-image binding and exact API/worker task-definition ARNs/configurations after separate deployment authorization |
| Compatible production recovery target | Prepare and review exact registry publication/source/floor proof and API/worker recovery definitions for the compatible image; record a supported, source-bound recovery command. The local fallback image alone and pre-adoption production ARN are insufficient |
| Production admission/ledger/role/sentinel proof | Completed under plan `60cd65f7`: 43 complete migrations and 121 protected tables. Retain its receipt; generate only missing admission operations and refresh drift-sensitive metadata immediately before execution. Do not reuse the consumed inspection authorization |
| Approved operational interval and current headroom/backups | Refresh metadata/suspension state/provider health, actual database limits/workload context, backup/restore evidence and exact America/New_York window |
| Verified DeSales identity and governed activation plans | The authorized private inspection resolves the actual school identity/domain and active ClassPilot entitlement. Keep identifying values private. Generate later Plan manifests with the actual current serving source/digest/API/worker ARNs, evidence/waiver files and reviewed hash; retain actual plan hashes before Apply |
| Frontend publication binding | Reverify final frontend application inputs and retain the supported frontend build/hash, S3 sync and completed targeted CloudFront invalidation receipts after separate authorization |
| Store publication and installed-client evidence | Recheck listing **and pending submissions** immediately before authorized upload; stop if a higher version prevents 2.9.7. Bind exact ZIP upload and actual installed identity/version/accepted capabilities, including open pages |
| Current-school activation and observation | Enable three pilots separately, complete combined live observation, then promote accepted capabilities individually with fresh evidence for each changed serving pair |

Use `deploy-product-runtime-config.ps1` with its `-Action/-ConfigPath/-OutDir/-ManifestPath/-ManifestHash` contract for Library, Rules, appointments and Reports. Use `deploy-classpilot-runtime-config.ps1` with `-Operation/-ProfilePath/-ExternalEvidenceRoot/-PlanPath/-ExpectedPlanSha256` and exact expected source/image/task-definition parameters for the classroom pilots. Their plan inputs differ; neither a generic example UUID nor an old plan hash is an execution packet. Local catalog preparation is not production execution permission.

Immediately contain wrong recipients, authority leakage, widened restrictions, revived expired replies, failed cleanup or unhealthy services. Disable new issuance using the governed plan, retain compatible writer/bridge/relay and cleanup servers, and use only the reviewed compatible recovery target. Precise rollback follows disable → clear incompatible persisted resources → compatible image; Focus cleanup removes only Focus; Usage rollback below its correction requires both new modes off and coverage invalidation before reuse. Keep migrations, audit history and historical inventories. Extension repair/revert requires a higher version, normally 2.9.8, with any locally installed 2.10.0 candidate checked separately; uploading 2.9.6 does not downgrade 2.9.7.

Usage activation additionally requires three accepted cold capacity passes, distinct authenticated-report and broader survival evidence, three clean deployed shadow school days and one complete rollup-observation school day with Digital Usage off. SFU, TURN, paid provisioning, legacy deletion and unrelated Observe remain excluded. The separate formatter branch remains unintegrated and is not a Usage repair.
