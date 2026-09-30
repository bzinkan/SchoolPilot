# PassPilot Reports v2 contract

Reports v2 reads retained pass, best-effort denial and appointment records. It
does not create student labels, disciplinary conclusions, new retention periods
or another source of truth. `PASSPILOT_REPORTS_MODE=off|v2` defaults off. Version 2
requires RLS request binding and the complete preserved 128-table admission. The
governed product runtime setter verifies the serving source contract before
activation; this change performs no production activation.

## Authority and filters

All endpoints under `/api/passpilot/reports` use authenticated current school
context, active PassPilot entitlement, current staff membership/auth version and
the established canonical-class capability header. Managers see school scope;
teachers use the existing pass-history scope, including their own historical
issuance and currently authorized class-attributed history. Appointment metrics
use current student/class access only. No GoPilot role inheritance is accepted.
Every response is `no-store`.

`GET /capabilities` returns `{ enabled: true, version: 2, schoolTimezone,
scope: "school" | "teacher_history", administratorEvidence: boolean,
appointmentsAvailable: true }`. Administrator evidence requires the verified
`admin`, `school_admin` or `super_admin` role. Office staff and teachers cannot
request encounter identifiers, rule-type/relationship filters or raw denial
details. Their override metric is always null, regardless of hidden row content.
Their denial metric is only the generic number of recorded denials, including
recorded override attempts; no rule identifiers or breakdown are returned.

Summary, pass pagination and CSV share exact filters: required offset-bearing
`from` inclusive and `through` exclusive, positive range at most 366 elapsed days;
optional `studentId`, `classId` or `gradeId` (mutually exclusive), `teacherId`,
`destination` and `issuedVia=teacher|kiosk`. Teachers may filter an issuer only to
themselves. Identifiers remain school scoped and are authorization checked. No
caller timezone, school ID, role, rule code or relationship filter is accepted.

## Summary

`GET /summary` returns this exact shape (illustrative values for an office viewer):

```json
{
  "version": 2,
  "asOf": "2026-09-30T16:00:00.000Z",
  "schoolTimezone": "America/New_York",
  "scope": "school",
  "range": { "from": "2026-09-30T04:00:00.000Z", "through": "2026-10-01T04:00:00.000Z" },
  "counts": { "total": 6, "active": 2, "returned": 3, "canceled": 1, "historicalExpired": 0, "other": 0 },
  "completedDuration": { "count": 3, "totalSeconds": 900, "averageSeconds": 300, "invalidCompletedCount": 0 },
  "completedOverdueRate": { "numerator": 1, "denominator": 3, "ratio": 0.3333333333333333 },
  "openCount": 2,
  "currentlyOverdueCount": 1,
  "destinations": [{ "destination": "office", "count": 6 }],
  "periods": { "kind": "school_local_hour", "basis": "current_school_timezone", "buckets": [{ "hour": 9, "label": "09:00–09:59", "count": 6 }] },
  "recordedDenials": { "count": 4, "coverage": "best_effort", "includesRecordedOverrideAttempts": true },
  "overrides": null,
  "appointments": { "total": 6, "scheduled": 2, "activated": 1, "completed": 1, "cancelled": 1, "missed": 1, "futureWindowCount": 2, "maturedWindowCount": 3, "missedRate": { "numerator": 1, "denominator": 3, "ratio": 0.3333333333333333 }, "attribution": "current_student_roster" },
  "coverage": { "state": "partial", "codes": ["RECORDED_DENIALS_BEST_EFFORT", "HISTORICAL_BELL_PERIODS_UNAVAILABLE"], "administratorEvidence": false }
}
```

An authorized administrator additionally receives `overrides: { count,
byRule: [{ ruleCode, count }] }`, based on durable pass override columns. Counts
and breakdown use the same selected pass cohort; no student-pair identifiers or
private reason text are included. The evidence permission is based on current
authority, including when Rules is off, rather than untrusted projection options.

- Pass cohort: records issued within `[from, through)` and all selected filters.
  Counts include canceled and legacy expired rows, with statuses separately named.
- Completed duration: only returned passes with `returnedAt >= issuedAt`.
  Open, canceled and historical expired passes are excluded. Mean is null when
  count is zero; invalid completed timestamps are explicitly counted.
- Completed overdue rate: valid returned passes whose return exceeds their valid
  deadline, divided by valid returned passes with `expiresAt >= issuedAt`.
  Active passes never enter this denominator. Ratio is null for no eligible data.
- Open/overdue: active passes in the issuance cohort, with currently overdue
  counted only where the valid deadline has passed at `asOf`. No status changes.
- Destinations and periods: issuance counts, ordered by count then stable key.
  Periods are explicitly school-local hourly buckets in the current timezone;
  historical bell-period attribution is unavailable because it was not captured.
- Denials: recorded rows denied within `[from, through)` and the equivalent
  attributed history scope/filters. Persistence is best effort, so this is not
  a denial rate and must not imply all attempted issuance was recorded.
- Appointments: windows starting within `[from, through)`, current student access,
  student/destination and current roster class filters. Ended pending windows
  project as missed. Future or still-open windows and canceled appointments are
  excluded from the outcome denominator. `maturedWindowCount` is ended,
  non-canceled windows; missed divided by that count is null when it is zero.
  Issuer/channel filters cannot describe unactivated appointments: those filters
  return `appointments: null` and `APPOINTMENT_FILTER_UNAVAILABLE` coverage.
- No data: zero cohort counts retain nullable averages/ratios and
  `coverage.state="no_data"`. Coverage otherwise states known partial sources,
  including best-effort denials, missing historical bell snapshots and invalid
  legacy completed/deadline values. Absence of records does not prove no event.

## Pass views and CSV

`GET /passes` adds `limit=1..100` (default 50) and opaque keyset `cursor` to the
shared filters. It returns `{ version: 2, asOf, schoolTimezone, passes,
nextCursor, hasMore }`. Rows contain id, studentId/studentName, teacherId/teacherName,
classId/className, destination/customDestination, issuedVia, status, issuedAt,
expiresAt, returnedAt, completedDurationSeconds, currentlyOverdue and permitted
ruleOverrideCode. Pass notes and private appointment notes are omitted. Nonadmin
rows always omit encounter override metadata. Cursors bind filter and current
viewer/school scope; changed filters or cross-viewer cursors are rejected.

`GET /export.csv` shares filters and adds `kind=passes|summary`. Pass exports cap
at 10,000 rows; larger cohorts return 409 `PASSPILOT_REPORT_EXPORT_LIMIT` before
any file/audit rather than truncate. Summary CSV includes metric numerators,
denominators and coverage. String fields are quoted and spreadsheet formulas
neutralized. A strict, content-free same-transaction
`passpilot.report.exported` audit must commit before the response is sent; audit
failure returns an error. The audit records scope, kind, bounded range, filter
keys and row count, never CSV content, notes or confidential relationship data.
Existing retained tables and student-deletion cascades remain authoritative.
