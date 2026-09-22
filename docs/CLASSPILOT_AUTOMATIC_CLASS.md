# Automatic Class, testing and next-class transitions

This coordinated SchoolPilot and ClassPilot extension change is shipped disabled.
It does not deploy itself or change saved class rosters, applied snapshots, report
boundaries or Central Email Copy.

## Teacher behavior

When enabled, Class displays the teacher's server-confirmed regular class,
scheduled testing or scheduled-class coverage. Tiles include assigned students who
are offline. Each new scheduled assignment returns an open Dashboard to Class;
teachers and administrators can browse Claimed or Available between boundaries;
administrators can also use Observe. Claim is available to both roles within
their authorized supervision scope. A refresh,
partial release or extension of the same assignment does not repeatedly reset that
choice. Unrelated pages and unfinished scheduling forms are not redirected.

Claimed contains ad hoc pickups, manual Other sessions and manually started groups.
An explicit ad hoc claim opens that view, but the next scheduled assignment returns
the Dashboard to Class. Browsing does not itself release or transfer students.

Testing ends through the existing supervision lifecycle. Students follow the
authoritative applied schedule and each teacher sees their own next assignment.
End testing is a confirmed early release, not End Class on a hidden regular session.
If the next assigned teacher is absent, a reporting-only occurrence remains visibly
awaiting supervision; it is not evidence of live classroom control. If no personal
class follows, the Dashboard shows an idle state rather than an old Homeroom.

Administrator Observe labels reporting-only occurrences **Awaiting teacher**.
They do not request live subscriptions or screen previews. While a class is selected,
its metadata refreshes every ten seconds, including with a connected WebSocket.
When the teacher begins live supervision, Observe subscribes and resumes screen
previews automatically even when the occurrence keeps the same session ID.
An ended or unauthorized class still fails closed; observing never acquires control.
If the selected class leaves the active list, Observe remains on that unavailable
selection until the administrator selects another class or chooses Stop observing.

## Compatibility and authority

`GET /api/classpilot/dashboard-activity` returns the scoped current activity,
capabilities, revision, server time, next assignment and next boundary. Activity
authority is exactly one real `teachingSessionId` or `supervisionContextId`.
The latter receives full tools only for server-proven scheduled testing/coverage,
the assigned staff member, current entitlement and the enabled rollout. No
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
2. Deploy the compatible backend/worker before the dependent Dashboard and
   extension. Keep `CLASSPILOT_SCHEDULED_CLASSROOM_MODE=off` until reviewed.
3. Verify the live Chrome Web Store version before selecting a successor version,
   then follow the separate ClassPilot packaging/review/adoption procedure.
   SchoolPilot deployment does not publish the extension.
4. For an authorized canary, set `CLASSPILOT_SCHEDULED_CLASSROOM_MODE=on` and
   `CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS` to the intended school IDs on both
   API and worker. Missing mode defaults off; a malformed allowlist fails closed.
   An omitted/empty allowlist with mode on enables the rollout for all schools.
   Keep existing protocol-v3 and scoped-authority capability gates enabled.
5. Rehearse Homeroom → 9:11–9:15 testing → actual next class with a connected
   assigned teacher and compatible Chromebook. Verify rendered tiles and a real
   classroom action in addition to backend lifecycle receipts. Check separate
   supervisor activity summaries and the central copy boundary.

Disable the rollout flag to stop expanded display/tool authority while retaining
compatible code and the additive schema. Continue normal supervision expiry and
reporting. Once context-parented classroom records exist, do not roll back to
software that assumes every record has a teaching session. Roll forward or retain
the compatible gated version; deleting activity records is not a rollback step.

Implementation does not authorize deployment, flag activation or Store upload.
