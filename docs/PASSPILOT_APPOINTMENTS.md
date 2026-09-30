# PassPilot appointments v1: server contract

Appointments are one-time, staff-managed invitations to activate a normal pass in
an explicit window. This slice supplies schema, staff API, atomic activation and
lifecycle maintenance. Staff reminders and the scheduling UI ship separately;
aggregate reporting also ships separately. No student or kiosk reminder surface,
automatic issuance, recurrence or GoPilot role inheritance is included.

`PASSPILOT_APPOINTMENTS_MODE=off` is the default. The routes step aside to the
normal unknown-route 404 before authentication unless the exact value is `on`,
RLS request binding is enabled and the complete preserved 128-table inventory is
admitted. The
sanctioned setter is `scripts/deploy-product-runtime-config.ps1`. RLS admission
uses the singleton reviewed `passpilotAppointments` bundle after the immutable
127-table usage-computation inventory; the new complete target has 128 tables.
Production's observed allowlist is unchanged in this PR.
While appointments remain on, Plan and Apply also require atomic writer contract
version 2 at the exact source SHA/digest serving on both API and worker; an older
writer or partial previous-table admission cannot enable new activation. Turning
the mode off remains available. PassPilot-only school-year setup is a separate
required release dependency because the current scheduling configuration route
requires a ClassPilot license; do not enable for those schools before that slice.
The initial server/API draft (#570) also requires the eligibility-race correction
before activation: version 2 includes student-lock serialization for attendance
and preserves GoPilot's session-before-student lock order.

## Authority and private notes

Existing PassPilot managers (`admin`, `school_admin`, `super_admin`, or
PassPilot-authorized `office_staff`) create, edit and cancel pending appointments.
Teachers read and activate only appointments for currently active students in
their currently assigned official classes (primary or co-teacher) or current
legacy classes. Prior pass authorship does not grant access. GoPilot office
profiles and product headers do not grant PassPilot manager authority.

Every write locks the school/staff-assignment lifecycle, canonical class source
and appointment row, then rechecks the current school, PassPilot license,
membership, user auth version, class access and student state. At activation the
supplied current class is validated by the existing issuer; the scheduling class
is never frozen. Current school hours, instructional closures, school-year and
timezone changes, known same-day absence, early dismissal and released/dismissed
GoPilot movement facts are checked. Manager notes are manager-only, omitted from
teacher DTOs, and never copied into pass notes, timeline, kiosk or normal exports.
Administrator rule overrides keep their original durable denial/audit evidence;
the corrected encounter confidentiality contract applies to the returned pass.

## HTTP API

All routes live under `/api/passpilot/appointments` and use current school
context, authentication, active school, PassPilot entitlement and the established
canonical-class capability header where applicable. Responses are `no-store`.

| Method/path | Contract |
| --- | --- |
| `POST /` | Manager; `requestId` UUID, studentId, destination, optional customDestination/staffNotes/duration, startsAt/endsAt. 201 first create, 200 exact replay; changed payload with the same requestId is 409. |
| `GET /` | Current-access staff; bounded offset-bearing from/through, optional status/studentId, limit 1–100, opaque keyset cursor. Default seven school-local days. |
| `GET /:id` | Current-access staff; confidential notes only for managers. |
| `PATCH /:id` | Manager; expectedRevision and at least one editable scheduling field. Pending appointments only. |
| `POST /:id/cancel` | Manager; expectedRevision. Pending cancellation is idempotent; after activation use the existing pass controls. |
| `POST /:id/activate` | Current-access staff; expectedRevision, explicit current classId, optional administrator overrideRuleCode. 201 first activation, 200 duplicate activation returning the exact original pass even after completion; no second pass. |
| `GET /students/:studentId/records` | Administrator only; explicit bounded date range, cursor and limit; manager-private records for existing access/export requests, with content-free audit. |

Instants must include an explicit UTC offset or `Z`. Both occurrences of a DST
fold are distinct chosen instants. Bare wall times are rejected; caller timezone,
roles, issuance toggles and recurrence fields are rejected. The school timezone
is captured from the verified school settings. The activation window is positive
and at most 24 elapsed hours. Duration is 1–120 minutes.

## Atomic activation and lifecycle

The existing canonical/legacy issuer accepts the outer transaction and uses a
savepoint on that same connection. Its class validation, Rules capacity, active-pass unique
index and authorization checks remain authoritative. Pass insertion, appointment
linkage, strict activation/override audits and the pass timeline event commit
together. Denied/failed issuance leaves the appointment scheduled. A concurrent
duplicate activation returns the linked pass; a concurrent edit/cancel wins or
loses under the same lock and expectedRevision contract.

Activation holds the current student row FOR SHARE through the canonical pass
insert and commit. Single/bulk attendance upserts and absence removal hold those
rows FOR UPDATE in sorted order; GoPilot release/dismissal writers already take
the same student lock. An earlier absence or dismissal writer must finish before
activation reads eligibility, and a later writer cannot commit between that read
and pass issuance. The dismissal read does not lock its session after the student:
GoPilot writers own the session first, so taking it here would reverse lock order.

Lifecycle states are `scheduled`, `activated`, `completed`, `cancelled`, and
`missed`. Reminder delivery state is separate and is not implemented in this
slice. Ended pending windows become missed; no pass is issued by a worker.
Explicit pass return completes the linked appointment; explicit pass cancellation
cancels it. Crossing a pass's overdue deadline leaves both pass and activated
appointment open. The database invoker trigger covers every existing return and
cancel path in the same transaction, including kiosk paths and feature-off use.

## Retention and rollback

Hall-pass policy retains records for the **current school year**
(`schoolpilot-app/src/pages/legal/PrivacyPolicy.jsx`). Scheduling requires both
canonical `classpilot_school_schedules.config.yearStart` and `yearEnd`; missing
configuration returns `APPOINTMENT_SCHOOL_YEAR_REQUIRED`. No invented fallback
retention period is used. The exclusive retainedUntil is school-local midnight
on the day after yearEnd. Manager edits recapture the configured boundaries.

Bounded worker maintenance runs independently of appointment mode, school status
and license. At the cutoff it scrubs private notes and the payload fingerprint,
then removes expired appointment records with no active linked pass. An open or
overdue linked pass retains its appointment linkage until an explicit return or
cancel; maintenance never returns, cancels or deletes a pass. Private note
scrubbing does not change activation status or revision. API projections hide
expired notes immediately even before the worker catches up.

Rollback uses the sanctioned runtime tool to set appointments off and keeps the
expanded schema, table grants, RLS admission and pass-return trigger. Use a
schema-aware compatibility image with appointments off; an arbitrary pre-schema
image is not an approved rollback target, because its admission registry may not
recognize the new table. Do not reverse the migration, drop the trigger/table,
remove the admitted table or auto-close open passes. Explicit returns continue
completing appointment linkage while the new scheduling API is unavailable.

During expansion, the invoker completion trigger returns without touching the
new table if the old writer lacks either SELECT or UPDATE privilege. It checks
these privileges separately. This compatibility branch is permitted only before
first activation, while the table is empty. It is not a post-activation fallback.
Before first activation prove all API/worker writers serve atomic writer contract
v2 with the full admission and SELECT/INSERT/UPDATE appointment grants; the locked
write context also checks those grants and returns `APPOINTMENT_GRANTS_REQUIRED`
when missing. After activation, preserve the compatible writers and all grants
even while the feature is off. Never roll back to a no-grant/pre-schema writer.
