# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Schoolpilot is a unified multi-product SaaS platform for K-12 schools. It combines three products under one API and one frontend app:

- **ClassPilot** — Chromebook classroom monitoring (screen viewing, web filtering, device locking)
- **PassPilot** — Digital hall pass system with kiosk mode
- **GoPilot** — School-operated student dismissal for administrators, office staff, and teachers

## Repository Structure

Backend lives at the root (`src/`), frontend in `schoolpilot-app/`. The ClassPilot Chrome extension is in a separate repo (`ClassPilot/extension/`).

```
/                           # Backend (Express + TypeScript)
├── src/
│   ├── index.ts            # Entry: HTTP server, Socket.io, WebSocket, migration runner
│   ├── worker.ts           # Dedicated scheduler worker entrypoint
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
│   │   └── gopilot/        # DismissalDashboard, TeacherView, SetupWizard
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
- **Device targeting boundary**: `src/services/classpilotDeviceScope.ts` is for internal/admin device-policy paths only. Teacher-facing chat, polls, block lists, Flight Paths, tab actions, and remote controls must not accept or return device IDs. The old device-targeted teacher endpoints are retired and return `410`; do not revive them.
- **Teacher Dashboard command scoping**: Owned-class actions go through `POST /api/classpilot/commands` with `{ teachingSessionId, targetScope, targetStudentIds?, subgroupId?, commandType, commandPayload }`. Only immutable `classpilot_session_staff` may mutate a teaching session; administrator/super-administrator Observe access alone is read-only. The server freezes the roster and exact student/session/device binding, rechecks entitlement, actor authority, control ownership, and current binding inside the command transaction, and records unavailable students without broadening the target. Device IDs remain transport-only.
- **Coverage command scoping**: Claimed-student actions go through `POST /api/classpilot/coverage/contexts/:id/commands`, grouped by immutable supervision context. The coverage allowlist is `open-tab`, `close-tabs`, `lock-screen`, `unlock-screen`, `teacher-message`, `apply-flight-path`, and `apply-block-list`; Teacher FAB, Live View, attention, timers, polls, sign-out, temporary unblock, tab limit, and removal actions remain class-session-only unless the backend contract is deliberately extended. Cross-context UI dispatch preserves partial outcomes and never converts one failed context into a class-wide fallback.
- **Strict command payloads**: `src/services/classpilotCommandValidation.ts` is the sole syntactic boundary and every payload object is strict. Canonical `unlock-screen` requires `{ screenOnly: true }` and preserves Flight Path; Flight Path removal is the separate `remove-flight-path {}` command. Exact tab close is either `{ closeAll: true }` or `{ tabsToClose: [{ studentId, tabRef, observedRevision }, ...] }` with 1–50 unique rows. URL/pattern fallback is forbidden, duplicate URLs remain separate tabs, and stale or unsupported refs fail per tab/student. `student-sign-out` accepts `{}` only.
- **Enrollment settings reliability**: `updateEnrollmentSettings()` upserts `settings` rows. Startup auto-migrations backfill missing settings rows for legacy schools so auto-enroll toggles and enrollment-key rotation do not fail on older tenants.
- **Readiness visibility**: IT Readiness must report missing school domain, Google reconnect-required tokens, Google domain mismatches, and staff email domain mismatches.

### Database-Level Tenant Isolation (RLS) — CRITICAL for new DB code
SchoolPilot is multi-tenant. Beyond the app-code rule of filtering every query by `res.locals.schoolId`, **PostgreSQL Row-Level Security is the enforced backstop**: school-scoped tenant tables carry a per-school policy so the database itself refuses cross-school rows even if a handler forgets to filter. `parent_student.school_id` is non-null. `messages` is also in the RLS baseline and every new write derives `school_id`, while retained ambiguous legacy rows may remain NULL and are deny-hidden by RLS; do not treat either table as deferred.

**How it works:**
- Each tenant table has a `tenant_isolation` policy + `FORCE ROW LEVEL SECURITY`: `USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')` with a matching `WITH CHECK`. New production tables receive this policy in their checksum-ledger migration and must also appear in `src/config/rlsRegistry.json`; the non-production bootstrap applies the registry inventory. `school_id` columns are TEXT (compared as text — no `::uuid` cast).
- **Deny-by-default**: with no GUC set, `current_setting('app.school_id', true)` is NULL, so reads return **0 rows silently** and writes fail `WITH CHECK` (sometimes a swallowed error). This is the #1 footgun.
- **Request path (the common case)**: `requireSchoolContext` / `requireDeviceAuth` call `bindTenantContext` (`src/middleware/tenantContext.ts`), which checks out one dedicated `pg` client, sets `app.school_id` (or `app.is_super='on'` for super-admins), and stashes it in `AsyncLocalStorage`. The exported Proxy `db` (`src/db.ts`) transparently routes every query to that GUC-scoped connection, then releases it on response finish. **No storage-function signatures change** — `db.select()/insert()/…` just works.
- **Global tables (NO RLS)**: `users`, `session`, `schools`, `school_memberships`, `product_licenses`, `school_inquiries`, and retained migration-source table `trial_requests` — read during auth bootstrap or public pre-tenant intake before a school is known; safe to query without a GUC.
- **Background / cross-school work**: `schedulerDb` / `schedulerPool` (`src/services/schedulerDb.ts`) set `app.is_super='on'` on every connection → bypass RLS. Use them for scheduler jobs and cross-school boot migrations.
- **Out-of-request DB access**: for code that runs OUTSIDE an Express request — WebSocket/Socket.IO handlers, unauthenticated routes (kiosk, device register), detached `.then()`/`.catch()` callbacks that outlive the response — wrap the DB work in **`runWithTenantContext({ schoolId }, fn)`** (or `{ isSuper: true }` for genuinely cross-school reads), from `src/middleware/tenantContext.ts`. It establishes the same tenant ALS scope on a fresh connection.
- **Kill-switch / rollout**: gated by env on the ECS task def — `RLS_GUC_ENABLED` (master on/off) and `RLS_ENABLED_TABLES` (comma-list of enforced tables). Dropping a table from the list (or `RLS_GUC_ENABLED=false`) disables enforcement on the next deploy — no code change.
- **Deploy-time allowlist additions**: ordinary backend deploys preserve the live task definition's RLS master switch and per-table allowlist exactly. A reviewed release may use the one-shot `--enable-rls-table <reviewed-table-or-exact-bundle>` flag. That path requires matching live API/worker allowlists with `RLS_GUC_ENABLED=true`, adds only the reviewed table set to the rendered API/emergency/worker definitions, verifies the registered definitions, and makes the migration task fail unless PostgreSQL reports enabled + forced RLS and the `tenant_isolation` policy for every requested table. Omit the flag on later deploys; a deliberate per-table kill-switch removal then remains removed. This path does not require a Terraform apply.
- **ClassPilot command/FAB state is tenant state**: keep `classpilot_commands`, `classpilot_command_targets`, `classpilot_classroom_states`, `classpilot_student_control_states`, `classpilot_active_hands`, `classpilot_chat_deliveries`, `polls`, `poll_responses`, and `session_settings` school-scoped in production and tests. Startup migrations fail closed on invalid parent bindings and install/verify same-school parent triggers for FAB/chat/poll rows. All five FAB/chat/poll tables are in the adopted production baseline; the reviewed re-admission bundle remains exactly `classpilot_chat_deliveries,poll_responses,polls,session_settings` if a deliberate kill-switch removal must later be reversed.
- **Semantic RLS registry**: `src/config/rlsRegistry.json` is the machine-readable inventory and rollout-request authority. It preserves the exact observed 72-table production snapshot from August 19, 2026 and separately defines the 75-table SchoolPilot 2.7.0 post-expand target. Never rewrite the historical snapshot to make it match a future target. `classpilot_active_hands` remains part of the full inventory but is deliberately excluded from the four-table FAB re-admission bundle.

**THE RULE when you add or change DB code:** any path that reads or writes a tenant table MUST run under a tenant context — a GUC-bound request, `schedulerDb` (is_super), or `runWithTenantContext`. A new unauthenticated route, WebSocket handler, detached callback, or boot migration that touches a tenant table on the bare `db`/`pool` will **silently return 0 rows or fail `WITH CHECK`** once that table is enforced. New `INSERT`s must set `school_id` (derive it from the parent/owner — never trust the request body). The cross-tenant regression suite (`tests/cross-tenant-isolation.test.ts`) wraps calls in `inSchool()` / `asSystem()` helpers around `runWithTenantContext` — extend it when you add school-scoped storage functions.

### URL Rewrite Layer
`src/routes/index.ts` contains a complex URL rewrite middleware that maps frontend-friendly paths to canonical backend routes. This is critical — all product-specific routes go through rewrites before hitting handlers.

### Product Licensing
Each school has entries in the `product_licenses` table (CLASSPILOT, PASSPILOT, GOPILOT). Frontend checks licenses via `LicenseContext` which reads from the `/auth/me` response. Security-sensitive ClassPilot and every GoPilot operational path use their canonical uncached entitlement resolvers rather than the legacy product-row-only middleware.

ClassPilot security-sensitive paths use the stricter uncached resolver in `src/services/classpilotEntitlement.ts`. Entitlement requires an existing school with `status=active`, `isActive=true`, no `disabledAt`/`deletedAt`, non-canceled plan status, non-expired school access, and an active non-expired CLASSPILOT license. Super administrators do not bypass this product boundary. Student token issuance, device telemetry/FAB/poll routes, staff mutations, and both student/staff WebSockets use the same decision; commands, FAB/chat/poll writes, and manual/scheduled starts recheck it under their transaction locks so revocation wins races.

