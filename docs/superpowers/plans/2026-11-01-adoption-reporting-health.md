# Adoption & Reporting Health Implementation Plan

Approved source: the implementation plan supplied in this chat on November 1, 2026, and the revised dark admin mockup.

Goal: replace Analytics with completed-session adoption, confirmed summary-generation failures, and neutral expandable reporting availability. Keep the URL and legacy analytics contracts. No new telemetry, tables, report-generation changes, runtime flags, extension release, or deployment.

## Tasks

- [x] Add school-scoped aggregation and the five read-only adoption-health endpoints; prove counts, weighted coverage, retention, pagination, permissions, and tenant isolation against the local database.
- [x] Replace the page, share the school-local date filter, lazy-load optional sections, scope caches to school/viewer, reuse authorized report drill-downs, and rename navigation.
- [x] Complete browser regression coverage, builds/type checks, focused database/RLS checks, documentation, and independent code review.

## Contracts and defaults

- Today / Last 7 days / Last 30 days; default Last 7 days. Completed sessions are selected by end time in the school-local range. Skip unfinished and skipped occurrences.
- Adoption uses current active official classes and stored ready-summary observations, never current roster membership to reattribute history. Health includes retained school-wide class summaries, including archived classes.
- Needs attention uses only unexpired generation reports in terminal failed state. Retrying, pending, absent, expired, email-delivery failures, and missing observations do not qualify.
- Count unique observed students and primary live-session teachers. Scheduled reports do not establish teacher use. Count commands once, not once per target. Versions describe observed clients, not inventory.
- Coverage is sum(observed seconds) / sum(eligible seconds) from ready reports. Missing, unavailable, and tracking-not-expected remain distinct. No data/request failure may turn into a healthy zero.
- Initial reads: overview and failures. Availability, tools, and clients load on expansion. Failure pages contain 20 items, newest first.
- Reuse existing tenant context, entitlement, and administrator gates. No internal device/session binding identifiers or raw errors leave the new API.

## Validation

Test real SQL against an isolated local fixture database, including restricted RLS reads and HTTP authorization. Test the rendered React page for lazy reads, errors, neutral gaps, period changes, school/viewer changes, pagination, dialogs, keyboard interaction, and narrow widths. Run backend build/type checks and focused legacy regressions; run frontend analytics/admin-shell/session-summary suites and production build. Review the complete diff before handoff.

## Review and implementation decisions

- Work happens on `codex/adoption-reporting-health-impl` in a separate checkout because the original workspace has unrelated edits. The worktree automation skills were unavailable, so native Git provides isolation. Cost: review and integration must use this branch/checkout.
- When retention leaves no usable ready summaries, observation counts are unavailable rather than zero. Cost: fewer numeric metrics until retained evidence exists.
- The local database template had RLS disabled. Restricted tests install the existing production policy SQL and force RLS in the disposable fixture database. No application policy or schema changes. Cost: the local test proof depends on that explicit fixture bootstrap.
- Independent review found duplicate primary staff snapshots, midnight-crossing observations, current-device dependence in historical client counts, and expired failures stranding pagination. Each was reproduced before correction and verified with passing database/browser regressions. Pagination was re-graded Important because expiry could remove backward navigation.
- Adoption reads immutable student report observations, independent of legacy usage cleanup. Completed sessions and recorded days use school-local session end dates; observations before midnight remain part of their selected completed summary.
- Production-scale query latency was not benchmarked without representative data. Heartbeat reads are bounded by frozen student membership, completed windows, and retention with existing indexes. Cost: unusually large schools may require later tuning.
- Existing, explicitly requested CSV downloads can finish after their dialog closes. Page and dialog reads are identity-scoped and aborted. Cost: closing the dialog does not cancel an export already requested.
- Deployment, extension publication, and report-writer changes remain outside this implementation. Cost: the replacement page is not live until a separately authorized release; deploy the additive API before the web app.

## Verification record

- New plus legacy SQL/HTTP/summary-authorization tests: 48 passed.
- New tests under a restricted application role and forced RLS: 13 passed.
- Analytics rendered-browser test: passed, covering requests, lazy panels, school/viewer/role changes, period resets, neutral missing observations, dialogs, expiring pagination, keyboard controls, errors, and mobile widths down to 320 px.
- Admin-shell suite: 19 passed. Session-summary/lifecycle suite: 4 passed.
- Backend no-emit check and build, frontend production build, and unsafe test-cast ratchet passed. The existing frontend Dashboard chunk-size warning remains.
- Full backend unit lane: 3,321 passed, 5 skipped, zero failures. The initial Windows checkout caused fixed-source hash checks to fail; restoring canonical LF bytes for otherwise unchanged dependencies resolved them without changing source or checksum expectations.
- Final test-type ratchet: passed with 436/534 allowed existing test diagnostics; the new tests add no debt, and application source/syntax have zero errors. `git diff --check` passed.

All requested implementation work is complete. No deferred review findings remain. The release has not been deployed, pushed, or merged.
