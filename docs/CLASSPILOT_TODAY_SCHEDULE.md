# ClassPilot — Today’s schedule

Teacher period changes live in **Teaching tools → Today’s schedule**
(`/classpilot/my-settings/today`). The dashboard retains ordinary Start/Join,
Switch and End; it has no period-swap manager or manual-start shortcut. The old
teaching-tools Manual today route redirects to Today’s schedule.

## Teacher contract

Choose two remaining meetings for the same primary teacher, review both teachers’
four saved classes, then Apply today. The other teacher must already teach both
cohorts in the opposite period order. Eligibility uses exact nonempty saved
student rosters and resolved dated windows, never grade/name matching. Different
period lengths are supported. A unique valid reciprocal match is prefilled;
multiple eligible teachers require selection, and duplicate/missing class entries
require administrator repair. Class/roster assignments remain unchanged.

Before the bell, only the dated plan changes. After the bell, outgoing meetings
end at the atomic commit timestamp, incoming meetings use the remaining period,
and displaced classes meet during the chosen later period. Elapsed history stays
intact. Unrelated periods remain automatic, and tomorrow resolves the ordinary
calendar. Skip this period is an explicitly reviewed meeting cancellation.

One initiator can change both timetables without another login when the counterpart
has no affected current live class. A report-only occurrence is not live. An
unexpired live class remains live during a dashboard disconnect and requires its
authorized counterpart’s acceptance. Pending proposals change neither sessions nor
the effective plan. Decline, cancellation and expiration leave scheduling intact.
Accept rechecks the exact sessions, date, permission, assignments, rosters, plan
revision and clock. Stale proposals need a new review; they never become automatic
permission to take a different live class.

The administrator setting is labelled **Allow teacher period swaps** and retains
`settings.allowTeacherManualToday` with its existing values/default false. New
teacher all-day Manual today writes are retired independently of the activation
flag. Ordinary authorized joins of already-running recovery sessions remain.
Revocation blocks new applications and acceptance; committed plans continue.

## Server and storage

- `GET /api/classpilot/today-schedule` returns the actor’s assigned classes,
  remaining meetings, short-lived opaque meeting references and visible changes.
- `POST /api/classpilot/today-schedule/preview` accepts `action: swap|skip`,
  `expectedSchoolDate`, `currentGroupId`, optional `selectedGroupId`, exact
  `currentMeetingRef`/`selectedMeetingRef`, and optional validated
  `counterpartTeacherId`. It returns before/after rows, blockers and a signed
  review token. Ambiguous group-only requests fail closed.
- `POST /api/classpilot/today-schedule/changes` accepts `reviewToken` and
  `idempotencyKey`, producing an applied receipt or pending request.
- `GET /api/classpilot/today-schedule/changes/:id` supplies the current receipt
  and a fresh acceptance preview when authorized.
- `POST /api/classpilot/today-schedule/changes/:id/actions` accepts
  `accept|decline|cancel`, `expectedRevision`, and the acceptance review token.
- Ordinary Start returns `TODAY_SCHEDULE_CHANGE_REQUIRED` and a Teaching tools
  URL when an automatic class needs a timing change. Selection alone never starts.

`classpilot_today_changes` stores proposal/review/receipt identity and
`classpilot_today_occurrences` stores immutable per-class/date generations. Only
applied generations affect execution. The latest generation for each class/date
contains its remaining meetings and explicit suppressions; other classes retain
their own generations. Copies of unchanged meetings retain their original
occurrence/session identity through server-owned provenance.

`teaching_sessions.scheduled_occurrence_id` gives new meetings exact identity.
Legacy rows retain their original one-class/date uniqueness; new rows are unique
per school/occurrence. Scheduled coverage conflicts carry the same identity, so
two corrections within one clock minute cannot reuse a previous coverage request.
Same-school parent and immutable-window guards enforce both relationships.

The canonical day resolution is calendar/bell rules and applied profiles, approved
legacy planned swaps, then the committed Today generation. Legacy Manual/Skip/end
records remain historical. A review can authorize exact replacement meetings;
it never clears old tombstones or reopens a finalized session. New meetings keep
truthful scheduled metadata. Each new live meeting freezes its own Flight Path
once; carried meetings retain teacher changes and explicit off decisions.

Apply runs under shared school lifecycle/date/config/group and student-control
locks. Finalization, all four dated changes, live promotion and summary outbox
writes roll back together. Transport updates are deferred until outer commit.
The initiator gains no counterpart classroom/private-data authority. Existing
Supervision and testing ownership remain admission constraints.

Administrator Manual today recovery remains separate. Its status includes
`todayRevision`, `hasTodayPlan`, and `activeScheduledSessionIds`. A recovery over
an existing generation requires `expectedTodayRevision` in the enable request.
Each deliberate recovery adds a new suppression generation and advances timetable
and boundary revisions, including when the legacy manual-date marker is unchanged.
The composite administrator Start’s `manualToday` object also accepts this fence.

Future Planned time swaps retain their existing approvals/history/links. New
same-day legacy requests use Today’s schedule. Existing pending workflows can be
superseded as complete requests; an approved legacy swap can only be replaced as
a complete reviewed unit. Calendar/profile/planned-swap writers validate the
effective day plan instead of silently overwriting it.

## Release and containment

`CLASSPILOT_TODAY_SCHEDULE_MODE=off|on` defaults off and gates creation and acceptance
of uncommitted changes. Reads, decline/cancel, cleanup and committed execution remain.
Activation additionally requires `RLS_GUC_ENABLED=true` and both new tables in
the runtime admission inventory. Committed plans, session cleanup and pending
expiration remain effective with the write gate off.

1. Use a clean reviewed main commit and the checksum-ledger migration task.
   Admit exactly the registered `classpilotTodaySchedule` two-table bundle with
   the documented `deploy.sh production --backend --enable-rls-table` path.
   Preserve existing runtime/capability flags, task sizes and observed RLS inventory.
2. Keep new requests off while compatible API and worker tasks converge. Verify
   the migration, both actual FORCE RLS policies, same-school/identity guards,
   serving image/commit and strict service stability.
3. Expansion retains the original full scheduled-conflict unique index so old
   rolling tasks' `ON CONFLICT` statements still work. After every API/worker task
   serves the reviewed image with writes off, run that exact image's
   `node dist/cli/contractClasspilotTodaySchedule.js --execute --expected-source-sha <main-sha>`
   as a migration-only one-off in the documented production database network.
   The guarded CLI verifies the exact expansion ledger/policies/indexes, records
   a separate immutable contraction migration, and drops only the old full index.
   New writes reject missing contraction evidence. Retain its private task/log
   receipt. Later deploys retain the completed contraction and never recreate the
   old full index.
4. Publish matching web assets and verify CloudFront invalidation/public hashes.
5. Plan/apply the mode `on` through `deploy-product-runtime-config.ps1`, preserving
   every other live value. Retain the private plan/hash/receipt and verify both
   serving services afterward. Do not hand-edit ECS environment definitions.
6. Verify public health and schedule/read-only capability smoke checks; use only
   synthetic fixtures for mutating production smoke tests.

Containment turns new requests off through the same guarded tool. Once new
generations exist, API and worker rollback must retain occurrence-aware readers,
expiration, control ownership and all earlier rollback floors. Never restore an
older worker that can interpret a finalized class/date as the complete revised day.
Conflict-index contraction itself establishes the new-writer rollback floor even
before the first swap: older explicit `ON CONFLICT` writers are incompatible with
the contracted indexes. Keep the compatible API/worker during frontend rollback.
No extension or native client release accompanies this SchoolPilot change.
