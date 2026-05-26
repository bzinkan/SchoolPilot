# Codex Rules For SchoolPilot

These rules replace the requested Cursor rules. Keep them in `.codex/rules.md` and update them as the project architecture changes.

## Project Identity

- SchoolPilot is a unified K-12 SaaS platform with ClassPilot, PassPilot, GoPilot, plus MailPilot/email monitoring as an add-on area.
- Backend lives at repo root in `src/`.
- Frontend lives in `schoolpilot-app/`.
- Shared school, user, student, and license data powers all products.

## Code Style

- Backend uses TypeScript, ESM imports, Express route modules, Drizzle ORM, and async/await.
- Frontend uses React, Vite, React Router, TanStack Query, Axios, Radix UI components, and Tailwind utility classes.
- Prefer the established file's local style over broad refactors.
- Keep comments short and useful. Do not narrate obvious code.
- Keep edits scoped to the requested product or shared layer.
- Avoid changing generated build output or dependency lockfiles unless the task requires it.

## Folder Conventions

- Backend routes:
  - `src/routes/classpilot/`
  - `src/routes/passpilot/`
  - `src/routes/gopilot/`
  - `src/routes/google/`
  - `src/routes/mailpilot/`
  - `src/routes/admin/`
  - `src/routes/compat.ts` only for legacy compatibility and hard-to-move aliases.
- Backend schemas:
  - `src/schema/core.ts` for schools/users/licenses/memberships.
  - `src/schema/students.ts` for shared students/attendance.
  - Product schemas in `classpilot.ts`, `passpilot.ts`, `gopilot.ts`, `mailpilot.ts`.
  - Shared operational schemas in `shared.ts`.
- Backend services:
  - Prefer `src/services/storage.ts` for existing query patterns.
  - Use focused services for domain logic when already present.
  - Use `schedulerDb` for heavy background jobs.
- Frontend product code:
  - `schoolpilot-app/src/products/classpilot/`
  - `schoolpilot-app/src/products/passpilot/`
  - `schoolpilot-app/src/products/gopilot/`
- Shared frontend utilities:
  - `schoolpilot-app/src/shared/`
  - `schoolpilot-app/src/lib/`
  - `schoolpilot-app/src/contexts/`

## Naming Conventions

- Database columns are snake_case.
- Drizzle/TypeScript properties are camelCase.
- React components use PascalCase.
- Hooks use `useName`.
- Product constants use uppercase product keys: `CLASSPILOT`, `PASSPILOT`, `GOPILOT`.
- Keep school role values consistent: `admin`, `school_admin`, `office_staff`, `teacher`, `parent`; super admin is represented by `isSuperAdmin`.

## Refactor Rules

- Refactor only when it removes real complexity or protects a risky behavior.
- Do not move route aliases casually. `src/routes/index.ts` is a compatibility boundary.
- Do not split `storage.ts` opportunistically in a feature PR. Split only by product/service with verification.
- Keep price logic synchronized between backend and frontend pricing files.
- Preserve legacy response shapes unless all callers are updated.
- When touching shared student identity, preserve `emailLc` handling.

## Feature Prompts

When adding a feature, answer these before coding:

1. Which product owns this: shared, ClassPilot, PassPilot, GoPilot, MailPilot, Google, or admin?
2. Which roles can use it?
3. Does it require an active product license?
4. Which school-scoped IDs need ownership checks?
5. Does any route alias or native/mobile/extension client already depend on the path?
6. Does the frontend need both web and Capacitor behavior?
7. What local checks prove the change?

## Backend Safety Rules

- Protected route chain should generally be:
  `authenticate -> requireSchoolContext -> requireActiveSchool -> requireProductLicense -> role/access guard`.
- For ID-based routes, verify the row belongs to `res.locals.schoolId`.
- For teacher routes, verify teacher assignment, not only school membership.
- For parent routes, verify approved parent-child link.
- For public kiosk/device/webhook endpoints, use explicit validation, rate limiting, and product/license checks where applicable.
- Do not trust `schoolId` from body for authenticated school context.
- Do not start new scheduler jobs on the main request DB pool.
- If adding startup migrations, make them idempotent and ensure required migrations complete before schedulers use the schema.

## Frontend Safety Rules

- Use `apiRequest()` and TanStack Query for newer server-state pages.
- Use the shared Axios client for existing legacy/native-aware flows.
- Handle both array and wrapped object responses when touching compatibility endpoints.
- Do not put protected product routes outside license/role gates unless they are intentionally public.
- Public pages must not assume `user` or `activeMembership`.
- For mobile/native behavior, check `NativeContext` and token persistence behavior.

## Auth And Security Rules

- Never read, paste, summarize, or commit real secrets.
- Never commit `.env`, `.env.local`, Terraform state, `.terraform/`, or `infra/secrets.auto.tfvars`.
- Treat `.env.production` as sensitive even if it appears in git history.
- Do not log access tokens, refresh tokens, JWTs, session IDs, API keys, service-account JSON, or webhook secrets.
- Preserve CSRF for cookie-authenticated mutating web requests.
- Preserve bearer-token flows for native apps and extension/device clients.
- Run a secret scan before pushing changes that touch env examples, docs, infra, auth, CI, or config.

## Verification Rules

- Backend changes:
  - `npm run check`
  - `npm run build`
- Frontend changes:
  - `cd schoolpilot-app; npm run lint`
  - `cd schoolpilot-app; npm run build`
- Product frontend changes:
  - `npm run build:gopilot` or `npm run build:passpilot` when relevant.
- Runtime route/auth changes:
  - Start backend and frontend locally.
  - Probe the affected API routes.
  - Browser-smoke the affected product page when user-facing.
- CI-sensitive changes:
  - Check GitHub Actions after push.
  - Confirm Gitleaks stays green.

## Do Not Do

- Do not create `.cursor/` files for this project.
- Do not overwrite `.env` or production-like config.
- Do not remove compatibility aliases without checking frontend/native/extension callers.
- Do not weaken license gates, role checks, CSRF, or school ownership checks.
- Do not change Terraform state or secrets files as part of app work.
- Do not introduce a new state-management or UI framework without a clear owner decision.