GoPilot uses the same lifecycle rules through `src/services/gopilotEntitlement.ts`: HTTP routes, Socket.io joins, scheduler candidate discovery, and locked dismissal start/resume transitions share one school-plus-license decision. The scheduler and manual transition path recheck immediately before activation under transaction locks. Revocation blocks new operational starts with `GOPILOT_NOT_ENTITLED`, while pause/completion cleanup remains available; super administrators do not bypass the product boundary.

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
1. **Heartbeats** — While the MV3 worker is awake, the extension coalesces roughly 10-second heartbeats with a 30-second `chrome.alarms` fallback and immediate navigation/recovery sends. It calls compatibility path `/api/device/heartbeat`, which resolves to canonical `POST /api/classpilot/device/heartbeat`. The route performs uncached canonical entitlement before the cached hot-path projections and writes heartbeat/realtime status under the exact student/session/device binding. Pending inbox rows are checked on first heartbeat, after a 60-second monitoring gap, every 5 minutes as fallback, and every heartbeat while command-linked messages remain unacknowledged. `requestFabState: true` asks for a throttled authoritative FAB recovery snapshot.
2. **Daily usage rollup** — `scheduler.ts` runs `rollupDailyUsage()` hourly (hour-gated). For each school with ClassPilot license, aggregates yesterday's heartbeats into the `daily_usage` table (totalSeconds, heartbeatCount, topDomains JSONB, firstSeen/lastSeen). Uses upsert on `(studentId, date)` for idempotency.
3. **Heartbeat purge** — `purgeExpiredHeartbeats()` runs at :30 past each hour (staggered from rollup). Deletes heartbeats in 5000-row batches using raw SQL (NO `.returning()` — that loads all IDs into memory). Deletes rows older than each school's `retentionHours` setting (default 720 = 30 days).
4. **Explicit migrations** — Production deploys run the checksum-verified, advisory-locked migration ledger as a one-off ECS task with `RUN_MIGRATIONS_ONLY=true` before rolling web/worker services. Any unexpected SQL state fails the task. `runStartupMigrations()` is retained only for non-production bootstrap convergence and is explicitly forbidden in production. Web ECS tasks use `RUN_MIGRATIONS_ON_STARTUP=false`.
5. **Scheduler isolation** — Production web tasks run with `SCHEDULER_ENABLED=false`; the singleton ECS service `schoolpilot-production-scheduler-worker` runs `src/worker.ts` with `SCHEDULER_ENABLED=true`. Each scheduled job also takes a Postgres advisory lock through `runWithSchedulerLock()` so accidental duplicate workers do not double-run jobs. All heavy background jobs use `schedulerDb` from `src/services/schedulerDb.ts` (dedicated `pg.Pool`, `SCHEDULER_DB_POOL_MAX`, default 3), isolated from the main API pool (`DB_POOL_MAX`, default 50). Background jobs cannot starve API requests regardless of how long they take. When adding a new scheduled job, route it through `schedulerDb`, NOT the main `db` export. `schedulerDb` also sets `app.is_super='on'` on every connection, so it **bypasses Row-Level Security** — correct for cross-school jobs, but it means a scheduler query is NOT school-scoped (see "Database-Level Tenant Isolation (RLS)").

### ClassPilot Teacher Dashboard Commands
Teacher Dashboard actions are student-scoped, exact-binding, and outcome-driven:

- **Owned-class route**: `POST /api/classpilot/commands` accepts `{ teachingSessionId, targetScope: "class" | "subgroup" | "students", targetStudentIds?, subgroupId?, commandType, commandPayload }`. Only immutable `classpilot_session_staff` may mutate the session; Observe access is read-only even for administrators.
- **Claimed-coverage route**: `POST /api/classpilot/coverage/contexts/:contextId/commands` accepts only the coverage allowlist documented under School Isolation. Teacher FAB, Live View, timers, polls, attention, sign-out, temporary unblock, tab limit, and removal commands are not coverage capabilities.
- **Transaction-frozen authority**: command creation freezes roster membership, supervision ownership, target student IDs, and the current student/session/device binding. It rechecks the actor, uncached ClassPilot entitlement, current control owner, and exact binding under transaction locks. A missing or moved target becomes `unavailable`/`failed`; it never broadens to another student, class, or school.
- **Strict payloads**: keep `src/services/classpilotCommandValidation.ts`, the dashboard resolver, and extension behavior aligned. `unlock-screen` is exactly `{ screenOnly: true }` and preserves Flight Path. Flight Path removal is `remove-flight-path {}`. Tab close is either `{ closeAll: true }` or `{ tabsToClose: [{ studentId, tabRef, observedRevision }, ...] }` with 1–50 unique rows; URLs, patterns, and `specificUrls` are not tab identity or fallback. `student-sign-out` accepts `{}` only.
- **Persistence and results**: `classpilot_commands` stores the header and `classpilot_command_targets` stores frozen per-student binding, status, result/error, and timestamps. Statuses are `requested`, `sent`, `received`, `completed`, `failed`, `unavailable`, and `expired`. The dashboard must preserve every non-zero outcome, including partial cross-context failures, in per-student results rather than collapse them into a generic toast.
- **Persistent versus transient controls**: revisioned desired screen lock, Flight Path, block list, attention, tab limit, and temporary allows live in `classpilot_student_control_states` and reconcile after reconnect. Timers and polls are transient commands with a 15-second delivery TTL; the extension persists only exact-bound overlay state with an expiry. Poll data and responses live in `polls` and `poll_responses`, not in `classpilot_classroom_states`.
- **Durable command ACKs**: the extension keeps an exact-binding command ACK outbox and retries over WebSocket or `POST /api/classpilot/device/command-acks` until `command-ack-receipt` is accepted. Protocol-v2 ACK bodies remain supported, while an advertised explicit ACK envelope must agree with the authenticated tuple. The storage transaction then matches the command's already stored school/student/session/device target and current active binding; an ACK never creates or replaces authority. An offline durable teacher message acquires its first exact target binding when a current authorized heartbeat claims it. Normal transitions are monotonic `received`, `completed`, `failed`, or `expired`, with bounded result/error data. A current-authority durable `teacher-message` apply/persist failure is intentionally retryable: the server may return that target to `sent`/`received` and clear the failed ACK so heartbeat can redeliver; a stale-authority failure is terminal and suppressed. Accepted HTTP ACKs publish the same `classpilot-command-update` event as WebSocket ACKs.
- **Capabilities and public telemetry**: `/students-aggregated` and coverage serializers may expose public `tabSnapshot`, `tabSnapshotRevision`, `extensionVersion`, and capability flags, but never device IDs. Exact row close and screen-only unlock must safe-fail unless `exactTabCloseV1` and `screenOnlyUnlockV1` are advertised. Duplicate same-URL tabs remain distinct opaque refs; a stale ref returns a per-tab `stale_tab_ref` outcome.

### ClassPilot FAB, Chat, and Polls

- **Teacher FAB context**: render it only for the teacher's owned active class, label that class explicitly, and close its panels when context changes. It is hidden in Available, Claimed Coverage, and Observe-other modes.
- **Session settings**: mutate hand raising and student messaging with `PUT /api/classpilot/teaching-sessions/:id/settings` and `expectedRevision`. Immutable session staff and canonical entitlement are rechecked transactionally; a stale revision returns `409` with the current authoritative state.
- **Authoritative FAB state**: `fab-state-sync.data` carries the exact `studentId`/`studentSessionId`, ownership and lifecycle revisions, teaching session, active session IDs, toggle values, and active hands. Full state fans out on session start/end, settings changes, and coverage claim/release. Claimed students receive an authoritative disabled/empty FAB state; stale ownership, session, or identity frames must be rejected.
- **Chat durability**: student and teacher FAB writes are transaction-authorized and text is capped at 500 characters. A capable durable student retry carries its original teaching `sessionId`; the server compares it with the current locked authority before inserting, so an S1 outbox entry can never be delivered to a replacement S2 teacher. The missing field is accepted only for legacy clients. Teacher replies use durable delivery/outbox rows. Chat acknowledgements use their own exact-bound WebSocket/HTTP `/api/classpilot/device/chat-acks` protocol and `chat-message-ack-receipt` keyed by `messageId`; never mix chat ACKs with command ACKs.
- **Poll contract**: polls start and close only through canonical commands. Only one poll may be active per teaching session (`409 POLL_ALREADY_ACTIVE`); close fans out to the frozen original start targets. Device auth occurs before the per-session response limiter. Responses are exact command-binding-authorized and first-write-wins (`409 POLL_ALREADY_ANSWERED`). The authoritative expiry is no later than session end or 12 hours and is included in start/restore state.
- **Session finalization**: use the centralized lifecycle path to close polls, clear or recompute FAB/chat/control state, release Live View, and fan out exact-binding classroom and FAB snapshots. Do not add a bare device `session-ended` event that can wipe a replacement session's state.

### ClassPilot Realtime and Live View

