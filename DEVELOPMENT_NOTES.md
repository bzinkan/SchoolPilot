# SchoolPilot development notes

Use [the backend package](package.json), [the frontend package](schoolpilot-app/package.json),
and [CI](.github/workflows/ci-build.yml) for the current script inventory and
job setup. Production changes follow the [deployment runbook](docs/PRODUCTION_DEPLOYMENT.md).

## Local setup

Use Node.js 22 as in CI. Copy `.env.example` to `.env` and use local-only
secrets and service endpoints. The Docker Compose defaults map Postgres to
5435, Redis to 6380, and pgAdmin to 5050.

```bash
docker compose up -d
npm ci
npm run db:push
npm run db:seed
npm run dev
```

Run the frontend in a second terminal.

```bash
cd schoolpilot-app
npm ci
npm run dev
```

The API runs on port 4000. Vite serves port 5173 and proxies `/api`, `/ws`,
and `/gopilot-socket` to the API.

### Local database commands

`db:push`, `db:generate`, `db:migrate`, `db:studio`, and `db:seed` are
local tools. Point them at a disposable local database. Add production changes
to the immutable checksum ledger in the appropriate `src/db/migrations*.ts`
module. Deploy the migration with the reviewed one-off ECS task.

### Configuration and secrets

[`.env.example`](.env.example) lists variables and local defaults. Keep
database and Redis addresses, auth secrets, Google/Microsoft and third-party
credentials in local or protected runtime configuration. Use the staff identity,
Microsoft sign-in, kiosk, and capability procedures for their activation and
rotation requirements.

- `APP_ENV` labels runtime metrics. Staging uses `schoolpilot.staging.sid`
  with an empty `COOKIE_DOMAIN`. Use the matching `LOAD_SESSION_COOKIE_NAME`
  for staging load clients. Keep production and staging artifacts separate.
- `PUBLIC_BASE_URL` provides the canonical audience for managed-device
  continuity. Production fails closed when it is absent or invalid.
  Forwarding headers cannot establish that audience.
