# Automatic Class, testing and next-class transitions

Scheduled classroom and supervision-preview modes default on; their separate
kill switches and school exclusions remain authoritative. These workflows do not
change saved class rosters, applied snapshots, report
boundaries or Central Email Copy.

## Teacher behavior

When enabled, Class displays the teacher's server-confirmed regular class,
scheduled testing or scheduled-class coverage. Tiles include assigned students who
are offline. When no temporary room is active, each new scheduled assignment
returns an open Dashboard to Class. Staff can browse My room or Available;
administrators can also use Observe. Claim is available to both roles within
their authorized supervision scope. A refresh,
partial release or extension of the same assignment does not repeatedly reset that
choice. Unrelated pages and unfinished scheduling forms are not redirected.

My room retains the legacy `claimed` navigation value. Available → Claim reviews
the exact selection and creates or adds to the staff member's one active
`temporary_room` context, independent of grade or scheduled homeroom. The first
claim chooses an end time; additions preserve it. The room remains selected across
bells and reloads unless staff intentionally choose Class or Observe. Its students
remain under room authority until expiry, removal, or explicit holder handoff.
Changing the end time reviews all current members. Browsing never transfers them.

Legacy claim requests retain their previous behavior. A saved testing group's membership can authorize a teacher to claim
that student, but it does not start testing or select that group as the student's
current activity. The saved membership remains available for future testing.
Ordinary claims never replace the teacher's current Class assignment. They retain
their own recipients, control authority, observation leases and release lifecycle.
Claim revalidates student availability, the exact staff grants and current group
membership under the assignment locks; competing claims cannot steal an accepted
assignment. Combine my supervision reviews personally held students across existing
contexts before moving them into the room; saved rosters and historical intervals
remain unchanged. Another supervisor's students require their explicit reviewed
Send. Room membership cannot be taken through legacy Return to class or Reroute.

The server supplies an activity `purpose`: `class`, `testing`, `coverage`,
`supervision`, or `claim`. Testing requires an active scheduled testing context or
an explicitly created `state_testing` context. Those contexts expose **End testing**;
ordinary supervision exposes release controls. Neither a group's name nor the
presence of a supervision context ID establishes testing. Existing unscheduled
group contexts receive the neutral claim display name only when every active
assignment proves an ordinary claim (`staff_claim` or `admin_assign`). Mixed or
unknown origins retain their original supervision name; historical records are
not rewritten. Explicit sends and manual testing keep their distinct purposes.

My room shows automatic screen previews for both teachers and administrators,
including an enlarged preview on click. A room uses its exact observation lease
and authority revision. Legacy claims retain a separate lease per group from the
personal claimed roster; navigation
summary metadata and an unrelated active class cannot authorize these reads.
Capture notifications refresh only the affected claimed students. Releasing a
student or losing a group's preview authority removes those images while other
authorized groups keep their previews. This Dashboard repair uses the existing
extension capture protocol and does not require a new extension release.

Testing ends through the existing supervision lifecycle. Students follow the
authoritative applied schedule and each teacher sees their own next assignment.
End testing is a confirmed early release, not End Class on a hidden regular session.
If the next assigned teacher is absent, a reporting-only occurrence remains visibly
awaiting supervision; it is not evidence of live classroom control. If no personal
class follows, the Dashboard shows an idle state rather than an old Homeroom.

Administrators and IT staff with a school administrator role can Observe a current
scheduled class even when its teacher is signed out or has not opened ClassPilot.
The server authorizes its frozen roster for read-only subscriptions and updating
screen previews without promoting the reporting occurrence to live supervision.
Observe explains when the teacher has not started live supervision; that status
does not pause the administrator's previews. Normal school monitoring hours,
student sign-in, roster and privacy requirements still apply. Future, ended and
unauthorized occurrences are not available through Observe.
Released extensions 2.9.2 and 2.9.3 can supply these teacher-absent previews at
their existing background capture interval of approximately 30 seconds. The
five-second active cadence for a reporting occurrence requires a separately
released extension that negotiates `screenshotReadOnlyObservationV1`; the new
capability defaults off until that release is enabled. Existing live-class and
supervision preview cadence is unchanged.
While a class is selected, its metadata refreshes every ten seconds, including with
a connected WebSocket. If the teacher later begins live supervision, Observe keeps
the same class selection and remains read-only. Observing never acquires control.
If the selected class leaves the active list, Observe remains on that unavailable
selection until the administrator selects another class or chooses Stop observing.

## Compatibility and authority

