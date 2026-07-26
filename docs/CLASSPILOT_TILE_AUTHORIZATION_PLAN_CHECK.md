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
office-staff membership, a 40-student class roster without active supervision
conflicts, a distinct 40-student office cohort without active supervision
conflicts, and the canonical historical mapping from each
`<fixtureId>-P-####` student to its same-school
`<fixtureId>-primary-####` device. All 80 devices must be distinct. Ordinary
tenant data is ineligible. Active `student_sessions` do not participate in
base or cohort selection; they are classified only after the deterministic 80
pairs have been selected.

An eligible class must have exactly one canonical `group_teachers`
relationship: its `teacher_id` must equal the group's primary teacher and its
role must be `primary`. Any missing, mismatched, malformed, or additional
relationship row makes that class ineligible. The production load fixture has
one real co-teacher on class 1, so classes 2-20 are the expected 19
primary-only candidates. Observation mode seals that count in a
`classpilot-tile-auth-plan-base-selection-v1` companion without changing the
passing preflight-v1 schema.

For the 80 canonical pairs, the gate reuses an active session only when it
matches the exact student and device. It inserts an explicit-ID active session
when neither side has an active counterpart and fails if either side is bound
elsewhere. It never updates or deactivates an existing session.

Using explicit random IDs and parameters, the gate therefore inserts 43-123
transaction-local rows: zero to 80 missing student sessions, one co-teacher
relationship, one correctly school-scoped open live teaching session, one
active office-supervision context, and 40 office-supervision assignments. It
does not consume sequences, update existing rows, insert heartbeats, or call an
application API. Discovery is constrained to these selected and seeded objects
and produces one complete representative cohort for each label:

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
read-only transaction on a distinct pool connection then proves that every
generated ID is absent; the write connection is never eligible to perform its
own residue check. If rollback cannot be proved, that write connection is
released to the pool with an error so it is destroyed, even when the separate
residue observation is zero. Only after rollback and zero residue succeed may
the CLI emit a passing report. Connection loss, timeout, query drift, rollback
failure, residue, or a concurrent gate conflict fails closed.

The existing counts-only plan report remains unchanged. A separate
`transactional-plan-scenarios-v2` event contains the fixed 1/1/1/40 counts,
80 required session pairs, exact-pair reuse and inserted-session counts,
rollback status, and zero-residue status. Reused plus inserted must equal 80,
and the total inserted rows must equal 43 plus the inserted-session count.
Version 1 evidence is ineligible. The deployer requires exactly one valid
lifecycle event and one valid plan report. The lifecycle event and the
deployer's normal sanitized projection contain no tenant, staff, student,
device, SQL, parameter, raw query-ID, or raw-plan values. The unchanged full
report carries the signed query ID only in the access-controlled exact task-log
stream so the private receipt writer can bind it; it is never copied to normal
deploy output. Unexpected database errors are reduced to
`database_operation_failed`.

The read-only fail-fast form uses the same stable base evaluator:

```bash
node dist/cli/checkClasspilotTileAuthorizationPlans.js --preflight-base
```

It runs in a rollback-only `REPEATABLE READ READ ONLY` transaction and emits
one aggregate `classpilot-tile-auth-plan-base-preflight-v1` event proving one
eligible base, 80 required pairs, the reused/missing split, and zero conflicts.

When base selection fails, the same snapshot-consistent statement emits one
sanitized `classpilot-tile-auth-plan-base-funnel-v1` object. It identifies
`base_funnel`, `base_shape`, or `session_posture` as the failure stage and
reports only bounded synthetic-fixture aggregate counts plus the independently
derived first empty stage. It contains no school, fixture, staff, student,
device, SQL, parameter, query-ID, or raw-error value. The passing preflight
schema above remains unchanged; funnel evidence is failure evidence and can
never satisfy the release gate.

