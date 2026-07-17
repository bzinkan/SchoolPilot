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

Every launch run includes ten second-school canaries first in the manifest,
20 distinct teacher sessions, shared-IP traffic, authenticated WebSockets and
ACKs, forced reconnects, dashboard/history/screenshot GETs, and one-minute
JSONL progress. Teacher WebSocket startups, dashboard polls, and isolation
probes are staggered across their real polling intervals. After screenshot
cache warm-up, each teacher's history and screenshot reads fire together as one
class-sized browser burst, while the 20 independent teacher cohorts are
staggered across the 30-second tile polling interval. Any valid redirect/4xx, known foreign tenant identifier, or
cross-school delivery writes `fatal_gate`, stops traffic, flushes evidence, and
exits nonzero.

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
- `wafDeviceRuleMetricName=schoolpilot-production-device-ingest-rate-limit`
- `wafApiRuleMetricName=schoolpilot-production-api-rate-limit`

Every accepted result is SHA-256-bound as the next stage's predecessor. The
immutable production chain is:

`Waf/500 -> Waf/800 -> PublicEcs/800 -> PublicEcs/24h no-load -> NatRemoved/800 -> Route53/no-load -> Redis/500 -> Redis/800 -> Redis/burst -> Final/endurance`.

The small Week 1 partial smoke is diagnostic only and cannot appear in this
acceptance chain.

The conditional heartbeat-index build is not an acceptance stage and cannot
reuse a predecessor. Its activation evidence, online-migration contract, and
exact restoration SQL are in
[HEARTBEAT_INDEX_PIVOT.md](./HEARTBEAT_INDEX_PIVOT.md). If activated, deploy it
as a new application build and restart the chain at `Waf/500`.

Automatic rollback may dispatch only one unambiguous pre-approved action:

- application regression: previous API and worker task definitions;
- API OOM: digest-matched emergency API revision;
- WAF rate block: only the two rate rules to `COUNT`;
- public ECS: captured private subnets/security groups while NAT still exists;
- NAT removal: digest-verified saved NAT recreation plan, then private ECS;
- Redis: `cache.t4g.small` and wait for `available`.

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

## Arrival-capacity remediation phase

Apply the API arrival-capacity remediation before repeating the failed WAF/500
gate. Run this phase outside the weekday 05:45-10:00 America/New_York arrival
window. First require production to remain on private ECS subnets with both NAT
gateways present, Route 53 latency measurement enabled, Redis small, both WAF
rate rules in `BLOCK`, and API desired capacity at or below two.

Plan from the merged remediation commit with the existing launch overrides:

```powershell
terraform -chdir=infra plan -var-file=production.tfvars `
  '-var=ecs_tasks_in_public_subnets=false' `
  '-var=route53_measure_latency=true' `
  '-var=waf_rate_rule_action=block' `
  -out $PlanPath
```

The existing arrival actions and metric-math running-task alarm are already
live. The only accepted amendment shape is **0 add / 2 change / 0 destroy**:
the API scalable target maximum changes from six to eight, and the weekday API
scale-up action changes from 06:00/minimum two to 05:45/minimum six. The 10:00
minimum-one scale-down and 70% Average CPU target remain unchanged. Abort for
any task-definition, ECS network, desired-count, NAT, Route 53, RDS, Redis,
WAF, alarm, replacement, or destroy action. Create and verify the required
before-plan, before-apply, and after-apply state backups; apply only the reviewed
saved plan and delete it after success.

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
