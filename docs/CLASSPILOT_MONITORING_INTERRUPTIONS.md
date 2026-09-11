# Monitoring interruptions

**Coverage/Supervision** and **IT Readiness** show a compact monitoring summary. **View interruption history** opens the event details without leaving the page. An interruption means expected telemetry stopped; its cause is unknown. It does not establish that a student disabled Wi-Fi, closed the extension or acted deliberately.

The summary separately counts **open interruptions** and **events detected in the last 24 hours**. These are event counts, not unique students; one student can have separate interruptions. An older open event counts as open but does not increase the last-24-hours count. Counts cover all retained events you are authorized to see, independently of the history page size.

History has **Open** and **Last 24 hours** views with 50 events per page and Previous/Next controls. Open includes retained events older than a day; Last 24 hours includes open, recovered and ended events detected during that window. Refresh history starts again at the newest page. A pagination window expires after 15 minutes; refresh to continue. Teachers and office staff can open their authorized history directly from Coverage; administrator-only IT Readiness is not required.

## What qualifies

The server must have previously observed a valid full-monitoring heartbeat for the student's exact active sign-in and Chromebook binding during the current frozen classroom or delegated supervision scope. Authentication presence alone does not count as telemetry. Students never observed in the scope do not generate interruption incidents.

A worker checks in batches every 60 seconds. An incident opens when the last valid observation is more than 60 seconds old, so detection usually takes 60–120 seconds. Stored expectation state survives the realtime cache's expiry. Repeat scans do not create duplicate open incidents.

Fresh telemetry for the exact binding recovers an incident. A new binding or scope ends the old expectation and must establish its own observation. Class or coverage end, release, inactive students, recorded absence/early dismissal, expired sign-in, privacy-off telemetry and non-full school monitoring policy exclude the student. Safety-only observations do not establish full-monitoring expectations.

## Uncertain readings

Redis or database failure, invalid binding reads and delayed worker scans produce **uncertain** status. A service failure does not open a new student interruption. The panel should be assessed together with service health; an existing incident may remain uncertain until telemetry or authoritative scope state is available again.

Teachers see incidents for their frozen classroom staff assignments and assigned supervision contexts. School administrators see school-wide incidents. Responses and digests omit internal Chromebook/session binding identifiers and browsing URLs.

## Optional daily digest

The **Daily monitoring interruption digest** setting sits next to school monitoring hours and defaults off. Enabling it sends current active school administrators an operational summary when that tracking day had interruptions. It becomes due 30 minutes after the configured tracking end time in the school's timezone. Overnight tracking belongs to the day on which the window started. Configure valid start/end times before enabling the digest.

ClassPilot monitoring, class schedules and this digest use the timezone on the school profile. Monitoring hours displays that timezone read-only; a monitoring-settings request cannot set a different one. Saving safety-only mode requires enabled tracking hours, distinct valid start/end times and at least one valid tracking day. Unrelated settings edits leave legacy monitoring configuration unchanged.

The digest groups incident and student counts by scope. It contains no browsing URLs or student safety content. It is independent of Safety Center notifications. Disabling it cancels pending deliveries. Known temporary failures retry with a limit; an uncertain provider submission is recorded as unknown and is not blindly resent.

Completed testing and Coverage assignments have a separate [supervision activity summary](CLASSPILOT_SUPERVISION_ACTIVITY_SUMMARIES.md), sent to the actual supervisor and the optional central recipient. It summarizes each student's recorded activity within that supervisor's participation intervals. It does not change interruption detection, this optional daily digest, or Safety Center alerts. Missing observations in an activity summary are not a confirmed healthy monitoring result.

Digest eligibility follows the instructional calendar and explicit makeup weekdays used by monitoring. A Saturday that follows Monday can send Monday's tracking-day digest; a closed instructional date does not. Overnight windows keep their start date even when the following day is closed. Queued deliveries recheck the current calendar before submission.

## Operator verification

The registered migration creates tenant-scoped expectations, incidents, digest settings and digest deliveries. Named constraints converge a Drizzle-created database without table recreation. Composite school/student, exact sign-in/Chromebook and scope-parent foreign keys protect relationships; database triggers also validate frozen-roster or coverage membership. Invalid existing relationships stop migration rather than being silently discarded.

The scan and digest jobs use the dedicated scheduler database pool and scheduler locks. No additional history queries or writes are added to the heartbeat request path. Inspect worker health when a panel remains uncertain for more than three minutes.

Incident rows are independent of regenerated monitoring-report events and carry retention expiry. Verify: initial observation → missed telemetry → one open incident → exact-binding recovery; cache expiry; cache outage; sign-in replacement; absence and privacy exclusions; school mode changes; staff/tenant isolation; default-off digest; and one delivery per administrator/day. The summary read returns counts without student details; history returns 50 authorized events per page. The legacy API response remains available for older clients.
