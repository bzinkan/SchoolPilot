# PassPilot kiosk scheduling

Teachers opt in at **PassPilot → Settings → Kiosk schedule**, also linked from
My Class. Administrators can choose a teacher; office staff cannot edit schedules.
Existing teachers default to Manual. Preferences belong to the teacher and school,
so newly claimed and remembered/resumed kiosks inherit them independently of the
teacher's selected class tab.

## Assignment contract

- Follow PassPilot schedule uses assigned standalone classes, weekly blocks,
  optional effective dates, and dated replacements (including empty days off).
  Administrator closures always win. Times use the school timezone. Overlapping
  and overnight blocks are rejected; adjacent and repeated meetings are supported.
- Follow ClassPilot requires an existing `classpilot_groups` configuration and
  active ClassPilot entitlement. It never migrates classes or creates mappings.
  Ordinary classes use the scheduling helpers, calendar, approved swaps, applied
  profiles, frozen occurrences/rosters and skips. An open dashboard, teaching
  session or connected Chromebook is unnecessary.
- Active assigned testing and scheduled coverage take precedence. Rosters use
  unreleased supervision assignments, including offline students. Pending or
  failed testing blocks block checkout; ambiguous assignments require staff
  selection. Ad hoc claims and saved testing-group membership do not activate a
  testing assignment. Reads do not activate sessions or send device commands.
- Send to Kiosk creates an individual/bulk temporary override. Its deadline is
  the next effective schedule transition or school-local midnight. Later schedule
  edits can shorten it. Resume automatic clears the override immediately; only
  an explicit setting change selects Manual permanently.
- Polling resolves today plus a bounded seven-day preview, never the Dashboard's
  multi-day projection. A null next assignment means none in that preview.
  Five-second polling plus boundary/focus/reconnect refreshes keep the display
  current. Effective assignment, roster, ownership and supervision revisions
  invalidate the displayed revision and unfinished student forms.

Session-bound clients send both the existing class-model header and
`X-PassPilot-Kiosk-Activity: scheduled-activities-v1`. Snapshots and student lists
can omit a class ID. They return activity identity/kind/name, roster, return-only
students, server time, boundary and assignment revision. Checkouts echo
`assignmentRevision`. The server resolves it again under the school lifecycle,
PassPilot configuration, calendar and student authority locks. A conflict requires
a fresh student selection; the browser never retries against a new assignment.
Older clients retain manual behavior and receive HTTP 426 for automatic mode.

Kiosk-issued outstanding passes can be returned at any active kiosk owned by the
issuing teacher in the same school. Reassigning the kiosk revokes the previous
teacher's return access. Device continuity IDs never establish this authority.
Schedule failures and ClassPilot entitlement loss stop new checkouts while
preserving eligible returns. PassPilot/kiosk authorization is still required.

Testing/coverage passes retain their supervision context, immutable activity name,
activity kind and issuing kiosk origin. They have no fabricated class ID. History,
exports and timeline events preserve that attribution; regular-teacher roster
membership does not grant access to another teacher's activity passes.

## Release procedure (requires a separate deployment request)

This implementation does not deploy or alter production. For a later release:

1. Use the documented backend deploy process in `CLAUDE.md`, admitting the new
   singleton with `--enable-rls-table passpilot_teacher_kiosk_settings` only on
   its first rollout. Preserve every other live RLS setting. The checksum-ledger
   expand migration is `passpilot-kiosk-schedule-20260924`.
2. Before the frontend, verify the migration completed and the deployment's
   catalog gate confirms enabled/forced RLS plus the tenant policy. Confirm the
   API and worker share the new allowlist entry. Retain the historical Terraform
   baseline until a separate observation/adoption change.
3. Verify the additive schema and constraints using a privileged migration
   connection. These queries contain no student data:

   ```sql
   SELECT id, status, checksum FROM schema_migrations
   WHERE id = 'passpilot-kiosk-schedule-20260924';
   SELECT relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE oid = 'passpilot_teacher_kiosk_settings'::regclass;
   SELECT policyname, qual, with_check FROM pg_policies
   WHERE tablename = 'passpilot_teacher_kiosk_settings';
   SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'passes'
     AND column_name IN ('supervision_context_id','activity_kind',
                         'activity_name_snapshot','issuing_kiosk_session_id');
   SELECT conname, convalidated FROM pg_constraint
   WHERE conrelid = 'passes'::regclass AND conname = 'passes_activity_shape_check';
   ```

4. Publish the compatible frontend only after the backend is healthy. Verify a
   Manual kiosk, then opt in fixture teachers for each supported source. Exercise
   a transition, temporary override/resume, testing partial release, stale
   checkout conflict, and return after transition before wider opt-in.
5. Monitor `passpilot_kiosk_hot_path_summary`: `assignmentFailures`,
   `staleCheckoutConflicts`, `returnFailures`, and `snapshotMs`. These are fixed,
   process-wide aggregates without student, school or kiosk identifiers.

For containment, `PASSPILOT_AUTOMATIC_KIOSK_ENABLED=false` disables automatic
resolution and new automatic checkout. Teachers can explicitly choose Manual;
eligible outstanding returns remain available. Preserve the additive schema and
activity-aware pass/return handlers during rollback; never downgrade to code that
cannot represent issued activity passes. No Chrome extension or Store release is
needed.

## Verification

`tests/passpilot-kiosk-schedule.test.ts` covers date/time rules, DST, closures,
overlaps, priority, gaps and effective boundaries. The serial integration suite
uses local PostgreSQL fixtures and the real Express router for assignment,
entitlement, concurrency, return continuity, reporting access, parent checks and
non-owner RLS denial. It also measures concurrent snapshots and verifies reads
create no ClassPilot sessions or supervision state.

Run `npm run test:passpilot-kiosk-schedule` in `schoolpilot-app` for both kiosk
interfaces and the schedule editor. This test is also in the frontend release
suite. Backend type/build, test type/cast ratchets, registry checks, existing kiosk
regressions, frontend lint/build and the repository CI lanes remain required.