- **Exact downstream binding**: student login/register, settings, heartbeat, and WebSocket `auth-success` expose top-level `schoolId`, `studentId`, `studentSessionId`, and `exactBinding: { studentId, studentSessionId }`; the device ID remains token/config/server-internal. Every student-specific command, FAB, classroom-state, chat, lifecycle, and Live View frame carries `studentId` plus `studentSessionId`. Protocol-3 exact-reference tab closures additionally carry an internal `exactBinding: { bindingVersion: 2, schoolId, deviceId, studentId, studentSessionId, controlRevision }`, frozen and rechecked under the command-authority lock; those internal fields never enter teacher DTOs, URLs, events, reports, or exports. Teacher commands carry session/context authority `{ teachingSessionId, supervisionContextId }`. The only school-policy authority forms are the tightly allowlisted AI-safety `close-tab` and school-settings `limit-tabs` frames, which carry `{ kind: "school_policy", schoolId, source: "ai_safety" | "school_settings" }`. The extension rejects late or mismatched frames before any side effect or ACK.
- **WebSocket bounds**: `src/realtime/websocket.ts` sets `maxPayload` to 256 KiB, bounds identifiers/SDP/candidates, serializes frames per socket, uses a token bucket (30-frame burst, 10 frames/second refill), and allows at most eight queued frames. Entitlement, membership, binding, and immutable staff authority are revalidated; revocation closes the socket and clears presence.
- **Coverage telemetry**: ownership transitions increment the control revision and fan out both classroom and FAB state. Assigned coverage staff receive supervision-context-bound realtime telemetry. A delayed former-class update must fail the same locked ownership/binding check rather than leak after a claim.
- **Coverage hydration hot path**: coverage queues bulk-load active sessions, direct-group membership, supervision-group membership, staff, and realtime state. Realtime reads must retain the exact school/student/student-session/device binding internally, while teacher responses expose no device or student-session identifiers. The `classpilot_coverage_hydration_hot_path` log is a once-per-minute, fixed-name aggregate of student count, session SQL statements, Redis batches, and elapsed time; never add tenant, person, device, token, request, or URL dimensions. The 500-student target is at most one session query and one 500-binding Redis `MGET` within hydration, with the complete coverage response held to ten SQL statements and two Redis commands.
- **Live View**: require `liveViewNegotiationV1` and immutable session-staff authority; Observe-only administrators cannot start or receive signaling. Negotiations are signed and exact-bound to school, student, student session, device, teaching session, and requester. Only one claim may be active per student, setup expires after 90 seconds, and an established view has a 15-minute maximum. Socket/auth loss, tracking off, sign-out, ownership/session change, requester disconnect, or explicit stop must close tracks/peer state immediately.

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
- An actual admin recurring-schedule change **clears** `scheduleSkippedDate` so a stale skip cannot block the new window. No-op class edits and Google Classroom imports preserve it.

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
- **Chrome extension release state**: The ClassPilot Chrome extension is MV3 and lives in the separate `C:\GitHub\ClassPilot` repository. The operator confirmed Chrome Web Store listing `iggbfegfcjkfieoemeolfmfnapepalca` is live at `2.7.0` on August 23, 2026. The separate repository contains the coordinated `2.7.1` repair candidate. Confirm the listing again immediately before upload. Use `console.warn` rather than routine `console.error` because Chrome surfaces the latter as visible extension errors to school IT.
- **Canonical packaging**: From a clean tagged ClassPilot commit in the ClassPilot repo root, run `./extension/package-extension.sh`. It reads the manifest, validates the packaged manifest version, and creates the Web Store artifact `dist/ClassPilot-v2.7.1.zip` plus compatibility copy `dist/classpilot-extension.zip`. Inspect the archive for root-level `manifest.json` and `managed_schema.json`, compare it byte-for-byte with source, and retain its SHA-256 before upload. A SchoolPilot deploy never publishes or updates the extension.
- **Protocol v2 capabilities**: registration/login, heartbeat, and WebSocket auth advertise `classroomStateV1`, `fabStateRevisionV1`, `exactTabCloseV1`, `screenOnlyUnlockV1`, `durableChatAckV1`, `commandAckReceiptV1`, `classroomOverlayRestoreV1`, and `liveViewNegotiationV1`. The public telemetry contract reports a minimum extension version of `2.6.0`, but features must be gated by advertised capabilities rather than version inference alone.
- **Protocol v3 repaired-client gate**: `scopedAuthorityChecksV1` proves that the client scopes `authBoundTelemetryV1`, `exactBindingAckV2`, and `exactTabCloseV2` independently. The server must refuse those three capabilities unless the marker is advertised and accepted; never infer repair status from `2.7.1` text. Protocol-3 selected-tab controls require accepted `exactTabCloseV2`; protocol-2 clients retain negotiated V1 behavior. The full activation and rollback contract is `docs/CLASSPILOT_2_7_1_RELEASE.md`.
- **MV3 lifetime rules**: The awake worker owns one scheduled 10-second heartbeat. Chrome's heartbeat alarm is recovery-only when that cadence becomes stale; it is not a second steady-state heartbeat source. Screenshots use an independent 30-second alarm subject to the negotiated observation policy. Async offscreen/runtime messages must keep the MV3 event alive until ordered side effects, storage, and ACK work settle.
- **Offscreen ownership**: `offscreen.js` owns the long-lived WebSocket and WebRTC peer/capture lifecycle; the service worker serializes relayed frames and owns exact-binding policy/state. Intentional or unexpected socket closure, auth invalidation, tracking off/off-hours, and Live View expiry must stop capture and reset negotiation state. Do not move these connections into a content script.
- **Extension deployment**: Managed deployments normally force-install through Google Admin (Devices → Chrome → Apps & extensions), with the required screen-capture policies. The release sequence is live-version check → manifest bump → canonical package script → archive inspection → Chrome Web Store upload/review → staged managed-browser adoption. Keep backend, frontend, and extension compatibility additive during rollout.
- **Durable delivery**: command ACKs and teacher-chat ACKs are separate exact-binding outboxes, each retrying over WebSocket and HTTP until its matching receipt. Command ACK receipts retain `accepted` and add `disposition: applied | idempotent | terminal_rejected`; a matched `retryable: false` terminal receipt drains only its exact outbox entry, while transport/infrastructure failures and mismatched receipts remain queued. Command-linked pending messages remain heartbeat-eligible only while unacknowledged, unexpired, and currently authorized; a handoff or terminal outcome suppresses stale delivery.
- **Screenshot pipeline**: In negotiated lease mode, the extension captures with `chrome.tabs.captureVisibleTab` (JPEG quality 50, normally ~30–50 KB) every 30 seconds only while an authorized observer holds an exact student/session lease. The server may explicitly retain legacy mode during staged rollout. An exact-bound safety request may attempt one capture independently before closing its exact tab. Uploads use `POST /api/device/screenshot`; Redis retains the latest image for 120 seconds. New writes use an exact school/device/student/student-session key and payload plus one-TTL device-key compatibility write; legacy payloads are accepted only for the current authorized student/session on that globally unique device and within the same freshness bound. Teacher UI uses student-scoped batched `POST /api/classpilot/tiles/screenshots` and `/api/classpilot/tiles/history`; it never requests or exposes a device ID. `screenshotHealth` diagnostics remain public monitoring metadata on `/students-aggregated`.
- **WebSocket reconnect for IDLE**: `connectWebSocket()` and `scheduleWsReconnect()` allow both ACTIVE and IDLE tracking states; only OFF blocks them. Otherwise an IDLE student that loses the socket could continue heartbeating but lose teacher/FAB realtime control.

### Compliance & Legal Documents
- **`docs/WISP.md`** — Written Information Security Program. Referenced by Privacy Policy for breach notification procedures. Provided to customers/assessors under NDA.
- **Privacy Policy** (`schoolpilot-app/src/pages/legal/PrivacyPolicy.jsx`): FERPA School Official, COPPA, 45-day parent access, 72-hour breach notification, 30-day data return/destruction on contract end, no-data-mining clause.
- **Terms of Service** (`schoolpilot-app/src/pages/legal/TermsOfService.jsx`): Ohio governing law, AAA arbitration (public school districts exempt), liability cap at fees paid in prior 12 months, DPA/SDPA/NDPA incorporation by reference.
- **Entity**: Schoolpilot is an Ohio LLC. Use "Schoolpilot" in user-facing copy and "Schoolpilot LLC" in legal documents when the full legal name is required.
- **iKeepSafe FERPA/COPPA certification**: demo parent accounts are created by `seeds/005_demo_parents.ts` and linked to students via the `parent_student` table for assessor user-simulation testing. Look up the demo credentials in the seed script or your secrets store — per the secrets-hygiene policy below, never record passwords in this file.

### Student Identity Resolution (CRITICAL)
The students table is shared across all 3 products. Several layers of identity resolution exist:
- **Email is an automatic discovery path, not runtime authority**. Managed Chrome-profile registration uses `chrome.identity.getProfileUserInfo()` and `resolveSchoolForStudent(email)`, while shared-Chromebook flows also support PIN and name/email/ID login. Authenticated wire responses expose `{ schoolId, studentId, studentSessionId, exactBinding: { studentId, studentSessionId } }`; runtime authority additionally binds the device ID from token/config/server state without exposing it to teacher-facing APIs.
- **`students.emailLc` MUST be set on every insert/update** — this is the column used for case-insensitive lookups by `resolveSchoolForStudent()`. The shared `normalizeStudentBody()` helper in `src/routes/students.ts` handles this for POST/PUT/PATCH. Extension auto-registration in `devices.ts` also sets it explicitly.
- **Auth adoption is serialized and generation-fenced**. Profile registration, manual login, worker startup restore, sign-out, entitlement revocation, and session replacement must not resurrect an older identity. Invalidating a binding immediately blocks side effects, clears exact-bound FAB/overlay/inbox/outbox/tab state, and stops Live View before best-effort network cleanup.
- **`/students-aggregated` is a public student-scoped projection**. It exposes authorized realtime telemetry, opaque tab snapshot/revision, extension version, capability flags, and `devices: []`; internal student-session/device bindings stay server-only. Teacher screenshots and history are resolved from student scope on the server, never from a `primaryDeviceId` supplied to the UI.
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

