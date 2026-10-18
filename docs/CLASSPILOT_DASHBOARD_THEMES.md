# ClassPilot Dashboard Themes — Implementation Plan

Status: PLAN (no code yet). Owner: Brian. Drafted 2026-10-16 from the approved mock canvas
(Design canvas "ClassPilot Dashboard Facelift", claude.ai/artifact/QyBZdcZuWWpJaTisCEZGGD).

## 1. Scope for v1

1. **Flat background.** Remove the mesh radial gradients behind every page. Keep the current styling otherwise. Approved.
2. **Preloaded artwork themes** a teacher can switch to for their own ClassPilot dashboard: Halloween, Thanksgiving,
   Christmas, Valentine's Day, St. Patrick's Day, Easter, Spring, Summer, Fall, Winter, plus Advent/liturgical for
   Catholic schools. Full-page illustration behind the dashboard, frosted-glass surfaces, a small ornament on each tile.
3. **Custom background upload.** A teacher uploads their own image (a team, a college, a mascot, anything they have the
   right to use) and it becomes the full-page background with the same frosted-glass treatment. This is the only way a
   Bengals or Steelers look gets onto a dashboard; the product never ships team or college marks.
4. **Not in v1:** color palettes, custom header or accent colors, header patterns, mascots, greetings. The model leaves room
   for them (§4.1) but nothing is built.
5. Admin dashboards get the same engine (header and shell) after the teacher dashboard ships.
6. **Products.** v1 is the ClassPilot teacher dashboard only. PassPilot and GoPilot staff dashboards render in the shared
   SchoolPilot shell and are candidates for a later phase (tokenize the shell header, put the theme attribute on its root).
7. **PassPilot kiosk follows the teacher's theme** (§4.11), as its own phase after v1. The kiosk is a shared, student-facing
   device, so: preloaded themes show automatically for the teacher the kiosk is bound to; a teacher's *uploaded* image shows
   on the kiosk only when an admin has enabled "Show custom backgrounds on kiosks" (default off). Parent-facing surfaces
   (GoPilot parent app) and the Android apps never get themes.

**One rule for light and dark:** a theme replaces light or dark mode while it is active. The dark toggle is shown disabled
with the hint "This theme sets its own look. Switch to Default to use light or dark mode." The teacher's stored light or
dark preference is left untouched and comes back when they return to Default.

## 2. Where the settings live

**Full picker: Teaching tools (`/classpilot/my-settings`), new "Appearance" section.**
It sits next to the existing "Classroom defaults" card, which already reads and writes
`/classpilot/teacher/preferences` with revision-based conflict handling. The theme is one more personal preference, so it
reuses that card pattern, that API and that table.

**Quick switch: dashboard header, beside the dark-mode toggle.** A palette icon opens a short menu of themes plus
"Customize…" linking to Teaching tools. Same control in the admin shell header later.

**Not the FAB.** The floating "Quick Classroom Tools" button is for live-class actions (chat, hands) and is only mounted
while a class runs. Theme switching lives in the header instead.

## 3. Product rules (non-negotiable in every theme)

- Themes change the **page background and the chrome surfaces only**: header, toolbar and view rail, stat cards, page,
  plus tile ornaments. Student tile status borders, status dots, badges, the Updating label and the four status colors
  (online, idle, off-task, offline) never change. Layout, control positions and labels never change.
- A theme is visible to the teacher who set it, and on the PassPilot kiosk bound to that teacher's class (§4.11). Other
  teachers, admins observing the class, parents and student Chromebooks never see it.
- Preloaded themes are named by holiday or season. No team, college, mascot or league name or logo ships in the product,
  and there is no built-in logo gallery. The upload is the only path for those images.
- Terms of use gain one sentence: upload only images you have the right to use.
- Demo, website and sales screenshots never show a pro or college mark. Use a fictional mascot or the SchoolPilot mark.
- Admin controls: allow or disable teacher themes, allow or disable uploads, set a school default, optionally lock to it.
- Every preloaded theme passes 4.5:1 text contrast on its chrome. Uploaded images sit under neutral dark glass (§4.2),
  so contrast does not depend on the picture.
- Respect `prefers-reduced-transparency` (drop the blur, keep the tint). No animation ships in v1.

## 4. Architecture

### 4.1 Theme model (JSON, validated on the server)

```ts
type DashboardTheme = {
  kind: 'preset' | 'image';
  preset?: string;              // preset id from the catalog (kind = preset)
  imageAssetId?: string;        // teacher's uploaded asset (kind = image)
  name?: string;                // optional teacher label, ≤40 chars, free text ("Who Dey")
  calendar?: boolean;           // optional: resolve the preset from today's date (§4.7)
};
```

