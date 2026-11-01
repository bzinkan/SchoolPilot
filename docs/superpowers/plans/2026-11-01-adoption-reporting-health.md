# Adoption & Reporting Health Implementation Plan

Approved source: the implementation plan supplied in this chat on November 1, 2026, and the revised dark admin mockup.

Goal: replace Analytics with completed-session adoption, confirmed summary-generation failures, and neutral expandable reporting availability. Keep the URL and legacy analytics contracts. No new telemetry, tables, report-generation changes, runtime flags, extension release, or deployment.

## Tasks

- [x] Add school-scoped aggregation and the five read-only adoption-health endpoints; prove counts, weighted coverage, retention, pagination, permissions, and tenant isolation against the local database.
- [x] Replace the page, share the school-local date filter, lazy-load optional sections, scope caches to school/viewer, reuse authorized report drill-downs, and rename navigation.
- [ ] Complete browser regression coverage, builds/type checks, focused database/RLS checks, documentation, and independent code review.

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
