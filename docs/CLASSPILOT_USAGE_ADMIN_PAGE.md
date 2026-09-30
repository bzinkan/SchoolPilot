# Monitored Browser Time administrator page

The Reports navigation opens `/classpilot/admin/usage`. It consumes the existing coverage-version-1 Digital Usage API from the corrected reporting backend; the collection cadence, daily analytics and rollup worker are unchanged. A pre-ledger response without coverage metadata is withheld.

Administrators select school, grade, official class or student, then Today, Last 7 days, Last 30 days or an ordered custom range of at most 366 school calendar days. Presets use the active school's timezone, including DST and midnight rollover. Grade choices include configured empty grades and current roster grades; grade reporting uses current student grades. Official-class attribution comes from the frozen teaching-session roster. Supervision observations have no official-class attribution.

Totals, distinct observed-student counts, instructional/off-task/unknown categories and top educational/non-educational sites use only computed days. Observed students are not an enrollment denominator. Unknown remains separate; teacher-approved activity is excluded from off-task time. Browser observations do not measure total device time, engagement or learning.

Coverage, partial retention, first retained/first computed dates and computation timestamps accompany the report. A completed empty day shows zero and “No browser activity observed.” Unavailable, expired and future days show a dash in the daily table and a gap in the chart. Empty computations and holes remain distinct even when they occur between non-empty days. The daily table supplies the chart's accessible data and can scroll by keyboard on narrow screens. Final/live labels describe the backend's computation state, not student presence.

Export uses authenticated `GET /api/classpilot/admin/usage?format=csv` with the same scope/date selection and explicit school header. The existing server audit and formula-safe CSV contract remain authoritative. Export is disabled when no computed report is available. Errors do not substitute zero totals or generate local partial exports.

Every report and directory cache includes the school/viewer identity. Reads consume cancellation signals; school or role changes unmount the old page and reset selectors. Export cancels on identity, filter changes or unmount, so delayed old-school responses cannot produce a download in the new school. Teacher/office roles render an access message without issuing report or directory requests; server authorization remains the enforcement boundary.

## Focused evidence

`npm run test:digital-usage` in `schoolpilot-app` runs six model and seven actual-component Playwright browser tests using synthetic API responses. The browser fixture mounts the real administrator shell, page, queries and authenticated HTTP client. It verifies canonical scope IDs and headers, no missing-selection fallback, school-time dates/DST, invalid custom ranges, internal holes, successful empty computations, final/live state, feature off, error/retry, export failure, old coverage refusal, teacher/office denial, role loss and delayed old-school reads. Desktop 1440px and mobile 390px screenshots were visually reviewed; the mobile document has no horizontal overflow. Browser fixtures do not claim authenticated backend end-to-end or production verification.

The existing administrator navigation/browser suite checks the new Reports destination against the registered App route. Frontend lint and production build pass, with the existing 32 lint warnings and no new warning from the page. The page is a lazy-loaded route and uses the existing components without an additional chart dependency.

## Release safety record

| Item | Result |
|---|---|
| 1. Change | Dedicated administrator browser-time page, navigation and focused regressions |
| 2. Backend | Existing Digital Usage API; coverage correction required |
| 3. Frontend | App route, Reports entry, page and small model |
| 4. Schema/migrations | None in this slice; prerequisite completion ledger remains additive |
| 5. RLS | No inventory or policy changes; both existing usage tables must be admitted |
| 6. Tenant boundary | Explicit school header, school/viewer query keys and cancellable requests |
| 7. Roles | Administrators; teacher/office UI makes no reporting requests |
| 8. Capabilities/extension | None; no extension release required |
| 9. Flags | Existing Digital Usage mode; feature-off 404 shows availability message |
| 10. Collection | No change to cadence, heartbeat contents or classification |
| 11. Data quality | Empty computations, gaps, retention and final/live metadata remain distinct |
| 12. Export | Existing audited formula-safe server CSV, same selected scope/date range |
| 13. Automated tests | Six model and seven browser tests, plus administrator navigation regressions |
| 14. Build/lint | Frontend build/lint pass; 32 existing warnings |
| 15. Browser | Synthetic real-component desktop/mobile verification; screenshots reviewed |
| 16. Load | Separate local synthetic million-heartbeat slice; not established by UI fixtures |
| 17. Manual evidence | Actual administrator API walkthrough and production observations remain pending |
| 18. Deployment order | Compatible corrected backend before frontend; no deployment performed here |
| 19. Activation | Governed setter only, after daily shadow and new-rollup observation gates in the existing runbooks |
| 20. Rollback/legacy | Frontend can roll back independently; preserve corrected backend/ledger and its rollback gates. No Live View/TURN dependency |

Production deployment, flag activation and full CI remain separate evidence. This page does not satisfy the three clean shadow school days or the subsequent new-usage one-school-day observation gate.
