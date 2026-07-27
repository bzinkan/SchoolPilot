# AWS Cost-Reduction Rollout Operations

This runbook is the production execution contract for the launch-safe AWS cost
reduction. It is deliberately fail-closed. A passing load summary is necessary
but not sufficient; the corresponding AWS monitor result, rollback evidence,
deployment checks, snapshots, and cost checks must also pass.

## Current medium decision path: engineering capacity acceptance

The active medium-capacity decision is a single engineering acceptance run,
not the historical supervisor certification chain. The frozen application
baseline is commit `f5759465b5a2ae43d4808c9aa53acc43c3c375b0`; its tooling-only
successor may change only load/deployment tooling, tests, this runbook, and
`docs/SCALE_READINESS.md`. Application, frontend, SQL, dependency, Docker, and
Terraform content must remain byte-identical to that baseline.

Deploy the merged successor once with the strict rollback-only tile-plan gate:

```bash
bash scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-gate --capacity-acceptance-release
bash scripts/deploy.sh production --frontend \
  --capacity-acceptance-frontend-sha <full-40-hex-merged-sha>
```

The capacity-release path builds and registers the candidate, runs the
authorization SQL plan gate before migration, deploys and converges the API and
worker, and reruns the gate from the active revision. It does not require or
consume an observation, reread, supersession, rehearsal receipt, offline
preparation rehearsal, host smoke, certification receipt, chain root, or
attestation. A gate, migration, convergence, identity, rollback, or restoration
failure remains authoritative and fail-closed.

Run the two-stage decision through
`scripts/load/start-classpilot-capacity-acceptance.ps1`. `Validate` is
non-mutating. One `Run` owns fixture refresh/verification, the harness and AWS
monitor start-gate order, a temporary six-API capacity pin, PostgreSQL `57014`
evidence, cause-specific rollback, and exact scaling restoration:

```powershell
pwsh -NoProfile -File scripts/load/start-classpilot-capacity-acceptance.ps1 `
  -Mode Validate -ConfigPath C:\absolute\private\capacity-acceptance.json
pwsh -NoProfile -File scripts/load/start-classpilot-capacity-acceptance.ps1 `
  -Mode Run -ConfigPath C:\absolute\private\capacity-acceptance.json
```

Create all run roots as disjoint, ACL-private directories. Bootstrap the
continuity root exactly once; it must initially contain only the two durable
authority files:

```powershell
$AuthorityRoot = Join-Path $env:LOCALAPPDATA "SchoolPilot\load-gates\launch-safe-20260711"
$AcceptanceRoot = Join-Path $env:LOCALAPPDATA ("SchoolPilot\capacity-acceptance\" + [Guid]::NewGuid().ToString("N"))
$ContinuityRoot = Join-Path $AcceptanceRoot "continuity"
$SupportRoot = Join-Path $AcceptanceRoot "support"
$EvidenceParent = Join-Path $AcceptanceRoot "evidence"
$EvidenceRoot = Join-Path $EvidenceParent "run"
$ConfigRoot = Join-Path $AcceptanceRoot "config"
$ReportRoot = Join-Path $AcceptanceRoot "report"
New-Item -ItemType Directory -Path $ContinuityRoot,$SupportRoot,$EvidenceParent,$ConfigRoot,$ReportRoot |
  Out-Null
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($Root in @($AcceptanceRoot,$ContinuityRoot,$SupportRoot,$EvidenceParent,$ConfigRoot,$ReportRoot)) {
  & icacls.exe $Root /inheritance:r /grant:r "*${Sid}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not make $Root private" }
}
foreach ($Name in @("fixture-state.private.json","fixture-ownership.private.json")) {
  Copy-Item -LiteralPath (Join-Path $AuthorityRoot $Name) -Destination (Join-Path $ContinuityRoot $Name)
  $SourceHash = (Get-FileHash -LiteralPath (Join-Path $AuthorityRoot $Name) -Algorithm SHA256).Hash
  $CopyHash = (Get-FileHash -LiteralPath (Join-Path $ContinuityRoot $Name) -Algorithm SHA256).Hash
  if ($SourceHash -cne $CopyHash) { throw "$Name changed during continuity bootstrap" }
}
if (@(Get-ChildItem -LiteralPath $ContinuityRoot -Force).Count -ne 2) {
  throw "Continuity root contains an unauthorized artifact"
}
if (Test-Path -LiteralPath $EvidenceRoot) {
  throw "The exact evidence root must remain absent until Run creates it"
}
```

Copy the hash-identical fixture config, fixture-password DPAPI document,
super-admin DPAPI document, and matching operation document into the separate
support. Those four files must be its only direct children. Never print their
contents. Capture the exact active and prior API/worker revision ARNs. The
runner independently re-describes all four ACTIVE revisions and rejects CPU,
memory, network mode, role, container, environment-name, or secret-name
incompatibility. It also reads and validates the committed 05:45/10:00 ET
schedule and 70% CPU policy directly; no operator-authored schedule receipt or
canonical hash is required.

The ACL-private capacity config has this exact shape. Replace every placeholder,
use the source/destination SHA-256 values, use the post-deploy active and
captured rollback revisions, and choose same-width start windows near 22:30 ET
and 01:15 ET on consecutive local dates:

```json
{
  "schemaVersion": 1,
  "engineeringAcceptance": true,
  "runId": "REPLACE_UNIQUE_CAMPAIGN_ID",
  "baseUrl": "https://school-pilot.net",
  "evidenceRoot": "C:/absolute/private/evidence",
  "reportPath": "C:/absolute/private/report/capacity.txt",
  "fixture": {
    "authorityFixtureId": "launch-safe-20260711",
    "authoritySourceRoot": "C:/absolute/private/launch-safe-20260711",
    "authorityStateSha256": "REPLACE_64_HEX",
    "authorityOwnershipSha256": "REPLACE_64_HEX",
    "configPath": "C:/absolute/private/support/fixture-config.json",
    "configSha256": "REPLACE_64_HEX",
    "continuityRoot": "C:/absolute/private/continuity",
    "stateSha256": "REPLACE_SAME_AUTHORITY_STATE_HASH",
    "ownershipSha256": "REPLACE_SAME_AUTHORITY_OWNERSHIP_HASH",
    "support": {
      "root": "C:/absolute/private/support",
      "fixturePasswordsPath": "C:/absolute/private/support/fixture-passwords.dpapi.json",
      "fixturePasswordsSha256": "REPLACE_64_HEX",
      "superAdminPasswordPath": "C:/absolute/private/support/temporary-local-password.dpapi.json",
      "superAdminPasswordSha256": "REPLACE_64_HEX",
      "superAdminOperationPath": "C:/absolute/private/support/operation.json",
      "superAdminOperationSha256": "REPLACE_64_HEX"
    }
  },
  "deploymentIdentity": {
    "applicationGitSha": "REPLACE_40_HEX",
    "deployedImageDigest": "sha256:REPLACE_64_HEX",
    "apiTaskDefinitionArn": "REPLACE_ACTIVE_API_REVISION_ARN",
    "workerTaskDefinitionArn": "REPLACE_ACTIVE_WORKER_REVISION_ARN",
    "rollbackApiTaskDefinitionArn": "REPLACE_PRIOR_API_REVISION_ARN",
    "rollbackWorkerTaskDefinitionArn": "REPLACE_PRIOR_WORKER_REVISION_ARN"
  },
  "expectedGeneratorPublicIp": "REPLACE_IPV4",
  "notificationTopicArn": "arn:aws:sns:us-east-1:135775632425:REPLACE_TOPIC",
  "resources": {
    "region": "us-east-1",
    "accountId": "135775632425",
    "cluster": "schoolpilot-production-cluster",
    "apiService": "schoolpilot-production-api",
    "workerService": "schoolpilot-production-scheduler-worker",
    "rdsInstanceId": "REPLACE_RDS_ID",
    "redisCacheClusterId": "REPLACE_CACHE_CLUSTER_ID",
    "redisReplicationGroupId": "REPLACE_REPLICATION_GROUP_ID",
    "vpcId": "REPLACE_VPC_ID",
    "wafWebAclName": "REPLACE_WEB_ACL_NAME",
    "wafDeviceClassifierMetricName": "REPLACE_METRIC",
    "wafDeviceRuleMetricName": "REPLACE_METRIC",
    "wafApiRuleMetricName": "REPLACE_METRIC",
    "cloudFrontDistributionId": "REPLACE_DISTRIBUTION_ID",
    "targetGroupArn": "REPLACE_TARGET_GROUP_ARN",
    "route53HealthCheckId": "REPLACE_HEALTH_CHECK_ID",
    "route53AlarmName": "REPLACE_ALARM_NAME",
    "expectedNatGatewayCount": 2,
    "expectedRoute53MeasureLatency": true,
    "expectedEcsAssignPublicIp": false,
    "ecsTaskSubnetIds": ["subnet-REPLACE_A", "subnet-REPLACE_B"],
    "expectedRedisNodeType": "cache.t4g.small",
    "expectedRdsInstanceClass": "db.t4g.medium",
    "expectedActiveApiTaskDefinitionArn": "REPLACE_ACTIVE_API_REVISION_ARN",
    "expectedActiveWorkerTaskDefinitionArn": "REPLACE_ACTIVE_WORKER_REVISION_ARN"
  },
  "stages": [
    {"stage":"500","runId":"REPLACE_WAF500_ID",
      "trafficStartNotBeforeUtc":"REPLACE_UTC","trafficStartNotAfterUtc":"REPLACE_UTC"},
    {"stage":"800","runId":"REPLACE_WAF800_ID",
      "trafficStartNotBeforeUtc":"REPLACE_UTC","trafficStartNotAfterUtc":"REPLACE_UTC"}
  ]
}
```

The only accepted profiles are Waf/500 at `510` sockets for `1,800` seconds
with `25` targets per class, followed by Waf/800 at `810` sockets for `5,400`
seconds with `40` targets per class. Waf/800 must span the local 01:30 purge
and 02:00 rollup. Waf/500 rejection prevents Waf/800. A stage may receive one
in-process pretraffic retry only when no start gate or progress record was
released and exact restoration is proven; traffic itself is one-shot.

The harness and monitor identify these runs with `engineeringAcceptance=true`,
`diagnosticOnly=false`, and `certificationEligible=false`. CloudWatch,
PostgreSQL logs, workload summaries, identity checks, and restoration state are
the acceptance evidence. Performance Insights remains Standard-mode
informational context only; query-ID discovery, Advanced mode, PI ratios,
supervisor sealing, and predecessor chaining are not acceptance gates.

Success is named **SchoolPilot 800-device engineering capacity acceptance on
`db.t4g.medium`**. It is not a supervisor-sealed certification and does not
lift the managed-Chromebook or real-student onboarding hold. A workload,
provider-evidence, or restoration failure produces the terminal engineering
report; after the tooling successor merges, it does not authorize another code
remediation, workload retry, RDS resize, cache change, threshold relaxation, or
xlarge fallback.

All older diagnostic, certification, observation-reread, supersession,
rehearsal-receipt, chain, seal, and Database Insights Advanced procedures below
remain historical/inspection material only. They cannot admit, invalidate, or
seed this engineering acceptance.

## Non-negotiable boundaries

- Use one Terraform operator and the local backend through launch.
- Run rollout, capacity-acceptance, and credential operations from PowerShell
  7.5 or newer (`pwsh`), not Windows PowerShell 5.1 (`powershell.exe`).
  Date-preserving AWS evidence decoding requires 7.5. Historical diagnostic,
  certification, and PI-finalization tools retain the same runtime floor but
  are not active admission paths.
- Use the committed AWS provider `5.100.0` lock file. Never run
  `terraform init -upgrade` during this rollout.
- Deploy the application only from a clean merged `main`. For this medium
  decision, use the capacity-release command above and publish the matching
  frontend without changing the checkout. Backend and frontend bind the
  identical release SHA; API and worker bind the identical image digest. Do
  not substitute the historical observation/rehearsal/receipt path, and do not
  package or upload the ClassPilot extension.
- Keep RDS and Redis private. Public IPv4 is only for outbound egress from the
  staged ECS API and worker tasks; the ALB remains the only inbound API path.
- Keep Route 53 DNS, nameservers, CloudFront routing, the HTTPS `/health`
  check, and its alarm. The Route 53 phase disables only latency measurement.
- Keep Container Insights through testing and the first five live school days.
- Do not perform deferred RDS/API downsizing, ARM64, reservations, remote-state
  migration, HA changes, or an extension release.
- Real-student onboarding remains blocked until managed Chromebooks pass the
  physical extension smoke gate in `docs/SCALE_READINESS.md`.

`production.tfvars` is the canonical current Terraform-managed production
baseline. Never preload a future cost-stage value or run an unreviewed
production apply. Each phase below introduces its future value through the
stated reviewed override or phase PR and uses a unique saved plan with the
required exact shape.

## External working directories

All sensitive or run-specific files stay outside the repository:

```powershell
$RolloutRoot = Join-Path $env:LOCALAPPDATA "SchoolPilot\aws-cost-rollout"
$PlanRoot = Join-Path $env:LOCALAPPDATA "SchoolPilot\terraform-plans"
$BackupRoot = Join-Path $env:LOCALAPPDATA "SchoolPilot\terraform-state-backups"
$RecoveryRoot = Join-Path $env:OneDrive "SchoolPilot-Recovery"
$LoadRoot = Join-Path $env:LOCALAPPDATA "SchoolPilot\load-gates"
New-Item -ItemType Directory -Force -Path $RolloutRoot,$PlanRoot,$BackupRoot,$RecoveryRoot,$LoadRoot | Out-Null
```

Use a filename-safe phase name. Saved plans use
`<UTC timestamp>-<12-char Git SHA>-<phase>.tfplan`:

```powershell
$Phase = "week1-waf-alarms"
$Timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$GitSha = (git rev-parse --short=12 HEAD).Trim().ToLowerInvariant()
$PlanPath = Join-Path $PlanRoot "$Timestamp-$GitSha-$Phase.tfplan"
if (Test-Path -LiteralPath $PlanPath) { throw "Unique saved plan already exists" }
```

Never reuse a plan, progress file, summary, run ID, evidence directory, or
rollback configuration.

## State backup and saved-plan gate

Enter the commands in this section inside a PowerShell 7.5+ (`pwsh`) session.
Confirm the host before handling the recovery credential:

```powershell
if ($PSVersionTable.PSVersion -lt [version]"7.5") {
  throw "PowerShell 7.5 or newer is required; reopen this runbook in a current pwsh."
}
```

Before every production plan, before every apply, and after every successful
apply, create both:

1. A CurrentUser-DPAPI backup under `$BackupRoot`.
2. An AES-256-GCM recovery copy under `$RecoveryRoot`.

The recovery passphrase is entered only in the visible PowerShell prompt. Store
it in the operator password manager; never put it in chat, shell history,
environment variables, config files, or logs.

Before the first rollout plan, prepare one CurrentUser-DPAPI `SecureString`
credential outside the repository from that visible prompt. Restrict it to the
current Windows user, record its SHA-256 in each rollback config, and set
`recoveryCredentialPreparedInteractively=true`. The automatic NAT rollback may
use this local DPAPI credential only to create its required before/after AES-GCM
state copies; never sync the credential itself or treat it as the off-device
recovery copy. Delete it after the rollout and confirm the passphrase remains in
the operator password manager.

