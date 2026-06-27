# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Schoolpilot is a unified multi-product SaaS platform for K-12 schools. It combines three products under one API and one frontend app:

- **ClassPilot** — Chromebook classroom monitoring (screen viewing, web filtering, device locking)
- **PassPilot** — Digital hall pass system with kiosk mode
- **GoPilot** — Student dismissal management with parent notifications

## Repository Structure

Backend lives at the root (`src/`), frontend in `schoolpilot-app/`. The ClassPilot Chrome extension is in a separate repo (`ClassPilot/extension/`).

```
/                           # Backend (Express + TypeScript)
├── src/
│   ├── index.ts            # Entry: HTTP server, Socket.io, WebSocket, auto-migrations
│   ├── app.ts              # Express app, middleware, route mounting
│   ├── routes/             # API handlers, organized by product
│   │   ├── index.ts        # URL rewrite layer (maps frontend paths to canonical routes)
│   │   ├── compat.ts       # Legacy/admin routes (analytics, bulk ops, staff management)
│   │   ├── classpilot/     # devices, monitoring, sessions, groups, chat
│   │   ├── passpilot/      # passes, kiosk
│   │   ├── gopilot/        # dismissal, homerooms, pickups, bus-routes, families
│   │   ├── google/         # OAuth, Classroom sync, Directory sync
│   │   └── admin/          # Super admin, school inquiries, billing
│   ├── config/
│   │   └── pricing.ts      # Product pricing constants, bundle discounts, calculateInvoice()
│   ├── middleware/         # authenticate, requireRole, requireProductLicense, etc.
│   ├── schema/             # Drizzle ORM table definitions (core, students, per-product)
│   ├── services/
│   │   ├── storage.ts      # All database queries (~80KB, single file)
│   │   └── scheduler.ts    # Cron jobs: dismissal auto-start, daily usage rollup, heartbeat purge
│   └── realtime/           # Socket.io (GoPilot) + WebSocket (ClassPilot devices)
├── seeds/                  # Database seeding
├── docker-compose.yml      # Postgres 16, Redis 7, pgAdmin
└── Dockerfile              # Multi-stage production build

schoolpilot-app/            # Frontend (React + Vite)
├── src/
│   ├── App.jsx             # Router with lazy-loaded product pages
│   ├── contexts/           # AuthContext, LicenseContext, SocketContext
│   ├── lib/queryClient.js  # TanStack React Query client + apiRequest helper
│   ├── products/
│   │   ├── classpilot/     # Dashboard, Roster, Admin, AdminAnalytics, Students, Settings
│   │   ├── passpilot/      # Dashboard, Kiosk, KioskSimple
│   │   └── gopilot/        # DismissalDashboard, TeacherView, ParentApp, SetupWizard
│   ├── pages/              # Landing, Login, super-admin/
│   ├── shell/              # Shared shell components (widgets, Layout)
│   ├── components/ui/      # Radix UI component library
│   └── shared/             # Shared components, hooks, utils (includes pricing.js)
└── vite.config.js          # Proxy /api→:4000, /ws→:4000
```

## Development Commands

### Local Setup
```bash
# Start Docker services (Postgres on 5435, Redis on 6380, pgAdmin on 5050)
docker compose up -d

# Backend (from root)
npm install
npm run db:push          # Push schema to database
npm run db:seed          # Seed initial data
npm run dev              # Start API on :4000 (tsx watch)

# Frontend (from schoolpilot-app/)
cd schoolpilot-app
npm install
npm run dev              # Start Vite on :5173, proxies /api to :4000
```

### Build & Check
```bash
# Backend
npm run check            # TypeScript type check (tsc --noEmit)
npm run build            # Compile to dist/ (tsc + tsc-alias)
npm run soc2:check       # Validate SOC 2 governance docs and draft risk acceptances
npm run soc2:ai-privacy-evidence  # Generate non-sensitive AI/privacy evidence for SOC2-002
npm run soc2:ai-private-evidence-kit  # Create private SOC2-002 AI data-flow review drafts
npm run soc2:privileged-access-evidence  # Generate non-sensitive SOC2-003 privileged access/MFA deferral evidence
npm run soc2:privileged-access-private-evidence-kit  # Create private SOC2-003 access review/export/MFA deferral drafts
npm run soc2:incident-evidence   # Generate non-sensitive incident response evidence
npm run soc2:incident-private-evidence-kit  # Create SOC2-001 private incident evidence drafts
npm run soc2:tenant-isolation-evidence  # Generate non-sensitive tenant isolation/RLS evidence
npm run soc2:deployment-evidence  # Generate shadow deployment/change evidence
npm run soc2:private-evidence-readiness  # Generate non-sensitive readiness metadata from the private evidence repo
npm run soc2:approval-queue       # Draft pending SOC 2 approval queue
npm run soc2:approval-issue       # Format the GitHub issue body for pending approvals
npm run soc2:approval-decision -- --approval-id <id> --decision approved|not_approved --approver "<name>" --rationale "<why>"

# Frontend
cd schoolpilot-app
npm run lint             # ESLint
npm run build            # Vite production build
```

### Database (Drizzle ORM)
```bash
npm run db:push          # Push schema changes directly
npm run db:generate      # Generate migration files
npm run db:migrate       # Run migrations
npm run db:studio        # Open Drizzle Studio GUI
```

## Architecture Details

### Authentication (Dual System)
The `authenticate` middleware (`src/middleware/authenticate.ts`) checks two auth methods:
1. **Session cookies** — `express-session` backed by PostgreSQL. Used by web app (ClassPilot, PassPilot).
2. **JWT Bearer tokens** — `Authorization: Bearer <token>`. Used by GoPilot mobile and WebSocket connections.
3. **Device tokens** — Separate `STUDENT_TOKEN_SECRET` for ClassPilot Chrome extension auth.

### Authorization Chain
Routes use a middleware chain: `authenticate` → `requireSchoolContext` → `requireActiveSchool` → `requireProductLicense` → `requireRole`.

Roles: `admin`, `school_admin`, `teacher`, `office_staff`. Super admins have `isSuperAdmin: true` on their user record.

### School Isolation Hardening (CRITICAL)
SchoolPilot is a multi-tenant product. Treat the active school context as the authority boundary for every import, device action, roster read/write, and realtime message.

- **Active school first**: Resolve `schoolId` through `requireSchoolContext`; do not trust request-body `schoolId` for school-scoped writes. Use `res.locals.schoolId` in route handlers.
- **Google OAuth domain binding**: `google_oauth_tokens` stores `connectedEmail` and `connectedDomain`. Use `getGoogleOAuthTokenForSchool(userId, schoolId)` for Workspace/Classroom actions so the connected Google account domain must match the current `schools.domain`. Multiple schools may share the exact same district domain, but foreign or missing domains fail. Older tokens without connected account identity must require reconnect.
- **Google OAuth purposes**: `/api/google/auth-url` accepts `purpose=workspace_import|classroom_resources`. Workspace import requires `admin` / `school_admin`; Classroom resource import allows `teacher` / `admin` / `school_admin`.
- **Google route gates**: Directory org units/users/imports, staff import, student import, Classroom roster sync/import, and Workspace audit are admin-only (`admin` / `school_admin`). Teacher-facing Classroom resources are allowed only for assigned school context and matching Google domain.
- **Staff domain enforcement**: New `admin`, `school_admin`, `teacher`, and `office_staff` memberships must use the school's Workspace domain. Parent accounts are exempt. Existing mismatched staff stay active but are blocked from sensitive Google/import authority and shown in IT Readiness.
- **Device target scoping**: Use `src/services/classpilotDeviceScope.ts` for targeted ClassPilot messages. Chat, polls, block lists, flight paths, and remote commands must filter through school-owned devices before sending/publishing/counting. Responses may include `rejectedDeviceCount`; return `404 No accessible devices` when the filtered list is empty.
- **Teacher Dashboard command scoping**: New teacher-facing classroom actions must go through `src/routes/classpilot/commands.ts` with the command contract `{ teachingSessionId, targetScope, targetStudentIds?, subgroupId?, commandType, commandPayload }`. The server resolves all targets from the active teaching session, rejects empty/out-of-class targets, and must never interpret missing targets as a class-wide or school-wide broadcast. Device IDs and active student sessions stay internal; UI/API calls use student IDs and per-student command results. Manage Tabs close actions must preserve the owning student/session/tab reference instead of flattening URLs across students.
- **Enrollment settings reliability**: `updateEnrollmentSettings()` upserts `settings` rows. Startup auto-migrations backfill missing settings rows for legacy schools so auto-enroll toggles and enrollment-key rotation do not fail on older tenants.
- **Readiness visibility**: IT Readiness must report missing school domain, Google reconnect-required tokens, Google domain mismatches, and staff email domain mismatches.

