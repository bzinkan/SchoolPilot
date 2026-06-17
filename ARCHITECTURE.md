# SchoolPilot Architecture

## System Diagram

```text
Browser / Capacitor app / Chrome extension
        |
        | HTTPS, cookies/JWT, WebSocket, Socket.io
        v
Vite React app --------------------------+
        |                                |
        | /api, /ws, /gopilot-socket     |
        v                                |
Express API (src/app.ts, src/index.ts)   |
        |                                |
        +-- Auth/session/JWT/CSRF        |
        +-- URL rewrite layer            |
        +-- Product routes               |
        +-- Schedulers                   |
        +-- Health/error monitoring      |
        |                                |
        +--> PostgreSQL via Drizzle
        +--> Redis cache/pubsub
        +--> Stripe
        +--> Google APIs
        +--> SendGrid
        +--> Anthropic
```

## Backend Layers

### Entry And App Setup

- `src/index.ts`
  - Loads env vars.
  - Validates required production env vars.
  - Runs startup schema patches.
  - Creates the HTTP server.
  - Attaches Socket.io and WebSocket.
  - Starts schedulers and health monitoring.

- `src/app.ts`
  - Creates Express app.
  - Applies Helmet, CORS, JSON/body parsing, cookie parsing, sessions, CSRF, health endpoints, and `/api` routes.
  - Uses PostgreSQL-backed session storage.
  - Exposes `/health`, `/client-config.json`, and `/api/client-config`.

### Route Hub

- `src/routes/index.ts`
  - Runs URL rewrites before route handlers.
  - Mounts auth, schools, students, users, products, admin, Google, AI chat, MailPilot, and compatibility routes.
  - This file is high impact. Route additions should be checked for ordering conflicts with rewrites and compatibility catch-alls.

### Middleware

- `authenticate`: accepts session cookie or Bearer JWT.
- `requireSchoolContext`: resolves `res.locals.schoolId` and membership role.
- `requireActiveSchool`: validates the school is active and entitled.
- `requireProductLicense`: checks product license rows.
- `requireRole`: checks membership role for the current school.
- `csrfProtection`: protects cookie-authenticated mutating requests; bearer-token requests skip CSRF.
- `rateLimiter`: applies auth/device/kiosk/chat-specific rate limits.

## Data Model

### Core

- `schools`: school identity, domain, product-related settings, billing/status fields.
- `productLicenses`: per-school product entitlement.
- `users`: staff, parents, super admins.
- `schoolMemberships`: user-to-school role binding with product-role extensions like `gopilotRole`.

### Shared Student Model

- `students`: shared across ClassPilot, PassPilot, and GoPilot.
- `studentAttendance`: daily attendance/absence records.

### ClassPilot

- Devices and identity: `devices`, `studentDevices`, `studentSessions`.
- Activity: `heartbeats`, `dailyUsage`, `events`.
- Classroom organization: `groups`, `groupStudents`, `groupTeachers`, `subgroups`, `subgroupMembers`.
- Teaching workflow: `teachingSessions`, `sessionSettings`, `dashboardTabs`, `teacherSettings`, `teacherStudents`.
- Controls and learning contexts: `flightPaths`, `blockLists`.
- Messaging/interactions: `chatMessages`, `messages`, `polls`, `pollResponses`, `checkIns`.

### PassPilot

- `grades`: class/grade buckets used by PassPilot.
- `teacherGrades`: teacher assignment to PassPilot classes.
- `passes`: hall pass lifecycle records.

### GoPilot

- Classroom and student assignment: `homerooms`, `homeroomTeachers`.
- Family/parent links: `parentStudent`, `authorizedPickups`, `familyGroups`, `familyGroupStudents`.
- Dismissal operations: `dismissalSessions`, `dismissalQueue`, `dismissalChanges`, `dismissalOverrides`.
- Transportation and safety: `busRoutes`, `walkerZones`, `custodyAlerts`.
- Audit-style operational log: `activityLog`.

### MailPilot And Shared Compliance

