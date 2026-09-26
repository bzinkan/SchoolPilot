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

## Workspace expansion after the verified base release

The September 26 verified live Terraform baseline remains exactly 109 tables.
The personal grade folders/student history, selected-attachment AI import,
measured seating and explicit school-discipline work is a new release. It does
not authorize pushing, merging, deployment, AI enablement or production writes.
Keep all original checksummed migrations and historical inventories unchanged.

The additive manifest includes `mydesk-workspace-expansion-20260926`,
`mydesk-measured-seating-20260926`, and `school-discipline-records-20260927`.
Workspace preferences and four discipline tables expand the reviewed target to
114 tables. The measured seating migration changes a bounded JSON compatibility
constraint without converting saved v1 layouts. The workspace migration adds
frozen preference/source metadata to imports without changing original checksums.

Before an authorized release, run backend/frontend checks, ordinary and real
restricted-role RLS tests, migration/schema and admission contracts, router and
dashboard regressions, and SOC2 checks. Relevant behavior includes personal admin
defaults without reduced permissions, zero-note student directories, historical
labels, source-copy races, orientation/crop correction, measured room geometry,
immutable school records, selected evidence, grants/revocation, retries, and
identity switching. Verify the existing serving baseline and migration ledger.

After explicit release authorization, deploy backend/worker and admit this exact
registered five-table bundle through the existing reviewed deploy process:

```text
mydesk_preferences,school_discipline_records,school_discipline_versions,school_discipline_attachments,school_discipline_access
```

Verify all five canonical forced policies plus existing RLS protections, then
deploy the matching frontend. Do not rerun the already-admitted six-table flag or
use a task template to replace serving configuration. Keep the verified109
Terraform CSV/order/hash unchanged until a separate observed114 adoption review.
School-wide discipline reader grants begin empty. They are managed deliberately
by active school administrators, not by a product enablement setting.

Keep AI imports off: orientation prompt `mydesk-forms-20260926-v2` and the selected
attachment flow require updated provider/data-flow, synthetic quality and
capacity review. Existing readiness evidence for a different prompt is not valid.
Use synthetic source notes and test identities for destructive/recovery checks;
verify real Android interaction and Letter/A4 output during the authorized live
walkthrough. Rollback preserves new tables, private ownership, school evidence,
forced RLS, bucket permissions and cleanup. Coordinate compatible API/frontend
versions; an older client must not rewrite a saved v2 chart as v1.

## Configuration and interfaces

| Setting | Default | Effect |
| --- | --- | --- |
| `MYDESK_MODE` | `off` | Personal notes for every eligible ClassPilot school |
| `MYDESK_SEATING_MODE` | `off` | Personal seating charts; requires base mode |
| `MYDESK_AI_IMPORT_MODE` | `off` | Teacher-started paperwork imports; requires base mode |

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

## Forward preparation and admission

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
  "bucket": "schoolpilot-production-mydesk-attachments",
  "model": "claude-sonnet-5",
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

## AI readiness and capacity

Keep AI off until the actual provider account/model retention arrangement is
reviewed, not inferred from a general policy or local object deletion. Use direct
requests without Files API archives or prompt caching. Never scan existing notes
or send note text or class rosters. Only teacher-selected source images, including
an explicitly selected saved attachment, are sent, and nothing is
published until teacher review and atomic Save.

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