### Database-Level Tenant Isolation (RLS) — CRITICAL for new DB code
SchoolPilot is multi-tenant. Beyond the app-code rule of filtering every query by `res.locals.schoolId`, **PostgreSQL Row-Level Security is the enforced backstop**: school-scoped tenant tables carry a per-school policy so the database itself refuses cross-school rows even if a handler forgets to filter. (Deferred, not yet enforced: `parent_student`, `messages` — pending NULL `school_id` cleanup.)

**How it works:**
- Each tenant table has a `tenant_isolation` policy + `FORCE ROW LEVEL SECURITY`: `USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')` with a matching `WITH CHECK`. Policy SQL lives in `src/db/rlsPolicies.ts`; it is applied and enabled per-table in `runStartupMigrations` (`src/index.ts`). `school_id` columns are TEXT (compared as text — no `::uuid` cast).
- **Deny-by-default**: with no GUC set, `current_setting('app.school_id', true)` is NULL, so reads return **0 rows silently** and writes fail `WITH CHECK` (sometimes a swallowed error). This is the #1 footgun.
- **Request path (the common case)**: `requireSchoolContext` / `requireDeviceAuth` call `bindTenantContext` (`src/middleware/tenantContext.ts`), which checks out one dedicated `pg` client, sets `app.school_id` (or `app.is_super='on'` for super-admins), and stashes it in `AsyncLocalStorage`. The exported Proxy `db` (`src/db.ts`) transparently routes every query to that GUC-scoped connection, then releases it on response finish. **No storage-function signatures change** — `db.select()/insert()/…` just works.
- **Global tables (NO RLS)**: `users`, `session`, `schools`, `school_memberships`, `product_licenses`, `school_inquiries` — read during auth bootstrap or public pre-tenant intake before a school is known; safe to query without a GUC.
- **Background / cross-school work**: `schedulerDb` / `schedulerPool` (`src/services/schedulerDb.ts`) set `app.is_super='on'` on every connection → bypass RLS. Use them for scheduler jobs and cross-school boot migrations.
- **Out-of-request DB access**: for code that runs OUTSIDE an Express request — WebSocket/Socket.IO handlers, unauthenticated routes (kiosk, device register), detached `.then()`/`.catch()` callbacks that outlive the response — wrap the DB work in **`runWithTenantContext({ schoolId }, fn)`** (or `{ isSuper: true }` for genuinely cross-school reads), from `src/middleware/tenantContext.ts`. It establishes the same tenant ALS scope on a fresh connection.
- **Kill-switch / rollout**: gated by env on the ECS task def — `RLS_GUC_ENABLED` (master on/off) and `RLS_ENABLED_TABLES` (comma-list of enforced tables). Dropping a table from the list (or `RLS_GUC_ENABLED=false`) disables enforcement on the next deploy — no code change.
- **Teacher command/state tables are tenant tables**: keep `classpilot_commands`, `classpilot_command_targets`, and `classpilot_classroom_states` in `RLS_ENABLED_TABLES` anywhere teacher command safety is enabled. These tables store per-school command history, target outcomes, and active classroom restrictions, so they must remain school-scoped in production and tests.

**THE RULE when you add or change DB code:** any path that reads or writes a tenant table MUST run under a tenant context — a GUC-bound request, `schedulerDb` (is_super), or `runWithTenantContext`. A new unauthenticated route, WebSocket handler, detached callback, or boot migration that touches a tenant table on the bare `db`/`pool` will **silently return 0 rows or fail `WITH CHECK`** once that table is enforced. New `INSERT`s must set `school_id` (derive it from the parent/owner — never trust the request body). The cross-tenant regression suite (`tests/cross-tenant-isolation.test.ts`) wraps calls in `inSchool()` / `asSystem()` helpers around `runWithTenantContext` — extend it when you add school-scoped storage functions.

### URL Rewrite Layer
`src/routes/index.ts` contains a complex URL rewrite middleware that maps frontend-friendly paths to canonical backend routes. This is critical — all product-specific routes go through rewrites before hitting handlers.

### Product Licensing
Each school has entries in the `product_licenses` table (CLASSPILOT, PASSPILOT, GOPILOT). The `requireProductLicense` middleware gates access. Frontend checks licenses via `LicenseContext` which reads from the `/auth/me` response.

### Billing & Stripe Integration
Pricing is defined in `src/config/pricing.ts` (backend) and mirrored in `schoolpilot-app/src/shared/utils/pricing.js` (frontend). Keep both in sync when changing prices.

**Product Pricing (Annual, per-student):**
| Products | Per-Student/Year |
|----------|-----------------|
| Any 1 app | $3/student |
| Any 2 apps | $5/student |
| All 3 apps | $7/student |

No base fees. Pure per-student pricing.

**Invoice Flow:** Super admins send manual invoices from SchoolDetail page → `POST /super-admin/schools/:id/send-invoice` → creates per-product Stripe line items + discount → Stripe emails the school → school pays via hosted invoice → `invoice.paid` webhook activates school and extends product license expiry.

**Webhook Events Handled** (`src/routes/admin/billing.ts`):
- `checkout.session.completed` — activates school after checkout
- `invoice.paid` — activates school, sets planTier, extends product licenses
- `invoice.payment_failed` — sets planStatus to `past_due`
- `customer.subscription.deleted` — sets planStatus to `canceled`

