# ClassPilot school settings and Teaching tools

School configuration belongs to Admin Panel; personal website tools and classroom
defaults belong to Teaching tools. The two use separate writers. My Desk,
classroom commands, roster ownership, and personal website-library visibility
keep their existing boundaries.

## Destinations and save boundaries

Admin Settings has School details, Browsing & monitoring, Staff notifications,
Sign-in & devices, Student portal, Integrations & IT readiness, and Data &
maintenance. Admin Guide is available through Help. Schedule-change policy is
beside Calendar & schedules → Schedule changes. The school name and timezone are
canonical school values; existing profile-editing authorization still applies.

Teaching tools retains `/classpilot/my-settings` and opens on Website tools.
Class setup selects one authorized class for subgroups and eligible co-teachers.
Classroom defaults stores a personal tab-limit preference for the selected
school. Administrators who teach can use both workspaces.

Each independently persisted form has its own Save. Staff sign-in and digest
switches are drafts until saved. Creating/deleting website tools, adding/removing
entries, and rotating a setup key retain their explicit individual operations.
Section changes preserve drafts; guarded exits offer discard confirmation.
Pending saves block exits. Identity or school changes dispose of drafts and
protected caches, and late callbacks cannot populate a new editor.

## API and data contract

- `GET/PATCH /api/classpilot/teacher/preferences`: the authenticated actor's
  active-school preference. PATCH requires `expectedRevision` and a nullable
  integer `maxTabsPerStudent` from 1 to 100. Null means school inheritance.
- `GET /api/classpilot/admin/settings`: canonical read-only school identity and
  section snapshots. Section values have opaque versions.
- `PATCH /api/classpilot/admin/settings/:section`: only the named section's
  allowlisted fields and its expected version. Sections are `classroom`,
  `monitoring`, `retention`, `email`, `signIn`, and `rosterGrades`.
- `blockedWebsites` preserves the existing policy-revision contract. Student
  portal, schedule-change policy, staff sign-in policy, interruption digest,
  and setup-key operations retain their independent endpoints.
- Legacy aggregate GET remains readable. Obsolete mixed POST returns
  `409 SETTINGS_REFRESH_REQUIRED` without changing school or personal data.

Versions are checked under the school/settings transaction lock. Rejected input
is validated before persistence or command publication. A school save never
writes a personal preference. Saving a personal default never sends a student
command: it only changes Manage Tabs' starting value. School policy enforcement
and the existing live command contract remain unchanged.

`classpilot_teacher_preferences` has one row per school and teacher, a nullable
tab limit, revision and timestamps, tenant RLS, and independent application
ownership checks. Its immutable migration initializes currently eligible
ClassPilot memberships once from valid legacy account-level tab values. Invalid
or unset values inherit. Later memberships start with inheritance; runtime
never falls back to account-wide values. The legacy table and unrelated fields,
including stored Flight Path identifiers, remain untouched. Nonproduction
bootstrap's repeated schema convergence does not repeat the data backfill.

## Release and compatibility

The production backend admission was verified at
`2026-09-27T19:31:04.9769077Z` on API emergency 153 and worker 168, release
`4c5a859d624dac7c46e6b1901006d2bc7a3519b1`. Private `postflight.json` and
`database-readiness.json` evidence confirms matching serving allowlists, all 120
canonical enabled/forced tenant policies, a non-bypass database role, and the
completed `classpilot-teacher-preferences-20260927` migration with checksum
`16f6b98348868ce93223e055ee526e0a33fc8c24d33876e6b7b67dd2e12cf369`.
The separately adopted production CSV preserves the observed runtime order and
SHA-256 `09d3fd8a4aa6579dbb08f73f951d4bf1a2fe8b8a1cb93e2f4e607e6efb39c0c2`.
This adoption performs no Terraform apply and does not establish frontend or AI
activation. Historical 119-table inventories and migration checksums remain
unchanged, as does the generic 75-table default.
This remains the historical settings release receipt. The later verified 121-table
production baseline is recorded in
[PAPERWORK_PROGRESS_RELEASE.md](PAPERWORK_PROGRESS_RELEASE.md#deployment-and-rollback).

1. Verify final PR and main-branch CI, including backend, frontend, database,
   tenant isolation, router/dashboard and governance checks.
2. Inspect the live serving API/worker image, task definitions and matching RLS
   allowlists. The verified 120-table observation above does not replace a fresh
   release preflight.
3. Deploy backend and worker without repeating the completed one-shot admission:

   ```bash
   ./scripts/deploy.sh production --backend --activate-emergency
   ```

   The initial admission used the reviewed singleton
   `--enable-rls-table classpilot_teacher_preferences`; omit it on later deploys.
   Preserve serving image/configuration controls, secret references, the
   completed migration and forced tenant RLS.
4. Deploy matching frontend after the new API is healthy. Stale open pages receive
   the refresh-required response instead of mixed writes. Verify section-scoped
   saves, inheritance, and teacher/admin navigation using authorized identities.
5. Retain the separately adopted, observed live RLS allowlist in Terraform
   production configuration. Future admissions require their own live verification
   and separate baseline adoption before a later apply; never use Terraform to
   bypass the live gate.

Rollback must retain the new preference table, school-specific values and RLS.
Keep the narrow writer and refresh-required compatibility response. Do not revert
to a backend that restores mixed writes or an account-wide preference fallback.
The extension is released separately and is unchanged by this work.

Automated browser screenshots use synthetic staff/school data. A phone-sized
browser viewport is not a real-device Android acceptance run.

## Review evidence

The focused browser coverage exercises section-only writes, dirty-form navigation,
stale saves, access revocation, identity changes, class access loss, and delayed
callbacks. Local results before PR CI: Admin Settings 7/7, Teaching tools 10/10,
admin shell 17/17, Dashboard isolation 20/20, settings endpoints 12/12 (also under
a restricted database role), and preference migration 3/3. The unit lane passed
1,077 tests with four existing skips. Final PR and merged-commit CI remain release
gates; these focused results do not replace them.

Synthetic screenshots:

- [School details, desktop](images/settings-organization/school-settings-desktop.png)
- [Browsing and monitoring, desktop](images/settings-organization/browsing-settings-desktop.png)
- [Browsing and monitoring, phone viewport](images/settings-organization/browsing-settings-mobile.png)
- [Staff notifications, phone viewport](images/settings-organization/notifications-settings-mobile.png)
- [Website tools, desktop](images/settings-organization/teaching-tools-websites-desktop.png)
- [Website tools, phone viewport](images/settings-organization/teaching-tools-websites-mobile.png)
- [Classroom defaults, desktop](images/settings-organization/teaching-tools-defaults-desktop.png)
- [Classroom defaults, phone viewport](images/settings-organization/teaching-tools-defaults-mobile.png)
