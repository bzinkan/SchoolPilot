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
        +-- Scheduler worker (src/worker.ts)
        +-- Health/error monitoring      |
        |                                |
        +--> PostgreSQL via Drizzle
        +--> Redis cache/pubsub
        +--> Stripe
        +--> Google APIs / Gemini
        +--> SendGrid
        +--> Anthropic
```

## Backend Layers

### Entry And App Setup

- `src/index.ts`
  - Loads env vars.
  - Validates required production env vars.
  - Creates the HTTP server and attaches Socket.io, WebSocket, and health monitoring.
  - Runs the explicit checksum-ledger task when `RUN_MIGRATIONS_ONLY=true`.
    The deploy script completes it before production services roll.
  - Legacy bootstrap is non-production only and defaults off.

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
- `requireActiveSchool`: validates the school's lifecycle.
- `requireProductLicense`: checks product license rows.
- `requireRole`: checks membership role for the current school.
- `csrfProtection`: protects cookie-authenticated mutating requests; bearer-token requests skip CSRF.
- `rateLimiter`: applies auth/device/kiosk/chat-specific rate limits.

### Authentication
Staff HTTP authentication uses `src/middleware/authenticate.ts`:

1. **Session cookies** — `express-session` backed by PostgreSQL. Used by web app (ClassPilot, PassPilot).
2. **JWT Bearer tokens** — `Authorization: Bearer <token>`. Used by GoPilot mobile and WebSocket connections.

Explicit valid Bearer credentials normally take precedence; an active
impersonation session takes precedence over stale client JWTs. Both staff
credential paths enforce the current `users.authVersion`. ClassPilot extension
student tokens use the separate `requireDeviceAuth` middleware and
`STUDENT_TOKEN_SECRET`, with exact school/student/session/device authority.

**Microsoft sign-in is tenant-pinned.** A super admin turns it on per school with that school's Entra tenant ID (`PUT /api/super-admin/schools/:id/sign-in-methods`). The callback verifies the ID token, then `resolveMicrosoftLoginIdentity` refuses — before writing anything — unless one of the user's active schools has Microsoft on for the token's `tid`. `users.microsoft_id` stores `<tid>:<oid>`; never match a Microsoft login on the email claim alone, because any tenant can assert any email.

[Microsoft sign-in setup](docs/MICROSOFT_SIGN_IN.md)

### School and import authority

Resolve the active school before every school-scoped authorization decision.

- **Google OAuth domain binding** — `google_oauth_tokens` stores `connectedEmail` and `connectedDomain`. Use `getGoogleOAuthTokenForSchool(userId, schoolId)` for Workspace/Classroom actions so the connected Google account domain must match the current `schools.domain`. Multiple schools may share the exact same district domain, but foreign or missing domains fail. Older tokens without connected account identity must require reconnect.
- **Google OAuth purposes**: `/api/google/auth-url` accepts `purpose=workspace_import|classroom_resources`. Workspace import requires `admin` / `school_admin`; Classroom resource import allows `teacher` / `admin` / `school_admin`.
- **Google route gates**: Directory org units/users/imports, staff import, student import, Classroom roster sync/import, and Workspace audit are admin-only (`admin` / `school_admin`). Teacher-facing Classroom resources are allowed only for assigned school context and matching Google domain.
- **Staff domain enforcement**: New `admin`, `school_admin`, `teacher`, and `office_staff` memberships must use the school's Workspace domain. Parent accounts are exempt. Existing mismatched staff stay active but are blocked from sensitive Google/import authority and shown in IT Readiness.
- **Enrollment settings reliability**: `updateEnrollmentSettings()` upserts `settings` rows. The reviewed backfill provides missing settings rows for legacy schools so auto-enroll toggles and enrollment-key rotation do not fail on older tenants.
- **Readiness visibility**: IT Readiness must report missing school domain, Google reconnect-required tokens, Google domain mismatches, and staff email domain mismatches.

Keep GoPilot and ClassPilot operational decisions on their canonical uncached
entitlement resolvers. Recheck inside locked transitions.

### Product Licensing
Each school has entries in the `product_licenses` table (CLASSPILOT, PASSPILOT, GOPILOT). Frontend checks licenses via `LicenseContext` which reads from the `/auth/me` response. Security-sensitive ClassPilot and every GoPilot operational path use their canonical uncached entitlement resolvers rather than the legacy product-row-only middleware.

ClassPilot security-sensitive paths use the stricter uncached resolver in `src/services/classpilotEntitlement.ts`. Entitlement requires an existing school with `status=active`, `isActive=true`, no `disabledAt`/`deletedAt`, non-canceled plan status, non-expired school access, and an active non-expired CLASSPILOT license. Super administrators do not bypass this product boundary. Student token issuance, device telemetry/FAB/poll routes, staff mutations, and both student/staff WebSockets use the same decision; commands, FAB/chat/poll writes, and manual/scheduled starts recheck it under their transaction locks so revocation wins races.

GoPilot uses the same lifecycle rules through `src/services/gopilotEntitlement.ts`: HTTP routes, Socket.io joins, scheduler candidate discovery, and locked dismissal start/resume transitions share one school-plus-license decision. The scheduler and manual transition path recheck immediately before activation under transaction locks. Revocation blocks new operational starts with `GOPILOT_NOT_ENTITLED`, while pause/completion cleanup remains available; super administrators do not bypass the product boundary.

### Tenant isolation

PostgreSQL RLS backs every application-level school filter. Tenant
`school_id` is text. Define matching `USING` and `WITH CHECK` expressions in
`tenant_isolation`, enable and force RLS in the immutable ledger migration,
and check same-school parents. The ordinary direct-tenant predicate is
`school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on'`.
Set `school_id` on inserts from the verified parent or owner.

