# Coordinated SchoolPilot release and ClassPilot 2.9.7

Status: implementation and release preparation in progress. No deployment green
light, merge, production deployment, capability activation or Store publication
is recorded by this document. The current release inventory is
[here](RELEASE_2_9_7_PR_INVENTORY.md). Preserve the historical September 30 evidence;
its 2.10.0 package results do not certify this successor.

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
| Exact release source / CI | Pending final combined-source freeze and required checks; record full SHAs and run URLs |
| API / worker artifacts | Pending compatible digest-pinned serving and rollback artifacts; record image digest, source SHA and task definitions |
| Extension candidate source | `065be165b5df704d84eb716e3fb914c1fed17f98`; reviewed candidate, not an asserted merge or publication |
| Extension ZIP | `82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575`; 24-file verifier passed; full native/package/Chrome acceptance recorded separately |
| Extension review-head CI | Documentation-only head `8069a9c9bd50352e187847158b356a69edc4e45d`: [all five required jobs passed](https://github.com/bzinkan/ClassPilot/actions/runs/37048485018), including Chrome 120, 133, 152 and stable; packaged source and ZIP above unchanged |
| Live validation | Not started; minimum 30 minutes with nonzero samples for every required lifecycle category |
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
- Keep Usage activation off unless three cold final-schema runs each complete
  within 48 seconds at unchanged 60-second limits. Use two schools, one million
  stored observations per school, concurrent reports and separately measured
  authenticated open-loop arrivals at the declared device cadence. Preserve
  failed stress results and state the measured capacity envelope explicitly.

Usage capacity/observation does not hold up an otherwise accepted classroom
release. A failed confidentiality, authority, recipient or enforcement check does.

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
headroom. Record backup readiness and a specific approved America/New_York
operational interval. Do not infer permission from an old freeze note. Retain the
weekday 04:45–05:59 deployment safeguards and public-ECS/no-NAT configuration.

Check the public Store listing **and the developer dashboard's publication and
pending-submission state** immediately before upload. If a higher version prevents
2.9.7, stop and report it. Publication does not prove client installation.

## Migration and deployment order

Use a separate clean main worktree after the integration PR is reviewed and
merged; original checkouts and draft Observe work remain untouched. Main must
match origin and required CI must pass. Use the existing immutable-image workflow
and documented `scripts/deploy.sh` procedure; no hand-edited task definitions.

Reconcile the live catalog and migration ledger before forming admission plans.
Preserve all historical inventory entries and migration checksums. From the
observed 121-table baseline, the missing reviewed bundles are:

| Order | `--enable-rls-table` bundle | Resulting table count |
|---|---|---|
| 1 | `passpilotRules` | 125 |
| 2 | `classpilotUsageRollups` | 126 |
| 3 | `classpilotUsageRollupDays` | 127 |
| 4 | `passpilotAppointments` | 128 |
| 5 | `classpilotPrivateChatLifecycle` | 129 |

These are expected deltas, not permission to repeat an already-admitted bundle.
The tool accepts one reviewed bundle per operation; re-read both services between
operations. First deploy and fully drain to the compatible dark writer/bridge
while the private lifecycle capability remains off and the thread table is not
yet admitted. In this reversible stage, unadopted schools create no private
thread/token/generation state and have no permanent-expiration guarantee yet.
Then admit the final thread bundle only when both exact rollback source images
contain the compatible writer and bridge. The final admission is
`classpilotPrivateChatLifecyclePostExpand`; require identical full admission on
API and worker before capability activation. Run additive migrations using the
candidate's exact image before service rollout. Verify health and admission before
publishing the frontend. Do not shrink admission on rollback.

Private lifecycle adoption is a durable compatibility floor. Once admitted,
capability off does not permit a legacy writer or removal of its migration/table.
Prepare a known-good compatible containment/rollback image before activation;
retain it while any offline cleanup is unresolved. The deploy guard verifies each
source image digest against its exact source SHA, the compatible writer/bridge
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
5. Use `scripts/deploy-classpilot-runtime-config.ps1` to prepare current-school
   pilot profiles. Bind precise/Focus waiver receipts to the exact reviewed
   source, image and ZIP. Pilot and global promotion are separate operations.
6. Complete the live checklist below, then create fresh global-promotion plans
   from the actual one-school pilot and its measured evidence. Global availability
   includes future eligible schools; licensing and negotiated client capabilities
   remain mandatory. Observe is not activated by these profiles.

Use governed JSON configurations for Library (`CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE`),
Rules (`PASSPILOT_RULES_MODE`), appointments (`PASSPILOT_APPOINTMENTS_MODE`) and
Reports (`PASSPILOT_REPORTS_MODE=v2`). Never set capabilities or RLS through the
product setter. Generate exact plan manifests only after source/image/serving
state is final; stale plans must be regenerated.

## Live acceptance record

Record start/end timestamps, school, exact API/worker task definitions, image and
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
