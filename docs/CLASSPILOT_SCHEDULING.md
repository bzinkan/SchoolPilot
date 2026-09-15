# ClassPilot scheduling

School administrators manage schedules in **Class Management → Scheduling**, the middle tab between Classes and Schedule Changes. Teachers continue to use their classroom and schedule-change workflows.

## Reusable Schedule Profiles

The overview has two sections:

- **Saved profiles** contains reusable plans. Each row summarizes configured testing blocks, **custom class times** and skipped-class rules. These are the plan’s settings, not a count of actual changes on a particular date. **No schedule changes configured** means none of those settings exist in the profile, even if classes are included. Including 50 classes does not mean 50 classes change; only eligible meetings with configured rules change when the plan is applied. **Open profile** opens Day planner, while **Choose dates & apply** selects the actual dates.
- **Applied dates** contains the saved dated applications. Expand an application to inspect its dates, class changes and testing details. Applications with several dates stay together, with details collapsed until needed. **Earlier and cancelled applications** keeps older and cancelled applications in a separate collapsed history section.

Saved-profile rows show the next applied date strictly after today, excluding cancelled applications and dates without eligible class changes or testing blocks. **Applied today** appears separately when appropriate. **No future dates** can therefore appear alongside **Applied today**. All date labels use the school’s timezone; the saved preview date never determines the next applied date.

Choose **Create Schedule Profile**, give it a name such as NWEA, Assembly or Two-Hour Delay, and choose **Preview schedule for**. **Load regular schedule** selects the classes meeting that day with no time overrides; **Start blank** lets you select participating grades or classes manually. **Day planner** combines visual review and editing in the same full-width workspace. Saving the profile does not change the calendar.

### Edit and review the proposed day

**Timeline** uses compact rows, approximately 52–64 pixels tall when collapsed, aligned to one shared time axis. The time header stays visible during vertical scrolling, and row labels stay pinned during horizontal scrolling. It shows the regular schedule as thin bars, proposed classes as blue bars, and testing as yellow bars. A server-confirmed conflict shades the exact overlapping interval on both affected bars; conflict text and separate allowed-overlap labels explain the status. **List** has the same row editors and is the default on mobile; the horizontally scrollable Timeline is optional. Skipped meetings remain visible as **Does not meet**, and unchanged regular classes stay visible beneath overlapping testing supervision. Times, labels and statuses remain available without interpreting color alone.

Use **School**, **Class** or **Teacher** view, plus grade, class, teacher and search filters. School view groups rows by grade with collapsible sections and places testing alongside the classes of each participating grade. Grade placement follows server-provided student associations. A mixed-grade testing block appears under every participating grade as linked views of the same block: editing any occurrence updates that one block, and profile counts and the 30-block limit count it once. Testing with unavailable or unknown associations stays visible in a labeled fallback section instead of being assigned to a guessed grade. Teacher view includes co-teachers and their obligations across grades. Class view includes testing associated with that class's students, showing participation counts for partial-class groups when the server has checked those associations. Display filters never alter profile membership; separate counts show classes included, custom-time rules, skipped classes and testing blocks.

Click a class name or bar to open its editor in that row. Explicitly include a class before changing it, then choose **Keep existing schedule**, **Custom time** or **Does not meet**. Custom times start from the preview date's resolved fixed or period-based window. **Restore regular schedule** removes that class's custom-time or skip rule. **Undo last change** restores draft edits. There is no automatic shortening, cancellation, movement or staff reassignment, and timeline bars use exact time inputs rather than dragging.

For example, a 9:00–10:45 testing block leaves Homeroom at 8:30–9:10 until the administrator explicitly changes its end to 9:00. The proposed bar then shortens while the regular bar remains visible. Choosing **Does not meet** for first period leaves a visible skipped row. Classes after testing continue at their proposed or unchanged times; the planner does not fill gaps by moving later classes.

Background reference-day checks remain advisory. Conflicts, allowed overlaps and incomplete checks are distinct. An unfinished testing block stays visible as not checked; complete portions can still be reviewed. The concise whole-profile issue summary remains visible when a filter hides affected rows; expand it for the explanations. Selecting an issue reveals and focuses its row through display filters. Conflict shading uses only the windows and conflict verdicts from the server's current check; the client does not infer a conflict merely because two bars share clock time. Editing and saving can continue with conflicts, but saved testing blocks still need a name, group, assigned staff and valid times. Failed or incomplete reviews are never a completed no-conflicts result.

