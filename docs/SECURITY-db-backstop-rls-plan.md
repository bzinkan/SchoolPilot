# Tenant-Isolation DB Backstop (Row-Level Security) — Plan

**Status:** Implemented in the app/runtime path; retain as design history and
operating checklist.
**Goal:** make per-school isolation enforced by the **database**, so a single
forgotten `WHERE schoolId` in a future handler can't leak across schools. Today
isolation is application-layer plus PostgreSQL RLS when `RLS_GUC_ENABLED=true`.

---

## 1. The problem this solves

Every multi-school table has an indexed `schoolId`, but nothing forces a query to
filter by it — each handler must remember. The 2026-06 audit found ~75 places that
forgot (all now fixed), plus a recurring "scoped-by-teacher-not-school" variant.
That class **will recur** in new code without a structural guard. RLS turns "every
developer must remember" into "the database refuses to return other schools' rows."

## 2. Options (recommended → fallback)

### Option A — PostgreSQL Row-Level Security (RLS) + per-request session GUC  ✅ recommended
The database enforces a `schoolId` predicate on every query automatically.

- Add to each tenant table: `ENABLE ROW LEVEL SECURITY` + a policy
  `USING (school_id = current_setting('app.school_id', true))`.
- Per request, set the GUC from `res.locals.schoolId`:
  `SET LOCAL app.school_id = $1` at the start of the transaction (must be inside a
  txn for `SET LOCAL` to scope correctly).
- Super-admin / cross-school jobs: a separate DB role or a `BYPASSRLS` path, or set
  `app.is_super = 'on'` and write policies `USING (... OR current_setting('app.is_super',true)='on')`.

**Pros:** true backstop; impossible to forget; minimal app churn once wired.
**Cons:** requires every connection to set the GUC per request (middleware + a txn
wrapper); careful handling for the connection pool, the scheduler's `schedulerPool`,
and migrations; cross-school admin paths need an explicit bypass; tables without a
`schoolId` column (subgroups, teachingSessions, messages, parentStudent,
teacherStudents, dashboardTabs) need either a derived policy (join) or an added
`schoolId` column.

### Option B — Query-layer forced predicate (Drizzle wrapper)  ◻ fallback
A thin data-access wrapper that injects `eq(table.schoolId, ctx.schoolId)` for
tenant tables, so raw unscoped queries are impossible by construction in app code.

**Pros:** no DB-role/GUC complexity; pure TypeScript.
**Cons:** not a true DB backstop (a dev can still drop to raw `db`); requires
discipline to route all tenant reads through the wrapper.

### Option C — CI guardrail (do this regardless)  ✅ cheap, immediate
An ESLint rule / test that flags any handler calling a raw `get*ById` / `update*` /
`delete*` on a tenant table without a `schoolId` (or `*ByIdAndSchool` / `*ForSchool`)
guard, plus a cross-tenant integration test suite (seed School A + B, auth as A,
assert 404 on every `:id` route and every list endpoint for B's resources).

## 3. Recommended sequence

1. Keep the cross-tenant regression suite in CI.
2. Keep `RLS_GUC_ENABLED=true` in production and keep `RLS_ENABLED_TABLES`
   aligned with the tested tenant table allowlist.
3. Export private production evidence for policies, status, grants, and
   representative deny-by-default checks.
4. Validate any future RDS Proxy experiment against session-GUC RLS behavior before
   adding it to production.
5. **Cleanup:** once RLS covers all tenant tables, the per-handler `schoolId`
   filters become defense-in-depth (keep them; belt + suspenders).

## 4. Effort / risk

Ongoing risk is operational drift: an env flag disabled in production, a new
tenant table omitted from the allowlist, or a DB connection path that bypasses
the request GUC. Treat RLS config and private evidence export as release gates.

## 5. Tables needing a `schoolId` column before RLS (no direct column today)

`subgroups` (→ via group), `teaching_sessions` (→ via group), `messages`
(→ via student), `parent_student` (→ via student), `teacher_students` (→ via
student), `dashboard_tabs` (no parent — needs its own column; this is also the
deferred dashboard-tabs isolation item). For these, either add the column (+ backfill)
or write a join-based RLS policy.

## 6. Bottom line

App-layer isolation is verified and tested, and RLS is the structural backstop.
Keep both: app filters are still defense-in-depth, and RLS is the fail-closed
safety net.
