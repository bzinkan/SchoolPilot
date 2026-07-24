# ClassPilot tile authorization plan check

The tile authorization release gate runs the exact SQL exported by
`buildClassPilotTileAuthorizationQuery` against representative 40-student
cohorts. It also runs the production cold-history fallback exported by
`buildHeartbeatTileHistoryBatchQuery` for the authorized `teacher.history`
cohort. Time-sensitive authorization rows are provisioned only inside one
rollback-only transaction; the gate changes neither schema nor committed data.

Build the release and run the gate with the same database environment used by
the API:

```powershell
npm run build
npm run check:classpilot-tile-auth-plans
```

The command starts one serialized `REPEATABLE READ`, write-capable transaction
under the existing application role and takes a transaction-scoped advisory
lock. It first audits every `teaching_sessions` row while using the existing RLS
super context. It fails if `school_id` is null, the parent group is missing, or
the session and group schools differ.

The gate then discovers exactly one unambiguous, active SchoolPilot-owned
synthetic fixture from the non-billable school marker and
`synthetic-load-fixture:<fixtureId>:class:<ordinal>` class markers. The retained
base must contain a primary teacher, another active teacher, an active
office-staff membership, a conflict-free 40-student class roster, a distinct
conflict-free 40-student office cohort, and same-school active sessions plus
historical device mappings for every student. Ordinary tenant data and ambient
open sessions are ineligible.

Using explicit random IDs and parameters, the gate inserts exactly 43
transaction-local rows: one co-teacher relationship, one correctly
school-scoped open live teaching session, one active office-supervision
context, and 40 office-supervision assignments. It does not consume sequences,
update existing rows, insert heartbeats, or call an application API. Discovery
is constrained to these seeded objects and produces one complete
representative cohort for each label:

- `teacher.live` and `teacher.history`
- `co_teacher.live` and `co_teacher.history`
- `office_staff.live` and `office_staff.history`

All six discoveries, authorization measurements, history-fallback
measurements, schema checks, and both query-ID probes remain in that same
transaction. Measurements run with `app.is_super=off` and `app.school_id`
bound to the selected tenant. The command performs two unmeasured warmups and
at least 20 measured
`EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)` samples. It fails
closed unless every authorization scenario has p95 at or below 50 ms, maximum
at or below 100 ms, zero temporary read/write blocks, and no `SubPlan` nodes.

The history fallback uses the same two warmups and measured sample count. Each
plan must return no more than 400 heartbeat rows and contain a per-pair `Limit`
executed for all 40 requested pairs, backed by
`heartbeats_school_device_student_timestamp_idx`. A `WindowAgg`, a sequential
or parallel sequential scan of `heartbeats`, any `SubPlan`, temporary-file I/O,
p95 above 50 ms, or maximum above 100 ms fails the gate. The fixed 40-student
cohort, ten-row history limit, existing index identity, and thresholds cannot
be relaxed by command-line flags.

The report is built in memory before the write transaction is explicitly
rolled back; there is no write-transaction commit path. A new super-scoped
read-only transaction then proves that all 43 explicit IDs are absent. Only
after rollback and zero residue succeed may the CLI emit a passing report.
Connection loss, timeout, query drift, rollback failure, residue, or a
concurrent gate conflict fails closed.

The existing counts-only plan report remains unchanged. A separate
`transactional-plan-scenarios-v1` event contains only the fixed 1/1/1/40 row
counts, rollback status, and zero-residue status. The deployer requires exactly
one valid lifecycle event and one valid plan report. The lifecycle event and
the deployer's normal sanitized projection contain no tenant, staff, student,
device, SQL, parameter, raw query-ID, or raw-plan values. The unchanged full
report carries the signed query ID only in the access-controlled exact task-log
stream so the private receipt writer can bind it; it is never copied to normal
deploy output. Unexpected database errors are reduced to
`database_operation_failed`.

For the authorized production batch-tile remediation, invoke the deployer's
opt-in release gate:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-gate
```

After building and registering the new digest-pinned 512/2048 API revision,
the deployer runs exactly one Fargate task on that full revision ARN using the
live service VPC/security groups and inherited database secret/container
identity. It overrides only the command and disables startup migrations and
the scheduler. The command is fixed to
`node dist/cli/checkClasspilotTileAuthorizationPlans.js --execute`; the deploy
flag exposes no bypass, sample, cohort, or threshold option.

The task has a 900-second controller deadline and a bounded 120-second stop
observation. It must stop cleanly with one successful `api` container. The
deployer then reads the exact task's awslogs stream, accepts only the strict
aggregate schema documented above, prints only a canonical sanitized report
and its log group/stream, and never persists raw log messages. Failure occurs
before the autoscaling hold, migration task, or either service update.

The production gate cannot start during the actual 01:15-02:15
America/New_York purge/rollup window. A missing, ambiguous, inactive,
incomplete, cross-school, or conflicted owned base fixture is a failed gate,
not permission to inspect ordinary tenants, refresh fixtures, or reduce the
cohort. The checker reports whether existing plans pass; it never creates or
recommends an index by itself.
