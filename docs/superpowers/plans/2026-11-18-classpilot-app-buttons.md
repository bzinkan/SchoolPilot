# ClassPilot App Buttons Implementation Plan

Approved app-button scope: common apps, personal websites and favorites, and administrator-managed school buttons. Automatic Clever discovery remains a follow-up.

## Behavior

Teachers choose a button instead of typing an address in Open URL, current website/resource Focus, or Flight Path authoring. Choosing a button sends no classroom command. Existing recipient review, restriction previews, Classroom student-access checks and explicit confirmation remain authoritative.

The common catalog includes Classroom, its Google work bundle, Docs, Slides, Sheets, Forms, Drive, IXL and Quill. Current main expands Classroom website access to its fixed Google work sites; buttons display that effective access. Individual Google tools launch their own product homes, with the shared Google Docs website scope clearly described. Existing school blocks, sign-in policies and browser capability checks still apply.

Teachers save a custom website with name and URL, manage its definition privately, add common/school apps to My Apps, and star favorites. Removing from My Apps clears favorite without deleting a personal definition. Administrators maintain school definitions; other staff may use but cannot modify them. A stale edit/delete is rejected by revision and retains the draft/confirmation for review. Support impersonation cannot access either API records or cached private app data.

Flight Path selection appends deduplicated domains explicitly and retains manual entries and precise resources. Saved Flight Paths copy selections; changing or deleting a button cannot silently alter saved or active browsing rules. Manual URL/domain entry remains usable on library failure. Icons use bundled graphics or initials without external fetching.

## Implementation

- Shared picker, scoped query hook, personal and school management, and integration into current Open URL/Focus/Flight Path fields.
- School-scoped classpilot_app_buttons definitions and classpilot_app_button_preferences. Strict verified-owner/admin writes, current entitlement/membership rechecks under lifecycle locks, optimistic revisions, private preferences, atomic identifier-only school audits.
- Authenticated /api/classpilot/apps GET/POST, revision-checked PATCH/DELETE and per-viewer PUT preferences.
- Additive classpilot-apps-20261118 ledger migration and forced tenant RLS. The two-table classpilotApps bundle chains after the immutable 140-table candidate inventory, creating the 142-table source/CI target. Existing live admission is preserved and expanded only by the two app tables.
- Generated teacher/admin guides, updated screenshots and test/release-gate registration.

## Integration and validation

The release is integrated with production main6e25a582, preserving its newer website/resource Focus contract, Google work expansion, current migration chain, native/Windows paths and Today Schedule behavior. No retired exact-tab controls or new extension commands are introduced.

Validation covers API privacy/roles, support cache and pending-write isolation, tenant RLS, idempotent migrations, queued revocation, conflicting edits/deletes, favorites, URL normalization, picker selection without sends, frozen recipients, current Focus commands, Flight Path scope and manual fallback. Fresh source checks/builds, frontend lint/build, focused browser and registry tests, independent review and GitHub CI gate the merge/deployment.

## Release

Merge the compatible feature through a pull request, wait for clean-main CI, then run documented backend deployment with the exact reviewed app-table admission. Verify migration catalog and API/worker convergence before publishing the frontend. Preserve actual production flags and capacity, and use the guarded deploy script. No Terraform apply or Chrome extension publication is required. After live verification, delete only this task's merged branches/worktrees.
