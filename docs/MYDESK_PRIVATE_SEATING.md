# My Desk private seating charts

This is the implementation and proposed rollout contract for seating charts in
ClassPilot web. It is not evidence of production deployment or an operating
privacy/retention control. The notebook prerequisites and storage cleanup remain
governed by [MYDESK_PRIVATE_NOTEBOOK.md](MYDESK_PRIVATE_NOTEBOOK.md).

## Access and stored data

Every request requires the base My Desk gate, the seating gate, ClassPilot
entitlement, and the author's current staff membership in the active school.
Teachers and school administrators own separate charts. Administrative access
does not permit reading another author's charts. Author predicates enforce that
boundary; forced tenant RLS provides school isolation. There is no shared chart,
Chromebook/device assignment, student-facing view, AI input, or timeline event.

`mydesk_seating_charts` stores the author's chart name, desk positions and lock
state, selected school student IDs, and class/roster name snapshots. The live
composite class FK detaches only `group_id` on class deletion; `filing_group_id`
and snapshots retain historical context. Past-class charts remain privately
readable and deletable. Editing requires access to the current class; copying a
layout to a current class clears student assignments and desk locks.

The retained version-1 layout permits at most 100 desks on a 1200 by 900 coordinate board,
with 100 by 60 desks snapped to a 10-unit grid. Application validation rejects
overlap, duplicate desk/student IDs, and positions outside the board. Roster
snapshots contain at most 1,000 students. Server-derived roster revisions detect
stale names or assignments; clients must refresh before saving a changed roster.
Student records supply names and IDs, never device identities.
Version 2 adds a measured room with integer millimetre geometry and imperial or
metric display. A single closed polygon supports 3–24 vertices, angled walls,
and one selected front wall. At most 100 desks and 100 fixtures may fit within
a 50-metre bounding area. Fixtures include a teacher desk, cabinets, lockers and
interior walls; doors/windows attach to stable wall IDs with width and offset.
Desk/furniture dimensions and rotation are explicit. Shared API/browser geometry
rejects self-intersecting/degenerate outlines, out-of-room or overlapping solid
footprints, and invalid wall openings, including concave-room edge crossings.
Door-swing intersections are visible advisory warnings and do not prevent saving;
this is classroom planning, not a building-code or accessibility certification.

Existing v1 documents remain readable and unchanged. Conversion requires a
teacher-entered actual room width, previews one uniform scale for the old 4:3
canvas and desks, and preserves seat IDs, assignments and locks. Conversion is
only a draft until explicit Save; Undo/Cancel remain available. New and converted
measured layouts retain the existing author ownership, class/roster revision
checks, atomic save, current-chart rules and historical-only restrictions.
Use the additive `mydesk-measured-seating-20260926` migration; never rewrite the
checksummed original seating migration or silently convert stored JSON.

Numeric controls and select-and-place editing supplement pointer dragging.
Room fixtures are included in the saved printable layout; controls, lock markers,
unassigned students and private-note contents are excluded. Letter/A4 printing
fits the drawing to a page and is not guaranteed to preserve real-world scale.

Derived names are bounded to 500 characters, student IDs to 128, and serialized
roster snapshots to 1,000,000 bytes before saving. The database also enforces a
1-MiB JSON ceiling; oversized source records require correction before saving.

Writes use the existing short school-scoped database transaction. Class advisory
locks serialize current-chart selection; class and roster row locks protect the
save snapshot. The first chart for an author's class is current. Deleting the
current chart does not automatically select a replacement. A partial unique
index enforces at most one active current chart per school, author, and filing
class. Revisions prevent overwriting another edit. Create request IDs and hashes
prevent duplicate creates; the last 100 mutation receipts store only operation
IDs, hashes, revisions, and kinds for bounded retry recognition.

## Privacy and retention

Charts and roster snapshots remain in PostgreSQL until author deletion or the
verified school-account destruction process. Chart deletion atomically clears
the chart/class names, layout, roster snapshot, roster revision, live class ID,
and current status. The remaining request tombstone retains only ownership,
filing/request IDs, hashes, operational receipts, and timestamps; it is not a
recoverable chart. No S3 object or new scheduled cleanup job is involved.

Audit events contain operation identifiers only. Chart names, student names,
layout content, and roster snapshots must not enter audit/error logs or release
evidence. The existing My Desk no-store responses and upstream private-error
boundary also cover seating routes. Printing uses the browser's own print flow;
delivered charts and prints cannot be recalled by the server.

Disabling either feature gate or revoking membership prevents access without
deleting records. Permanent account destruction must include seating rows and
their tombstones before hard-deleting the referenced users/schools, plus the
existing backup-retention process. Soft deletion is not proof of complete
destruction. Apply the executed agreement and WISP section 9.

## Rollout and rollback

Seating is an included ClassPilot capability governed by `MYDESK_MODE=on` and
`MYDESK_SEATING_MODE=on`. Both default off until operational preparation completes;
after activation every eligible current or future school receives it without
an admin toggle or school-ID configuration. Author privacy remains unchanged.

Follow [MYDESK_PRODUCTION_RELEASE.md](MYDESK_PRODUCTION_RELEASE.md) for the forward combined admission.
Preserve `mydesk-private-seating-20260925` and the earlier notebook checksum.
Do not downgrade to an M1-only artifact. Seating adds no attachment storage.
Disable only its mode to hide seating while notes remain available; preserve
charts, schema, RLS, bucket/IAM and cleanup. Perform the phone/desktop walkthrough
and Letter/A4 printing in production with synthetic records for destructive cases.

## Local verification — September 25, 2026

Verification used synthetic local schools and students, not production data.

- Full backend regression command: 2,568 passed, zero failures, three conditional
  skips. The separate seating HTTP suite passed all eight cases under both the
  ordinary database connection and a restricted, non-owner RLS role.
- Full restricted RLS lane: 146 passed, zero failures; its Redis availability
  skip was exercised successfully with isolated Redis in the full backend run.
  Existing notebook ownership and request-lifecycle cases also passed.
- Five seating schema behavior tests and sixteen registry/admission checks
  passed. Fresh Drizzle bootstrap plus canonical composite-FK repair, Terraform
  validation, two mocked plans, and SOC2 documentation checks passed.
- Seating frontend: fourteen tests passed (eight browser workflows and six
  model tests). Existing My Desk: fourteen tests passed. Router/dashboard
  regression checks, frontend lint (zero errors; existing warnings), backend
  typecheck/build, frontend production build, and preview smoke passed.
- Synthetic thirty-seat and hundred-seat charts produced single-page Letter
  and A4 PDFs. Rendered output was visually inspected; browser checks verified
  names remain inside desks and controls, locks, and private notes are excluded.
  Desktop and phone-size browser workflows passed.

Real Android verification was not performed in this historical check: no device was connected.
It is part of the operator's live production walkthrough.
No production migration, AWS provisioning, deployment, or flag activation was
performed in that historical check. It does not cover the later measured-room
expansion. Its additive migration, regression checks and new live device/printing
walkthrough are required before release; no predecessor downgrade is required.
