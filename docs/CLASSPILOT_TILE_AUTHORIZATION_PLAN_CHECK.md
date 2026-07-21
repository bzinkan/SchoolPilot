# ClassPilot tile authorization plan check

The tile authorization release gate runs the exact SQL exported by
`buildClassPilotTileAuthorizationQuery` against representative 40-student
cohorts. It also runs the production cold-history fallback exported by
`buildHeartbeatTileHistoryBatchQuery` for the authorized `teacher.history`
cohort. It is read-only and changes neither schema nor data.

Build the release and run the gate with the same database environment used by
the API:

```powershell
npm run build
npm run check:classpilot-tile-auth-plans
```

The command first audits every `teaching_sessions` row while using the existing
RLS super context. It fails if `school_id` is null, the parent group is missing,
or the session and group schools differ. It then discovers one complete
representative cohort for each of these labels:

- `teacher.live` and `teacher.history`
- `co_teacher.live` and `co_teacher.history`
- `office_staff.live` and `office_staff.history`

Each measured query runs in a read-only transaction with `app.is_super=off`
and `app.school_id` bound to the selected tenant. The command performs two
unmeasured warmups and at least 20 measured
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

Output is a counts-only JSON record containing scenario labels, cohort/sample
counts, timings, row bounds, indexed-limit status, and plan violation counters.
Tenant, staff, student, device, SQL, parameter, and raw-plan values are never
emitted. Unexpected database errors are reduced to
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
America/New_York purge/rollup window. A missing representative cohort is a
failed gate, not permission to reduce the cohort. This checker reports whether
existing plans pass; it never creates or recommends an index by itself.