### PassPilot kiosk API

- Public kiosk requests require `X-School-Id` plus either `X-Kiosk-Token` or the compatibility `X-Kiosk-Pin`. `POST /api/passpilot/kiosk/auth` exchanges a valid PIN for a 15-minute token; current school lifecycle, PassPilot license, kiosk enablement, and PIN-hash state are rechecked on every request, so revocation or PIN rotation takes effect immediately.
- `GET /api/passpilot/kiosk/snapshot?classId=...` is the bounded polling contract. It returns config, the optional teacher-bound kiosk session, roster students, active passes, revisions, and an ETag. The existing `/config`, `/students`, and PIN routes remain available during migration.
- `POST /api/passpilot/kiosk/client-health` accepts only the bounded `snapshot_failure` / `snapshot_recovery` enum contract after at least three consecutive failures. Event types are rate-limited for five minutes using an opaque Redis key with a bounded local fallback.
- `POST /api/classpilot/kiosk/launch-ticket/preflight` requires `X-School-Id` plus that exact school's `X-ClassPilot-Enrollment-Key`, applies no-store/rate-limit policy, and negotiates `scopedAuthorityChecksV1` plus `kioskLaunchTicketV2` without a directory identifier. The extension must not call `chrome.enterprise.deviceAttributes` unless this preflight accepts V2.
- `POST /api/classpilot/kiosk/launch-ticket` revalidates the exact school/key, ClassPilot and PassPilot entitlements, school lifecycle, kiosk configuration, Redis, and accepted ticket capability. V1 remains a disabled 60-second compatibility path. V2 returns a one-use 600-second ticket and immediately reduces the raw directory identifier to the new school-scoped HMAC ID plus the exact legacy 2.6.9 deterministic ID; only those opaque identifiers, the school, and bounded timestamps enter Redis. The raw identifier is never stored, logged, returned, or placed in a URL.
- `POST /api/passpilot/kiosk/launch-ticket/redeem` requires current kiosk PIN/token authorization before consuming the ticket. It returns only `continuityOnly: true` plus an opaque school-scoped UUID-shaped `deviceId`; this ID preserves same-school kiosk continuity and is never a kiosk credential. Tickets are HMAC-keyed and atomically consumed with Redis `GETDEL` in production.
- Public kiosk hot paths execute tenant queries inside one RLS checkout. Kiosk tokens, PINs, device IDs, session IDs, and school/student identifiers must never be added to kiosk metric labels or logs. Student roster DTOs remain separate from kiosk/Chromebook device records.

## Environment Variables

Copy `.env.example` to `.env`. Required for local dev:
- `DATABASE_URL` — PostgreSQL connection (default: `postgresql://schoolpilot:schoolpilot_dev@localhost:5435/schoolpilot`)
- `REDIS_URL` — Redis connection (default: `redis://localhost:6380`; production ElastiCache with required transit encryption uses `rediss://...`)
- `APP_ENV` — Runtime environment dimension for CloudWatch embedded metrics (`production`, `staging`, `development`)
- `RUN_MIGRATIONS_ON_STARTUP` — Defaults to `false` everywhere and is rejected when enabled in production; use the explicit one-off migration task instead
- `RUN_MIGRATIONS_ONLY` — One-off migration task mode used by `npm run migrate:startup` / `scripts/deploy.sh`
- `SCHEDULER_ENABLED` — `false` for web ECS tasks, `true` only for the singleton scheduler worker
- `DB_POOL_MAX` / `SCHEDULER_DB_POOL_MAX` — Main API and scheduler Postgres pool caps
- `SESSION_SECRET`, `JWT_SECRET`, `STUDENT_TOKEN_SECRET` — Auth secrets. Kiosk tokens use `KIOSK_TOKEN_SECRET` when configured and otherwise share `JWT_SECRET`; `KIOSK_HEALTH_HMAC_SECRET` may independently rotate the opaque client-health rate-limit keys. `CLASSPILOT_KIOSK_TICKET_HMAC_SECRET` independently rotates launch-ticket keys and managed-device continuity projections (falling back to the kiosk/JWT secret when omitted).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth
- `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY` — Current AES-256-GCM key for admin-visible ClassPilot student PIN ciphertext (the legacy name is retained for compatibility)
- `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS` — Optional previous PIN key used only during a staged dual-read/current-write rotation; remove after the counts-only migration and rollback window pass
- `SUPER_ADMIN_EMAIL` — Email address that gets super admin privileges
- `CORS_ALLOWLIST` — Comma-separated frontend origins
- `CLASSPILOT_PROTOCOL_V3_ENABLED` plus the per-capability flags are kill switches. `CLASSPILOT_CAPABILITY_ROLLOUTS_JSON` optionally supplies fail-closed `off`, `observe`, `canary`, or `on` policy per capability, with optional `schoolIds` and a deterministic school-level `canaryPercent`. Capability acceptance still requires a protocol-v3 client advertisement from the current exact binding, and the three repaired authority capabilities additionally require accepted `scopedAuthorityChecksV1`. For 2.7.1 the flags are temporary deployment/emergency controls; after the managed gate, every repaired capability except superseded `kioskLaunchTicketV1` must be globally `on` per `docs/CLASSPILOT_2_7_1_RELEASE.md`.
- `CLASSPILOT_SESSION_REPORT_V2_MODE` controls immutable session-report rollout with `legacy`, `shadow`, or `on`. Missing or malformed values fail closed to `legacy`. `shadow` persists, exposes, and emails the exact v1 contract while computing v2 without writes and emitting identifier-free aggregate mismatch, invariant, and timing metrics. `on` creates v2 rows; every materialization, API/CSV presentation, and email dispatch continues to follow the version stored on its report row, so existing v1 rows never change behavior when the environment changes.
- `CLASSPILOT_TURN_HOSTS`, `CLASSPILOT_TURN_REST_SECRET`, and optional `CLASSPILOT_STUN_URLS` provide the dark `liveViewIceServersV1` runtime. Client outcome telemetry is accepted only for a still-active exact-bound negotiation and emits identifier-free metrics; deployment and alarm details live in `docs/CLASSPILOT_TURN_OPERATIONS.md`.
- `SENDGRID_API_KEY` — SendGrid email service (session reports, safety alerts, welcome emails)
- `ANTHROPIC_API_KEY` — Anthropic Claude API for AI content classification + chat assistant
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — Stripe billing
- `SENTRY_DSN` — (optional, gated off) Sentry error tracking. Leave unset until DPA signed + added to subprocessors. See "Sentry" section below.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — (optional) developer error alerts via Telegram
- `RLS_GUC_ENABLED` / `RLS_ENABLED_TABLES` — (prod, ECS task def) master switch + per-table allowlist for the Row-Level Security enforcement described under "Database-Level Tenant Isolation (RLS)". Leave unset locally unless testing RLS.
- `SOC2_DASHBOARD_GITHUB_TOKEN` — (prod, ECS task def) GitHub token used only by the Super Admin SOC 2 dashboard to read issue #146, workflow status, code/secret-scanning counts, and dispatch the configured CI workflow. Missing or under-scoped tokens must degrade to partial dashboard data.
- `SOC2_DASHBOARD_REPO`, `SOC2_APPROVAL_ISSUE_NUMBER`, `SOC2_DASHBOARD_WORKFLOW` — optional SOC 2 dashboard overrides; defaults are `bzinkan/SchoolPilot`, `146`, and `ci-build.yml`.

### Secrets hygiene — NEVER commit keys

- `.env`, `.env.local`, `.env.production` are in `.gitignore` — keep all real secrets there.
- **Never** paste API keys, passwords, or tokens into source files, commit messages, PR descriptions, GitHub issues, or `CLAUDE.md`. Gitleaks runs on every push and will fail CI if a secret pattern leaks.
- Production secrets live in the ECS task definition (or AWS Secrets Manager) — not in any committed file.
- Terraform references application runtime secrets by deterministic/external SSM parameter ARN only. Do not add application secret-value variables back to `infra/variables.tf`, module inputs, tfvars, resources, plans, or state; `REDIS_URL` is the sole topology-derived SecureString that remains Terraform-managed.
- Before the first plan after adopting the detached-secret configuration, run `scripts/terraform-detach-application-secret-state.ps1` with verified DPAPI and AES-GCM backup paths. It removes only the ten historical `module.ecs.aws_ssm_parameter.*` bindings via `terraform state rm`, preserves the live parameters and Redis binding, and prevents a first forget plan from carrying prior values in `terraform show -json`.
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

