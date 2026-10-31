# ClassPilot Manual for today

> Teacher all-day access is retired by the Today’s schedule successor. This document retains the administrator/legacy storage contract. See [Today’s schedule](CLASSPILOT_TODAY_SCHEDULE.md) for teacher period swaps, exact meeting identity and current rollout rules.
Manual for today lets staff choose particular automatically scheduled classes to
start themselves for the rest of the current school day. Recurring schedules,
saved times, rosters, teachers, applied profiles and approved swaps are retained.
The exception expires at midnight in the school's timezone. The usual schedule
applies on the next date, including its normal weekday and school-calendar rules.

## Staff workflow

The Dashboard class picker stays available while teaching. Selecting another
class only changes the selection. Use **Start Class** or **Switch Class** for a
normal start, or **Start manually today / Switch manually today** to override a
scheduled class. One review names the class, the owned session that will end,
the shared effect on co-teachers, the saved Flight Path and the school-local
expiry. Enabling the override and starting the class commit together; a failed
start leaves both the previous session and the schedule unchanged.

To prepare classes without starting them, open **Teaching tools → Manual for
today** (`/classpilot/my-settings/manual-today`) or use the existing entry in
Admin Classes. Choose a class,
review its name and school-local date, and select **Make manual for today**.
Repeat for any other classes needed. The action does not start a class. Select
the class and use **Teach Class** (or **Start Class** for teachers) when ready;
use **End Class** when finished. A manual session can be started again that day.
New Manual today sessions use the class's saved automatic Flight Path when
enabled and available. The decision freezes once per session; retries and
co-teacher joins reuse it, including an explicit off decision. Older running
manual sessions never acquire a preset retroactively. Reusing one for Manual
today keeps that session running with its existing settings and tightens its
deadline when needed; it does not restart the session or reset its Flight Path.

If that class has a running automatic session, enabling the exception ends it
through the normal lifecycle and preserves its Session Summary and history.
Already ended or skipped occurrences remain historical records and no longer
prevent an explicit manual start for that day. Other classes' schedules and
current control ownership remain subject to the existing start/overlap checks.
The override applies to the whole class, including co-teachers. Other classes
remain automatic and may take over at their scheduled times. Ending a manual
session or switching away leaves the override enabled through today. There is
no same-day reset; tomorrow's normal calendar determines its next automatic
meeting. Planned time swaps remain in Teaching tools → Advanced → Planned time
swaps, with their existing acceptance, approval and history workflow.

**Skip Today** remains cancellation of the scheduled occurrence. Turning off
**Automatic Scheduling** remains a recurring configuration change. Neither action
is a substitute for this dated exception.

## Administrator permission

Administrators and school administrators may enable the exception for their
school's classes. In ClassPilot Settings → School details → Teacher schedule
adjustments, the school administrator can enable **Allow teachers to use Manual
for today for their assigned classes** and select **Save teacher adjustments**.
This defaults off.
When enabled, current primary teachers and co-teachers can act only on their own
assigned classes. The server rechecks the policy and assignments when saving.
Disabling the permission prevents new teacher adjustments; existing exceptions
still expire normally. It does not grant teacher command access to other classes.

The policy uses the narrow, version-checked `scheduling` section of
`/api/classpilot/admin/settings`; it does not change the separate schedule-swap
policy or accept a mixed settings snapshot.

## Server contract and lifecycle

- `GET /api/classpilot/groups/manual-today` returns authoritative `schoolDate`,
  `timezone`, `resumesOn`, `resumesAt`, management permission and scoped classes.
- `POST /api/classpilot/groups/:id/manual-today` accepts only
  `{ expectedSchoolDate: "YYYY-MM-DD" }`. The school/date comes from the active
  authenticated school. The expected date fences stale confirmations; it cannot
  select a future or past override. Missing targets never mean all classes.
- The write shares school lifecycle, instructional-date and class locks with
  scheduling. It audits `class.manual_today_enabled`. Current scheduled sessions
  end through centralized finalization, including control cleanup and reporting.
- `POST /api/classpilot/teaching-sessions/start` (and its existing aliases)
  additionally accepts `manualToday: { expectedSchoolDate }` together with
  `expectedActiveSessionId` (an exact session ID or null). This combines the
  override and start in one transaction. Normal reviewed switches can also
  supply `expectedActiveSessionId`; stale reviews return
  `CLASS_START_REVIEW_STALE`. Existing normal start payloads remain supported.
  An unavailable automatic occurrence returns `MANUAL_TODAY_REQUIRED` with the
  current school date and management permission. Unacknowledged student overlaps
  return the existing `CLASS_ROSTER_ACTIVE_OVERLAP` response without committing.
- Class starts serialize and reuse an already-running manual class only for
  immutable session staff. Repeated starts return the same session instead of
  replacing it or resetting the frozen preset. Switching replaces only the
  initiating teacher's owned session; another teacher's shared class continues.
- A running unscheduled manual session can predate its class's automatic
  schedule. Reusing it for Manual today also enforces the dated deadline on the
  existing session row and its still-owned control state. An existing earlier
  deadline is preserved; reuse never extends the session's lifetime or restarts
  its clock. The session ID, original start, classroom settings, restriction
  values and frozen Flight Path decision (including off or no initialized
  preset) remain intact. Deadline repair does not acquire students or controls
  held by another session. Retries and co-teacher joins are idempotent: they
  converge on the same bounded session without retroactive preset initialization.
- A skipped scheduled marker preserves the exception for report backfill even
  after a later manual date replaces the group field. Such a marker is not a
  taught class: it grants no control, roster authority or report delivery.
- All scheduler, conflict, dashboard and promotion paths honor the dated
  exception. Approved swap partners retain their own effective windows.
- Manual teaching sessions have a `manual_expires_at` deadline at the next local
  midnight, bounded by the ordinary 12-hour session cap. Control state, classroom
  tools, observations and history stop at that deadline even before worker
  cleanup. The worker finalizes expired sessions through the normal lifecycle.
- The client uses server dates and `resumesAt` to refresh after midnight. A
  confirmation that crosses the date boundary is rejected and must be reviewed
  again. Browser timezone and local storage cannot extend the override.

## Release and rollback

The additive `classpilot-manual-today-20261030` migration adds columns on existing
tenant tables and an expiry index/checks. It adds no tenant table and needs no new
RLS allowlist admission. Run the ledger-backed migration and deploy the compatible
API and scheduler worker before publishing the frontend. No extension release or
runtime-capability activation is required.

After exceptions or deadline-bound manual sessions exist, retain compatible API
and worker versions. Before a downgrade to software unaware of this contract,
allow all exceptions to expire, end every open deadline-bound manual session
through normal finalization, and verify the resulting state. Preserve scheduled
markers, reports and audits; do not delete history to make rollback possible.

Implementation and local verification do not deploy production.