**Stripe env vars:** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`. Raw body middleware in `app.ts` captures `req.rawBody` for webhook signature verification.

### Real-time Communication
- **Socket.io** (`src/realtime/socketio.ts`) — GoPilot dismissal updates, namespaced at `/gopilot-socket`
- **WebSocket** (`src/realtime/websocket.ts`) — ClassPilot device monitoring at `/ws`
- **Redis pub/sub** — Cross-instance message broadcasting for distributed deployments

### ClassPilot Data Pipeline
1. **Heartbeats** — Chrome extension sends heartbeats every 10s to `/api/classpilot/heartbeat`. Stored in `heartbeats` table with studentId, schoolId, activeTabUrl, timestamp. Heartbeat handler caches `productLicenses` by schoolId (30min TTL) and only queries pending messages on the first heartbeat per device (WebSocket handles subsequent delivery). Reduces per-heartbeat DB queries from 7 to 5.
2. **Daily usage rollup** — `scheduler.ts` runs `rollupDailyUsage()` hourly (hour-gated). For each school with ClassPilot license, aggregates yesterday's heartbeats into the `daily_usage` table (totalSeconds, heartbeatCount, topDomains JSONB, firstSeen/lastSeen). Uses upsert on `(studentId, date)` for idempotency.
3. **Heartbeat purge** — `purgeExpiredHeartbeats()` runs at :30 past each hour (staggered from rollup). Deletes heartbeats in 5000-row batches using raw SQL (NO `.returning()` — that loads all IDs into memory). Deletes rows older than each school's `retentionHours` setting (default 720 = 30 days).
4. **Auto-migration** — `index.ts` creates tables with `CREATE TABLE IF NOT EXISTS` on startup (since production RDS is in a private VPC and can't be reached by `drizzle-kit push` directly).
5. **Scheduler isolation** — All heavy background jobs use `schedulerDb` from `src/services/schedulerDb.ts` (dedicated `pg.Pool` with `max: 3`), completely isolated from the main API pool (`max: 50`). Background jobs cannot starve API requests regardless of how long they take. When adding a new scheduled job, route it through `schedulerDb`, NOT the main `db` export. `schedulerDb` also sets `app.is_super='on'` on every connection, so it **bypasses Row-Level Security** — correct for cross-school jobs, but it means a scheduler query is NOT school-scoped (see "Database-Level Tenant Isolation (RLS)").

### ClassPilot Teacher Dashboard Commands
Teacher Dashboard actions are intentionally class-scoped and outcome-driven:

- **Canonical route**: `POST /api/classpilot/commands` (rewritten as `/commands` from the ClassPilot app) accepts `{ teachingSessionId, targetScope: "class" | "subgroup" | "students", targetStudentIds?, subgroupId?, commandType, commandPayload }`.
- **Server resolution only**: `commands.ts` loads the active teaching session and group roster, verifies teacher/co-teacher/admin authority, rejects empty or out-of-class student/subgroup targets, resolves current extension sessions/devices internally, and records unavailable students instead of broadening the target.
- **Persistence**: `classpilot_commands` is the command header; `classpilot_command_targets` stores the per-student target, resolved student session/device, status, acknowledgement state, result/error, and timestamps. Valid statuses are `requested`, `sent`, `received`, `completed`, `failed`, `unavailable`, and `expired`.
- **Acknowledgements**: extension `2.5.2+` echoes `commandId` and sends `received`, `completed`, or `failed` results over the ClassPilot WebSocket. `src/realtime/websocket.ts` writes those acknowledgements with `updateClasspilotCommandTargetAck()` and broadcasts `classpilot-command-update` back to teacher dashboards. Older extensions may stay at `sent` / awaiting acknowledgement; do not block rollout solely on missing ack.
- **Active classroom state**: `classpilot_classroom_states` stores live screen locks, Flight Paths, Block Lists, timers, polls, and attention mode so refresh/reconnect can restore state. `sessions.ts` clears these states when a class session ends.
- **Teacher UI rule**: result toasts and command history should report per-student outcomes. Manage Tabs opened for multiple students must group tabs by student and close only selected tabs owned by that student/session.

### Stale Session Auto-End (ClassPilot)
`autoEndStaleClassPilotSessions()` in scheduler runs every 60s as a safety net for teachers who forget to end class:
- **Hard 12-hour cap** on any open session
- **After school hours**: if `trackingEndTime` passed AND session running ≥ 1 hour, auto-end
- Sends same session summary email as manual end
- Broadcasts `session-ended` to teacher dashboard

### Auto-Schedule Window (ClassPilot Groups)
Admin Class Management lets schools set `blockStartTime`/`blockEndTime` per group. When `scheduleEnabled = true`:
- `autoStartClassBlocks()` creates a `teaching_session` at start time (primary teacher only)
- `autoEndClassBlocks()` ends it at end time
- **Manual start is BLOCKED outside the scheduled window** for all teachers (primary + co-teachers) — returns 403 with times shown
- Manual end **during** the window does NOT set `scheduleSkippedDate` (teacher might restart accidentally)
- Manual end **after** the window sets `scheduleSkippedDate = today` to prevent scheduler from restarting
- Admin updating schedule times **clears** `scheduleSkippedDate` — required so stale skips from earlier ends don't block the new window

### Security Monitor
`src/services/securityMonitor.ts` runs every 5 minutes from the scheduler as a deterministic rule-based breach detector. Reads `audit_logs`, writes detections to `security_events` table, emails `security@school-pilot.net`, and forwards only severity/type/event id to the generic `security_event` monitor category. NEVER takes destructive action autonomously — read-only + alerting only. Current rules: failed auth spike, bulk student writes, off-hours admin burst, cross-school access. 30-minute dedup prevents alert spam. When adding rules, use `schedulerDb` and keep them deterministic (no LLM inference for security decisions). Sensitive details belong in `security_events`, not generic Telegram/error-monitor text. See `docs/WISP.md` for the Written Information Security Program this supports.

### Admin Analytics Endpoints
All in `src/routes/compat.ts`, require admin role:
- `GET /admin/analytics/summary?period=24h|7d|30d` — School-wide stats from `daily_usage` + supplemental live `heartbeats` query for today (rollup only runs for yesterday, so today's activity must come from heartbeats directly)
- `GET /admin/analytics/by-teacher?period=today|7d|30d` — Teacher session stats from `teaching_sessions`. Session times are clamped to the query window via `GREATEST(startTime, cutoff)` and `LEAST(endTime, NOW())` so an open session from yesterday doesn't inflate Today's total (e.g., "27h" on a 24h query)
- `GET /admin/analytics/by-group?period=today|7d|30d` — Per-class Chromebook usage. Combines `daily_usage` (historical) + live `heartbeats` WHERE `timestamp::date = CURRENT_DATE` (today) so Class Usage reflects real-time activity. Active student count uses `MAX(rolled_up, live)` as a conservative dedup estimate.

### Frontend Product Pages
Each product has its own header/navigation built into its pages (no shared shell wrapper). The unified app only provides routing, auth, and the landing page. Product pages are lazy-loaded via `React.lazy()`.

- ClassPilot pages use a dark `bg-slate-900` header
- PassPilot wraps in its own `<AppShell>` component
- GoPilot pages have their own `<header>` elements
- Super Admin pages have standalone layouts

### Product Priority
When a school has multiple products, priority order is: ClassPilot > PassPilot > GoPilot (defined in `PRODUCT_PRIORITY` in `shared/utils/constants.js`). This determines the default landing product after login.

## Key Patterns

- **All DB queries** live in `src/services/storage.ts`. Add new queries there rather than inline in routes. Exception: complex analytics queries with multi-table joins may live directly in route handlers (see `compat.ts` analytics endpoints).
- **Schemas** are split by product: `core.ts` (users, schools, memberships), `classpilot.ts` (heartbeats, devices, groups, groupStudents, dailyUsage, teachingSessions), `passpilot.ts`, `gopilot.ts`, `students.ts`, `shared.ts`.
- **Frontend API calls** use two patterns:
  - **TanStack React Query** with `apiRequest()` from `lib/queryClient.js` — preferred for newer pages (ClassPilot admin, analytics). Uses `useQuery` with `queryKey` and `queryFn`.
  - **Axios instance** from `shared/utils/api.js` — legacy pattern, auto-attaches JWT tokens.
- **Role-aware hooks**: `useClassPilotAuth`, `usePassPilotAuth`, `useGoPilotAuth` map the generic `activeMembership.role` to product-specific role checks (isAdmin, isTeacher, etc.).
- **Vite proxy**: The frontend dev server proxies `/api`, `/ws`, and `/gopilot-socket` to the backend on port 4000.
- **Chrome extension**: The ClassPilot Chrome extension (MV3, separate repo at `ClassPilot/extension/`) uses a service worker (`service-worker.js`). Current version: `2.5.5`. Use `console.warn` instead of `console.error` — Chrome surfaces `console.error` calls as visible "Errors" on the chrome://extensions page, alarming school IT admins.
- **MV3 service worker limits**: `setInterval` doesn't survive service worker termination. Use `chrome.alarms` for periodic tasks. Screenshots use a separate `chrome.alarms` alarm (30s). Heartbeats use `setInterval(10s)` plus `chrome.alarms` as fallback.
- **WebSocket lives in offscreen document**: MV3 service workers can't maintain persistent WebSockets (Chrome 145+ enforces this). The extension uses an offscreen document (`offscreen.js`) as a WebSocket proxy. Chrome can kill the offscreen doc when the declared `reasons` (USER_MEDIA, DISPLAY_MEDIA, BLOBS) are inactive — the offscreen doc sends a 25s application-level ping to keep itself alive AND keep ALB connections from idling out.
- **Extension deployment**: Requires force-install via Google Admin (Devices → Chrome → Apps & extensions) for managed browsers/Chromebooks. Google Workspace screen capture policies needed for `captureVisibleTab`. Updates flow: bump `manifest.json` version in the separate ClassPilot repo → package a versioned zip → publish to Chrome Web Store → CWS review → force-install pulls automatically. A SchoolPilot API/frontend deploy does not publish or update the Chrome extension.
- **Teacher command acknowledgements**: Extension `2.5.2+` includes `commandId` in teacher command responses and reports `received`, `completed`, and `failed` states with result snapshots when available. SchoolPilot remains backward compatible with older extensions by showing `sent` / awaiting acknowledgement rather than blocking classroom actions.
- **Pending message delivery**: Backend includes undelivered messages in heartbeat response (`pendingMessages` field). Extension checks this on each heartbeat to recover messages missed during WebSocket disconnection.
- **Screenshot pipeline**: Extension captures with `chrome.tabs.captureVisibleTab` (JPEG quality 50, ~30-50KB) every 30s → POST `/api/device/screenshot` → stored in Redis with **120s TTL** (must outlive both 30s capture interval AND 30s dashboard poll, with margin for jitter). Dashboard polls `GET /api/device/screenshot/:deviceId` every 30s. Extension also reports `screenshotHealth` diagnostics (lastSuccessAt, lastError, attempts, successes, alarmActive) in every heartbeat — visible on `/students-aggregated` for remote troubleshooting without console access.
- **WebSocket reconnect for IDLE**: `connectWebSocket()` and `scheduleWsReconnect()` allow connections for both ACTIVE and IDLE tracking states. Only OFF blocks them. Otherwise students that go IDLE (180s no keyboard/mouse) and then lose their WebSocket can never reconnect, breaking all teacher FAB actions while heartbeats keep working.

### Compliance & Legal Documents
- **`docs/WISP.md`** — Written Information Security Program. Referenced by Privacy Policy for breach notification procedures. Provided to customers/assessors under NDA.
- **Privacy Policy** (`schoolpilot-app/src/pages/legal/PrivacyPolicy.jsx`): FERPA School Official, COPPA, 45-day parent access, 72-hour breach notification, 30-day data return/destruction on contract end, no-data-mining clause.
- **Terms of Service** (`schoolpilot-app/src/pages/legal/TermsOfService.jsx`): Ohio governing law, AAA arbitration (public school districts exempt), liability cap at fees paid in prior 12 months, DPA/SDPA/NDPA incorporation by reference.
- **Entity**: Schoolpilot is an Ohio LLC. Use "Schoolpilot" in user-facing copy and "Schoolpilot LLC" in legal documents when the full legal name is required.
- **iKeepSafe FERPA/COPPA certification**: demo parent accounts are created by `seeds/005_demo_parents.ts` and linked to students via the `parent_student` table for assessor user-simulation testing. Look up the demo credentials in the seed script or your secrets store — per the secrets-hygiene policy below, never record passwords in this file.

### Student Identity Resolution (CRITICAL)
The students table is shared across all 3 products. Several layers of identity resolution exist:
- **Email is the primary identity** for the extension. The extension auto-detects the Google Workspace email via `chrome.identity.getProfileUserInfo()`. Backend resolves school via `resolveSchoolForStudent(email)` which extracts the domain and looks up `schools.domain`.
- **`students.emailLc` MUST be set on every insert/update** — this is the column used for case-insensitive lookups by `resolveSchoolForStudent()`. The shared `normalizeStudentBody()` helper in `src/routes/students.ts` handles this for POST/PUT/PATCH. Extension auto-registration in `devices.ts` also sets it explicitly.
- **`/students-aggregated` device resolution** falls back to the `student_devices` table when the in-memory realtime status map doesn't have a match. This is essential for screenshot retrieval — without the fallback, `primaryDeviceId` would be null after server restart even though screenshots exist in Redis.
- **Field name normalization**: Different frontends send different field conventions. The shared `normalizeStudentBody()` helper handles `studentName` → `firstName`/`lastName`, `studentEmail` → `email`, `first_name` → `firstName`, etc. Always use this helper for student create/update endpoints.
- **School domain auto-set on registration**: `POST /api/auth/register` auto-extracts the domain from the admin's email so the extension can find the school by domain. Without this, new self-signup schools have broken extensions.

### Google Workspace & Classroom Imports
Student imports are shared setup paths for ClassPilot, PassPilot, and GoPilot. They must be reliable for IT onboarding.

- **OAuth scopes**: Classroom roster import needs `classroom.courses.readonly`, `classroom.rosters.readonly`, and `classroom.profile.emails`. Directory import needs `admin.directory.user.readonly` and `admin.directory.orgunit.readonly`. If an older connected account lacks the Classroom email scope, force a Google reconnect rather than silently importing nameless/email-less students.
- **Pagination is required**: Google Classroom courses/students and Workspace Directory users are paginated. Always loop `nextPageToken`; do not assume the first 100/500 results are the whole roster.
- **Email upsert rule**: Imports must upsert students by exact `(schoolId, emailLc)`, never fuzzy `searchStudents(email)`, because partial email/name matches can update the wrong student. `createStudent`, `updateStudent`, and `bulkCreateStudents` normalize `emailLc` in `src/services/storage.ts`.
- **Workspace import filtering**: Skip suspended, admin, and delegated-admin Google users when importing students. OU imports may include per-OU `gradeLevel` and `excludeEmails`.
- **GoPilot Classroom sync**: `/google/classroom/sync` accepts `{ courseId, homeroomId, grade|gradeLevel }` and must assign imported/updated students to the mapped homeroom, not just create roster records.
- **Production schema**: Google OAuth/Classroom tables and student Google fields must be represented both in Drizzle schema and startup auto-migrations in `src/index.ts`, because production RDS is private.

### API Response Format Gotchas
**IMPORTANT:** Backend and frontend use inconsistent field naming. Be careful:
- **Drizzle ORM** returns camelCase JS properties (`firstName`, `lastName`, `dismissalType`, `checkInMethod`).
- **Some endpoints** wrap responses in objects (`{ students: [...] }`, `{ session: {...} }`, `{ overrides: [...] }`). Others return flat arrays. Always check the specific route handler.
- **GoPilot queue endpoint** (`GET /sessions/:id/queue`) explicitly maps to snake_case (`first_name`, `last_name`, `check_in_method`, `dismissal_type`) for frontend compatibility.
- **Students endpoint** (`GET /schools/:id/students`) returns Drizzle camelCase wrapped in `{ students: [...] }`.
- When consuming API responses in the frontend, always handle both formats defensively: `Array.isArray(res.data) ? res.data : (res.data?.items ?? [])` and `student.firstName || student.first_name`.

## Environment Variables

Copy `.env.example` to `.env`. Required for local dev:
- `DATABASE_URL` — PostgreSQL connection (default: `postgresql://schoolpilot:schoolpilot_dev@localhost:5435/schoolpilot`)
- `REDIS_URL` — Redis connection (default: `redis://localhost:6380`)
- `SESSION_SECRET`, `JWT_SECRET`, `STUDENT_TOKEN_SECRET` — Auth secrets
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth
- `SUPER_ADMIN_EMAIL` — Email address that gets super admin privileges
- `CORS_ALLOWLIST` — Comma-separated frontend origins
- `SENDGRID_API_KEY` — SendGrid email service (session reports, safety alerts, welcome emails)
- `ANTHROPIC_API_KEY` — Anthropic Claude API for AI content classification + chat assistant
- `OPENAI_API_KEY` — OpenAI API (legacy classification path)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — Stripe billing
- `SENTRY_DSN` — (optional, gated off) Sentry error tracking. Leave unset until DPA signed + added to subprocessors. See "Sentry" section below.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — (optional) developer error alerts via Telegram
- `RLS_GUC_ENABLED` / `RLS_ENABLED_TABLES` — (prod, ECS task def) master switch + per-table allowlist for the Row-Level Security enforcement described under "Database-Level Tenant Isolation (RLS)". Leave unset locally unless testing RLS.

