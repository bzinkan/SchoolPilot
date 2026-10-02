# Google Classroom staff quick actions

Source implementation and synthetic browser acceptance are separate from
production activation and managed Chromebook acceptance.

The Dashboard picker uses the existing teacher-owned Classroom connection,
courses and paginated assignment/material resources. It adds no roster import
or Google access scope. The current class, subgroup or claimed-student
selection resolves to explicit student IDs, displayed before issuance. School,
viewer, activity, context revision or selection changes retire the picker and
abort status/review reads; no missing-target broadcast is issued.

## Actions

- **Open** sends the chosen assignment/material browser link under existing
  browsing restrictions. It does not automatically allow a domain.
- **Open + Focus** requests `focusAfterOpen` on the student-scoped open command.
  The server derives the exact Focus target from each validated successful
  open acknowledgement. A server-created continuation is displayed as pending
  until its own browser confirmation. Refusal never searches for another tab
  by URL. At least one selected student must have accepted the negotiated
  scoped-authority and Focus capabilities; mixed outcomes remain per student.
- **Open as Lesson** requires precise mode and an explicit normalized scope
  review. Resource/Section is the initial boundary; Website is a conscious
  broader choice with warnings. A link or boundary edit invalidates the review.
  Only reviewed resources are saved. Original provenance contains IDs, with no
  unreviewed links merged back into the policy. A reviewed-source reuse request
  prevents repeated actions from creating duplicate personal Flight Paths.
  The returned policy must match the review, including no extra domains or
  blocks. Website starts retain the selected assignment URL inside its reviewed
  hostname; precise starts use the canonical reviewed resource.

Lesson application pins the Flight Path's public `updatedAt` instant through
`expectedFlightPathUpdatedAt`. The picker polls the exact authorized source
command, independently of the recent-command history limit. Each dependent
open carries `afterRestrictionCommandId`; the server atomically rechecks that
student's applied acknowledgement, exact binding, current desired state and
current authority. Only a completed target with `result.outcome = applied`
qualifies for a dependent open. Failed, missing, unsupported and timed-out
targets are not opened. Lesson mode permits movement among reviewed resources
and does not request Focus.

Closing stops browser waiting and aborts future UI continuations. Already issued
commands and any successfully applied Flight Path remain in activity history;
closing does not pretend to undo a delivered restriction.

## Verification and release dependencies

The model suite covers unsafe links, reviewed-policy equality, explicit target
envelopes, partial application, pending acknowledgements, exact source IDs,
Focus continuation/refusal and authority retirement. Actual Vite/Playwright
cases cover the picker, per-student results, normalized boundaries, Website
warnings, mobile dialog containment, mode-off behavior and held responses.
Both suites run in existing frontend CI lanes.

The restricted-role API integration suite also runs the real UI lesson
orchestrator against canonical preview, reviewed reuse, command issuance and
exact status HTTP routes. Authenticated synthetic per-recipient acknowledgements
confirm only one student, proving that the actual timestamp pin and source
prerequisite survive the combined interface and that the failed student is not
opened. This local contract check preserves public DTO privacy; it does not
replace packaged extension or managed-device acceptance.

Required source prerequisites: precise previews/authoring, Focus command and
teacher-control contracts, and the Classroom command prerequisite/status and
reviewed-source reuse API. Keep runtime capabilities default off. Packaged
ClassPilot precise/Focus checks and two managed Chromebook results are required
before activation; these browser fixtures do not satisfy that device gate.
