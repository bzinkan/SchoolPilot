# ClassPilot Digital Usage (Monitored Browser Time)

Digital Usage gives administrators school, grade, class and student totals of the browser activity
ClassPilot observed on managed Chromebooks. The total is called **Monitored Browser Time** (or
ClassPilot Monitored Time, or Chromebook Browser Activity). It is never called "Screen Time":
ClassPilot sees browser activity only, not full-device use.

This document covers the backend (roadmap PR 10b): the `classpilot_usage_rollups` table, its hourly
rollup job, retention, and the read/CSV API. The admin page is PR 11.

## Flags

| Variable | Values | Default | Controls |
|---|---|---|---|
| `CLASSPILOT_USAGE_ROLLUP_MODE` | `off`, `on` | `off` | The hourly worker job that writes rollups |
| `CLASSPILOT_DIGITAL_USAGE_MODE` | `off`, `on` | `off` | `GET /api/classpilot/admin/usage` and the Student Data rollup block |

`src/config/classpilotUsageModes.ts` reads both. Anything but the exact value `on` is off; a malformed
or inconsistent pair (Digital Usage on with the rollup off) turns both off; and `on` still reads as
off until `RLS_GUC_ENABLED=true` and `RLS_ENABLED_TABLES` contains both `classpilot_usage_rollups` and `classpilot_usage_rollup_days` in that
process. Production changes go only through `scripts/deploy-product-runtime-config.ps1`
(`docs/PRODUCT_RUNTIME_CONFIG_OPERATIONS.md`), which sets both names on the API and the worker, refuses
`on` until both tables are admitted on both services and their serving source SHA declares usage coverage contract version 1. It refuses Digital Usage without the rollup.

With both flags off nothing changes: the job returns before any query, and the API router steps aside
to the ordinary unknown-route JSON 404 before authentication.

## Table

`classpilot_usage_rollups` (migration `classpilot-usage-rollups-20260929`, forced RLS with the
canonical `tenant_isolation` policy, reviewed bundle `classpilotUsageRollups`):

| Column | Meaning |
|---|---|
| `school_id`, `usage_date` | School and school-local calendar date (`schools.school_timezone`) |
| `student_id` | Same-school FK to `students`; a hard-deleted student's rows cascade |
| `class_id`, `session_id` | The class and teaching session the observation was attributed to, or NULL; same-school FKs `ON DELETE SET NULL` on that column only, so removing a class keeps the student's time |
| `domain` | Lowercase http(s) hostname without `www.`; `''` for any other URL |
| `classification` | `educational`, `non-educational` or `unknown` |
| `seconds`, `heartbeat_count` | Attributed seconds and counted observations for the grain |
| `computed_at` | When this aggregate grain was inserted or last changed; the day ledger records every successful computation |

The grain `(school_id, usage_date, student_id, class_id, session_id, domain, classification)` is unique
(COALESCE over the nullable columns). No row carries a device identifier.

## Attribution

Each school-local day is computed from `heartbeats` with the v2 session-report rule
(`src/services/classpilotHeartbeatCoverage.ts`):

- Heartbeats without a student, or whose student is not in the school, are ignored.
- One observation per student per second survives across devices, so reconnects, handoffs between
  Chromebooks and duplicate sends never add time.
- Each observation earns the least of 15 seconds, the gap to the same student's next observation, the
  end of the day (or now, for today) and the start of the next excluded interval.
- Tracking-policy-disabled intervals (tracking hours on with after-hours off or limited) and
  server-authored tracking-off intervals are excluded with the same helpers the reports use
  (`trackingPolicyDisabledIntervals`, `serverTrackingDisabledIntervals`). As in class-session reports,
  only server events inside the day are considered.
- The category is the newest `classpilot_ai_decisions` row for the heartbeat, else `heartbeats.ai_category`.
  A non-educational page with a domain is off-task (`non-educational`) unless a teacher-intent exemption
  applies (on the decision or the heartbeat); any other classified page is `educational`; everything else
  is `unknown`.
- Class attribution uses the frozen session roster (`classpilot_session_students`): an observation belongs
  to the newest teaching session whose window (start or roster capture, to the earliest of end, scheduled
  end and 12 hours) holds it. The split is per observation, so a class switch mid-hour divides the time at
  the observation boundary.

Known v1 limits:

- Supervision and coverage contexts are not a class dimension. That time counts toward the student with
  no class.
- Grade scope uses each student's current `students.grade_level`, not the grade at the time.
- Idle and locked screens are counted the way session reports count them (the extension keeps its cadence).
- A day missed entirely while the worker was down is not backfilled; yesterday is still finalized when the
  worker returns, if the retention horizon allows.
