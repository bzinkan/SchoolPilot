<p align="center">
  <img src="schoolpilot-logo.png" alt="SchoolPilot logo" width="110" />
</p>

<h1 align="center">SchoolPilot</h1>

<p align="center">
  <a href="https://github.com/bzinkan/SchoolPilot/actions/workflows/ci-build.yml"><img src="https://github.com/bzinkan/SchoolPilot/actions/workflows/ci-build.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/bzinkan/SchoolPilot/actions/workflows/codeql.yml"><img src="https://github.com/bzinkan/SchoolPilot/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <a href="https://github.com/bzinkan/SchoolPilot/actions/workflows/gitleaks.yml"><img src="https://github.com/bzinkan/SchoolPilot/actions/workflows/gitleaks.yml/badge.svg" alt="Gitleaks" /></a>
  <a href="https://github.com/bzinkan/SchoolPilot/actions/workflows/trivy.yml"><img src="https://github.com/bzinkan/SchoolPilot/actions/workflows/trivy.yml/badge.svg" alt="Trivy" /></a>
</p>

SchoolPilot is a multi-tenant K-12 school operations platform that puts three products behind one API, one shared student/school data model, and one React app — a single account, roster, license, and admin surface for the whole school:

- **ClassPilot** — classroom Chromebook monitoring: device heartbeats, teaching sessions, web filtering, teacher controls, and student analytics (paired with a Chrome extension maintained in a separate repo).
- **PassPilot** — digital hall passes: class-based pass assignment, pass history, and a public kiosk mode.
- **GoPilot** — dismissal management: parent/student pickup flows, family groups, bus and walker handling, and a live dismissal queue.

## Architecture

```text
Browser / Capacitor app / Chrome extension
        |  HTTPS, cookies/JWT, WebSocket, Socket.io
        v
React 19 + Vite app (schoolpilot-app/)
        |  /api, /ws, /gopilot-socket
        v
Express API — Node.js 22, TypeScript, ESM (src/)
        +--> PostgreSQL (Drizzle ORM, row-level security)
        +--> Redis (cache + cross-instance pub/sub)
        +--> Stripe, Google APIs, SendGrid, Anthropic
```

- **API**: Express with layered middleware — auth (session or JWT), school context, active-school and product-license checks, role guards, CSRF, and rate limiting.
- **Tenant isolation**: every tenant table is scoped by school ID at the application layer, with Postgres row-level security as a database-level backstop. CI runs cross-tenant isolation tests against both a plain and an RLS-enabled Postgres.
- **Realtime**: Socket.io (`/gopilot-socket`) for dismissal events and a raw WebSocket (`/ws`) for ClassPilot device/teacher traffic, with Redis pub/sub for cross-instance delivery.
- **Mobile**: Capacitor wraps product-filtered Vite builds into native GoPilot and PassPilot apps (`VITE_APP_PRODUCT` selects the product at build time).
- **Infrastructure**: Docker image deployed to AWS ECS; Terraform modules for ECS, RDS, and Redis under `infra/`.

## Quick Start

Requires Node.js >= 22.9 and Docker.

```bash
# 1. Local services (Postgres, Redis, pgAdmin)
docker compose up -d

# 2. Dependencies
npm install
cd schoolpilot-app && npm install && cd ..

# 3. Environment
#    Copy .env.example to .env and fill in local values.

# 4. Schema and seed data
npm run db:push
npm run db:seed

# 5. Run (two terminals)
npm run dev                      # API on http://localhost:4000
cd schoolpilot-app && npm run dev  # app on http://localhost:5173
```

Useful checks: `npm run check` (TypeScript), `npm run build`, `npm test` (cross-tenant isolation tests), and `npm run lint` / `npm run build` inside `schoolpilot-app/`.

## Repository Layout

```text
src/                 Express API: routes, schemas, services, realtime, schedulers
schoolpilot-app/     React/Vite frontend + Capacitor mobile projects
migrations/          Drizzle SQL migrations
seeds/               Local/demo seed scripts
tests/               Cross-tenant and RLS isolation tests
infra/               Terraform modules (ECS, RDS, Redis)
docs/                User guides and security/compliance docs
```

## Documentation

| Doc | What it covers |
| --- | --- |
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | Products, tech stack, data flows, known gaps |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Backend layers, data model, realtime, schedulers |
| [DEVELOPMENT_NOTES.md](DEVELOPMENT_NOTES.md) | Local setup, conventions, how to add features/routes |
| [docs/MOBILE_APP_ARCHITECTURE.md](docs/MOBILE_APP_ARCHITECTURE.md) | Capacitor strategy for the GoPilot and PassPilot apps |
| [docs/SECURITY-tenant-isolation-readiness.md](docs/SECURITY-tenant-isolation-readiness.md) | Tenant-isolation posture and readiness review |
| [docs/SECURITY-db-backstop-rls-plan.md](docs/SECURITY-db-backstop-rls-plan.md) | Postgres row-level-security backstop rollout plan |
| [docs/WISP.md](docs/WISP.md) | Written Information Security Program |
| [docs/HECVAT-LITE.md](docs/HECVAT-LITE.md) | HECVAT Lite vendor security assessment |

User guides for each product are also in [docs/](docs/).

## Status

Active work in progress. Current priorities and known gaps are tracked in [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) and [DEVELOPMENT_NOTES.md](DEVELOPMENT_NOTES.md).
