# Product runtime-config operations (wave-1 flags)

`scripts/deploy-product-runtime-config.ps1` is the only sanctioned way to change the
wave-1 product flags on the production API and scheduler worker. Nothing else sets
them: Terraform's ECS services ignore task-definition changes, and `deploy.sh`
carries each service's live environment into every new revision unchanged. Without
this tool a flag could only be flipped by hand-editing a task definition, which is
not allowed.

The tool is modeled on `scripts/deploy-mydesk-runtime-config.ps1`. It dot-sources
`scripts/deploy-classpilot-runtime-config.ps1` for the AWS transport, task cloning,
operation fence, autoscaling hold, health checks and exact convergence. Every other
environment entry, every secret and every task field is fingerprinted and must
survive each clone unchanged.

## Managed names

| Name | Exact values | Unset means | Feature | Activation precondition |
| --- | --- | --- | --- | --- |
| `CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE` | `off`, `on` | `off` | School Library (roadmap PR 1) | none |
| `CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS` | comma-separated lower-case school UUIDs, no spaces, no duplicates | every school (when the mode is `on`) | School Library allowlist | none |
| `PASSPILOT_RULES_MODE` | `off`, `on` | `off` | PassPilot rules (PR 7) | RLS admission of `passpilot_destination_policies`, `passpilot_pass_limits`, `passpilot_encounter_restrictions`, `passpilot_pass_denials` |
| `PASSPILOT_APPOINTMENTS_MODE` | `off`, `on` | `off` | PassPilot appointments (PR 8) | complete preserved 128-table admission; serving source atomic writer contract v1 on both services |
| `CLASSPILOT_DAILY_USAGE_ROLLUP_MODE` | `legacy`, `shadow`, `set_based`, `on` | `shadow` | `daily_usage` rollup (PR 10a) | promotion to `set_based`/`on`: live mode `shadow` plus an evidence file |
| `CLASSPILOT_USAGE_ROLLUP_MODE` | `off`, `on` | `off` | usage rollups (PR 10b) | RLS admission of both `classpilot_usage_rollups` and `classpilot_usage_rollup_days`; serving source SHA coverage contract v1 |
| `CLASSPILOT_DIGITAL_USAGE_MODE` | `off`, `on` | `off` | Digital Usage API (PR 10b) | RLS admission of both `classpilot_usage_rollups` and `classpilot_usage_rollup_days`; serving source SHA coverage contract v1; always requires `CLASSPILOT_USAGE_ROLLUP_MODE=on` |

Values are exact: no case folding, no surrounding whitespace. `on` for the daily
rollup is the alias of `set_based` added by PR 10a; a release older than PR 10a
reads `on` as `shadow`. A flag does nothing until the release that reads it is
serving, so deploy the feature first with its mode unset.

Everything else is refused, including:

- `CLASSPILOT_CAP_*`, `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` and
  `CLASSPILOT_PROTOCOL_V3_ENABLED` (only `deploy-classpilot-runtime-config.ps1`);
- the legacy TURN names (no runtime-config tool changes them);
- `MYDESK_*` and `STUDENT_INFORMATION_AI_IMPORT_MODE` (only
  `deploy-mydesk-runtime-config.ps1`);
- `RLS_ENABLED_TABLES` and `RLS_GUC_ENABLED` (only
  `deploy.sh production --backend --enable-rls-table <bundle>`);
- any secret: the configuration has no secret channel, and a managed name that
  arrives as a task secret blocks the plan.

## When to use it

- To turn a wave-1 feature on or off, or change the School Library allowlist, after
  the feature's release is serving with its mode unset.
- For an emergency turn-off. A turn-off needs no RLS admission and no evidence;
  only the steadiness checks under "Before you start" apply.

## Before you start

- Run from a clean worktree on `main` that equals `origin/main`, for example
  `C:\GitHub\SchoolPilot-deploy`. The tool refuses any other checkout.
- **Main must not move between Plan and Apply, or between Apply and Rollback.** The
  plan records the tool SHA and Apply and Rollback refuse unless `HEAD` still equals
  it. Tell the other sessions to hold merges for the sitting. If main moved, pull,
  discard the plan and plan again.
- One runtime-config operation at a time. This tool holds the same DynamoDB lease
  (`schoolpilot/production/classpilot-runtime-config-v1` in `schoolpilot-terraform-locks`)
  as the ClassPilot and My Desk tools.
- Not on weekdays 04:45–05:59 America/New_York (Apply refuses) and not inside a
  declared deploy freeze or school-day soak.
- Production must be steady: both services stable on one completed deployment, API
  desired count 1–3, the reviewed `100/200` deployment configuration, autoscaling not
  held, the reviewed task sizes (API 1024 CPU / 2048 MiB, worker 512 / 1024), and API
  and worker carrying identical values for all seven names.