### Secrets hygiene — NEVER commit keys

- `.env`, `.env.local`, `.env.production` are in `.gitignore` — keep all real secrets there.
- **Never** paste API keys, passwords, or tokens into source files, commit messages, PR descriptions, GitHub issues, or `CLAUDE.md`. Gitleaks runs on every push and will fail CI if a secret pattern leaks.
- Production secrets live in the ECS task definition (or AWS Secrets Manager) — not in any committed file.
- If a key ever lands in the repo by accident: rotate it immediately in the provider console, then scrub history. Assume any key visible in a diff or chat transcript is already compromised.
- When rotating: update `.env` locally and the ECS task definition in prod. There is no `.env` checked in to update.

## CI

GitHub Actions (`.github/workflows/ci-build.yml`) runs on push/PR to main:
- Backend: `npm audit --audit-level=high` + `tsc --noEmit` + `npm run build`
- Frontend: `npm audit --audit-level=critical` + `npm run lint` + `vite build`
- SOC 2 governance: `npm run soc2:check` validates governance metadata, checks public/security claims, writes non-sensitive evidence packets, and auto-drafts risk acceptances for eligible open remediation items.
- SOC 2 privileged access evidence: `npm run soc2:privileged-access-evidence` writes a non-sensitive packet for `SOC2-003` showing MFA is deferred, privileged access is reviewed, and private access-review/user-export/MFA-deferral evidence is required.
- SOC 2 deployment evidence: `npm run soc2:deployment-evidence` writes a shadow change/deployment packet without deploying or requiring AWS credentials.

### SOC 2 governance evidence

