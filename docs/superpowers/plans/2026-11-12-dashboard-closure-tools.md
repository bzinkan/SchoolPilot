# Dashboard closure and tools implementation plan

**Goal:** Show saved school-day closures across the three staff dashboards and restore one-row ClassPilot tools.
**Architecture:** A narrow product-scoped current-day read, a shared informational frontend notice, and a contained nowrap toolbar.
**Tech Stack:** Express/TypeScript, PostgreSQL, React/TanStack Query, Playwright.
**Spec:** ../specs/2026-11-12-dashboard-closure-tools.md

## Global constraints

- Work in codex/dashboard-closure-tools-20261112 from f0bc241d; preserve unrelated work.
- Follow CLAUDE.md and existing tenant, role, entitlement and scheduling boundaries.
- No policy mutations, extension change, new dependency, migration or paid AWS load tests.
- Preserve all classroom commands, screenshot behavior and existing capacity/settings.
- Native browser suites run sequentially on this host.
- Deployment and task-branch cleanup are already authorized.

## Review focus

Check school/product/user cache isolation; exact staff entitlement boundaries;
shared closure versus ClassPilot overrides; DST, midnight, malformed data and
request failure; no schedule/settings writes; contained toolbar overflow,
portaled dropdowns, keyboard reachability and unchanged Focus targeting.

## Tasks

- [x] Add route/service regressions for closed/open dates, overrides, timezone/DST,
  staff roles, tenant isolation and no writes. Observe RED, implement narrow read,
  then verify unit and disposable local database cases.
- [x] Add shared notice and dashboard mounts with stale/date/failure/isolation
  regressions. Observe RED before implementation, then verify native browser cases.
- [x] Add real browser toolbar geometry regression. Observe RED, move guidance
  below a nowrap scrolling action row, and verify desktop/narrow/menu behavior.
- [ ] Review the whole diff independently, fix material findings, run lint/build,
  types and relevant regressions; confirm required CI on reviewed source.
- [ ] Merge, wait for full main CI, deploy backend then dashboard through the
  documented script; verify ECS/targets/health/assets and ordinary traffic.
- [ ] Record source, rollback and validation evidence; delete only this task's
  local/remote branch after release and leave unrelated branches/work intact.

## Execution notes

Independent backend, shared notice, and toolbar work is delegated with disjoint
ownership. Backend and notice share the DTO above; root coordinates integration
and sequential browser runs. A fresh reviewer checks the assembled change.
