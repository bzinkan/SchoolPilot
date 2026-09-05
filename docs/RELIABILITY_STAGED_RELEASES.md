# SchoolPilot reliability: staged backend and dashboard releases

## Scope and baseline

This release preserves the #398 student sign-in delivery guard and dashboard
command wording. ClassPilot extension #103 / version 2.8.4 is a separate Chrome
Web Store release and adoption process; neither SchoolPilot stage publishes it.

The September 4, 2026 daytime review (00:00–16:20 America/New_York) found 89
worker tenant-pool acquisition failures, 46 FAB finalization push failures, 26
classroom-state clear push failures, and four API audit-write failures. These
counts describe the earlier image and review window, not the #398 deployment.
The corresponding ALB target latency p50/p95/p99 was 36/170/547 ms.

The #398 baseline was verified separately:

- Source: `547bfd9111be466408542437f2379a8dff815830`.
- Image digest: `sha256:c6f6bead8e07cee2f805e4f151631ea7eff8fcb14447da23202bb60a0ed6b59d`.
- API: `schoolpilot-production-api-emergency:107`, rollout completed at
  `2026-09-04T20:34:46.998Z`.
- Worker: `schoolpilot-production-scheduler-worker:123`, rollout completed at
  `2026-09-04T20:36:25.265Z`.
- Both services were stable at one running/desired task; public health was OK.
- Use `2026-09-04T20:37:00Z` as the earliest complete #398 comparison window.
  Stop it before the first reliability-release task begins serving, and identify
  each task by its task-definition revision and image digest.

A separate CloudWatch comparison from `20:37Z` through `23:25Z` contained 880 API
and 511 worker log records, with no audit-write, WebSocket bootstrap, FAB-finalization,
or classroom-clear failure messages. This was an evening window. Pool acquisition
metrics were absent in that query, so it is not evidence of zero acquisition
failures or an active-school-day acceptance result.

No schema migration, Terraform apply, database pool expansion, or extension
change is part of either stage. Keep the current API 512 CPU / 2048 MiB and
worker 256 CPU / 512 MiB task sizing, autoscaling limits, RLS configuration,
and effective role-specific connection caps unchanged.

## Release 1: backend

Committed lifecycle transitions retain immediate staff notifications. Device
delivery runs in one process-owned FIFO with one active job and at most 256
waiting jobs, outside the producer's tenant/transaction context. Each finalization
attempts old-state clear, replacement-state restore, and current FAB recomputation
in order. Each phase owns and releases its tenant scopes, rechecks current
authority/binding/revision, and leaves recovery to authoritative heartbeat/auth
reconciliation when delivery is stale, fails, or cannot be queued. There is no
automatic replay of retained frames. Scheduler batches drain this work before
producing the next finalization batch.

School audit inserts reuse a matching tenant connection or acquire a fresh
school scope for trusted work outside a request. Cross-school writes are
rejected. Global authentication/system events use a separate internal writer
whose elevated callback contains only the audit insert. Request handlers await
their audit calls; strict failures propagate and best-effort failures are counted.

Student WebSocket bootstrap reports a fixed stage and bounded, allowlisted cause
classification, without raw exception text, SQL, URLs, credentials, or student
and device identifiers. Diagnostic improvement alone is not evidence that the
underlying unknown authentication failures have been repaired.

Pool failures use `database_connectivity`; audit failures use `health_failure`
with `job=auditWrite`; independent lifecycle-delivery failures use
`scheduler_failure`. Pool and audit failure alerts disable database persistence,
and upstream reporting suppresses duplicate alerts for the same checkout failure.
New interval counters supplement existing cumulative counters. Use interval
metrics for fleet sums; never sum repeated lifetime totals as event counts.

Both task-definition renderers stamp the deployed full Git SHA and the correct
API/worker role after merging environment settings. Same-image configuration
operations retain the source image and its release identity. Successful per-frame
WebSocket receive/acknowledgement traffic uses debug logging and aggregate counts.

