# My Desk redesign: implementation and local verification

Implementation branch: `codex/my-desk-redesign`, based on
`9573f0eb9ac2497894edd96eb6507462990f4de8`.

This report covers the personal Notes/shared Discipline/shared Student information
redesign. It supersedes the preceding workspace verification report for this
release. Results are local checks with synthetic fixtures, not remote CI or
production acceptance. No push, merge, deployment, provider request, or production
data mutation was performed for this implementation.

## Review the implementation in three areas

1. **Navigation and grade filing.** Four teacher tabs; remembered grade/class
   preference; direct grade notes and student notes without a required class;
   historical filing snapshots and legacy private-history links. The seating
   library accepts the shared filter, while its editor, room geometry, assignment
   logic and printing remain unchanged. Start with `mydeskGradeFilingMigration`,
   `mydesk.ts`, `mydeskGrade.ts`, `MyDeskScopePicker`, Notes and the teacher guide.
2. **Shared discipline.** Current official teaching assignments authorize student
   records; active school administrators have automatic access. Student summaries,
   direct manual incidents, independent evidence, reasoned corrections and
   withdrawals replace author/grant-based school-record access. Paperwork imports
   have immutable destinations, explicit duplicate decisions and atomic direct
   publication. Start with `sharedStudentRecords.ts`, `schoolDisciplineWorkspace.ts`,
   the discipline/import migrations and the Discipline records page.
3. **Student information.** Shared contact profiles and immutable reviewed history;
   one profile editor in My Desk and the administrator student profile; private
   resumable imports from PDF, supported photos, DOCX, XLSX and CSV. Reviewed
   changes save atomically and temporary source material is durably cleaned up.
   Start with `studentInformationRedesignMigration.ts`, the `studentInformation*`
   services, routes, components and [Student information operations](STUDENT_INFORMATION.md).

Shared-record access is rechecked for directories, totals, versions, mutations,
exports, receipts and evidence. Roster/membership changes trigger school-scoped
refresh signals; identity changes and denied access clear shared editors and
previews. These signals contain identifiers only. Private historical notebooks
and seating retain their ownership boundary.

## Local verification

| Check | Result |
| --- | --- |
| Backend and frontend production builds | Passed |
| Frontend lint | Passed: zero errors; 33 existing warnings |
| API routing, router source and built-bundle reachability | Passed; router tests 15/15 |
| Backend unit lane | 1,063 passed; four existing skips; zero failures |
| Full ordinary database regression lane | 1,098 passed, five skips, one fixture failure; corrected fixture passed with all 27 import tests on focused rerun |
| Final restricted workspace checks | 69 passed, one rollback-fixture failure; corrected fixture passed with all 16 notebook/core tests on focused restricted rerun |
| Contact integration | 10/10 ordinary and 10/10 restricted |
| Staff/student lifecycle | 27/27; final student-move notification regression run 7/7 |
| Full My Desk browser/model run | 42/43; corrected asynchronous test assertion passed with all five workspace browser tests on focused rerun |
| Seating browser/model and print regressions | 23/23 |
| Paperwork import browser/model tests | 13/13 |
| Contact extraction/parser/evaluation harness | 9/9 with synthetic, injected results; no live-model accuracy claim |
| Dashboard isolation regressions | 33/33 |
| Full infrastructure lane | 583/584; updated current-inventory fixture passed with all 16 admission tests on focused rerun |
| Runtime configuration / Terraform mock checks | 106 runtime assertions and eight mocked plans passed |
| SOC 2 governance and focused evidence checks | Passed with existing human-approval/evidence caveats |
| Test TypeScript ratchet | Passed: 439 existing test-only diagnostics against the 534 baseline; no new debt or application/syntax errors |
| Unsafe test-cast ratchet and patch whitespace | Passed without increasing the baseline |

The initial broad-lane failures above were corrected and their affected suites
rerun. The full database, infrastructure and browser lanes were not repeated after
those focused closures. Existing historical migration SQL/checksums were not edited.
The test TypeScript ratchet and application builds pass without increasing the
existing test-only baseline.

## Database and release handoff

Four additive migrations extend grade filing, discipline structures, import
destinations and contact storage. The five new contact tables are registered in
bootstrap, RLS, CI inventories and the exact reviewed `studentInformation`
admission bundle. They expand the historical 114-table release inventory to 119.
The Terraform production baseline remains the previously verified 109-table
baseline; editing a target inventory does not establish live admission.

Follow [the production release runbook](MYDESK_PRODUCTION_RELEASE.md): verify the
serving release and live catalog/ledger/RLS state, deploy compatible backend and
cleanup workers with the reviewed admission, then deploy the matching frontend.
Adopt a subsequently verified live allowlist through a separate reviewed change.
Do not restore older code that grants a former teacher shared-record access or
misinterprets new note/incident versions.

Manual workflows can release independently. Keep paperwork AI and
`STUDENT_INFORMATION_AI_IMPORT_MODE` off until each has its own provider/data-flow
review, fixed-model/prompt evaluation and isolated production-image capacity
evidence. The repository includes a 100-profile synthetic contact fixture pack
and scorer, but its injected automated results do not satisfy actual provider
quality acceptance. No student paperwork was sent to a provider during this work.

Remaining acceptance includes remote CI against the release commit, the signed-in
production walkthrough, real Android camera/touch/account-switch checks, physical
Letter/A4 print review, and verification of object cleanup in the serving worker.
The documented actual-model quality and production-image capacity thresholds
remain required before enabling either AI flow.
