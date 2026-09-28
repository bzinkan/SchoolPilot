# My Desk production release

My Desk is included with ClassPilot for every active qualifying teacher/admin
membership, including schools added after activation. There is no school-admin
toggle, per-teacher enrollment, or school-ID allowlist. Each author owns a separate
private notebook, seating library and import workspace. Support impersonation and
administrator access to another author's content remain forbidden.

This runbook supersedes the former notebook-only predecessor release sequence.
PR #510 contains all three immutable migrations. Feature modes do not defer DDL.
Do not downgrade that combined artifact or edit its checksummed migrations.
Operational evidence, not this document, establishes actual production status.

## Workspace redesign release

The workspace redesign's historical Terraform baseline adopted the exact 119-table runtime CSV verified
at `2026-09-26T18:46:05.78359-04:00` on API151/worker166, release
`9b3cabdf4ca7b40280b9598cc41ab51c3581a178`. The private
`redesign-live-verification.json` receipt confirms all 119 canonical forced tenant
policies and four completed migration checksums. The observed CSV SHA-256 is
`1441661e3f5af6582b24e6ec8145f4b76705a13511aeb21bf4ea0030c27f1358`.
This separate baseline adoption does not apply Terraform or establish frontend
release or AI activation. Keep the prior 109-table observation, historical 114-table
workspace target and all original migrations immutable. Inspect actual serving
admission before each release; a registry target is not proof of deployment.
The later verified 121-table production baseline is documented in
[PAPERWORK_PROGRESS_RELEASE.md](PAPERWORK_PROGRESS_RELEASE.md#deployment-and-rollback).
The observation above remains the original workspace redesign receipt.

Additive migrations are `mydesk-grade-filing-20260927`,
`school-discipline-redesign-20260928`, `mydesk-import-destination-20260928`, and
`student-information-redesign-20260928`. They add true grade snapshots/view
preferences, current-role school access, direct discipline import receipts and
contact profiles/imports. Seating remains unchanged.

Deploy independently reviewable navigation/private-note, discipline and contact
increments with compatible backend/migrations before frontend. Run backend,
frontend, authorization, ordinary/restricted RLS, migration/router/dashboard and
SOC 2 checks. Verify current-role revocation, private historical notes, grade
filing, independent evidence, atomic batches, contacts, retries and identity changes.

For a serving system that already admitted workspace/discipline tables, the new
reviewed bundle is exactly:

```text
student_contact_profiles,student_contact_profile_versions,student_information_imports,student_information_import_items,student_information_import_assets
```

If earlier workspace admission is still pending, apply that registered bundle
first. Never rerun an admitted bundle or concatenate unreviewed bundles. Verify
all five new forced tenant policies and existing protections before frontend.
Repair ledger/catalog mismatch additively. The original separate baseline adopted
the verified 119-table allowlist above; never replace serving tasks with bootstrap
templates or rerun this already admitted bundle.

Active school administrators automatically access shared discipline/contact
records; legacy grants have no authority. Teacher access follows current official
student assignments, including for their own school submissions. Private notes,
charts, import drafts and original packets remain author-only. Existing private
material is never retrospectively shared. Communicate the changed shared-record
boundary and verify authorized synthetic identities before broad live use.

Keep both AI modes off until their independent provider/quality/capacity reviews.
Manual work is available without AI. Rollback preserves data, RLS, school evidence,
contact history, private ownership, bucket permissions and cleanup. An older
client must not drop new note filing fields or overwrite measured seating content.

## Configuration and interfaces

| Setting | Default | Effect |
| --- | --- | --- |
| `MYDESK_MODE` | `off` | Personal notes for every eligible ClassPilot school |
| `MYDESK_SEATING_MODE` | `off` | Personal seating charts; requires base mode |
| `MYDESK_AI_IMPORT_MODE` | `off` | Teacher-started paperwork imports; requires base mode |
| `STUDENT_INFORMATION_AI_IMPORT_MODE` | `off` | Independent contact extraction; requires base mode, not discipline AI |

Values must be exactly `on` or `off`. The three old `*_ENABLED_SCHOOL_IDS`
variables are retired, including empty declarations. Invalid or conflicting
configuration fails all feature gates closed; release preflight rejects it.
Cleanup is independent of these modes and of membership/entitlement revocation.
Keep `MYDESK_ATTACHMENTS_BUCKET` and task-role permissions on both services even
when all modes are off. The worker discovers eligible queued work in the database,
not by enumerating schools from configuration. Existing quotas remain 100 pages
per author/day and 500 per school/day, with two import jobs across the deployment.

`GET /api/mydesk/capabilities` keeps its existing fields. The sidebar and labeled
mobile entry read those capabilities and work without a teaching session. New
schools need active ClassPilot access and qualifying staff memberships only.
Seating and AI do not depend on each other. No onboarding/settings API is added.

## Original base preparation reference (do not repeat admitted steps)

1. Capture exact serving API/worker image digests, task-definition ARNs, desired
   counts and RLS allowlists without printing unrelated environment or secrets.
   Run `scripts/run-mydesk-readiness.ps1 -Execute -WorkerArn <serving-worker-arn>
   -CandidateImageDigest <reviewed-image-digest> -CandidateAppSha <release-sha>
   -OutDir <private-external-directory>` from clean reviewed main. It runs
   `node dist/cli/inspectMyDeskReadiness.js` in a temporary worker clone with the
   existing database secret/TLS and network configuration; migrations, features
   and the scheduler stay off, and serving services are not changed. It reports migration checksums,
   catalog metadata and aggregate counts, never notes, filenames or images.
   Missing runtime allowlist entries do not prove database RLS is absent.
2. Compare all three ledger records with canonical checksums and inspect all six
   tables. If a completed migration has catalog drift, stop and prepare a new
   additive repair migration against populated fixtures. Never rewrite the old
   SQL, ledger, or historical inventory. Pending migrations run normally.
3. Provision/verify the six `aws_s3_* .mydesk_attachments` resources and narrowly
   scoped `module.ecs.aws_iam_role_policy.mydesk_attachments[0]`. Follow
   [AWS_COST_ROLLOUT_OPERATIONS.md](AWS_COST_ROLLOUT_OPERATIONS.md): verified DPAPI
   and OneDrive AES-GCM backups before plan/before apply/after apply, a unique
   saved plan, exact plan review and operator go/no-go. Review bootstrap task
   definition changes separately; never replace serving definitions with them.
   Reject unrelated service changes, replacements, destruction or secret changes.
4. From the reviewed release, reconcile the entire combined manifest with this
   exact registered bundle, after confirming matching live API/worker baselines:

   ```bash
   ./scripts/deploy.sh production --backend --activate-emergency --enable-rls-table mydesk_attachments,mydesk_notes,mydesk_seating_charts,mydesk_import_assets,mydesk_import_items,mydesk_imports
   ```

   The production migration path now verifies enabled/forced RLS, canonical
   tenant policies and a non-bypass database role even when all ledger migrations
   were already applied. Unexpected admission state fails closed. Omit the
   one-shot flag on later ordinary deploys.
5. Verify the actual database and both converged task definitions, then adopt
   the observed allowlist in the production Terraform baseline as a separately
   reviewed change before a later apply. Preserve old inventory order/hashes.

## Runtime configuration

Use `scripts/deploy-mydesk-runtime-config.ps1` from clean reviewed main. It clones
the exact serving image and all unrelated task-definition fields, preserves
secret references and RLS, freezes autoscaling during each transition, serializes
API-before-worker rollout, and verifies exact task/target health convergence.
Its plan/apply/rollback receipt lives in an owner-only directory outside the repo.
It shares the existing ClassPilot operation fence, so concurrent runtime operations
cannot race. The workflow does not change CPU/memory or IAM.

Store this non-secret configuration in a private external file:

```json
{
  "mode": "on",
  "seatingMode": "on",
  "aiImportMode": "off",
  "studentInformationAiImportMode": "off",
  "bucket": "schoolpilot-production-mydesk-attachments",
  "model": "claude-opus-5-5",
  "teacherDailyPages": 100,
  "schoolDailyPages": 500
}
```

```powershell
./scripts/deploy-mydesk-runtime-config.ps1 -Action Plan `
  -ConfigPath $ConfigPath -OutDir $EvidenceDirectory `
  -ApiArn $ServingApiArn -WorkerArn $ServingWorkerArn `
  -ImageDigest $ServingImageDigest -AppSha $DeployedCommit
./scripts/deploy-mydesk-runtime-config.ps1 -Action Apply `
  -ManifestPath $ManifestPath -ManifestHash $ReviewedManifestSha256 -Execute
```

Set all modes off first when installing bucket configuration and verifying S3,
IAM, encryption and the cleanup worker. Authenticated notebook routes deliberately
return 404 while base mode is off, so their end-to-end checks follow activation.
Deploy the matching frontend and enable notes/seating with AI still off. Immediately
verify synthetic attachment upload/authenticated download/delete and worker-confirmed
object removal, including cross-author denial. Disable the base and seating modes
if those checks fail, preserving bucket access for cleanup.
Teachers may use their own private workspaces while the operator performs the
desktop and physical Android walkthrough in production. Automated CI remains a
prerequisite; a separate staging acceptance environment is not required.

A model change with both AI modes off uses the same runtime plan/apply path and
does not authorize processing. The setting is shared by paperwork and contact
imports; each still needs its own evaluation with the selected model. Opus 5.5
requires the compatible structured-response parser before activation. Existing
imports retain their recorded model. To reverse a model change, create a fresh
plan with the previous model; the mode-only Rollback action retains the model.

## AI readiness and capacity

Keep AI off until the actual provider account/model retention arrangement is
reviewed, not inferred from a general policy or local object deletion. Use direct
requests without Files API archives or prompt caching. Never scan existing notes
or send note text or class rosters. Only teacher-selected source images, including
an explicitly selected saved attachment, are sent, and nothing is
published until teacher review and atomic Save. Discipline imports save school records directly after shared-visibility confirmation; private-note imports remain author-only.

Run the synthetic evaluator documented in [MYDESK_AI_IMPORT.md](MYDESK_AI_IMPORT.md)
with a fixed model/prompt, at least 30 pages and 60 forms. Require typed-form
precision, recall and key-field accuracy of at least 95%; report difficult cases
separately. Require zero critical wrong-student evidence, invented consequences,
silent missing pages, instruction-following or automatic publication. Human
review must verify every crop/summary and record correction time against manual
entry. Cursive generated text is not evidence of real handwriting performance.

The image includes `node dist/cli/measureMyDeskProcessing.js --role combined
--scenario max --image-digest <sha256-digest>` for a credential-free, synthetic
native-processing measurement. Its supervisor samples task/cgroup memory, stops
at 85% memory or the deadline, and waits for cleanup. It covers two five-file,
20-page, 50-form packets, ordinary uploads, 24-megapixel image decoding and a
20-region continuation. The report explicitly does not establish production
readiness: provider latency, storage, database leases, normal API traffic and
scheduler interference require separate measurements. Padded PDFs exercise input
size, not worst-case PDF complexity.

The measurement fails before generating fixtures if cgroup usage or a finite
memory limit is unavailable. On Fargate, an unlimited container cgroup can use
the single-container task's `Limits.Memory` from the injected, link-local
`ECS_CONTAINER_METADATA_URI_V4/task` endpoint. This metadata request is bounded
and cannot follow redirects; no credentials or metadata contents enter reports.
The smaller finite cgroup/task limit controls the stop guard. Reports preserve
both raw limits and identify the effective limit; metadata failure never supplies
an assumed worker size. Loss of usage readings cancels an active measurement.
Use the task-level limit, not a container reservation; see the
[AWS v4 task metadata examples](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-fargate-examples.html).

Measure the actual Linux image in an isolated production task before loading the
serving scheduler. Poppler and all My Desk Sharp image transforms share one native
processing permit per process, at most four waiters and bounded waiting. Two
durable imports may overlap their I/O.
Include two maximum-sized packets, combined ordinary/import uploads, image
decoding and normal scheduler work. A native child's limit does not bound total
task memory. Size the worker from measurements; record the selected CPU/memory.
Require peak task memory below 70%, API p95 within 20% of the measured baseline,
no OOM/restart, database timeout, unexpected 5xx, readiness loss or scheduler
disruption, and bounded queues that drain. Stop load at 85% memory, readiness
loss or sustained regression. Pathological files belong in isolated tasks.

AI activation additionally takes `-AiReadinessPath`, a private JSON evidence
record. Its schema is validated by `Assert-MyDeskAiReadiness` in the runtime
workflow and binds the exact image, model, prompt, serving worker CPU/memory,
provider-review reference, quality/capacity report hashes, measured thresholds,
zero critical failures, human correction timings and review/recovery completion.
All required results must reflect actual checks; do not fill missing checks with
`true`. The same evidence is hashed and rechecked at apply. Physical Android and
real-paperwork acceptance occurs after guarded activation in production.

Contact extraction requires separate `-StudentInformationReadinessPath` evidence.
Its strict schema binds the same serving image/model/worker dimensions plus
`INFORMATION_PROMPT_VERSION`, contact-specific provider review, quality/capacity
report hashes, at least 100 profiles across all five formats, at least 99% exact
phone/email accuracy on typed/tabular fields, separate difficult-case reporting,
zero critical failures, correction timing and review/recovery checks. See
[STUDENT_INFORMATION.md](STUDENT_INFORMATION.md). An omitted contact mode in an old
config means off only while the live mode is off; when already enabled the tool
requires an explicit value to avoid an accidental disable. Both services receive
matching modes. Each evidence file is hash-checked again at apply; enabling both
AI paths requires both evidence files. Rollback preserves contact cleanup storage.

## Acceptance, monitoring and rollback

Exercise 5th/6th-grade filing, General/Past classes, photo/PDF-only saves, edits,
search/export, retries and discarded drafts. Verify separate teacher/admin
accounts, impersonation denial, account/school switches and revoked blob URLs.
Test mouse/touch/keyboard seating, current arrangements, roster refresh,
duplication/layout reuse, and Letter/A4 printing. Use synthetic classes/records
for destructive tests. Confirm actual object removal, including cancellation,
expiry, revoked membership and mode-off cleanup. Add a new-school-after-activation
regression so availability and processing need no configuration update.

Monitor operational IDs, fixed error codes, counts, model versions, timing,
queue age, cleanup backlog, task memory, API latency and provider usage. Never
log names, filenames, source text/images, prompts or generated logs. Retain the
24-hour incomplete-upload and seven-day review expiry; committed attachments
follow ordinary notebook retention.

To disable one feature, create a new configuration plan with its mode off.
To reverse a completed activation, invoke `-Action Rollback` with its manifest
and hash. Rollback clones the current pair with previous feature modes while
retaining the bucket, image, RLS and unrelated settings. It refuses to turn an
off feature back on; use a reviewed new activation for that. Failed applies try
to restore previous modes while retaining cleanup configuration. If a receipt
says `recovery_required`, inspect the exact pair and preserve the operation fence
until service/scaling recovery is proven. Do not delete stored content, drop
tables, revoke cleanup IAM, or disable RLS as a rollback mechanism.