- Read `SOC2.md` before doing SOC 2 work. It is the agent runbook for sources of truth, automation boundaries, and command selection; the official control and evidence records remain under `docs/soc2/` and the private evidence repo.
- Run `npm run soc2:check` whenever changing `docs/soc2/`, `docs/WISP.md`, `docs/HECVAT-LITE.md`, public security/privacy/legal claims, remediation registers, control matrices, claim registers, or SOC 2 evidence scripts.
- Run `npm run soc2:privileged-access-evidence` whenever changing auth, role checks, school context enforcement, session controls, security monitoring, audit logging, `SOC2-003`, or `SP-SEC-001` evidence docs. This command is evidence-only and must not enable MFA, change login behavior, revoke sessions, or query production users.
- Run `npm run soc2:privileged-access-private-evidence-kit -- --private-dir ../SchoolPilot-SOC2-Evidence` to create private draft access-review, user/role export, and MFA-deferral records. Drafts are not approvals; the founder/security owner must complete factual fields before approval.
- Run `npm run soc2:deployment-evidence` whenever changing CI/deploy evidence behavior, `scripts/deploy.sh`, `Dockerfile`, package lock files, or `SP-SEC-004` evidence docs.
- Risk-acceptance drafts are generated from `docs/soc2/remediation-register.md` according to `docs/soc2/risk-acceptance-policy.json`. Current policy drafts P0/P1 items with `Open` or `In progress` status.
- Generated packets and drafts are written under `soc2-evidence/`, including `soc2-evidence/risk-acceptances/` and `soc2-evidence/deployments/`; this folder is ignored by Git and must not be committed.
- Automation may prepare risk records, owners, risk levels, expiration dates, and suggested compensating controls, but it must not approve risk acceptances. Drafts remain `Draft - pending founder approval` until the founder/Security & Privacy Officer signs off.
- Deployment evidence automation must remain shadow-only unless a later task explicitly implements protected deploys: do not add AWS credentials, ECS/S3/CloudFront changes, or production approval bypasses to evidence collection.
- Privileged access evidence automation must keep MFA status as deferred unless a later task explicitly implements MFA; do not add user-facing MFA prompts, login changes, AWS changes, session revocation, or production DB exports to CI.
- Super Admin SOC 2 dashboard changes must stay read-only except for triggering GitHub Actions `workflow_dispatch`; do not add in-app approve/reject buttons or expose private evidence document bodies.
- If changing risk automation rules, update `docs/soc2/risk-acceptance-policy.json` and the SOC 2 governance tests together.

The frontend uses React Compiler lint rules. Common gotchas:
- `form.watch()` from React Hook Form is incompatible — extract to a variable (e.g., `const watchedRole = form.watch("role")`)
- Sync `setState` in `useEffect` triggers `set-state-in-effect` — wrap in `requestAnimationFrame()`
- `useCallback` deps must match what the compiler infers — include state setters if referenced

### Required Test Gates

- **Backend**: run `npm run check`, `npm run build`, and `npm test`. Backend tests run serially because integration cases share the local PostgreSQL fixture; do not parallelize them against the same database.
- **ClassPilot frontend** (`schoolpilot-app/`): run `npm run lint`, `npm run build`, and the focused gates `npm run test:classpilot-tile-batching`, `npm run test:classpilot-session-lifecycle`, `npm run test:classpilot-realtime-cache`, `npm run test:classpilot-signal-loss`, `npm run test:classpilot-command-context`, and `npm run test:classpilot-radix-browser` when dashboard, tiles, command targeting, realtime, dialogs, or FAB behavior changes.
- **ClassPilot extension** (separate `C:\GitHub\ClassPilot` repo): run `npm run check`, `npm test`, `npm run test:extension:chrome`, and `npm run build`. The real-Chrome resilience gate is required for MV3 lifetime, exact-binding, auth restore, WebSocket ordering, Live View, FAB, poll, and ACK changes; Node/static tests alone are not sufficient.
- **Release hygiene**: run `git diff --check` in both repositories. Before packaging, keep the manifest release guard aligned with `extension/manifest.json`, then run the canonical package script and inspect the resulting ZIP.

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
- Auth: JWT Bearer tokens (no cookies on native), persisted only through the repository-controlled `schoolpilot-app/plugins/capacitor-secure-storage-plugin` fork (Android Keystore AES-256-GCM, API 24+, no plaintext fallback); authentication fails closed if secure storage or protected readback is unavailable
- `useGoPilotAuth` hook adapts unified AuthContext to GoPilot-specific shape

### GoPilot Staff-Only Flow
1. GoPilot parent registration, linking, portal, QR arrival, change requests, and parent sockets are permanently disabled with `GOPILOT_PARENT_PORTAL_DISABLED`.
2. Administrators and office staff add car riders by internal car number or direct family/student search. Bus and walker workflows remain staff operated.
3. Teachers see only assigned students and may acknowledge/release them; teachers cannot add arrivals.
4. Office staff retain final dismissal authority. Session reset and queue transitions remain audited.
5. Historical parent accounts, links, requests, and dismissal records remain stored under existing retention rules but grant no GoPilot access.

#### GoPilot containment and rollout runbook

1. Deploy the backend containment behavior first and verify every retired parent route and parent socket handshake returns `410 GOPILOT_PARENT_PORTAL_DISABLED`. Never roll back by re-enabling those endpoints.
2. From a controlled one-off task using the exact reviewed backend image and production database network configuration, run the ID/count-only inventory before the schema/RLS rollout:
   ```bash
   npm run audit:gopilot
   # or narrow the report without exposing names, emails, car numbers, or tokens
   npm run audit:gopilot -- --school-id <school-uuid>
   ```
   Review parent memberships/links, pickup approvals without staff evidence, duplicate queue/family rows, weekend or unlicensed sessions, invalid states, completed sessions with open queue entries, and orphan totals. Resolve every migration-blocking count deliberately; do not delete retained history simply to make the report clean.
3. Deploy the additive GoPilot schema and normalized staff APIs backend-first with the exact seven-table RLS bundle documented below. Wait for the old API tasks to drain and verify migration, RLS, Redis-relay health, scheduler skips/starts, queue metrics, alarms, and public health before publishing the web client.
4. Publish the staff web client. Pilot car-number and direct-search arrivals with synthetic students under separate office and teacher accounts before a live dismissal.
5. Release Android separately only after rotating the historical GoPilot upload/signing credential through the distribution provider, building with protected `GOPILOT_KEYSTORE_*` secrets, inspecting the signed AAB, and confirming the staff-only version is adopted. Retain the temporary staff car-number compatibility alias until that adoption is verified.

The inventory CLI is read-only and must remain school-ID/count-only. It never changes parent links, pickups, queue rows, invitations, or sessions.

### GoPilot Socket Events
- `dismissal:started` — emitted when an administrator starts a session
- `dismissal:ended` — emitted when an administrator ends a session
- `student:checked-in` — office adds a student to the queue
- `student:called` — office calls student
- `student:dismissed` — office completes pickup
- `student:released` — teacher releases student

## Production Deployment

Infrastructure is on AWS (us-east-1):
- **ECR**: `135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api`
- **ECS**: Cluster `schoolpilot-production-cluster`, services `schoolpilot-production-api` and `schoolpilot-production-scheduler-worker`
- **RDS**: PostgreSQL in private VPC (not directly accessible - run the deploy-script migration task for schema changes)
- **S3**: `schoolpilot-production-frontend` (static frontend assets)
- **CloudFront**: Distribution `E1TPPJOD7C2CXR`

### Schema Changes
Since production RDS is in a private VPC, `drizzle-kit push` cannot reach it directly. Instead:
1. Add the Drizzle schema definition in the appropriate `src/schema/*.ts` file (e.g., `gopilot.ts` for GoPilot tables, `classpilot.ts` for ClassPilot, etc.)
2. Add an immutable migration entry in `src/db/migrations27.ts` (or the next versioned migration module), with a checksum, explicit transactional/nontransactional mode, and fail-closed SQL. New tenant tables must enable and FORCE RLS in that migration and be added to `src/config/rlsRegistry.json`.
3. Let `scripts/deploy.sh` run the ledger-backed migration ECS task before web/worker rollout; do not rely on scaled web tasks to apply DDL. The legacy `runStartupMigrations()` path is for non-production bootstrap only.

### GoPilot Dismissal Override System
Session-scoped dismissal type changes (car/bus/walker/afterschool) for today only, controlled by administrators, school administrators, and office staff:
- **Table:** `dismissal_overrides` (schema in `src/schema/gopilot.ts`, auto-migration in `src/index.ts`)
- **Storage functions:** `src/services/storage.ts` — `upsertDismissalOverride`, `deleteDismissalOverride`, `getOverridesForSession`, `getEffectiveDismissalType(s)`
- **API endpoints** in `src/routes/gopilot/dismissal.ts`:
  - `POST /sessions/:id/override` — create/update override (administrators, school administrators, and office staff only)
  - `GET /sessions/:id/overrides` — list all overrides for session
  - `DELETE /sessions/:id/override/:studentId` — revert to permanent default (administrators, school administrators, and office staff only)
- **Socket event:** `dismissal:override` emitted to authorized office and teacher rooms through the local-plus-Redis GoPilot broadcaster
- **Queue integration:** Staff car-number/search, bus, and walker arrivals use `getEffectiveDismissalTypes()` to respect overrides. Afterschool students are excluded from queue.
- **Frontend:** Override mutation UI appears only in administrator/office views. Teachers see the effective same-day type for their assigned students but cannot create or revert overrides.

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

**Health endpoints:** `/livez` is the lightweight liveness endpoint used by ECS container health and the ALB target group; keep it session-free and DB-free. CloudFront intentionally does not expose a separate `/livez` behavior. Public `/health` is cheap external uptime (`{"status":"ok"}`) for Route53/synthetic checks. Detailed operational health is available only with `HEALTH_TOKEN` via `x-health-token` or `?token=...`; that detailed response includes `recentErrors`, `checks.alerting`, and `checks.monitoring` with monitor stats/runtime metadata plus `checks.monitoring.aggregation` (`mode: "redis" | "local"`). If alerting is the only degraded check, detailed `/health` still returns HTTP 200 with JSON status `degraded`; core subsystem failures return 503.

**Super Admin Monitoring panel:** `/super-admin/monitoring` is the read-only operations view for the monitor. APIs live under `/api/super-admin/monitoring/*` and require super-admin auth plus the existing RLS super-admin bypass. The Schools page may show only a compact status chip/link, not a large monitoring dashboard section. Phase 4A intentionally has no schema changes, no mute/acknowledge controls, and no durable incident workflow; live fingerprint history comes from in-process/Redis aggregation, while recent events come from existing sanitized `error_logs`. The panel must never show raw query strings, request bodies, tokens, emails, IPs, student names, device ids, unrestricted context, or raw security-event details.