- Run `npm run soc2:check` whenever changing `docs/soc2/`, `docs/WISP.md`, `docs/HECVAT-LITE.md`, public security/privacy/legal claims, remediation registers, control matrices, claim registers, or SOC 2 evidence scripts.
- Run `npm run soc2:privileged-access-evidence` whenever changing auth, role checks, school context enforcement, session controls, security monitoring, audit logging, `SOC2-003`, or `SP-SEC-001` evidence docs. This command is evidence-only and must not enable MFA, change login behavior, revoke sessions, or query production users.
- Run `npm run soc2:privileged-access-private-evidence-kit -- --private-dir ../SchoolPilot-SOC2-Evidence` to create private draft access-review, user/role export, and MFA-deferral records. Drafts are not approvals; the founder/security owner must complete factual fields before approval.
- Run `npm run soc2:deployment-evidence` whenever changing CI/deploy evidence behavior, `scripts/deploy.sh`, `Dockerfile`, package lock files, or `SP-SEC-004` evidence docs.
- Risk-acceptance drafts are generated from `docs/soc2/remediation-register.md` according to `docs/soc2/risk-acceptance-policy.json`. Current policy drafts P0/P1 items with `Open` or `In progress` status.
- Generated packets and drafts are written under `soc2-evidence/`, including `soc2-evidence/risk-acceptances/` and `soc2-evidence/deployments/`; this folder is ignored by Git and must not be committed.
- Automation may prepare risk records, owners, risk levels, expiration dates, and suggested compensating controls, but it must not approve risk acceptances. Drafts remain `Draft - pending founder approval` until the founder/Security & Privacy Officer signs off.
- Deployment evidence automation must remain shadow-only unless a later task explicitly implements protected deploys: do not add AWS credentials, ECS/S3/CloudFront changes, or production approval bypasses to evidence collection.
- Privileged access evidence automation must keep MFA status as deferred unless a later task explicitly implements MFA; do not add user-facing MFA prompts, login changes, AWS changes, session revocation, or production DB exports to CI.
- If changing risk automation rules, update `docs/soc2/risk-acceptance-policy.json` and the SOC 2 governance tests together.

The frontend uses React Compiler lint rules. Common gotchas:
- `form.watch()` from React Hook Form is incompatible — extract to a variable (e.g., `const watchedRole = form.watch("role")`)
- Sync `setState` in `useEffect` triggers `set-state-in-effect` — wrap in `requestAnimationFrame()`
- `useCallback` deps must match what the compiler infers — include state setters if referenced

No test suite currently configured.

## Native Mobile Apps (Capacitor)

GoPilot and PassPilot are available as native Android apps via Capacitor. Each product has its own Android project and Capacitor config.

### Directory Structure
```
schoolpilot-app/
├── capacitor.config.ts              # Default (GoPilot)
├── capacitor.gopilot.config.ts      # GoPilot-specific config
├── capacitor.passpilot.config.ts    # PassPilot-specific config
├── android-gopilot/                 # GoPilot Android project (com.schoolpilot.gopilot)
├── android-passpilot/               # PassPilot Android project (com.schoolpilot.passpilot)
└── resources/
    ├── gopilot/                     # GoPilot icons and splash
    └── passpilot/                   # PassPilot icons and splash
```

### Build Native App (GoPilot example)
```bash
cd schoolpilot-app

# 1. Build web assets with product env var
VITE_APP_PRODUCT=gopilot npm run build

# 2. Sync Capacitor (use product-specific config)
cp capacitor.gopilot.config.ts capacitor.config.ts
npx cap sync android

# 3. Build APK
cd android-gopilot
JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug

# 4. Install on device
"$ANDROID_HOME/platform-tools/adb" install -r app/build/outputs/apk/debug/app-debug.apk
```

### Native App Key Details
- `VITE_APP_PRODUCT` env var (`gopilot` | `passpilot`) controls branding and routing
- `NativeContext.jsx` detects native platform via `@capacitor/core` and reads `VITE_APP_PRODUCT`
- API base URL: `/api` on web, `https://school-pilot.net/api` on native
- Auth: JWT Bearer tokens (no cookies on native), persisted via `@capacitor/preferences`
- `useGoPilotAuth` hook adapts unified AuthContext to GoPilot-specific shape

### GoPilot Parent Flow
1. Parent registers via `/auth/register/parent` with `schoolSlug`
2. Auto-assigned car number via `generateCarNumber()`
3. Onboarding links children by car number (`/me/children/link-by-car`)
4. **Parent app is fully passive** — no check-in or pickup buttons. All status driven by socket events:
   - `Waiting for Dismissal` → `Dismissal is Active` (shows car number) → `You're checked in!` → `Pickup Complete`
   - Office enters car number → `student:checked-in` socket event → parent sees "Checked in"
   - Office marks pickup complete → `student:dismissed` socket event → parent sees "Pickup Complete"
5. Office has final authority — can complete dismissal even if teacher hasn't released
6. Session reset: admin can end and restart dismissal same day (clears queue, resets timestamps)

### GoPilot Socket Events
- `dismissal:started` — emitted when admin starts session, parent app switches to active
- `dismissal:ended` — emitted when admin ends session, parent app resets
- `student:checked-in` — office adds student to queue, parent app updates
- `student:called` — office calls student
- `student:dismissed` — office completes pickup, parent app shows "Pickup Complete"
- `student:released` — teacher releases student

## Production Deployment

Infrastructure is on AWS (us-east-1):
- **ECR**: `135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api`
- **ECS**: Cluster `schoolpilot-production-cluster`, service `schoolpilot-production-api`
- **RDS**: PostgreSQL in private VPC (not directly accessible — use auto-migrations in `index.ts` for schema changes)
- **S3**: `schoolpilot-production-frontend` (static frontend assets)
- **CloudFront**: Distribution `E1TPPJOD7C2CXR`

### Schema Changes
Since production RDS is in a private VPC, `drizzle-kit push` cannot reach it directly. Instead:
1. Add the Drizzle schema definition in the appropriate `src/schema/*.ts` file (e.g., `gopilot.ts` for GoPilot tables, `classpilot.ts` for ClassPilot, etc.)
2. Add a `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` block in `src/index.ts` (for production auto-migration on startup)

### GoPilot Dismissal Override System
Session-scoped dismissal type changes (car/bus/walker/afterschool) for today only, without admin approval:
- **Table:** `dismissal_overrides` (schema in `src/schema/gopilot.ts`, auto-migration in `src/index.ts`)
- **Storage functions:** `src/services/storage.ts` — `upsertDismissalOverride`, `deleteDismissalOverride`, `getOverridesForSession`, `getEffectiveDismissalType(s)`
- **API endpoints** in `src/routes/gopilot/dismissal.ts`:
  - `POST /sessions/:id/override` — create/update override (role-based: parent must be linked, teacher must have homeroom, office/admin unrestricted)
  - `GET /sessions/:id/overrides` — list all overrides for session
  - `DELETE /sessions/:id/override/:studentId` — revert to permanent default
- **Socket event:** `dismissal:override` emitted to office, teacher, and parent rooms
- **Queue integration:** All check-in methods (app, car number, bus, walker release) use `getEffectiveDismissalTypes()` to respect overrides. Afterschool students are excluded from queue.
- **Frontend:** Override UI in ParentApp, TeacherView, and DismissalDashboard (including expandable homerooms in Rooms tab)

### GoPilot Role Override
GoPilot uses a `gopilot_role` column on `memberships` that overrides the base `role` for dismissal-specific access control. This lets a teacher be assigned as `office_staff` in GoPilot (to manage the dismissal queue) without changing their role in ClassPilot or PassPilot. The `useGoPilotAuth` hook reads `gopilot_role ?? role` to determine the effective role.

### School Timezone
The `school_timezone` column on the `schools` table (IANA string, e.g. `America/Chicago`) drives all time-sensitive features: attendance resets, dismissal auto-start, and date-based queries.

- **Backend pattern**: `todayInTz(tz)` and `todayForSchool(schoolId)` in `src/routes/admin/attendance.ts` use `Intl.DateTimeFormat("en-CA", { timeZone: tz })` to get YYYY-MM-DD in the school's local time. Always use these instead of `new Date().toISOString().slice(0,10)` (which returns UTC and breaks after 7 PM Eastern).
- **Frontend pattern**: Same `Intl.DateTimeFormat("en-CA", { timeZone: tz })` approach, reading timezone from `activeMembership.schoolTimezone` via `useAuth()`.
- **Auto-detection at school creation**: `detectTimezone()` in `CreateSchool.jsx` uses `Intl.DateTimeFormat().resolvedOptions().timeZone` to detect the browser's timezone, mapping it to one of 6 supported US timezones. The super admin POST /schools endpoint saves this directly to `schools.school_timezone` (`src/schema/core.ts:74`).

