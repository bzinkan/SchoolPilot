# ClassPilot guide accuracy implementation

Approved scope: audit all teacher/admin topics against the current live app, shorten instructions, preserve the existing layout and topic links, and improve maintenance and navigation checks. No deployment or runtime behavior changes.

1. Establish API, frontend and extension evidence independently. Treat local fixtures as local evidence. Omit source-only features and explain released school/capability gates.
2. Review every canonical topic, correct supervision/Resync/Focus, Workspace connector, staff transitions, roster distinctions, settings and safety instructions. Preserve existing topic IDs and add the Workspace Roster Connector topic.
3. Regenerate all Markdown exports. Record topic sources, review dates, verification basis and validating checks without automatic date advancement.
4. Replace the Python smoke with real-router Node Playwright checks, explicit destination fixtures, access/entitlement cases, interaction/accessibility checks and all distinct topic destinations. Add a separate CI shard and aggregate invocation.
5. Run content/browser/behavioral checks, lint/build and independent review. Preserve unrelated changes and report actual verification limits.

Execution baseline: `f9d363c3eeeedc38bdeb0417b468841dc4977444`, observed serving on November 18. The shared checkout is older and dirty; implementation uses the isolated `codex/classpilot-guide-accuracy-20261118` worktree.

Rulings after current-source inspection:

- The live source already retires rendered Waypoint terminology. Use current Focus/Flight Path labels rather than reintroducing the older wording from the initial audit.
- The serving Class tools configuration is phase 0. Remove descriptions of the unenabled later phases instead of disguising them as generally available.
- The current CI shard timeout is 30 minutes, superseding the older 20-minute observation used during planning. Preserve 30 minutes and add shard 5 without reducing existing limits.
- Full frontend provenance is unverified. Public served guide text matches all pre-edit canonical topics; retain that bounded evidence separately from the verified API source and unobserved extension adoption.
- Independent review identified a pre-existing local release-aggregate gap: kiosk themes and native/Windows browser gates were present in CI but absent locally. Added those three invocations and an inventory regression check, observed failing before the fix and passing afterward.

## Completed verification

- All 14 teacher and 21 administrator topics have dated source/check references; guide URLs and existing topic IDs remain intact. Added the dedicated roster-connector topic.
- Generated Markdown exports match canonical content. Content, review-evidence validation and CI/local entrypoint inventory: 12 tests passed.
- Real-router browser gate: 35 tests passed, covering all 22 distinct instructional destinations, access/entitlements, search/history/focus, mobile/theme and disabled-feature states. The new CI shard runs this same gate.
- Existing settings (49), admin-shell (23), supervision (21), staff-contract (9), classroom-command (179), narrow safety-close (4), and deployment-evidence (5) checks passed. Frontend production build passed; lint has no errors and retains existing warnings.
- The three restored local aggregate invocations also passed: kiosk themes, native desktop and Windows browsers. Final lint passed with 37 existing warnings and zero errors; whitespace checks passed.
- Independent technical/editorial review found no other important content, evidence or browser-validation defects. No production deployment, data/policy writes or extension release was performed.

The baseline records read-only deployment metadata and public guide assets. Local browser fixtures do not establish live authenticated workflow execution or managed-client adoption; those limits remain explicit in the review record.
