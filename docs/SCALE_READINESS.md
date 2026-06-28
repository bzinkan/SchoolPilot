# SchoolPilot Scale Readiness

**Target:** 2,000 concurrently active ClassPilot devices on the standard HA AWS posture.

## Current Gate

Broad ClassPilot onboarding stays gated until staging and production-like testing prove:

- Web ECS tasks run at 2+ desired count with `SCHEDULER_ENABLED=false`.
- Exactly one scheduler worker service runs with `SCHEDULER_ENABLED=true`.
- Startup migrations run as a deploy step before service rollout, not as normal web boot work.
- RDS is Multi-AZ with enough storage and connection headroom for the configured task count.
- Redis is a TLS-required multi-AZ replication group with at least one replica and automatic failover.
- ECS tasks run in private subnets behind the ALB; CloudFront reaches the ALB through the HTTPS `api-origin` hostname.
- WAF and CloudWatch alarms are active.
- RLS remains enabled through the production-like connection path.

## Runtime Controls

Production ECS web tasks:

- `RUN_MIGRATIONS_ON_STARTUP=false`
- `SCHEDULER_ENABLED=false`
- `DB_POOL_MAX=20`
- `RLS_GUC_ENABLED=true`

Production scheduler worker:

- command: `node dist/worker.js`
- `SCHEDULER_ENABLED=true`
- `SCHEDULER_DB_POOL_MAX=5`

Migration task:

- task definition family: `schoolpilot-production-api`
- image: same digest as the release
- override env: `RUN_MIGRATIONS_ONLY=true`, `SCHEDULER_ENABLED=false`

## Load Gate

Run the ClassPilot load test at 500, 1,000, then 2,000 active devices. Model:

- WebSocket auth and reconnect behavior.
- 10-second heartbeats.
- 30-second screenshots.
- Teacher dashboard polling and command broadcasts.
- School-scoped realtime delivery.

Use `npm run load:classpilot` with `LOAD_BASE_URL` and `LOAD_DEVICE_MANIFEST`.
Set `LOAD_ENFORCE_THRESHOLDS=true` for gate runs.

Pass thresholds:

- heartbeat p95 below 500 ms
- API 5xx below 0.1 percent
- no DB pool exhaustion
- sustained RDS CPU below 65 percent
- sustained Redis CPU and memory below 70 percent
- WebSocket delivery remains school-scoped
- no cross-tenant/RLS failures through the production-like path

## Heartbeat Retention

Raw `heartbeats` retention remains bounded by each school's `retentionHours` setting, default 720 hours. The scheduler purges old raw rows in 5,000-row batches. Long-term reporting comes from `daily_usage`, which is rolled up hourly and stores aggregate usage by student and date.

Before increasing beyond the 2,000-device gate, revisit partitioning or archival for `heartbeats`; do not let raw heartbeat growth become the long-term analytics store.

## Failure Drills

Document these before lifting the ClassPilot gate:

- RDS Multi-AZ failover.
- Redis primary failover.
- ECS rolling deploy with two API tasks and one worker.
- Scheduler duplicate-safety check with advisory locks.
- Frontend rollback.
- Database restore proof.

## Rollback Notes

- ECS rollback: update the API and scheduler worker services back to the previous task definition revision.
- Migration rollback: data/schema rollback must be planned per migration. Do not assume ECS rollback reverses DDL.
- RDS/Redis HA settings should be changed during a maintenance window; validate provider replacement/modify behavior in staging first.