**Browser/extension runtime telemetry:** Browser telemetry is operational error capture only, not analytics. The web app installs capture before React renders, dedupes per tab, and sends only sanitized message/stack/path/component/release/browser details. The ClassPilot extension service worker imports the vendored Sentry browser SDK and initializes it only when the extension DSN is configured; it is the only network sender. Offscreen/content-script failures relay typed sanitized reports through `chrome.runtime.sendMessage`, and content scripts must never capture arbitrary host-page JavaScript errors. Extension release remains separate: confirm the live Chrome Web Store version, bump `ClassPilot/extension/manifest.json`, run `./extension/package-extension.sh`, inspect the archive, upload, and wait for review.

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
- **Evidence packets**: `POST /classpilot/evidence-packets` creates a packet manifest; `GET /classpilot/evidence-packets/:id/download` returns a ZIP with JSON, CSV, HTML, and available artifacts. Screenshot storage and safety evidence are internally bound to school, device, student, student session, capture time, and binding version. A safety artifact is available only when a fresh screenshot matches that exact tuple and classified tab; every mismatch is recorded explicitly as unavailable. Device/binding internals are stripped from packet DTOs, manifests, and downloads.
- **Context-aware monitoring**: `/students-aggregated` includes `attendanceStatus`, `activePass`, `dismissalStatus`, `monitoringContext`, and `suppressionReason`. Classroom off-task noise is suppressed for absent/on-pass/dismissal states, but critical safety alerts still display and log.
- **Parent transparency**: GoPilot parent digests and dismissal content are retired. Historical parent-link and digest settings remain retained but must not grant GoPilot access or trigger GoPilot email. Do not change unrelated product communication policy by reusing those links.
- **Classroom Flight Paths**: Google OAuth includes read-only coursework/material scopes. `/google/classroom/courses/:courseId/resources` extracts Classroom links, and `/classpilot/flight-paths/from-classroom` creates source-tagged Flight Paths using hostname-level enforcement for every HTTP(S) resource, including YouTube. The response exposes `domainLevelEntries`, `enforcementLevel: "hostname"`, and an explanatory warning; never promise per-video URL enforcement. Empty Flight Paths may remain drafts, but canonical apply fails with `409 FLIGHT_PATH_EMPTY`.

### Student Detail Drawer (ClassPilot)
The student sidebar (Screens, Timeline, History) is student-scoped and bound to the active teaching/supervision context:
- Teacher UI batches current screenshots with `POST /api/classpilot/tiles/screenshots` and history with `POST /api/classpilot/tiles/history`; the server resolves the exact internal binding and never returns or accepts a teacher-facing device ID.
- History is constrained to the authorized active session/context window, and a binding/ownership change clears stale image, tab, classification, and capability state before applying the next revision.
- The class badge shows the active group name (for example, "Science"), while coverage views identify the supervision context. Fetch failures must remain distinguishable from signed-out, signal-lost, stale, unauthorized, and genuinely empty states.

### PassPilot Pass Data Analytics
Teacher My Class tab includes a collapsible "Pass Data" section showing:
- Time period filter (Today/Week/Month/Year), default Today
- All students ranked by pass count (including 0 passes)
- Click student for per-student destination breakdown with Class/Student tab switcher
- Export CSV button for current view (class-wide or individual student)
- Pass history API uses opaque keyset pagination (`limit <= 500`, `nextCursor`, `hasMore`). Reports and CSV exports must follow every page; never silently truncate.

### PassPilot Class Source
- `settings.passpilot_class_source` is the only authority: `legacy_grades` preserves standalone PassPilot behavior, while `classpilot_groups` uses active official ClassPilot `admin_class` groups, `group_students`, and primary/co-teacher assignments.
- Never infer the source from licenses and never dual-write live rosters. Existing schools cut over only through the reviewed migration. New-school provisioning also requires explicit `passpilotClassModelAcknowledged: true`; licenses alone leave the school in legacy mode.
- Canonical-aware web/native/kiosk requests send `X-PassPilot-Class-Model: classpilot-groups-v1`. Canonical schools reject old clients rather than synthesizing grades or collapsing many-to-many membership into `students.grade_id`.
- Class mappings preserve legacy history only. Canonical passes write `passes.classpilot_group_id` and `class_name_snapshot`; historical `grade_id` values and labels are never rewritten.
- Cutover, pass issuance, kiosk changes, official class/roster/teacher mutations, and ClassPilot license removal share the per-school PassPilot advisory lock. Do not add an alternate write path that bypasses it.
- The ClassPilot license cannot be removed while PassPilot is canonical. After the first canonical write, recovery is roll-forward; mixed-source reads remain supported.

#### Guarded clean-school cutover runbook

The clean-school CLI is only for an existing `legacy_grades` school that already has at least one active official ClassPilot `admin_class` and has **zero** PassPilot grades, passes of any status/class shape, `students.grade_id` assignments, teacher-grade assignments, kiosk class selections, prior canonical-write markers, or prior cutover markers. Active PassPilot and ClassPilot licenses are prerequisites, but licenses never establish readiness by themselves. Suspended, inactive, or deleted schools are ineligible.

1. Build and deploy the exact reviewed backend image, including startup migrations. Run this CLI only from a controlled one-off task with production RDS connectivity and that same digest; production RDS is not reachable from a workstation.
2. Dry-run one exact school (default mode; no source mutation):
   ```bash
   npm run migrate:passpilot-clean-schools -- --school-id <school-uuid>
   ```
   Or inventory every persisted legacy-source candidate using IDs and counts only:
   ```bash
   npm run migrate:passpilot-clean-schools -- --all-clean-schools
   ```
3. Review `eligible`, every reason, and every count. Resolve any non-zero legacy state through the normal PassPilot class-migration review; never delete history to make a school appear clean.
4. Execute only after web, native, and kiosk clients support `classpilot-groups-v1`. Execution requires the audited ID of an existing super administrator and the exact acknowledgement:
   ```bash
   npm run migrate:passpilot-clean-schools -- --school-id <school-uuid> --execute --super-admin-actor-id <user-uuid> --acknowledge-class-model classpilot-groups-v1
   ```
   `--all-clean-schools` may replace `--school-id`; it executes only rows that were eligible and pass the same eligibility check again inside the advisory-locked cutover transaction.
5. Require an `executed` outcome and the durable `passpilot.class_migration.completed` audit event. Re-run the single-school dry-run: it must report `source_not_legacy`; the school must no longer appear in `--all-clean-schools` output.

The CLI never runs from startup, a GET request, or scheduler work, and dry-run is always the default. Do not add license-based source inference or automatic retry. A failed or ambiguous execution is investigated and rolled forward through the reviewed migration path; do not manually switch the source back.

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
- **Recurring schedule boundary**: Class Management creates and edits the recurring `groups.schedule_*` / `groups.block_*` configuration. These writes are audited as `class.recurring_schedule_updated`; they do not create a dated schedule-change/swap record. No-op class edits and Google Classroom imports preserve `schedule_skipped_date`.
- **Session summary email**: `buildAndSendSessionSummary()` in `src/routes/classpilot/sessions.ts` is exported and called by both manual end and auto-end. Uses school timezone (not hardcoded ET).

### ClassPilot One-Day Schedule Changes
ClassPilot can exchange the scheduled time windows of two administrator-linked
official classes for one instructional date. This is a dated exception, not a
recurring schedule edit: teachers, co-teachers, rosters, and class ownership do
not move, and the normal `groups.block_*` schedule resumes the next day.

- **Eligibility:** administrators and school administrators configure exact
  eligible class pairs. Primary teachers may request and accept; co-teachers and
  office staff are view-only. Teacher requests default off and require the other
  primary teacher's acceptance. Administrator approval, the teacher same-day
  cutoff, and required teacher reasons are independent policies that default on.
  Disabling the cutoff never bypasses the absolute earliest affected-class start
  guard, and administrator-created changes always require a reason.
- **Authority:** `classpilot_schedule_change_pairs`,
  `classpilot_schedule_changes`, and `classpilot_schedule_change_legs` are the
  tenant-scoped workflow and effective-window authority. Never implement a
  one-day change by updating `groups.block_start_time` or `block_end_time`.
- **Effective schedule:** every pre-occurrence path—scheduler readiness,
  automatic/manual start, occurrence freezing, Skip Today, and scheduled
  conflict projection—must use the shared effective-window resolver. An
  approved leg suppresses the original window for that class/date.
- **Frozen history:** approval does not pre-create a teaching session. The
  canonical occurrence and roster snapshot are created at the effective bell;
  once created, the occurrence remains immutable. Skip Today skips only that
  class's effective occurrence and never falls back to the original window.
- **Concurrency:** request transitions, cancellation, Skip Today, and occurrence
  creation share the instructional-calendar school/date lock and deterministic
  class-row locks. Every workflow mutation is revisioned and audited.
- **UI:** teacher operations live under My Settings → Schedule Changes; admin
  pairing and operations live under Classes → Schedule Changes; policy lives in
  Admin Settings immediately before Privacy & Compliance. The Teacher Dashboard
  shows only a compact day-of indicator.

### Super Admin Features
- **Broadcast email**: POST `/super-admin/broadcast-email` sends to all school admins via SendGrid
- **Reset login**: POST `/super-admin/schools/:id/reset-login` generates temp password AND emails it to the admin
- **School inquiries**: Public `/get-started` submissions are reviewed in Super Admin before creating an active or suspended school.
- **Tax exemption**: Full S3 upload/download flow with Stripe tax-exempt status sync
- **Impersonation**: Session-based, stores `originalUserId` to restore after