For MAP testing, choose **Add testing groups**, find the required **Supervision Groups**, select across pages and set a common window. Each group becomes a separate editable block. A sole eligible staff pairing is prefilled, but availability still needs conflict checks. Click a testing name or bar to change its group, staff or time. **Create group** opens the existing group editor from the picker and returns to the draft; the saved group exists independently of the profile. Regular class rosters stay intact.

The header keeps the profile name, preview date, school timezone, save controls and **Back to scheduling** available. Switching Timeline/List, views or filters preserves the draft. Back returns to the profile list and asks about unsaved changes; an unchanged saved profile closes without a discard prompt. Save first to keep the changes.

### Preview date and actual application dates

**Save profile** saves both the reusable definition and the preview date for every administrator across browsers and devices. Reopening or duplicating the profile uses its saved preview date. New profiles and legacy profiles without that metadata initially use today in the school's timezone. Past dates and closed days are valid preview choices; the review explains when a regular schedule is unavailable.

In the saved planner, changing only the date reveals **Save preview date** and **Discard date change**. Unsaved date changes stay with the draft after display changes and failed saves. Save or discard reusable edits before entering **Choose dates & apply**. Successful saves reopen the exact saved response; a subsequent review failure is reported as **Profile saved; schedule review unavailable**, with a review retry.

Unchanged classes follow their regular schedule on each application date. An explicit custom time remains the chosen clock time even if the preview day or regular bells later change. The saved preview date does not select application dates or activate testing. **Customize this use** starts its comparison with the first selected application date without changing the reusable profile; **Save as new profile** saves the date currently displayed with that new profile.

To use a saved profile:

1. Select **Choose dates & apply**, then choose one or more instructional dates (up to 31 per application).
2. Optionally select **Customize this use**. These edits affect this application only; save a new profile separately when the variation should be reusable.
3. Select **Preview application** and review the class changes and testing blocks. Resolve teacher/student conflicts, approved schedule-change conflicts, unavailable staff pairings, and monitoring-hours problems before applying.
4. Select **Apply reviewed dates**. The server checks the schedule, roster and staff again; an intervening change requires a new preview.

Only eligible meetings on the selected dates change. Class weekdays, term dates, A/B eligibility and instructional status still apply; a profile does not create an extra occurrence or open a holiday. Keep testing dates instructional so the school's A/B rotation continues. Normal scheduling resumes outside those dates.

Applied schedules are snapshots. Renaming or editing the reusable profile does not rewrite them. Apply before both the original and proposed class start time and before testing starts. **Cancel application** opens an accessible confirmation listing every date in that application. **Cancel all applied dates** cancels that entire application, not only an expanded date; **Keep application** leaves it unchanged. Cancellation must occur before the earliest affected original class, proposed class or testing start across all the application’s dates, provided restoring the regular schedule creates no conflict. Once it starts, use Coverage **Release** or **Extend** for active testing; remaining class changes and recorded schedules stay in place. For independent cancellation across a testing week, apply each date separately.

At the scheduled testing time, the worker activates ordinary Coverage supervision for the saved students and assigned staff. Activation rechecks entitlement, full monitoring hours, current class obligations, exact group membership and staff pairing. A changed roster or unavailable staff produces a visible failure rather than silently broadening access. Coverage expiration releases the testing group through the existing authority lifecycle; early release does not restart on the next scheduler tick. A missed window is recorded without starting it late after its end.

In **Applied dates**, **Scheduled**, **Applied today**, **Past date** and **Cancelled** describe the dated schedule. Testing status is separate: blocks can be awaiting start, active, ending, finished, unable to start, missed or cancelled. A **Finished** testing block does not mean the entire application is finished: regular-class changes later that day and other applied dates still remain effective. A cancelled application can briefly show testing as **Ending** while its release completes. Missing or unavailable status information is not proof of completion. Activation runs on the scheduler cadence with bounded work per tick, so it is not an exact-to-the-second start. Review failures in Scheduling and manage live groups in Coverage.