- `requireSchoolContext` and `requireDeviceAuth` call `bindTenantContext`.
  The `db` proxy uses the scoped PostgreSQL client via `AsyncLocalStorage`
  and releases it at response completion.
- WebSocket, Socket.io, unauthenticated flows and detached work must call
  `runWithTenantContext({ schoolId }, fn)` with a verified school. An
  absent GUC denies reads and writes. Use `{ isSuper: true }` or
  `schedulerDb` only for authorized cross-school work.
- Global bootstrap tables include `users`, `session`, `schools`,
  `school_memberships`, `product_licenses`, `school_inquiries` and the retained
  `trial_requests` source table. `parent_student` and `messages` are tenant
  data. `parent_student.school_id` is non-null. New messages set their school.
  Ambiguous legacy NULL messages remain deny-hidden.
- Keep commands, targets, classroom state, device control state, active hands,
  chat deliveries, polls, responses and session settings tenant-scoped.
  Migrations fail closed on invalid parents and verify same-school triggers.

Use [the semantic registry](src/config/rlsRegistry.json) and
[policy definitions](src/db/rlsPolicies.ts). Chain the new candidate from the
current registry target. Update its named bundle, both `infra/main.tf`
consumers, the policy inventory, CI and local/load helpers and tests. Preserve
historical inventory order and hashes. Earlier Terraform targets remain
subset assertions. Registry membership alone cannot prove runtime
admission. See [deploy-time RLS admission](docs/PRODUCTION_DEPLOYMENT.md#deploy-time-rls-admission).

Extend [cross-tenant isolation tests](tests/cross-tenant-isolation.test.ts)
for every new school-scoped storage function. Use `inSchool()` and `asSystem()`
to exercise both the expected school scope and the explicit system context.

## Data Model

### Core

- `schools`: school identity, domain, product-related settings, billing/status fields.
- `productLicenses`: per-school product entitlement.
- `users`: staff, parents, super admins.
- `schoolMemberships`: user-to-school role binding with product-role extensions like `gopilotRole`.

### Shared Student Model

- `students`: shared across ClassPilot, PassPilot, and GoPilot.
- `studentAttendance`: daily attendance/absence records.

### Student Identity Resolution (CRITICAL)
The students table is shared across all 3 products. Several layers of identity resolution exist:
- **Email is an automatic discovery path, not runtime authority**. Managed Chrome-profile registration uses `chrome.identity.getProfileUserInfo()` and `resolveSchoolForStudent(email)`, while shared-Chromebook flows also support PIN and name/email/ID login. Authenticated wire responses expose `{ schoolId, studentId, studentSessionId, exactBinding: { studentId, studentSessionId } }`; runtime authority additionally binds the device ID from token/config/server state without exposing it to teacher-facing APIs.
- **`students.emailLc` MUST be set on every insert/update** — this is the column used for case-insensitive lookups by `resolveSchoolForStudent()`. The shared `normalizeStudentBody()` helper in `src/routes/students.ts` handles this for POST/PUT/PATCH. Extension auto-registration in `devices.ts` also sets it explicitly.
- **Auth adoption is serialized and generation-fenced**. Profile registration, manual login, worker startup restore, sign-out, entitlement revocation, and session replacement must not resurrect an older identity. Invalidating a binding immediately blocks side effects, clears exact-bound FAB/overlay/inbox/outbox/tab state, and stops Live View before best-effort network cleanup.
- **`/students-aggregated` is a public student-scoped projection**. It exposes authorized realtime telemetry, opaque tab snapshot/revision, extension version, capability flags, and `devices: []`; internal student-session/device bindings stay server-only. Teacher screenshots and history are resolved from student scope on the server, never from a `primaryDeviceId` supplied to the UI.
- **Field name normalization**: Different frontends send different field conventions. The shared `normalizeStudentBody()` helper handles `studentName` → `firstName`/`lastName`, `studentEmail` → `email`, `first_name` → `firstName`, etc. Always use this helper for student create/update endpoints.
- **School domain is set at provisioning, never by self-registration**: a school's `domain` is set by a super admin (`POST /api/admin/schools`, `POST /api/schools`) and is what the extension uses to find the school. `POST /api/auth/register` is retired and answers `410 { code: "PUBLIC_REGISTRATION_RETIRED" }` with a request-independent body, recording the hit as a system audit event; prospects arrive through the public `POST /admin/school-inquiries` intake. It used to create an active school on the caller's unverified email domain, which could put a second school on a live school's domain and break student sign-in there.
- **Domain resolution rules**: `resolveSchoolForStudent` / `getSchoolsByDomain` ignore soft-deleted schools (a deleted school holds no domain claim) but keep suspended ones, which then fail at entitlement, so a suspended district sibling's students are never re-mapped onto the surviving school. Both lookups are ordered by `createdAt, id`: the oldest school and, on a shared domain, the oldest roster row win, so a later duplicate import cannot take over an already-rostered student.

### Google Workspace & Classroom Imports
Student imports are shared setup paths for ClassPilot, PassPilot, and GoPilot. They must be reliable for IT onboarding.

- **OAuth scopes**: Classroom roster import needs `classroom.courses.readonly`, `classroom.rosters.readonly`, and `classroom.profile.emails`. Directory import needs `admin.directory.user.readonly` and `admin.directory.orgunit.readonly`. If an older connected account lacks the Classroom email scope, force a Google reconnect rather than silently importing nameless/email-less students.
- **Classroom resource scope aliases**: Google can return `classroom.student-submissions.students.readonly` for the requested `classroom.coursework.students.readonly` grant. This returned grant was verified to read assignments on October 12, 2026. Resource access and connection status must share `missingGoogleOAuthScopes` from `src/util/googleOAuthScopes.ts`, which recognizes this exact teacher read alias and the `email` / `userinfo.email` alias. Keep the raw returned grant stored, preserve school-domain checks, and never infer arbitrary scope equivalence from similar names or descriptions.
- **Pagination is required**: Google Classroom courses/students and Workspace Directory users are paginated. Always loop `nextPageToken`; do not assume the first 100/500 results are the whole roster.
- **Email upsert rule**: Imports must upsert students by exact `(schoolId, emailLc)`, never fuzzy `searchStudents(email)`, because partial email/name matches can update the wrong student. `createStudent`, `updateStudent`, and `bulkCreateStudents` normalize `emailLc` in `src/services/storage.ts`.
- **Workspace import filtering**: Skip suspended, admin, and delegated-admin Google users when importing students. OU imports may include per-OU `gradeLevel` and `excludeEmails`.
- **GoPilot Classroom sync**: `/google/classroom/sync` accepts `{ courseId, homeroomId, grade|gradeLevel }` and must assign imported/updated students to the mapped homeroom, not just create roster records.
- **Production schema**: Update Drizzle schema and ship a reviewed checksum-ledger migration for changes to Google OAuth/Classroom tables or student Google fields.

### ClassPilot

- Devices and identity: `devices`, `studentDevices`, `studentSessions`.
- Activity: `heartbeats`, `dailyUsage`, `events`.
- Classroom organization: `groups`, `groupStudents`, `groupTeachers`, `subgroups`, `subgroupMembers`.
- Teaching workflow: `teachingSessions`, `sessionSettings`, `dashboardTabs`, `teacherSettings`, `teacherStudents`.
- Controls and learning contexts: `flightPaths`, `blockLists`.
- Messaging/interactions: `chatMessages`, `messages`, `polls`, `pollResponses`, `checkIns`.

### ClassPilot Teacher Dashboard Commands

Classroom commands require authorized student scope and current ownership.
Use `src/services/classpilotCommandValidation.ts` as the strict parser. Internal
admin device policy uses `src/services/classpilotDeviceScope.ts`. Retired device-
targeted teacher endpoints return `410`. Keep device IDs and transport details
out of teacher request/response data, including Screenshots, chat, polls, tab
actions, lists and Flight Paths.

- [Classroom Focus](docs/CLASSPILOT_CLASSROOM_FOCUS.md) owns reviewed assignment
  and material restrictions. [Focus controls](docs/CLASSPILOT_FOCUS_CONTROLS.md)
  own the wire compatibility. Stop Focus uses screen-only unlock and preserves
  the Flight Path.
- [Automatic Class](docs/CLASSPILOT_AUTOMATIC_CLASS.md) owns temporary rooms,
  claims, signed preview/commit, immutable staff tenure and room rollbacks.
  [Scheduled classroom activation](docs/CLASSPILOT_SCHEDULED_CLASSROOM_ACTIVATION.md)
  owns its capability gates. The boundary worker has a separate switch.


- **Owned-class route**: `POST /api/classpilot/commands` accepts `{ teachingSessionId, targetScope: "class" | "subgroup" | "students", targetStudentIds?, subgroupId?, commandType, commandPayload }`. Only immutable `classpilot_session_staff` may mutate the session; Observe access is read-only even for administrators.
- **Claimed-coverage route**: `POST /api/classpilot/coverage/contexts/:contextId/commands` accepts the coverage allowlist in the backend, widened to the full classroom set for any context that passes `scheduledContextHasClassroomTools` — scheduled or ad hoc alike. A claimed student therefore gets tiles, screenshots and the complete toolbar, one observation lease per claimed context so several groups can preview at once. Outside the rollout the route still admits only the coverage allowlist.

- Authorization comes from the actual active server-owned session or context. `scheduledContextHasClassroomTools` checks the appropriate scheduled or ad hoc rollout. Each route uses its exact target and reveals partial failures without broadening.

- **Transaction-frozen authority**: command creation freezes roster membership, supervision ownership, target student IDs, and the current student/session/device binding. It rechecks the actor, uncached ClassPilot entitlement, current control owner, and exact binding under transaction locks. A missing or moved target becomes `unavailable`/`failed`; it never broadens to another student, class, or school.
- **Strict payloads**: keep `src/services/classpilotCommandValidation.ts`, the dashboard resolver, and extension behavior aligned. `unlock-screen` is exactly `{ screenOnly: true }` and preserves Flight Path. Flight Path removal is `remove-flight-path {}`. Tab close is either `{ closeAll: true }` or `{ tabsToClose: [{ studentId, tabRef, observedRevision }, ...] }` with 1–50 unique rows; URLs, patterns, and `specificUrls` are not tab identity or fallback. `student-sign-out` accepts `{}` only.
- **Persistence and results**: `classpilot_commands` stores the header and `classpilot_command_targets` stores frozen per-student binding, status, result/error, and timestamps. Statuses are `requested`, `sent`, `received`, `completed`, `failed`, `unavailable`, and `expired`. The dashboard must preserve every non-zero outcome, including partial cross-context failures, in per-student results rather than collapse them into a generic toast.
- **Persistent versus transient controls**: revisioned desired screen lock, Flight Path, block list, attention, tab limit, and temporary allows live in `classpilot_student_control_states` and reconcile after reconnect. Timers and polls are transient commands with a 15-second delivery TTL; the extension persists only exact-bound overlay state with an expiry. Poll data and responses live in `polls` and `poll_responses`, not in `classpilot_classroom_states`.
- **Durable command ACKs**: the extension keeps an exact-binding command ACK outbox and retries over WebSocket or `POST /api/classpilot/device/command-acks` until `command-ack-receipt` is accepted. Protocol-v2 ACK bodies remain supported, while an advertised explicit ACK envelope must agree with the authenticated tuple. The storage transaction then matches the command's already stored school/student/session/device target and current active binding; an ACK never creates or replaces authority. An offline durable teacher message acquires its first exact target binding when a current authorized heartbeat claims it. Normal transitions are monotonic `received`, `completed`, `failed`, or `expired`, with bounded result/error data. A current-authority durable `teacher-message` apply/persist failure is intentionally retryable: the server may return that target to `sent`/`received` and clear the failed ACK so heartbeat can redeliver; a stale-authority failure is terminal and suppressed. Accepted HTTP ACKs publish the same `classpilot-command-update` event as WebSocket ACKs.
- **Capabilities and public telemetry**: `/students-aggregated` and coverage serializers may expose public `tabSnapshot`, `tabSnapshotRevision`, `extensionVersion`, and capability flags, but never device IDs. Exact row close and screen-only unlock must safe-fail unless `exactTabCloseV1` and `screenOnlyUnlockV1` are advertised. Duplicate same-URL tabs remain distinct opaque refs; a stale ref returns a per-tab `stale_tab_ref` outcome.

### ClassPilot FAB, Chat, and Polls

- **Teacher FAB context**: render it for the teacher's owned active class **and for a supervision context they hold** — a scheduled block or a claimed context with `capabilities.fab === true`. Ordinary claims open the Claimed workspace; the selected context remains the authority for its tools. Label the context explicitly and close its panels when context changes. It remains hidden in Available and Observe-other modes.
- **Session settings**: mutate hand raising and student messaging with `PUT /api/classpilot/teaching-sessions/:id/settings` and `expectedRevision`. Immutable session staff and canonical entitlement are rechecked transactionally; a stale revision returns `409` with the current authoritative state.
- **Authoritative FAB state**: `fab-state-sync.data` carries the exact `studentId`/`studentSessionId`, ownership and lifecycle revisions, teaching session, active session IDs, toggle values, and active hands. Full state fans out on session start/end, settings changes, and coverage claim/release. A claimed student receives the **full** FAB — chat, raise-hand, polls and timers — whenever `scheduledContextHasClassroomTools` holds for their context and the device has accepted `scheduledClassroomV1` (`classpilotFab.ts`); the disabled/empty state now applies only outside the rollout or to a device that cannot negotiate. Stale ownership, session, or identity frames must still be rejected.
- **Server-authoritative sign-out completion**: recheck classroom actor, current owner and lifetime under the final server end's locks; an exact student/device binding alone does not retain a previous classroom's authority after handoff. A device `completed` ACK records transport receipt until the exact binding is verified ended on the server, including a device's own server sign-out that wins before the dispatcher follow-up. Only a persisted `student-sign-out` command whose exact school/student/session/device binding successfully ended on the server may replace an earlier device `failed` or `expired` outcome with `completed`. Preserve generic command terminal monotonicity. The `result.serverAuthoritative` completion marker is server-owned; device ACKs cannot invent or replace it.
- **Chat durability**: student and teacher FAB writes are transaction-authorized and text is capped at 500 characters. A capable durable student retry carries its original teaching `sessionId`; the server compares it with the current locked authority before inserting, so an S1 outbox entry can never be delivered to a replacement S2 teacher. The missing field is accepted only for legacy clients. Teacher replies use durable delivery/outbox rows. Chat acknowledgements use their own exact-bound WebSocket/HTTP `/api/classpilot/device/chat-acks` protocol and `chat-message-ack-receipt` keyed by `messageId`; never mix chat ACKs with command ACKs.
- **Poll contract**: polls start and close only through canonical commands. Only one poll may be active per teaching session (`409 POLL_ALREADY_ACTIVE`); close fans out to the frozen original start targets. Device auth occurs before the per-session response limiter. Responses are exact command-binding-authorized and first-write-wins (`409 POLL_ALREADY_ANSWERED`). The authoritative expiry is no later than session end or 12 hours and is included in start/restore state.
- **Session finalization**: use the centralized lifecycle path to close polls, clear or recompute FAB/chat/control state, release Live View, and fan out exact-binding classroom and FAB snapshots. Do not add a bare device `session-ended` event that can wipe a replacement session's state.

### ClassPilot reporting and activity

All in `src/routes/compat.ts`, require admin role:
- **Adoption & reporting health** replaces the Analytics UI at the same `/classpilot/admin/analytics` URL. `GET /admin/analytics/adoption-health/overview|failures|availability|tools|clients?period=today|7d|30d` uses the existing school/administrator gates plus canonical ClassPilot entitlement. Default is `7d`; failures accept a positive `page` and return 20 records. Aggregation lives in `src/services/classpilotAdoptionHealth.ts`, reads only existing data, and selects completed non-skipped sessions by school-local end-date range and retention. Adoption uses current active official classes; report health includes archived classes. Only terminal, unexpired generation failures appear in Needs attention; email failures and missing observations do not. Availability is neutral and uses weighted stored ready-report totals. New frontend queries and report drill-downs include school/viewer identity and abort signals; optional panels read only when expanded. No new report writer, tables, flags, or extension release is required.
- Adoption observations come from immutable `classpilot_session_student_reports`, not the separately cleaned legacy usage rows. Each session contributes once using its actual starter's frozen staff label; recorded days follow school-local session end dates. A completed window includes its retained observations before the period's start when it crosses midnight. Client versions use frozen student membership and retained check-ins, independently of the current device registry.
- **Legacy compatibility:** the three endpoints below and their response/calculation contracts remain unchanged. The current Adoption & health page does not use these browsing metrics.
- `GET /admin/analytics/summary?period=today|7d|30d` (anything else reads as today) — School-wide stats from `daily_usage` for completed school-local days + supplemental live `heartbeats` query for today (the daily rollup only covers yesterday, so today's activity must come from heartbeats directly)
- `GET /admin/analytics/by-teacher?period=today|7d|30d` — Teacher session stats from `teaching_sessions`. Session times are clamped to the query window via `GREATEST(startTime, cutoff)` and `LEAST(endTime, NOW())` so an open session from yesterday doesn't inflate Today's total (e.g., "27h" on a 24h query)
- `GET /admin/analytics/by-group?period=today|7d|30d` — Per-class Chromebook usage. The default `attributionMode=session` sums `classpilot_session_usage` (class-session reports) by group; `attributionMode=roster` combines current `group_students` with `daily_usage` for completed days and today's live `heartbeats`.
- **Legacy class daily averages**: session mode combines usage by class/student/recorded local date and divides raw total seconds by positive-usage student-days before converting and rounding to minutes. `avgDailyMinutesPerActiveStudent`, `activeStudentDayCount`, and `activeClassDayCount` describe daily usage and recorded days; the average is null without active student-days. Keep `avgMinutesPerStudent` cumulative for compatibility; roster mode keeps its existing calculation and returns null for all three daily fields. Do not divide by calendar range length or replace historical dates/rosters with current schedules.
- Digital Usage (Monitored Browser Time) is a separate, flag-gated API: see [Digital Usage](docs/CLASSPILOT_DIGITAL_USAGE.md).

`CLASSPILOT_SESSION_REPORT_V2_MODE` controls immutable session-report rollout with `legacy`, `shadow`, or `on`. Missing or malformed values fail closed to `legacy`. `shadow` persists, exposes, and emails the exact v1 contract while computing v2 without writes and emitting identifier-free aggregate mismatch, invariant, and timing metrics. `on` creates v2 rows; every materialization, API/CSV presentation, and email dispatch continues to follow the version stored on its report row, so existing v1 rows never change behavior when the environment changes.

Heartbeat intake uses the canonical device entitlement, exact binding and
tenant context. See [reliability](docs/CLASSPILOT_RELIABILITY.md) for realtime
and [scale readiness](docs/SCALE_READINESS.md#daily-usage-rollup-mode-and-promotion)
for daily usage shadow promotion. Keep heartbeat purge batched without
`.returning()`. Derive aggregate retention and school-day boundaries from
the school's timezone and retention settings.

### PassPilot

- `grades`: class/grade buckets used by PassPilot.
- `teacherGrades`: teacher assignment to PassPilot classes.
- `passes`: hall pass lifecycle records.

### PassPilot Class Source
- `settings.passpilot_class_source` controls manual PassPilot class selection and roster management: `legacy_grades` preserves standalone PassPilot behavior, while `classpilot_groups` uses active official ClassPilot `admin_class` groups, `group_students`, and primary/co-teacher assignments. A teacher may explicitly opt their kiosks into `classpilot` scheduling independently of this school-wide setting. That resolver uses the teacher's official timetable and roster without migrating grades, creating mappings, or changing manual class tabs.
- Never infer the source from licenses and never dual-write live rosters. Existing schools cut over only through the reviewed migration. New-school provisioning also requires explicit `passpilotClassModelAcknowledged: true`; licenses alone leave the school in legacy mode.
- Canonical-aware web/native/kiosk requests send `X-PassPilot-Class-Model: classpilot-groups-v1`. Canonical schools reject old clients rather than synthesizing grades or collapsing many-to-many membership into `students.grade_id`.
- Teacher-scheduled ClassPilot kiosks require both the class-model and activity capabilities even in legacy schools. Temporary Send to Kiosk overrides use the school's manual class source. Pass attribution follows the resolved assignment's source; history reads support both sources, with testing/coverage restricted to the issuer and managers. A ClassPilot kiosk pass in a legacy school does not set the school-wide canonical-write cutover marker.
- Class mappings preserve legacy history only. Canonical passes write `passes.classpilot_group_id` and `class_name_snapshot`; historical `grade_id` values and labels are never rewritten.
- Cutover, pass issuance, kiosk changes, official class/roster/teacher mutations, and ClassPilot license removal share the per-school PassPilot advisory lock. Do not add an alternate write path that bypasses it.
- The ClassPilot license cannot be removed while PassPilot is canonical. After the first canonical write, recovery is roll-forward; mixed-source reads remain supported.

See [the guarded cutover](docs/PRODUCTION_DEPLOYMENT.md#guarded-clean-school-cutover-runbook) and [kiosk scheduling](docs/PASSPILOT_KIOSK_SCHEDULING.md).

### GoPilot

- Classroom and student assignment: `homerooms`, `homeroomTeachers`.
- Family/parent links: `parentStudent`, `authorizedPickups`, `familyGroups`, `familyGroupStudents`.
- Dismissal operations: `dismissalSessions`, `dismissalQueue`, `dismissalChanges`, `dismissalOverrides`.
- Transportation and safety: `busRoutes`, `walkerZones`, `custodyAlerts`.
- Audit-style operational log: `activityLog`.

### GoPilot Socket Events
- `dismissal:started` — emitted when an administrator starts a session
- `dismissal:ended` — emitted when an administrator ends a session
- `student:checked-in` — office adds a student to the queue
- `student:called` — office calls student
- `student:dismissed` — office completes pickup
- `student:released` — teacher releases student

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

- `AuthContext` owns user, memberships, licenses, active school, JWT token, login/logout, and school switching.
- `LicenseContext` derives product access and default route.
- `NativeContext` detects Capacitor/native product builds.
- `shared/utils/api.js` is the Axios client. It handles web cookies, native JWTs, CSRF token fetching, and 401 redirects.
- `lib/queryClient.js` wraps Axios for TanStack Query.

### Product Frontends

- ClassPilot pages live in `schoolpilot-app/src/products/classpilot/`.
- PassPilot pages live in `schoolpilot-app/src/products/passpilot/`.
- GoPilot pages live in `schoolpilot-app/src/products/gopilot/`.
Product routes are lazy-loaded in `schoolpilot-app/src/App.jsx`. ClassPilot
administration shares `ClassPilotAdminShell`, its navigation/operation guards,
and the school/user-scoped `AdminQueryBoundary`; Teaching tools uses
`TeachingToolsLayout`. Preserve these shared layouts when adding nested pages.
PassPilot uses its own `AppShell`; GoPilot and Super Admin retain their
product-specific layouts. Check the active route/layout rather than copying a
historical page header.

When a school has multiple products, priority order is: ClassPilot > PassPilot > GoPilot (defined in `PRODUCT_PRIORITY` in `shared/utils/constants.js`). This determines the default landing product after login.

### API Response Format Gotchas
**IMPORTANT:** Backend and frontend use inconsistent field naming. Be careful:
- **Drizzle ORM** returns camelCase JS properties (`firstName`, `lastName`, `dismissalType`, `checkInMethod`).
- **Some endpoints** wrap responses in objects (`{ students: [...] }`, `{ session: {...} }`, `{ overrides: [...] }`). Others return flat arrays. Always check the specific route handler.
- **GoPilot queue endpoint** (`GET /sessions/:id/queue`) explicitly maps to snake_case (`first_name`, `last_name`, `check_in_method`, `dismissal_type`) for frontend compatibility.
- **Students endpoint** (`GET /schools/:id/students`) returns Drizzle camelCase wrapped in `{ students: [...] }`.
- When consuming API responses in the frontend, always handle both formats defensively: `Array.isArray(res.data) ? res.data : (res.data?.items ?? [])` and `student.firstName || student.first_name`.

## Realtime architecture

Socket.io uses `/gopilot-socket` with staff JWT and school/role-scoped
dismissal rooms. The join and session transitions enforce current GoPilot
entitlement. Parent sockets remain retired.

ClassPilot uses `/ws`. Student messages authenticate with the current student
token and exact registered binding. Staff WebSocket auth uses a user token.
Redis supports cross-instance fanout and recovery. Preserve bound identity,
authority and revocation across delivery and ACKs. See
[ClassPilot reliability](docs/CLASSPILOT_RELIABILITY.md) for transport budgets,
recovery and content-free diagnostics.

## Schedulers and background jobs

Production API tasks set `SCHEDULER_ENABLED=false`. The singleton
`src/worker.ts` process runs the scheduled jobs with its own pool and
`runWithSchedulerLock()` advisory locks. Heavy jobs use `schedulerDb`.
That pool sets `app.is_super='on'`, so jobs still need intentional scope.

Pool settings are capped by [databaseCapacity.json](src/config/databaseCapacity.json).
The reviewed caps are API main 16 and worker main 2, scheduler 5, scheduler
lock 8. `DB_POOL_MAX`, `SCHEDULER_DB_POOL_MAX` and `SCHEDULER_LOCK_POOL_MAX` can
lower their respective limits. Scheduler connections are allowed only in
worker and migration roles.

- `startScheduler()` runs every 60 seconds.
- GoPilot:
  - Auto-start dismissal sessions based on school dismissal time.
  - Auto-complete stale dismissal sessions.
- ClassPilot:
  - Auto-end stale teaching sessions.
  - `reconcileClasspilotScheduledSessions`: finalize scheduled occurrences at their frozen end, then start due occurrences; a live occurrence is never re-started (the tick reports `already_live`).
  - Roll up daily usage from heartbeats.
  - Purge expired heartbeats.
- Security:
  - Rule-based security checks run every five scheduler ticks.
- MailPilot:
  - Renew Gmail watches.
  - Enforce email retention.

[Scale readiness](docs/SCALE_READINESS.md) owns API and worker sizing, and [Digital Usage](docs/CLASSPILOT_DIGITAL_USAGE.md) owns rollups and retention.

## Integrations

- Google OAuth: user connection and auth callback.
- Google Classroom: course import/sync.
- Google Directory: users, org units, staff/student import.
- Google Workspace Audit: read-only policy audit.
- Gmail/Pub/Sub: MailPilot email safety monitoring.
- Stripe: billing, invoice checkout, product licenses.
- SendGrid: operational emails, session summaries, safety/security alerts.
- Gemini Flash-Lite: ClassPilot URL/title classification.
- Anthropic: MailPilot email safety classification and AI chat/tool assistant when configured.

### Billing & Stripe Integration
Pricing is defined in `src/config/pricing.ts` (backend) and mirrored in `schoolpilot-app/src/shared/utils/pricing.js` (frontend). Keep both in sync when changing prices.

Use the current shared pricing sources for per-student tiers.

**Invoice flow** Super admins send manual invoices from SchoolDetail page → `POST /super-admin/schools/:id/send-invoice` → creates per-product Stripe line items + discount → Stripe emails the school → school pays via hosted invoice → `invoice.paid` webhook activates school and extends product license expiry.

**Webhook Events Handled** (`src/routes/admin/billing.ts`):
- `checkout.session.completed` — activates school after checkout
- `invoice.paid` — activates school, sets planTier, extends product licenses
- `invoice.payment_failed` — sets planStatus to `past_due`
- `customer.subscription.deleted` — sets planStatus to `canceled`

Use the `STRIPE_*` runtime credentials. Raw-body middleware in `src/app.ts` captures `req.rawBody` for signature verification.

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

See [the staff identity lifecycle runbook](docs/STAFF_IDENTITY_LIFECYCLE_RUNBOOK.md) for migration and protected access procedures.

## AWS topology

CloudFront serves the S3 web bundle and sends `/api/*`, `/ws`,
`/gopilot-socket/*` and `/health` to the ALB. The ALB accepts CloudFront
origin-facing HTTPS and forwards to the Fargate API. Verify public `/health`
through CloudFront and ECS target health. The scheduler worker has no public
application listener. ECS revisions pin ECR images by digest.

The configured topology uses public ECS subnets with public IPs and an
internet gateway. NAT gateways were removed on October 1, 2026. RDS
PostgreSQL and TLS-protected ElastiCache Redis use private subnets. A new
private workload that requires outbound connectivity needs a reviewed route
or VPC endpoint. The ECS security group allows the API port from the ALB
security group.

[Terraform](infra) owns the infrastructure. [Scale readiness](docs/SCALE_READINESS.md),
[AWS cost rollout](docs/AWS_COST_ROLLOUT_OPERATIONS.md), and
[production deployment](docs/PRODUCTION_DEPLOYMENT.md) own rollout, capacity,
exact infrastructure names and verification.

## Monitoring

`src/services/securityMonitor.ts` runs every 5 minutes from the scheduler as a deterministic rule-based breach detector. Reads `audit_logs`, writes detections to `security_events` table, emails `security@school-pilot.net`, and forwards only severity/type/event id to the generic `security_event` monitor category. NEVER takes destructive action autonomously — read-only + alerting only. Current rules: failed auth spike, bulk student writes, off-hours admin burst, cross-school access. 30-minute dedup prevents alert spam. When adding rules, use `schedulerDb` and keep them deterministic (no LLM inference for security decisions). Sensitive details belong in `security_events`, not generic Telegram/error-monitor text. See `docs/WISP.md` for the Written Information Security Program this supports.

See [operations and redaction](docs/PRODUCTION_DEPLOYMENT.md#error-monitoring) for error event routing and activation gates.

## High-Risk Areas

- `src/routes/index.ts`: rewrite order and catch-all compatibility mounts.
- `src/routes/compat.ts`: mixed legacy/product/admin behavior.
- `src/services/storage.ts`: large shared query layer with cross-product impact.
- Student identity fields: `email`, `emailLc`, `studentCode`, `studentIdNumber`, `gradeId`, homeroom/family relations.
- Auth and role mapping across `admin`, `school_admin`, `office_staff`, `teacher`, `parent`, `super_admin`, and product-specific roles.
- Schema, ledger migrations and RLS registry entries must agree. See [development and CI](DEVELOPMENT_NOTES.md) for local verification.
- Env and infra files include sensitive operational concepts. Never copy real values into docs, examples, prompts, commits, or logs.
