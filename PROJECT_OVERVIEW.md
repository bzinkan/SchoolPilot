# SchoolPilot Project Overview

## Purpose

SchoolPilot is a unified K-12 school operations platform. It combines three school-facing products behind one API, one shared student/school data model, and one React app:

- ClassPilot: Chromebook classroom monitoring, web filtering, teacher controls, class sessions, student analytics, and workspace safety tools.
- PassPilot: digital hall passes, class-based pass assignment, pass history, and public kiosk mode.
- GoPilot: dismissal management, parent/student pickup flows, family groups, bus/walker handling, dismissal queueing, and parent notifications.

The project is built for schools that want a single account, roster, license, and admin surface across these workflows.

## Tech Stack

- Backend: Node.js, Express, TypeScript, ESM modules.
- Database: PostgreSQL with Drizzle ORM schemas and migrations.
- Realtime: Socket.io for GoPilot dismissal events, raw WebSocket for ClassPilot device/teacher communication, Redis pub/sub for cross-instance delivery.
- Frontend: React 19, Vite, React Router, TanStack Query, Axios, Radix UI components, Tailwind CSS v4, lucide-react icons.
- Mobile: Capacitor Android builds for GoPilot and PassPilot.
- Integrations: Google OAuth, Google Classroom, Google Directory, Gemini Flash-Lite, Gmail/Pub/Sub for MailPilot, SendGrid, Stripe, Anthropic Claude API.
- Infrastructure: Docker Compose for local Postgres/Redis/pgAdmin, Dockerfile for production API image, Terraform modules under `infra/`, GitHub Actions CI/CodeQL/Gitleaks/Trivy.

## Major User Outcomes

- School admins can create and manage schools, staff, rosters, licenses, billing, Google imports, and product setup.
- Teachers can run classroom sessions, monitor Chromebook activity, issue hall passes, and manage class-specific settings.
- Office staff can manage dismissal and schoolwide operational views where roles allow it.
- Parents can connect to GoPilot and manage pickup/dismissal interactions for approved children.
- Students interact indirectly through managed Chromebooks, kiosk mode, and dismissal/pass workflows.

## Top-Level Structure

```text
/
  src/                         Express API, schemas, services, realtime, routes
  schoolpilot-app/             React/Vite frontend and Capacitor app projects
  migrations/                  Drizzle SQL migrations and snapshots
  seeds/                       Local/demo data seed scripts
  scripts/                     Deployment and Stripe setup helpers
  infra/                       Terraform infrastructure modules and environment files
  docs/                        User guides, security/compliance docs, review docs
  .github/workflows/           CI, CodeQL, Gitleaks, Trivy workflows
  CLAUDE.md                    Existing project guidance and operational notes
```

## Products And Components

### Shared Platform

- `src/app.ts` builds the Express app, security headers, CORS, sessions, JSON parsing, CSRF, health checks, and `/api` route mounting.
- `src/index.ts` validates env vars, runs startup schema patches, creates the HTTP server, attaches Socket.io and WebSocket, starts schedulers, and listens on port 4000.
- `src/routes/index.ts` is the route hub and URL rewrite layer. It maps frontend-friendly and legacy paths to canonical product routes.
- `src/schema/` contains Drizzle table definitions split by domain: core, students, classpilot, passpilot, gopilot, mailpilot, shared.
- `src/services/storage.ts` is the main database access layer. It contains most CRUD/query functions across all products.
- `schoolpilot-app/src/contexts/` contains shared app state: auth, licenses, native platform detection, socket, and theme.

### ClassPilot

- Backend routes: `src/routes/classpilot/`.
- Frontend pages: `schoolpilot-app/src/products/classpilot/`.
- Main data: devices, exact student sessions, heartbeats/realtime status, daily usage, groups and rosters, teaching sessions/staff, revisioned student control state, command targets/results, Flight Paths, block lists, FAB/chat delivery, polls, attendance, and teacher settings.
- Realtime path: `/ws` raw WebSocket for teacher and student/device messages.
- External dependency: the Chrome extension lives in the separate `C:\GitHub\ClassPilot` repo and is released independently through Chrome Web Store. This API owns registration/exact binding, entitlement, heartbeat/screenshot ingest, command authority/results, FAB/chat/poll persistence, and WebSocket delivery.

### PassPilot

- Backend routes: `src/routes/passpilot/passes.ts` and `src/routes/passpilot/kiosk.ts`.
- Compatibility/admin routes: parts of `src/routes/compat.ts`.
- Frontend pages: `schoolpilot-app/src/products/passpilot/`.
- Main data: grades, teacher-grade assignments, passes, students, school kiosk fields.
- Public kiosk endpoints use school ID from query/header and are rate limited. Authenticated setup routes require school context, active school, license, and role checks.