- MailPilot: `mailpilotWatches`, `emailAlerts`, `emailScanLog`.
- Google: `googleOAuthTokens`, Classroom course tables.
- Audit/compliance: `auditLogs`, `securityEvents`, `schoolInquiries`, `expressSessions`, `settings`.

## Frontend Architecture

### Application Shell

- `schoolpilot-app/src/App.jsx` defines lazy-loaded routes.
- Providers wrap the app in this order:
  1. `QueryClientProvider`
  2. `NativeProvider`
  3. `ThemeProvider`
  4. `AuthProvider`
  5. `LicenseProvider`
  6. `SocketProvider`

### Auth And Licensing

- `AuthContext` owns user, memberships, licenses, active school, JWT token, login/register/logout, and school switching.
- `LicenseContext` derives product access and default route.
- `NativeContext` detects Capacitor/native product builds.
- `shared/utils/api.js` is the Axios client. It handles web cookies, native JWTs, CSRF token fetching, and 401 redirects.
- `lib/queryClient.js` wraps Axios for TanStack Query.

### Product Frontends

- ClassPilot pages live in `schoolpilot-app/src/products/classpilot/`.
- PassPilot pages live in `schoolpilot-app/src/products/passpilot/`.
- GoPilot pages live in `schoolpilot-app/src/products/gopilot/`.
- Product pages use their own navigation/header conventions rather than one shared shell.

## Realtime Architecture

### Socket.io

- Implemented in `src/realtime/socketio.ts`.
- Path: `/gopilot-socket`.
- Auth: JWT in Socket.io handshake.
- Primary use: GoPilot dismissal events.
- Rooms are school/role scoped.

### WebSocket

- Implemented in `src/realtime/websocket.ts`.
- Path: `/ws`.
- Auth:
  - Student/device auth with student tokens or email-first auto-provisioning.
  - Staff auth with user JWT.
- Primary use: ClassPilot extension/device monitoring and teacher commands.
- Redis pub/sub is used for cross-instance delivery.

## Schedulers And Background Jobs

- `startScheduler()` runs every 60 seconds.
- GoPilot:
  - Auto-start dismissal sessions based on school dismissal time.
  - Auto-complete stale dismissal sessions.
- ClassPilot:
  - Auto-end stale teaching sessions.
  - Auto-start/end scheduled class blocks.
  - Roll up daily usage from heartbeats.
  - Purge expired heartbeats.
- Security:
  - Rule-based security checks run every five scheduler ticks.
- MailPilot:
  - Renew Gmail watches.
  - Enforce email retention.

Heavy background work should use `schedulerDb` and not the main request pool.

## Integrations

- Google OAuth: user connection and auth callback.
- Google Classroom: course import/sync.
- Google Directory: users, org units, staff/student import.
- Google Workspace Audit: read-only policy audit.
- Gmail/Pub/Sub: MailPilot email safety monitoring.
- Stripe: billing, invoice checkout, product licenses.
- SendGrid: operational emails, session summaries, safety/security alerts.
- Anthropic: AI chat/tool assistant when configured.

## Deployment And CI

- Local dependencies: Docker Compose starts Postgres, Redis, and pgAdmin.
- Backend build: `npm run check`, `npm run build`.
- Frontend build: `npm run lint`, `npm run build`.
- Product-specific frontend builds: `npm run build:gopilot`, `npm run build:passpilot`.
- CI:
  - Backend TypeScript/build and npm audit.
  - Frontend lint/build and npm audit.
  - CodeQL.
  - Gitleaks.
  - Trivy container scan.

## High-Risk Areas

- `src/routes/index.ts`: rewrite order and catch-all compatibility mounts.
- `src/routes/compat.ts`: mixed legacy/product/admin behavior.
- `src/services/storage.ts`: large shared query layer with cross-product impact.
- Student identity fields: `email`, `emailLc`, `studentCode`, `studentIdNumber`, `gradeId`, homeroom/family relations.
- Auth and role mapping across `admin`, `school_admin`, `office_staff`, `teacher`, `parent`, `super_admin`, and product-specific roles.
- Startup migrations and formal Drizzle migrations can drift if not managed deliberately.
- Env and infra files include sensitive operational concepts. Never copy real values into docs, examples, prompts, commits, or logs.