An explicitly authorized investigation may run the non-consuming observation
form:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-observation
```

Observation mode performs the normal source, workflow, timing, AWS-identity,
topology, and production-posture checks, then builds, pushes, and registers an
inactive candidate and runs only the read-only base preflight. It performs no
migration, scaling hold, service update, frontend publication, fixture
mutation, monitoring lease, or workload traffic. It creates neither a
rehearsal admission nor a rehearsal receipt and therefore does not consume the
one-attempt rehearsal boundary.

Before `run-task`, observation mode atomically writes and independently
inspects one ACL-private
`classpilot-tile-auth-plan-observation-attempt-v1` record. It binds the
observation ID, SHA, digest, inactive API/worker definitions, active baseline,
and initial network/posture hashes and cannot be overwritten. Its sibling
terminal directory then publishes one
`classpilot-tile-auth-plan-observation-v2` packet plus any companion files by
one atomic rename. Exit zero binds one canonical preflight-v1 companion, one
canonical selection-v1 companion, and outcome `base_eligible`; the expected
base-ineligibility exit `1` binds one canonical funnel-v1 companion and
outcome `base_ineligible`. Other terminal task exits seal `task_failed`;
unavailable task, log, network, or posture evidence seals
`evidence_unavailable`. A launched task whose exit cannot be recovered retains
its exact ARN with tagged state `exit_unavailable`.

The packet binds the attempt hash, terminal task state and exit when known,
sanitized collection status and attempt count, canonical whole-event hash,
final network/posture envelopes, and UTC completion time. Verified final hashes
must equal the immutable initial hashes. Every packet sets
`eligibleForDeployment`, `eligibleForDiagnostic`, and
`eligibleForCertification` to `false`; rehearsal inspection/consumption,
deployment, diagnostic, and certification admission reject it. Version 1
observation packets are historical/inspect-only and no writer may create one.

For an authorized production release, first invoke the candidate-only
rehearsal:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-gate \
  --classpilot-tile-auth-plan-rehearsal
```

Before any candidate build, push, registration, or candidate base preflight,
the deployer
atomically and exclusively writes the fixed admission marker at
`$LOCALAPPDATA/SchoolPilot/load-gates/tile-auth-rehearsals/<SHA>/classpilot-tile-auth-plan-rehearsal-attempt.private.json`.
The marker is durable and permits exactly one rehearsal admission for that
SHA. Once admitted, an EXIT/failure trap must seal exactly one immutable
`classpilot-tile-auth-plan-rehearsal-terminal.private.json` marker with
`status: passed` or `status: failed`; neither marker may be deleted, reset, or
overwritten. A passed terminal binds the exact receipt SHA-256. A failed
terminal, or an admitted attempt without a coherent passed terminal,
permanently disqualifies the SHA.

After building and registering the new digest-pinned 512/2048 API revision,
the deployer runs the read-only preflight and complete gate using the live
service VPC/security groups and inherited database secret/container identity.
It performs no migration, scaling hold, serving-service update, frontend
publication, fixture mutation, lease, or traffic. Its build, image push, and
inactive task-definition registrations are the only candidate control-plane
writes; the plan task's bounded data writes remain transaction-local and are
rolled back before acceptance. A pass seals an ACL-private, single-use, 60-minute
`classpilot-tile-auth-plan-rehearsal-v1` receipt. Receipt `inspect` and
`consume` require the immutable passed terminal and its matching receipt hash.
Admission, terminal, receipt, inspection, consumption, and the canonical
consumption marker bind a protected execution-authority SHA-256. Production
Windows derives it from the stable machine identity and current user SID and
never persists or logs either raw value. Missing authority data or a mismatch
fails closed, so a complete copied evidence tree is not consumable by another
host or user.
Consumption is an atomic marker in the canonical per-SHA attempt root, not
beside the caller-supplied receipt. Consequently, copying a byte-identical
receipt and companion set anywhere else under the load-gates root cannot
create another consumable capability, and concurrent consumers can produce
only one winner.
The validity interval is half-open: the exact expiry instant is rejected, so
`now >= expiresAtUtc` is expired. Consumption captures its actual UTC time and
rechecks that condition immediately before atomic marker creation; inspection
before expiry cannot authorize consumption at or after expiry. Deploy only
that exact candidate with the receipt path and its out-of-band SHA-256:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --classpilot-tile-auth-plan-gate \
  --reuse-classpilot-tile-auth-plan-rehearsal <absolute-private-receipt-path> \
  --expected-classpilot-tile-auth-plan-rehearsal-sha256 <64-hex>
