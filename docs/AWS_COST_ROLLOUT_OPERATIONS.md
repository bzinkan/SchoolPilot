# AWS Cost-Reduction Rollout Operations

This runbook is the production execution contract for the launch-safe AWS cost
reduction. It is deliberately fail-closed. A passing load summary is necessary
but not sufficient; the corresponding AWS monitor result, rollback evidence,
deployment checks, snapshots, and cost checks must also pass.

## Non-negotiable boundaries

- Use one Terraform operator and the local backend through launch.
- Run the state-backup tool from PowerShell 7 or newer (`pwsh`), not Windows
  PowerShell 5.1 (`powershell.exe`). The script enforces this before any
  filesystem or cryptographic operation.
- Use the committed AWS provider `5.100.0` lock file. Never run
  `terraform init -upgrade` during this rollout.
- Deploy only the backend from a clean merged `main`. While the launch-safe
  2048 MiB API posture is selected, use
  `./scripts/deploy.sh production --backend --activate-emergency`. Do not deploy
  the frontend or package/upload the ClassPilot extension.
- Keep RDS and Redis private. Public IPv4 is only for outbound egress from the
  staged ECS API and worker tasks; the ALB remains the only inbound API path.
- Keep Route 53 DNS, nameservers, CloudFront routing, the HTTPS `/health`
  check, and its alarm. The Route 53 phase disables only latency measurement.
- Keep Container Insights through testing and the first five live school days.
- Do not perform deferred RDS/API downsizing, ARM64, reservations, remote-state
  migration, HA changes, or an extension release.
- Real-student onboarding remains blocked until managed Chromebooks pass the
  physical extension smoke gate in `docs/SCALE_READINESS.md`.

`production.tfvars` contains staged future values. Never run an unreviewed full
apply. Each phase below uses a saved plan with the stated overrides and exact
shape.

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

Enter the commands in this section inside a PowerShell 7+ (`pwsh`) session.
Confirm the host before handling the recovery credential:

```powershell
if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "PowerShell 7 or newer is required; reopen this runbook in pwsh."
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

## Publish and backend deployment

The rollout branch is `codex/aws-cost-reduction-launch-safety`. Before opening
the PR, run backend tests/type-check/build/SOC 2 checks, frontend lint/API-route
assertions/build, dependency audits, fixture tests, PowerShell parser/tests,
Terraform lockfile-only initialization/format/validation, and secret/diff
checks.

Open a draft PR and require green CI, Gitleaks, and CodeQL. Review the full diff,
mark ready, squash-merge, update local `main`, and require a clean tree exactly
equal to `origin/main`. Wait for post-merge CI and Trivy.

Capture the current API and worker task-definition ARNs before deploying. Run:

```bash
./scripts/deploy.sh production --backend --activate-emergency
```

The reviewed flag keeps the current 2048 MiB API serving until a newly
registered, digest-matched 2048 MiB revision is healthy. It binds that exact
revision to the migration task, API service update, and strict stability check;
the worker is updated to the same image digest at its existing 256/512 size.

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
before any load test.

## Synthetic fixture lifecycle

The preparer uses supported production APIs only. Its private config and
artifacts must be under `%LOCALAPPDATA%\SchoolPilot\load-gates`; no real student
record or repository-local secret is permitted.

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

## Load harness and AWS supervision

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
by SHA-256. `Run` consumes the receipt, copies the rollback JSON to
`<evidenceDirectory>/<runId>-bound-rollback-config.json`, writes
`<runId>-bound-monitor-config.json`, and passes that runtime config's hash to
the monitor. Any byte change blocks traffic or, after arming, blocks the
automatic mutation. A receipt or evidence directory cannot be replayed.

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

The medium-RDS production chain is:

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

## Optimized-build certification and conditional capacity path (2026-07-17)

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

For this one remediation, deploy the backend with the release-bound plan gate:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-gate
```

The gate uses the freshly registered digest-pinned emergency revision and the
service network configuration. It must produce the fixed six-scenario,
40-student, 20-sample sanitized aggregate with the teaching-session school
precheck at zero and every unchanged plan threshold passing. It runs before
the autoscaling hold, migration, or service update and cannot start during the
actual 01:15-02:15 America/New_York purge/rollup window. There is no bypass or
sample/cohort/threshold override. A failed, timed-out, malformed, or missing
report stops the deploy without changing either ECS service.