- Catalog: `schoolpilot-app/src/shared/themes/presets.js` exports `PRESETS` (id, label, artwork path, chrome token set,
  ornament id, ornament clearance). The server mirrors the id list in `src/services/classpilotThemes.ts`; a unit test
  asserts the two match.
- Validation: extend `personalSchema` in `src/services/classpilotSettings.ts` with `dashboardTheme: themeSchema.nullable()`.
  `imageAssetId` must belong to the actor and be finalized.
- Reserved for later, not built: `palette`, `pattern`, `accent`.

### 4.2 Applying a theme in the browser

- `ThemeContext` keeps light/dark exactly as today and adds `dashboardTheme`. With a theme active it sets
  `data-theme="<preset id | image>"` and `--page-image` **on the ClassPilot dashboard root element**, not on `<html>` or
  `<body>`, so the theme cannot leak into PassPilot, GoPilot, admin pages, dialogs portaled to `<body>`, or print views.
  It removes the `.dark` class for the dashboard subtree only, without touching `sp_theme` in storage.
- `schoolpilot-app/src/index.css` defines chrome variables with today's values at `:root`, then one block per preset under
  `[data-theme="…"]` overriding only: `--chrome-bg`, `--chrome-border`, `--chrome-fg`, `--chrome-muted`, `--accent`,
  `--accent-fg`, `--rail-bg`, `--rail-border`, `--rail-on-bg`, `--rail-on-fg`, `--rail-off-bg`, `--surface-glass`,
  `--tile-glass`, `--page-image`.
- Uploaded images use the `[data-theme="image"]` block: neutral charcoal glass for header, toolbar and stat cards
  (`rgba(15,23,42,.6)` with blur), white glass tiles, SchoolPilot amber mark. This reads well over any picture, including
  orange-and-black stripes or a black-and-gold logo wall, without asking the teacher for colors.
- Glass: the blur lives on a `::before` layer behind each chrome surface
  (`[data-theme] .chrome-surface::before { backdrop-filter: blur(12px); background: var(--surface-glass); }`), never on the
  element that holds interactive children. `backdrop-filter` on an element turns it into a containing block and a stacking
  context, which would re-anchor any `position: fixed` child and change z-order; the pseudo-element pattern avoids that.
  Tiles use `rgba(255,255,255,.88)` on their own `::before`. `@media (prefers-reduced-transparency: reduce)` removes the blur.
- Background: `background: var(--page-image) center/cover no-repeat fixed`.

### 4.3 Token refactor (prerequisite, no visible change)

Hard-coded Tailwind color classes move to the chrome variables so a theme can swap them:

| Surface | File | Hard-coded tokens today |
|---|---|---|
| Console header, pills, right-side buttons, sidebar tab | `products/classpilot/pages/Dashboard.jsx` header block | 66 |
| View rail (Class / Available / My room / Supervision / Send to) | `products/classpilot/components/RemoteControlToolbar.jsx` | 14 |
| Stat cards (tinted panels) | `Dashboard.jsx` stats grid | 4 panels |
| Admin shell header and sidebar | `components/admin/ClassPilotAdminShell.jsx` | later phase |

`StudentTile.jsx` is **not** touched for color (105 status tokens stay). It gains one slot,
`<TileOrnament preset={preset} />`, absolutely positioned inside the card, `pointer-events: none`, `aria-hidden`.
Uploaded-image themes render no ornament.

### 4.4 Ornaments

`schoolpilot-app/src/products/classpilot/components/TileOrnament.jsx` renders inline SVG by preset id: hearts at corners
(Valentine's), shamrock top-right (St. Patrick's), bunny ears rising from the top edge (Easter), cobweb top-right
(Halloween), turkey peeking over the top edge (Thanksgiving), string of lights across the top (Christmas), snow cap along
the top (Winter), leaf corners (Fall), sun (Summer), daisy (Spring), candles chip in the header (Advent).
Ornaments that rise above the tile need `overflow: visible` on the card and a larger grid row gap; the preset declares
`ornamentClearance: 0 | 'sm' | 'md'`.

### 4.5 Persistence