### GoPilot

- Backend routes: `src/routes/gopilot/`.
- Frontend pages: `schoolpilot-app/src/products/gopilot/`.
- Main data: homerooms, co-teachers, parent-student links, authorized pickups, custody alerts, bus routes, walker zones, family groups, dismissal sessions, dismissal queue, dismissal changes, activity log, dismissal overrides.
- Realtime path: `/gopilot-socket` Socket.io.

### MailPilot / Email Monitoring

- Backend routes: `src/routes/mailpilot/`.
- Services: `src/services/mailpilotGmail.ts`, scheduler renewal and retention tasks.
- Data: mailpilot watches, email alerts, email scan logs.
- It depends on service-account and Pub/Sub env vars. When those are missing, MailPilot is disabled.

### Workspace Audit

- Backend: `src/routes/google/workspaceAudit.ts`, `src/services/workspaceAudit.ts`.
- Frontend: `schoolpilot-app/src/products/classpilot/pages/WorkspaceAudit.jsx`.
- Purpose: read-only Google Workspace policy audit for school admins.

## Data Flow Between Components

1. User opens the React app.
2. `AuthContext` calls `/api/auth/me` through the Axios client.
3. Backend authenticates via session cookie or JWT and returns user, memberships, licenses, and token data.
4. `LicenseContext` derives product access and default route.
5. Product pages call `/api/...` endpoints through Axios or TanStack Query.
6. Express route rewrites normalize legacy/product frontend paths into canonical route handlers.
7. Middleware establishes auth, school context, active school status, product license, and role checks.
8. Route handlers call `storage.ts` or focused services.
9. Drizzle/Postgres stores core school/user/student/product data.
10. Redis stores transient realtime/screenshot data and distributes WebSocket messages across instances.
11. Schedulers handle automatic dismissal, stale session cleanup, daily usage rollups, retention purges, security monitoring, and MailPilot watch renewal.

## Runtime Data Flow By Product

### ClassPilot

```text
Chrome extension
  -> /extension/register or /extension/student-login for exact student binding
  -> /api/device/heartbeat (canonical /api/classpilot/device/heartbeat)
  -> /ws for exact-bound classroom/FAB/chat/Live View messages and ACK receipts
  -> /api/device/screenshot -> Redis latest-screenshot cache
  -> Postgres heartbeats, commands/targets, control state, FAB/chat, polls, sessions
  -> scheduler rollups to daily_usage
  -> student-scoped teacher dashboard tiles/results and admin analytics
```

### PassPilot

```text
Teacher/admin app
  -> /api/passpilot/passes and /api/grades compatibility routes
  -> Postgres passes, grades, teacher_grades, students
  -> pass history/reports

Public kiosk
  -> /api/passpilot/kiosk/* with school ID
  -> license/kiosk validation
  -> pass create/checkin/list students
```

### GoPilot

```text
Office/teacher/parent UI
  -> /api/gopilot/* and school-scoped compatibility routes
  -> Postgres dismissal sessions, queue, changes, homerooms, families
  -> Socket.io rooms for live dismissal updates
  -> parent/teacher/office views update in realtime
```

## Incomplete Or Unclear Functionality Noticed

- `GET /api/compat/export/activity` returns an empty activity array.
- The AI assistant frontend button is disabled in `App.jsx`, while backend AI chat services and tools still exist and require `ANTHROPIC_API_KEY`. This does not disable the active ClassPilot teacher/student classroom FABs.
- MailPilot is present but env-dependent and likely still needs operational validation for domain-wide delegation and Pub/Sub setup.
- `src/routes/index.ts` and `src/routes/compat.ts` carry many legacy aliases. Useful for compatibility, but they obscure the canonical API surface.
- Production migrations run as an explicit `RUN_MIGRATIONS_ONLY=true` task before API/worker rollout; optional startup migrations are awaited before sockets, schedulers, or the HTTP listener start.
- Backend, frontend, and extension suites are configured. ClassPilot releases require the SchoolPilot checks plus the separate extension repo's typecheck, Vitest, build, and real-Chrome resilience gate.
- The ClassPilot extension remains a separately versioned release. The operator and public listing confirmed Web Store `2.6.1` live on August 19, 2026; no higher unpublished package is currently prepared.

## Missing Clarity Questions

1. Should AI chat remain backend-only/disabled in the UI, or return behind a deliberate feature flag?
2. Should the empty ClassPilot `/export/activity` compatibility endpoint be implemented or formally retired?
3. Should public PassPilot kiosk pages remain reachable without a logged-in user whenever the school has an active PassPilot license?