```

The guarded deployment verifies the bound SHA, digest, task definitions,
baseline, network, evidence hashes, and receipt freshness before consuming it.
It reruns the complete gate before migration and after strict convergence.

The task has a 900-second controller deadline and a bounded 120-second stop
observation. The deployer resolves the exact task's awslogs stream before
interpreting the exit code, including when ECS omits `logStreamName`. A passing
task requires exit zero and the strict aggregate schemas above. A nonzero task
still has its exact stream read so the allowlisted sanitized gate failure is
reported instead of a derivative log-binding error. Raw log messages are never
persisted.

The failed candidate at SHA
`3c82f540cccfaf0badd70312e76e69770b6cfaed`, image digest
`sha256:776bd7e55a64c9da26d5eb1f38887f0402b0f1d143d3a1ca20a47246d459c1d6`,
and inactive task definitions `schoolpilot-production-api:133` and
`schoolpilot-production-api-emergency:33` is historical-only. It has no
eligible query receipt and must never be rehearsed, deployed, or used as
provenance.

The later failed preflight candidate at SHA
`f3265563ac2efb673a2974a1adafefe32dcedb42`, image digest
`sha256:56e973299479638e02f496b0641a21945440367cbe0a3d782c3fc75e6442673a`,
and inactive task definitions `schoolpilot-production-api-emergency:34` and
`schoolpilot-production-scheduler-worker:49` is historical-only. Its
`representative_scenario_missing` result produced no rehearsal receipt,
migration, service activation, frontend publication, fixture mutation,
monitoring lease, traffic, diagnostic provenance, or certification
provenance. Never reuse or promote those identities.

The later observation candidate at SHA
`abf820cc02b69599857739afe42f86baacd2351d`, image digest
`sha256:cbd7a7d2e07d41120ace5cda19c990de26dac0f9a140bcad5b7c0c298f6531a5`,
and inactive `api:135`, `api-emergency:35`, and `worker:50` definitions is
historical-only. Its terminal funnel isolated the old any-relationship
predicate at `noCoTeacherGroups`; the run produced no observation packet and
made no serving or fixture change.

The production gate cannot start during the actual 01:15-02:15
America/New_York purge/rollup window. A missing, ambiguous, inactive,
incomplete, cross-school, or conflicted owned base fixture is a failed gate,
not permission to inspect ordinary tenants, refresh fixtures, or reduce the
cohort. The checker reports whether existing plans pass; it never creates or
recommends an index by itself.

New observation writes use
`classpilot-tile-auth-plan-observation-v2`. The terminal finalizer runs even
after task, collection, network, or posture failure; it seals one of
`base_eligible`, `base_ineligible`, `task_failed`, or
`evidence_unavailable`, publishes the packet and optional companions
atomically, and independently inspects them. Every outcome is ineligible for
deployment, diagnostics, and certification. Evidence rereads may retry only
the exact terminal stream and never rerun the ECS task.

The current authorization permits one new observation. Only a sealed
`base_eligible` packet with selection values `40/19/19/1/1` may proceed to one
gate-only rehearsal and immediate single-use guarded deployment. Any other
observation stops without retry or report-only fallback. Fixture refresh,
Database Insights lease, diagnostic validation or traffic, and certification
remain separately authorized.