- `daily_usage` keeps its fixed 10-seconds-per-heartbeat semantics; Admin Analytics, the parent digest and
  browsing domains are unchanged.

## Hourly job

`runHeavyJobsSerially` calls `rollupClasspilotUsage()` in the top-of-hour block, after the daily usage
rollup and before the :30 retention purge. For each active, ClassPilot-licensed school it:

1. Finalizes yesterday once, using the durable school/day ledger as the authority, at the first
   top-of-hour tick after local midnight. Redis markers are advisory only. All finalizations are queued before today's work.
2. Computes today once even when empty, then refreshes when a heartbeat arrived since its stored processed cutoff (with a five-minute overlap).

Each day is reconciled from one materialized set of computed grains: changed grains are updated, missing
grains are inserted and vanished grains are deleted by three disjoint sibling CTEs. Unchanged aggregates
keep their identity and timestamps and produce no aggregate-row writes. The completion ledger still records
successful empty or unchanged computations and advances their processed cutoff. All changes and completion
remain in one transaction on the scheduler pool under the existing per-school advisory lock; every statement
filters `school_id = $1` itself because the scheduler bypasses RLS. The grain reconciliation uses the same
COALESCE keys as the unique index and a hashable full join rather than one full-day scan per grain.
Administrator cleanup takes that same school lock before its raw-input deletion and removes inputs,
aggregates and coverage atomically with its audit. Retention takes the lock in each existing short
5,000-observation batch and in its aggregate/coverage removal transaction; yields remain outside
those transactions. Cleanup owns a narrow tenant lease through transaction completion and GUC
reset, even when its HTTP response disconnects during the advisory wait. This prevents a paused
writer from recreating completion after removal or an active transaction's client being reused.

Retention safety: the job never rewrites a day that starts before the purge horizon (the top of the
current UTC hour before :30, or now after it, or when this process last finished the purge if later,
minus the school's retention). A one-day-retention school's finished day is therefore captured whole at
00:00 and then left alone while the purge deletes its heartbeats; its rows are removed with the day.

Budget: the job stops taking new work at :25 of the hour in which the heavy job started, so it can never
push that hour's purge out; deferred days are retried next hour. One in-flight school-day is bounded by the
scheduler pool's 60-second statement timeout.

Every run logs one JSON line (worker stream prefix `scheduler-worker/` in `/ecs/schoolpilot-production-api`):

```json
{"event":"classpilot_usage_rollup","schools":0,"finalizedDays":0,"recomputedDays":0,"unchangedDays":0,
 "retentionSkippedDays":0,"deferredDays":0,"failedSchools":0,"rowCount":0,"budgetExhausted":false,
 "durationMs":0,"deadline":"..."}
```

Nonzero `failedSchools` and `deferredDays` are also published as EMF metrics
`UsageRollupFailedSchools` and `UsageRollupDeferredDays` (namespace `SchoolPilot/ClassPilot`).

## Retention and deletion

- `purgeExpiredHeartbeats` deletes rollups and completion records (including empty days) dated before the retention cutoff's school-local date, next to
  `daily_usage`, in the same hourly pass. A failure there is reported and does not skip the school's
  remaining retention steps.
- `POST /api/admin/cleanup-students` clears both usage tables with heartbeats and `daily_usage`.
- The Student Data export includes one student's rollups (`student.monitoredBrowserTime` and a
  "Monitored Browser Time (school days)" CSV section) for administrators in the school-wide scope while
  Digital Usage is on. Teachers never receive them.

## API

`GET /api/classpilot/admin/usage?scope=school|grade|class|student&id=&from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv`

- Auth: the monitoring `adminAuth` chain (authentication, school context, ClassPilot entitlement, active
  school, ClassPilot license, `admin` or `school_admin`).
- `scope` defaults to `school` (no `id`); `grade` takes a grade level, `class` a class id and `student` a
  student id of the caller's school. Anything else is `404 CLASSPILOT_USAGE_SCOPE_NOT_FOUND`.
- `from`/`to` default to today; the range is ordered and at most 366 days
  (`400 CLASSPILOT_USAGE_DATE_INVALID` / `CLASSPILOT_USAGE_RANGE_INVALID`).
- Presented days are clipped to today, to `range.retainedFrom` (the first day wholly inside retention;
  `range.partiallyExpired`). Each presented date requires its own successful completion record;
  `range.computedFrom` is the first covered date in this requested retained range.
  `range.unavailableDates` lists internal holes too; `range.computedDays` and `range.requestedDays` describe
  coverage and `range.partiallyComputed` is true when any eligible date is unavailable.
  Missing days are omitted from numeric `byDay`, totals and top sites. Only successful empty days show zero. `dataState` is `unavailable` when
  nothing can be presented, `live` while any presented day may still change, else `final`.