```powershell
$RecoveryCredentialPath = Join-Path $RolloutRoot "rollout-recovery-passphrase.dpapi"
if (Test-Path -LiteralPath $RecoveryCredentialPath) { throw "Use a new rollout credential path" }
$RecoveryPassphrase = Read-Host -Prompt "Recovery passphrase (save it in the password manager now)" -AsSecureString
$ProtectedPassphrase = ConvertFrom-SecureString -SecureString $RecoveryPassphrase
[IO.File]::WriteAllText($RecoveryCredentialPath, $ProtectedPassphrase, [Text.UTF8Encoding]::new($false))
$CurrentUser = (& whoami.exe).Trim()
& icacls.exe $RecoveryCredentialPath /inheritance:r /grant:r "${CurrentUser}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not restrict the recovery credential ACL" }
$RecoveryCredentialSha256 = (Get-FileHash -LiteralPath $RecoveryCredentialPath -Algorithm SHA256).Hash.ToLowerInvariant()
```

```powershell
$RecoveryPath = Join-Path $RecoveryRoot "$Timestamp-$GitSha-$Phase-before-plan.aesgcm"
$RecoveryPassphrase = ConvertTo-SecureString (Get-Content -LiteralPath $RecoveryCredentialPath -Raw)
.\scripts\terraform-state-backup.ps1 -Mode Backup `
  -Phase "$Phase-before-plan" -Usage Before `
  -OutputDirectory $BackupRoot -RecoveryPath $RecoveryPath `
  -RecoveryPassphrase $RecoveryPassphrase
