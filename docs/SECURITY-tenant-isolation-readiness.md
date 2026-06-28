# Multi-Tenant (Cross-School) Isolation — Readiness

**Last updated:** 2026-06 (RLS backstop live in app/runtime path)

This is the single source of truth for "are schools sealed from each other?" Read
the **Bottom line** and **Pre-onboarding checklist** first.

---

## Bottom line

Schools are isolated by **verified, tested application-layer controls** plus a
PostgreSQL Row-Level Security backstop on tenant tables when
`RLS_GUC_ENABLED=true`. Request middleware binds `app.school_id` to a dedicated
connection, out-of-request work uses `runWithTenantContext()`, and scheduler
cross-school work uses `schedulerDb` with `app.is_super='on'`.

Keep `RLS_GUC_ENABLED=true` and keep `RLS_ENABLED_TABLES` aligned with CI and
production. Store live policy/status/grants exports as private SOC 2 evidence,
not in this repository.

## What was found & fixed

### Phase 1 — REST API layer (10-round adversarial sweep, converged dry)
~75 cross-school IDORs across the codebase — two systemic patterns:
- **`getById`/update/delete without `schoolId`** → fixed via `*ByIdAndSchool` /
  `*ForSchool` storage helpers that filter in the DB query.
- **scoped-by-`teacherId`-not-`schoolId`** (multi-school teacher lists/sessions) →
  fixed via `*ByTeacherAndSchool` + `getActiveTeachingSessionForSchool`.
- Plus a **CRITICAL Stripe billing IDOR** (pay for/alter another school's plan) and
  an IPv6 rate-limit bypass.
- Shipped as **PR #39** (the PR #36 8-endpoint hotfix already shipped as `9bb2747`).

### Phase 2 — non-REST surfaces (readiness audit)
- **CRITICAL — `/extension/register` was unauthenticated + trusted body `schoolId`.**
  Anyone could mint a signed device JWT for any school and tap its live WebSocket
  monitoring. **Fixed:** registration is now anchored to the verified email domain;
  full hardening (per-school enrollment secret) is specced in
  [SECURITY-device-enrollment-secret-spec.md](./SECURITY-device-enrollment-secret-spec.md).
- **HIGH — scheduler** could end a multi-school teacher's session in another school.
  **Fixed** (`getActiveTeachingSessionForSchool`).
- **HIGH — Google Workspace tokens** reusable across a multi-school user's schools.
  **Fixed:** use-time domain guard (`getGoogleOAuthTokenForSchool`).
- **The WebSocket/Redis transport itself is correctly isolated** by the *signed*
  `schoolId` in the device JWT + per-school socket maps; the only hole was the
  unauthenticated *minting* of that JWT (now domain-anchored).

### Structural finding
The original finding was correct at the time: isolation was application-layer
only. That is now stale. The durable RLS plan has been implemented in the app
runtime path and must remain part of production readiness evidence.

## Isolation model (how it works today, post-fixes)

- **Auth:** every API route requires authentication; `requireSchoolContext` sets
  `res.locals.schoolId` and (for non-super-admins) verifies active membership in
  that school via DB.
- **Per-handler enforcement:** handlers filter by `res.locals.schoolId`, via the
  `*ByIdAndSchool` / `*ForSchool` / `*ByTeacherAndSchool` storage helpers.
- **Devices/real-time:** student device JWT (HS256) binds `schoolId`+`studentId`+
  `deviceId`; WS sockets live in per-school maps; broadcasts route on the
  authenticated `schoolId`, never client-supplied fields.
- **Super-admin:** intentionally cross-school; all such paths gated by
  `requireSuperAdmin` / `isSuperAdmin`.
- **Database backstop:** tenant tables enforce `tenant_isolation` RLS policies
  when included in `RLS_ENABLED_TABLES`; policies use `app.school_id` or the
  explicit `app.is_super='on'` bypass.

## Pre-onboarding checklist

1. [ ] **Verify RLS in production-like runtime** with `RLS_GUC_ENABLED=true` and
       the full `RLS_ENABLED_TABLES` allowlist.
2. [ ] **Export private RLS evidence**: policy status, grants, and representative
       deny-by-default checks through the live connection path.
3. [ ] **Decide the Google-token scope** — domain guard is shipped; confirm it's
       sufficient for your districts (it is, unless one person admins two schools on
       two separate Workspace domains).
4. [ ] **Enrollment secret** — implement per the spec (backend + extension) if you
       want device enrollment locked beyond domain-binding. Backward compatible /
       off by default.
5. [ ] **Keep cross-tenant CI tests green** for route-level and RLS-enabled paths.
6. [ ] **Resolve or accept `dashboard_tabs`** — a multi-school teacher sees their own
       tabs across schools (own data; needs a `schoolId` column to fully partition).

## Known accepted / deferred items

- `dashboard_tabs` cross-school (own data only; needs schema migration).
- `workspaceAudit` service Google-token use not yet school-scoped (feature is
  dormant / not exposed).
- Live RLS evidence is private, not committed here.

## Honest caveat

No software can be declared "100% sealed." What can be said: the cross-school
attack surface has been exhaustively swept (REST) and audited (non-REST), every
confirmed hole is fixed, and the remaining risk is future code or operational
regression. Keep CI, RLS evidence, and production config aligned.