- Response: `measure`, `scope`, `range`, `dataState`, `totals{monitoredBrowserSeconds,
  instructionalSeconds, offTaskSeconds, unknownSeconds, activeMonitoredStudents, heartbeatCount}`,
  `byDay[]` (with `state`), `topEducationalDomains[10]`, `topNonEducationalDomains[10]`.
- `format=csv`: formula-safe cells, UTF-8 BOM, CRLF rows, `Cache-Control: no-store, private`, and a strict
  `classpilot.usage.export` audit record before any byte is sent.

## Rollout

1. Keep both modes off and deploy the compatible backend with the additive migration. After any prerequisite
   PassPilot rules admission, admit the aggregate table once if it is not already admitted:
   `deploy.sh production --backend --enable-rls-table classpilot_usage_rollups`.
   Then admit the completion ledger separately:
   `deploy.sh production --backend --enable-rls-table classpilot_usage_rollup_days`.
   Confirm both API and worker serve the same compatible source SHA and carry both admissions.
2. Product runtime tool Apply: `CLASSPILOT_USAGE_ROLLUP_MODE=on`.
3. Observe at least one school day of `classpilot_usage_rollup` lines, for example with CloudWatch Logs
   Insights on `/ecs/schoolpilot-production-api`:
   `filter @logStream like /^scheduler-worker\// and event = "classpilot_usage_rollup" | stats sum(failedSchools), sum(deferredDays), max(durationMs) by bin(1h)`.
4. Product runtime tool Apply: `CLASSPILOT_DIGITAL_USAGE_MODE=on` (needed by the PR 11 page).

LOAD VERIFIED is not claimed until a full-day recompute is timed on production-sized data (school-days
larger than about one million heartbeats risk the 60-second statement timeout; the API reads on the main
pool's 15-second timeout).

## Rollback

- Turn both usage flags off with the product runtime tool before deploying an older image.
  Keep the additive tables, policies and invalidation triggers. Retention and cleanup must handle
  completion records too, including successful empty days. Follow the recovery semantics below.

## Computation ledger and rollback

Migration `classpilot-usage-rollup-days-20260930` adds `classpilot_usage_rollup_days`, a forced-RLS school/day ledger, with reviewed singleton bundle `classpilotUsageRollupDays`. The 127-table `classpilotUsageRollupDaysPostExpand` registry target preserves the prior 126-table target and the observed production baseline. Admit the aggregate table first if needed, then this singleton; admission does not enable either product flag.

Each row stores the actual UTC day boundaries, the processed half-open cutoff (`processed_through`), completion time, and `is_final`. The writer commits it after aggregate replacement, including a zero-row result. Under the same school advisory lock it refuses a cutoff at or before the stored one, so queued stale work cannot regress a newer or final snapshot. Refresh probes use the processed cutoff rather than transaction start or commit time; a school queued at 14:00 and computed at 14:20 still checks for 14:10 activity on the next tick. Finalization can repair activity missed by earlier live snapshots while retention still permits a complete day.

There is no initial historical backfill. Existing aggregates without completion records are unavailable until a compatible computation succeeds; completion is never inferred from those rows. Failed, deferred, expired and partly purged days do not acquire successful coverage. `dataState=final` describes the presented days; consumers must also inspect coverage fields to describe a partial range. Student Data and both CSV exports preserve the unavailable dates.

Statement-level INSERT, UPDATE and DELETE triggers on direct aggregate edits invalidate only the affected school/day completion records. Nested foreign-key CASCADE/SET NULL actions preserve completion for the remaining retained rows; The triggers recognize deleted same-school student parents and exact class/session nulling with a missing parent; all other changed fields invalidate coverage. Trigger depth alone cannot distinguish deferred statement-trigger execution. Student deletion removes that student's totals, while class/session deletion removes only attribution. Coverage describes retained data, not deleted records. Hard school deletion removes its ledger through the school FK. The compatible writer restores completion last within its transaction. An incompatible writer or old aggregate cleanup cannot leave those changed dates verified in the corrected reader. Empty-day records have no aggregate rows, so retention and school activity cleanup explicitly delete them too.

Before deploying an older image, turn **both** Digital Usage and usage rollup flags off through the governed setter, keeping the additive migration, ledger and invalidation triggers installed. Do not enable the old reader or writer. The setter checks the exact serving source SHA at both Plan and Apply; table admission alone does not satisfy compatibility. Returning to a compatible release permits activation after both services and admissions are verified. Any legacy writes made during rollback invalidate changed days; today/yesterday can recompute safely inside retention, while older invalidated dates remain unavailable. Operators who deliberately replace or restore aggregate data must invalidate the matching ledger dates in the same transaction; never synthesize completion or remove the triggers to make a range appear complete.
