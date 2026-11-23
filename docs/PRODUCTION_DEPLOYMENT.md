# SchoolPilot production deployment

Use this runbook for authorized changes to SchoolPilot's AWS API, scheduler worker,
and web app. The ClassPilot extension, desktop software, and native store builds
have separate release procedures. Use a clean local `main` equal to `origin/main`
and verify the exact SHA and its release checks before publishing. Confirm the
live serving image, task definitions, RLS allowlist, and feature state before a
change. Dated release records describe what was observed at the time.

- [Backend rollout](#deploy-sequence--backend) and [schema changes](#schema-changes)
- [Frontend publication and rollback](#deploy-sequence--frontend)
- [GoPilot containment](#gopilot-containment-and-rollout-runbook) and [PassPilot cutover](#guarded-clean-school-cutover-runbook)
- [Capacity and runtime configuration](#common-deployment-pitfalls)
- [Health and redaction](#error-monitoring) and [Terraform state and secrets](#terraform-state-and-secrets)

Start with [deploy.sh](../scripts/deploy.sh) and inspect its current guards. For
paired releases, prepare the web artifact first, then verify the ledger migration,
RLS catalog, and exact API/worker convergence before publishing the web app.
Use the feature owner's admission and rollback procedure for any flag or schema
change. Record the approved SHA, serving revisions and recovery evidence in the
private release record.

## Production infrastructure

SchoolPilot's production AWS resources are in `us-east-1`.
- **ECR**: `135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api`
- **ECS**: Cluster `schoolpilot-production-cluster`, services `schoolpilot-production-api` and `schoolpilot-production-scheduler-worker`
- **RDS**: PostgreSQL in private VPC (not directly accessible - run the deploy-script migration task for schema changes)
- **S3**: `schoolpilot-production-frontend` (static frontend assets)
- **CloudFront**: Distribution `E1TPPJOD7C2CXR`

## Schema changes

Production RDS is private. Ship schema changes through the deploy script's
one-off checksum-ledger ECS migration task. Keep local Drizzle pushes and
legacy bootstrap out of the serving path.

1. Add the definition in the owning `src/schema/*.ts` file.
2. Add an immutable entry to the current versioned ledger module, with a
   checksum, explicit transaction mode and fail-closed SQL. Enable and force
   RLS for tenant tables, verify same-school parents and update the registry.
3. Verify the ledger and live catalog before API and worker rollout.

### Deploy-time RLS admission

Ordinary backend deploys preserve the live task definition's RLS master switch and per-table allowlist exactly. A reviewed release may use the one-shot `--enable-rls-table <reviewed-table-or-exact-bundle>` flag. That path requires matching live API/worker allowlists with `RLS_GUC_ENABLED=true`, adds only the reviewed table set to the rendered API/emergency/worker definitions, verifies the registered definitions, and makes the migration task fail unless PostgreSQL reports enabled + forced RLS and the `tenant_isolation` policy for every requested table. Omit the flag on later deploys; a deliberate per-table kill-switch removal then remains removed. This path does not require a Terraform apply.

Use the exact table set reviewed in [the registry](../src/config/rlsRegistry.json).
Preserve earlier entries and their order. Verify registered task definitions
and the live catalog before a separately reviewed baseline adoption.
`RLS_GUC_ENABLED` controls application binding. Changing it cannot remove a
PostgreSQL policy and can deny-hide reads or reject writes.

## Deploy Sequence — Backend

Build and deploy from the SchoolPilot repository root. The obsolete GoPilot
prototype has an incompatible schema.

Preferred path:

```bash
./scripts/deploy.sh --backend
```

When production is intentionally retained on the launch-safe reviewed-size API
posture (1024 CPU / 2048 MiB), use the reviewed backend-only mode instead:

```bash
./scripts/deploy.sh production --backend --activate-emergency
```

**Reviewed task sizes.** The reviewed launch envelope runs the API at 1024 CPU / 2048 MiB and the
scheduler worker at 512 CPU / 1024 MiB, the configuration that passed the My
Desk paperwork capacity tests. The sizes are recorded in `REVIEWED_*_TASK_*`
(`scripts/deploy.sh`), `$script:ApiTaskCpu` and friends
(`scripts/deploy-classpilot-runtime-config.ps1`, shared by the My Desk and product runtime tools),
the rollback and load tools under `scripts/load/`, `ecs_cpu`/`worker_cpu` in
`infra/production.tfvars`, and the ECS module's production floor.
`tests/deploy-production-task-sizing.test.ts` keeps them identical.
`--activate-emergency` refuses unless the serving API and worker are exactly
these sizes, and every rendered API, emergency, and worker revision is refused
if it is smaller than the revision it replaces. To resize, change all of these
in one reviewed PR with new capacity evidence. A live resize before the
tooling update blocks deployment.

The reviewed-size mode leaves the prior API serving during image preparation and
uses the candidate digest-matched revision for migrations and API convergence.
The default backend mode selects the standard API family. Inspect the serving
family before a rollout or recovery.

### Reviewed release-2.9.7 artifact binding

The reviewed release-2.9.7 v5 artifact path applies only to that binding. Use
the exact tested serving image after the approved publication. See
[artifact preparation](RELEASE_ARTIFACT_PREPARATION.md) for its authorization and
receipt requirements.

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --release-artifact-publication <absolute-private-publication-receipt-path> \
  --release-artifact-publication-sha256 <64-hex-receipt-hash> \
  --release-artifact-fallback <absolute-private-fallback-registration-receipt-path> \
  --release-artifact-fallback-sha256 <64-hex-receipt-hash>
```

This path accepts only the allowlisted v5 serving-anchor binding after successor
selection, applicability and original acceptance gates pass. It replays source,
tool, scan, evidence and registry identities before registration, migrations and
service rollout. Publication remains unsigned and is never described as a signed
CI artifact. All normal production window, capacity, environment and rollback
guards remain in force. Deploy the separately verified matching frontend after
backend/worker convergence; this flag does not upload the Chrome extension.
The v5 path prepares the already-admitted 129-table pair, preserving its exact
capability settings. Before rollout it verifies the completed inactive successor
registration and both exact definitions. If rollout fails, automatic recovery
uses that CP-AI-protected pair; original serving references remain the baseline
for preflight comparisons. Historical 121/128 preparation remains unchanged for
earlier binding versions.

### Protected-window backend admission

Use the protected-window path only for its narrowly authorized backend scope.

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --tag <full-40-character-main-sha> \
  --confirm-protected-window-production-mutation
```

That flag is valid only for an initial admission during the weekday 04:45–05:59
America/New_York window; it is also what permits a stable API desired count above three during that admitted run. It rejects
frontend, RLS, skip-wait, immutable-image, same-image, capacity, observation,
rehearsal, and receipt modes. The only admitted API desired counts and temporary
`minimumHealthyPercent/maximumPercent` mappings are `1=100/200`, `2=50/100`,
`3=66/100`, `4=75/100`, `5=80/100`, and `6=83/100`; the singleton worker uses
`0/100`. Counts 2–6 therefore permit exactly one stop with no capacity growth,
while count 1 permits one availability-preserving replacement slot. Those envelopes
hold only while the containment bounds are installed: an ordinary
`deploy-classpilot-runtime-config.ps1` Apply keeps the reviewed `100/200`
configuration, under which ECS starts every replacement before it drains an
incumbent, so healthy ALB targets legitimately rise to twice the desired count
mid-rollout (three were observed at two tasks on 2026-09-17). The tool's converging
health gate is therefore derived from the live deployment configuration with ECS
rounding, `[max(1, N-1), floor(N × maximumPercent / 100)]`: `[max(1, N-1), 2N]` under
`100/200` and exactly the table above under containment. The gates before mutation
and after convergence still require exactly N healthy targets. The script
suspends dynamic and scheduled scaling, proves the live target-health floor,
converges the API before mutating the worker, restores the exact prior ECS
deployment configurations, and releases scaling only after validating the exact
05:45/16:00 scheduled-action contract and reconciling the current minimum (`3`
during 05:45–15:59 weekdays, otherwise `1`). If scheduled scaling was already
suspended, its captured minimum is restored exactly. A reconciliation to three
does not complete until desired, running, and healthy API capacity all reach three.
After any candidate may have served traffic, an unresolved protected run retains
the no-growth/scaling hold for explicit roll-forward recovery instead of forcing
an unproven application downgrade; the ECS rollback circuit breaker remains enabled.
Omitting the explicit flag retains the ordinary window and one-to-three-task
rules; an ordinary three-task rollout converges the API before the worker mutates.

### Backend execution and verification

The deploy script requires a clean local `main` equal to `origin/main`, green
latest GitHub Actions runs per workflow, authenticated AWS + GitHub CLIs, and a
git-SHA image tag by default. A production backend deploy also fails closed
unless the API is stable at one, two, or three tasks and the scheduler worker is stable
at exactly one task. Ordinary mode blocks weekday production backend deployments
from 04:45 through 05:59 America/New_York so the 05:45 three-task school-day floor action
cannot cross a migration or 200%-capacity service rollout; only the explicit
protected-window flag above may use the separately bounded no-growth path.
Immediately before its
migration it captures the API
Application Auto Scaling suspended state, suspends dynamic scale-in/out while
preserving the captured scheduled-scaling state, rechecks both services, keeps
the dynamic hold through migration and service stabilization, and restores the
exact prior state. Leaving the reviewed one/three-task schedules active prevents
a deployment from skipping the 05:45 scale-up or 16:00 scale-down. Production `--skip-wait` is
therefore prohibited. This bounds the 200% rolling database-connection overlap
below the launch gate. It builds and pushes the image, registers
digest-pinned API and scheduler-worker task definitions, and also pre-registers
an unused digest-pinned API OOM target in the
`schoolpilot-<environment>-api-emergency` family. The emergency target clones
the newly rendered API definition, including its environment and secrets, but
uses the reviewed 1024 CPU / 2048 MiB. The script prints its exact ARN and revision without
changing either active service. It then runs the explicit
`RUN_MIGRATIONS_ONLY=true` ECS migration task, updates both ECS services, waits
for service stability, and cleans temporary task-definition files. After the
standard ECS waiter, a bounded production-only poll requires the service and
PRIMARY deployment task definitions to match the newly registered API and
worker revisions with exactly one `COMPLETED` deployment each; a circuit-breaker
rollback to old stable revisions fails closed while the autoscaling hold is
still active.

When ECR returns multiple tag aliases for a digest, the legacy verifier requires
every entry to have the requested digest, repository, media type, and identical
manifest bytes before checking the scanned config digest. Tag aliases do not
permit a second executable image or bypass the vulnerability scan.

The immutable CI image workflow is intentionally opt-in with the repository
variable `IMMUTABLE_RELEASE_IMAGE_ENABLED=true`. Leave it disabled until the
`release-image` GitHub environment, `AWS_RELEASE_IMAGE_ROLE_ARN`, and the
repository-scoped AWS GitHub OIDC trust are provisioned and verified. While it
is disabled, use the deploy script's guarded legacy build path; do not set the
flag merely to make a workflow appear green.

```bash
# Step 1: ECR login (required — tokens expire after 12 hours)
MSYS_NO_PATHCONV=1 aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 135775632425.dkr.ecr.us-east-1.amazonaws.com

# Step 2: Build Docker image from THIS repo root
docker build -t schoolpilot-production-api .

# Step 3: Tag for ECR
docker tag schoolpilot-production-api:latest 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api:latest

# Step 4: Push to ECR
docker push 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api:latest

# Step 5: Register a task-def revision pinned to the pushed image DIGEST, then
# point the API and scheduler-worker services at matching revisions. Preferred:
# `./scripts/deploy.sh --backend` does this automatically (resolve digest →
# run migration task → render revisions → register → update services).
# ECR tags are mutable, so never deploy by tag/force-new-deployment. A
# digest-pinned revision is exact; before any manual rollback, apply the
# feature-specific data compatibility gates above rather than assuming every
# previous revision can safely interpret current production rows.
DIGEST=$(MSYS_NO_PATHCONV=1 aws ecr describe-images --repository-name schoolpilot-production-api --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text --region us-east-1)
# Render: copy current task def JSON, strip read-only fields, set containerDefinitions[0].image
# to 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@$DIGEST,
# then: aws ecs register-task-definition --cli-input-json file://taskdef.json
MSYS_NO_PATHCONV=1 aws ecs update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-api --task-definition schoolpilot-production-api:<NEW_REV> --region us-east-1

# Step 6: VERIFY — wait for new API + worker tasks to reach RUNNING, old tasks to stop
MSYS_NO_PATHCONV=1 aws ecs describe-services --cluster schoolpilot-production-cluster --services schoolpilot-production-api schoolpilot-production-scheduler-worker --region us-east-1 --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,taskDefinition:taskDefinition,deployments:deployments}'
# rolloutState=COMPLETED with desiredCount==runningCount. The API carries a scheduled
# weekday school-day floor of 3 from 05:45 to 16:00 America/New_York, so desiredCount=3
# is the correct healthy reading for most of a school day; only the worker is ever 1.
# If runningCount=0 or rolloutState=FAILED, check task logs in CloudWatch
```

If a standard API deployment OOMs, use the exact emergency ARN printed by that
same backend deploy; do not reuse an emergency revision from a different image.
The command below is an operator action and is not run automatically by the
default deploy path. The reviewed `--activate-emergency` mode performs this
selection as part of its guarded rollout instead:

```bash
EMERGENCY_TASK_DEF_ARN="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:<PRINTED_REVISION>"
MSYS_NO_PATHCONV=1 aws ecs update-service \
  --cluster schoolpilot-production-cluster \
  --service schoolpilot-production-api \
  --task-definition "$EMERGENCY_TASK_DEF_ARN" \
  --region us-east-1
MSYS_NO_PATHCONV=1 aws ecs wait services-stable \
  --cluster schoolpilot-production-cluster \
  --services schoolpilot-production-api \
  --region us-east-1
```

Verify `/health`, target health, and ECS task restart/OOM counters immediately
after using the emergency target. The standard API revision keeps the serving
task size, so it is not an OOM recovery target.


### One-shot RLS release examples

These examples are scoped to their original release or a separately reviewed
recovery of the exact missing tables. Before any admission, compare the live
ordered API and worker allowlists with the reviewed registry entry and migration.
Keep existing admissions and deliberate removals as observed. Omit one-shot
flags after successful admission and adopt the observed live baseline separately.
For a new release, use the exact bundle and guards in its reviewed change.
For the single release that first enforces the ClassPilot session-summary
delivery outbox, use the explicitly reviewed additive RLS flag. Do not retain
the flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_session_summary_deliveries
```

For the single release that first adds the PassPilot legacy multi-class
membership table, use the same reviewed one-table path and omit the flag on
later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table passpilot_grade_students
```

For the backend-first ClassPilot bypass-resilience release, add and verify the
five direct-tenant monitoring/control tables as one indivisible reviewed
bundle. Do not split, reorder, or retain this flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_monitoring_events,classpilot_session_reports,classpilot_session_staff,classpilot_session_student_reports,classpilot_student_control_states
```

Keep Terraform's production allowlist at the deployed baseline until this
one-shot activation has completed and the live RLS catalog checks have passed.
Then land the observed allowlist as a separate baseline-adoption change before
any later Terraform apply.

For the first ClassPilot FAB durability release, add and verify the four new
direct-tenant state tables as one indivisible reviewed bundle. Do not split,
reorder, or retain this flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_chat_deliveries,poll_responses,polls,session_settings
```

That activation was verified on August 19, 2026. The semantic RLS registry
retains its exact observed 72-table live allowlist as an immutable audit
snapshot. The separate 75-table 2.7.0 post-expand target remains unchanged in
the registry. The 90-table roadmap allowlist verified on September 6, 2026
and 121-table paperwork inventory verified on September 28, 2026 are dated
observations. Check the live pair and catalog before making any admission. Its recorded runtime order remains
distinct from historical target order. Future additions still require
the reviewed migration/catalog gate before baseline adoption.
Ordinary later deploys omit the flag. Do not use the Terraform baseline to bypass
a deliberate per-table kill-switch; reversing one still requires the reviewed
one-shot path and successful live FORCE RLS, tenant-policy, and catalog checks.

For the SchoolPilot 2.7.0 additive persistence expansion, use the exact
three-table bundle only when all three tables are absent from the live
allowlist:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_evidence_capture_requests,passpilot_kiosk_devices,passpilot_kiosk_sessions
```

Production was verified at 74/75 on August 22, 2026: both kiosk tables were
already admitted and only `classpilot_evidence_capture_requests` remained.
The reviewed singleton for that rollout was the following. The deploy guard
rejects tables already enabled.

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_evidence_capture_requests
```

Either valid starting state reaches the same 75-table target without changing
the intentionally distinct ClassPilot FAB re-admission bundle. Omit the flag
from later deployments.

For this ClassPilot release family, deploy in compatibility-safe stages:

1. Run and verify the backend migration task first, including the exact
   four-table one-shot RLS bundle, FORCE RLS policies, parent-binding triggers,
   canonical entitlement, and mixed-version protocol behavior. Do not roll API
   or worker tasks if the migration/catalog checks fail.
2. Deploy the SchoolPilot API/frontend only after the backend contract is live.
   Frontend controls must remain hidden or safe-disabled until the relevant
   extension capability is advertised; never infer support only from a version.
3. Release the Chrome extension separately from `C:\GitHub\ClassPilot`. Chrome
   Web Store listing `iggbfegfcjkfieoemeolfmfnapepalca` is operator-confirmed
   live at `2.9.7` on October 7, 2026; this and the August 27 `2.7.2` observation
   are dated records. Newer source is reviewed separately from Store status. This report
   is not uploaded-package identity proof or managed-Chromebook adoption or
   validation. Before any separately reviewed successor upload, re-check the listing
   and pending submissions,
   build from the clean tagged commit with `./extension/package-extension.sh`,
   inspect and hash the versioned archive, and stage adoption separately through
   Chrome Web Store and Google Admin.
4. Omit the one-shot RLS flag on later deploys. The 75-table target above is
   retained as versioned history; the configured Terraform baseline is the
   separately verified September 28, 2026 121-table paperwork inventory. Verify the current live
   catalog before any later Terraform apply. The historical 72-table observation
   and 75-table target remain unchanged in the registry. A
   SchoolPilot backend/frontend deploy never publishes the extension, and
   disabling a new UI action is safer than falling back to a legacy URL/device
   contract.

For the single backend-first GoPilot staff-dismissal release, add and verify
the seven direct-tenant child tables as one indivisible reviewed bundle. Do
not split, reorder, or retain this flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table authorized_pickups,custody_alerts,dismissal_changes,dismissal_overrides,dismissal_queue,family_group_students,homeroom_teachers
```

Before that one-shot deploy succeeds, keep Terraform's generic and production
allowlists at the currently deployed baseline; preloading the seven tables
would bypass the live-source and catalog admission checks above. Immediately
after the rollout is verified, land a separate baseline-adoption change that
copies the observed live allowlist (including all seven tables) into an
explicit `infra/production.tfvars` value before any later Terraform apply.
Stage non-production environments separately. Never combine the pre-rollout
activation and post-rollout Terraform baseline into one static value.

For the first ClassPilot one-day schedule-change release, add and verify the
three direct-tenant workflow tables as one indivisible reviewed bundle. Do not
split, reorder, or retain this flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_schedule_change_pairs,classpilot_schedule_changes,classpilot_schedule_change_legs
```

Keep Terraform's production allowlist at the deployed baseline until this
one-shot activation and live catalog verification succeed. Then land the
observed allowlist in a separate production baseline-adoption change before
any later Terraform apply. The feature policy defaults off, but already
approved dated changes must continue to resolve during a frontend rollback.
After the feature has accepted data, a backend rollback to a pre-schedule-change
revision is not automatically safe: that code would ignore approved effective
windows and could start the recurring windows instead. Before selecting such a
revision, verify that there are zero future approved changes and zero frozen
occurrences that depend on a swapped window; cancel any future changes before
the earliest affected bell. If either condition cannot be proved, roll forward
with a repaired feature-aware revision. The teacher-request kill switch only
blocks new requests and is not a backend rollback mechanism. An automatic ECS
circuit-breaker rollback before the candidate serves traffic or stores feature
data remains safe.

If that safe rollback leaves the live API/worker task definitions without the
three schedule-change tables in `RLS_ENABLED_TABLES`, the next feature-aware
backend attempt must repeat the exact three-table one-shot flag after re-running
the live-source preflight. An ordinary deploy intentionally preserves the live
allowlist and would otherwise start feature code without admitting those tables.
Apply the same rule after a deliberate per-table kill-switch removal. Once live
catalog verification has succeeded and all three tables remain enabled, omit the
one-shot flag on later releases as usual.

## Deploy Sequence — Frontend

Use the existing deploy command from a clean, current `main` worktree. CI
packages the standard web bundle after its production-preview and Router
checks. The command uses that run's bundle and verifies its file hashes before
publishing. Run the read-only preflight to confirm the current rollback target.

```bash
./scripts/deploy.sh production --frontend-plan
./scripts/deploy.sh production --frontend
./scripts/deploy.sh production --frontend-rollback <release-receipt-path>
```

For a coupled release, prepare the web artifact before the backend rollout and
publish after the API and scheduler worker converge. A frontend-only release
requires compatibility with the serving API. If the CI artifact has expired,
rerun the exact main push CI from GitHub and wait for its frontend job and all
release checks to succeed.

S3 versioning and a bucket lock protect the cutover. Hashed assets are retained
for open sessions. Stable public files use revalidation. Use a versioned URL
for any public file whose bytes must change in step with JavaScript. The deploy
publishes the HTML last, waits for the scoped invalidation, and checks the
served HTML and its entry assets through CloudFront.

Keep the receipt from `soc2-evidence/frontend-releases/` in the private release
evidence when retiring the worktree. The rollback command uses the receipt and
serving S3 versions, so it can run after `main` advances. It restores the prior
web entry files and verifies the restored page. When recovery is uncertain,
inspect the receipt and live S3 versions before retrying. A visible prior
version alone cannot settle a pending write with a lost response. Reconcile
that request and confirm that the process has exited before removing a stranded
`__schoolpilot_frontend_lock`. Match its body to the receipt's `lockToken`, its
`schoolpilot-release` metadata to the receipt ID, and its current version to the
recorded version when available. Remove only that exact lock version. Preserve
the original receipt and use the resulting recovery receipt for any subsequent
recovery. If AWS definitively rejected a pending write, preserve that evidence
with the original receipt before clearing `pendingWrite` in a recovery copy.
Staging discovers the distribution for the staging bucket and alias.

## GoPilot containment and rollout runbook

1. Deploy the backend containment behavior first and verify every retired parent route and parent socket handshake returns `410 GOPILOT_PARENT_PORTAL_DISABLED`. Never roll back by re-enabling those endpoints.
2. From a controlled one-off task using the exact reviewed backend image and production database network configuration, run the ID/count-only inventory before the schema/RLS rollout:
   ```bash
   npm run audit:gopilot
   # or narrow the report without exposing names, emails, car numbers, or tokens
   npm run audit:gopilot -- --school-id <school-uuid>
   ```
   Review parent memberships/links, pickup approvals without staff evidence, duplicate queue/family rows, weekend or unlicensed sessions, invalid states, completed sessions with open queue entries, and orphan totals. Resolve every migration-blocking count deliberately; do not delete retained history simply to make the report clean.
3. Deploy the additive GoPilot schema and normalized staff APIs backend-first with the exact seven-table RLS bundle in [the one-shot examples](#one-shot-rls-release-examples). Wait for the old API tasks to drain and verify migration, RLS, Redis-relay health, scheduler skips/starts, queue metrics, alarms, and public health before publishing the web client.
4. Publish the staff web client. Pilot car-number and direct-search arrivals with synthetic students under separate office and teacher accounts before a live dismissal.
5. Release Android separately only after rotating the historical GoPilot upload/signing credential through the distribution provider, building with protected `GOPILOT_KEYSTORE_*` secrets, inspecting the signed AAB, and confirming the staff-only version is adopted. Retain the temporary staff car-number compatibility alias until that adoption is verified.

The inventory CLI is read-only and must remain school-ID/count-only. It never changes parent links, pickups, queue rows, invitations, or sessions.

## PassPilot class-source rollout

See the [class-source contract](../ARCHITECTURE.md#passpilot-class-source)
for class model, client requirements, and shared lock.

#### Guarded clean-school cutover runbook

The clean-school CLI is only for an existing `legacy_grades` school that already has at least one active official ClassPilot `admin_class` and has **zero** PassPilot grades, passes of any status/class shape, `students.grade_id` assignments, teacher-grade assignments, kiosk class selections, prior canonical-write markers, or prior cutover markers. Active PassPilot and ClassPilot licenses are prerequisites, but licenses never establish readiness by themselves. Suspended, inactive, or deleted schools are ineligible.

1. Build and deploy the exact reviewed backend image, including the reviewed ledger migration. Run this CLI only from a controlled one-off task with production RDS connectivity and that same digest; production RDS is not reachable from a workstation.
2. Dry-run one exact school (default mode; no source mutation):
   ```bash
   npm run migrate:passpilot-clean-schools -- --school-id <school-uuid>
   ```
   Or inventory every persisted legacy-source candidate using IDs and counts only:
   ```bash
   npm run migrate:passpilot-clean-schools -- --all-clean-schools
   ```
3. Review `eligible`, every reason, and every count. Resolve any non-zero legacy state through the normal PassPilot class-migration review; never delete history to make a school appear clean.
4. Execute only after web, native, and kiosk clients support `classpilot-groups-v1`. Execution requires the audited ID of an existing super administrator and the exact acknowledgement:
   ```bash
   npm run migrate:passpilot-clean-schools -- --school-id <school-uuid> --execute --super-admin-actor-id <user-uuid> --acknowledge-class-model classpilot-groups-v1
   ```
   `--all-clean-schools` may replace `--school-id`; it executes only rows that were eligible and pass the same eligibility check again inside the advisory-locked cutover transaction.
5. Require an `executed` outcome and the durable `passpilot.class_migration.completed` audit event. Re-run the single-school dry-run: it must report `source_not_legacy`; the school must no longer appear in `--all-clean-schools` output.

The CLI never runs from startup, a GET request, or scheduler work, and dry-run is always the default. Do not add license-based source inference or automatic retry. A failed or ambiguous execution is investigated and rolled forward through the reviewed migration path; do not manually switch the source back.

## Read-only AWS monitoring

### ALB access-log summary (live monitoring)

`scripts/load/alb-access-log-summary.mjs` downloads the five-minute ALB
access-log objects for a UTC window (read-only `aws s3 ls`/`cp` into a temp
cache) and prints per-route status counts, per-target share and target latency
in ten-minute slices, heartbeats per minute, `device/screenshot` upload-size
buckets (25 KiB or smaller is the thumbnail signal), and every 4xx/5xx by
route. Rows are selected by their own request timestamp, never by the object
name: object stamps are the interval end and objects arrive about five minutes
late. Minutes newer than the newest delivered object print `n/a` rather than
zero so a real traffic gap stays distinguishable from undelivered data. Logs
expire after 90 days. Add `--json` for machine output, `--target <ip>` to
isolate one task, and `--files <dir>` to re-summarize a cached day without S3.
Delete the cache after a monitoring day: logged URLs identify tenants.

```bash
# Was the tile-storm back between 14:15 and 14:45 UTC?
node scripts/load/alb-access-log-summary.mjs --date 2026-09-03 --from 14:15 --to 14:45 --route 'tiles/screenshots'
# Per-target share since a scale-out
node scripts/load/alb-access-log-summary.mjs --from 14:45
# Thumbnail share this hour (upload size buckets plus ten-minute slices)
node scripts/load/alb-access-log-summary.mjs --from 14:00 --to 15:00 --route 'device/screenshot'
# Heartbeats per minute at a period start
node scripts/load/alb-access-log-summary.mjs --from 13:55 --to 14:15
# Re-summarize an already-downloaded day, machine output
node scripts/load/alb-access-log-summary.mjs --files "$TEMP/schoolpilot-alb-access-logs/2026-09-03" --from 14:15 --to 14:45 --date 2026-09-03 --json
```

## Launch cost rollout

The TURN repair exception described next was superseded on 2026-09-28 by
[parking](CLASSPILOT_TURN_PARKING.md). Legacy TURN decommission is
Lane D of the [competitive roadmap](SCHOOLPILOT_COMPETITIVE_ROADMAP.md).
The August 24, 2026 TURN repair exception is retained here as historical plan
evidence. Its authorization cannot be reused. The reviewed exception had these
constraints. It may replace only
`module.turn[0].aws_instance.turn["a"]`,
`module.turn[0].aws_instance.turn["b"]`,
`module.turn[0].aws_eip_association.turn["a"]`, and
`module.turn[0].aws_eip_association.turn["b"]`; create only
`module.turn[0].aws_cloudwatch_metric_alarm.log_storage["a"]` and
`module.turn[0].aws_cloudwatch_metric_alarm.log_storage["b"]`; and update only
`module.turn[0].aws_cloudwatch_metric_alarm.node_status["a"]` and
`module.turn[0].aws_cloudwatch_metric_alarm.node_status["b"]` plus
`module.turn[0].aws_cloudwatch_dashboard.turn`. The reviewed saved plan must be
exactly `6 to create, 3 to update, 4 to destroy`, with no unrelated changes. It
must never replace or update EIPs, DNS, the TURN secret, IAM, security groups,
ECS, API, worker, or frontend resources; the exact TURN dashboard address may
update but must not be replaced. Take and verify the normal external DPAPI and
OneDrive AES-GCM state backups before plan, before apply, and after apply.
Authorization alone is not completion: mark this exception completed and
non-reusable only after the exact saved-plan apply, node/network/TLS/telemetry
validation, and a fresh no-op plan all pass. See [TURN operations](CLASSPILOT_TURN_OPERATIONS.md).

The same literal `prevent_destroy` that guards the instances and the TURN secret
now also guards both Elastic IPs, both EIP associations, both Route 53 records,
the security group, and the IAM role, policy, SSM attachment, and instance
profile.
Because the exception replaces the instances and both EIP associations, it
cannot be executed without the reviewed Lane D decommission PR that removes
those literals. Deleting the module block would bypass `prevent_destroy`, so
decommission must remove the literals explicitly.

The staged WAF/alarm, public-ECS, NAT, Route 53, Redis, synthetic-load, state
recovery, supervision, and rollback procedure lives in
[AWS cost rollout](AWS_COST_ROLLOUT_OPERATIONS.md). The thresholds and
Chromebook onboarding hold live in [scale readiness](SCALE_READINESS.md). Follow those two files as one contract.
`production.tfvars` is the canonical current Terraform-managed production
baseline; never preload a future cost-stage value. Introduce each future value
only through that phase's separately reviewed plan or PR, and never run an
unreviewed production apply. Use a unique external saved plan, verified DPAPI
and OneDrive AES-GCM state backups before plan/before apply/after apply, and
the exact phase shape from the runbook.

Useful safety checks:

```powershell
node scripts/load/prepare-classpilot-load-test.mjs --help
npm run load:classpilot -- --validate-fixtures
npm run load:kiosk -- --validate-fixtures
pwsh -NoProfile -File tests/terraform-state-backup.test.ps1
pwsh -NoProfile -File tests/aws-rollout-automation.test.ps1
terraform -chdir=infra init -backend=false -lockfile=readonly -input=false
terraform -chdir=infra validate -no-tests
```

## Common Deployment Pitfalls

1. **Wrong source directory** — ALWAYS build from this repo. The obsolete GoPilot server prototype uses raw `pool.query()` with columns that don't exist in the production database.
2. **ECR login expired** — `docker push` will fail with auth errors if you haven't run `ecr get-login-password` recently. Tokens last 12 hours.
3. **ECS service names** — Must be exactly `schoolpilot-production-api` and `schoolpilot-production-scheduler-worker` in cluster `schoolpilot-production-cluster`.
4. **Task not starting** — If the new task fails to start after a service update, ECS rolls back automatically. Check CloudWatch logs for the failed task. Common causes: missing env vars, bad image, port mismatch. Rollback is explicit now, and must target **the family that was actually serving** — if the captured API definition is in `schoolpilot-production-api-emergency`, use that exact ARN. Switching to `schoolpilot-production-api:<previousRev>` would select a different family. `deploy.sh` captures the live definition into `PRODUCTION_ROLLBACK_API_TASK_DEFINITION` before mutating anything; by hand, read the current ARN from `describe-services` first and roll back within that family, or `schoolpilot-production-scheduler-worker:<previousRev>` for the worker.
5. **CloudFront invalidation costs** — The frontend release tool computes the scoped paths and waits for invalidation. Keep unrelated cached assets available to open sessions.
6. **Windows path conversion** — Always prefix AWS CLI commands with `MSYS_NO_PATHCONV=1` in Git Bash on Windows, otherwise paths like `--paths "/*"` get mangled.
7. **Task definition env vars** — The ECS task definition must include `CLIENT_URL=https://school-pilot.net` and `GOOGLE_CALLBACK_URL=https://school-pilot.net/api/auth/google/callback`. These are set in the task definition, not in the container.
8. **Dockerfile CMD** — Runs `node dist/index.js` directly (no `drizzle-kit push`). Production schema changes are handled by the explicit deploy-script migration task (`RUN_MIGRATIONS_ONLY=true`), not by normal web/worker startup.
9. **Busy main checkout** — When `C:\GitHub\SchoolPilot` is on another branch or dirty (another agent may be working there), run `deploy.sh` and `deploy-classpilot-runtime-config.ps1` from a separate clean `main` worktree, when that branch is available. Fetch and fast-forward it to `origin/main`. Both tools derive their repository root from their own location and their guards are cwd-relative. Never switch or reset the main checkout out from under the other session.
10. **Runtime-config apply capacity** — `deploy-classpilot-runtime-config.ps1` applies at any admitted API desired count (1–3 ordinary; 1–6 only inside an admitted protected-window run). Under the ordinary `100/200` configuration ECS surges before it drains, so `describe-target-health` showing up to twice the desired count healthy mid-rollout is expected and passes: the converging gate mirrors the live deployment configuration (`[max(1, N-1), floor(N × maximumPercent / 100)]`) and only the pre-mutation and post-convergence gates require exactly N. A run that still ends `apply_failed_manual_intervention` leaves autoscaling suspended and the DynamoDB lease `mutating` by design; follow the [ClassPilot runtime-config recovery procedure](CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md) before any new Plan.
11. **Wave-1 product flags** — `CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE`/`_SCHOOL_IDS`, `PASSPILOT_RULES_MODE`, `PASSPILOT_APPOINTMENTS_MODE`, `PASSPILOT_REPORTS_MODE`, `CLASSPILOT_DAILY_USAGE_ROLLUP_MODE`, `CLASSPILOT_USAGE_ROLLUP_MODE` and `CLASSPILOT_DIGITAL_USAGE_MODE` change in production only through `scripts/deploy-product-runtime-config.ps1` (Plan → review → Apply → verify, Rollback; [product runtime-config operations](PRODUCT_RUNTIME_CONFIG_OPERATIONS.md)). `deploy.sh` carries each service's live values forward and Terraform never sets them, so never hand-edit a task definition. The tool refuses every other name (capabilities, TURN, My Desk, RLS), refuses activation of an RLS-gated feature until its tables are admitted on both API and worker, and needs clean shadow evidence to promote the daily rollup. Main must not move between its Plan and Apply; it shares the ClassPilot runtime-config lease.

## Error monitoring

Centralized error tracking in `src/services/errorMonitor.ts`. `trackError(category, error, context?, options?)` normalizes and redacts the event once, then (1) records it in bounded per-fingerprint counters for threshold alerting, (2) persists the sanitized event durably to the `error_logs` Postgres table unless `options.persist === false`, and (3) forwards the sanitized error to Sentry **if** Sentry is enabled.

**Wired into:**
- `process.on("uncaughtException"/"unhandledRejection")` in `src/index.ts` via bounded fatal shutdown
- Express error middleware (`src/middleware/errorHandler.ts`) — 500-level errors only
- All scheduler catch blocks (`src/services/scheduler.ts`)
- SendGrid failures (`src/services/email.ts`) — with recursion guard to avoid alert→email→fail→alert loops
- WebSocket connection errors and non-noise internal message-processing errors (`src/realtime/websocket.ts`)
- Security detections as safe `security_event` notifications (`src/services/securityMonitor.ts`)
- Main/scheduler DB pool failures as non-persisted `database_connectivity` events
- Background subsystem health failures as non-persisted `health_failure` / `database_connectivity` events
- SchoolPilot browser runtime telemetry via `POST /api/monitoring/browser-error`
- ClassPilot extension runtime telemetry via device-authenticated `POST /api/classpilot/extension/runtime-error` (also aliased from `/api/extension/runtime-error`)

**Categories and thresholds** (matching fingerprint errors in 5-min window to trigger alert): `fatal_process_error`: 1, `api_error`: 5, `client_error`: 10, `scheduler_failure`: 2, `email_failure`: 3, `websocket_error`: 10, `security_event`: 1, `database_connectivity`: 1, `health_failure`: 1, `browser_runtime_error`: 10, `extension_runtime_error`: 25. Fingerprints are built from category, safe error code, normalized top stack frame, path, job, and message type. Cooldown is fingerprint-scoped and starts only after at least one configured alert channel confirms delivery; if all channels fail, the monitor uses a short 2-minute retry cooldown.

**Alerts sent to:** Email (SendGrid -> `ADMIN_EMAIL`) and Telegram bot (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`) when configured. Delivery results are checked explicitly; missing SendGrid or Telegram config is not treated as delivered. Telegram alerts are plain text, truncated under platform limits, and picked up by Claude Code Channels for AI-powered diagnosis.

**Redaction boundary:** messages, stacks, paths, safe context, email alerts, Telegram alerts, and Sentry capture are scrubbed before leaving the monitor. Query strings are stripped; emails, IPs, bearer/JWT/API-token shapes, and secret-looking assignments are redacted. Context JSONB stores only safe keys (`job`, `eventId`, `eventType`, `messageType`, `errorCode`, `source`, `surface`, `component`, `release`, `clientVersion`, `extensionVersion`, `chromeVersion`) while request/school/user correlation stays in dedicated columns. Do not pass student names, student emails, device ids, raw request bodies, raw URLs, localStorage, form/input values, or arbitrary context into monitor call sites.

**Stats + metrics:** `errorMonitor.getStats()` exposes captured, persisted, persistFailed, dropped, alertAttempted, alertDelivered, alertFailed, and cooldownSuppressed counters by total/category/fingerprint. Fingerprint samples are bounded to 5 sanitized entries each and active fingerprints are capped/evicted by quiet low-priority entries first. The monitor emits CloudWatch Embedded Metric Format JSON to stdout every 60 seconds with namespace `SchoolPilot/Monitoring`: fleet interval counts on dimensions `Environment` and `Service` are the metrics, while per-process lifetime totals and `InstanceId` stay log fields; EMF output never includes message text, stack, path, user id, school id, or context. When `REDIS_URL` is configured, monitor alert thresholds and cooldown election are shared across ECS tasks under `${REDIS_PREFIX}:monitor:*`; if Redis is missing/unhealthy, aggregation degrades to the local Phase 2 behavior without blocking boot.

**Health endpoints:** `/livez` is lightweight ECS container liveness; keep it session-free and DB-free. The ALB initially uses `/livez`; activate the separate cached `/readyz` response only through [API pool readiness operations](API_POOL_READINESS_OPERATIONS.md) after the candidate backend and every task's readiness startup marker are verified. `/readyz` performs no request-time DB query. Do not expose either endpoint through a dedicated CloudFront behavior. Public `/health` is cheap external uptime (`{"status":"ok"}`) for Route53/synthetic checks. Detailed operational health is available only with `HEALTH_TOKEN` via `x-health-token` or `?token=...`; that detailed response includes `recentErrors`, `checks.alerting`, and `checks.monitoring` with monitor stats/runtime metadata plus `checks.monitoring.aggregation` (`mode: "redis" | "local"`). If alerting is the only degraded check, detailed `/health` still returns HTTP 200 with JSON status `degraded`; core subsystem failures return 503.

**Super Admin Monitoring panel:** `/super-admin/monitoring` is the read-only operations view for the monitor. APIs live under `/api/super-admin/monitoring/*` and require super-admin auth plus the existing RLS super-admin bypass. The Schools page may show only a compact status chip/link, not a large monitoring dashboard section. Phase 4A intentionally has no schema changes, no mute/acknowledge controls, and no durable incident workflow; live fingerprint history comes from in-process/Redis aggregation, while recent events come from existing sanitized `error_logs`. The panel must never show raw query strings, request bodies, tokens, emails, IPs, student names, device ids, unrestricted context, or raw security-event details.

**Browser/extension runtime telemetry:** Browser telemetry is operational error capture only, not analytics. The web app installs capture before React renders, dedupes per tab, and sends only sanitized message/stack/path/component/release/browser details. The ClassPilot extension service worker imports the vendored Sentry browser SDK and initializes it only when the extension DSN is configured; it is the only network sender. Offscreen/content-script failures relay typed sanitized reports through `chrome.runtime.sendMessage`, and content scripts must never capture arbitrary host-page JavaScript errors. Extension release remains separate: confirm the live Chrome Web Store version, bump `ClassPilot/extension/manifest.json`, run `./extension/package-extension.sh`, inspect the archive, upload, and wait for review.

**Fatal behavior:** uncaught exceptions, unhandled rejections, and startup failures are recorded as `fatal_process_error`, flushed with a 5-second bound, and then the process exits nonzero with a 10-second force-exit fallback. Do not continue serving traffic after a fatal process error.

### Durable error logs + request correlation
- **`error_logs` table** (`src/schema/shared.ts`) — every persisted tracked error stores sanitized category, message, stack, `request_id`, method, pathname-only path, status_code, school_id, user_id, and safe JSONB `context`. Queryable in your own DB (same FERPA posture as `audit_logs`). Purged after 30 days by `purgeOldErrorLogs()` in the scheduler. This is the durable counterpart to the 5-minute in-memory window.
- **Request correlation id** (`src/middleware/requestId.ts`) — mounted first; assigns/honors `X-Request-Id`, echoes it in the response header, and the error handler returns it in the JSON error body (`{ error, requestId }`). To trace a reported problem: get the `requestId` from the user → query `error_logs` by `request_id` or grep CloudWatch for `req:<id>`.

### Sentry activation gate

`src/services/sentry.ts`. **No-op unless `SENTRY_DSN` is set.** Sentry is a third-party subprocessor — do NOT set the DSN in production until (1) Sentry's DPA is signed and (2) Sentry is on the public subprocessors list. Even when enabled, `beforeSend` scrubs PII (emails, JWT/API tokens) and drops request bodies/cookies/headers/user identifiers so student data does not leave the system. The durable `error_logs` table records sanitized persisted events independently of Sentry.

## Terraform state and secrets

Keep application secrets in protected runtime storage. Terraform references
their deterministic or external SSM ARNs. The topology-derived `REDIS_URL`
is the only Terraform-managed application SecureString.

When adopting the detached-secret configuration for the first time, use the
reviewed [state detachment script](../scripts/terraform-detach-application-secret-state.ps1)
with verified DPAPI and AES-GCM backup paths before the first plan. It removes
the ten historical `module.ecs.aws_ssm_parameter.*` state bindings while
preserving live parameters and the Redis binding. This keeps previous secret
values out of the first plan's JSON. Follow the
[state-recovery procedure](AWS_COST_ROLLOUT_OPERATIONS.md) for backup, review
and exact saved-plan application.
