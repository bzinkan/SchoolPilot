# SchoolPilot Development Notes

## Local Setup

1. Start local services.

```powershell
docker compose up -d
```

2. Install backend dependencies from the repo root.

```powershell
npm install
```

3. Install frontend dependencies.

```powershell
cd schoolpilot-app
npm install
```

4. Configure local env.

- Copy `.env.example` to `.env`.
- Fill local-only values for database, Redis, session/JWT/device secrets, Google, SendGrid, Stripe, Anthropic, and MailPilot as needed.
- Do not commit `.env`, real API keys, service-account JSON, Terraform state, or `infra/secrets.auto.tfvars`.

5. Push schema and seed local data when needed.

```powershell
npm run db:push
npm run db:seed
```

6. Run backend and frontend in separate terminals.

```powershell
# root
npm run dev

# schoolpilot-app
npm run dev
```

Backend defaults to `http://localhost:4000`. Frontend defaults to `http://localhost:5173`.

## Common Commands

### Backend

```powershell
npm run check
npm run build
npm run db:generate
npm run db:migrate
npm run db:push
npm run db:studio
```

### Frontend

```powershell
cd schoolpilot-app
npm run lint
npm run build
npm run build:gopilot
npm run build:passpilot
npm run mobile:gopilot
npm run mobile:passpilot
```

## Development Rules Of Thumb

- Prefer existing patterns in `CLAUDE.md` and these docs before adding new abstractions.
- Add backend DB access through `src/services/storage.ts` unless the query is clearly complex analytics or an established local exception.
- Use Drizzle schema files as the source for table shape and TypeScript types.
- Keep backend validation in `src/schema/validation.ts` or focused validators near the route when already established.
- Preserve the middleware chain for protected routes: auth, school context, active school, product license, role/access guard.
- Use product-specific access helpers for ID-based routes instead of trusting IDs from request params/body.
- In frontend code, prefer TanStack Query plus `apiRequest()` for server state in newer code.
- Use the shared Axios client for legacy areas and native-token behavior.
- Handle inconsistent API response shapes defensively when touching legacy/compat endpoints.
- Keep product pricing synchronized between `src/config/pricing.ts` and `schoolpilot-app/src/shared/utils/pricing.js`.
- Treat `src/routes/index.ts` rewrites as API compatibility contracts. Add tests or probes when changing them.

## Adding A Feature

1. Identify the product boundary: shared, ClassPilot, PassPilot, GoPilot, MailPilot, Google, or admin.
2. Check whether the frontend already calls a compatibility route.
3. Add or update Drizzle schema if data shape changes.
4. Add storage/service functions.
5. Add route handlers with auth, school, license, and role checks.
6. Update frontend API calls and UI state.
7. Update docs and, if pricing or legal/security behavior changes, update the relevant compliance docs.
8. Run the narrow checks first, then full checks:
   - `npm run check`
   - `npm run build`
   - `cd schoolpilot-app; npm run lint`
   - product build if relevant
9. For browser-facing changes, run a local smoke test with backend and Vite.

## Adding A Route

- Decide whether the canonical path belongs under `/api/classpilot`, `/api/passpilot`, `/api/gopilot`, `/api/google`, `/api/mailpilot`, `/api/admin`, or shared routes.
- Only add rewrite aliases in `src/routes/index.ts` when supporting an existing frontend/native/extension contract.
- Keep public routes minimal and explicitly rate limited.
- For school-scoped ID params, verify the target row belongs to `res.locals.schoolId`.
- For teacher/parent routes, verify ownership/assignment, not just school membership.
- For public kiosk/device/webhook routes, validate school/product/license and use request-specific auth or rate limits.

## Adding Data Or Schema

- Update the matching `src/schema/*.ts` file.
- Prefer formal Drizzle migrations for durable schema changes.
- If production cannot run migrations directly, add a startup safety patch carefully and make it idempotent.
- Avoid startup patches that need to complete after schedulers begin.
- Keep shared student fields consistent. `students.emailLc` is critical for extension identity resolution.

## Security And Secrets

- Never read, paste, summarize, or commit real `.env` values.
- Never commit `.env`, `.env.local`, Terraform state, `.terraform/`, or `infra/secrets.auto.tfvars`.
- `.env.production` is listed as tracked in this checkout even though `.gitignore` contains it. Treat it as sensitive and avoid editing it unless deliberately rotating/replacing placeholders.
- Do not log tokens, session IDs, OAuth refresh tokens, service account JSON, Stripe secrets, SendGrid keys, Anthropic keys, or JWT secrets.
- Use Gitleaks and local pattern scans before pushing anything that touched config, docs, infra, auth, or env examples.
- Preserve CSRF behavior for cookie-authenticated web requests.
- Preserve bearer-token behavior for native apps and extension/device flows.

## Current Known Gaps

- No dedicated automated test suite is configured.
- Some compatibility endpoints are stubs or intentionally minimal:
  - `GET /teacher/raised-hands`
  - `POST /compat/invite`
  - `GET /export/activity`
- The AI chat button is disabled in the frontend, but backend AI chat services remain.
- MailPilot depends on external service-account and Pub/Sub setup not represented by local defaults.
- `src/index.ts` currently starts sockets/schedulers/server immediately after launching startup migrations asynchronously. If new code depends on freshly added columns/tables, migrations should complete before schedulers begin.
- Route rewrites and compatibility aliases are powerful but hard to reason about without explicit route tests.

## Suggested Cleanup Priorities

1. Convert critical startup schema patches into formal Drizzle migrations and await any remaining startup migrations before starting schedulers.
2. Add route-level tests for auth/license/role behavior on ClassPilot, PassPilot, GoPilot, and public kiosk/device/webhook routes.
3. Split `src/services/storage.ts` into smaller product-oriented modules behind stable service APIs.
4. Reduce `src/routes/compat.ts` by migrating frontend calls to canonical routes where possible.
5. Decide the future of AI chat, MailPilot naming, and the remaining stub endpoints.
6. Add smoke tests for the route rewrite layer and product default routing.
7. Standardize response envelopes and field casing where old clients do not require legacy formats.

## 7-14 Day Improvement Roadmap

### Days 1-2

- Document canonical routes versus compatibility aliases.
- Add smoke tests for `/auth/me`, product license gates, PassPilot kiosk, GoPilot queue, and ClassPilot heartbeat/device registration.
- Make startup migration ordering explicit and safe.

### Days 3-5

- Add product-specific access helper tests for ID ownership.
- Replace or remove the known stub endpoints.
- Add a small route test harness that can run in CI with a test database.

### Days 6-9

- Break the highest-risk portions of `storage.ts` into product services.
- Move analytics SQL and compatibility transforms behind named service functions.
- Add regression probes for route rewrites.

### Days 10-14

- Decide and document AI chat and MailPilot product positioning.
- Standardize API response envelopes for new work.
- Add frontend smoke tests for login routing, product routing, kiosk pages, and core admin pages.
- Review infra tracked files and ensure no sensitive production values are versioned.
