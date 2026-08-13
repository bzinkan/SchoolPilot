# GoPilot User Guide

GoPilot is a school-operated dismissal system. Authorized school staff enter arrivals, office staff coordinate the live queue, and teachers release students assigned to them. GoPilot has no parent registration, parent portal, parent check-in, QR arrival, or parent change-request workflow.

## Roles

| Role | Add arrivals | Manage queue | Release assigned students | Manage authorized pickups | Configure school |
| --- | --- | --- | --- | --- | --- |
| Administrator / school administrator | Yes | Yes | Yes | Yes | Yes |
| Office staff | Yes | Yes | No | Yes | No |
| Teacher | No | No | Yes | No | No |

Historical parent accounts, family links, requests, and dismissal records remain retained under SchoolPilot’s existing retention rules, but they do not grant GoPilot access.

## Initial setup

Administrators open **GoPilot → Setup** and complete these areas:

1. Add staff and identify teachers and office staff.
2. Import or add the active student roster.
3. Create homerooms and assign students and teachers.
4. Configure bus routes and each student’s normal dismissal type.
5. Create internal car-number groups for car riders.
6. Add and verify authorized pickup contacts.
7. Review dismissal time, timezone, optional auto-start, pickup zones, and the instructional calendar in **Settings**.

Car numbers are internal school lookup values. They are not invitations and are not displayed as parent QR tags.

## Settings

The settings screen saves one versioned GoPilot settings record:

- **Dismissal time** — the school-local scheduled time.
- **School timezone** — used for instructional-day and daylight-saving calculations.
- **Auto-start** — off by default; when enabled, GoPilot starts only on eligible instructional days for an active GoPilot-licensed school.
- **Pickup zones** — staff-selectable release locations.
- **Instructional calendar** — administrators mark holidays and school closures so an enabled auto-start does not create a dismissal session on those dates.

After a successful save, GoPilot displays the authoritative saved revision. If another administrator saves first, reload the latest version, review it, and save again. A failed save leaves the local edits in place.

Calendar months use the same verified, revision-aware save behavior. Weekends and past dates are locked; future weekdays can be marked non-instructional individually or as a range.

## Starting dismissal

An administrator or office staff member opens the dismissal dashboard. An administrator starts the session manually, or an explicitly enabled instructional-day schedule starts it at the configured school-local time.

The header shows the current state:

- **Not started** — arrivals cannot be queued.
- **Active** — staff can add arrivals and operate the queue.
- **Paused** — queue mutations are paused.
- **Completed** — the day’s session is closed and retained as history.
- **Offline/stale** — real-time transport is degraded; GoPilot continues polling for an authoritative snapshot.

## Adding arrivals

Only administrators, school administrators, and office staff can add arrivals.

### Car number

1. Open the **Queue** view.
2. Enter the school-assigned car number.
3. Select **Add**.
4. GoPilot queues the eligible active car riders in that family group.

Repeated clicks are idempotent. An absent student is skipped and reported to staff.

### Student or family search

Use **Search arrivals** when a student has no car number or the number is unknown:

1. Search by student, family, or car number.
2. Select one or more eligible students.
3. Choose **Add selected arrivals**.

Search results are limited to the active school and never reveal another school’s records.

### Buses and walkers

The existing staff bus-number and walker workflows remain available. Their queue entries follow the same call, release, and completion controls as car riders.

## Queue lifecycle

1. **Waiting** — authorized staff entered the arrival.
2. **Called** — office staff selected a pickup zone and called the student.
3. **In transit** — the assigned teacher released the student from class.
4. **Dismissed** — office staff verified the handoff and completed pickup.

Teachers cannot add arrivals. They see only their assigned students, acknowledge the classroom call through the queue state, and release the student when the handoff begins.

Do not complete a pickup if a custody alert or authorized-pickup mismatch is unresolved.

## Authorized pickups

Administrators and office staff manage contacts in **Setup → Authorized Pickups**:

1. Select the student.
2. Enter the contact name, relationship, and optional phone.
3. Verify the contact against school records.
4. Approve the pending contact.

Revocation keeps the historical record. Status changes are limited to `pending`, `approved`, and `revoked` and are recorded as staff actions.

## Same-day dismissal overrides

Administrators, school administrators, and office staff may set or revert a documented same-day override for car, bus, walker, or after-school dismissal while a session is active. The permanent student configuration is unchanged. Teachers see the effective same-day type for assigned students but cannot create or revert overrides.

## Android app

The supported GoPilot native app is Android and staff-only. It contains the office/admin dashboard, teacher view, setup access appropriate to the signed-in role, and staff authentication. Parent routes and parent registration are not included.

Authentication tokens are stored only through Android Keystore-backed secure storage. If secure storage is unavailable, authentication stops without falling back to SharedPreferences.

Android staff sign in with their school-issued email and password. Google sign-in is not offered in the Android app while a verified HTTPS App Link flow is pending.

## Troubleshooting

### An arrival cannot be added

- Confirm dismissal is active rather than paused or completed.
- Confirm the staff member is an administrator, school administrator, or office staff member.
- Confirm the student is active, belongs to the school, is not absent, and has an eligible effective dismissal type.
- For car-number intake, confirm the internal family group and car number.
- Use direct student search for students without a car number.

### A teacher cannot see a student

- Confirm the teacher is active and assigned to the student’s GoPilot homeroom.
- Confirm the student has been queued and called.
- Refresh the page; GoPilot also refetches after reconnects and periodically during an active session.

### Settings report a conflict

Another administrator saved a newer revision. Reload the latest settings, review the differences, and save again.

### Real-time status is stale

Keep the page open. GoPilot polls the active session while the socket or Redis relay recovers. Do not repeat an arrival solely because a socket update is delayed; the arrival API is idempotent.

## Operational checklist

Before a live dismissal:

- Verify the active school and GoPilot license.
- Confirm the instructional calendar, timezone, dismissal time, and auto-start choice.
- Confirm staff roles and homeroom assignments.
- Test car-number and direct-search arrivals with synthetic students.
- Test one teacher release and office completion.
- Review custody alerts and authorized pickups.
- Confirm the Android app is the current staff-only release.

After dismissal, review outstanding queue entries before completing the session. Session, arrival, call, release, dismissal, override, settings, and setup actions remain available to authorized staff for audit and support.
