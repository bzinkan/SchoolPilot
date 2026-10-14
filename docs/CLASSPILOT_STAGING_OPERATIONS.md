# Isolated ClassPilot staging

The synthetic reliability stack serves `https://staging.school-pilot.net`.
Its HTTPS ALB origin is `api-origin.staging.school-pilot.net`. It uses a new
VPC, database, Redis, ECR repository, ECS cluster, S3 buckets, CloudFront
distribution and environment-scoped credentials. The existing public Route53
zone is read for new staging records and certificate validation only. Never
copy production data, secret values, state bindings or task definitions.

## Isolated workspace and stopped bootstrap

Create an ACL-restricted execution directory outside the repository. Keep its
state, plans, receipts and encrypted recovery copies private. Run:

```powershell
.\scripts\prepare-classpilot-staging.ps1 -PrivateRoot $stagingPrivateRoot
$stagingWorkspace = Get-Content (Join-Path $stagingPrivateRoot 'staging-workspace.json') -Raw | ConvertFrom-Json
$env:TF_DATA_DIR = $stagingWorkspace.dataDirectory
$env:TF_WORKSPACE = 'default'
Remove-Item Env:TF_CLI_ARGS,Env:TF_CLI_ARGS_init,Env:TF_CLI_ARGS_plan,Env:TF_CLI_ARGS_apply -ErrorAction SilentlyContinue
if ($stagingWorkspace.environment -ne 'staging') { throw 'Unexpected workspace environment' }
$implicitState = Join-Path $stagingWorkspace.terraformRoot 'terraform.tfstate'
if (Test-Path -LiteralPath $implicitState) { throw 'Unexpected snapshot-local state; stop and reconcile private custody' }
if (Test-Path -LiteralPath $stagingWorkspace.statePath) { throw 'Initial bootstrap requires absent explicit staging state' }
terraform ('-chdir=' + $stagingWorkspace.terraformRoot) init '-backend=false' '-input=false' '-lockfile=readonly'
terraform ('-chdir=' + $stagingWorkspace.terraformRoot) validate '-no-tests'
terraform ('-chdir=' + $stagingWorkspace.terraformRoot) plan '-input=false' `
  '-var-file=staging.tfvars' '-var=staging_bootstrap=true' `
  '-var=ecs_desired_count=0' '-var=worker_desired_count=0' `
  ('-state=' + $stagingWorkspace.statePath) ('-out=' + $stagingWorkspace.bootstrapPlanPath)
# Apply only after saved-plan review and the encrypted before backup.
terraform ('-chdir=' + $stagingWorkspace.terraformRoot) apply '-input=false' `
  ('-state=' + $stagingWorkspace.statePath) $stagingWorkspace.bootstrapPlanPath
if (-not (Test-Path -LiteralPath $stagingWorkspace.statePath -PathType Leaf) -or
    (Test-Path -LiteralPath $implicitState)) { throw 'Explicit staging state custody did not converge' }
```

The preparer refuses existing workspace/state/data/receipt paths, inherited or
other-user directory access, and reparse-point traversal. It copies only
source files and the two required capacity/RLS JSON configurations. It does not
read or copy the repository's `.terraform` or `terraform.tfstate`. Do not run
`init`, `plan`, `apply`, `state` or `destroy` in the repository infrastructure
directory. Terraform mock tests also belong in a separate external workspace;
`terraform test` uses mocks and must never be substituted with a real apply.

Review the saved bootstrap plan for new staging names, zero running API/worker
tasks, new network/storage/security resources and staging-only DNS names. Any
production resource update, deletion, secret reference or state binding stops
the run. Root applies the reviewed saved plan and verifies the explicit staging
state location, service counts and unchanged production state identity. Back up
private state and receipts after each mutation using the protected DPAPI and
AES recovery procedure; never print secret values or decrypted backups.
Before/After `RecoveryPath` values must be under
`$OneDrive/SchoolPilot-Recovery`, as enforced by
`scripts/terraform-state-backup.ps1`.

Every later plan **and saved-plan apply** must include
`('-state=' + $stagingWorkspace.statePath)` explicitly. The saved plan alone
does not reliably preserve the plan command's local state path. Before either
command, require the explicit state file to exist and refuse any
`terraform.tfstate` inside the isolated snapshot. Preserve encrypted Before and
After copies. The first staging apply wrote state inside the isolated snapshot;
the operator encrypted/backed it up, verified its hash, and moved it to the
receipt's explicit state path. Production state remained unchanged. Do not
repeat that recovery by creating a second empty staging state or reapplying a
create-only plan.

## Image, schema and fresh credentials

Both task templates accept `api_image_digest=sha256:<64 lowercase hex>` and
render the same ECR digest. Staging serving counts cannot be nonzero without a
digest. The stopped bootstrap may register an unused `:latest` template before
the repository has an image; it must never serve traffic from that template.

Create fresh SecureStrings only under `/schoolpilot/staging/`:

- `SESSION_SECRET`, `JWT_SECRET`, `STUDENT_TOKEN_SECRET` and
  `GOOGLE_OAUTH_ENCRYPTION_KEY` contain new random staging material.
