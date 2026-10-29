# Windows browser usage and reports

Windows browser history is retained metadata in `classpilot_windows_browser_events`.
It is independent of native desktop observation bytes. Only server-accepted full-mode
observations with browser focus contribute time, bounded by each observation's
`usage_ends_at` (at most ten seconds). Unfocused observations contribute no time.
These are estimates of monitored browser activity, not whole-device screen time.

The daily usage legacy writer and set-based candidate/upsert include Windows-only
students and merge overlapping Chrome/Edge intervals once per student. Within an
overlap, the most recent observation determines domain attribution; older activity
can resume for the remainder of its bounded interval. Daily boundaries clip time.
Full-mode observations without a class also contribute to student daily totals.
The existing Chromebook count-times-ten daily semantics remain unchanged. Historical
Windows metadata remains reportable after the runtime feature flag is turned off;
its admitted tables must therefore exist before deploying the API/worker code.

Each Windows interval is also clipped to its exact browser and guard lifetime;
another live browser or a later Chromebook sign-in cannot extend the old source's
tail. For mixed Chromebook/Windows days, the Windows contribution excludes the union
of the counted Chromebook heartbeats' forward ten-second slots. Existing Chromebook
totals, including duplicate heartbeat counts, are preserved. For example, a legacy
heartbeat at second 0 followed by Windows activity from second 5 to 15 contributes
15 seconds, not 20. Windows activity starting at second 0 whose guard ends at second
4, followed by a legacy heartbeat at second 4, contributes 14 seconds, not 20.
Only the Windows seconds are reduced; all valid observation counts are retained,
including a Windows observation whose entire duration overlaps a legacy slot.

Class reports, provisional class usage and supervision reports add authenticated
Windows browser lifetimes. Eligibility starts after both browser pairing and guard
creation, and ends at the earliest browser termination, guard termination, rolling
guard expiry, absolute guard expiry or report end. Overlapping browser lifetimes
are unioned. Windows observations use their explicit interval ends, without inheriting
the Chromebook sixty-second coverage tolerance or fifteen-second attribution limit.
Existing Chromebook-only report behavior and immutable report-version selection
remain unchanged.

The frozen v1 report retains its existing ten-second attribution for each legacy
sample and adds only Windows time outside those legacy slots. Report v2 and Monitored
Browser Time retain their existing student timeline attribution (at most fifteen
seconds per legacy observation, cut at the next observation); Windows interval ends
remain bounded by their own source lifetime. These metrics deliberately retain their
different historical Chromebook arithmetic rather than rewriting old report versions.

Windows class observations must match the exact teaching session or have no class
or supervision context within the authorized frozen roster/report window. This
retains scheduled-report coverage before live classroom control starts, while
excluding activity explicitly owned by another class or supervision context.
Supervision observations must match the exact supervision context. Existing roster capture,
participation, delegated supervision, tracking-hours and retention boundaries still
apply. Missing observations produce coverage gaps rather than inferred activity.

Reports read existing browser classification metadata and shared decision review
status. Browser screenshot evidence is reported available only for its exact
student, browser child identity and observation ID, using
`classpilot_windows_screenshot`. An overlapping sibling browser cannot supply the
artifact. This integration neither captures images nor invokes AI, and never reads
native desktop images or native observation caches.

Validation:

- `tests/classpilot-monitoring-reports.test.ts`: bounded overlap, short authority,
  exclusions and exact Chrome/Edge evidence correlation, alongside legacy coverage.
- `tests/daily-usage-rollup.test.ts`: legacy/domain merge behavior and existing
  scheduler, timezone, mode and metric checks.
- `tests/classpilot-windows-reporting.integration.test.ts`: production SQL against
  PostgreSQL transaction-local temporary fixtures, covering school/context scope,
  browser/guard lifetime bounds, interval union, mixed-owner handoffs in both
  directions, fully covered Windows samples, duplicate legacy samples, UTC day
  clipping and idempotent upsert. It also executes the production Monitored Browser
  Time read phase and checks that a live sibling cannot revive a closed source's
  observation. This tests query behavior; canonical table constraints and RLS policies
  are covered by the separate Windows integration/RLS suites.

The October 29, 2026 focused handoff validation passed 37 pure report/daily tests
and one transaction-local PostgreSQL integration test using the restricted local
fixture role. The integration test contains the interval, handoff, lifetime,
domain and persistence assertions described above; it is not a physical-device test.

No physical Windows lifecycle, signed deployment, managed browser installation or
production activation evidence is established by these reporting tests.
