# API pool readiness activation

This release adds automatic removal of an API task whose main connection pool
has stopped making progress under demand. The detector is deliberately separate
from lightweight ECS container liveness. The ALB path changes only after the
backend has deployed and every running API task has proved its readiness startup
contract. A SchoolPilot deployment does not publish the Chrome extension.

## Runtime contract and limits

`/livez` stays session-free and DB-free, with the existing ECS health command.
`/readyz` returns cached task-local readiness without acquiring a connection or
querying the database on the health-check request. The detector samples every
second, shorter than the five-second pool checkout timeout. A full main pool must have no acquire/release/remove progress for
at least 60 seconds under observed demand before confirmation begins. It uses
the existing session pool, at most one outstanding bounded probe, and requires
two successful confirmations at least ten seconds apart. A failed independent
database probe defers task isolation, because restarting all API tasks cannot
repair a shared database outage. The detector stops and its probe drains with
the existing shutdown sequence and shared 15-second deadline.

Task startup emits `api_pool_readiness_started` with contract version 1,
`path=/readyz`, the three timing fields above, and the standard runtime
environment, service, release, instance and start metadata. These fixed,
identifier-free fields bind activation to the exact source and task log stream.

ALB detection remains three failed checks, 30 seconds apart, with a five-second
timeout. Pool confirmation, ALB detection, replacement startup and deregistration
are separate intervals. Do not promise a two-minute total recovery. If all
registered targets are unhealthy, ALB can fail open; readiness is not a guarantee
against all application or database outages. Preserve existing capacity limits,
task resources, RLS, pool sizes, task-definition identities and cookie stickiness.

## Deploy before activation

1. Run backend type checks/build, the complete serial test suite, the detector
   tests, `node --test tests/deploy-api-readiness.test.mjs`, and the required
   access/tenant/deployment evidence checks. Exercise the detector against the
   real PostgreSQL fixture before deployment, including main-pool exhaustion,
   healthy bursts, recovery, shared-database failure and shutdown.
2. Merge and deploy from clean `main` using the documented guarded backend
   procedure in `CLAUDE.md`. Finish exact-image API/worker convergence, target
   health, migration/RLS and public/detailed health verification. Record the
   deployed full Git SHA, immutable digest, and exact API/worker task definitions.
   Leave the ALB on `/livez` throughout that rollout.
3. Confirm no concurrent deployment, scheduled scaling boundary or capacity
   experiment is active. The utility fences activation within five minutes of
   weekday 05:45 and 16:00 America/New_York scheduled capacity changes; rollback
   remains available. Activation requires one to three stable API tasks,
   exactly one worker and all old targets fully removed. The plan binds exact
   task inventory; a scale event invalidates it and requires fresh evidence.

## Plan and activate

The utility defaults to a read-only plan. Use a new evidence directory outside
every checkout. It records resource identities and configuration hashes without
serializing environment or secret values. It does not modify a task definition,
image, service, capacity, stickiness, health threshold or Terraform state.

```powershell
node scripts/deploy-api-readiness.mjs --operation plan `
  --sha <verified-full-git-sha> --digest <verified-sha256-digest> `
  --api <verified-api-task-definition-arn> `
  --worker <verified-worker-task-definition-arn> `
  --evidence <new-absolute-external-evidence-directory>
```

The plan verifies the account/region, exact converged services, task-definition
and runtime image digests, Git SHA/role metadata, every running API task's startup
marker in its own log stream, target IP bindings, and the existing health path,
timings and attributes. Wait for CloudWatch startup-log delivery if markers are
not yet available. Do not waive a missing or mismatched marker.

Use the exact returned plan path and hash within 15 minutes:

```powershell
node scripts/deploy-api-readiness.mjs --operation apply `
  --plan <absolute-plan-path> --plan-hash <returned-plan-hash> `
  --evidence <same-external-evidence-directory>
```

Apply refreshes the complete plan preconditions immediately before its only
mutation: `elbv2 modify-target-group --health-check-path /readyz`. It captures an
attempt receipt before writing, observes all exact targets for 120 seconds, then
checks release/configuration identities again. On failure it restores `/livez`
only if the same services, immutable source, desired capacity and other
target-group settings remain unchanged. Expected ECS replacement churn on that
same release does not block restoration.
An uncertain restoration is reported explicitly; inspect live state before
retrying. Receipt files are exclusive creations and never silently overwritten.

After success, collect the ordinary backend operational verification again.
In a separate follow-up baseline-adoption PR, change only production's
`api_alb_health_check_path` from `/livez` to the observed `/readyz`. Keep the
generic default `/livez`. This records an already completed mutation; it does
not authorize or require a Terraform apply. Do not run Terraform while the live
health path and its production baseline differ.

## Rollback and acceptance

If readiness incorrectly removes healthy tasks, restore the health path first:

```powershell
node scripts/deploy-api-readiness.mjs --operation rollback `
  --plan <absolute-plan-path> --plan-hash <returned-plan-hash> `
  --evidence <new-absolute-external-rollback-evidence-directory>
```

Rollback only restores captured `/livez`. It allows an expired receipt and
replacement tasks, but still requires the original service identities, immutable
source, desired capacity and unchanged configuration. It verifies the path
restoration separately from eventual ECS convergence; after restoration, inspect
the services and targets until replacement has completed and ordinary health
verification passes. If a deployment changed the source, a scale event changed
desired capacity, or the utility cannot verify that identity, inspect current
services/targets and perform
the same narrow path restoration through a newly reviewed exact-live-state
procedure. Never restore an old task definition as a substitute. Reconcile the
production Terraform baseline after any verified path rollback.

Before a future backend rollback to an image without `/readyz`, restore `/livez`
and verify healthy targets first. Follow all existing data-compatibility gates;
an ALB path rollback does not make older application code data-compatible.

The activation observation proves endpoint compatibility and healthy routing.
It does not prove an actual stalled task has been replaced. Use local/integration
fault tests for that behavior; never deliberately exhaust a live school pool.
Validate actual classroom traffic, period changes and scheduled scale-in on the
next school day. Require zero acquisition, audit, lifecycle-overflow and shutdown
cleanup failures and no false-positive readiness transitions. Interpret zero
tenant checkouts only with actual per-task demand; quiet tasks are not failures.