- Use a dedicated evidence directory: an absolute path outside the repository,
  either a new leaf or one this tool created (marker file
  `.schoolpilot-product-runtime-evidence-v1`). The My Desk and ClassPilot evidence
  roots are refused.

## Configuration

Keep the configuration in a private file outside the repository (owner-only ACL):

```json
{
  "schemaVersion": 1,
  "environment": {
    "PASSPILOT_RULES_MODE": "on"
  }
}
```

- List only the names you are changing. Every other managed name keeps its live
  value.
- `null` unsets a name, which restores its default. For the school list, `""` also
  unsets it: an empty list means every school, and the tool never writes an empty
  value to a task definition.
- School ids are checked for UUID format only. Confirm each one against the
  `schools` table before planning.
- A configuration that would change nothing is refused.
- A live value that is malformed (set outside this tool) blocks every plan until a
  plan names that variable, which repairs it.

## Plan

Collect the serving identity:

```powershell
aws ecs describe-services --cluster schoolpilot-production-cluster `
  --services schoolpilot-production-api schoolpilot-production-scheduler-worker `
  --region us-east-1 --query 'services[].[serviceName,taskDefinition]'
```

The image digest is the `@sha256:...` suffix of the API container image. The app SHA
is the full 40-character commit of the serving release (the ECR image tag is its
first 12 characters).

```powershell
./scripts/deploy-product-runtime-config.ps1 -Action Plan `
  -ConfigPath $ConfigPath -OutDir $EvidenceDirectory `
  -ApiArn $ServingApiArn -WorkerArn $ServingWorkerArn `
  -ImageDigest $ServingImageDigest -AppSha $DeployedCommit
```

Add `-DailyUsageEvidencePath $EvidencePath` only when promoting the daily rollup.
Plan is read-only against AWS: it reads STS, ECS, ECR and Application Auto Scaling.
Locally it writes only `<runId>-plan.json` (and, on first use, the evidence directory
and its marker). It prints the plan path, its SHA-256, each change
(`name: from -> to`) and the features it activates.

## Review

Open the plan file and check `changes`, `activations`, `prior`, `desired`,
`dailyUsageEvidence`, `apiArn`, `workerArn`, `imageDigest` and `toolSha`. The reviewer
approves the printed SHA-256; Apply accepts only that exact hash and refuses a plan
whose recorded fields disagree with its own configuration.

## Apply

```powershell
./scripts/deploy-product-runtime-config.ps1 -Action Apply `
  -ManifestPath $ManifestPath -ManifestHash $ReviewedManifestSha256 -Execute
```

Apply within two hours of Plan. It re-reads production and re-checks every
precondition, and refuses before any mutation if anything drifted: task definitions,
tags, managed values, deployment configuration, autoscaling, API desired count, the
evidence file's hash or freshness, or the tool SHA. It then takes the lease,
registers API and worker clones that differ from the serving pair only in the
managed names, proves both clones carry exactly the planned values, holds
autoscaling, updates the API, waits for exact convergence, updates the worker,
waits again, restores autoscaling and writes `<runId>-result.json` with status
`applied`.

## Verify

1. Both new revisions (ARNs in the receipt) carry the planned values:

   ```powershell
   aws ecs describe-task-definition --task-definition $NewApiArn --region us-east-1 `
     --query "taskDefinition.containerDefinitions[0].environment[?starts_with(name, 'PASSPILOT_') || starts_with(name, 'CLASSPILOT_SHARED_') || contains(name, 'USAGE')]"
   ```

   Repeat for the worker ARN; the two lists must be identical.
2. `https://school-pilot.net/health` returns 200.
3. Run the feature's own smoke check from its documentation.

## Rollback

```powershell
./scripts/deploy-product-runtime-config.ps1 -Action Rollback `
  -ManifestPath $ManifestPath -ManifestHash $ReviewedManifestSha256 -Execute
