# PassPilot school-year setup

PassPilot-only schools configure the canonical school-year dates through
`/api/passpilot/school-year`; they do not need a ClassPilot license. This narrow
setup contract is available while appointments are off, so an administrator can
configure retention boundaries before activating the appointment feature.

Current `admin`, `school_admin` and `super_admin` authority plus an active school
and PassPilot entitlement are required. The save transaction rechecks current
membership, authentication version and entitlement under the shared lifecycle
lock. Teachers, office staff and GoPilot-only profiles cannot configure the year.

| Method | Contract |
| --- | --- |
| GET `/` | Only yearStart, yearEnd, revision, server-owned schoolTimezone and schoolLocalToday. |
| POST `/preview` | Exactly yearStart/yearEnd date strings. Returns current revision, previewToken, changedOccurrences and canonical blockers. |
| PUT `/` | Those dates plus expectedRevision and previewToken. Rejects stale or changed previews. |

Both dates must be valid and ordered within the existing canonical 550-day bound.
This interface cannot clear the year or accept a caller's timezone, school ID,
roles, calendar overrides, cycle settings, bell profiles or applied profiles.
Every remaining canonical configuration field is preserved. Existing ClassPilot
scheduling routes retain their ClassPilot entitlement requirement.

The writer reuses the canonical preview, blocking checks and pending schedule-
change supersession workflow. The canonical config/revision and the strict
`passpilot.school_year.updated` audit commit together; an audit failure rolls back
the save. No new schema, tenant table, RLS admission or runtime flag is introduced.

This is the server setup slice. Role-gated PassPilot interface controls ship with
the appointment UI slice. Appointment activation also depends on the separate
attendance/dismissal eligibility-race correction; keep the feature off until both
dependencies are reviewed and serving on API and worker.
