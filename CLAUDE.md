# CLAUDE.md

Shared instructions for Claude Code, Codex, and other coding agents in SchoolPilot.

## Start here

- Check the branch, `git status`, worktrees, and current GitHub `main` before
  editing. Preserve unrelated changes and work in isolation when the shared
  checkout is busy or behind.
- Use [backend scripts](package.json), [frontend scripts](schoolpilot-app/package.json),
  and [CI](.github/workflows/ci-build.yml) for executable commands and gates.
  Read the owning runbook before changing a feature's authority or rollout.
- ClassPilot handles classroom monitoring and supervision, PassPilot handles
  hall passes and kiosks, and GoPilot handles staff-operated dismissal. They
  share the Express API in `src/`, the worker in `src/worker.ts`, and the Vite
  React app in `schoolpilot-app/`. See [architecture](ARCHITECTURE.md).

## Tenant and identity rules

- Require the applicable auth, school context, active-school, product license,
  and role checks. Derive school scope from `res.locals.schoolId` or the
  authenticated binding. Check resource ownership and assignment on every
  privileged read or write, including imports and realtime actions.
- Keep PostgreSQL RLS enforced. Use the GUC-bound request `db`, or call
  `runWithTenantContext` with a verified school for out-of-request work.
  Reserve `schedulerDb` and super scope for authorized cross-school jobs.
  Without tenant context, protected reads can return zero rows and writes fail.
- For a new tenant table, derive `school_id` from the verified parent or
  owner and enforce same-school relationships. Update the Drizzle schema and
  add a checksum-ledger migration with enabled and forced RLS, a matching
  `tenant_isolation` policy and `WITH CHECK`. Add the table and reviewed bundle
  to [the RLS registry](src/config/rlsRegistry.json) and update its current
  CI and tooling consumers. See [tenant isolation](ARCHITECTURE.md#tenant-isolation)
  and [production RLS admission](docs/PRODUCTION_DEPLOYMENT.md#deploy-time-rls-admission).
- Extend cross-tenant isolation tests for each new school-scoped storage function.
- Preserve staff cookie, Bearer, and impersonation precedence, auth-version
  checks, and the separate ClassPilot student/device auth path. Google imports
  require an approved purpose, role and matching connected domain. Microsoft
  sign-in binds the configured tenant and `<tid>:<oid>`.
- Normalize `students.emailLc` on writes. Email discovery stays school-scoped.
  Runtime device actions require the current authenticated school, student,
  session, and device binding. Preserve exact binding in reads, writes and ACKs.
- New schools go through the public inquiry and super-admin review flow. Only
  authorized super admins provision schools and assign their domain or
  lifecycle state. Keep staff domain and active-membership checks in place.

## Product boundaries

### ClassPilot classroom authority

- Use `POST /api/classpilot/commands` for owned-class actions and the scoped
  `/api/classpilot/coverage/contexts/:id/commands` path for claimed supervision.
  Require an explicit authorized class, subgroup, or exact student set.
  A missing or stale target must refuse or yield unavailable/failed for that
  student. Never default to a class-wide or school-wide action.
- Recheck role, license, ownership, frozen roster, and exact current binding
  in the command transaction. Observe is read-only, including for admins.
  Preserve per-student outcomes and the strict command payload contract.
- Keep device IDs internal to transport/admin paths. Teacher-facing APIs and
  UI use student, session, and context authority. Rosters use school student
  records. Chromebook status uses device records. Keep `deviceId` out of
  roster create/edit and student-to-device assignment out of Rosters.
- Read [the command contract](ARCHITECTURE.md#classpilot-teacher-dashboard-commands),
  [classroom Focus](docs/CLASSPILOT_CLASSROOM_FOCUS.md), and
  [Automatic Class](docs/CLASSPILOT_AUTOMATIC_CLASS.md) for the affected workflow.

### GoPilot staff-only dismissal

Parent registration, linking, portal, QR arrival, requests, and sockets stay
retired with `GOPILOT_PARENT_PORTAL_DISABLED`. Administrators and office staff
record arrivals. Teachers only acknowledge or release assigned students.
Office staff retain final dismissal authority. Preserve historical records and
audits. See [GoPilot containment](docs/PRODUCTION_DEPLOYMENT.md#gopilot-containment-and-rollout-runbook).

### My Desk private notebook — SHELVED, not live until further notice

Brian shelved My Desk on September 28, 2026. Keep the frontend entry points
unmounted and AI imports off until he lifts the hold. Preserve the private
backend, retained data, author-only access and cleanup. Do not advertise,
extend, or reactivate the feature without that decision. See
[My Desk release and recovery](docs/MYDESK_PRODUCTION_RELEASE.md#shelving-boundary).

## Development and verification

- Follow [local setup and CI gates](DEVELOPMENT_NOTES.md). Use Node 22,
  lockfile installs, and local Docker services. Run `npm run check` and
  `npm run build` at the root. Run frontend lint and build in
  `schoolpilot-app/`. Select affected test lanes and product checks from CI.
- Keep `npm run db:push` and legacy bootstrap migrations local. Apply
  production DDL through the explicit deploy-script migration task.
- Keep credentials, private evidence, and student/staff data out of source,
  prompts, logs, commits, issues, and PRs. Use `.env.example` and protected
  secret storage. Treat Gitleaks and failing checks as release blockers.
- Use [SOC 2 evidence guidance](SOC2.md) and the [WISP](docs/WISP.md) for
  governance and public claims. Sentry stays off until the DPA is signed.

## Releases and operations

- Start with the [production runbook](docs/PRODUCTION_DEPLOYMENT.md). Confirm
  release authorization, a clean local `main` equal to `origin/main`, exact
  green CI and current serving state. Keep configured, observed, and historical
  states distinct.
- Use the exact reviewed image and migration path, verify the RLS catalog and
  migration ledger, then prove the API and worker converge before publishing
  a coupled frontend. Preserve the live RLS allowlist on ordinary deploys.
  Use one-shot flags only for an exact reviewed admission or recovery.
- Prepare the frontend from the verified standard bundle of successful main
  push CI with `./scripts/deploy.sh production --frontend-plan`. Publish with
  `./scripts/deploy.sh production --frontend`. Keep the private release receipt
  for `./scripts/deploy.sh production --frontend-rollback <receipt>`.
- Use captured serving revisions and schema-aware rollback floors. If older
  code cannot safely interpret accepted data, retain compatible revisions and
  roll forward. Use the approved [runtime-config procedures](docs/PRODUCTION_DEPLOYMENT.md#common-deployment-pitfalls).
- SchoolPilot publishes the API, scheduler worker, and web app. The `ClassPilot`
  repo owns the separate versioned Chrome Web Store and Windows browser
  packages. `ClassPilotDesktop` owns native Agent, Guard, and Host. Verify
  store version and pending submissions before an authorized extension upload.
  Track upload identity and managed-device adoption as separate evidence.
- Read [native mobile](docs/MOBILE_APP_ARCHITECTURE.md), [desktop visibility](docs/CLASSPILOT_DESKTOP_VISIBILITY.md),
  and [Windows browser integration](docs/CLASSPILOT_WINDOWS_BROWSER_INTEGRATION.md)
  before changing those client contracts. Source or simulated-host proof alone
  cannot establish device pilot readiness.

## Review cadence

Review this guide every six months and when a release, authority, or startup
contract changes. Verify instructions against source and the owning runbooks.
Use dated release records and Git history for prior decisions.
