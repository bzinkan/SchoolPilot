# SchoolPilot scheduling guide

Open **Class Management → Scheduling**. Its three sections separate special schedules from everyday setup: **Schedule profiles**, **Bells & rotation**, and **Calendar & exceptions**. All times use the school's timezone.

## Choose the right tool

| What you want to do | Where to do it |
| --- | --- |
| Set a class's regular weekdays, term dates, A/B rule and time | **Classes** → edit the class |
| Define named periods and the times used on regular or early-release days | **Scheduling → Bells & rotation** |
| Mark holidays, open a makeup day, or change one date's A/B day or bells | **Scheduling → Calendar & exceptions** |
| Reuse a testing-day, assembly or delay plan on selected dates | **Scheduling → Schedule profiles** |
| Exchange two classes' time slots for one date | The separate **Schedule Changes** tab |

**Bell profiles** and **schedule profiles** do different jobs. A bell profile is a timetable for named periods; only classes linked to those periods follow it. A schedule profile is a reusable plan that you apply to dates; it can change fixed-time classes, period-based classes and optional testing supervision. Saving a schedule profile alone does not activate anything, and it does not repeat automatically each week.

## Set up the everyday schedule

1. In **Bells & rotation**, add your periods, such as Period 1 and Period 2. This enables **Add bell profile**.
2. Create a **Regular** bell profile, enter each period's start and end time, and make it the default. Add alternatives such as **Early Release**. A weekday selection overrides the default for that weekday; **Use default** inherits the default timetable.
3. If your school rotates A/B days, enter the school-year dates and an instructional **anchor date** with its A or B label. The anchor means “this known date is A/B.” Leave it empty for weekday-only schedules.
4. Choose **Preview changes**, resolve blockers, then **Save reviewed schedule**.
5. In **Classes**, enable each class's schedule. Choose weekdays, optional first/last meeting dates, A/B applicability, and either a named period or fixed start/end times. Existing fixed-time classes need to be linked to a period before bell-profile edits affect them.

For example, Period 1 can be 8:00–8:45 in Regular and 8:00–8:30 in Early Release. Assign Early Release to Wednesday and every Wednesday class linked to Period 1 uses the shorter window. Fixed-time classes keep their own times.

Weekday and A/B rules both apply. An A-day Monday/Wednesday class meets only when the date satisfies both conditions. School-year dates bound the generated A/B rotation; use each class's first/last dates to limit a weekday-only class to a term. A class can have one scheduled meeting per date.

## Handle holidays and makeup days

In **Calendar & exceptions**, mark future noninstructional weekdays in the month calendar. Choose **Preview month changes**, review the affected classes, then **Save reviewed month**. Save or discard that month draft before reviewing other schedule changes.

A/B advances on instructional days. A holiday pauses the rotation and shifts later A/B dates. A single-date A/B override changes that date only; it does not reset the sequence afterward. A/B and bell choices are independent, so a date can be both **A** and **Early Release**.

Use a date exception to choose a different bell profile or A/B label. To open a weekend makeup date, choose **Instructional makeup day**, then the weekday whose classes and bells it should follow. For example, Saturday can follow Monday's meetings. Preview and save these exceptions with the schedule controls.

The month calendar stores shared school closures. An explicit ClassPilot instructional exception takes precedence for ClassPilot and can open a date that the month calendar still shows as closed. It does not open GoPilot dismissal on a weekend.

## Apply a special schedule or testing day

1. In **Schedule profiles**, choose **Create Schedule Profile** and name the plan, such as NWEA or Two-Hour Delay. Choose an instructional **Reference date** and select **Load regular schedule** to begin with the classes that meet that day. **Start blank** lets you choose the participating grades and classes yourself.
2. Review the **Regular schedule** column and adjust the selection. Use **Clear selection** to remove the imported classes and their rules before choosing a smaller group. Meeting classes initially use **Keep existing schedule**. Choose **Custom time** to start from that class's resolved time for the reference date, then edit it; choose **Does not meet** to skip the class on the dates where the profile is applied. Returning to **Keep existing schedule** removes that class's custom-time or skip rule.
3. For supervised testing, first create the student groups and staff pairings in **Coverage**. Add testing blocks to the profile, selecting each group, its assigned staff member and its times. Student class rosters remain intact.
4. Save the profile. Then choose **Apply**, select up to 31 instructional dates, and optionally use **Customize this use** for a variation that belongs only to this application.
5. Choose **Preview application**. Resolve overlaps, approved swaps, unavailable staff pairings and monitoring-hours issues. Choose **Apply reviewed dates** when the preview is clear.