- `RUN_MIGRATIONS_ON_STARTUP` defaults off and is forbidden in production.
  `RUN_MIGRATIONS_ONLY` selects the ledger task. `SCHEDULER_ENABLED` is false
  on production API tasks and true on the worker. See [architecture](ARCHITECTURE.md#schedulers-and-background-jobs).
- Keep `.env`, local/production env files, service-account JSON, Terraform
  state, and `infra/secrets.auto.tfvars` out of Git. Keep actual passwords,
  API keys, tokens and private records out of prompts, logs, commits and PRs.
  Gitleaks runs in CI. Rotate exposed provider credentials immediately and
  handle history cleanup separately.
- Terraform refers to application runtime secrets by external/deterministic
  SSM parameter ARN. Keep secret values out of variables, plans and state.
  `REDIS_URL` is the topology-derived SecureString Terraform manages.
  Follow the [production procedure](docs/PRODUCTION_DEPLOYMENT.md#terraform-state-and-secrets)
  for legacy secret-state detachment.

- [Microsoft sign-in](docs/MICROSOFT_SIGN_IN.md)
- [Staff identity lifecycle](docs/STAFF_IDENTITY_LIFECYCLE_RUNBOOK.md)
- [ClassPilot runtime configuration](docs/CLASSPILOT_RUNTIME_CONFIG_OPERATIONS.md)
- [PassPilot kiosk scheduling and tickets](docs/PASSPILOT_KIOSK_SCHEDULING.md)

## Development patterns

- Extend the existing route, schema, or domain service. Shared CRUD lives in
  `src/services/storage.ts`. Use existing product validators and preserve
  ordering in `src/routes/index.ts` for compatibility aliases.
- Keep protected routes in authenticated school and role scope. Check specific
  ownership or assignment and include current entitlement. Kiosk, device and
  webhook routes require their own auth and rate limits. Preserve cookie CSRF
  and the separate Bearer flows.
- Follow [tenant isolation](ARCHITECTURE.md#tenant-isolation) for every database
  read and write. Preserve locks when extending a guarded transaction.
- Use TanStack Query and `apiRequest()` in newer code. Use the shared Axios
  client where existing code relies on its cookies, CSRF or native JWT handling.
  Check each endpoint's actual envelope and field casing before consuming it.
- Keep the frontend pricing mirror and applicable public/legal claims aligned
  when changing pricing or legal or security behavior.

## Continuous integration

[GitHub Actions](.github/workflows/ci-build.yml) runs on pushes to `main`, PRs
targeting `main` or `codex/**`, and manual dispatch. PR change detection may
skip `rollout-safety`; a push to `main` runs the full job set because
`scripts/deploy.sh` gates on it and a deployed commit's SOC 2 packets must not
record a skipped job. Consult the workflow for current job dependencies and
timeouts rather than assuming a fixed duration.
- `changes` (pull requests only, `dorny/paths-filter@v3`): detects whether a PR touched any input of the ~30-minute `rollout-safety` job (`scripts/load/**`, `infra/**`, `scripts/deploy.sh`, the named PowerShell tools, `tests/**/*.ps1|psm1|py`, documentation it asserts on, and the workflow itself). `rollout-safety` is skipped on a PR only when that filter ran successfully AND proved no input changed; it fails closed (`!= 'false'`, `!cancelled()`) and always runs on `push`/`workflow_dispatch`. Never convert this to a workflow-level `on.*.paths` filter: `deploy.sh` refuses a commit with **zero** workflow runs, while a *skipped job* is green to it.
- Backend: `npm audit --audit-level=high`, `npm run check`, `npm run check:test-casts`, a fresh `npm run build`, then `npm run check:tests` (tests import compiled `dist`). CI runs `test:unit`, `test:infrastructure`, `test:db-serial`, and `test:rls-serial` in their assigned jobs and database postures.
- Frontend: `npm audit --audit-level=critical` + `npm run lint` + `vite build`, production-preview smoke, GoPilot/PassPilot builds, Android debug APKs and the dependency-audit chain (`audit:dependencies` collect → three post-build Router validations → `finalize`, which must stay in this one job, in order).
- `frontend-release-gates` runs five shards on separate runners. The package scripts are the exact suite inventory: dashboard tests are split across shards 1 and 4, Classroom and Reports v2 remain in the release gates, shard 3 retains the guide content and fixed-port/browser-cache suites, and shard 5 exercises guide navigation through the real application router. Never run shards concurrently on one machine. `test:release-focused` remains the complete local aggregate and begins with `npm run test:staff-identity-contracts`. Every SOC 2 job that `needs: frontend` also needs this matrix, so release checks remain represented in `CI_JOB_RESULTS`.
- Workflow-level `concurrency` cancels superseded **PR** runs only; every job has a `timeout-minutes`.
- SOC 2 governance: `npm run soc2:check` validates governance metadata, checks public/security claims, writes non-sensitive evidence packets, and auto-drafts risk acceptances for eligible open remediation items.
- SOC 2 privileged access evidence: `npm run soc2:privileged-access-evidence` writes a non-sensitive packet for `SOC2-003` showing MFA is deferred, privileged access is reviewed, and private access-review/user-export/MFA-deferral evidence is required.
- SOC 2 deployment evidence: `npm run soc2:deployment-evidence` writes a shadow change/deployment packet without deploying or requiring AWS credentials.

### Required Test Gates

- **Backend**: run `npm run check`, `npm run check:test-casts`, a fresh `npm run build`, `npm run check:tests`, and `npm test`. For CI-equivalent lane coverage, also use `npm run test:unit`, `npm run test:infrastructure`, `npm run test:db-serial`, and `npm run test:rls-serial` with the workflow's respective database setup. `npm test` is the serial `tests/**/*.test.ts` suite; the lane runner discovers both `.test.ts` and `.test.mjs`, and the restricted-RLS lane proves a separate database posture. Unit tests run at concurrency four; infrastructure, DB, and RLS lanes are serial. Never overlap DB/RLS lanes against the same fixture. Inspect `node scripts/run-test-lane.mjs list` and classify new database/RLS tests explicitly so they do not fall into the parallel unit lane. Documentation-only changes need the relevant document-contract checks and `git diff --check`; application builds are required when application code changes.
- **ClassPilot frontend** (`schoolpilot-app/`): run `npm run lint`, `npm run build`, and the focused gates `npm run test:classpilot-tile-batching`, `npm run test:classpilot-session-lifecycle`, `npm run test:classpilot-realtime-cache`, `npm run test:classpilot-signal-loss`, `npm run test:classpilot-command-context`, and `npm run test:classpilot-radix-browser` when dashboard, tiles, command targeting, realtime, dialogs, or FAB behavior changes. For the full release gate set run `npm run test:release-focused`, or one shard with `npm run test:release-focused:shard-1|2|3|4|5` (shard 3 carries every fixed-port suite; do not run two shards concurrently on one machine).
- **ClassPilot extension** (separate `C:\GitHub\ClassPilot` repo): run `npm run check`, `npm test`, `npm run test:extension:chrome`, and `npm run build`. The real-Chrome resilience gate is required for MV3 lifetime, exact-binding, auth restore, WebSocket ordering, Live View, FAB, poll, and ACK changes; Node/static tests alone are not sufficient.
- **Release hygiene**: run `git diff --check` in both repositories. From a clean
  tagged commit in the separate ClassPilot repo, align the release guard with
  `extension/manifest.json` and run `./extension/package-extension.sh` to create
  `dist/ClassPilot-v<manifest-version>.zip` and the compatibility copy
  `dist/classpilot-extension.zip`. Verify the root manifest and managed schema
  against source and keep the archive SHA-256 before an authorized upload.
  Confirm the live version and pending submissions first. Track Web Store
  publication and managed Chrome adoption separately. Use `console.warn` for
  routine extension diagnostics because `console.error` surfaces to school IT.

The frontend uses React Compiler lint rules. Common gotchas:
- `form.watch()` from React Hook Form is incompatible — extract to a variable (e.g., `const watchedRole = form.watch("role")`)
- Sync `setState` in `useEffect` triggers `set-state-in-effect` — wrap in `requestAnimationFrame()`
- `useCallback` deps must match what the compiler infers — include state setters if referenced

## ClassPilot guide maintenance

The structured teacher/admin content under `schoolpilot-app/src/products/classpilot/guides/`
is canonical. Changes to visible workflows, labels, roles, feature availability or
instructional destinations require reviewing affected topics before merging.
Preserve existing topic IDs and guide URLs. Write exact visible actions and their
consequences; keep device IDs and transport details out of staff instructions.

Record actual review dates, verification basis (`live-observed`,
`released-source-verified`, or `unverified`), sources, checks and limitations in
`schoolpilot-app/scripts/classpilot-guide-{teacher,admin}-evidence.json`.
The separate `classpilot-guide-release-baseline.json` records dated API/worker,
served frontend and extension evidence independently. A passing fixture test,
source path or review date does not prove deployment, device adoption or future
freshness. Do not advance dates on regeneration or infer whole-frontend source
identity from an API SHA. Omit unverified source-only features; conditional copy
is for released functionality with actual role, school or capability gates.

From `schoolpilot-app`, run `npm run docs:classpilot-guides`,
`npm run test:classpilot-guides`, and `npm run test:classpilot-guides:browser`.
Never edit generated `docs/CLASSPILOT_{USER,TEACHER,ADMIN}_GUIDE.md` exports directly.
The Node browser suite uses the real router and explicit fixtures; every distinct
topic destination must reach its expected page/query state rather than a fallback.
Keep detailed command/lifecycle behavior in its owning feature suites and cite
those checks in the topic review records.

## Security and compliance evidence

Use [SOC2.md](SOC2.md) for command selection and which changes require each
packet. Control records live under `docs/soc2/` and private evidence stays
in the separate evidence repository. Drafts require a factual review and
founder/security-owner authorization. Evidence collection stays read-only
or shadow-only for production. Keep generated `soc2-evidence/` packets out
of Git.

Review the [WISP](docs/WISP.md), policy and terms source in
[the legal pages](schoolpilot-app/src/pages/legal), and the
[claims register](docs/soc2/claim-register.md) together when wording changes.
`securityPosture.js` drives both security summary pages. The frontend serves
[HECVAT Lite](docs/HECVAT-LITE.md) directly, so its edits ship in the next web
bundle. Use Schoolpilot for customer copy and Schoolpilot LLC for the legal name.
Assessor demo parent accounts live in `seeds/005_demo_parents.ts`. Keep demo
credentials confined to approved fixtures or protected secret storage.
