# AGENTS.md

Read [CLAUDE.md](./CLAUDE.md) before making changes. It is the shared startup
guide for all coding agents. It links to the authorities for tenant isolation,
development, CI, product boundaries, and production releases.

For backend, frontend, and runtime changes, use the
[production deployment runbook](./docs/PRODUCTION_DEPLOYMENT.md). Publish
with `deploy.sh` and the exact standard web bundle from successful main push
CI. Roll back with the private release receipt and its recorded S3 versions.

SchoolPilot releases cover the API, scheduler worker, and web app. The
ClassPilot extension, Windows browser packages, and desktop software have
separate release procedures. Follow the ownership and verification rules in
[CLAUDE.md](./CLAUDE.md#releases-and-operations).

For teacher classroom actions, use the
[server-enforced command contract](./ARCHITECTURE.md#classpilot-teacher-dashboard-commands).
Missing targets cannot become class-wide or school-wide broadcasts. Keep
device IDs out of teacher-facing API and UI flows. Use school student records
in Rosters and extension or Chromebook records for device status.