```

Rollback takes the same plan and its `applied` receipt. The services must still run
that operation's pair, their values must still equal the plan's `desired`, and main
must still be at the plan's tool SHA. It writes a new plan that restores exactly the
prior values of the names the plan changed (an unset name is unset again) and applies
it through the same checks.

Rollback never widens exposure. It undoes a turn-on, a promotion or an allowlist
extension, but refuses to undo a turn-off or a narrowing: re-enabling something needs
a reviewed new plan that meets its preconditions again. If Rollback refuses for any
other reason (main moved, a later operation ran), write a forward plan from the
`prior` block of the original plan. A turn-off needs no RLS admission or evidence.

## Preconditions

**RLS admission.** Turning on `PASSPILOT_RULES_MODE`, `PASSPILOT_APPOINTMENTS_MODE`,
`CLASSPILOT_USAGE_ROLLUP_MODE` or `CLASSPILOT_DIGITAL_USAGE_MODE` requires
`RLS_GUC_ENABLED=true` and every table of its bundle in `RLS_ENABLED_TABLES`, on the
API and on the worker. The check is exact (comma-separated names, no trimming) and
runs at Plan and again at Apply. Admission itself happens only through
`deploy.sh production --backend --enable-rls-table <bundle>`. The feature's mode
reader also stays off without admission; the tool refuses so a plan can never record
a feature as on when it cannot be.

**Appointment writers.** `PASSPILOT_APPOINTMENTS_MODE=on` requires the complete immutable
`passpilotAppointmentsPostExpand` inventory on API and worker and atomic writer
contract version 1 in their exact serving source SHA. Plan and Apply check this
even when appointments were already on. Keep schema, grants, RLS admission and
the explicit pass-return trigger during a schema-aware feature-off rollback.
See `docs/PASSPILOT_APPOINTMENTS.md` for staged setup and lifecycle requirements.

**Digital usage needs the rollup.** In every plan's resulting state,
`CLASSPILOT_DIGITAL_USAGE_MODE=on` requires `CLASSPILOT_USAGE_ROLLUP_MODE=on`. Turn them on
together or the rollup first; turn them off together or digital usage first.

**Daily rollup promotion.** Moving `CLASSPILOT_DAILY_USAGE_ROLLUP_MODE` from shadow
(unset or `shadow`) to `set_based` or `on` requires an evidence file. Promotion from
`legacy` is refused, because only shadow mode compares the two implementations
(`legacy` and `set_based` always log zero mismatches). Switching between `set_based`
and `on`, or demoting to `shadow`, `legacy` or unset, needs no evidence.

Gather the evidence with CloudWatch Logs Insights on `/ecs/schoolpilot-production-api`
(the worker logs there under the `scheduler-worker/` stream prefix):

```
filter @logStream like /^scheduler-worker\// and event = "classpilot_daily_usage_rollup"
| stats count(*) as runs, sum(processedSchools) as processedSchools, sum(shadowMismatches) as shadowMismatches, sum(failedSchools) as failedSchools by bin(1d)
```

Each school's day D is rolled up once, by the first hourly run after 02:00 local
time on D+1, so a result row for run day D+1 describes school day D. Pick at least
three school days (weekdays with school in session) from the last 30 days where
`processedSchools >= 1`, `shadowMismatches = 0` and `failedSchools = 0`, then write
a private file outside the repository:

```json
{
  "schemaVersion": 1,
  "reviewedAt": "2026-10-08T14:05:00.0000000+00:00",
  "reviewReference": "logs-insights/daily-usage-shadow-2026-10-08",
  "imageDigest": "sha256:<serving image digest>",
  "schoolDays": [
    { "date": "2026-10-05", "processedSchools": 1, "shadowMismatches": 0, "failedSchools": 0 },
    { "date": "2026-10-06", "processedSchools": 1, "shadowMismatches": 0, "failedSchools": 0 },
    { "date": "2026-10-07", "processedSchools": 1, "shadowMismatches": 0, "failedSchools": 0 }
  ]
}
```

`reviewedAt` is an exact round-trip (`o`) timestamp no more than two hours old at
Plan and again at Apply. `imageDigest` must equal the serving digest. Dates must be
distinct weekdays before today in America/New_York and within the last 30 days;
holidays cannot be detected, so do not list them. The plan binds the file's SHA-256;
changing the file afterwards blocks Apply.

## Terminal states (`<runId>-result.json`)

| Status | Meaning | Next step |
| --- | --- | --- |
| `applied` | Both services converged on the planned values; autoscaling restored; lease released. | Verify. |
| `failed_no_service_mutation` | Failed before any `update-service`; the serving pair never changed; lease released. Unused revisions may remain registered. | Fix the cause and plan again. |
| `rolled_back` | A service update failed; fresh clones with the exact prior values were rolled out to both services and proven; lease released. | Read the error and plan again. |
| `recovery_required` (or a stale `preparing`, `api_update_pending`, `worker_update_pending`) | Recovery could not be proven, or the lease transition was ambiguous. The lease, and possibly the autoscaling hold, are kept on purpose. | Follow "Manual recovery" in `CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md` (same lease) before any new Plan. |

A plan that already has a receipt is never applied again; create a new plan.

Usage coverage compatibility is checked against `AppSha` from the exact serving API and worker task definitions and image digest, at both Plan and Apply. `src/config/classpilotUsageModes.ts` at that SHA must declare `CLASSPILOT_USAGE_COVERAGE_CONTRACT_VERSION = 1`. This is required whenever the desired usage flags remain on, including a plan changing other flags. A local working-tree edit or RLS admission cannot make an older release compatible. Turn both usage flags off before an older-image rollback; keep the additive computation-ledger migration and aggregate invalidation triggers. See `CLASSPILOT_DIGITAL_USAGE.md` for unavailable coverage and recovery semantics.