### Attendance System
Daily attendance tracking with timezone-aware resets:
- **Backend**: `src/routes/admin/attendance.ts` — POST marks absent (date defaults to school's local today), GET queries by date, GET `/stats` returns summary.
- **Frontend**: `useAbsentStudents.js` hook queries today's absences using the school's timezone. `AttendancePanel.jsx` marks students absent with timezone-aware date.
- **Reset behavior**: No cron job needed — attendance "resets" naturally because queries filter by the current local date. Historical records are permanent.

### Error Monitoring
Centralized error tracking in `src/services/errorMonitor.ts`. `trackError(category, error, context?, options?)` normalizes and redacts the event once, then (1) records it in bounded per-fingerprint counters for threshold alerting, (2) persists the sanitized event durably to the `error_logs` Postgres table unless `options.persist === false`, and (3) forwards the sanitized error to Sentry **if** Sentry is enabled.

**Wired into:**
- `process.on("uncaughtException"/"unhandledRejection")` in `src/index.ts` via bounded fatal shutdown
- Express error middleware (`src/middleware/errorHandler.ts`) — 500-level errors only
- All scheduler catch blocks (`src/services/scheduler.ts`)
- SendGrid failures (`src/services/email.ts`) — with recursion guard to avoid alert→email→fail→alert loops
- WebSocket connection errors and non-noise internal message-processing errors (`src/realtime/websocket.ts`)
- Security detections as safe `security_event` notifications (`src/services/securityMonitor.ts`)
- Main/scheduler DB pool failures as non-persisted `database_connectivity` events
- Background subsystem health failures as non-persisted `health_failure` / `database_connectivity` events
- SchoolPilot browser runtime telemetry via `POST /api/monitoring/browser-error`
- ClassPilot extension runtime telemetry via device-authenticated `POST /api/classpilot/extension/runtime-error` (also aliased from `/api/extension/runtime-error`)

**Categories and thresholds** (matching fingerprint errors in 5-min window to trigger alert): `fatal_process_error`: 1, `api_error`: 5, `client_error`: 10, `scheduler_failure`: 2, `email_failure`: 3, `websocket_error`: 10, `security_event`: 1, `database_connectivity`: 1, `health_failure`: 1, `browser_runtime_error`: 10, `extension_runtime_error`: 25. Fingerprints are built from category, safe error code, normalized top stack frame, path, job, and message type. Cooldown is fingerprint-scoped and starts only after at least one configured alert channel confirms delivery; if all channels fail, the monitor uses a short 2-minute retry cooldown.

**Alerts sent to:** Email (SendGrid -> `ADMIN_EMAIL`) and Telegram bot (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`) when configured. Delivery results are checked explicitly; missing SendGrid or Telegram config is not treated as delivered. Telegram alerts are plain text, truncated under platform limits, and picked up by Claude Code Channels for AI-powered diagnosis.

**Redaction boundary:** messages, stacks, paths, safe context, email alerts, Telegram alerts, and Sentry capture are scrubbed before leaving the monitor. Query strings are stripped; emails, IPs, bearer/JWT/API-token shapes, and secret-looking assignments are redacted. Context JSONB stores only safe keys (`job`, `eventId`, `eventType`, `messageType`, `errorCode`, `source`, `surface`, `component`, `release`, `clientVersion`, `extensionVersion`, `chromeVersion`) while request/school/user correlation stays in dedicated columns. Do not pass student names, student emails, device ids, raw request bodies, raw URLs, localStorage, form/input values, or arbitrary context into monitor call sites.

**Stats + metrics:** `errorMonitor.getStats()` exposes captured, persisted, persistFailed, dropped, alertAttempted, alertDelivered, alertFailed, and cooldownSuppressed counters by total/category/fingerprint. Fingerprint samples are bounded to 5 sanitized entries each and active fingerprints are capped/evicted by quiet low-priority entries first. The monitor emits CloudWatch Embedded Metric Format JSON to stdout every 60 seconds with namespace `SchoolPilot/Monitoring` and dimensions `Environment`, `Service`, and `InstanceId`; EMF output never includes message text, stack, path, user id, school id, or context. When `REDIS_URL` is configured, monitor alert thresholds and cooldown election are shared across ECS tasks under `${REDIS_PREFIX}:monitor:*`; if Redis is missing/unhealthy, aggregation degrades to the local Phase 2 behavior without blocking boot.

**Health endpoint** (`/health`) includes `recentErrors`, detailed `checks.alerting`, and detailed `checks.monitoring` with monitor stats/runtime metadata plus `checks.monitoring.aggregation` (`mode: "redis" | "local"`). If alerting is the only degraded check, `/health` still returns HTTP 200 for liveness with JSON status `degraded`; core subsystem failures still return 503.

**Super Admin Monitoring panel:** `/super-admin/monitoring` is the read-only operations view for the monitor. APIs live under `/api/super-admin/monitoring/*` and require super-admin auth plus the existing RLS super-admin bypass. The Schools page may show only a compact status chip/link, not a large monitoring dashboard section. Phase 4A intentionally has no schema changes, no mute/acknowledge controls, and no durable incident workflow; live fingerprint history comes from in-process/Redis aggregation, while recent events come from existing sanitized `error_logs`. The panel must never show raw query strings, request bodies, tokens, emails, IPs, student names, device ids, unrestricted context, or raw security-event details.

**Browser/extension runtime telemetry:** Browser telemetry is operational error capture only, not analytics. The web app installs capture before React renders, dedupes per tab, and sends only sanitized message/stack/path/component/release/browser details. The ClassPilot extension uses `extension/telemetry.js`; service worker is the only network sender, offscreen/content script failures relay through `chrome.runtime.sendMessage`, and content scripts must not report arbitrary host-page JavaScript errors. Extension release remains separate: confirm the live Chrome Web Store version, bump `ClassPilot/extension/manifest.json` to the next patch, package, upload, and wait for review.

**Fatal behavior:** uncaught exceptions, unhandled rejections, and startup failures are recorded as `fatal_process_error`, flushed with a 5-second bound, and then the process exits nonzero with a 10-second force-exit fallback. Do not continue serving traffic after a fatal process error.

### Durable error logs + request correlation
- **`error_logs` table** (`src/schema/shared.ts`) — every persisted tracked error stores sanitized category, message, stack, `request_id`, method, pathname-only path, status_code, school_id, user_id, and safe JSONB `context`. Queryable in your own DB (same FERPA posture as `audit_logs`). Purged after 30 days by `purgeOldErrorLogs()` in the scheduler. This is the durable counterpart to the 5-minute in-memory window.
- **Request correlation id** (`src/middleware/requestId.ts`) — mounted first; assigns/honors `X-Request-Id`, echoes it in the response header, and the error handler returns it in the JSON error body (`{ error, requestId }`). To trace a reported problem: get the `requestId` from the user → query `error_logs` by `request_id` or grep CloudWatch for `req:<id>`.

### Sentry (GATED OFF until DPA signed)
`src/services/sentry.ts`. **No-op unless `SENTRY_DSN` is set.** Sentry is a third-party subprocessor — do NOT set the DSN in production until (1) Sentry's DPA is signed and (2) Sentry is on the public subprocessors list. Even when enabled, `beforeSend` scrubs PII (emails, JWT/API tokens) and drops request bodies/cookies/headers/user identifiers so student data does not leave the system. The durable `error_logs` table captures everything regardless of whether Sentry is on.

### AI Content Classification (ClassPilot)
Claude Haiku classifies student browsing activity on each heartbeat. Uses `ANTHROPIC_API_KEY` (same key as AI chat).

- **Service**: `src/services/aiClassification.ts` — `classifyUrl()` with 30-min domain cache
- **Categories**: `educational`, `non-educational`, `unknown`
- **Safety alerts**: `sexual`, `violence`, `drugs`, `self-harm`
- **Known lists**: `KNOWN_EDUCATIONAL` (Google, IXL, Khan Academy, etc.), `KNOWN_NON_EDUCATIONAL` (ESPN, YouTube, TikTok, etc.), `KNOWN_UNSAFE` (explicit sites → instant safety alert)
- **Search query detection**: Catches unsafe Google/Bing/Yahoo searches (e.g., "porn", "how to kill")
- **Real-time blocking**: Safety alerts auto-close the tab, email admins, alert teachers. Domains are NOT auto-added to the blocklist — AI blocks in real-time only
- **Allowed domains**: Admin can add domains to `allowedDomains` in settings to prevent AI from blocking them
- **Cooldown**: 10-min per device per domain to prevent alert spam
- **Persistence**: `ai_category` and `safety_alert` columns on `heartbeats` table (auto-migrated in `index.ts`)
- **Off-task overrides**: Teacher intent is respected — domains from Open Tab, Flight Path allowed domains, or manual dismiss are not flagged

### ClassPilot Competitive Safety Spine
ClassPilot now has a shared cross-product safety/context layer for IT review readiness and incident workflows:
- **Schemas**: `student_safety_cases`, `student_timeline_events`, `classpilot_ai_decisions`, and `evidence_artifacts` live in `src/schema/shared.ts` and MUST stay mirrored in startup auto-migrations in `src/index.ts`.
- **Readiness/Safety routes**: `src/routes/classpilot/competitive.ts` mounts admin/readiness, AI decision review, unified timeline, evidence packet, and parent digest endpoints under `/api/classpilot/*`.
- **Timeline producers**: Browser safety alerts, MailPilot alerts/reviews, attendance marks, PassPilot pass lifecycle, GoPilot dismissal/check-in/override events, and targeted ClassPilot remote actions write `student_timeline_events`.
- **Evidence packets**: `POST /classpilot/evidence-packets` creates a packet manifest; `GET /classpilot/evidence-packets/:id/download` returns a ZIP with JSON, CSV, HTML, and available artifacts. Safety alerts snapshot the current Redis screenshot when available and record an unavailable artifact otherwise.
- **Context-aware monitoring**: `/students-aggregated` includes `attendanceStatus`, `activePass`, `dismissalStatus`, `monitoringContext`, and `suppressionReason`. Classroom off-task noise is suppressed for absent/on-pass/dismissal states, but critical safety alerts still display and log.
- **Parent transparency**: Opt-in only. Settings fields are on `settings` (`parent_transparency_enabled`, cadence/includes fields). Scheduler sends weekly digests using approved GoPilot `parent_student` links only, with no screenshots, raw browsing timeline, or raw email content.
- **Classroom Flight Paths**: Google OAuth includes read-only coursework/material scopes. `/google/classroom/courses/:courseId/resources` extracts Classroom links, and `/classpilot/flight-paths/from-classroom` creates source-tagged Flight Paths with exact YouTube video URLs preserved.

### Student Detail Drawer (ClassPilot)
The student sidebar (Screens, Timeline, History) is scoped to the active teaching session:
- Heartbeat queries filter by `activeSession.startTime` to `activeSession.endTime`
- Class name badge shows the active group name (e.g., "Science"), not "NO CLASS"
- `/api/classpilot/heartbeats/:deviceId` accepts optional `startTime`/`endTime` query params

### PassPilot Pass Data Analytics
Teacher My Class tab includes a collapsible "Pass Data" section showing:
- Time period filter (Today/Week/Month/Year), default Today
- All students ranked by pass count (including 0 passes)
- Click student for per-student destination breakdown with Class/Student tab switcher
- Export CSV button for current view (class-wide or individual student)
- Pass history API limit: 2000 records

### ClassPilot Student Data Analytics
Student Data dialog (accessible from dashboard toolbar) shows:
- Time period filter (Today/Week/Month/Year) using school timezone
- Class view: all students sorted by last name with browsing time and top domains
- Click student for per-student domain breakdown
- Export CSV button for current view
- Backend: `/student-analytics/:studentId` supports `startDate`/`endDate` query params

### ClassPilot Settings
- **Teacher settings**: Shows category labels (Sexual, Violent, Drug, Self-Harm) instead of raw blocked domains
- **Admin settings**: Allowed Domains field (bypasses AI blocking), Blocked Websites (admin-curated only), AI Safety Alert Emails toggle
- IP Allowlist removed from UI (still in schema, not exposed)
- Export Data card removed from admin settings (export lives inside Student Data dialog)

### Class Block Scheduling
Optional time-based auto-start/end for ClassPilot classes. Schema columns on `groups`: `schedule_enabled`, `block_start_time` (HH:MM), `block_end_time` (HH:MM), `schedule_skipped_date` (YYYY-MM-DD).

- **Scheduler** (`src/services/scheduler.ts`): `autoStartClassBlocks()` and `autoEndClassBlocks()` run every 60s. Skips weekends. Uses school timezone.
- **Skip-date pattern**: When a teacher manually ends a scheduled class, `schedule_skipped_date` is set to today to prevent the scheduler from restarting it. Resets naturally the next day.
- **Session summary email**: `buildAndSendSessionSummary()` in `src/routes/classpilot/sessions.ts` is exported and called by both manual end and auto-end. Uses school timezone (not hardcoded ET).

### Super Admin Features
- **Broadcast email**: POST `/super-admin/broadcast-email` sends to all school admins via SendGrid
- **Reset login**: POST `/super-admin/schools/:id/reset-login` generates temp password AND emails it to the admin
- **School inquiries**: Public `/get-started` submissions are reviewed in Super Admin before creating an active or suspended school.
- **Tax exemption**: Full S3 upload/download flow with Stripe tax-exempt status sync
- **Impersonation**: Session-based, stores `originalUserId` to restore after

### AI Chat (Backend Only — FAB Disabled)
Claude-powered chat assistant at `/api/ai-chat/*`. Frontend FAB is commented out in `App.jsx` but backend routes remain mounted. Uses `ANTHROPIC_API_KEY` env var (set in ECS task definition).

- **Route**: `src/routes/chat.ts` → mounted at `/ai-chat` (NOT `/chat` — that path is rewritten to ClassPilot student chat)
- **Service**: `src/services/chatService.ts` — Claude Sonnet streaming via SSE, conversation memory (30-min TTL)
- **Tools**: `src/services/chatTools.ts` + `chatToolExecutor.ts` — role-aware tools filtered by product license
- **System prompt**: `src/prompts/systemPrompt.ts` — includes UI navigation docs and product feature descriptions
- **Escalation**: Chat tool executor auto-emails dev team on unexpected tool errors

### MailPilot — ClassPilot Email Safety Monitoring Add-on
Gmail inbound + outbound scanning for K-12 safety concerns (self-harm, violence, sexual content, drugs, bullying). Packaged as a **paid ClassPilot add-on**, not a standalone product. Super Admin entitlement is tracked by `schools.mailpilot_entitled`; school-admin operational monitoring is tracked separately by `schools.classpilot_email_monitoring`.

**Architecture:**
```
Student Gmail ──► Gmail watch() ──► GCP Pub/Sub topic ──► webhook
                                                              │
                                                              ▼
                                         history.list → fetch → classifyEmail (Claude Haiku)
                                                              │
                              ┌───────────────────────────────┼─────────────────────────────┐
                              ▼                               ▼                             ▼
                       email_alerts table             sendEmailSafetyAlert          admin dashboard
```

**Auth model: Google Workspace Domain-Wide Delegation (not OAuth).**
- GCP service account `mailpilot-gmail-reader@schoolpilot-487201.iam.gserviceaccount.com` (numeric Client ID `104735483460959094424`) impersonates each student mailbox
- Each customer school's Workspace super admin authorizes the service account once in their own Google Admin Console → Security → API Controls → Domain-wide delegation
- Scope: `https://www.googleapis.com/auth/gmail.readonly`
- No Google OAuth consent screen, no app verification required (DWD bypasses both). This is the same pattern Securly Aware and GoGuardian Beacon use.

**Key files:**
- **Schema**: `src/schema/mailpilot.ts` — `mailpilot_watches`, `email_alerts`, `email_scan_log`
- **Schema columns**: `mailpilot_entitled`, `classpilot_email_monitoring`, and `mailpilot_org_units` on `schools` (auto-migrated in `index.ts`)
- **AI classifier**: `classifyEmail()` in `src/services/aiClassification.ts` — Claude Haiku with severity + confidence + reasoning, no cache (emails are unique). Returns `safetyAlert`, `bullying`, `severity`, `confidence`, `reasoning`.
- **Gmail client**: `src/services/mailpilotGmail.ts` — JWT impersonation via `new google.auth.JWT({ subject: studentEmail })`, `startWatch`/`stopWatch`, `listHistorySince`, `fetchMessage` (MIME walker: plain text preferred, HTML fallback with tag stripping)
- **Pub/Sub webhook**: `src/routes/mailpilot/pubsub.ts` — bearer-token auth via `MAILPILOT_PUBSUB_VERIFY_TOKEN` (query string `?token=...`), fires async and always returns 2xx to prevent Pub/Sub retry storms. On `history_expired` error, auto-rebootstraps the watch.
- **Setup routes**: `src/routes/mailpilot/setup.ts` — `/setup/info`, `/setup/verify` (tests DWD with one student), `/setup/enable` (flips operational monitoring + starts watches with concurrency cap of 5), `/setup/disable`, `/setup/resync` (diffs roster, adds/removes watches). All setup routes require `mailpilot_entitled=true`.
- **Alert routes**: `src/routes/mailpilot/alerts.ts` — list/stats/detail/review (confirmed | dismissed | escalated). Alert routes require both `mailpilot_entitled=true` and `classpilot_email_monitoring=true`.
- **Super admin toggle**: `POST /api/super-admin/schools/:id/email-monitoring` in `superAdmin.ts` — toggles paid MailPilot entitlement (`mailpilot_entitled`) and requires active CLASSPILOT license to enable. Disabling entitlement stops watches and clears operational monitoring.
- **Scheduler**: `renewMailpilotWatches()` in `scheduler.ts` — hourly, renews any watch expiring within 24h (Gmail watches expire every 7 days) only for entitled schools with monitoring enabled.
- **Frontend**: `schoolpilot-app/src/products/classpilot/pages/EmailMonitoring.jsx` (dashboard) + `EmailMonitoringSetup.jsx` (3-step wizard: Overview → Authorize DWD → Verify + Enable). Linked from Admin.jsx header via "Email Monitor" button.

**Environment variables (ECS task definition):**
- `MAILPILOT_SA_KEY_JSON` — base64-encoded service-account JSON key (supports raw JSON or base64)
- `MAILPILOT_PUBSUB_TOPIC` — `projects/schoolpilot-487201/topics/mailpilot-gmail-events`
- `MAILPILOT_PUBSUB_VERIFY_TOKEN` — bearer token for webhook auth (appended as `?token=` query string on the Pub/Sub push endpoint)

**GCP resources (one-time, already provisioned):**
- Service account with DWD enabled, JSON key issued
- Pub/Sub topic `mailpilot-gmail-events` with `gmail-api-push@system.gserviceaccount.com` as publisher
- Push subscription `mailpilot-push-sub` → `https://school-pilot.net/api/mailpilot/pubsub/push?token=<verify-token>`
- Org policies overridden at project level to permit SA key creation (`iam.disableServiceAccountKeyCreation`) and cross-domain IAM members (`iam.allowedPolicyMemberDomains`)

**Customer onboarding flow:**
1. Super admin enables MailPilot entitlement via the toggle on SchoolDetail page (requires active CLASSPILOT license)
2. School admin opens ClassPilot → Admin → Email Monitor → Start setup
3. Wizard shows Client ID + scope (auto-populated from `/mailpilot/setup/info`)
4. School's Workspace super admin pastes them into `admin.google.com` → Security → API controls → Domain-wide delegation → Add new
5. Wizard step 3: verify with a test student email → Enable → watches start on all students with email addresses
6. Steady state: Gmail fires Pub/Sub notification → webhook classifies → alerts land in dashboard + email admins. Invisible to students.

**Pricing model:** Paid add-on on top of ClassPilot license. Super Admin can include a custom MailPilot add-on line in the existing Stripe invoice flow; MailPilot does not change ClassPilot/PassPilot/GoPilot bundle pricing.

## AWS Infrastructure Architecture

### Traffic Flow
```
User → CloudFront (E1TPPJOD7C2CXR) → routes by path:
  /api/*              → ALB → ECS Fargate (port 4000)
  /health             → ALB → ECS Fargate (port 4000)
  /ws                 → ALB → ECS Fargate (port 4000)
  /gopilot-socket/*   → ALB → ECS Fargate (port 4000)
  /* (default)        → S3 (schoolpilot-production-frontend)
```

### Component Details

| Component | Name / ARN | Notes |
|-----------|-----------|-------|
| **CloudFront** | Distribution `E1TPPJOD7C2CXR` | Two origins: `alb-api` (ALB) and `s3-frontend` (S3) |
| **ALB** | `schoolpilot-production-alb` (`schoolpilot-production-alb-1268871698.us-east-1.elb.amazonaws.com`) | Forwards to ECS target group |
| **ECS Cluster** | `schoolpilot-production-cluster` | Fargate launch type |
| **ECS Service** | `schoolpilot-production-api` | 1 desired task, Fargate, uses ALB target group |
| **Task Definition** | `schoolpilot-production-api` | Single container named `api`, port 4000 |
| **ECR** | `135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api` | Image tagged `:latest` |
| **S3** | `schoolpilot-production-frontend` | Static frontend assets served by CloudFront |
| **RDS** | PostgreSQL in private VPC | Not directly accessible; use auto-migrations in `index.ts` |
| **Region** | `us-east-1` | All resources |
| **Account** | `135775632425` | |

### Deploy Sequence — Backend

**CRITICAL: Always build and deploy from this repo's root. Never deploy from any older prototype checkout — their schemas are incompatible with the production database.**

```bash
# Step 1: ECR login (required — tokens expire after 12 hours)
MSYS_NO_PATHCONV=1 aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 135775632425.dkr.ecr.us-east-1.amazonaws.com

# Step 2: Build Docker image from THIS repo root
docker build -t schoolpilot-production-api .

# Step 3: Tag for ECR
docker tag schoolpilot-production-api:latest 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api:latest

# Step 4: Push to ECR
docker push 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api:latest

# Step 5: Register a task-def revision pinned to the pushed image DIGEST, then
# point the service at it. Preferred: `./scripts/deploy.sh --backend` does steps
# 1-5 automatically (resolve digest → render revision → register → update-service).
# ECR tags are mutable, so never deploy by tag/force-new-deployment — a digest-pinned
# revision is exact and rollback is just `update-service --task-definition family:prevRev`.
DIGEST=$(MSYS_NO_PATHCONV=1 aws ecr describe-images --repository-name schoolpilot-production-api --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text --region us-east-1)
# Render: copy current task def JSON, strip read-only fields, set containerDefinitions[0].image
# to 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@$DIGEST,
# then: aws ecs register-task-definition --cli-input-json file://taskdef.json
MSYS_NO_PATHCONV=1 aws ecs update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-api --task-definition schoolpilot-production-api:<NEW_REV> --region us-east-1

# Step 6: VERIFY — wait for new task to reach RUNNING, old task to stop
MSYS_NO_PATHCONV=1 aws ecs describe-services --cluster schoolpilot-production-cluster --services schoolpilot-production-api --region us-east-1 --query 'services[0].deployments'
# Should show 1 deployment with desiredCount=1, runningCount=1, rolloutState=COMPLETED
# If runningCount=0 or rolloutState=FAILED, check task logs in CloudWatch
```

### Deploy Sequence — Frontend

```bash
# Step 1: Build frontend
cd schoolpilot-app && npm run build

# Step 2: Sync to S3 (--delete removes old files)
MSYS_NO_PATHCONV=1 aws s3 sync "C:/GitHub/SchoolPilot/schoolpilot-app/dist/" s3://schoolpilot-production-frontend/ --delete --region us-east-1

# Step 3: Invalidate CloudFront cache (use targeted paths to reduce costs — "/*" causes ALL cached objects to refetch)
MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation --distribution-id E1TPPJOD7C2CXR --paths "/index.html" "/assets/*" --region us-east-1

# Step 4: VERIFY — check invalidation completed
MSYS_NO_PATHCONV=1 aws cloudfront list-invalidations --distribution-id E1TPPJOD7C2CXR --region us-east-1 --query 'InvalidationList.Items[0]'
# Status should be "Completed" (may take 1-2 minutes)
```

### Common Deployment Pitfalls

1. **Wrong source directory** — ALWAYS build from this repo. The obsolete GoPilot server prototype uses raw `pool.query()` with columns that don't exist in the production database.
2. **ECR login expired** — `docker push` will fail with auth errors if you haven't run `ecr get-login-password` recently. Tokens last 12 hours.
3. **ECS service name** — Must be exactly `schoolpilot-production-api` in cluster `schoolpilot-production-cluster`. There are no other services/clusters.
4. **Task not starting** — If the new task fails to start after a service update, ECS rolls back automatically. Check CloudWatch logs for the failed task. Common causes: missing env vars, bad image, port mismatch. Rollback is explicit now: `update-service --task-definition schoolpilot-production-api:<previousRev>`.
5. **CloudFront invalidation costs** — Use targeted invalidation (`/index.html /assets/*`) instead of `/*`. Wildcard `/*` invalidates ALL cached objects, causing every request to refetch from origin, generating massive CloudFront + S3 request charges during development.
6. **Windows path conversion** — Always prefix AWS CLI commands with `MSYS_NO_PATHCONV=1` in Git Bash on Windows, otherwise paths like `--paths "/*"` get mangled.
7. **Task definition env vars** — The ECS task definition must include `CLIENT_URL=https://school-pilot.net` and `GOOGLE_CALLBACK_URL=https://school-pilot.net/api/auth/google/callback`. These are set in the task definition, not in the container.
8. **Dockerfile CMD** — Runs `node dist/index.js` directly (no `drizzle-kit push`). Schema migrations are handled by auto-migration blocks in `src/index.ts` on startup.