Before certification, run one 30-minute diagnostic-only Waf/800 using the new
batch workload. Every RDS CPU minute must be below 65%; HTTP 5xx and network
errors must each remain below 0.1%; screenshot tile success must be at least
99%; admission-timeout 503s must be zero; screenshot-batch p95 must be at most
750 ms and history-batch p95 at most one second; PostgreSQL SQLSTATE `57014`
must be absent from the exact production API log streams for the traffic
interval; authorization SQL must no longer dominate Performance Insights; and
the optimized history fallback must appear in the bounded token evidence; and
`IO:DataFileRead` must remain below 50% of both every identified fallback
token and their aggregate. Diagnostic evidence cannot seed a certification
chain.

Use `scripts/load/start-waf800-batch-diagnostic.ps1` for that one run. Its
operator config is external and hash-bound and must declare
`diagnosticOnly=true`, the exact 810/1800/40960/10 workload, the batch schema
and endpoint-shape hash above, the new release SHA/digest/revisioned API and
worker task definitions, three role-tagged private harness artifacts with
SHA-256 bindings, the expected generator IPv4, and the same exact `resources`
posture used by the Waf monitor. Add `resources.accountId=135775632425` and put
the existing SNS topic ARN at `resources.notificationTopicArn`. Bind the exact
production CloudFront distribution at `resources.cloudFrontDistributionId`;
the controller proves that distribution still serves the `school-pilot.net`
alias and is associated with the bound global WebACL. Bind the classifier
metric at `resources.wafDeviceClassifierMetricName=schoolpilot-production-device-ingest-classifier`.
Do not add a
`certification` or `predecessorResultPath` property.

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

The controller discovers SQL through `db.sql_tokenized`, retains
hashes/categories rather than SQL text, and fails if aggregate
tile-authorization load reaches 50% of average DB load. It recognizes the exact
optimized cold-history fallback only when the tokenized SQL contains all three
`requested_tiles`, `heartbeats`, and `lateral` markers. For every such top-25
token it performs a token-filtered `db.wait_event` query, requires the filtered
wait totals to cover the token's DB load within the fixed numeric tolerance,
and requires `IO:DataFileRead` to be strictly below 50% both per token and in
aggregate. If no optimized fallback appears in the top 25, the strict
cold-cache diagnostic records that absence and fails closed because the
fallback's own wait mix was not proven. A present token with missing, partial,
malformed, or unpaginated wait evidence also fails closed.
The terminal artifact is explicitly
`diagnosticOnly=true`, `certificationEligible=false`,
`supervisorSealed=false`, and `predecessor=null`. The certification supervisor
also forces `LOAD_DIAGNOSTIC_ONLY=false` and rejects any monitor or predecessor
carrying diagnostic markers, so this result cannot seed or be sealed into the
fresh Waf/500 -> Waf/800 chain.

The corrected release requires a completely fresh Waf/500 with no predecessor,
then Waf/800 using only that sealed Waf/500 result. Both stages must bind the
same new application SHA/digest, the tile-batch workload schema/shape, and
`expectedRdsInstanceClass=db.t4g.medium`. Start Waf/800 around 01:15 ET so its
90-minute interval contains the existing 01:30 purge and 02:00 rollup. Restore
schedule-appropriate scaling after every terminal outcome. If the corrected
run is otherwise valid and still fails solely on RDS CPU, medium remains
uncertified and work stops; an xlarge path requires separate approval.

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
next authorized traffic is the fresh supervisor-owned Waf/500 -> Waf/800 chain
described above; historical results and drills cannot seed it.

## Phase 2: public ECS while NAT remains

Use the profile's public-task value while retaining the Route 53 override:

```powershell
terraform -chdir=infra plan -var-file=production.tfvars `
  '-var=route53_measure_latency=true' `
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

## Phase 3: NAT removal

Only after the soak passes, merge the minimal `production.tfvars` change to
`enable_nat_gateway=false`. Retain public ECS and the Route 53 latency override.
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

## Phase 4: Route 53 latency measurement

Remove only the temporary `route53_measure_latency=true` override. Required
shape: **1 add / 1 alarm change / 1 destroy**, with the health check replacement
created before the old check is destroyed. Abort for any hosted-zone, DNS,
nameserver, CloudFront, or unrelated change.

Require every Route 53 checker to report exact HTTP 200 on HTTPS `/health` and
the replacement alarm to remain `OK` for three one-minute periods.

## Phase 5: Redis micro and final workload

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