Both processes stop intake, drain producers, drain lifecycle/classification work,
await monitor disposal, and close named pools under one 15-second hard deadline.
Timeouts identify their shutdown phase and aggregate pool state and exit nonzero.
API WebSocket transport closure allows a two-second handshake grace before
closing unresponsive upgraded connections, including Socket.IO. Transport closure
does not replace the admitted-handler and close-callback drain barriers, and it
does not terminate ordinary active HTTP requests.

Additive response codes preserve existing HTTP statuses and private messages:

| Context | HTTP status | Code |
| --- | --- | --- |
| Requested teaching-session student aggregation is unavailable | 404 | `CLASSPILOT_SESSION_UNAVAILABLE` |
| No requested tile binding is accessible | 404 | `CLASSPILOT_NO_ACCESSIBLE_TILES` |

## Release 2: dashboard

Observation eligibility uses existing authoritative session fields: live mode,
no end time, and a completed roster snapshot. Ineligible observation has an
explicit state. Otherwise authorized metadata remains available.

Terminal denials persist separately from React Query errors and are keyed by
school, viewer, session, endpoint, and exact student authority. Ticks, focus,
reconnect, visibility, targeted refresh, rerenders, timestamp changes, and cache
scrubbing do not re-arm unchanged denied authority. Healthy classmates and
unrelated batches continue normally. A meaningful authoritative change or an
explicit Retry that first refreshes parent state can re-arm the affected scope.

A session-scoped aggregation 404 cancels dependent requests, scrubs telemetry,
disables command targets, and coalesces a parent session-list refresh. It never
falls back to an unscoped student query. Observation denials remain latched across
visibility changes, and cleanup releases the exact viewer lease. Authorized null
screenshots, partial results, transient recovery, response fencing, and global
authorization revocation remain supported.

## Validation, rollout order, and operational acceptance

Before backend release, run backend type/build checks, the complete serial test
suite, the restricted-role RLS lane, test type/cast checks, and the required
privileged-access, tenant-isolation, deployment, and governance evidence checks.
The worker regression uses real PostgreSQL, ten simultaneous class finalizations,
two schools, the worker's actual two-connection main pool, enabled screenshot
policy nudges, exact-bound WebSocket frames, and fully released leases. Queue,
phase isolation, replacement/transfer, shutdown, audit, diagnostic injection,
redaction, and interval-count tests complement that fixture.

Release 2 additionally requires lint/build and dashboard/tile, session lifecycle,
realtime cache, signal-loss, command-context, and browser gates. Fake-clock and
browser request-count tests must cover terminal denial and legitimate recovery.

On September 5, 2026, the operator authorized the dashboard release to ship after
its refreshed validation, with one school currently live. This authorization
supersedes the earlier requirement to hold release 2 until the backend completed
a full school day of operational acceptance. The rollout order remains backend
first, then dashboard, with current-head CI and the applicable local gates passing
before each release. This change in release order does not declare the operational
acceptance checks passed.

Deploy the backend only through the documented guarded path:

```bash
./scripts/deploy.sh production --backend --activate-emergency
```

Verify both services complete on the intended digest and stamped SHA, with the
same RLS settings, sizing, and effective pool limits. Record the rollout's actual
start/completion times and inspect public health and target health.

Operational acceptance of both releases remains **pending**, with observation
planned for Tuesday, September 8, 2026. All of the following must be observed on
the deployed releases with real traffic:

1. An active class transition.
2. A scheduled scale-in with successful cleanup of draining tasks.
3. One complete school day with actual classroom traffic.
4. Zero worker acquisition timeouts, audit-write failures, lifecycle queue
   overflows, and shutdown cleanup timeouts, with existing latency budgets met.

Quiet evening/weekend traffic and synthetic tests do not pass this gate. Review
new WebSocket stage/cause diagnostics separately. On Tuesday, verify that unchanged
denied dashboard authority stops replaying while valid observation and recovery
continue. Record the backend and frontend release identities separately. If the
day lacks actual classroom traffic, a complete school day, or scheduled scale-in
cleanup evidence, keep operational acceptance pending rather than treating the
September 5 deployment authorization as an acceptance result.

If release 2 regresses, roll back the frontend independently. Any backend
rollback must retain #398 and pass the repository's current data-compatibility
checks; do not re-enable retired routes or weaken RLS as a rollback mechanism.
