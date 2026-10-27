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
applies a Flight Path. Opening never requests Focus, a Waypoint or a screen
lock, and does not depend on precise-resource or Focus capabilities.

Existing teacher restrictions still apply. Opening does not automatically
allow a domain or clear a restriction. Teachers can separately use Focus,
Waypoint and Flight Path controls when they want restrictions. Teaching tools
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

The legacy helper and backend prerequisite APIs remain compatible but are not
reachable from the assignment picker. This UI simplification and the Stop Focus
payload repair require a SchoolPilot API/web release, with no extension change
or capability activation. Local browser checks do not establish managed
Chromebook acceptance or production deployment.
