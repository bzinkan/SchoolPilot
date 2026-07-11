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
- Deploy only the backend from a clean merged `main` with
  `./scripts/deploy.sh production --backend`. Do not deploy the frontend or
  package/upload the ClassPilot extension.
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
then delete the plan:

```powershell
terraform -chdir=infra apply -input=false $PlanPath
if ($LASTEXITCODE -ne 0) { throw "Saved plan apply failed" }
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
./scripts/deploy.sh production --backend
```

Require a successful migration task, API and worker `1/1`, one completed
deployment per service, a healthy ALB target, public `/health`, a current
scheduler heartbeat, and clean startup logs. The deploy also registers—but
does not select—a `schoolpilot-production-api-emergency` revision at
`512 CPU / 2048 MiB`. Record its exact ARN and verify that its image digest
matches the deployed API digest before any load test.

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
| `500-baseline` | 510 | 1,800 s | 40 KiB | 25 |
| `800-gate` | 810 | 5,400 s | 40 KiB | 40 |
| `1000-burst` | 1,010 | 600 s | 50 KiB | 40 |
| `endurance` | 810 | 28,800 s | 40 KiB | 40 |

Every launch run includes ten second-school canaries first in the manifest,
20 distinct teacher sessions, shared-IP traffic, authenticated WebSockets and
ACKs, forced reconnects, dashboard/history/screenshot GETs, and one-minute
JSONL progress. Teacher WebSocket startups, dashboard polls, and isolation
probes are staggered across their real polling intervals. After screenshot
cache warm-up, each teacher's history and screenshot reads fire together as one
class-sized browser burst, while the 20 independent teacher cohorts are
staggered across the 30-second tile polling interval. Any valid 403/429, known foreign tenant identifier, or
cross-school delivery writes `fatal_gate`, stops traffic, flushes evidence, and
exits nonzero.

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
Use these exact WAF CloudWatch dimensions; Validate mode confirms them against
the deployed Web ACL before monitoring begins:

- `wafWebAclName=schoolpilot-production-cloudfront-waf`
- `wafDeviceRuleMetricName=schoolpilot-production-device-ingest-rate-limit`
- `wafApiRuleMetricName=schoolpilot-production-api-rate-limit`

Every accepted result is SHA-256-bound as the next stage's predecessor. The
immutable production chain is:

`Waf/500 -> Waf/800 -> PublicEcs/800 -> PublicEcs/24h no-load -> NatRemoved/800 -> Route53/no-load -> Redis/500 -> Redis/800 -> Redis/burst -> Final/endurance`.

The small Week 1 partial smoke is diagnostic only and cannot appear in this
acceptance chain.
Automatic rollback may dispatch only one unambiguous pre-approved action:

- application regression: previous API and worker task definitions;
- API OOM: digest-matched emergency API revision;
- WAF rate block: only the two rate rules to `COUNT`;
- public ECS: captured private subnets/security groups while NAT still exists;
- NAT removal: digest-verified saved NAT recreation plan, then private ECS;
- Redis: `cache.t4g.small` and wait for `available`.

The supervisor stops traffic if the generator/watcher heartbeat disappears.
The monitor stops immediately on a hard gate and after three consecutive fresh
one-minute resource breaches. A missing metric, missed duration, stale
artifact, notification failure, or incomplete acceptance invalidates the run;
monitoring-completeness failures never guess at an infrastructure mutation.

## Phase 1: WAF and alarms

Plan from merged `main` with:

```powershell
terraform -chdir=infra plan -var-file=production.tfvars `
  '-var=ecs_tasks_in_public_subnets=false' `
  '-var=route53_measure_latency=true' `
  '-var=waf_rate_rule_action=block' `
  -out $PlanPath
```

Required shape: **9 add / 6 change / 0 destroy**. Abort for any ECS networking,
Route 53, NAT, RDS/Redis instance-size, replacement, or unexpected action.

After apply, verify 100,000/5-minute device-ingest and 50,000/5-minute generic
API rules, both per-rule WAF alarms, and real `CacheClusterId` datapoints for
the Redis alarms. Perform a saved-plan `block -> count -> block` drill; each
direction must be only the WebACL in-place change. Never detach WAF. Delete
legacy alarms only after their Terraform replacements have real datapoints and
are healthy.

Run a partial smoke, then the 510-socket 30-minute and 810-socket 90-minute
baselines. Time the latter across school-local 02:00 and a `:30` purge boundary.

## Phase 2: public ECS while NAT remains

Use the profile's public-task value while retaining the Route 53 override:

```powershell
terraform -chdir=infra plan -var-file=production.tfvars `
  '-var=route53_measure_latency=true' `
  '-var=waf_rate_rule_action=block' `
  -out $PlanPath
```

Required shape: **0 add / 2 change / 0 destroy**, limited to API/worker network
configuration. Apply, force a fresh backend deployment, and verify public task
IPs, ALB-only inbound access, migration, ECR, SSM, CloudWatch, RDS, Redis,
Google, SendGrid, read-only Stripe, minimal Anthropic, Telegram `getMe`, login,
WebSockets, and scheduler egress.

Run the 810-socket 90-minute gate, then the exact 24-hour `MonitorOnly` soak.
The final six hours require all 360 fresh one-minute datapoints, under 1 MiB
total NAT bytes, no drops/allocation errors, and no upward trend.

## Phase 3: NAT removal

Only after the soak passes, merge the minimal `production.tfvars` change to
`enable_nat_gateway=false`. Retain public ECS and the Route 53 latency override.
Required shape: **0 add / 0 change / 6 destroy**—two private default routes,
two NAT gateways, and two EIPs only.

After apply, immediately create a separate saved rollback plan with
`-var=enable_nat_gateway=true`; it must be exactly six additions. Record its
SHA-256 in the rollback config and retain a verified OneDrive AES-GCM state
backup. The rollback controller applies only that reviewed plan, waits for NAT,
then restores both ECS services to captured private networking. Delete the
unused rollback plan after phase acceptance.

Force another backend deployment, repeat all egress checks and the 810-socket
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
