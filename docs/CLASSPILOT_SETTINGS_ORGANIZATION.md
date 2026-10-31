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
school. The Manual for today tab opens `/classpilot/my-settings/manual-today`
to prepare classes for manual starts without starting them; it uses the existing
school permission and school-local date checks. Administrators who teach can use
both workspaces.

Each independently persisted form has its own Save. Staff sign-in and digest
switches are drafts until saved. Creating/deleting website tools, adding/removing
entries, and rotating a setup key retain their explicit individual operations.
Section changes preserve drafts; guarded exits offer discard confirmation.
Pending saves block exits. Identity or school changes dispose of drafts and
protected caches, and late callbacks cannot populate a new editor.

## API and data contract

- `GET/PATCH /api/classpilot/teacher/preferences`: the authenticated actor's
  active-school preference. PATCH requires `expectedRevision` plus at least one
  of a nullable integer `maxTabsPerStudent` from 1 to 100 (null means school
  inheritance) and a nullable `dashboardTheme` object (`{ kind: "preset",
  preset, name?, calendar?, kiosk? }` or `{ kind: "image", imageAssetId, fit?,
  name?, kiosk? }`; null means the default look; `kiosk` means "show my theme on
  the PassPilot kiosk", absent = true, stored as-is; `fit` is `"cover"`,
  `"contain"` or `"tile"`, stored exactly as sent and read as `"cover"` when
  absent). Omitted fields keep their stored value. Reads also return
  `schoolDashboardTheme` (the school default or null), `dashboardThemeLocked`,
  `effectiveDashboardTheme` (an `image` theme here always carries `fit`),
  `dashboardThemesEnabled` (launch gate AND the school's `teacherThemesEnabled`),
  `dashboardThemeUploadsEnabled` (themes enabled AND `teacherUploadsEnabled` AND
  an attachments bucket is configured), `dashboardThemeAssets` (the teacher's
  background library: `{ id, status, contentType, byteSize, width, height }`
  for every ready image, oldest ready first), `dashboardThemeLibraryLimit` (5)
  and `dashboardThemeAsset` (compatibility field for clients that predate the
  library: the ready image the saved `image` theme names, else the most
  recently ready one, else null). The effective theme is the school default
  when locked or when the teacher's own theme does not count; an own `image`
  theme counts only while uploads are enabled and `imageAssetId` is a ready
  image in the library; it is null while the launch gate is off.
- Theme PATCH refusals, checked before the revision and never writing:
  `409 CLASSPILOT_DASHBOARD_THEMES_DISABLED` (gate off or teacher themes off),
  `409 CLASSPILOT_DASHBOARD_THEME_LOCKED` (`lockToSchoolTheme`),
  `409 CLASSPILOT_DASHBOARD_THEME_UPLOADS_DISABLED` (`kind: "image"` without
  uploads), `409 CLASSPILOT_DASHBOARD_THEME_ASSET_MISSING` (`imageAssetId` is not
  a ready image in the teacher's library). An unknown `fit` is `400`.
- Teacher background library, up to 5 images per teacher, stored on the
  preferences row (`dashboard_theme_assets` JSONB array; the earlier
  single-image `dashboard_theme_asset` column stays in place but is no longer
  read or written) with bytes in the private attachments bucket under
  `classpilot/themes/<school>/<teacher>/<asset>`. Input is PNG, JPEG or WebP up
  to 6 MiB and 24 megapixels; the server re-encodes to WebP at most 2560 px on
  the long edge with EXIF/XMP/ICC metadata stripped, so the served bytes never
  equal the upload.
  - `POST /api/classpilot/teacher/theme-asset` `{ contentType, size, sha256 }` →
    `201 { asset, preferences }`. A ready image with the same input type, size
    and SHA-256 is returned as-is (status `ready`) and takes no slot; otherwise
    a new entry is appended (status `reserved`). Abandoned reservations and
    expired leases are pruned on the way and their objects discarded. Refuses
    `409 CLASSPILOT_DASHBOARD_THEME_UPLOAD_IN_PROGRESS` while any entry's lease
    is live and `409 CLASSPILOT_DASHBOARD_THEME_LIBRARY_FULL` ("You can keep up
    to 5 backgrounds. Remove one to add another.") when five images are ready,
    writing nothing. A teacher without a preference row gets one, revision 1.
  - `PUT /api/classpilot/teacher/theme-asset/:id/content`: raw bytes with the
    image `Content-Type` → `200 { asset, preferences }` (status `ready`,
    `contentType: "image/webp"`). Bytes must match the reservation
    (`409 CLASSPILOT_DASHBOARD_THEME_UPLOAD_MISMATCH`); a live lease answers
    `409 CLASSPILOT_DASHBOARD_THEME_UPLOAD_IN_PROGRESS`; at most two uploads
    decode per process (`429 CLASSPILOT_DASHBOARD_THEME_UPLOAD_BUSY`). Other
    library entries are untouched. Uploading does not change `revision`; PATCH
    `dashboardTheme` with the new `imageAssetId` (and a `fit`) afterwards.
  - `GET /api/classpilot/teacher/theme-asset/:id/content`: the owner or a
    same-school admin/school_admin; anyone else `404`. Also accepts
    `?schoolId=` for stylesheet `url()` use. Headers: `Cache-Control: private,
    max-age=86400`, `ETag: "<sha256>"`, `X-Content-Type-Options: nosniff`,
    `Content-Security-Policy: sandbox; default-src 'none'`; `If-None-Match` → `304`.
  - `DELETE /api/classpilot/teacher/theme-asset/:id`: owner only →
    `200 { preferences }`; removes that one image from the library and deletes
    its object; also clears an `image` theme pointing at it (then the revision
    increments). Other images stay. Allowed even after uploads are disabled.
  - Reserve and upload refuse `409 CLASSPILOT_DASHBOARD_THEME_UPLOADS_DISABLED`
    when uploads are off for the teacher; other errors are
    `415 ..._ASSET_UNSUPPORTED_TYPE`, `413 ..._ASSET_TOO_LARGE`,
    `422 ..._ASSET_INVALID`, `404 ..._ASSET_NOT_FOUND`,
    `409 ..._UPLOAD_CONFLICT`, `503 ..._ASSET_UNAVAILABLE` and
    `503 ..._ASSET_PROCESSING_UNAVAILABLE`, all prefixed
    `CLASSPILOT_DASHBOARD_THEME`.
- `GET /api/classpilot/admin/settings`: canonical read-only school identity and
  section snapshots. Section values have opaque versions.
- `PATCH /api/classpilot/admin/settings/:section`: only the named section's
  allowlisted fields and its expected version. Sections are `classroom`,
  `monitoring`, `retention`, `email`, `signIn`, `rosterGrades` and `appearance`.
- `appearance` (stored as `settings.appearance` JSONB; missing or malformed
  values read as defaults): `teacherThemesEnabled` (default true),
  `teacherUploadsEnabled` (false), `kioskCustomBackgrounds` (false),
  `lockToSchoolTheme` (false) and `schoolDefaultTheme` (a `kind: "preset"` theme
  or null; an image is rejected with `400`), plus the school calendar
  (`docs/CLASSPILOT_DASHBOARD_THEMES.md` §9.2): `autoCalendar` (true; with no
  fixed default the school theme is today's calendar preset), `calendarHolidays`
  (`["halloween", "thanksgiving", "valentines", "st-patricks"]`; Christmas,
  Easter and Advent are opt-in, Advent implies Christmas), `calendarLeadDays`
  (10; integer 0–30), `calendarStarts` (`{}`; per-holiday `YYYY-MM-DD` early
  start for the current year) and `signInGateTheme` (true; the student sign-in
  gate shows the school theme). The GET section always carries every key,
  normalized (unknown holidays and malformed starts dropped, the lead clamped).
  On PATCH the five calendar keys are optional and the save merges over the live
  values, so a client that omits a key keeps it; `calendarStarts` merges per
  holiday, and a `null` entry clears that holiday's start.
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
tab limit, a nullable `dashboard_theme` JSONB object from its own additive ledger
migration, a nullable `dashboard_theme_asset` JSONB record (the retired
single-image slot, added with `settings.appearance` by the
`classpilot-dashboard-appearance-20261016` ledger migration and kept for
rollback), a `dashboard_theme_assets` JSONB array (the background library, up
to five images re-encoded to WebP ≤ 2560 px with metadata stripped; added by
the `classpilot-dashboard-theme-library-20261018` ledger migration, whose
one-time backfill copies a ready single image into an empty library), revision
and timestamps, tenant RLS, and independent application ownership checks. Its immutable migration initializes currently eligible
ClassPilot memberships once from valid legacy account-level tab values. Invalid
or unset values inherit. Later memberships start with inheritance; runtime
never falls back to account-wide values. The legacy table and unrelated fields,
including stored Flight Path identifiers, remain untouched. Nonproduction
bootstrap's repeated schema convergence does not repeat the data backfill.

## School Library (Flight Paths and Block Lists)

Flight Paths and Block Lists stay private to their owner by default. The School
Library is off unless `CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE=on`, optionally
narrowed by `CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS` (empty means every
school; a malformed list turns it off). With it off for a school, the list and
detail responses keep exactly their previous shape and the publication endpoints
answer `409 SHARED_TEACHING_RESOURCES_DISABLED`.

With it on, `GET /api/flight-paths` and `GET /api/block-lists` add `library`
(shared and official items in the same school that the caller does not own,
without Classroom provenance or owner ids; the owner's name only while the owner
is an active member) and `features.sharedTeachingResources`. Website tools shows
them in the School Library card; the Dashboard selectors list them after the
teacher's own items with a Shared or Official badge.

- `POST .../:id/visibility {visibility: private|school}`: the owner only. An
  administrator never publishes a teacher's private item; for an ownerless item
  (staff offboarding) an administrator may only stop sharing it.
- `POST .../:id/official {official}`: administrators only, and only on items
  already shared with the school or owned by the acting administrator (`409`
  otherwise). Official items are administrator-only for edits and deletes.
- `POST .../:id/copy`: anyone who can see the item gets a new private copy they
  own, without the source's Classroom course and resource ids. Office staff and
  other non-teaching accounts get `403`.
- Sharing and official changes, and edits or deletes of shared, official or
  another person's items, are audited in the same transaction as the change; an
  audit failure rolls the change back. Copies are audited best-effort.
- Applying an item copies its domains into the classroom state as before; later
  edits never change an active class. Staff transfers keep publication state and
  audit the hand-off of a published item.

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