`GET /api/classpilot/dashboard-activity` returns the scoped current activity and an
optional `room` activity using the same exact supervision authority contract,
capabilities, revision, server time, next assignment and next boundary. Activity
authority is exactly one real `teachingSessionId` or `supervisionContextId`.
The latter receives full tools for an assigned active supervision context,
current entitlement and the enabled rollout. Ordinary claims remain in `activities`
but are excluded from `current`; each supervision activity includes its authoritative
`purpose` and `contextType`. New claims never reuse future or scheduled contexts,
and explicit group sends cannot extend a scheduled testing window. No
synthetic teaching session is created for testing. Observe remains read-only.

The extension negotiates `scheduledClassroomV1`, dependent on
`scopedAuthorityChecksV1`. Testing tools include messages/replies, raised
hands, polls, timers, settings, preview capture and ordinary authorized
class commands. Live View remains backend-only in this release: its authority and
extension protocol support are retained, but the Dashboard does not expose start,
expand or stop controls, including when the scheduled-classroom rollout is enabled.
Automatic screen previews, Tabs and Details remain available. Unsupported clients
show an update requirement. Neither version
text nor a Dashboard tab establishes authority. Media, overlays and delayed
commands remain bound to the exact student/session and activity; old class images
are never used as a fallback after a handoff.

Scheduled contexts carry a separate authority revision for the supervising staff
tenure. Reassignment advances it; changing a restriction or extending the same
testing window does not. Applied timers and polls therefore survive ordinary
updates without carrying over to a different supervisor.

## Boundary worker

The additive `classpilot-schedule-boundaries-20260915` migration adds a due time,
generation and short lease to the existing school scheduling row. An indexed
one-second worker claims bounded due schools, runs expiry/testing/class execution,
then computes the next school-local boundary. Existing transactional lifecycle
locks and idempotency remain in force. Schedule mutations wake the row in the
same transaction; a newer generation wins over a stale worker completion.

The minute-paced discovery, backfill and report jobs remain recovery paths.
Historical roster work and email materialization do not run in the fast lane.
The healthy target is within five seconds for connected, awake clients. Sleep,
disconnects, unavailable dependencies and processing limits are explicit recovery
conditions. Pending authority is never presented as a successful transition.

## Rollout and rollback

1. Run the normal backend migration and catalog checks. The separate
   `classpilot-scheduled-classroom-20260915` expansion adds exclusive activity
   parents to settings, chat, deliveries, hands, polls and classroom state.
   Preserve the existing tenant policies and all retained rows.
2. Deploy the compatible backend/worker before the dependent Dashboard. Temporary
   rooms reuse existing supervision tables and extension capability contracts;
   they require no extension release or new database tables.
3. SchoolPilot deployment does not publish the extension. Any future extension
   successor follows the separate live-version verification and Store procedure.
4. `CLASSPILOT_SCHEDULED_CLASSROOM_MODE` and
   `CLASSPILOT_SUPERVISION_PREVIEW_MODE` default on. Their `off` kill switches and
   corresponding `*_EXCLUDED_SCHOOL_IDS` carve-outs remain supported; malformed
   exclusions fail closed. Retired `*_SCHOOL_IDS` allowlists fail startup. Keep
   existing protocol-v3 and scoped-authority capability gates enabled. The separate
   schedule-boundary worker still defaults off; do not infer five-second lifecycle
   processing from the classroom mode alone.
5. Rehearse Homeroom → 9:11–9:15 testing → actual next class with a connected
   assigned teacher and compatible Chromebook. Verify rendered tiles and a real
   classroom action in addition to backend lifecycle receipts. Check separate
   supervisor activity summaries and the central copy boundary.

Disable the rollout flag to stop expanded display/tool authority while retaining
compatible code and the additive schema. Continue normal supervision expiry and
reporting. Once context-parented classroom records exist, do not roll back to
software that assumes every record has a teaching session. Roll forward or retain
the compatible gated version; deleting activity records is not a rollback step.

Once temporary rooms have been created, a frontend rollback must retain the
room-compatible API and worker. Pre-room revisions lack the holder-only source,
reviewed destination/deadline and exact whole-room release checks, and classify
rooms as ordinary current supervision. Before any pre-room backend downgrade,
end or expire every active `temporary_room` through normal lifecycle finalization
and verify that no active room contexts remain. Keep supervision history and
respect the other data compatibility floors. Disabling display/tool rollout
flags does not drain rooms or make that downgrade safe.

Implementation does not authorize deployment, flag activation or Store upload.