### AI Chat (Backend Only — AI Assistant FAB Disabled)
Claude-powered chat assistant at `/api/ai-chat/*`. Only the unrelated AI assistant FAB is commented out in `App.jsx`; the ClassPilot teacher and student classroom FABs are active and follow the exact-binding lifecycle documented above. Backend AI chat routes remain mounted and use `ANTHROPIC_API_KEY` from the ECS task definition.

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
  /health             → ALB → ECS Fargate (port 4000), public cheap uptime
  /ws                 → ALB → ECS Fargate (port 4000)
  /gopilot-socket/*   → ALB → ECS Fargate (port 4000)
  /* (default)        → S3 (schoolpilot-production-frontend)
```

The ALB target group and ECS container health checks use `/livez` directly. Do
not add a CloudFront `/livez` behavior; public synthetic checks should use
`/health`.

### Component Details

| Component | Name / ARN | Notes |
|-----------|-----------|-------|
| **CloudFront** | Distribution `E1TPPJOD7C2CXR` | Two origins: `alb-api` (HTTPS-only ALB origin) and `s3-frontend` (S3); WAF attached |
| **ALB** | `schoolpilot-production-alb` (`schoolpilot-production-alb-1532292365.us-east-1.elb.amazonaws.com`) | HTTPS listener forwards to ECS target group; target health path `/livez`; inbound HTTPS access is restricted to the AWS CloudFront origin-facing managed prefix list |
| **ECS Cluster** | `schoolpilot-production-cluster` | Fargate launch type |
| **ECS API Service** | `schoolpilot-production-api` | ClassPilot 2.7 capacity sizing: ordinary minimum 1 task, weekday 05:45–10:00 America/New_York arrival minimum 6, autoscaling maximum 6; each API task uses main=16 and session=2 connections, so six API tasks plus the 16-connection worker ceiling total 124. The selected launch-safe revision uses 512 CPU / 2048 MiB and the ALB target group. Re-enabling eight tasks requires a separately reviewed RDS Proxy or database-capacity decision. The cost rollout stages tasks from private to public subnets with a public IPv4 only after the baseline gate. |
| **ECS Worker Service** | `schoolpilot-production-scheduler-worker` | Launch sizing: 1 desired singleton scheduler worker at 256 CPU / 512 MiB, staged to the same public-task egress posture as the API; no ALB target registration. |
| **Task Definitions** | `schoolpilot-production-api`, `schoolpilot-production-api-emergency`, `schoolpilot-production-scheduler-worker` | API container named `api`, worker container named `scheduler-worker`, same digest-pinned image. The emergency family is pre-registered at 512 CPU / 2048 MiB and is never selected by the normal deploy path. |
| **ECR** | `135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api` | Images are pushed with a git-SHA tag and also `:latest`; ECS revisions pin by digest |
| **S3** | `schoolpilot-production-frontend` | Static frontend assets served by CloudFront |
| **RDS** | PostgreSQL in private VPC | Pilot sizing is `db.t4g.medium`, Single-AZ, 100 GB allocated with 1000 GB max autoscaling |
| **Redis** | ElastiCache replication group | Launch target is `cache.t4g.micro`, single node, TLS required via `rediss://`; retain `cache.t4g.small` until the snapshot and 800-device endurance gates pass. |
| **Region** | `us-east-1` | All resources |
| **Account** | `135775632425` | |

Production public traffic must enter through CloudFront at `school-pilot.net`.
Public IPv4 on launch ECS tasks is for direct outbound egress after NAT removal;
the ECS security group still accepts the API port only from the ALB security
group and the worker exposes no public application listener.
Direct local/browser access to `api-origin.school-pilot.net` is intentionally not
part of the verification path because the ALB security group allows only
CloudFront origin-facing IP ranges over HTTPS. Use public `/health` through
CloudFront plus ECS target health for deploy checks. ALB access logs are
delivered to the production ALB log bucket under `alb/AWSLogs/<account-id>/`.

### Deploy Sequence — Backend

**CRITICAL: Always build and deploy from this repo's root. Never deploy from any older prototype checkout — their schemas are incompatible with the production database.**

Preferred path:

```bash
./scripts/deploy.sh --backend
```

When production is intentionally retained on the launch-safe 512 CPU / 2048
MiB API posture, use the reviewed backend-only mode instead:

```bash
./scripts/deploy.sh production --backend --activate-emergency
```

For the single release that first enforces the ClassPilot session-summary
delivery outbox, use the explicitly reviewed additive RLS flag. Do not retain
the flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_session_summary_deliveries
```

For the single release that first adds the PassPilot legacy multi-class
membership table, use the same reviewed one-table path and omit the flag on
later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table passpilot_grade_students
```

For the backend-first ClassPilot bypass-resilience release, add and verify the
five direct-tenant monitoring/control tables as one indivisible reviewed
bundle. Do not split, reorder, or retain this flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_monitoring_events,classpilot_session_reports,classpilot_session_staff,classpilot_session_student_reports,classpilot_student_control_states
```

Keep Terraform's production allowlist at the deployed baseline until this
one-shot activation has completed and the live RLS catalog checks have passed.
Then land the observed allowlist as a separate baseline-adoption change before
any later Terraform apply.

For the first ClassPilot FAB durability release, add and verify the four new
direct-tenant state tables as one indivisible reviewed bundle. Do not split,
reorder, or retain this flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_chat_deliveries,poll_responses,polls,session_settings
```

That activation was verified on August 19, 2026. The semantic RLS registry
retains its exact observed 72-table live allowlist as an immutable audit
snapshot. `infra/production.tfvars` now describes the separate 75-table 2.7.0
post-expand target; it is not evidence that the target is already live. Do not
apply it until the additive tables pass the reviewed migration/catalog gate.
Ordinary later deploys omit the flag. Do not use the Terraform baseline to bypass
a deliberate per-table kill-switch; reversing one still requires the reviewed
one-shot path and successful live FORCE RLS, tenant-policy, and catalog checks.

For the SchoolPilot 2.7.0 additive persistence expansion, use the exact
three-table bundle only when all three tables are absent from the live
allowlist:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_evidence_capture_requests,passpilot_kiosk_devices,passpilot_kiosk_sessions
```

Production was verified at 74/75 on August 22, 2026: both kiosk tables were
already admitted and only `classpilot_evidence_capture_requests` remained.
Resume that rollout with the reviewed singleton below; the deploy guard rejects
tables that are already enabled:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_evidence_capture_requests
```

Either valid starting state reaches the same 75-table target without changing
the intentionally distinct ClassPilot FAB re-admission bundle. Omit the flag
from later deployments.

For this ClassPilot release family, deploy in compatibility-safe stages:

1. Run and verify the backend migration task first, including the exact
   four-table one-shot RLS bundle, FORCE RLS policies, parent-binding triggers,
   canonical entitlement, and mixed-version protocol behavior. Do not roll API
   or worker tasks if the migration/catalog checks fail.
2. Deploy the SchoolPilot API/frontend only after the backend contract is live.
   Frontend controls must remain hidden or safe-disabled until the relevant
   extension capability is advertised; never infer support only from a version.
3. Release the Chrome extension separately from `C:\GitHub\ClassPilot`. The
   current Web Store version is operator-confirmed `2.7.0` (August 23, 2026),
   and the separate repository contains the coordinated `2.7.1` repair
   candidate. Immediately before upload, re-check the listing, build from the
   clean tagged commit with `./extension/package-extension.sh`, inspect and
   hash the versioned archive, and stage adoption through Chrome Web Store and
   Google Admin.
4. Omit the one-shot RLS flag on later deploys. Verify all 75 target tables in
   the live catalog before applying the matching Terraform baseline. The
   historical 72-table observation remains unchanged in the registry. A
   SchoolPilot backend/frontend deploy never publishes the extension, and
   disabling a new UI action is safer than falling back to a legacy URL/device
   contract.

For the single backend-first GoPilot staff-dismissal release, add and verify
the seven direct-tenant child tables as one indivisible reviewed bundle. Do
not split, reorder, or retain this flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table authorized_pickups,custody_alerts,dismissal_changes,dismissal_overrides,dismissal_queue,family_group_students,homeroom_teachers
```

Before that one-shot deploy succeeds, keep Terraform's generic and production
allowlists at the currently deployed baseline; preloading the seven tables
would bypass the live-source and catalog admission checks above. Immediately
after the rollout is verified, land a separate baseline-adoption change that
copies the observed live allowlist (including all seven tables) into an
explicit `infra/production.tfvars` value before any later Terraform apply.
Stage non-production environments separately. Never combine the pre-rollout
activation and post-rollout Terraform baseline into one static value.

For the first ClassPilot one-day schedule-change release, add and verify the
three direct-tenant workflow tables as one indivisible reviewed bundle. Do not
split, reorder, or retain this flag on later releases:

```bash
./scripts/deploy.sh production --backend --activate-emergency \
  --enable-rls-table classpilot_schedule_change_pairs,classpilot_schedule_changes,classpilot_schedule_change_legs
```

Keep Terraform's production allowlist at the deployed baseline until this
one-shot activation and live catalog verification succeed. Then land the
observed allowlist in a separate production baseline-adoption change before
any later Terraform apply. The feature policy defaults off, but already
approved dated changes must continue to resolve during a frontend rollback.
After the feature has accepted data, a backend rollback to a pre-schedule-change
revision is not automatically safe: that code would ignore approved effective
windows and could start the recurring windows instead. Before selecting such a
revision, verify that there are zero future approved changes and zero frozen
occurrences that depend on a swapped window; cancel any future changes before
the earliest affected bell. If either condition cannot be proved, roll forward
with a repaired feature-aware revision. The teacher-request kill switch only
blocks new requests and is not a backend rollback mechanism. An automatic ECS
circuit-breaker rollback before the candidate serves traffic or stores feature
data remains safe.

If that safe rollback leaves the live API/worker task definitions without the
three schedule-change tables in `RLS_ENABLED_TABLES`, the next feature-aware
backend attempt must repeat the exact three-table one-shot flag after re-running
the live-source preflight. An ordinary deploy intentionally preserves the live
allowlist and would otherwise start feature code without admitting those tables.
Apply the same rule after a deliberate per-table kill-switch removal. Once live
catalog verification has succeeded and all three tables remain enabled, omit the
one-shot flag on later releases as usual.

That mode keeps the prior 2048 MiB API serving while the deploy script builds
and registers the new image. It then uses the newly registered, digest-matched
2048 MiB revision for the migration task, API service update, and strict
stability check. The default backend deploy remains unchanged and selects the
standard API family.

The deploy script requires a clean local `main` equal to `origin/main`, green
latest GitHub Actions runs per workflow, authenticated AWS + GitHub CLIs, and a
git-SHA image tag by default. A production backend deploy also fails closed
unless the API is stable at one or two tasks and the scheduler worker is stable
at exactly one task. It blocks weekday production backend deployments from
04:45 through 10:14 America/New_York so the 05:45 six-task arrival action cannot
cross a migration or 200%-capacity service rollout. Immediately before its
migration it captures the API
Application Auto Scaling suspended state, suspends dynamic scale-in/out while
preserving the captured scheduled-scaling state, rechecks both services, keeps
the dynamic hold through migration and service stabilization, and restores the
exact prior state. Leaving the reviewed one/six-task schedules active prevents
a deployment from skipping the 05:45 scale-up or 10:00 scale-down. Production `--skip-wait` is
therefore prohibited. This bounds the 200% rolling database-connection overlap
below the launch gate. It builds and pushes the image, registers
digest-pinned API and scheduler-worker task definitions, and also pre-registers
an unused digest-pinned API OOM target in the
`schoolpilot-<environment>-api-emergency` family. The emergency target clones
the newly rendered API definition, including its environment and secrets, but
uses 512 CPU / 2048 MiB. The script prints its exact ARN and revision without
changing either active service. It then runs the explicit
`RUN_MIGRATIONS_ONLY=true` ECS migration task, updates both ECS services, waits
for service stability, and cleans temporary task-definition files. After the
standard ECS waiter, a bounded production-only poll requires the service and
PRIMARY deployment task definitions to match the newly registered API and
worker revisions with exactly one `COMPLETED` deployment each; a circuit-breaker
rollback to old stable revisions fails closed while the autoscaling hold is
still active.

The immutable CI image workflow is intentionally opt-in with the repository
variable `IMMUTABLE_RELEASE_IMAGE_ENABLED=true`. Leave it disabled until the
`release-image` GitHub environment, `AWS_RELEASE_IMAGE_ROLE_ARN`, and the
repository-scoped AWS GitHub OIDC trust are provisioned and verified. While it
is disabled, use the deploy script's guarded legacy build path; do not set the
flag merely to make a workflow appear green.

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
# point the API and scheduler-worker services at matching revisions. Preferred:
# `./scripts/deploy.sh --backend` does this automatically (resolve digest →
# run migration task → render revisions → register → update services).
# ECR tags are mutable, so never deploy by tag/force-new-deployment. A
# digest-pinned revision is exact; before any manual rollback, apply the
# feature-specific data compatibility gates above rather than assuming every
# previous revision can safely interpret current production rows.
DIGEST=$(MSYS_NO_PATHCONV=1 aws ecr describe-images --repository-name schoolpilot-production-api --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text --region us-east-1)
# Render: copy current task def JSON, strip read-only fields, set containerDefinitions[0].image
# to 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@$DIGEST,
# then: aws ecs register-task-definition --cli-input-json file://taskdef.json
MSYS_NO_PATHCONV=1 aws ecs update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-api --task-definition schoolpilot-production-api:<NEW_REV> --region us-east-1

# Step 6: VERIFY — wait for new API + worker tasks to reach RUNNING, old tasks to stop
MSYS_NO_PATHCONV=1 aws ecs describe-services --cluster schoolpilot-production-cluster --services schoolpilot-production-api schoolpilot-production-scheduler-worker --region us-east-1 --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,taskDefinition:taskDefinition,deployments:deployments}'
# Each service should show desiredCount=1, runningCount=1, rolloutState=COMPLETED
# If runningCount=0 or rolloutState=FAILED, check task logs in CloudWatch
```

If a standard API deployment OOMs, use the exact emergency ARN printed by that
same backend deploy; do not reuse an emergency revision from a different image.
The command below is an operator action and is not run automatically by the
default deploy path. The reviewed `--activate-emergency` mode performs this
selection as part of its guarded rollout instead:

```bash
EMERGENCY_TASK_DEF_ARN="arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:<PRINTED_REVISION>"
MSYS_NO_PATHCONV=1 aws ecs update-service \
  --cluster schoolpilot-production-cluster \
  --service schoolpilot-production-api \
  --task-definition "$EMERGENCY_TASK_DEF_ARN" \
  --region us-east-1
MSYS_NO_PATHCONV=1 aws ecs wait services-stable \
  --cluster schoolpilot-production-cluster \
  --services schoolpilot-production-api \
  --region us-east-1
```

Verify `/health`, target health, and ECS task restart/OOM counters immediately
after using the emergency target. The standard 512 CPU / 1024 MiB API revision
is not an OOM recovery target because it retains the failed memory ceiling.

### Launch cost rollout

The staged WAF/alarm, public-ECS, NAT, Route 53, Redis, synthetic-load, state
recovery, supervision, and rollback procedure lives in
`docs/AWS_COST_ROLLOUT_OPERATIONS.md`; the thresholds and Chromebook onboarding
hold live in `docs/SCALE_READINESS.md`. Follow those two files as one contract.
`production.tfvars` is the canonical current Terraform-managed production
baseline; never preload a future cost-stage value. Introduce each future value
only through that phase's separately reviewed plan or PR, and never run an
unreviewed production apply. Use a unique external saved plan, verified DPAPI
and OneDrive AES-GCM state backups before plan/before apply/after apply, and
the exact phase shape from the runbook.

Useful safety checks:

```powershell
node scripts/load/prepare-classpilot-load-test.mjs --help
npm run load:classpilot -- --validate-fixtures
npm run load:kiosk -- --validate-fixtures
pwsh -NoProfile -File tests/terraform-state-backup.test.ps1
pwsh -NoProfile -File tests/aws-rollout-automation.test.ps1
terraform -chdir=infra init -backend=false -lockfile=readonly -input=false
terraform -chdir=infra validate -no-tests
```

### Deploy Sequence — Frontend

```bash
# Step 1: Build frontend
cd schoolpilot-app && npm run build

# Step 2: Sync to S3 (--delete removes old files)
MSYS_NO_PATHCONV=1 aws s3 sync "C:/GitHub/SchoolPilot/schoolpilot-app/dist/" s3://schoolpilot-production-frontend/ --delete --region us-east-1

# Step 3: Invalidate CloudFront cache (use targeted paths to reduce costs — "/*" causes ALL cached objects to refetch)
MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation --distribution-id E1TPPJOD7C2CXR --paths "/index.html" "/" --region us-east-1

# Step 4: VERIFY — check invalidation completed
MSYS_NO_PATHCONV=1 aws cloudfront list-invalidations --distribution-id E1TPPJOD7C2CXR --region us-east-1 --query 'InvalidationList.Items[0]'
# Status should be "Completed" (may take 1-2 minutes)
```

### Common Deployment Pitfalls

1. **Wrong source directory** — ALWAYS build from this repo. The obsolete GoPilot server prototype uses raw `pool.query()` with columns that don't exist in the production database.
2. **ECR login expired** — `docker push` will fail with auth errors if you haven't run `ecr get-login-password` recently. Tokens last 12 hours.
3. **ECS service names** — Must be exactly `schoolpilot-production-api` and `schoolpilot-production-scheduler-worker` in cluster `schoolpilot-production-cluster`.
4. **Task not starting** — If the new task fails to start after a service update, ECS rolls back automatically. Check CloudWatch logs for the failed task. Common causes: missing env vars, bad image, port mismatch. Rollback is explicit now: `update-service --task-definition schoolpilot-production-api:<previousRev>` or `schoolpilot-production-scheduler-worker:<previousRev>`.
5. **CloudFront invalidation costs** — Use targeted invalidation (`/index.html /`) instead of `/*`. Wildcard `/*` invalidates ALL cached objects, causing every request to refetch from origin, generating massive CloudFront + S3 request charges during development.
6. **Windows path conversion** — Always prefix AWS CLI commands with `MSYS_NO_PATHCONV=1` in Git Bash on Windows, otherwise paths like `--paths "/*"` get mangled.
7. **Task definition env vars** — The ECS task definition must include `CLIENT_URL=https://school-pilot.net` and `GOOGLE_CALLBACK_URL=https://school-pilot.net/api/auth/google/callback`. These are set in the task definition, not in the container.
8. **Dockerfile CMD** — Runs `node dist/index.js` directly (no `drizzle-kit push`). Production schema changes are handled by the explicit deploy-script migration task (`RUN_MIGRATIONS_ONLY=true`), not by normal web/worker startup.