- `DATABASE_URL` ultimately names the isolated `schoolpilot_staging` database
  and a restricted runtime role. The RDS master is `schoolpilot_admin`; its
  managed password remains in Secrets Manager. Use a separate one-off migration
  task with temporary owner credentials to create/migrate the fresh schema and
  restricted role, then bind the runtime URL before serving. Require
  `sslmode=verify-full`; staging tasks trust `/app/rds-ca.pem` through
  `NODE_EXTRA_CA_CERTS` without changing production TLS configuration.
- `REDIS_URL` is the sole Terraform-managed, staging-derived SecureString.

With `provider_secrets_enabled=false`, provider keys are omitted from ECS
secret references and their environment values are empty. Google OAuth client
ID, email, Stripe, AI, Telegram and Sentry remain unconfigured. No production
provider credentials, Google integrations or imported school records are used.
My Desk, AI imports and TURN stay off. Password-authenticated synthetic staff
accounts and device enrollment exercise the reviewed application routes.

Push the reviewed candidate to staging ECR, capture its registry digest, and
bind backend source identity, frontend build hash, packed extension hash and
test artifact identities in the private run receipt. Run the candidate's
checksum-ledger migration-only entrypoint in a controlled staging task; serving
templates keep `RUN_MIGRATIONS_ON_STARTUP=false`. Verify all 129 admitted tenant
tables have their expected forced RLS/policies before starting API or worker.
Capture one-off task completion and exit status before enabling serving counts.

Task-definition changes are intentionally ignored by the existing ECS services.
After rendering digest-pinned task definitions, explicitly select those exact
staging API and worker revisions with `aws ecs update-service`; a Terraform
apply alone does not switch an existing service's task definition. Never use
production service names or the production deployment helper for this staging
selection.

## Session and request isolation

Both staging roles use `COOKIE_NAME=schoolpilot.staging.sid` and empty
`COOKIE_DOMAIN`, producing a secure host-only session cookie. Runtime rejects
the production cookie name or a parent-domain staging cookie. Login, logout and
the harness use the same exact name. A browser may still send the production
parent-domain cookie to a sibling hostname; CloudFront forwards only the
staging session plus `AWSALB`/`AWSALBCORS` affinity cookies to API and socket
origins. The production cookie is excluded. Use dedicated synthetic profiles.
Set `LOAD_SESSION_COOKIE_NAME=schoolpilot.staging.sid` explicitly in the private
fixture, cohort-selection and load-runner process environments.

CloudFront routes `/api/*`, `/ws` and `/gopilot-socket/*` to the staging ALB
without caching; staging forwards required request headers including CSRF,
enrollment and capability headers. The S3 behavior alone rewrites SPA paths.
ACM covers the staging frontend and API origin; ALB ingress permits only the
CloudFront origin-facing prefix list. No separate CloudFront readiness behavior
is added. Validate public login/logout, CSRF, enrollment, socket authentication,
foreign-school denial and cookie isolation before load.

## Fixed capacity and cleanup

Optional remote generator custody is in `infra/staging-load-generator.tf`.
Enable it only in the next reviewed staging plan with
`enable_staging_load_generator=true` and the exact `staging_load_run_id`.
The private, encrypted, versioned bucket is
`schoolpilot-staging-load-135775632425`; lifecycle rules expire current and
noncurrent campaign objects after one day. The generator task role can only
GET `runs/<campaign>/<subrun>/inputs/*` and PUT
`runs/<campaign>/<subrun>/results/*`. It has no SSM, database or bucket-list
permission. Use a new `40-<id>`, `500-<id>` or `800-<id>` subrun each time, and
exact-key downloads/uploads. Its separate ECS execution role handles image
pulls/logs; its 2-vCPU/4-GiB load task does not count as serving API capacity.
Export artifacts before expiry and remove this optional custody stack during
the same reviewed teardown.

The profile uses three API tasks at 1024 CPU/2048 MiB and one worker at
512 CPU/1024 MiB; smoke may use one API. It explicitly selects Single-AZ
`db.t4g.medium`, 100 GiB gp3 capped at 100, one `cache.t4g.micro`, two ALB
availability zones, public task networking, no NAT, no Redis replica and no
Container Insights. `DB_POOL_MAX=20` matches observed environment configuration;
the runtime role caps remain API main16 and worker main2, with scheduler5.

All automatic/scheduled API scaling is suspended for fixed-size acceptance.
The six-task reviewed maximum is retained, but a capacity result must record
the actual constant task counts. Do not let autoscaling hide a failed three-task
gate. Start one API only after image/schema/secret gates, then select the exact
three-API/one-worker capacity profile before the 40/500/800 campaign. The fixed
ClassPilot capability flags are staging-only. Follow
[the reliability gates](./CLASSPILOT_RELIABILITY.md) for measured latency,
freshness, isolation, twenty rendered dashboards and managed-device evidence.

Export private result artifacts and stop services after the authorized test
window. Review a destroy plan from the same external workspace and explicit
staging state; it must contain staging resources only. Remove the disposable
stack, new staging DNS/certificate resources and separately created staging
SecureStrings after evidence export. The private My Desk bucket deliberately
has `force_destroy=false`; verify it is empty rather than weakening protection.
Retain encrypted state/recovery evidence separately. An RDS stop is temporary
and retains storage charges; it is not stack removal.