The reference date supplies a comparison of the regular school day. It accounts for the school calendar, that day's weekday and A/B rules, class term dates, and the applicable bell timetable. It excludes applied schedule profiles and approved one-day swaps. A class that does not meet, has scheduling turned off, or has an unresolved time or period is shown with its status instead of a guessed time. Choose another instructional date if the reference date is closed. For more than 500 meeting classes, start blank and choose a smaller selection.

Loading the regular schedule does not save a profile or change a live schedule. The reference date is not stored in the profile or its application, and keeping every class unchanged saves a profile without custom-time rules. **Keep existing schedule** uses the class's eligible regular schedule on each eventual application date; it does not freeze the reference date's times. Loading a different comparison date after editing preserves your class selection and custom rules.

Editing and duplicating a saved profile offer the same regular-day comparison. When you customize an application, its first selected date supplies the initial reference. The application preview remains the final check of the actual selected dates, including interactions with other applied plans and approved swaps.

For example, an NWEA plan can skip or move the regular meetings that overlap a 9:00–10:00 testing block and assign the testing group to its paired intervention specialist. The preview checks staff and student obligations. Simply adding a testing block does not automatically cancel conflicting classes.

An application changes only eligible meetings on its selected dates. It does not open a holiday or create a meeting outside a class's weekdays, term or A/B rule. Regular scheduling resumes outside those dates. Editing the saved profile later does not rewrite an applied plan.

Apply before both the original and proposed class starts, and before testing starts. **Cancel application** restores the regular schedule only before the application's first affected start and only if restoration is conflict-free. For a testing week that may need separate daily cancellations, apply each date separately. After testing starts, manage it with **Release** or **Extend** in Coverage.

The applications list shows testing-block progress and failures. At activation, the system checks the saved students, current group membership, staff pairing, monitoring hours and other teaching obligations again. A changed group or unavailable pairing can make activation fail. Review failures here and manage any testing still needed in Coverage; failed, missed or early-released blocks do not restart automatically. Schedule profiles do not send administrator email or safety alerts.

## Use Schedule Changes for a one-day swap

This separate tab exchanges two existing class windows on one instructional date. It preserves teachers, rosters and class ownership; the recurring schedule returns afterward.

Administrators first enable an eligible pair: two active scheduled official classes with different primary teachers, equal-length windows and no overlap. An administrator can create the dated swap directly with a reason. If teacher requests are enabled in **Admin Settings → Schedule Changes**, a primary teacher can request a swap, the other primary teacher accepts, and an administrator approves when school policy requires it. Co-teachers have view access to this request workflow.

Teacher requests are off by default. Administrator approval, required teacher reasons and a school-local same-day cutoff are separate settings. Every swap must be completed before the earlier affected class starts, even if the teacher cutoff is disabled. The tab separates **Needs Action**, **Upcoming** and **History**.

## What happens when the bell arrives

The system resolves the date's instructional status, meeting weekday and A/B day; checks the class's meeting rules; picks fixed times or the date's bell timetable; and incorporates applied plans and approved swaps. Conflicting changes must be resolved before saving or applying them.

The scheduler checks about every minute. A connected primary teacher or co-teacher can carry the automatic class start. If none is connected, the scheduled occurrence enters the coverage workflow. Classes end at their recorded scheduled end; a live occurrence is not repeatedly restarted on each check. Testing blocks activate through Coverage on the scheduler cadence too.

Once an occurrence is recorded, its times and roster are frozen. Later calendar or schedule edits preserve it. Previews flag conflicts and stale reviews; if another administrator changes the schedule between preview and save, review the latest state again. Cancel an incompatible approved swap before changing its underlying schedule.
