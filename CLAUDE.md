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

## CI

GitHub Actions (`.github/workflows/ci-build.yml`) runs on push/PR to main:
- Backend: `npm audit --audit-level=high` + `tsc --noEmit` + `npm run build`
- Frontend: `npm audit --audit-level=critical` + `npm run lint` + `vite build`

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
"C:/Users/zinka/AppData/Local/Android/Sdk/platform-tools/adb" install -r app/build/outputs/apk/debug/app-debug.apk
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
4. Dashboard shows linked children, authorized pickups, check-in UI
5. Check-in method (app vs QR) is school-controlled via `settings.checkInMethod`

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

**CRITICAL: Always deploy from `C:\GitHub\SchoolPilot\` (this repo). NEVER from `C:\GoPilot\server\`.**

```bash
# Step 1: ECR login (required — tokens expire after 12 hours)
MSYS_NO_PATHCONV=1 aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 135775632425.dkr.ecr.us-east-1.amazonaws.com

# Step 2: Build Docker image from THIS repo root
docker build -t schoolpilot-production-api .

# Step 3: Tag for ECR
docker tag schoolpilot-production-api:latest 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api:latest

# Step 4: Push to ECR
docker push 135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api:latest

# Step 5: Force ECS to pull new image and redeploy
MSYS_NO_PATHCONV=1 aws ecs update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-api --force-new-deployment --region us-east-1

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

1. **Wrong source directory** — ALWAYS build from `C:\GitHub\SchoolPilot`. The `C:\GoPilot\server` repo uses raw `pool.query()` with columns that don't exist in the production database.
2. **ECR login expired** — `docker push` will fail with auth errors if you haven't run `ecr get-login-password` recently. Tokens last 12 hours.
3. **ECS service name** — Must be exactly `schoolpilot-production-api` in cluster `schoolpilot-production-cluster`. There are no other services/clusters.
4. **Task not starting** — If the new task fails to start after `force-new-deployment`, ECS rolls back automatically. Check CloudWatch logs for the failed task. Common causes: missing env vars, bad image, port mismatch.
5. **CloudFront invalidation costs** — Use targeted invalidation (`/index.html /assets/*`) instead of `/*`. Wildcard `/*` invalidates ALL cached objects, causing every request to refetch from origin, generating massive CloudFront + S3 request charges during development.
6. **Windows path conversion** — Always prefix AWS CLI commands with `MSYS_NO_PATHCONV=1` in Git Bash on Windows, otherwise paths like `--paths "/*"` get mangled.
7. **Task definition env vars** — The ECS task definition must include `CLIENT_URL=https://school-pilot.net` and `GOOGLE_CALLBACK_URL=https://school-pilot.net/api/auth/google/callback`. These are set in the task definition, not in the container.
