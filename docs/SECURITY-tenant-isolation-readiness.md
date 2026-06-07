# Multi-Tenant (Cross-School) Isolation — Readiness

**Last updated:** 2026-06 (pre-multi-tenant-onboarding hardening)

This is the single source of truth for "are schools sealed from each other?" Read
the **Bottom line** and **Pre-onboarding checklist** first.

---

## Bottom line

Schools are isolated by **verified, tested application-layer controls** — not by
database-level construction. After the work below is **deployed**, cross-school
access requires a code regression (a future handler forgetting a check), not an
existing hole. There is **no database backstop yet** (see the RLS plan), so
isolation depends on continued discipline + the recommended CI guardrail.

**Do not onboard a second school until the Pre-onboarding checklist is complete.**

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
Isolation is **100% application-layer** — no PostgreSQL RLS / row-level backstop.
Plan to add one: [SECURITY-db-backstop-rls-plan.md](./SECURITY-db-backstop-rls-plan.md).

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

## Pre-onboarding checklist (required before a 2nd school)

1. [ ] **Deploy PR #39 + the Phase-2 fixes** to production (verify in the running
       environment — not just merged). Until deployed, the live system still has the
       Phase-1 holes.
2. [ ] **Decide the Google-token scope** — domain guard is shipped; confirm it's
       sufficient for your districts (it is, unless one person admins two schools on
       two separate Workspace domains).
3. [ ] **Enrollment secret** — implement per the spec (backend + extension) if you
       want device enrollment locked beyond domain-binding. Backward compatible /
       off by default.
4. [ ] **Add cross-tenant CI tests** (Option C in the RLS plan) — seed two schools,
       auth as one, assert no access to the other across every `:id` route + list.
5. [ ] **Resolve or accept `dashboard_tabs`** — a multi-school teacher sees their own
       tabs across schools (own data; needs a `schoolId` column to fully partition).
6. [ ] **Schedule the RLS backstop** (Option A) as a follow-up project.

## Known accepted / deferred items

- `dashboard_tabs` cross-school (own data only; needs schema migration).
- `workspaceAudit` service Google-token use not yet school-scoped (feature is
  dormant / not exposed).
- No DB-level RLS backstop yet (planned).

## Honest caveat

No software can be declared "100% sealed." What can be said: the cross-school
attack surface has been exhaustively swept (REST) and audited (non-REST), every
confirmed hole is fixed, and the remaining risk is (a) deploying the fixes and
(b) future code discipline — which the CI tests + RLS plan are designed to remove.
