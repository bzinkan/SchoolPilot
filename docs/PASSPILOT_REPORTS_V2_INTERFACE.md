# PassPilot Reports v2 staff interface

The Reports tab negotiates the default-off server Reports v2 capability. A
known disabled/missing v2 route retains the existing report. A failed authority
check renders an error; it cannot silently select another report scope.

V2 summaries come from server aggregates rather than rounded pass rows. The
interface separates completed overdue rate, currently overdue open passes,
cancellations and best-effort recorded denials. Null ratios/averages remain
unavailable. Coverage and no-data explanations accompany each summary;
school-local hourly issuance counts are explicitly separate from unavailable
historical bell-period attribution. Administrator override evidence requires
the current verified capability and is absent from office/teacher surfaces.

All date boundaries use the verified school timezone, including midnight gaps
and folds. Inclusive school dates become a half-open instant range, bounded by
the server's 366 elapsed-day limit. History classes retain canonical or legacy
filter identities; school managers can select historical issuers. Destination,
channel and a student selected from authorized historical rows share identical
filters across the summary, paginated history and exports.

History pages use the server cursor and expose Load more until complete.
Malformed/nonadvancing pagination fails visibly. CSV downloads use the audited
server endpoint; no client row aggregation or truncated export is substituted.
The 10,000-row server limit and audit errors appear as failures without a
partial download. Row notes, private appointment notes and nonadministrator
encounter metadata are never rendered. Appointment outcomes use the server
matured-window denominator and explain current-roster attribution.

Queries are keyed by school, viewer, auth version and roles. Requests carry an
explicit school and canonical class-contract header. Context changes unmount
the interface, abort pending downloads and remove private report cache. Known
authority failure immediately removes summary/rows and disables further work.

Validation: five date/filter/pagination model tests and seven actual Chromium
interface tests cover DST, separate overdue metrics, privacy, complete pages,
shared export filters, no truncated export, late previous-school responses,
capability denial, actual adapter auth-version changes during held export,
snapshot conflict recovery and 390px containment. Mobile and desktop screenshots are
reviewed. These synthetic checks do not verify production activation or data.
