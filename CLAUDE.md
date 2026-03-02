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
│   │   └── admin/          # Super admin, trial requests, billing
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

### URL Rewrite Layer
`src/routes/index.ts` contains a complex URL rewrite middleware that maps frontend-friendly paths to canonical backend routes. This is critical — all product-specific routes go through rewrites before hitting handlers.

### Product Licensing
Each school has entries in the `product_licenses` table (CLASSPILOT, PASSPILOT, GOPILOT). The `requireProductLicense` middleware gates access. Frontend checks licenses via `LicenseContext` which reads from the `/auth/me` response.

### Billing & Stripe Integration
Pricing is defined in `src/config/pricing.ts` (backend) and mirrored in `schoolpilot-app/src/shared/utils/pricing.js` (frontend). Keep both in sync when changing prices.

**Product Pricing (Annual):**
| Product | Base Fee | Per-Student |
|---------|----------|-------------|
| ClassPilot | $500 | $2/student |
| GoPilot | $300 | $2/student |
| PassPilot | $0 | $2/student |

**Bundle Discounts:** 2 products → 10% off, all 3 → 20% off.

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
1. **Heartbeats** — Chrome extension sends heartbeats every 10s to `/api/classpilot/heartbeat`. Stored in `heartbeats` table with studentId, schoolId, activeTabUrl, timestamp.
2. **Daily usage rollup** — `scheduler.ts` runs `rollupDailyUsage()` hourly (hour-gated). For each school with ClassPilot license, aggregates yesterday's heartbeats into the `daily_usage` table (totalSeconds, heartbeatCount, topDomains JSONB, firstSeen/lastSeen). Uses upsert on `(studentId, date)` for idempotency.
3. **Heartbeat purge** — `purgeExpiredHeartbeats()` runs hourly. Deletes heartbeats older than each school's `retentionHours` setting (default 720 = 30 days).
4. **Auto-migration** — `index.ts` creates the `daily_usage` table with `CREATE TABLE IF NOT EXISTS` on startup (since production RDS is in a private VPC and can't be reached by `drizzle-kit push` directly).

### Admin Analytics Endpoints
All in `src/routes/compat.ts`, require admin role:
- `GET /admin/analytics/summary?period=24h|7d|30d` — School-wide stats from `daily_usage`, hourly activity and top websites from `heartbeats`
- `GET /admin/analytics/by-teacher?period=7d|30d` — Teacher session stats from `teaching_sessions` joined with `groups`
- `GET /admin/analytics/by-group?period=7d|30d` — Per-class Chromebook usage from `daily_usage` joined with `groupStudents` → `groups` → `users`

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
- **Chrome extension**: The ClassPilot Chrome extension (MV3, separate repo at `ClassPilot/extension/`) uses a service worker (`service-worker.js`). Use `console.warn` instead of `console.error` — Chrome surfaces `console.error` calls as visible "Errors" on the chrome://extensions page, alarming school IT admins.

## Environment Variables

Copy `.env.example` to `.env`. Required for local dev:
- `DATABASE_URL` — PostgreSQL connection (default: `postgresql://schoolpilot:schoolpilot_dev@localhost:5435/schoolpilot`)
- `REDIS_URL` — Redis connection (default: `redis://localhost:6380`)
- `SESSION_SECRET`, `JWT_SECRET`, `STUDENT_TOKEN_SECRET` — Auth secrets
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth
- `SUPER_ADMIN_EMAIL` — Email address that gets super admin privileges
- `CORS_ALLOWLIST` — Comma-separated frontend origins

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to main:
- Backend: `npm audit --audit-level=high` + `tsc --noEmit` + `npm run build`
- Frontend: `npm audit --audit-level=critical` + `npm run lint` + `vite build`

The frontend uses React Compiler lint rules. Common gotchas:
- `form.watch()` from React Hook Form is incompatible — extract to a variable (e.g., `const watchedRole = form.watch("role")`)
- Sync `setState` in `useEffect` triggers `set-state-in-effect` — wrap in `requestAnimationFrame()`
- `useCallback` deps must match what the compiler infers — include state setters if referenced

No test suite currently configured.

## Production Deployment

Infrastructure is on AWS (us-east-1):
- **ECR**: `135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api`
- **ECS**: Cluster `schoolpilot-production-cluster`, service `schoolpilot-production-api`
- **RDS**: PostgreSQL in private VPC (not directly accessible — use auto-migrations in `index.ts` for schema changes)
- **S3**: `schoolpilot-production-frontend` (static frontend assets)
- **CloudFront**: Distribution `E1TPPJOD7C2CXR`

### Deploy Backend
```bash
# On Windows, prefix AWS CLI / Docker commands with MSYS_NO_PATHCONV=1
docker build -t schoolpilot-production-api .
docker tag schoolpilot-production-api:latest 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api:latest
docker push 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api:latest
MSYS_NO_PATHCONV=1 aws ecs update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-api --force-new-deployment --region us-east-1
```

### Deploy Frontend
```bash
cd schoolpilot-app && npm run build
MSYS_NO_PATHCONV=1 aws s3 sync "C:/GitHub/Schoolpilot/schoolpilot-app/dist/" s3://schoolpilot-production-frontend/ --delete --region us-east-1
MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation --distribution-id E1TPPJOD7C2CXR --paths "/*" --region us-east-1
```

### Schema Changes
Since production RDS is in a private VPC, `drizzle-kit push` cannot reach it directly. Instead:
1. Add the Drizzle schema definition in `src/schema/classpilot.ts` (for type safety and local dev)
2. Add a `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` block in `src/index.ts` (for production auto-migration on startup)
