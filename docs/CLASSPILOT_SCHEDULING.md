# ClassPilot scheduling

School administrators manage schedules in **Class Management → Scheduling**, the middle tab between Classes and Schedule Changes. Teachers continue to use their classroom and schedule-change workflows.

## Reusable Schedule Profiles

Choose **Create Schedule Profile**, give it a name such as NWEA, Assembly or Two-Hour Delay, and select participating grades or individual classes. For each selected class, keep its normal schedule, set custom start/end times, or choose **Does not meet**. Custom times work for existing fixed-time classes as well as period-based classes. Saving the profile does not change the calendar.

For MAP testing with an intervention specialist or another teacher, first create the required **Supervision Groups** and staff pairings in Coverage. Add optional testing blocks to the profile, choosing each group's paired staff member and its start/end times. Regular class rosters stay intact. Separate blocks can give each grade or group its own time and proctor.

To use a saved profile:

1. Select **Apply**, then choose one or more instructional dates (up to 31 per application).
2. Optionally select **Customize this use**. These edits affect this application only; save a new profile separately when the variation should be reusable.
3. Preview the class changes and testing blocks. Resolve teacher/student overlaps, approved schedule-change conflicts, unavailable staff pairings, and monitoring-hours problems before applying.
4. Apply the reviewed preview. The server checks the schedule, roster and staff again; an intervening change requires a new preview.

Only eligible meetings on the selected dates change. Class weekdays, term dates, A/B eligibility and instructional status still apply; a profile does not create an extra occurrence or open a holiday. Keep testing dates instructional so the school's A/B rotation continues. Normal scheduling resumes outside those dates.

Applied schedules are snapshots. Renaming or editing the reusable profile does not rewrite them. Apply before both the original and proposed class start time and before testing starts. An application can be cancelled before its first affected meeting or testing block starts, provided restoring the regular schedule creates no conflict. Once it starts, use Coverage **Release** or **Extend** for active testing; recorded class schedules remain preserved. For independent cancellation across a testing week, apply each date separately.

At the scheduled testing time, the worker activates ordinary Coverage supervision for the saved students and assigned staff. Activation rechecks entitlement, full monitoring hours, current class obligations, exact group membership and staff pairing. A changed roster or unavailable staff produces a visible failure rather than silently broadening access. Coverage expiration releases the testing group through the existing authority lifecycle; early release does not restart on the next scheduler tick. A missed window is recorded without starting it late after its end.

The applications list shows pending, active, ended, failed and missed testing-block outcomes. Activation runs on the scheduler cadence with bounded work per tick, so it is not an exact-to-the-second start. Review failures in Scheduling and manage live groups in Coverage. Schedule Profiles do not generate safety alerts or administrator email notifications.

Limits are 30 saved profiles, 100 retained applications and 2,000 testing windows per school. They are explicit validation limits; saved applications are not silently discarded when a limit is reached.

## Set up the school calendar and bells

1. Enter the school-year dates. For A/B rotation, choose an instructional anchor date and whether it is A or B. Leave the anchor empty if the school uses weekdays only.
2. Add named periods, then give each period a start and end time in the Regular bell profile. Add other profiles, such as Early Release, and select the default profile.
3. Assign a profile to particular weekdays where needed. A Wednesday Early Release profile changes every Wednesday class linked to those periods.
4. Mark holidays and other noninstructional dates in the school calendar. Preview the affected occurrences, then save the reviewed month. Save or discard that month draft before reviewing other scheduling changes.
5. Add explicit date overrides for a particular A/B day or bell profile. For a makeup date, including a weekend, choose **Instructional makeup day** and the weekday whose classes and bells it should follow. For example, a Saturday can follow Monday meetings. Leave the meeting weekday unset for classes explicitly scheduled on Saturday. A/B and bell profiles are independent: a day can be both A and Early Release.
6. Select **Preview changes**, review conflicts and the dated changes, then **Save reviewed schedule**. Another administrator's intervening changes require a fresh preview.

A/B advances only on instructional dates within the configured year, including explicitly opened weekend makeup dates. Closing a day shifts the generated rotation for later dates. Explicit A/B and bell overrides remain in place and do not reset the generated sequence that follows them. Weekends are closed by default; an instructional date override opens them for ClassPilot. The A/B anchor must remain an instructional date.

ClassPilot instructional overrides take precedence over shared school-calendar closures. They affect ClassPilot classes and rotation only; they do not open GoPilot dismissal on a weekend. The month calendar continues to show the shared closures; the Scheduling preview shows the effective ClassPilot date, including its makeup weekday.

## Assign schedules to classes

In the Classes tab, enable a class schedule and choose its meeting weekdays, optional first and last meeting dates, A/B applicability, and either a period or fixed times. First and last dates are inclusive. Weekdays and A/B rules both apply.

Existing classes retain their fixed start and end times until an administrator links them to a period. Bell-profile edits affect classes linked to periods. Choose an end date for a term-limited fixed-time class; the school-year dates bound generated A/B rotation.

ClassPilot retains one occurrence per class per school-local date. Separate classes are needed for two meetings on the same day. Both primary and co-teacher assignments participate in overlap checks, which compare dates the classes actually meet. Classes on disjoint weekdays, date ranges or A/B days can share clock times.

## Changes already in progress

Frozen occurrences retain their recorded times and roster, including after a calendar closure. Their actual windows still participate in conflict checks. A class currently due but not yet frozen cannot have its window moved while it is in progress.

An approved schedule swap reserves its dated windows. Cancel an affected approved change before saving an incompatible base schedule or calendar change. Affected pending requests are superseded after a successful configuration save. Unaffected approved changes remain valid.

## Operator verification

Apply the registered additive scheduling migration and tenant RLS policies before the application reads `groups.schedule_rule` or `classpilot_school_schedules`. Missing school calendar settings fail closed. School provisioning and test fixtures must create settings even when all classes use fixed times.

Reusable profiles additionally require the `classpilot-schedule-profile-supervision-20260905` migration before API/worker activation. It adds activation outcomes to the existing school schedule row and nullable application/block/date metadata with a uniqueness constraint to existing supervision contexts. Both tables retain their registered tenant policies. The migration is mirrored in nonproduction convergence. No Chrome extension release is needed for this feature; it uses the existing Coverage control contract.

After applications exist, a rollback must preserve the `scheduleProfiles` and `profileApplications` collections and activation outcomes. Do not restore an older schedule writer that drops those fields. Keep the compatible writer, or disable schedule mutations while preparing a compatible rollback. Existing live Coverage contexts still require their expiration/release lifecycle.

Verify a regular weekday, early-release day, closed day, A/B holiday reflow, weekend makeup with mapped weekday, explicit override, co-teacher collision and an already-frozen occurrence. The preview lists at most 150 occurrence changes; validation also checks approved reservations and explicit exceptions beyond the displayed calendar horizon. This release does not change the one-occurrence-per-day invariant.