Completed testing supervision produces an activity-summary email for the staff member who actually supervised, plus the existing optional central copy. Each staff handoff closes a separate reporting period. Student participation is clipped to actual arrival/release intervals; a regular class does not claim activity delegated to testing. Reports wait at least 30 seconds for final observations. Failed or missed activation produces no activity summary. These summaries report completed activity; saving, previewing or applying profiles does not announce scheduling changes, and Safety Center alerts remain independent. See [Supervision activity summaries](CLASSPILOT_SUPERVISION_ACTIVITY_SUMMARIES.md).

Limits are 30 saved profiles, 100 retained applications and 2,000 testing windows per school. They are explicit validation limits; saved applications are not silently discarded when a limit is reached.

### Delete a reusable profile

In **Saved profiles**, open **⋯ → Delete profile** on the row and confirm the named profile. Deletion removes it from the reusable list and frees one saved-profile slot. It cannot be undone. **Applied schedules will remain scheduled. Deleting this profile does not cancel testing.** Upcoming and active applications continue; earlier and cancelled applications keep their original snapshot names, dates and histories. Their entries remain in **Applied dates** or **Earlier and cancelled applications**, with **Saved profile deleted** shown beside the saved application name.

Deletion does not remove classes, students, Supervision Groups, staff permissions, live supervision or activity reports. Use **Cancel application** separately before its first affected start when a dated schedule should be cancelled. Existing group-deletion protections still apply to upcoming testing and active supervision even after its reusable profile is removed.

The deletion confirmation freezes the profile and scheduling revisions. If another administrator edits, applies or deletes while it is open, refresh and reopen it. After a successful deletion, a list-refresh failure says **Profile deleted; list refresh unavailable** and retries the read without repeating the deletion.

### API boundaries

The administrator-only `GET /api/classpilot/admin/schedule-profiles/regular-schedule?referenceDate=YYYY-MM-DD` endpoint returns a read-only projection of current regular settings, including date/day/bell metadata and class windows or nonmeeting/unavailable statuses. The API retains the `referenceDate` parameter name; the UI labels it **Preview schedule for**. Calendar exceptions remain effective, while applied profiles, swaps and recorded sessions are excluded. It uses the authenticated school context, returns no roster/device data, and does not create settings or modify scheduling state. The response includes all active classes; whole-day loading enforces the existing 500-individual-class limit without truncation.

Day planner uses the existing regular-schedule projection and `POST /api/classpilot/admin/schedule-profiles/draft-review` checks. Testing participation, grade associations and co-teacher conflicts use server relationships; the client does not infer that omitted roster data means an empty group. Linked testing rows retain one block identity and never create extra profile rules or testing windows. Advisory checks are separate from authoritative application-preview tokens. The saved `previewDate` metadata remains outside class rules and applied snapshots. The compact planner changes presentation only, with no backend rule or API changes. An Applied dates timeline, one-day schedule-change integration, dragging and automatic conflict resolution remain outside this planner update.

`DELETE /api/classpilot/admin/schedule-profiles/:id` accepts `{ revision, profileRevision }` and returns `{ deleted: true, profileId, revision }`. It rechecks active administrator access and entitlement under the existing school lifecycle locks, removes only the catalog entry, increments the scheduling revision and writes its deletion audit in the same transaction. Missing profiles return 404; stale revisions return 409. It neither calls cancellation nor changes activation outcomes, and outstanding previews become stale normally. Day planner and deletion need no database migration or Chrome extension change; release the compatible backend before the frontend controls.

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

After applications exist, a rollback must preserve the `scheduleProfiles` and `profileApplications` collections, each profile's saved `previewDate`, and activation outcomes. Do not restore an older schedule writer that drops those fields or assumes every application still has a reusable source profile. Keep the compatible writer, or disable schedule mutations while preparing a compatible rollback. Existing live Coverage contexts still require their expiration/release lifecycle.

Verify a regular weekday, early-release day, closed day, A/B holiday reflow, weekend makeup with mapped weekday, explicit override, co-teacher collision and an already-frozen occurrence. The preview lists at most 150 occurrence changes; validation also checks approved reservations and explicit exceptions beyond the displayed calendar horizon. This release does not change the one-occurrence-per-day invariant.