- `classpilot_teacher_preferences` gains `dashboard_theme JSONB NULL` through an idempotent startup migration in the
  existing `src/db/classpilotTeacherPreferencesMigration.ts` style (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`). RLS already covers the table.
- `GET /classpilot/teacher/preferences` returns `dashboardTheme`, `schoolDashboardTheme`, `effectiveDashboardTheme`,
  `themesEnabled`, `uploadsEnabled`, mirroring the `maxTabsPerStudent` inherit pattern.
- `PATCH /classpilot/teacher/preferences` accepts `{ expectedRevision, dashboardTheme }` alongside the existing field.
- School settings gain an `appearance` section in `schemas` (`src/services/classpilotSettings.ts`):
  `{ expectedVersion, teacherThemesEnabled, teacherUploadsEnabled, schoolDefaultTheme, lockToSchoolTheme }`, stored as
  `appearance JSONB` on the ClassPilot school settings row. Surfaces in Admin → Settings as a new card.

### 4.6 Teacher image upload

> Implemented (Phase 4 backend) with one deliberate change from the sketch below: there is no new table. The single
> asset record lives on the teacher's `classpilot_teacher_preferences` row as `dashboard_theme_asset` JSONB (already
> RLS-covered), the routes are singular (`/teacher/theme-asset`, `/teacher/theme-asset/:id/content`), output is WebP
> ≤ 2560 px with metadata stripped, and the exact contract is in `docs/CLASSPILOT_SETTINGS_ORGANIZATION.md`.

Reuse the MyDesk object-store pattern (`src/services/mydeskFiles.ts`): reserve → PUT raw bytes → finalize.

- New table `classpilot_theme_assets` (id, school_id, teacher_id, content_type, bytes, sha256, object_key, status,
  created_at). RLS on school_id. One finalized asset per teacher; a new upload replaces and deletes the old object.
- Routes in `src/routes/classpilot/settings.ts`: `POST /teacher/theme-assets` (reserve), `PUT /teacher/theme-assets/:id/content`
  (raw body, ≤6 MiB, `image/png|jpeg|webp` only, normalized through `normalizeMyDeskFile` so EXIF is stripped and the
  image is re-encoded), `GET /teacher/theme-assets/:id/content` (owner or school admin only, `Content-Security-Policy:
  sandbox; default-src 'none'`, long cache with the sha256 as ETag), `DELETE /teacher/theme-assets/:id`.
- Object keys `classpilot/themes/<school>/<teacher>/<id>` in the existing attachments bucket. `mutationLimit` on uploads.
- Client resizes before upload: longest edge 2560 px, WebP or JPEG, so a 12 MB phone photo does not hit the cap.

### 4.7 Calendar mode (optional, cheap)

`calendar: true` resolves the preset on the client from today's date in the school timezone: fixed-date holidays,
Thanksgiving as the fourth Thursday of November, Easter via the Anonymous Gregorian algorithm (also drives Lent and
Advent for the liturgical variant), seasons by month. Pure function in `shared/themes/calendar.js` with unit tests across a leap year.

### 4.8 Feature gate

`CLASSPILOT_DASHBOARD_THEMES_ENABLED` (server env, default off), same style as the other `CLASSPILOT_*_ENABLED` gates.
When off: the API returns `themesEnabled: false`, the picker and header switcher are hidden, and the client ignores any
stored theme. Flipping the flag is the launch.

### 4.9 Light and dark mode

A theme overrides light or dark mode while active (§1). Implementation: `ThemeContext` removes `.dark` when a theme is
set and restores it from `sp_theme` when the theme is cleared; `ThemeToggle` renders disabled with the hint while a
theme is active. Two repairs ride along in Phase 1 because the dark-mode mock exposed them: the dark `--border` token
equals `--card`, so cards have no edge in dark mode, and the view rail has no dark variant and stays pale yellow on a
near-black page. Both get proper dark values. If color palettes are added later they will need light and dark token
sets of their own; nothing in the model prevents that.

### 4.11 PassPilot kiosk

The kiosk already has a per-session `kioskStyle` that the server returns in the session, resume and config responses and
that the client uses to choose between `Kiosk.jsx` and `KioskSimple.jsx`. The theme rides the same channel.

- **Whose theme.** A kiosk session is bound to a teacher's class (claimed, scheduled, or following the ClassPilot
  schedule). The server resolves `effectiveDashboardTheme` for that teacher and returns it as `theme` beside `kioskStyle`.
  When the kiosk retargets to another teacher's class, the theme follows on the next poll. No bound teacher: school default or none.
- **Who controls it.** The kiosk device has no theme setting of its own; it inherits. Teachers set their own theme
  individually and it follows them onto whichever kiosk is bound to their class. Admins hold the school-wide layer in
  Admin → Settings → Appearance. Resolution order for a kiosk's effective theme:
  1. `lockToSchoolTheme` on → the school theme, for every teacher and kiosk.
  2. The bound teacher's theme, if the teacher's "Show my theme on the kiosk" switch is on and, for an uploaded image,
     `kioskCustomBackgrounds` is on.
  3. `schoolDefaultTheme`, if set (also covers kiosks bound to no teacher, such as an office or gate kiosk).
  4. Otherwise the kiosk's current look.
- **What is allowed on a kiosk.** Preloaded presets always. A teacher's uploaded image only when the school's `appearance`
  section has `kioskCustomBackgrounds: true` (default false), because the kiosk is a shared device students look at and the
  image was not curated. The teacher also gets a personal switch, "Show my theme on the kiosk", default on.
- **Serving images to an unauthenticated kiosk.** Presets are static files under `/themes/`, no auth needed. An uploaded
  image is fetched with the kiosk's existing launch-ticket credential through `GET /kiosk/theme-asset/:id/content`, which
  checks that the asset belongs to the teacher the kiosk session is bound to. Nothing is made public.
- **Rendering.** The kiosk root replaces its black or gray gradient with the theme background and puts the sign-out card on
  glass. Touch targets, text sizes and the sign-out flow are unchanged. Tile ornaments do not apply; the kiosk has no tiles.
  The kiosk's own high-contrast requirements win over the theme: body text stays ≥ 18 px and ≥ 4.5:1 on the glass card.
- **The student's name becomes part of the theme.** Three touches, all presentation only:
  1. *Name plate on the sign-out confirmation.* After "Pass issued!", the student's first name is rendered inside a
     theme object for the few seconds before the kiosk returns to the list: carved in glowing letters on a jack-o-lantern,
     written on a stocking cuff, set inside a heart, on an egg, a shamrock, a leaf, a sun, a snowflake ornament, a flower.
     One SVG template per preset with a single text slot; `textLength` with `lengthAdjust` keeps long names inside the
     shape and a measured fallback shrinks the font for very long names. The name stays real text with an `aria-label`
     ("Ada, carved on a jack-o-lantern"), and plate text keeps ≥ 4.5:1 against its shape color.
  2. *Themed roster rows.* Each name row on the simple kiosk gets a small theme tag (pumpkin, stocking, heart) before the
     name, and the "Currently Out" row takes the theme accent. Text size and tap targets are unchanged.
  3. *Themed welcome banner.* "Welcome back!" becomes "Happy Halloween, Grace!" style copy from a per-preset greeting
     table, first name only.
  Names show exactly what the kiosk shows today (the list uses last, first; the plate uses first name only). No new
  personal data is displayed. Uploaded-image themes get a neutral glass plate, no illustration.
- **Isolation.** Same §4.10 guarantees: theme is presentation only, the kiosk ticket, checkout and checkin flows do not
  read it, and a missing image falls back to the flat theme color.
- **Where it lives (Phase 5 as built).** Rules: `src/services/passpilotKioskThemeRules.ts` (pure, unit-tested); loaders and the
  kiosk asset read: `src/services/passpilotKioskTheme.ts`; calendar mode is resolved server-side by
  `src/services/classpilotThemeCalendar.ts` (a port of the browser `calendar.js`, kept identical by a test), so the kiosk only
  ever receives a concrete `{ kind: 'preset', preset }` or `{ kind: 'image', imageAssetId }`. The teacher's switch is the
  optional `kiosk: false` key on the stored theme JSON (absent = on). Client: `shared/themes/kiosk.js`,
  `passpilot/useKioskTheme.js`, `passpilot/kioskTheme.css`, `KioskNamePlate.jsx`, `KioskThemeTag.jsx`; the image is fetched
  through the kiosk API client (token + session headers) from `GET /api/passpilot/kiosk/theme-asset/:id/content` and painted
  from an object URL. When the gate is off the kiosk routes make no theme queries at all.
- **Tests.** Kiosk browser test (`passpilot-kiosk-controller-browser` family): bound teacher with Halloween → kiosk shows it;
  retarget to a teacher with Default → kiosk clears it; uploaded image hidden until the admin switch is on; checkout and
  checkin pass under a theme; blocked image falls back.

### 4.10 Isolation guarantees: everything operates normally under any theme

Every teacher may run a different background. The dashboard must behave identically under all of them, and under none.
These are invariants, each with a check that enforces it.

| Guarantee | How it is kept | How it is checked |
|---|---|---|
| **Presentation only.** No behavior reads the theme. | Theme state lives in `ThemeContext`; the only consumers are the dashboard root (attribute + variables), `TileOrnament`, `ThemeToggle` (disabled state) and the picker. No command, capability, socket, query key or scheduler code imports it. | CI grep: `useDashboardTheme` and `data-theme` may appear only in an allowlist of files; the build fails otherwise. |
| **The viewer's theme, never the class owner's.** Co-teachers, substitutes, supervision coverage and admins in Observe mode each see their own preference. | The theme is read only from the actor's own `/teacher/preferences`. It is never joined to class, session or roster data, never sent over the WebSocket, never part of a command payload, never cached per class. | Browser test: teacher A sets Halloween; admin opens Observe on A's class and sees Default; A's exported data contains no theme field. |
| **Same tiles, same geometry.** Tile size, order, text, badges and status cues are identical with and without a theme. | Ornaments are absolutely positioned, `pointer-events: none`, `aria-hidden`, drawn inside a fixed clearance; the only layout input is the preset's row-gap clearance. Status tokens are untouched by construction (§4.3). | Tile regression harness runs twice, Default and one ornament preset, and asserts equal tile bounding boxes and equal rendered badge text; a hit-test clicks the checkbox, lock button, screenshot, and each footer button on every ornament preset. |
| **Overlays, menus, toasts, the FAB and Class Tools work unchanged.** | Blur is on pseudo-elements (§4.2), so no containing block or stacking context changes; Radix portals go to `<body>`, outside the themed subtree. | Themed smoke run opens the header user menu, the lock menu, a dialog, a toast, the FAB and the Class Tools panel on three presets and asserts position and z-order match Default. |
| **Realtime, commands, screenshots, chat untouched.** | No change to `dashboardCapabilities`, the command contract, heartbeat handling, screenshot decoding or chat. The theme PRs never touch those files. | PR review rule: Phases 2–4 contain no diff under `realtime/`, `routes/classpilot/dashboard.ts`, the command services or the extension contract. Existing release-focused shards run unchanged. |
| **Other products and admin pages unaffected.** | Theme attribute scoped to the dashboard root; cleared on route change. | Browser test navigates Dashboard → Admin → PassPilot kiosk with a theme set and asserts no `data-theme` in those trees. |
| **Student Chromebooks never see it.** | Nothing about themes reaches the ClassPilot extension or device channel. The kiosk is the one student-facing surface that does show a theme, under the §4.11 rules. | Contract test: device WebSocket message schemas unchanged. |
| **Print and exports ignore it.** | `@media print` resets the chrome variables and hides the background image. | Print-preview snapshot of the seating print view under a theme equals Default. |
| **Performance stays within budget.** | One cached image (≤400 KB WebP) and blur on at most a dozen surfaces plus tiles; no per-tile images; ornament SVG is a few hundred bytes each. | Phase 3 performance gate on the oldest Chromebook; fallback removes blur. |
| **Accessibility holds.** | Glass tints fix chrome contrast independent of the picture; focus rings keep the existing ring color and gain a 1 px white halo so they read on dark glass. | Contrast assertion per preset; keyboard walk through the toolbar and one tile on each preset. |
| **Failure is harmless.** | If the artwork fails to load, the dashboard renders on the flat theme color with glass surfaces still legible. If a stored preset id is unknown (removed in a later release), the client falls back to Default and the picker shows "This theme is no longer available." | Unit test for unknown preset id; browser test with the image request blocked. |

## 5. Phases

Each phase is one PR, CI green, flag-off until Phase 6. Verification per `.codex/rules.md`: `npm run check` and
`npm run build` for backend changes; `cd schoolpilot-app; npm run lint; npm run build` for frontend; browser-smoke the affected page.

### Phase 1 — Flat background + chrome tokens (no visible change except the background)
- Remove `background-image` from `body` and `.dark body` in `schoolpilot-app/src/index.css`; keep `--background`.
- Introduce the chrome variables with their current values and migrate the 66 + 14 hard-coded tokens in the header and rail.
- Dark-mode repairs: real dark `--border`, dark variants for the view rail.
- Acceptance: pixel-equal dashboard apart from the flat background and the two dark repairs; existing tile and dashboard
  regression PNGs still pass.

### Phase 2 — Theme model, persistence, picker, quick switch, first three presets
- Migration + schema + zod + API changes (§4.5). "Dashboard theme" card in Teaching tools (Appearance section) modeled on
  `TeachingDefaults.jsx`: a grid of theme thumbnails, a Default tile, and the upload slot shown disabled with "coming in
  the next release" until Phase 4.
- `ThemeContext` theme axis, light/dark override behavior, header palette menu beside `ThemeToggle`.
- Ship Halloween, Thanksgiving and Christmas with glass surfaces and ornaments to prove the pipeline end to end.
- Tests: service unit tests for validation and revision conflicts; browser test modeled on
  `scripts/admin-settings-browser.test.mjs` that selects a theme, reloads, and confirms the dark toggle is disabled;
  contrast assertion for every shipped preset; the §4.10 allowlist grep, the viewer-not-owner Observe test, the
  overlay smoke run, and the route-change leak test.

### Phase 3 — Remaining presets, calendar mode, performance gate
- Valentine's, St. Patrick's, Easter, Spring, Summer, Fall, Winter, Advent, with ornaments. Artwork per §6.
- Calendar resolver (§4.7).
- Performance gate: dashboard frame time with 30 tiles on the oldest Chromebook in the fleet with blur on; below 50 fps,
  glass falls back to translucent-without-blur for that device class.
- Tests: tile regression PNGs for each ornament; the §4.10 geometry and hit-test harness on every ornament preset;
  calendar unit tests across a leap year; print-preview snapshot; artwork-blocked fallback test.

### Phase 4 — Custom background upload + admin governance
- §4.6 routes, table and client resize; the picker's upload slot goes live; "image" chrome block.
- Admin → Settings → Appearance card: allow themes, allow uploads, school default, lock.
- Tests: ownership (teacher A cannot read teacher B's asset), size and type rejection, EXIF stripping, replacement deletes
  the old object, lock behavior, disabled uploads hide the slot.

### Phase 5 — PassPilot kiosk follows the teacher's theme
- §4.11: `theme` in kiosk session, resume and config responses; `Kiosk.jsx` and `KioskSimple.jsx` root styling; glass
  sign-out card; kiosk theme-asset route behind the launch-ticket credential; admin switch `kioskCustomBackgrounds`;
  teacher switch "Show my theme on the kiosk".
- Name plates (`KioskNamePlate.jsx`, one SVG template per preset), themed roster tags, per-preset greeting table.
  Fit-to-width test with a 14-character first name on every plate.
- Tests as listed in §4.11; kiosk regression screenshots under Default and one preset.

### Phase 6 — Admin shell, docs, flag flip
- Apply chrome variables in `ClassPilotAdminShell.jsx`; admin header gets the quick switch.
- Update `CLASSPILOT_TEACHER_GUIDE.md` and `CLASSPILOT_ADMIN_GUIDE.md`; one sentence in the public terms about uploaded images.
- Flip `CLASSPILOT_DASHBOARD_THEMES_ENABLED` for St. Francis de Sales first, then everyone.

## 6. Artwork requirements

- Every reference image on the mock canvas is stock, AI-generated, or in the Easter case a watermarked Getty preview. None ship.
- Replacement art per preset: licensed or self-made, 1920 × 1200 minimum, exported WebP ≤400 KB, no text, no brand marks,
  composition that keeps the center-top calm (the stat row and first tile row sit there).
- Illustrated style preferred over photos; flat illustration reads better behind glass than the photo did.
- Spring: pick option A (illustrated garden) or B (photo meadow). Default to A unless Brian chooses B.
- Ornaments are inline SVG in code, no files needed. Served from `schoolpilot-app/public/themes/` through the existing
  CloudFront frontend bucket.
- **As shipped (2026-10-16).** Eleven backgrounds generated in the school's Canva account (Canva's terms for generated
  content apply; no stock licence), reviewed on the mock canvas, exported at 1920 × 1280 and stored as WebP (28–175 KB)
  at `schoolpilot-app/public/themes/<id>.webp`. The header also carries each preset's mark beside the wordmark
  (`HeaderOrnament.jsx`) and three presets set the wordmark in a display face self-hosted under `public/fonts/`
  (Creepster and Pacifico under the SIL Open Font License, Mountains of Christmas under Apache 2.0; license texts beside the files). The wordmark keeps its 28 px line box, so
  the header height, and everything below it, is unchanged (asserted by the dashboard theme case).

## 7. Open questions

1. Spring A or B.
2. Whether admins may theme the admin shell in v1 (recommendation: teacher dashboard first, admin in Phase 5 as planned).
3. Upload cap: 6 MiB after client resize proposed.
4. Whether to offer one optional accent color for uploaded images later (not v1).
5. **Storage home.** §4.5 puts the theme in `classpilot_teacher_preferences`, which ties it to a ClassPilot license. If
   PassPilot or GoPilot dashboards are likely to get themes within a year, store it instead in a product-neutral table keyed
   by school and user (`dashboard_theme_preferences`: school_id, user_id, dashboard_theme JSONB, revision, RLS on school_id)
   and have the ClassPilot preferences endpoint read through to it. Same one-migration effort in Phase 2; avoids a data
   move later. Recommendation: neutral table.

## 8. Risks

- **Token refactor regressions** in a 8,800-line `Dashboard.jsx`. Mitigation: Phase 1 is variables-only with identical
  values, verified by the existing regression PNGs.
- **Blur cost on old Chromebooks.** Mitigation: the Phase 3 performance gate and fallback.
- **Trademark exposure through marketing.** Mitigation: §3 rules; screenshots use the SchoolPilot mark.
- **Teachers uploading inappropriate images.** Mitigation: private to the teacher only; admins can disable uploads and can
  view an asset for review; uploads are logged with teacher id and sha256.

---

# Part 2 — Automatic calendar themes, school calendars, and the student sign-in gate

Written 2026-10-17 after Part 1 (phases 1–6 plus the approved artwork) shipped. Three asks from Brian:

1. The student sign-in gate (the ClassPilot extension's auth gate on shared Chromebooks) follows the **school** theme, with
   the production artwork inside the sign-in panel behind a frosted form card (canvas row 13, approved).
2. Holiday and season themes come up **automatically** unless a teacher or an admin turns them off.
3. Public schools must not get Christmas or Easter by default. The default for them is Spring and Winter; an admin (or a
   teacher, for their own dashboard) can change that.

## 9. Model changes

### 9.1 Three teacher states instead of two
Today a teacher's `dashboardTheme` is `null` (no choice, inherit the school) or a theme. Automatic themes need "I inherit"
and "I want nothing" to be different, so the stored value gains a third shape:

| Stored value | Meaning | Picker label |
|---|---|---|
| `null` | Follow the school (automatic calendar, or the admin's default) | **Follow the school calendar** (default) |
| `{ kind: "none" }` | Plain dashboard, no theme, honours light/dark mode | **Plain, no theme** |
| `{ kind: "preset", … }` / `{ kind: "image", … }` | The teacher's own choice | as today |

`{ kind: "none" }` is accepted by `dashboardThemeSchema`, resolves to no theme everywhere (dashboard, kiosk when that
teacher is bound), and is never overridden except by the admin lock. Existing rows need no migration: `null` already means
"inherit".

### 9.2 School appearance gains a calendar
`settings.appearance` (jsonb, Phase 4) gains:

| Key | Default | Meaning |
|---|---|---|
| `autoCalendar` | `true` | When no `schoolDefaultTheme` is set, the school theme is today's calendar preset. Off = plain unless a default is set. |
| `calendarHolidays` | `["halloween","thanksgiving","valentines","st-patricks"]` | Holidays the calendar may pick. Anything not listed falls through to the season: December → Winter, the Easter window → Spring. |
| `signInGateTheme` | `true` | The student sign-in gate shows the school theme. |
| `calendarLeadDays` | `10` | How many days before a holiday its theme appears (0–30). The day after the holiday the season returns. |

The **faith-calendar** holidays (`christmas`, `easter`, `advent`) are therefore **off for every school by default** and an
admin turns them on. St. Francis de Sales turns all three on in Admin › Settings › Appearance (no migration, no code).
`advent` implies `christmas` (Advent runs to Dec 24, Christmas from Dec 25). `schoolDefaultTheme` keeps its meaning as an
explicit fixed override; `lockToSchoolTheme` keeps forcing the school theme on everyone.

Why an allowlist rather than a "public school" switch: there is no reliable school-type field, districts differ about
Halloween too, and a checkbox per holiday is what an admin actually asks for. The default set is the one most US public
schools already decorate for.

### 9.3 Holiday windows: lead time, then the season comes back
Every holiday opens `calendarLeadDays` before its date (default 10) and closes the day after it, when the season preset
returns. The windows in Part 1 (Halloween from Oct 15, a two-week Easter run-up, Christmas for all of December) are
replaced by one rule:

| Holiday | Date | Window at the default lead of 10 days | Then |
|---|---|---|---|
| Halloween | Oct 31 | Oct 21 – Oct 31 | Fall |
| Thanksgiving | 4th Thursday of November | 10 days before – Thanksgiving Day | Fall |
| Christmas | Dec 25 | Dec 15 – Dec 25 | Winter |
| Valentine's Day | Feb 14 | Feb 4 – Feb 14 | Winter |
| St. Patrick's Day | Mar 17 | Mar 7 – Mar 17 | Spring |
| Easter | Easter Sunday | 10 days before – Easter Sunday | Spring |
| Advent (when listed) | Advent Sunday – Dec 24 | Its real liturgical dates, yielding to the Christmas window from Dec 15 | Christmas, then Winter |

The lead time is one number for the whole school (Admin › Appearance); a teacher who wants something else picks a theme
or Plain for their own dashboard. The resolver is still a pure function of the date, so the leap-year test keeps covering
every day; two new tests pin the window edges (the 10th day before shows the holiday, the day after shows the season) and
that Advent hands over to Christmas on Dec 15.

### 9.4 One resolver, three consumers
`calendarPresetFor(today, { allowed, leadDays })` replaces the `liturgical` flag in both copies (`shared/themes/calendar.js` and
`src/services/classpilotThemeCalendar.ts`; the parity test keeps them identical). Resolution for a **school theme**:

```
schoolTheme = schoolDefaultTheme
  ?? (autoCalendar ? { kind: "preset", preset: calendarPresetFor(today, { allowed: calendarHolidays, leadDays: calendarLeadDays }), calendar: true } : null)
```

- Dashboard: the viewer's own choice (`preset`/`image`), else `none` → nothing, else the school theme; the admin lock beats
  all of it. The teacher's own `calendar: true` with an `advent` hint keeps working (a public-school teacher may still choose
  Christmas for her own dashboard).
- Kiosk: unchanged order (lock → bound teacher → school theme), the school theme now computed as above.
- Sign-in gate: the school theme only (`signInGateTheme` on, launch flag on); never a teacher's.

### 9.5 Student sign-in gate (extension)
- `GET /api/classpilot/extension/login-config` gains `theme: { preset, label, artwork, mark, brandFace } | null`.
  `artwork` is the absolute production URL (`https://school-pilot.net/themes/<id>.webp`), `brandFace` one of
  `creepster | mountains-of-christmas | pacifico | null` with its font URL. Absent field = plain gate, so older extensions
  change nothing. Public with the enrollment key as today; no student or teacher data.
- The gate (`extension/auth-gate-frame.*`) paints the artwork inside the sign-in panel behind a frosted form card, tints the
  side column, draws the mark beside the brand and sets the brand face; fields, button, copy and contrast unchanged
  (row 13 on the canvas). The last theme is cached in extension storage so the gate does not flash plain on a slow network;
  any failed image or font falls back to the plain gate. Requires an extension release; it rides the 3.0.0 train in
  coordination with its owner.
- Isolation rule update (§4.10): the extension receives **one school-level, pre-sign-in, presentation-only** theme object
  through login-config and nothing else; no theme data on the device channel, no per-teacher data.

### 9.6 Teacher and admin surfaces
- Teaching tools › Appearance: first option becomes **Follow the school calendar** (selected by default, shows "Today:
  Halloween"), then the presets, then **Plain, no theme**, then the upload slot. The per-teacher "Follow the calendar"
  checkbox stays for teachers who want their own calendar with a different holiday set (the Advent checkbox remains there).
- Header quick switch: the same three groups.
- Admin › Settings › Appearance: **Automatic calendar themes** (on), **Holidays shown automatically** checkboxes (secular set
  checked; Christmas, Easter, Advent unchecked), **Days before a holiday** (10), **Show the school theme on the student
  sign-in gate** (on), plus the existing switches. Saving stays a single versioned section write.
- First-run notice: the first time a dashboard renders an automatic theme, a one-line dismissible banner says "Your
  dashboard follows the school calendar. Change it in Appearance." with a Plain link. Stored per teacher in the browser.

## 10. Phases

### Phase 7 — Automatic calendar themes and school calendars (web + API, flag-safe)
- Schema: `{ kind: "none" }`; `appearance.autoCalendar`, `calendarHolidays`, `calendarLeadDays`, `signInGateTheme`; zod and
  `readSchoolAppearance` defaults; `calendarPresetFor(today, { allowed, leadDays })` in both copies with the window table above.
- Resolvers: `preferenceDto` (`effectiveDashboardTheme`), `passpilotKioskThemeRules`, and a new `schoolThemeFor(schoolId, now)`
  shared by the kiosk and login-config.
- UI: picker three groups + first-run banner; admin checkboxes; guides.
- Tests: every day of the year resolves for the secular set with no faith preset; Christmas, Easter and Advent appear only
  when listed; `none` beats the school theme and loses only to the lock; kiosk and dashboard parity; admin section save.
- Rollout: deploy; the St. Francis admin ticks Christmas, Easter and Advent. From then on teachers who never chose a theme see
  Halloween this month automatically.

### Phase 8 — Student sign-in gate
- API: `theme` on login-config (ships with Phase 7 or right after; harmless until the extension reads it).
- Extension: gate rendering, cache, fallback, a browser test against the fixture gate; ride the 3.0.0 release.
- Docs: IT tutorial note that the sign-in gate shows the school theme and how an admin turns it off.

## 11. Feedback and decisions to confirm
1. **Default-on is a product change teachers will notice on day one.** The banner in §9.6 is the mitigation; without it
   expect "my dashboard changed" messages. Recommendation: ship the banner with Phase 7.
2. **Dark mode.** A theme overrides dark mode (§4.9). With automatic themes, dark-mode users lose dark mode for the length
   of a holiday window unless they pick Plain. Recommendation: keep the rule and make the banner's Plain link one click.
3. **Faith holidays stay reachable for teachers.** A public-school teacher can still pick Christmas for her own dashboard;
   only the automatic school calendar is filtered. If a district needs presets hidden outright, that is a later
   `hiddenPresets` admin list, not in this plan.
4. **Halloween is in the default secular set.** Some districts avoid it; the admin checkbox covers them. Confirm the default.
5. **Student-facing surfaces.** With Phase 8, students see the school theme on the sign-in gate and on the kiosk. Both are
   school-level and admin-controllable (`signInGateTheme`, `kioskCustomBackgrounds`); uploaded teacher images never reach the
   gate.
6. **Christmas versus Advent.** With the 10-day rule a Catholic school that lists Advent sees Advent from Advent Sunday,
   Christmas from Dec 15, Winter from Dec 26. Confirm Dec 15 is the right hand-over; it is one constant.
7. **Extension timing.** The gate waits for an extension release; everything else lands with a web deploy. If 3.0.0 is far
   off, a 2.9.10 with only the gate change is the alternative.
