# Google Classroom staff quick actions

Source implementation and synthetic browser acceptance are separate from
production activation and managed Chromebook acceptance.

The Dashboard picker uses the existing teacher-owned Classroom connection,
courses and paginated assignment/material resources. It adds no roster import
or Google access scope. The current class, subgroup or claimed-student
selection resolves to explicit student IDs, displayed before issuance. School,
viewer, activity or context revision changes retire the picker and abort status
reads. Later selection changes do not add recipients to the frozen list; no
missing-target broadcast is issued.

## Open assignment

The picker has one action: **Open assignment**. It sends the chosen
assignment/material link as `open-tab { url }`, using the same command as
Open URL. Selecting a course, assignment or link never previews, creates or
applies a Flight Path. Opening never requests Focus or a screen lock, and does
not depend on precise-resource or exact-tab capabilities.

Existing teacher restrictions still apply. Opening does not automatically
allow a domain or clear a restriction. Teachers can separately use Focus for an
approved website or resource, or apply a Flight Path. Bring Forward activates
an existing exact tab once without starting Focus. Teaching tools
retains the explicit Create Flight Path from Classroom authoring flow.

The picker polls each issued command's authorized status and shows each
student's open result. Received and pending commands remain unconfirmed;
failed, unavailable and expired results remain visible. A change in student
availability requires another explicit gesture before sending to a subset.
Closing aborts status reads; already issued commands remain in activity history.

## Verification and release dependencies

The model suite covers unsafe links, explicit target envelopes, pending
acknowledgements and authority retirement. Actual Vite/Playwright cases cover
open-only requests, per-student results, frozen and unavailable recipients,
duplicate gestures, mobile dialog containment, capability-independent opening
and held responses. Both suites run in existing frontend CI lanes.

The restricted-role API integration suite retains the legacy lesson
orchestrator contract against canonical preview, reviewed reuse, command issuance and
exact status HTTP routes. Authenticated synthetic per-recipient acknowledgements
confirm only one student, proving that the actual timestamp pin and source
prerequisite survive the combined interface and that the failed student is not
opened. This local contract check preserves public DTO privacy; it does not
replace packaged extension or managed-device acceptance.

The legacy lesson helper and backend prerequisite APIs remain separate from
the assignment picker. New teacher requests cannot create the retired
foreground-tab Focus or request its `open-tab` continuation; legacy status and
cleanup remain compatible. The teacher-facing Focus destination restriction
uses the existing screen-lock protocol. These API/web changes require no
extension update or capability activation. The extension's existing Waypoint
notification wording is a separate release concern. Local browser checks do
not establish managed Chromebook acceptance or production deployment.