```

Repeat with unique `before-apply` and `after-apply` recovery paths immediately
before and after applying. The tool verifies DPAPI and AES-GCM round trips and
never prints state or hashes. Confirm OneDrive has synchronized the recovery
copy before proceeding.

Initialize only from the lock file:

```powershell
terraform -chdir=infra init -backend=false -lockfile=readonly -input=false
terraform -chdir=infra validate -no-tests
```

Review both the human plan and its JSON. Count create/update/delete actions,
including both sides of any replacement:

```powershell
terraform -chdir=infra show -no-color $PlanPath
$Plan = terraform -chdir=infra show -json $PlanPath | ConvertFrom-Json -Depth 100
$Changes = @($Plan.resource_changes | Where-Object { $_.change.actions -notcontains "no-op" })
$Adds = @($Changes | Where-Object { $_.change.actions -contains "create" }).Count
$Updates = @($Changes | Where-Object { $_.change.actions -contains "update" }).Count
$Destroys = @($Changes | Where-Object { $_.change.actions -contains "delete" }).Count
"add=$Adds change=$Updates destroy=$Destroys"
```

Apply only the reviewed saved plan, create the verified after-apply backups,
then delete the plan. `$PlanSha256` below is the 64-hex digest recorded during
review. Hold a read-only, no-write/no-delete share on the exact bytes through
`terraform apply`; a separate pre-apply hash command without this handle leaves
a check/use race:

```powershell
$PlanHandle = [IO.File]::Open($PlanPath, [IO.FileMode]::Open,
  [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { $ActualPlanSha256 = [Convert]::ToHexString($Hasher.ComputeHash($PlanHandle)).ToLowerInvariant() }
  finally { $Hasher.Dispose() }
  if ($ActualPlanSha256 -ne $PlanSha256) { throw "Reviewed plan digest changed before apply" }
  $PlanHandle.Position = 0
  terraform -chdir=infra apply -input=false $PlanPath
  if ($LASTEXITCODE -ne 0) { throw "Saved plan apply failed" }
}
finally { $PlanHandle.Dispose() }
# Create and verify the unique After backup here.
Remove-Item -LiteralPath $PlanPath -Force
```

## Publish the frozen same-SHA capacity release

The rollout branch is `codex/aws-cost-reduction-launch-safety`. Before opening
the PR, run backend tests/type-check/build/SOC 2 checks, frontend lint/API-route
assertions/build, dependency audits, fixture tests, PowerShell parser/tests,
Terraform lockfile-only initialization/format/validation, and secret/diff
checks.

Open a draft PR and require green CI, Gitleaks, and CodeQL. Review the full diff,
mark ready, squash-merge, update local `main`, and require a clean tree exactly
equal to `origin/main`. Wait for post-merge CI and Trivy.

Capture the current API and worker task-definition ARNs before deploying. From
the clean merged checkout, run the one guarded capacity backend deployment:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-gate \
  --capacity-acceptance-release
```

The capacity path runs the strict rollback-only authorization SQL plan gate
before migration, keeps the current 2048 MiB API serving until the new
digest-matched revision is healthy, and reruns the gate from the active
revision. It requires no observation, reread, supersession, rehearsal receipt,
offline rehearsal, host smoke, certification receipt, chain root, or
attestation. The worker is updated to the same image digest at its existing
256/512 size.

Do not use `--skip-wait` in production. The script fails closed unless the API
is stable at `1/1` or `2/2` and the worker is stable at `1/1`. After the slow
image work, it rechecks the weekday 04:45-10:15 America/New_York deployment
guard, then captures the exact API Application Auto Scaling suspended state,
suspends dynamic scale-in/out while preserving the captured scheduled-scaling
state, rechecks both services, and keeps that dynamic hold through migration and
both service deployments. The reviewed one/six-task schedules remain active so
a rollout cannot skip the 05:45 scale-up or 10:00 scale-down. It verifies both
services again after stabilization and restores/verifies the exact prior scaling
state; its EXIT trap retries restoration after a failure.

The one-off migration controller polls the exact ECS task every 15 seconds for
up to 3,600 seconds instead of using the fixed ten-minute AWS waiter. This is
required for online `CREATE INDEX CONCURRENTLY` work, where multiple bounded
statements may legitimately exceed that waiter in aggregate. At the controller
deadline it requests `stop-task`, continues observing until ECS reports
`STOPPED`, records the task/result in deploy output, and hard-stops before any
API or worker service update.

Require a successful migration task, the API at `1/1` or `2/2`, the worker at
`1/1`, one completed deployment per service, the exact prior autoscaling state
restored, a healthy ALB target, public `/health`, a current scheduler heartbeat,
and clean startup logs. In the reviewed `--activate-emergency` mode, the deploy
registers and selects a new `schoolpilot-production-api-emergency` revision at
`512 CPU / 2048 MiB`; the standard 1024 MiB revision remains unused. Record the
active emergency ARN and verify that its image digest matches the worker digest
before publishing the matching frontend or running any load test. Without
changing the checkout, republish the frontend from the identical SHA:

```bash
./scripts/deploy.sh production --frontend \
  --capacity-acceptance-frontend-sha <full-40-hex-merged-sha>
```

Re-read `git rev-parse HEAD`, require it to equal the backend release SHA, and
require the worktree to remain clean after both deployments.

## Synthetic fixture lifecycle

The preparer uses supported production APIs only. Its private config and
artifacts must be under `%LOCALAPPDATA%\SchoolPilot\load-gates`; no real student
record or repository-local secret is permitted.

For this acceptance, create one new ACL-private mutable continuity root from
the tool-owned `launch-safe-20260711` authority. Copy only
`fixture-state.private.json` and `fixture-ownership.private.json` byte-for-byte,
and verify the source and destination SHA-256 values. Put the hash-identical
fixture config plus required DPAPI credential and operation documents in a
separate ACL-private support root. Do not copy historical device, authentication,
command, verification, snapshot, diagnostic, or certification artifacts. The
capacity runner refreshes and verifies the same continuity root once per stage;
it does not promote an old stage result.

The remaining provision/deactivate procedure in this section is historical
fixture-operator reference. The capacity acceptance does not call `provision`,
`deactivate`, or `cleanup`; only its two owned `refresh`/`verify` operations are
authorized.

```powershell
node scripts/load/prepare-classpilot-load-test.mjs --help
```

For the July launch gate, both exact admin aliases were tested through the
operator mailbox before provisioning. Both synthetic schools may share the
operator-owned `school-pilot.net` domain because SchoolPilot identifies a
school by exact `(domain, name)` and supports shared domains. Their names and
admin aliases must be distinct and include the fixture marker. The config must
retain both safety acknowledgements printed by `--help`.

Run a non-mutating preview first:

```powershell
node scripts/load/prepare-classpilot-load-test.mjs provision `
  --config "$LoadRoot\<fixture>\fixture-config.json" `
  --output "$LoadRoot\<fixture>" --dry-run
```

For the live `provision`, supply super-admin and generated fixture passwords
only to that process, plus the two alias-confirmation variables. Never echo
them. The tool creates or adopts only its exact owned schools, refuses any
Stripe-linked tenant, imports 1,000 primary and ten canary students before
device registration, creates 20 teachers and 20 disjoint classes of 40,
disables tracking-hour/group-schedule enforcement, and writes ACL-restricted
schema-v2 auth/device/command artifacts. A login-only rate gate keeps the 15th
login outside the first 15-minute window.

If school creation is interrupted after the school row exists, the pending
intent is first bound to that exact discovered ID. The tool requires a pristine,
non-billable tenant, creates only the missing configured fixture admin, forces
the settings upsert through the supported school-hours PATCH, and re-queries
those postconditions before recording durable ownership. It never adopts a
same-name school without that checkpoint.

```powershell
node scripts/load/prepare-classpilot-load-test.mjs provision --config <absolute-config> --output <absolute-output>
node scripts/load/prepare-classpilot-load-test.mjs verify    --config <absolute-config> --output <absolute-output>
```

Use `refresh` before a later gate to renew device tokens, 20 teacher sessions,
cookies, CSRF tokens, and command bodies. The 12-hour session cap is compatible
with one eight-hour run, but do not reuse artifacts across an intervening soak.

After final acceptance, run `deactivate --dry-run`, inspect tenant-scoped
counts, then run `deactivate --confirm <fixtureId>`. This ends sessions, revokes
devices, purges synthetic telemetry, rotates enrollment keys, removes all
non-admin fixture identities, retains exactly one disabled fixture admin per
school, disables ClassPilot licenses, and starts the 30-day disabled-school
hold. After 30 days, run `cleanup --dry-run`; only then use
`cleanup --confirm <fixtureId>` to remove tool-owned school shells. All
destructive steps are checkpointed and idempotent. A school deletion is not
checkpointed as complete until the supported super-admin list/detail APIs prove
that the exact ID is absent or returns the exact suspended record with a valid
`deletedAt` timestamp.

## Historical load harness and supervisor reference (inactive)

The direct harness and legacy supervisor commands below remain inspectable for
their underlying workload semantics. They are not active admission or execution
paths. Use the capacity runner and exact two profiles documented at the top of
this runbook.

Credential-free fixture validation:

```powershell
npm run load:classpilot -- --validate-fixtures
# With the launch environment/private artifacts set, this performs no traffic:
npm run load:classpilot -- --validate-config
```

The preparer writes `load-devices.private.json`,
`load-command-bodies.private.json`, and `load-auth.private.json`. Set the
harness environment to those absolute paths and unique external progress and
summary paths. Launch-profile runs are immutable:

| Stage | Sockets | Duration | Screenshot | Expected targets/class |
|---|---:|---:|---:|---:|
| `500` | 510 | 1,800 s | 40 KiB | 25 |
| `800` | 810 | 5,400 s | 40 KiB | 40 |
| `burst` | 1,010 | 600 s | 50 KiB | 40 |
| `endurance` | 810 | 28,800 s | 40 KiB | 40 |

Before an accepted `Waf/800` or private `Waf/endurance` run, fixture
verification must read both synthetic schools back through the supported API
and prove that `schoolTimezone` and `schoolHours.timezone` equal the configured
timezone. For `Waf/800`, it must also prove from the planned UTC start/end
instants that the run contains that timezone's `01:30` purge tick and `02:00`
rollup eligibility. The live-schedule endurance window is not subject to that
night-window condition. A config default or locally persisted fixture value is
not evidence of the live school setting. If a required proof fails or credential
reverification would compress the run window, defer and prepare a new run.

Every launch run includes ten second-school canaries first in the manifest,
20 distinct teacher sessions, shared-IP traffic, authenticated WebSockets and
ACKs, forced reconnects, dashboard reads, student-ID tile batches, and one-minute
JSONL progress. Teacher WebSocket startups, dashboard polls, and isolation
probes are staggered across their real polling intervals. The screenshot GET
and tile-batch warm-up is exactly 45 seconds: the unchanged 30-second initial
screenshot-upload interval plus the unchanged 15-second request timeout. After
that warm-up, each teacher issues exactly one
`POST /api/classpilot/tiles/history` and one
`POST /api/classpilot/tiles/screenshots` request for its 25- or 40-student
cohort. The two requests fire together, while the 20 independent cohorts are
staggered across the 30-second tile polling interval. The harness still
accounts for every returned/requested student as a logical history or
screenshot operation, counts screenshot success per tile, and counts response
bytes once per HTTP response. The old per-device history/screenshot requests
remain only as explicit foreign-canary isolation probes. Any valid redirect/4xx, known foreign tenant identifier, or
cross-school delivery writes `fatal_gate`, stops traffic, flushes evidence, and
exits nonzero.

Certification configs must bind
`workload.workloadSchemaVersion="classpilot-tile-batch-v1"` and
`workload.endpointShapeSha256="8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"`.
The supervisor supplies the two reviewed endpoint paths to both preflight and
traffic, seals the schema and endpoint-shape hash into the chain root, stage
attestation, and terminal envelope, and rejects any historical per-device
predecessor that lacks those bindings.
The atomic load summary must repeat both bindings and prove exactly 20 tile
cohorts, two requests per cohort per poll, 25 students per cohort for Waf/500
or 40 for Waf/800, and history/screenshot logical counts equal to their batch
request counts times the cohort size. It must also bind
`pollAccountingVersion="staggered-deadline-v1"` and carry exactly 20 sanitized
history counts plus 20 matching screenshot counts in stagger order. Every
complete 30-second wave contains all 20 paired cohort callbacks and therefore
preserves all of that wave's logical history and screenshot operations. When
the exact monotonic traffic deadline lands inside the stagger window, at most
one final wave may be partial: its admitted callbacks form one leading prefix,
all remaining cohorts have one fewer poll, and no cohort count differs by more
than one. The per-cohort sums, derived complete/maximum round counts, partial
prefix length, aggregate requests, logical operations, screenshot attempts,
and screenshot successes must all reconcile. This deadline accounting changes
neither traffic duration nor any workload, latency, error, or screenshot
threshold.

The monitor independently validates and copies that accounting into
`workload.tileBatch` in its terminal result; the supervisor repeats the same
validation and rejects a current or predecessor result when the version or
accounting is missing or inconsistent. Any fresh-chain config generator must
populate both workload fields shown below and verify the emitted monitor
evidence before constructing the Waf/800 predecessor link.

An isolation probe passes only on the reviewed `404`. A `2xx` response is a
confirmed foreign-resource access failure and stops immediately. A timeout or
`5xx` is recorded as an indeterminate availability failure: it still fails the
stage's 20/20 isolation acceptance, but it is not mislabeled as tenant leakage.

Production keeps the ordinary API autoscaling minimum at one. From 05:45 to
10:00 America/New_York on weekdays, Application Auto Scaling raises the minimum
to six measured launch-safe `512 CPU / 2048 MiB` tasks before the school-arrival
reconnect wave. CPU target tracking remains 1-8 outside that window and 6-8
inside it; after 10:00 it may scale in under the existing cooldown. The active
emergency revision retains `DB_POOL_MAX=20`, so six API pools plus the worker's
five-client pool have a theoretical ceiling of 125 connections. Eight API
pools plus the worker can reach 165; actual RDS connections therefore remain a
hard monitored gate below 150 and max eight must not be represented as
statically bounded below that gate. Before a joint API/worker deployment,
require API desired capacity at or below two. The deployment script blocks
weekday backend deployments from 04:45 through 10:14 America/New_York, including
a one-hour safety buffer before the arrival action. Do not create a new
Terraform plan or run an unscoped apply between
05:45 and 10:00
America/New_York on weekdays: the scheduled action intentionally owns the
scalable target's temporary minimum during that window, and a refresh would
otherwise present the expected `6` floor as drift from the ordinary Terraform
baseline of `1`. A previously reviewed, digest-verified emergency rollback
saved plan remains immediately applicable during this window because applying
that immutable plan does not refresh or reinterpret the scheduled capacity.

The harness rejects non-loopback HTTP targets and forces both HTTPS requests
and WebSockets onto IPv4. The supervisor binds its filename-safe `runId` into
the harness as `LOAD_RUN_ID`, then refuses to launch unless `--validate-config`
proves that exact run ID, `gateProfile=launch`, threshold enforcement, and
`networkFamily=IPv4`. Do not launch the harness directly for accepted evidence.

`start-aws-rollout-supervisor.ps1` prevents workstation sleep, launches and
binds the harness/watcher, supervises both heartbeats, restores power state,
and writes all logs/evidence externally. Use its default `Load` supervision for
the 30-minute, 90-minute, 10-minute, and eight-hour runs:

```powershell
pwsh -NoProfile -File scripts/load/start-aws-rollout-supervisor.ps1 `
  -ConfigPath <absolute-monitor-config.json> -SupervisionKind Load -Mode Validate
pwsh -NoProfile -File scripts/load/start-aws-rollout-supervisor.ps1 `
  -ConfigPath <absolute-monitor-config.json> -SupervisionKind Load -Mode Run
```

For the post-public-ECS 24-hour idle/normal-traffic soak, use the exact
monitor-only contract. It launches no synthetic harness, requires
`minimumWallClockSeconds=86400`, two NAT gateways, and the final-six-hour NAT
gate:

```powershell
pwsh -NoProfile -File scripts/load/start-aws-rollout-supervisor.ps1 `
  -ConfigPath <absolute-monitor-config.json> -SupervisionKind MonitorOnly -Mode Validate
pwsh -NoProfile -File scripts/load/start-aws-rollout-supervisor.ps1 `
  -ConfigPath <absolute-monitor-config.json> -SupervisionKind MonitorOnly -Mode Run
```

At the start of each 24-hour/eight-hour run, create an hourly Codex follow-up
automation for this task. Remove it after the run. AWS alarms/SNS and the local
supervisor remain independent safety layers.

Monitor configuration must bind the exact run ID, phase, deadline, resources,
expected NAT count, expected Route 53 latency flag, immutable workload (when
present), evidence/progress/summary paths, notification SNS topic, and a
prevalidated rollback config. Production polling is fixed at 60 seconds.
RDS CPU datapoints may publish one additional minute behind the other
one-minute series. The monitor therefore permits 240-second freshness and
backfills every returned RDS CPU datapoint inside the actual traffic-start/end
minute buckets into cumulative acceptance; pre-run, post-run, and future points
cannot pad the result. Production load monitoring requires its wall-clock
minimum to equal the immutable workload duration. Once the final summary is
validated, its bounded actual traffic duration fixes the end bucket and cannot
grow while a later acceptance condition is pending. Runtime evidence continues
to report the newest point, while every fresh unseen RDS CPU point is processed
chronologically from the fixed monitor-start minute so pre-phase history cannot
trigger rollback, three delayed consecutive breach minutes still trigger, and a
missing minute resets the sequence. This preserves strict 60-second coverage,
the 120-second maximum gap, and delayed peak detection. Every other one-minute
metric retains 180-second freshness.
Use these exact WAF CloudWatch dimensions; Validate mode confirms them against
the deployed Web ACL before monitoring begins:

- `wafWebAclName=schoolpilot-production-cloudfront-waf`
- `wafDeviceClassifierMetricName=schoolpilot-production-device-ingest-classifier`
- `wafDeviceRuleMetricName=schoolpilot-production-device-ingest-rate-limit`
- `wafApiRuleMetricName=schoolpilot-production-api-rate-limit`

Every accepted result is written by the monitor and sealed by the supervisor in
a separate terminal envelope. The next stage hashes that envelope and verifies
the enclosed monitor-result hash; raw monitor output, historical evidence, a
recomputed operator summary, or an unsealed result cannot be a predecessor.
`Validate` produces a single-use receipt bound to the exact controller SHA,
deployed application SHA/digest and task definitions, fixture generation,
config/script hashes, generator IPv4, AWS posture, rollback identities, and
output paths. It also freezes the operator config and executable rollback JSON
by SHA-256. `Run` first calls `Inspect-CertificationValidationReceipt` without
consuming it. It starts and validates the harness and monitor, rechecks lease,
fixture, rollback, IP, schedule, task, and posture identities, and stages the
chain-root and stage-attestation artifacts. Only after those pretraffic checks
pass does it call `Use-CertificationValidationReceipt`; that consumption must
occur immediately before the atomic harness start-gate publication. The
consumed receipt binds the copied
`<evidenceDirectory>/<runId>-bound-rollback-config.json` and
`<runId>-bound-monitor-config.json`. Any byte change blocks traffic or, after
arming, blocks the automatic mutation. A receipt or evidence directory cannot
be replayed.

Late receipt consumption prevents a startup failure from falsely burning
traffic authority, but it does not authorize another binding or run. Any
certification startup failure before the start gate is released is a decisive
terminal no-traffic failure. Seal exact no-traffic evidence, restore
schedule-appropriate scaling and Database Insights Standard/7, and stop. Do
not create a second binding, repeat fixture preparation, or run `Validate` or
`Run` again. Once the start gate is released, traffic is one-shot.

The production certification member must use this concrete shape. Every path
is an absolute external file and every `REPLACE_*` value must be populated
before Validate. A later stage adds `certification.chainRoot` plus top-level
`predecessorResultPath` and `predecessorResultSha256`; it never mints a second
root.

```json
{
  "rollbackConfigPath": "C:/absolute/evidence/reviewed-rollback.json",
  "workload": {
    "stage": "500",
    "devices": 510,
    "durationSeconds": 1800,
    "screenshotBytes": 40960,
    "canaryDevices": 10,
    "workloadSchemaVersion": "classpilot-tile-batch-v1",
    "endpointShapeSha256": "8e9f1942e4b3a27de7dd0571a9f60ffeb276c089e4baae96a885dba69e3233b2"
  },
  "resources": {
    "expectedRdsInstanceClass": "db.t4g.medium",
    "expectedActiveApiTaskDefinitionArn": "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:17",
    "expectedActiveWorkerTaskDefinitionArn": "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:37"
  },
  "certification": {
    "schemaVersion": 1,
    "chainId": "REPLACE_FRESH_CHAIN_ID",
    "deployedApplicationGitSha": "REPLACE_40_HEX_APP_SHA",
    "deployedImageDigest": "sha256:REPLACE_64_HEX_IMAGE_DIGEST",
    "controllerGitSha": "REPLACE_40_HEX_CONTROLLER_SHA",
    "activeApiTaskDefinitionArn": "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:17",
    "activeWorkerTaskDefinitionArn": "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:37",
    "rollbackApiTaskDefinitionArn": "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:13",
    "rollbackWorkerTaskDefinitionArn": "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:35",
    "rollbackApiGitSha": "REPLACE_EXACT_FULL_ROLLBACK_API_GIT_SHA",
    "rollbackWorkerGitSha": "REPLACE_EXACT_FULL_ROLLBACK_WORKER_GIT_SHA",
    "rollbackApiImageDigest": "sha256:REPLACE_64_HEX_ROLLBACK_API_DIGEST",
    "rollbackWorkerImageDigest": "sha256:REPLACE_64_HEX_ROLLBACK_WORKER_DIGEST",
    "rollbackSchemaCompatibilityEvidence": {"path": "C:/absolute/evidence/schema-compatibility.json", "sha256": "REPLACE_64_HEX"},
    "fixture": {
      "expectedFixtureId": "REPLACE_EXACT_FIXTURE_ID",
      "state": {"path": "C:/Users/OPERATOR/AppData/Local/SchoolPilot/load-gates/certification/CHAIN/RUN/fixture-state.private.json", "sha256": "REPLACE_64_HEX"},
      "verification": {"path": "C:/Users/OPERATOR/AppData/Local/SchoolPilot/load-gates/certification/CHAIN/RUN/verification.private.json", "sha256": "REPLACE_64_HEX"},
      "artifacts": [
        {"kind": "device-manifest", "path": "C:/Users/OPERATOR/AppData/Local/SchoolPilot/load-gates/certification/CHAIN/RUN/load-devices.private.json", "sha256": "REPLACE_64_HEX"},
        {"kind": "teacher-auth", "path": "C:/Users/OPERATOR/AppData/Local/SchoolPilot/load-gates/certification/CHAIN/RUN/load-auth.private.json", "sha256": "REPLACE_64_HEX"},
        {"kind": "command-bodies", "path": "C:/Users/OPERATOR/AppData/Local/SchoolPilot/load-gates/certification/CHAIN/RUN/load-command-bodies.private.json", "sha256": "REPLACE_64_HEX"}
      ],
      "expectedTimezone": "America/New_York",
      "maximumVerificationAgeMinutes": 60,
      "plannedTrafficStartUtc": "REPLACE_ISO_8601_UTC"
    },
    "alarmNames": ["REPLACE_EVERY_REQUIRED_ALARM"],
    "scheduleNames": ["REPLACE_EVERY_API_SCHEDULE"],
    "historicalEvidence": []
  }
}
```

The :17/:37 and `805a0f73...` identities describe the current initial
controller-landing baseline, not a permanent allowlist. A same-image deployment
creates fresh active task-definition revisions, and an activated index pivot
creates a fresh application SHA/digest; in either case start a fresh chain with
those exact supplied identities while retaining the reviewed :13/:35 rollback
identities and proving ECR/service provenance.

The rollback JSON must set `previousApiTaskDefinition` and
`previousWorkerTaskDefinition` to those exact :13/:35 full ARNs. The generated
receipt has type `certification_validation_receipt`, run/chain IDs, a 30-minute
expiry, nonce, operator-config hash, controller SHA/component hashes,
application SHA/digest, full AWS preflight, and rollback path/hash. Its separate
seal contains the receipt hash. Never hand-author, re-seal, or copy either file
between runs. `issuedAtUtc` cannot be in the future, `expiresAtUtc` must be
exactly 30 minutes later, and Run consumes only the exact
`<receiptPath>.consumed` destination. Every predecessor re-hashes and loads that
consumed receipt and cross-checks its complete task, fixture, datastore,
network, alarm, schedule, rollback, operator-config, and bound-runtime evidence
against the stage attestation and supervisor terminal envelope. The chain root
is always a supervised Waf/500 load result with a bound generator IPv4; a
MonitorOnly or minimal hand-authored root is not accepted.

The three role-tagged `fixture.artifacts` entries must be immutable,
stage-specific copies of the exact device manifest, teacher-auth artifact, and
command-bodies file supplied to the harness. The supervisor requires their
paths to match `LOAD_DEVICE_MANIFEST`, `LOAD_TEACHER_AUTH_FILE`, and
`LOAD_COMMAND_BODIES_FILE`; refreshing the shared fixture therefore cannot
silently change a predecessor stage. After every refresh/verify, copy the
state, verification, manifest, auth, and command files into a new
ACL-restricted stage directory below `%LOCALAPPDATA%\SchoolPilot\load-gates`
and bind those copies; the harness rejects private inputs stored elsewhere.
MonitorOnly stages must bind freshly verified preparer outputs even though no
LOAD process consumes them. The manifest must also prove that Waf/500 selects
exactly 25 students from each teacher roster and Waf/800 selects all 40 from
each roster, with the latter covering exactly the 800 disjoint roster students.
Live verification must prove exactly two schools, 20
teachers and classes, 1,010 students/devices/live device sessions, 800
disjoint roster students, 20 active sessions and safe command bodies, one live
command admin, 20 live teacher auth artifacts, and every
disabled-tracking/auto-enroll/schedule
and exact-timezone gate.

Production monitor `Validate` and `Monitor` invocations require the supervisor's
`-ExpectedConfigSha256`; direct production invocation without that bound config
digest is rejected. Isolated `testMode` unit calls may omit it.

Historical supervisor-chain reference (inactive for the current medium
decision):

`Waf/500 -> Waf/800 -> PublicEcs/800 -> PublicEcs/24h no-load -> NatRemoved/800 -> Route53/no-load -> Redis/500 -> Redis/800 -> Redis/burst -> Final/endurance`.

If the approved RDS capacity fallback is used, the private prefix is instead:

`Waf/500 -> Waf/800 -> Waf/endurance -> PublicEcs/800`.

The monitor resolves this choice from the exact observed
`resources.expectedRdsInstanceClass`: `db.t4g.medium` requires `Waf/800` as the
PublicEcs predecessor, while `db.t4g.xlarge` requires `Waf/endurance`.

The small Week 1 partial smoke is diagnostic only and cannot appear in this
acceptance chain.
Automatic rollback may dispatch only one unambiguous pre-approved action:

- application regression: previous API and worker task definitions;
- API OOM: digest-matched emergency API revision;
- WAF rate block: only the two rate rules to `COUNT`;
- public ECS: captured private subnets/security groups while NAT still exists;
- NAT removal: digest-verified saved NAT recreation plan, then private ECS;
- Redis: `cache.t4g.small` and wait for `available`.

RDS CPU, connection, free-memory/swap, credit, latency, queue-depth, or IOPS
capacity evidence is a stop-and-preserve condition, not an infrastructure
rollback selector. It must never change WAF, ECS networking, NAT, Route 53,
Redis, or application revisions. PI may corroborate a database-only result but
cannot override any failed application, valid-traffic, isolation, WebSocket,
ECS/ALB, Redis, WAF, scheduler, duration, or evidence-completeness gate. An OOM
while the API already runs the bound emergency revision is also a hard stop;
there is no second corrective redeploy.

Application rollback keeps the reviewed ALB deregistration delay at **300
seconds** and restores the API before the worker. For API desired capacity two
or greater, it uses a non-overlapping one-at-a-time policy: total API capacity
cannot exceed desired capacity and at least `desired - 1` tasks remain healthy.
For desired capacity one, zero overlap is not availability-safe; the controller
instead uses `maximumPercent=200` and `minimumHealthyPercent=100`, permitting
exactly one replacement slot (two API tasks maximum) while requiring one
healthy target throughout. It waits for zero draining/unhealthy targets, one
completed exact-revision deployment, and two consecutive exact polls before
touching the worker. If zero healthy targets predate rollback, the controller
records a pre-existing outage and continues recovery. If a rollback that began
with a healthy target later observes zero, it still restores the exact API and
worker revisions and captured deployment configurations, then exits failed to
block progression while recording the recovered availability violation. A
failed deployment or deadline before exact recovery leaves
`recoveryRequired=true` and retains both the bounded safety policy and the API
scaling hold. The controller never claims success over a mixed deployment.
Before its first mutation it durably checkpoints the exact normal `200/100`
API/worker deployment configurations and the API scalable target's min/max and
three suspended-state flags. A restarted controller resumes that bound capture;
it must not reinterpret a prior controller's temporary policy or all-suspended
state as normal. Dynamic scale-in, dynamic scale-out, and scheduled scaling are
all held during recovery so a scheduled `1 -> 6/8` change cannot race the
singleton `200%` policy. The controller still binds any externally observed
desired-count drift immediately before revision dispatch and on every
five-second API convergence poll, replacing `200/100` with the live multi-task
non-overlap policy (or the reverse) before waiting further. After both services
converge, it restores the exact captured scaling state and then requires two
fresh exact API/target and worker polls before completing the checkpoint.
The checkpoint also carries original/minimum healthy-target history, any
zero-target/availability violation, the mutation-start marker, original desired
count, desired drift, and policy-application history. Losing, corrupting, or
replacing it after mutation is a hard recovery failure that retains the safe
deployment policy and scaling hold. A recovered availability violation is
durably terminal and cannot be erased by restarting the controller.
Application rollback callers must continue enforcing the approved off-hours
window and must not start a recovery that can span the 05:45 or 10:00 ET
scheduled-minimum boundary while scheduled scaling is held. Drift, checkpoint
resume, scaling hold/restoration, and every policy application are retained in
recovery evidence. The 300-second ALB drain remains unchanged.

The supervisor stops traffic if the generator/watcher heartbeat disappears.
The monitor stops immediately on a hard gate and after three consecutive fresh
one-minute resource breaches. A missing metric, missed duration, stale
artifact, notification failure, or incomplete acceptance invalidates the run;
monitoring-completeness failures never guess at an infrastructure mutation.

## Historical optimized-build certification path (inactive, 2026-07-17)

The current application baseline is `805a0f73c63e0c8f5706776d3d8bbcb4afcbbc00`
at digest
`sha256:5fff93d966279516e247f11c506163ebe144321a8316730b56313f34ec4c92fa`,
served by `schoolpilot-production-api-emergency:17` and scheduler worker `:37`.
Controller-only changes record their own Git SHA separately and do not change
that deployed application identity. Existing Waf results cannot seed this
optimized-build chain.

At supervisor Validate and again immediately before traffic, bind the full
revisioned ARNs for `schoolpilot-production-api-emergency:13` and
`schoolpilot-production-scheduler-worker:35`. Both must be ACTIVE, use
digest-pinned images whose manifests remain retrievable from ECR, and match the
recorded task-definition JSON hashes. Reject shorthand family names, mutable
image tags, missing manifests, or a schema audit that finds a destructive table,
column, or constraint change since source SHAs `3e1933534c4c` and
`4377622408a9`. The supervisor treats the controller's complete bounded
rollback interval as recovery, not a new monitored stage.

Run a fresh private `Waf/500` with no predecessor, then a fresh private
`Waf/800` whose sole predecessor is the sealed Waf/500 terminal envelope. Pin
API min 6/max 8 only for these night gates, require six healthy exact-digest
targets and worker 1/1, and restore schedule-appropriate scaling after the
terminal result. Do not add a separate 40-45% Waf/500 margin gate.

The terminal r8 chain
`optimized-medium-20260719T143700Z-b50f7656-d6f889bb-r8` is historical-only.
Its Waf/800 evidence showed a mixed application/database failure: 1,502 HTTP
503s in 47,226 requests (3.18%), 5,895/6,800 successful screenshots (86.69%),
and three one-minute RDS CPU samples at 75.35%, 73.16%, and 72.93%. Performance
Insights attributed the dominant database load to the per-tile live/history
authorization reads, not heartbeat writes, Redis, WAF, I/O, purge, or rollup.
The controller/evidence link succeeded; r8 is not a valid predecessor for the
new batch workload.

Exactly one bounded `db.t4g.medium` remediation is authorized: rewrite the
tile authorization query as set-based SQL, add only plan-proven indexes, and
replace each class's per-student fan-out with the two student-ID batch reads.
This authorization does **not** permit an RDS resize, admission-timeout or pool
change, workload-duration change, purge/rollup exception, or threshold
relaxation. Keep RDS `db.t4g.medium`, Redis `cache.t4g.small`, WAF `BLOCK`, the
private ECS/NAT posture, existing schedules, and the 512 CPU / 2048 MiB API
posture. The backward-compatible backend deploys before the matching frontend,
both from one new release commit.

For every new release, the backend uses the release-bound plan gate through the
candidate-rehearsal and single-use guarded-reuse sequence above. A direct
unrehearsed plan-gated deployment is ineligible.

The gate uses the freshly registered digest-pinned emergency revision and the
service network configuration. It must produce the fixed six-scenario,
40-student, 20-sample sanitized aggregate with the teaching-session school
precheck at zero and every unchanged plan threshold passing. The exact shared
history-fallback builder is also compiled once for a tenant-scoped
nonexecuting `EXPLAIN (VERBOSE, FORMAT TEXT)`. The resulting PostgreSQL signed
query ID, compiled-SQL hash, parameter-signature hash, engine version, and
schema hash are bound as `history-fallback-queryid-v1`. The gate observes
`compute_query_id` read-only and never changes that GUC, grants parameter
privilege, or uses a privileged plan role. Only effective `on` or `auto` is
eligible: the exact verbose probe must emit one nonzero signed query ID both
before and after plan measurement, and both IDs and schema identities must
match. `off`, `regress`, missing, malformed, zero, ambiguous, or unstable
identity fails closed. Effective PostgreSQL
`track_io_timing` must be `on`, and the compiled statement must contain all
three PI discovery markers -- `requested_tiles`, `heartbeats`, and `lateral`
-- within its first 500 characters. The gate rejects a query whose markers move
outside that exact prefix even if its result or plan is otherwise equivalent.
Only hashes may appear in sanitized deploy output. The raw decimal query ID is
copied from the restricted task log into an ACL-restricted release receipt
which also binds the exact DBI resource ID, PostgreSQL engine/schema identity,
release SHA, image digest, and revisioned API and worker task definitions. The
same gate runs again from the active post-migration revision and must reproduce
the exact identity before the release is eligible for load testing. Neither
probe can start during the actual 01:15-02:15 America/New_York purge/rollup
window. There is no bypass or sample/cohort/threshold override. A failed,
timed-out, malformed, missing, or identity-drifted report stops the deploy;
post-deployment identity drift rolls
the API and worker back to their captured revisions. The pre-deployment probe
runs before the autoscaling hold; the post-deployment probe runs under that
hold after strict API/worker convergence and before exact scaling restoration.

The gate must not depend on an ambient open teaching, supervision, or student
device session. For every invocation it takes a transaction-scoped advisory
lock and uses one `REPEATABLE READ`, write-capable transaction under the
existing application role. It discovers only an unambiguous non-billable
SchoolPilot-owned synthetic base from the school and
`synthetic-load-fixture:<fixtureId>:class:<ordinal>` markers. The stable base
must provide two active teachers, one office-staff membership, disjoint
40-student cohorts, and historical same-school device mappings. It binds each
selected `<fixtureId>-P-####` student to the corresponding
`<fixtureId>-primary-####` device and requires all 80 pairs and devices to be
distinct. Active `student_sessions` do not participate in base or cohort
selection; they are classified only after the deterministic 80 pairs have
been selected. The gate does not repair or refresh the persistent fixture.

Inside that transaction, an already-active student session is reused only when
it matches the exact selected student/device pair. If neither side is active,
the gate inserts an explicit random-ID active session for the pair. An active
student or device bound to a different counterpart, an ambiguous mapping, a
cross-school row, or an incomplete cohort fails before measurement. The gate
never updates, deactivates, or deletes an existing session.

After the global teaching-session school-integrity precheck succeeds, the gate
also inserts exactly one co-teacher relationship, one school-scoped open live
teaching session, one active office-supervision context, and 40 supervision
assignments. Stable discovery, session representation, all six authorization
series, the history-fallback series, both schema checks, and both query-ID
probes remain in that transaction and are constrained to the selected
fixture/staff/cohorts. The gate then explicitly rolls back; there is no
write-transaction commit path. A distinct pool connection running a separate
super-scoped read-only transaction must prove every generated ID absent before
a passing report is eligible.

Deployment evidence must contain exactly one sanitized
`transactional-plan-scenarios-v2` lifecycle event. Its exact top-level fields
are `version`, `requiredSessionPairs`, `reusedActiveSessionPairs`,
`insertedSessionPairs`, `seededRows`, `rollback`, and `residue`.
`requiredSessionPairs` is 80, reused plus inserted is 80, the fixed
`seededRows` counts are 1/1/1/40, `studentSessions` equals the inserted count,
and `total` equals 43 plus that count. Rollback must complete and residue must
be zero. Version 1 and 43-only evidence are historical and ineligible for new
deployments. The lifecycle event contains no identifier, SQL, or tenant data.
Seed, discovery, plan, identity, rollback, residue, connection, timeout, or
concurrency failure stops the deployment without a bypass. Do not run a
production fixture refresh before this gate.

The shared read-only base preflight runs in `REPEATABLE READ READ ONLY` and
rolls back. Its sole passing event is
`classpilot-tile-auth-plan-base-preflight-v1`. Its exact fields are `version`,
`status`, `eligibleBases`, `requiredSessionPairs`,
`reusedActiveSessionPairs`, `missingSessionPairs`, and
`conflictingSessionPairs`, with exactly one eligible base, 80 required pairs,
reused plus missing equal to 80, and zero conflicts. It contains aggregate
counts only. Preflight is advisory fail-fast evidence; it does not replace
either complete rollback-only gate.

Candidate classes must have the canonical teacher-relationship posture used by
the application: exactly one `group_teachers` row matching the group's primary
teacher with role `primary`, and no additional relationship row of any role.
Missing, mismatched, malformed, or additional relationships make that class
ineligible. Observation mode also emits one
`classpilot-tile-auth-plan-base-selection-v1` companion from the same
transaction snapshot. Its exact fields are `version`, `cohortSize`,
`canonicalPrimaryOnlyGroups`, `exactCohortGroups`, `eligibleSchools`, and
`finalBases`. The production-owned fixture is accepted only at
`40/19/19/1/1`; this companion does not change preflight-v1 or admit a
deployment.

A failed base preflight emits one
`classpilot-tile-auth-plan-base-funnel-v1` object from that same
snapshot-consistent statement. Its exact top-level fields are `version`,
`failureStage`, `firstEmptyStage`, `cohortSize`, `counts`, and
`sessionPosture`. The allowlisted counts cover only the owned synthetic
group/marker/license, roster/device/supervision/co-teacher/cohort,
office-membership/cohort, alternate-teacher, selection, and final-base stages.
They contain no identifiers or SQL. `base_funnel` identifies the first zero
stage, `base_shape` proves a selected base with an invalid aggregate shape, and
`session_posture` binds the 80-pair reused/missing/conflicting arithmetic.
This failure evidence cannot satisfy the unchanged passing preflight or either
complete release gate.

The failed pre-deployment artifacts at application SHA
`ba416e4f46cc175af62863e3a06573ef5d23504e`, image digest
`sha256:0c4653b244e8e7bc7a12ac7828b5e9421eacf376dc3d5ab7b7ac75413f844c5a`,
and task definitions `schoolpilot-production-api:128` and
`schoolpilot-production-api-emergency:28` are historical-only and ineligible
for diagnostics or certification. That gate produced no query-identity receipt.

The later failed self-contained release candidate at application SHA
`ada101ecdd127c624b9bbe7974ce70f090582f0f`, image digest
`sha256:1194aded2d731b8cf9fedacb850ec9cd815cd88cae85bd0d46682015e3496beb`,
and task definitions `schoolpilot-production-api:132` and
`schoolpilot-production-api-emergency:32` is also historical-only. Its
predeployment gate correctly stopped because the ambient synthetic teaching
sessions had expired; no service activation, migration, frontend publication,
query-identity receipt, fixture refresh, Database Insights lease, or traffic
occurred. Never deploy, resume, or use these identities as diagnostic or
certification provenance.

The failed rollback-safe candidate at application SHA
`3c82f540cccfaf0badd70312e76e69770b6cfaed`, image digest
`sha256:776bd7e55a64c9da26d5eb1f38887f0402b0f1d143d3a1ca20a47246d459c1d6`,
and inactive task definitions `schoolpilot-production-api:133` and
`schoolpilot-production-api-emergency:33` is historical-only. The plan task
inserted no rows, completed rollback with zero residue, and correctly failed
because no stable base satisfied the remaining active-session dependency. No
candidate service was activated, and no migration, frontend publication,
query-identity receipt, fixture refresh, Database Insights lease, or traffic
occurred. Never reuse these identities or their missing receipt.

The later failed preflight candidate at application SHA
`f3265563ac2efb673a2974a1adafefe32dcedb42`, image digest
`sha256:56e973299479638e02f496b0641a21945440367cbe0a3d782c3fc75e6442673a`,
and inactive task definitions `schoolpilot-production-api-emergency:34` and
`schoolpilot-production-scheduler-worker:49` is historical-only. It emitted
`representative_scenario_missing` but no eligible rehearsal receipt, migration,
service activation, frontend publication, fixture mutation, monitoring lease,
or traffic. These identities are ineligible for deployment, diagnostics, and
certification and must not be promoted or reused.

The later observation candidate at application SHA
`abf820cc02b69599857739afe42f86baacd2351d`, image digest
`sha256:cbd7a7d2e07d41120ace5cda19c990de26dac0f9a140bcad5b7c0c298f6531a5`,
and inactive task definitions `schoolpilot-production-api:135`,
`schoolpilot-production-api-emergency:35`, and
`schoolpilot-production-scheduler-worker:50` is historical-only. Its exact
terminal stream proved that all 20 licensed groups and 800 canonical,
unsupervised roster students reached `noCoTeacherGroups`, where the old
any-row predicate excluded all groups. The wrapper sealed no packet. No
migration, service activation, frontend publication, fixture mutation,
monitoring lease, or traffic occurred. Never promote or reuse these
identities.

The later observation at application SHA
`cf9b70420b71668d4f06c9376b5274d27a259d0f`, image digest
`sha256:293e31c70c779da9d20af62957af70d2f6fb4c8ed327c0f9d7d4730053e8e570`,
inactive `api:136`/`api-emergency:36` and `worker:51`, and observation ID
`tile-plan-observe-20260726t035926z-cf9b70420b71` is historical-only. Its
terminal task exited zero and its exact stream proved selection
`40/19/19/1/1`, one eligible base, and session posture `80/80/0/0`, but the old
cross-process monotonic-deadline boundary sealed
`log_evidence_unavailable` with zero reads. The immutable original
observation-v2 packet remains unchanged and ineligible. Never promote its
candidate identities or use the original packet for rehearsal, deployment,
diagnostic, or certification admission.

For an explicitly authorized, non-consuming investigation, run exactly one
inactive-candidate observation:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-observation
```

Observation mode performs the normal source, workflow, timing, AWS-identity,
topology, and production-posture checks; builds, pushes, and registers the
inactive API/worker candidate; and runs only the read-only base preflight. It
performs no migration, scaling hold, service update, frontend publication,
fixture mutation, Database Insights lease, or workload traffic. It creates no
rehearsal admission or receipt, does not consume the per-SHA one-attempt
rehearsal boundary, and is never an alternate deployment path.

Before `run-task`, atomically write and independently inspect one immutable,
ACL-private `classpilot-tile-auth-plan-observation-attempt-v1` record binding
the observation ID, release and candidate identities, active baseline, and
initial network/posture hashes. Seal every terminal result as a sibling
`classpilot-tile-auth-plan-observation-v2` packet. A monotonic five-minute
collector owns both exact-stream binding and every CloudWatch read in one Node
process. At process entry it latches its `process.hrtime.bigint()` deadline,
reads the exact terminal task-result and task-definition log-configuration
files, invokes the shared PR #250 resolver, derives a null or omitted ECS
`logStreamName`, and performs all fresh snapshots under that same clock.
Absolute monotonic values must not cross a process boundary.

The collector interface accepts the task-result file, log-configuration file,
expected task/task-definition/region/account identities, and an optional
bounded duration. It must not accept a caller-created
`--deadline-monotonic-nanoseconds` or direct log-group/log-stream/task-exit
arguments. Preserve 30-second-or-remaining process limits, explicit pagination,
100-page/10,000-event caps, cycle and conflicting-event detection, fresh
snapshots, and delays of 0, 1, 2, 4, then 5 seconds. It never launches another
task or merges partial reads.

The strict failures are `log_binding_unavailable` with zero CloudWatch reads,
`collector_start_unavailable` with zero reads, and
`log_evidence_unavailable` only after at least one attempted fresh snapshot.
New observation writes reject a zero-attempt `log_evidence_unavailable`;
historical observation-v2 inspection remains compatible with the old packet
but cannot rewrite it. The strict outcomes remain `base_eligible`,
`base_ineligible`, `task_failed`, and `evidence_unavailable`. Exit-zero
eligibility requires the unchanged preflight-v1 plus the exact selection-v1
companion; expected exit-one ineligibility requires the canonical funnel-v1
companion. Collection, network, and final-posture failures are retained as
sanitized source envelopes instead of bypassing packet finalization.

The packet binds the exact immutable attempt hash, observation ID, SHA, digest,
inactive task definitions, active baseline, initial and final network/posture
evidence, terminal
task/exit/log-stream identity when available, canonical whole-event hash, and
UTC timestamps. Packet and companions publish by one same-parent atomic
rename and are independently inspected. All variants set
`eligibleForDeployment`, `eligibleForDiagnostic`, and
`eligibleForCertification` to exactly `false`; unavailable or failed outcomes
seal first and then return nonzero.
`classpilot-tile-auth-plan-observation-v1` is historical/inspect-only and
cannot be written or used for admission. Rehearsal consumption, deployment,
diagnostic binding, and certification validation must reject every
observation packet.

New observations keep their task-launch, terminal-description, and
task-definition log-configuration scratch JSON inside the ACL-private per-run
observation root. Remove those transient copies only after the terminal packet
and companions are sealed and independently inspected. A sealing, inspection,
or cleanup failure retains the private controller workspace for forensic
review and returns nonzero. The two known repository-root scratch files
from the historical `cf9b70420b71668d4f06c9376b5274d27a259d0f`
observation must first be archived byte-for-byte with their SHA-256 values
under that observation's private evidence tree; remove only those two known
files afterward so the checkout becomes clean.

Historical observation reread and supersession artifacts remain immutable,
ACL-private, and inspectable with all downstream eligibility flags false. They
are not active observation, rehearsal, readiness, deployment, diagnostic, or
certification prerequisites. No current phase may depend on a stopped ECS task
remaining describable, and no historical packet, exit code, reread, or
supersession marker admits a fresh task. The prior artifacts stay historical
without being rewritten or promoted.

Standalone observation is optional audit evidence. When explicitly run, its
CloudWatch-backed preflight and selection evidence remains strict and the
packet remains ineligible downstream. The production-connected gate-only
rehearsal runs both the read-only preflight and rollback-only transactional
gate, so it is the stronger and required proof before guarded deployment.

For the completed session-independent remediation, require exact merged-SHA
CI, CodeQL, Gitleaks, and Trivy success, then save and independently parse a
fresh production Terraform plan with detailed exit code `0`, zero
resource/output actions, and no apply. Operate outside both the weekday
04:45-10:14 America/New_York deploy guard and the 01:15-02:15 plan-gate
exclusion.

Run the inactive candidate once in gate-only mode:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-gate \
  --classpilot-tile-auth-plan-rehearsal
```

This mode performs the normal source, workflow, timing, AWS, and posture
checks; builds, pushes, and registers inactive candidate definitions; runs the
read-only preflight and complete rollback-only gate; and performs no migration,
scaling hold, serving-service update, frontend publication, fixture mutation,
Database Insights lease, or traffic. Building, pushing, and registering the
inactive candidate are the only candidate control-plane writes; they do not
change the serving release or committed production data. CloudWatch-backed
preflight, lifecycle, plan-report, and query-identity evidence is mandatory;
exit zero without that complete sanitized evidence never passes.

A non-authoritative provider or evidence-transport failure before production
mutation creates no SHA-wide attempt, terminal, or consumption marker and
permits one same-SHA gate-only retry. A nonzero task or authoritative SQL,
query-identity, RLS, rollback, residue, or plan-threshold failure atomically
creates the existing admission plus failed terminal and permanently makes that
SHA ineligible. No raw provider response, SQL, identifier, stderr, or error is
persisted; only the existing allowlisted sanitized failure is retained.

A pass seals and inspects one ACL-private
`classpilot-tile-auth-plan-rehearsal-v1` receipt without consuming the
SHA-wide attempt. The receipt binds the SHA, digest, inactive task definitions,
active baseline, network configuration, preflight, lifecycle, plan, and
query-identity hashes and expires after 60 minutes. During guarded deployment,
the exact receipt is inspected first. After the strict predeploy gate and
candidate/baseline/network/posture equality checks pass, and immediately before
the scaling hold and first production mutation, the deployer atomically creates
or resumes the existing passed admission/terminal records and consumes the
existing single-use marker.

Admission, terminal, receipt, inspection, consumption, and the canonical
consumption marker bind one protected execution-authority SHA-256. Production
Windows derives it from the stable machine identity plus the current user SID;
neither raw value is written or logged. Resolution failure or an authority
mismatch fails closed, so copying the complete private tree to another host or
user does not transfer deployment authority. Byte-identical copies and
concurrent consumers share the canonical single-use marker. Receipt freshness
is half-open: `now < expiresAtUtc`; the exact expiry instant and every later
instant are rejected immediately before consumption.

Deploy only that exact candidate:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-gate \
  --reuse-classpilot-tile-auth-plan-rehearsal <absolute-private-receipt-path> \
  --expected-classpilot-tile-auth-plan-rehearsal-sha256 <64-hex>
```

The deployment verifies the unused, unexpired receipt and all bound state,
reruns the complete gate before late consumption and migration, then reruns it
from the active revision after strict convergence. The postdeployment gate is
CloudWatch-strict and must reproduce the rehearsal query identity. It rejects a
different SHA, digest, task definition, baseline, network configuration,
identity, expired receipt, or second consumption. After the guarded backend
passes, publish the matching
frontend from the unchanged checkout, run one offline preparation/binding
rehearsal, and run one 1,560-second harmless host-supervision smoke.

For every terminal plan task, resolve and validate the exact task definition,
container, awslogs configuration, stream, and integer exit code before judging
the gate. A null or omitted ECS `logStreamName` is deterministically derived
from the verified stream prefix, container name, and exact ECS task ID. Fetch
that exact stream even when exit is nonzero, then surface only an allowlisted
sanitized gate failure code. Exit zero plus complete valid evidence remains
mandatory for acceptance; log binding must never replace the real gate
failure.

## Historical final stop-loss campaign authorization (inactive)

This is the campaign's final remediation PR. Its exact changed-file allowlist
is:

- `scripts/deploy.sh`
- `scripts/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs`
- `scripts/load/start-aws-rollout-supervisor.ps1`
- `tests/deploy-classpilot-tile-auth-plan-gate.test.ts`
- `tests/classpilot-tile-auth-plan-rehearsal-receipt.test.ts`
- `tests/aws-rollout-certification-chain.test.ps1`
- `tests/classpilot-tile-auth-plan-readiness-governance.test.ts`
- `docs/AWS_COST_ROLLOUT_OPERATIONS.md`
- `docs/CLASSPILOT_TILE_AUTHORIZATION_PLAN_CHECK.md`

The PR may add no file and no runtime schema/version, controller, marker, or
failure-code literal. It may not introduce an active dependency on
retention-limited historical evidence or make a phase depend on an artifact
produced only by a later phase. After exact merged-SHA CI, CodeQL, Gitleaks, and
Trivy success, the release and acceptance criteria freeze. No later campaign
commit or remediation PR is allowed.

Create fresh DPAPI and AES-GCM state backups, a unique saved zero-action/no-apply
production Terraform plan, and a fresh read-only baseline. Run the offline
preparation rehearsal and 1,560-second host-supervision smoke before production
mutation. Standalone observation is optional; it is not a readiness
prerequisite and remains ineligible downstream.

Run the strict production-connected gate-only rehearsal. One
non-authoritative provider or evidence-transport failure before mutation may
receive one same-SHA retry; an authoritative gate failure is terminal. Inspect
the exact passing 60-minute receipt, then run one guarded backend deployment
against the rehearsed candidate. Rerun the strict gate before late receipt
consumption/migration and after active-revision convergence, publish the
matching frontend from the frozen SHA, verify routes and production posture,
and seal readiness. The readiness packet binds only current workflow,
Terraform, rehearsal, deployment, query-identity, frontend, posture, route, and
smoke evidence. Historical reread/supersession artifacts and optional
observation packets are not required.

This authorization continues through one fresh strict diagnostic and, only
after diagnostic acceptance, one fresh Waf/500 -> Waf/800 certification chain.
Pre-mutation retry and schedule rollover are operational continuation; after a
traffic start there is no workload rerun. A genuine application, SQL, security,
deployment, fixture, workload, evidence, or restoration failure ends the
campaign with an immutable terminal report. A genuine medium performance
failure leaves `db.t4g.medium` uncertified. No RDS resize, xlarge fallback,
threshold relaxation, cache/workload change, or new remediation is authorized.

Any later separately authorized diagnostic-only Waf/800 must use the new batch
workload. Every RDS CPU minute must be below 65%; HTTP 5xx and network
errors must each remain below 0.1%; screenshot tile success must be at least
99%; admission-timeout 503s must be zero; screenshot-batch p95 must be at most
750 ms and history-batch p95 at most one second; PostgreSQL SQLSTATE `57014`
must be absent from the exact production API log streams for the traffic
interval; authorization SQL must no longer dominate Performance Insights; and
the optimized history fallback must appear in the bounded token evidence; and
`IO:DataFileRead` must remain strictly below 50% whenever the fallback has
sampled AAS. Independently, its Advanced Database Insights SQL statistics must
prove positive calls, zero temporary blocks, and aggregate block-read time
strictly below 50% of total SQL time. Diagnostic evidence cannot seed a
certification chain.

Use `scripts/load/start-waf800-batch-diagnostic.ps1` for that one run. Its
operator config is external and hash-bound and must declare
`diagnosticOnly=true`, the exact 810/1800/40960/10 workload, the batch schema
and endpoint-shape hash above, the new release SHA/digest/revisioned API and
worker task definitions, the ACL-restricted `historyFallbackQueryIdentity`
receipt reference and its SHA-256,
`historyFallbackPiEvidenceVersion="queryid-sqlstats-v1"`, three role-tagged
private harness artifacts with SHA-256 bindings, the expected generator IPv4,
and the same exact `resources` posture used by the Waf monitor. Add
`resources.accountId=135775632425` and put
the existing SNS topic ARN at `resources.notificationTopicArn`. Bind the exact
production CloudFront distribution at `resources.cloudFrontDistributionId`;
the controller proves that distribution still serves the `school-pilot.net`
alias and is associated with the bound global WebACL. Bind the classifier
metric at `resources.wafDeviceClassifierMetricName=schoolpilot-production-device-ingest-classifier`.
Do not add a
`certification` or `predecessorResultPath` property.

The controller rehashes that private receipt and requires its application SHA,
image digest, API task revision, worker task revision, DBI resource identity,
compiled-SQL hash, parameter-signature hash, schema hash, engine version, and
`track_io_timing=true` assertion to match the live diagnostic contract. The PI
request and sealed result must carry the same receipt hash, query-ID hash,
release-identity hash, DBI-resource hash, SQL/schema hashes, and API runtime
task-definition hash. Certification repeats these bindings at the chain root,
stage attestation, PI request/result, and supervisor envelope, and Waf/800 must
inherit them unchanged from its sole sealed Waf/500 predecessor. Raw query IDs,
SQL text, DB resource IDs, and private paths remain restricted; ordinary logs
and PI evidence contain only their hashes and sanitized measurements.

```powershell
$config = "$env:LOCALAPPDATA\SchoolPilot\load-gates\diagnostic-waf800-batch.json"
$sha = (Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash.ToLowerInvariant()
pwsh -NoProfile -File scripts/load/start-waf800-batch-diagnostic.ps1 `
  -ConfigPath $config -ExpectedConfigSha256 $sha -Mode Validate
pwsh -NoProfile -File scripts/load/start-waf800-batch-diagnostic.ps1 `
  -ConfigPath $config -ExpectedConfigSha256 $sha -Mode Run
```

`Validate` is non-mutating: its harness preflight is captured in memory and it
does not create the evidence directory or any run artifact. It proves the
exact private production task, WAF `BLOCK`, RDS medium, Redis small, NAT,
fixture, batch endpoint, and 20x40 cohort contract. WAF validation requires the
live `DeviceIngestClassifier` to remain priority 25 with `COUNT`, an exact
`POST` method match, the exact
`^/api/(classpilot/)?device/(heartbeat|screenshot)$` URI regex, the
`device-ingest` output label, and its bound visibility metric. It also requires
`DeviceIngestRateLimit` to remain exactly 100000 requests per five minutes
and `ApiRateLimit` exactly 50000 requests per five minutes, including the
reviewed priorities, IP aggregation, scope-down statements, metrics, global
CloudFront scope, and distribution/WebACL association. Redis validation proves
that `redisCacheClusterId` is an available `cache.t4g.small` member of the exact
bound replication group, with the group and cluster independently reporting
the same node type and identity.

Before `Validate`, use `scripts/load/database-insights-lease.ps1` to capture the
exact RDS monitoring posture and enable Advanced mode with Performance Insights
retention 465. The lease must observe the same private, available
`db.t4g.medium`, its bound DBI resource ID, no pending reboot, and the reviewed
PI metrics. It changes no database class, storage, parameter group, workload,
or threshold. `database-insights-monitoring-lease-v3` also captures and verifies
the exact Performance Insights KMS key, Enhanced Monitoring interval and role,
and sorted CloudWatch database-log exports. Its schema-3 private receipt binds a
canonical `rds-preserved-monitoring-posture-json-v1` envelope and its SHA-256.
An absent Enhanced Monitoring role is represented by JSON `null` only when the
interval is zero, and no database-log exports is represented by the literal JSON
array `[]`; neither condition is encoded as an empty SSM parameter. Its public
binding contains only hashes for private paths, KMS identities, and IAM role
ARNs.

Before acquiring a lease, apply the reviewed
`database-insights-lease-watchdog` Terraform resources. This medium-only module
is instantiated in production and nowhere else; non-production outputs remain
null. It provisions the deterministic Scheduler group, least-privilege
Scheduler launcher and SSM Automation roles, the exact Automation document,
an encrypted 14-day SQS dead-letter queue, an Automation-failure EventBridge
rule, and a queue-depth alarm wired to the existing operational SNS topic.

Acquisition creates and independently verifies one fixed-name, per-database
recurring Scheduler guard **before** the first RDS mutation. Its start date is
the immutable lease expiration, its expression is `rate(15 minutes)`, and it
has no end date. It uses `ActionAfterCompletion=NONE`, a 60-second maximum event
age, and zero same-invocation Scheduler retries. Each recurrence is the next
bounded restore attempt; the guard never disappears merely because Scheduler
successfully launched one attempt. Its universal target is
`ssm:StartAutomationExecution` for
`schoolpilot-production-db-insights-restore-v2` at the literal numeric document
version `1`, never `$DEFAULT`. Acquisition rejects an existing fixed-name guard
or a still-active Automation generation for any
`schoolpilot-production-db-insights-restore-v*` document before creating a new
receipt.

The immutable private receipt binds
`aws-scheduler-ssm-recurring-restore-v2`, the exact account, region, DB ARN and
DBI resource identity, expiration, lease-generation hash, schedule expression
and target, numeric Automation version and content SHA-256, initial monitoring
posture, execution roles, encrypted DLQ, failure rule, and retry policy. The
SSM target carries exactly one nonempty value for every parameter. Its preserved
monitoring posture is independently decoded, structurally validated, and hashed
by the lease controller, certification supervisor, and Automation runtime; no
consumer trusts a serialized Scheduler target without rebuilding it. Lease-v2,
guard-v1, and restore-document-v1 receipts are historical-only and are never
translated into this contract. The
numeric version and content hash are independently re-read from SSM during
acquisition and validation; disarm requires the exact bound schedule target to
still carry them. Ordinary logs and sealed evidence retain only the immutable
binding, schedule, document, role, rule, and DLQ hashes. The fixed schedule name
remains the cross-host lease lock.

Every scheduled SSM invocation first proves that the exact ENABLED guard and
lease generation still match its immutable input. A receipt-bound manual
invocation may also resume the same exact guard in DISABLED state, but a
missing guard is accepted only after independently proving exact Standard/7;
any mismatched generation fails the Automation and reaches the alarmed failure
path. Each invocation has at most 600 seconds to
restore and verify the exact database identity and captured Standard/seven-day
posture: `db.t4g.medium`, PostgreSQL engine/version and DBI resource ID,
Performance Insights enabled with the captured KMS key, Enhanced Monitoring
interval/role, sorted database-log exports, no pending modifications, and
in-sync parameter groups. Scheduled invocations retain the recurring guard.
The manual mode first converges and verifies Standard/7 while the guard remains
ENABLED and retryable, then disables the exact generation, drains the complete
Scheduler delivery-age window, reverifies posture, and idempotently deletes
only that generation. The EventBridge rule and DLQ report terminal Automation
failures only. Neither a successful Scheduler delivery nor an EventBridge
status is accepted as convergence evidence.

The rejected diagnostic
`diagnostic-waf800-medium-queryid-20260722T074700Z-4454554b6e70-r1` and its
fixture, lease, controller, and evidence artifacts are historical-only. Its
otherwise healthy workload does not overcome the client-side PI timestamp
decode failure or malformed empty restoration parameters, and it cannot be
patched, rebound, replayed, or used as a certification predecessor. Before any
new fixture preparation or workload approval, the corrected release must prove
the v3/v2 contract with one bounded no-traffic Standard/7 -> Advanced/465 ->
Standard/7 lease round trip against the live absent-role/empty-export posture.
That proof must end with the exact guard removed, no active matching Automation,
an empty DLQ, and the alarm healthy. Remediation approval does not authorize a
new diagnostic or certification workload.

The subsequent no-traffic proof under release
`e12f833628200af2a9f1487f5e140744a2ecf547` is also historical-only for
readiness. The application remained healthy and recovery restored the exact
Standard/seven-day posture, but the ordinary manual restore wrapper decoded
the nested Scheduler target without `ConvertFrom-Json -DateKind String`.
On an Eastern-time operator host that changed an immutable `+00:00`
`ExpiresAtUtc` member to `-04:00`, so the SSM guard correctly rejected the
drifted invocation. Do not reuse the release-bound smoke receipt, image
digest, query receipt, task revisions, or
`medium-pi-restore-e12f833-20260722T151353Z` readiness packet.

All PowerShell JSON ingress under `scripts/load` must preserve date-shaped
scalars as strings and run on PowerShell 7.5 or newer. The AST conformance test
must reject every `ConvertFrom-Json` command that lacks the literal
`-DateKind String` argument or lives in a file with an older runtime floor.
SSM restore parameters must already be nonempty strings; casting a decoded
`DateTime` back to text is not acceptable. A new release must complete one
fresh no-traffic Standard/7 -> Advanced/465 -> Standard/7 proof through the
ordinary receipt-bound wrapper before any fixture preparation or workload is
separately approved.

The rejected diagnostic
`diagnostic-waf800-medium-datekind-20260722T233716Z-b2918be83d4d-r1` and all
of its fixture sources, partial preparation state, receipts, lease candidates,
and evidence paths are historical-only. The refresh and verification stages
completed, but the external preparation wrapper disappeared before snapshot
publication without persisting an owned child-process exit status. That is an
orchestration/lifecycle failure; the evidence does not prove which external
runtime terminated the wrapper. Never resume, republish, reconstruct, or bind
that run.

All new Waf/800 diagnostic preparation uses the repository-owned PowerShell
7.5 preparation system. An ACL-restricted
`waf800-diagnostic-prep-manifest-v1` binds the immutable run, release,
controller, fixture inputs, query receipt, pinned timezone data, UTC execution
window, roots, freshness limits, credential validity, and one-attempt policy.
`start-waf800-diagnostic-preparation.ps1 -Mode Start` returns a durable ticket
and launches a detached supervisor; the caller does not own the preparation
worker lifetime. Before launch, Start publishes one immutable launch admission;
the detached child validates that admission and authors the immutable ticket
after first publishing a durable launch-presence record. The ticket binds the
supervisor identity, launch admission, and control paths; no preparation worker
can launch before it is committed. The supervisor holds a cross-session run-lock
file, owns the complete worker process tree through a non-breakaway Windows Job
Object, persists the worker's PID and creation identity, redirects stdout and
stderr to private files, and commits the worker exit code and completion before
it interprets worker output. Its terminal result binds the admission, ticket,
run-lock, ownership proof, journal, receipt, and snapshot evidence. Its internal
limit is 35 minutes.

The worker records each admitted and completed stage in the ACL-private,
hash-chained `diagnostic-prep-journal-v1`. After refresh, verification,
freshness, and exact source hashing succeed, it seals an immutable
`fixture-preparation-receipt-v1` before publication. The receipt alone is not
completion evidence: a binder must also verify the journal's
`terminal_commit/completed` record, the terminal journal hash, and the exact
five-file snapshot manifest. Snapshot publication and diagnostic binding use
same-parent staging directories and atomic directory renames.

For a future run whose authorization explicitly allows it, exactly one
`ResumePublication` may recover publication only. Recovery is filesystem-only:
it cannot refresh, verify, call AWS, acquire a lease, or start traffic. It
requires the original processes and named mutex to be absent, the sealed
receipt and five sources to remain byte-identical and eligible, unchanged
repository/release/script/manifest identities, no downstream run artifacts,
and either an absent final snapshot or an exact already-published snapshot.
A partial or mismatched final root is terminal and is never repaired,
overwritten, or deleted. Diagnostic and certification controllers independently
validate the mandatory `fixturePreparation` provenance and reject rehearsals,
historical receipts, manual reconstruction, or any receipt, journal, snapshot,
release, or controller drift.

Recovery admission is itself immutable and is the first recovery-attempt
artifact. A missing mutable state update after admission is reported as an
incomplete admitted recovery, never treated as permission to make another
attempt. Status and recovery may reconcile a coherent immutable terminal result
or a persisted worker-exit observation after an interrupted mutable state
commit, but cannot weaken or reconstruct worker, journal, receipt, or snapshot
evidence.

Repository release readiness rehearses this machinery only with an offline
fake provider and a harmless local child supervised for at least 26 wall-clock
minutes. Neither rehearsal may contact SchoolPilot, AWS, RDS, Redis, or live
fixtures. Readiness does not authorize production fixture generation, a
Database Insights lease, an eligible diagnostic binding, workload traffic, or
certification; each requires the separately approved immutable run contract.

Run the two durable rehearsal modes separately from a clean exact merged SHA.
Each mode creates an ACL-private external artifact root and an immutable
evidence receipt; it never uses the ordinary transient CI cleanup path:

```powershell
$EvidenceRoot = Join-Path $env:LOCALAPPDATA `
  "SchoolPilot\aws-cost-rollout\diagnostic-prep-readiness\$((git rev-parse HEAD).Trim())"
New-Item -ItemType Directory -Path $EvidenceRoot | Out-Null
# Apply the documented current-operator-only protected ACL before invoking the modes.

pwsh -NoProfile -File tests/aws-rollout-diagnostic-preparation.test.ps1 `
  -Mode OfflineRehearsal `
  -EvidenceOutputPath (Join-Path $EvidenceRoot "offline-rehearsal.private.json")

pwsh -NoProfile -File tests/aws-rollout-diagnostic-preparation.test.ps1 `
  -Mode HostSmoke -HostSmokeSeconds 1560 `
  -EvidenceOutputPath (Join-Path $EvidenceRoot "host-smoke-26m.private.json")
```

Do not shorten `HostSmokeSeconds`; the mode rejects values below 1,560. Both
receipts must say `diagnosticEligible=false`, `externalContactPermitted=false`,
`trafficStarted=false`, and `leaseAcquired=false`. Independently rehash the
retained journal, result, receipt, snapshot, binding (offline rehearsal), and
evidence files before adding them to the readiness packet.

The Windows CI preparation suite is a fail-closed contract test, not a durable
rehearsal receipt: it uses private temporary roots and removes them when the
test completes. Do not claim its transient files as readiness evidence or add a
broken artifact upload that points at no stable workspace path. After the
corrective merge, run the offline fake-provider flow and the 26-minute harmless
host-supervision smoke from the exact merged SHA under reviewed external,
ACL-private roots. Preserve their sanitized terminal results, journal hashes,
fixture-preparation and binding receipts, and elapsed-time evidence for the
readiness packet. Require the host smoke's
`diagnostic-prep-host-supervision-smoke-v2` receipt: independently rehash its
embedded canonical terminal `Status`, canonical terminal journal record, full
journal, immutable supervisor result, and supervisor state; also require the
record's chain hash to equal the terminal hash bound by `Status`. A v1 host
smoke receipt is historical-only and cannot prove readiness. The host smoke
must be launched from a disposable initiating shell and polled from a separate
shell so its evidence proves survival beyond the former caller-owned timeout.

The durable `launch-safe-20260711` fixture authority is continuity input only;
it is not a historical diagnostic snapshot. Before the diagnostic, create one
new current-user-only ACL-private mutable continuity root. Copy only
`fixture-state.private.json` and `fixture-ownership.private.json` from the
durable authority into that root, byte-for-byte, and independently verify the
source and destination SHA-256 values. In a separate ACL-private support root,
copy the fixture config and required DPAPI/operation documents with the same
hash discipline.

Before refresh, validate the exact fixture identity, two owned schools, 20
teachers, one office user, zero pending intents, and no hold or cleanup state.
Do not copy any historical device, auth, command, verification, snapshot, or
diagnostic artifact. Old diagnostic snapshots remain historical and
ineligible. Reuse the mutable continuity root sequentially for the diagnostic,
Waf/500, and Waf/800; each stage performs its own refresh/verification and
publishes a new immutable five-file stage snapshot before the next stage may
touch the continuity root.

For the authorized production diagnostic, start from the tracked
[`scripts/load/waf800-diagnostic-prep-manifest.template.json`](../scripts/load/waf800-diagnostic-prep-manifest.template.json).
Copy it to a fresh ACL-private external directory, replace every `__...__`
placeholder, retain the exact key set, and bind every path and SHA-256 before
admission. Never generate a per-run PowerShell wrapper. The template contains
references only; credential-document contents remain outside the repository.
Require one JSON value, no `testControls`, and current-user-only protected ACLs,
then use the repository-owned lifecycle exactly as follows:

```powershell
$ManifestPath = "C:\absolute\private\fresh-run\prep-manifest.private.json"
$ManifestSha256 = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$Prep = "scripts/load/start-waf800-diagnostic-preparation.ps1"

pwsh -NoProfile -File $Prep -Mode Validate `
  -ManifestPath $ManifestPath -ExpectedManifestSha256 $ManifestSha256

$Ticket = pwsh -NoProfile -File $Prep -Mode Start `
  -ManifestPath $ManifestPath -ExpectedManifestSha256 $ManifestSha256 |
  ConvertFrom-Json -DateKind String -Depth 100
if ($LASTEXITCODE -ne 0 -or $Ticket.accepted -ne $true) {
  throw "Preparation admission failed."
}

$TerminalPreparationStatuses = @("completed","failed","timed_out","interrupted")
$PreparationStatusDeadline = [TimeSpan]::FromMinutes(40)
$PreparationStatusWatch = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $Status = pwsh -NoProfile -File $Prep -Mode Status `
    -ManifestPath $ManifestPath -ExpectedManifestSha256 $ManifestSha256 |
    ConvertFrom-Json -DateKind String -Depth 100
  if ($LASTEXITCODE -ne 0) { throw "Preparation status validation failed." }
  if ([string]$Status.status -in $TerminalPreparationStatuses) { break }
  if ($Status.healthy -ne $true -or
      -not [string]::IsNullOrWhiteSpace([string]$Status.finding)) {
    throw "Preparation supervision became unhealthy at the reported last-known stage."
  }
  if ($PreparationStatusWatch.Elapsed -ge $PreparationStatusDeadline) {
    throw "Preparation status polling exceeded its bounded 40-minute deadline."
  }
  Start-Sleep -Seconds 15
}
$PreparationStatusWatch.Stop()
```

`ResumePublication` is not a general retry. Invoke it at most once only when the
run-specific authorization permits recovery and the terminal status plus sealed
receipt meet the filesystem-only recovery contract:

```powershell
$Recovery = pwsh -NoProfile -File $Prep -Mode ResumePublication `
  -ManifestPath $ManifestPath -ExpectedManifestSha256 $ManifestSha256 |
  ConvertFrom-Json -DateKind String -Depth 100
if ($LASTEXITCODE -ne 0 -or $Recovery.status -cne "completed") {
  throw "The one publication recovery failed and the run is terminal."
}
$Status = pwsh -NoProfile -File $Prep -Mode Status `
  -ManifestPath $ManifestPath -ExpectedManifestSha256 $ManifestSha256 |
  ConvertFrom-Json -DateKind String -Depth 100
```

After a successful terminal status, and only after the separately authorized
v3 lease exists, bind the group atomically from the exact status references:

```powershell
$FixtureReceiptPath = "C:\absolute\private\fresh-run\run-control\fixture-preparation-receipt.private.json"
$LeaseReceiptPath = "C:\absolute\private\fresh-run\database-insights-lease.private.json"
pwsh -NoProfile -File scripts/load/bind-fresh-diagnostic.ps1 `
  -ManifestPath $ManifestPath -ExpectedManifestSha256 $ManifestSha256 `
  -FixturePreparationReceiptPath $FixtureReceiptPath `
  -ExpectedFixturePreparationReceiptSha256 `
    (Get-FileHash -LiteralPath $FixtureReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant() `
  -SupervisorTicketPath $Status.ticket.path `
  -ExpectedSupervisorTicketSha256 $Status.ticket.sha256 `
  -SupervisorResultPath $Status.result.path `
  -ExpectedSupervisorResultSha256 $Status.result.sha256 `
  -DatabaseInsightsLeaseReceiptPath $LeaseReceiptPath `
  -ExpectedDatabaseInsightsLeaseReceiptSha256 `
    (Get-FileHash -LiteralPath $LeaseReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant() `
  -ExpectedGeneratorPublicIp "__CURRENT_BOUND_GENERATOR_IPV4__"
```

The final stop-loss authorization includes this production recipe after the
same frozen release has sealed readiness. No additional code, schema,
controller, evidence layer, or approval is introduced between readiness and
the one strict diagnostic.

Before either deployment, prepare one production saved plan solely as
zero-change readiness evidence. Obey the weekday plan/deployment guards above,
require clean `main == origin/main` at the merged SHA, initialize only from the
committed lock file, and use the reviewed production variables:

The prior four-change plan for commit
`27e518e65c5e75de30e9b9104d5b252625302dfb` (saved-plan SHA-256
`10a2951bfcfb2cabf7f66f36c3bd521ac967fd647ee76572fc5ed2c4456035ed`)
and its private failure evidence (SHA-256
`051ad5c879cf27f9655289cee4a96a14cf5b65470062b4a378f84db00851815d`)
are historical-only failure records. Never apply or reuse that plan, carry its
hashes into a fresh readiness packet, or treat its evidence as current
approval. Keep the artifacts outside the repository under their existing
restricted access controls; do not copy their private contents into this
runbook.

```powershell
$GitSha = (git rev-parse HEAD).Trim()
if ($GitSha -cne (git rev-parse origin/main).Trim()) {
  throw "Readiness requires main == origin/main."
}
if (-not [string]::IsNullOrWhiteSpace((git status --porcelain))) {
  throw "Readiness requires a clean worktree."
}

$PlanPath = Join-Path $PlanRoot "waf800-prep-readiness-$GitSha.tfplan"
terraform -chdir=infra init -backend=false -lockfile=readonly -input=false
if ($LASTEXITCODE -ne 0) { throw "Terraform initialization failed." }
terraform -chdir=infra plan -input=false -lock-timeout=5m `
  -var-file=production.tfvars -detailed-exitcode "-out=$PlanPath"
$PlanExitCode = $LASTEXITCODE
if ($PlanExitCode -ne 0) {
  if ($PlanExitCode -eq 2) {
    throw "Readiness requires an exact zero-change Terraform plan."
  }
  throw "Terraform readiness planning failed."
}

$PlanJson = terraform -chdir=infra show -json $PlanPath |
  ConvertFrom-Json -DateKind String -Depth 100
if ($LASTEXITCODE -ne 0) { throw "Terraform plan JSON inspection failed." }
$ChangedResources = @($PlanJson.resource_changes | Where-Object {
  @($_.change.actions) -notcontains "no-op"
})
$ChangedOutputs = @($PlanJson.output_changes.PSObject.Properties | Where-Object {
  $_.Value.actions -and @($_.Value.actions) -notcontains "no-op"
})
if ($ChangedResources.Count -ne 0 -or $ChangedOutputs.Count -ne 0) {
  throw "Readiness Terraform plan is not zero-change."
}
$PlanSha256 = (Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash.ToLowerInvariant()
```

Review the human plan and JSON, retain the exact saved-plan SHA-256 with the
readiness evidence, and **do not run `terraform apply`**. A zero-change plan is
proof of posture only; it grants no infrastructure mutation.

The readiness packet is complete only when it contains:

- the remediation audit, exact merged SHA, PR, and exact-SHA CI, CodeQL,
  Gitleaks, and Trivy results;
- the late-created per-SHA admission marker, immutable passed terminal marker,
  the inspected-to-consumed `classpilot-tile-auth-plan-rehearsal-v1` receipt, its
  immutable consumption sidecar, their common protected execution-authority
  SHA-256, exact candidate/baseline/network bindings, base-preflight evidence,
  and predeployment and postdeployment
  `transactional-plan-scenarios-v2` rollback/residue evidence;
- the deployed image digest, API and worker task-definition revisions, frontend
  publication identity, and fresh pre/post-deployment query-identity receipt;
- SHA-256 values for all three preparation scripts and the frozen preparation,
  journal, binding, diagnostic, and certification contracts;
- the post-merge offline fake-provider preparation/binding receipt and the
  separate 26-minute disposable-shell host-smoke journal, status, terminal
  result, and elapsed-time evidence;
- the reviewed zero-change Terraform plan, its SHA-256, human/JSON review
  evidence, and an explicit record that no apply occurred; and
- an authorization attestation binding the frozen release to the subsequent
  diagnostic and conditional certification path, with no historical
  reread/supersession prerequisite and no Terraform apply.

The acquisition preflight reads the live Scheduler group, numeric SSM document
and content hash, both role trusts and complete permission sets, SQS encryption
and empty-queue posture, EventBridge failure rule, and CloudWatch alarm. It
requires no unreviewed attached policies, the exact inline permissions, an
empty SQS-managed-encryption DLQ, and the alarm to target only the existing
operational SNS topic. Any absent, partially applied, paginated, or drifted
resource fails closed before schedule creation and before Advanced mode. The
same infrastructure and live ENABLED-guard checks run again after Advanced
convergence and during lease validation.

Acquisition also retains the detached local hash-bound watchdog and does not
return success until its ACL-restricted heartbeat is fresh. Loss or reboot of
the operator host leaves the recurring AWS-native guard armed. `Validate`
requires both a fresh local heartbeat and the exact live ENABLED schedule.
Manual, controller, and local-watchdog restores use a local mutex keyed by
account/region/database, supplemented across hosts by the active execution of
the pinned manual SSM document. Acquisition explicitly drains every active
numeric version of that fixed-name document before creating a new guard. The
local process performs no RDS or Scheduler restoration mutation: it starts the
receipt-bound manual Automation, waits for that exact execution and all
matching versions to become terminal, then independently requires Standard/7
and an absent schedule. A partial restore, disable, delivery drain, reverify,
or deletion failure is terminal and leaves the fixed-name guard resource as a
fail-closed lock against another lease. Each AWS
CLI process is bounded to 60 seconds. Keep the lease active through the
publication-delayed evidence seal, then restore and disarm it on every terminal
outcome. A restore, schedule, Automation, DLQ, alarm, or disarm failure blocks
progression. Historical receipts lacking this recurring guard are ineligible
even if they carry the v2 lease label.

Use a fresh 90-minute diagnostic lease after the new diagnostic fixture
refresh, verification, freshness check, and atomic stage snapshot succeed.
Bind a new immutable diagnostic ID, config/controller hashes, generator IPv4,
run/binding/evidence roots, release identities, query receipt, and reserved
stage-local lease path. Run one `Validate` and one strict 30-minute Waf/800
diagnostic traffic start. The existing hash-identical filesystem-only
publication recovery is the only preparation recovery.

Certification uses a distinct bounded 480-minute lease spanning Waf/500
through the final Waf/800 evidence seal; do not reuse a diagnostic receipt or
extend an existing receipt. The recurring guard remains armed across both
certification stages while schedule-appropriate scaling is restored between
them. For example:

```powershell
pwsh -NoProfile -File scripts/load/database-insights-lease.ps1 `
  -Mode Acquire -DbInstanceIdentifier schoolpilot-production-db `
  -ReceiptPath C:\absolute\private\fresh-certification-lease.json `
  -LeasePurpose certification -MaximumLeaseMinutes 480
```

The returned contract includes only the receipt/status/watchdog path hashes,
receipt hash, local-watchdog heartbeat hash/state, immutable recurring-guard
binding hash, schedule/document/role/rule/DLQ hashes and state, and expiration.
Store the private receipt path, numeric document binding, and raw AWS schedule
input only in the ACL-restricted diagnostic or certification config/receipt.

`Run` takes a run-wide OS mutex keyed by evidence directory and run ID before
checking or creating artifacts, preventing two same-run controllers from
racing. It refuses any start whose conservative two-hour
mutation/readiness/monitor/terminal-validation/restoration window overlaps the
weekday 05:45 or 10:00 ET scaling boundaries, durably captures desired
capacity plus the scalable target,
scheduled-action hash, policy hash, and suspended flags, then pins API 6/6
healthy with min 6/max 8 while traffic runs. It never edits a schedule, WAF,
RDS, Redis, task definition, or deployment. Its `finally` path restores the
exact capture and verifies service/target health; after a killed controller,
run the same command with `-Mode Restore` to complete that idempotent recovery.
A restoration failure is terminal `scaling_restoration_failed` evidence.

The coordinator revalidates the complete WAF association/rule and Redis
group/member posture immediately before releasing traffic and again before a
successful terminal result. It runs the normal AWS monitor with the diagnostic
profile, which requires 30 of 30 contiguous one-minute RDS CPU points across
the 30-minute traffic window and requires every point to remain strictly below
65%; the generic 95% telemetry allowance does not apply to diagnostic RDS CPU.
All normal traffic/latency/coverage gates remain intact. After the exact traffic
interval, the controller re-reads the bound revisioned API task definition,
requires its one `api` container to use the reviewed production `awslogs`
group/region/prefix, and runs a fully paginated `FilterLogEvents` query against
only the derived API stream prefix for SQLSTATE `57014`. Any match is terminal;
the result stores only the interval, count, and hashes of the log binding, never
raw log messages, event IDs, stream IDs, or log-group names.

The controller retains hashes/categories rather than SQL text and fails if
aggregate tile-authorization load reaches 50% of average DB load. Fallback
identity does not use top-load discovery: it filters Advanced PI
`GetResourceMetrics` by the receipt's exact PostgreSQL
`db.sql_tokenized.db_id` and uses
`db.sql_tokenized.stats.calls_per_sec.avg` as the primary metric. Exactly one
support token must match the bound native ID plus the `requested_tiles`,
`heartbeats`, and `lateral` structure. Each fallback-positive application
summary must represent one complete UTC-minute-aligned 60-second interval and
must carry the compiled-SQL identity hash plus the SHA-256 of the exact API
task-definition ARN resolved by that running ECS task as
`apiRuntimeTaskDefinitionSha256`. The controller rejects edge fragments or
summaries from another revision. PI call statistics must be positive in every
such fallback-active minute, and their integrated calls must cover the
application's bound fallback database-read count. Total time,
block-read time, shared-block reads, and temporary-block metrics must be
complete and stable; temporary reads/writes must be zero; and block-read time
divided by total SQL time must be strictly below 50%. If filtered AAS is
positive, the existing token-filtered `db.wait_event` coverage and strict
`IO:DataFileRead < 50%` gate also remain mandatory. If AAS is exactly zero for
the millisecond query, record `not_applicable_zero_sampled_load`, require no
sampled-wait ratio, and still require positive per-minute call coverage plus the
strict call-time block-read ratio. Never fabricate a zero wait ratio. Missing,
ambiguous, drifted, unstable, malformed, or unpaginated evidence fails closed
under `queryid-sqlstats-v1`.
The terminal artifact is explicitly
`diagnosticOnly=true`, `certificationEligible=false`,
`supervisorSealed=false`, and `predecessor=null`. The certification supervisor
also forces `LOAD_DIAGNOSTIC_ONLY=false` and rejects any monitor or predecessor
carrying diagnostic markers, so this result cannot seed or be sealed into the
fresh Waf/500 -> Waf/800 chain.

Only a completely accepted diagnostic may proceed. Create a fresh Waf/500
with no predecessor, refresh and publish its own immutable fixture snapshot,
then run one 510-device, 30-minute traffic start around 22:30 ET. Require a
supervisor-sealed accepted result whose Database Insights state is retained
for Waf/800.

Restore scaling between stages without releasing the certification lease.
Refresh the continuity root again, publish a distinct Waf/800 snapshot, and
create Waf/800 using only the newly sealed Waf/500 predecessor. Both stages
bind the identical frozen application SHA/digest, API/worker revisions, query
identity, workload/evidence contracts, lease, and
`expectedRdsInstanceClass=db.t4g.medium`. Start Waf/800 around 01:15 ET so its
90-minute interval contains the existing 01:30 purge and 02:00 rollup. Start
each stage's `Validate`/`Run` within 60 minutes of its own fixture verification.
If readiness misses the evening cutoff, shift the certification schedule
exactly 24 hours and regenerate external IDs and immutable artifacts without a
code change or new approval.

Restore schedule-appropriate scaling after every terminal outcome and restore
Database Insights Standard/7 after the final evidence seal or any failure.
Bounded provider/evidence reads may complete inside the existing attempt, but
a startup failure before the start gate is terminal and cannot create a fresh
binding, fixture preparation, validation, or run. Traffic is never rerun after
its start gate releases.
Evidence unavailability after bounded collection is terminal
`not certified - evidence unavailable`, not a medium-capacity finding. A
genuine application, SQL, security, fixture, deployment, latency, CPU, error,
workload, or restoration failure stops the campaign without a remediation.
If an otherwise valid run fails solely on RDS CPU, medium remains uncertified.
No xlarge path, RDS resize, cache/workload change, or threshold relaxation is
authorized.
Success is a supervisor-sealed Waf/800 terminal result binding the frozen
release and observed `db.t4g.medium`; every other outcome is an immutable
terminal report, not another remediation.

The RDS capacity path below is retained as a separately reviewable procedure;
it is not authorized by this remediation. Before any future resize, require the
monitor amendment, explicit approval, a fresh price/Cost Explorer projection,
PITR/orderability checks, and a new encrypted manual snapshot. Handle a pending OS update separately. The resize
plan must be exactly 0 add / 1 in-place change / 0 destroy, limited to the
existing instance and temporary immediate application. After availability and
empty pending modifications, restore `db_apply_immediately=false` with a
separate normalization plan. Then run the xlarge private chain including the
eight-hour `Waf/endurance`; no additional min-6 endurance lease is authorized.
Every T4g stage retains credit balance strictly >24 and zero surplus charges.
Only the resized capacity track enforces the new latency, queue, total-IOPS,
and hours-2-8 regression gates: read and write latency p95 <20 ms and peak <50
ms, queue-depth p95 <1 with no three-minute period >=2, total ReadIOPS +
WriteIOPS p95 <2400 and peak <3000, and a nonnegative regression slope over at
least 5h50 of the intended six-hour hours-2-8 window. Directional IOPS remain
evidence only. The medium baseline does not acquire these new capacity
thresholds.

Use `scripts/load/validate-rollout-plan.ps1` before any saved-plan apply. Its
phase-specific resource allowlists and action counts are authoritative; a
Terraform summary count alone is insufficient. Plan validation and state
backup do not grant approval to apply.

For `RdsResize`, pass `BudgetAcknowledgementPath` and its SHA-256 to the
validator. The acknowledgement must bind the exact saved resize-plan hash,
account, region, USD currency, approval, and all three hashed fresh evidence
files: price, Cost Explorer projection, and the verified manual snapshot.
These are the accepted typed shapes (timestamps, identifiers, storage values,
and prices must be freshly observed, not copied from this example):

```json
{"schemaVersion":1,"type":"aws_rds_price_evidence","observedAtUtc":"REPLACE_ISO_8601_UTC","accountId":"135775632425","region":"us-east-1","currency":"USD","targetRdsInstanceClass":"db.t4g.xlarge","hourlyOnDemandUsd":0.29,"estimatedMonthlyUsd":211.70,"sourceUrl":"https://aws.amazon.com/rds/pricing/"}
```

```json
{"schemaVersion":1,"type":"rds_cost_explorer_projection","generatedAtUtc":"REPLACE_ISO_8601_UTC","accountId":"135775632425","region":"us-east-1","currency":"USD","targetRdsInstanceClass":"db.t4g.xlarge","monthlyEstimateUsd":365.25,"monthlyBudgetUsd":350}
```

```json
{"schemaVersion":1,"type":"rds_manual_snapshot_evidence","observedAtUtc":"REPLACE_ISO_8601_UTC","snapshotCreateTimeUtc":"REPLACE_ISO_8601_UTC","accountId":"135775632425","region":"us-east-1","snapshotArn":"arn:aws:rds:us-east-1:135775632425:snapshot:REPLACE_NAME","sourceDbInstanceIdentifier":"schoolpilot-production-db","sourceDbInstanceClass":"db.t4g.medium","engine":"postgres","status":"available","encrypted":true,"kmsKeyId":"REPLACE_KMS_KEY_ARN"}
```

```json
{"schemaVersion":1,"type":"rds_resize_budget_acknowledgement","approved":true,"approver":"REPLACE_APPROVER","acknowledgedAtUtc":"REPLACE_ISO_8601_UTC","targetRdsInstanceClass":"db.t4g.xlarge","resizePlanSha256":"REPLACE_EXACT_64_HEX_PLAN_HASH","accountId":"135775632425","region":"us-east-1","currency":"USD","monthlyBudgetUsd":350,"temporaryBudgetBreachAcknowledged":true,"pendingOsUpdateHandledSeparately":true,"orderabilityVerified":true,"pointInTimeRecoveryVerified":true,"manualSnapshotEncrypted":true,"manualSnapshotArn":"arn:aws:rds:us-east-1:135775632425:snapshot:REPLACE_NAME","manualSnapshotEvidence":{"path":"C:/absolute/evidence/rds-snapshot.json","sha256":"REPLACE_64_HEX"},"awsPriceEvidence":{"path":"C:/absolute/evidence/rds-price.json","sha256":"REPLACE_64_HEX"},"costExplorerProjectionEvidence":{"path":"C:/absolute/evidence/rds-projection.json","sha256":"REPLACE_64_HEX"}}
```

The approval's own `acknowledgedAtUtc` is evidence too: both saved-plan
validation and certification reject it when older than 24 hours or more than
five minutes in the future, even if every file hash is recomputed.

The resized monitor configuration must also copy the exact observed post-resize
values into `resources.expectedRdsPosture`; placeholders are not valid:

```json
{"expectedRdsPosture":{"engine":"postgres","engineVersion":"REPLACE_EXACT_VERSION","allocatedStorageGiB":0,"maxAllocatedStorageGiB":0,"storageType":"REPLACE_EXACT_TYPE","storageEncrypted":true,"multiAz":false,"publiclyAccessible":false,"performanceInsightsEnabled":true,"dbSubnetGroupName":"REPLACE_EXACT_NAME","vpcSecurityGroupIds":["sg-REPLACE"]}}
```

Replace both numeric zero placeholders with the exact positive observed GiB
values (maximum must be at least allocated), and replace every string
placeholder. The supervisor compares this object to the live RDS engine,
version, storage, encryption, Multi-AZ, subnet-group, security-group, private
access, and Performance Insights posture at Validate and immediately before
traffic.

The arrival-capacity and WAF/alarm sections below document controls already
present in the current production baseline. Do not reapply them merely to start
the optimized-build chain.

## Current arrival-capacity baseline (already applied; verification only)

Do not plan or reapply the historical arrival-capacity remediation. Before the
fresh Waf chain, verify production remains on private ECS subnets with both NAT
gateways present, Route 53 latency measurement enabled, Redis small, both WAF
rate rules in `BLOCK`, and API desired capacity at or below two outside the
night-gate lease. The already-live contract is API scalable-target maximum
eight, weekday 05:45 America/New_York scale-up to minimum six, weekday 10:00
scale-down to minimum one, 70% Average CPU target tracking, and the metric-math
running-task alarm. Any drift is a separate reviewed correction; starting this
certification chain does not authorize an infrastructure apply.

After apply, verify both scheduled actions use `America/New_York`, the exact
weekday 05:45 scale-up has minimum six, the exact weekday 10:00 scale-down has
minimum one, and the API alarm has fresh desired/running datapoints. If the
same-day 05:45 action has already passed, temporarily set the API scalable
target minimum to six and wait for six healthy/warm API tasks before the load
gates. Restore the schedule-appropriate runtime minimum only after both WAF
gates. Do not lower the minimum while a gate is running.

If the scheduled-action contract is invalid, hold the live target at minimum
six/maximum eight, stop progression, and correct it with a separately reviewed
saved plan. Do not disable the schedules or restore the measured-unsafe
minimum-two arrival floor. An application regression uses the captured previous
API/worker task-definition rollback; an API OOM on the already-selected
512/2048 emergency revision blocks progression. Never roll back this phase by
changing ECS networking, NAT, Redis, Route 53, or WAF.

## Current WAF and alarm baseline (already applied; verification only)

Do not rerun the historical WAF/alarm creation plan or the prior diagnostic
partial smoke. Verify the live 100,000/5-minute device-ingest and 50,000/5-minute
generic API rules remain in `BLOCK`, both per-rule WAF alarms are healthy, and
the Redis alarms have real `CacheClusterId` datapoints. Never detach WAF. The
next authorized traffic is the engineering-capacity Waf/500 -> Waf/800 run
owned by `start-classpilot-capacity-acceptance.ps1`; historical results and
drills cannot seed it.

## Deferred phase 2: public ECS while NAT remains (inactive)

Keep the canonical profile unchanged during this phase. Explicitly override
only the ECS subnet posture for the reviewed public-task plan; the profile
continues to retain NAT and Route 53 latency measurement:

```powershell
terraform -chdir=infra plan -var-file=production.tfvars `
  '-var=ecs_tasks_in_public_subnets=true' `
  '-var=waf_rate_rule_action=block' `
  -out $PlanPath
```

Required shape: **0 add / 2 change / 0 destroy**, limited to API/worker network
configuration. Before apply, record fresh typed public-subnet evidence with
exactly two unique subnet IDs in two availability zones, validate the saved
plan, and retain its canonical network hash:

```powershell
$PublicValidation = pwsh -NoProfile -File scripts/load/validate-rollout-plan.ps1 `
  -Phase PublicEcs -PlanPath $PlanPath -PlanSha256 $PlanSha256 `
  -PublicSubnetEvidencePath $PublicSubnetEvidencePath `
  -PublicSubnetEvidenceSha256 $PublicSubnetEvidenceSha256 | ConvertFrom-Json
if (-not $PublicValidation.valid) { throw "PublicEcs plan validation failed" }
$ExpectedNetworkSha256 = $PublicValidation.shape.network.canonicalNetworkSha256
```

Apply only that saved plan, run the guarded same-image networking deployment, and verify public task
IPs, ALB-only inbound access, migration, ECR, SSM, CloudWatch, RDS, Redis,
Google, SendGrid, read-only Stripe, minimal Anthropic, Telegram `getMe`, login,
WebSockets, and scheduler egress.

```bash
./scripts/deploy.sh production --backend \
  --same-image-networking-stage PublicEcs \
  --expected-app-sha <40-hex-certified-app-sha> \
  --expected-image-digest sha256:<64-hex-certified-digest> \
  --expected-api-task-definition <full-active-api-task-definition-arn> \
  --expected-worker-task-definition <full-active-worker-task-definition-arn> \
  --expected-network-config-sha256 <PublicValidation.shape.network.canonicalNetworkSha256>
```

This mode requires the stage's exact public-network and NAT posture, clones the
two exact digest-pinned definitions into fresh revisions, runs the normal
migrations-only task, and uses the existing scaling hold and strict convergence
checks. It re-enumerates every running API/worker task and ENI before mutation,
under the hold, after migration, after final convergence, and throughout
bounded recovery. Every task must use the expected revision, every ENI must use
the hashed subnet/security-group set and have a public IPv4 address, and every
API private IP must be the complete healthy ALB target set. It contains no
Docker build, push, or tag path.

Run the 810-socket 90-minute gate, then the exact 24-hour `MonitorOnly` soak.
The final six hours require all 360 fresh one-minute datapoints, under 1 MiB
total NAT bytes, no drops/allocation errors, and no upward trend.

## Deferred phase 3: NAT removal (inactive)

Only after the soak passes, merge a phase-specific `production.tfvars` PR that
sets `ecs_tasks_in_public_subnets=true` and `enable_nat_gateway=false`. This
records the already-live public-ECS posture and introduces NAT removal together
only when the phase is authorized. Keep `route53_measure_latency=true`.
Required shape: **0 add / 0 change / 6 destroy**—two private default routes,
two NAT gateways, and two EIPs only.

Validate the destroy plan first with `-Phase NatRemoved` and retain its saved
file, SHA-256, verified state backup, and the validator's
`nat_pre_destroy_recovery_contract`. Capture and hash that contract outside the
repository before apply; it contains the exact six resource addresses, original
per-AZ subnet/route-table/allocation topology, forward-plan hash, and required
six-add inverse shape.

A Terraform saved plan is bound to the state lineage and serial from which it
was created. It therefore cannot be both a valid six-create plan and be created
while those same six objects still exist in production state. This runbook does
not mislabel a stale synthetic-state plan as an applicable rollback. The sealed
pre-destroy contract plus verified state backup is the reviewed recovery
artifact available before destruction. Immediately after the reviewed destroy
apply—and before guarded redeployment, egress checks, or progression—create the
real `enable_nat_gateway=true` saved plan against the new production state and
validate it as the exact inverse of the retained forward plan:

```powershell
$NatDestroyValidation = pwsh -NoProfile -File scripts/load/validate-rollout-plan.ps1 `
  -Phase NatRemoved -PlanPath $NatDestroyPlan -PlanSha256 $NatDestroyPlanSha256 |
  ConvertFrom-Json
if ($NatDestroyValidation.shape.preDestroyRecoveryContract.type -ne
    "nat_pre_destroy_recovery_contract") { throw "Missing NAT recovery contract" }
$NatDestroyValidation | ConvertTo-Json -Depth 30 |
  Set-Content -LiteralPath $NatPreDestroyContractPath -Encoding utf8NoBOM
$NatPreDestroyContractSha256 = (Get-FileHash -LiteralPath $NatPreDestroyContractPath -Algorithm SHA256).Hash.ToLowerInvariant()
# Apply that exact saved destroy plan, then create $NatRollbackPlan.
pwsh -NoProfile -File scripts/load/validate-rollout-plan.ps1 `
  -Phase NatRollback -PlanPath $NatRollbackPlan -PlanSha256 $NatRollbackPlanSha256 `
  -ForwardPlanPath $NatDestroyPlan -ForwardPlanSha256 $NatDestroyPlanSha256
```

`NatRollback` must be exactly six additions and an exact per-address inverse:
two VPC EIPs, two public NAT gateways in the original distinct subnets, and two
default routes in the original distinct route tables. Provider-computed IDs
must be driven by the reviewed EIP-to-NAT and NAT-to-route references; unknown
stable fields or cross-wired AZ paths fail validation. Record the rollback-plan
SHA-256 in `natRollbackPlanSha256` and retain the exact forward plan as
`natForwardPlanPath`/`natForwardPlanSha256` (with its filename phase in
`natForwardPlanPhase`) in the rollback config. The rollback controller opens
both files read-only, keeps both handles locked, re-runs the trusted
`NatRollback` inverse validator, re-hashes both open streams immediately before
apply, and applies only the reviewed six-add plan. Retain a verified OneDrive
AES-GCM state backup. The controller then waits for NAT,
then restores both ECS services to captured private networking. Delete both
unused saved plans only after phase acceptance.

Run the same guarded command with `--same-image-networking-stage NatRemoved`
and the same canonical PublicEcs network hash,
repeat all egress checks and the 810-socket
gate, and verify no NAT gateway remains. Confirm delayed billing reports
`NatGateway-Hours` at zero before final cost acceptance.

## Deferred phase 4: Route 53 latency measurement (inactive)

Only after NAT removal is accepted, merge a phase-specific
`production.tfvars` PR that changes `route53_measure_latency` from `true` to
`false`. Required shape: **1 add / 1 alarm change / 1 destroy**, with the health
check replacement created before the old check is destroyed. Abort for any
hosted-zone, DNS, nameserver, CloudFront, or unrelated change.

Require every Route 53 checker to report exact HTTP 200 on HTTPS `/health` and
the replacement alarm to remain `OK` for three one-minute periods.

## Deferred phase 5: Redis micro and final workload (inactive)

Confirm no pending maintenance. Create a uniquely named manual snapshot from
`schoolpilot-production-redis-001` and wait for `available`. Merge only the
`production.tfvars` change to `redis_node_type="cache.t4g.micro"`.

Required Terraform shape: **0 add / 1 change / 0 destroy**, limited to the
replication group node type. Apply and wait for Redis `available`.

Run 510/30 minutes, 810/90 minutes, 1,010/10-minute burst, and one 810/eight-hour
endurance run in that order. The eight-hour run is both the Redis and full-stack
endurance gate. Require a subsequent automated Redis snapshot to become
available before acceptance.

## Acceptance and remaining holds

The exact traffic/resource thresholds are in `docs/SCALE_READINESS.md` and are
enforced cumulatively by the harness plus AWS monitor. Additionally verify
rollup/purge completion under ten minutes, scheduler heartbeat, storage forecast
above 20% headroom at 60 school days, screenshot/Redis success logging removal,
per-service usage bands, and current gross cost projection.

Keep the disabled synthetic tenants for 30 days after deactivation, then perform
the counted cleanup. Retain Container Insights until five stable live school
days have passed; disable it only in a separate reviewed change. Physical
managed-Chromebook enrollment/screenshot/heartbeat/command/reconnect/isolation
testing remains the final real-student onboarding hold.

## Cost governance

Keep `Project` and `Environment` active as cost-allocation tags. The gross
whole-account budget is $350/month with forecast alerts at 80%/95% and actual
alerts at 85%/100%, delivered to the billing email and production SNS. Cost
Anomaly Detection remains $10 absolute and 20% impact. After one complete fully
tagged school month, add a SchoolPilot-specific budget at 115% of that month's
tagged gross cost.

An RDS resize approval must attach a fresh AWS price and Cost Explorer
projection and explicitly acknowledge any temporary breach of the $350 gross
budget. Budget and forecast alerts remain enabled and informational; they are
never automatic rollback triggers.
