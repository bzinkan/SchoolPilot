# Reviewed precise authoring interfaces

The Teaching tools Flight Path editor, Classroom import dialog and Dashboard
Waypoint dialog use the authenticated, tenant-scoped
`POST /classpilot/flight-paths/preview-resources` endpoint from the precise
restriction preview API. This change adds authoring interfaces only; the
preview API, schema, runtime admission and extension release remain separate.

## Save contract

- Flight Paths with precise entries require a successful scope review before
  saving. The submitted allowed domains and resource URLs come from the
  response's canonical `authoring` fields. Website-only editing retains its
  existing direct save flow, with scope review available for host warnings.
- Classroom imports offer Website and, when enabled, Resource boundaries.
  Every import requires review. Creation sends the reviewed canonical
  `resourceLinks` and boundary, selected IDs and ID-only provenance objects;
  it never combines those links with the original Classroom link inputs.
  Unusable links are counted and listed in the review. An empty result cannot
  be created.
- When precise authoring is enabled, a specific Waypoint URL requires review
  for either boundary and uses the canonical returned URL. Its command still
  uses the existing exact student target and classroom authority contract.
  Reviewing sends no student command. Current-page Waypoints keep their
  existing per-student behavior and describe that each student's website may
  differ.
- A review is discarded after draft edits, boundary or selection changes,
  school/viewer changes, feature changes, closing a dialog or changed
  classroom authority. Late responses are aborted and cannot restore it.
  Undoing an edit does not restore a prior review. Errors keep required
  review saves disabled and allow an explicit retry.
- Section means the normalized path and paths below it, rather than an exact
  single page. Entire websites display broader-access warnings. The Google
  domain help identifies YouTube as a separate website.
- With precise authoring disabled, Resource choices remain hidden, retained
  Flight Path resources survive a metadata edit through omission from the
  PATCH, and the established website/current-page command behavior remains.

## Local acceptance, September 30, 2026

Base: precise restriction previews commit `16162e06`. Tests use synthetic
browser fixtures with the actual React components and API client; no
production school or Google account was accessed.

From `schoolpilot-app`:

```powershell
node --test --test-concurrency=1 scripts/teaching-tools-browser.test.mjs scripts/teaching-tools-library.test.mjs
node --test --test-name-pattern='precise Waypoint review' scripts/classpilot-dashboard-load-state.test.mjs
node --test scripts/classpilot-dashboard-isolation.test.mjs scripts/classpilot-read-recovery.test.mjs scripts/restriction-resource-matcher.test.mjs scripts/classpilot-command-context.test.mjs
npm run lint
npm run build
```

- Teaching tools and library: 22 passing tests. Browser coverage verifies
  canonical short-link replacement, broader website warnings, edit/undo
  invalidation, retry after errors, pending response cancellation, school
  changes, Classroom boundaries and selection invalidation, skipped items,
  ID-only creation provenance and feature-off retained-resource edits.
- Actual Dashboard Waypoint regression: one passing test. The final command
  contains the reviewed Google Form URL, Resource boundary and exact selected
  student ID, with no original short link. Boundary edits invalidate review;
  Resource help does not claim website-wide access.
- Authority/cache/resource/command regression suites: 73 passing tests.
- Frontend lint: no errors, the existing 32 warnings. Frontend build passes.
  Source and standard post-build router reachability audits also pass.
- Desktop Flight Path and Waypoint reviews and the 390-pixel Classroom import
  dialog were captured and visually inspected. Mobile document width remains
  within the viewport. Long dialogs scroll to the review and save controls.

Local screenshots and test logs are under the operator's temporary directory,
with screenshots in `schoolpilot-precise-scopes`. They contain synthetic data
and are not product assets. Broader frontend release shards are left to the
stack's required CI. These checks do not verify a deployed negotiated school,
an actual Google Classroom connection, a managed Chromebook or Chrome Web
Store release; those rollout gates remain open.
