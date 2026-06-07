# Tenant-Isolation DB Backstop (Row-Level Security) — Plan

**Status:** Plan only — no code changes yet (deliberate; review before implementing).
**Goal:** make per-school isolation enforced by the **database**, so a single
forgotten `WHERE schoolId` in a future handler can't leak across schools. Today
isolation is **100% application-layer** (verified + tested, but no backstop).

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
  `USING (school_id = current_setting('app.school_id', true)::uuid)`.
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

1. **Now (cheap, high value):** Option C — add the cross-tenant regression test
   suite to CI. This would have caught every finding in the 2026-06 sweep and guards
   against regressions immediately, with zero runtime risk.
2. **Next (structural):** Option A — RLS, rolled out table-by-table behind a flag:
   1. Add `schoolId` columns to the 6 derived tables (or write join-based policies).
   2. Add a txn-scoped `SET LOCAL app.school_id` in a middleware wrapper; route the
      main pool through it. Leave `schedulerPool` / migrations on a `BYPASSRLS` role.
   3. Enable RLS on low-risk tables first (e.g. `dashboard_tabs`, `grades`),
      validate in staging, then expand to `students`, `passes`, `heartbeats`, etc.
   4. Add a "deny by default" test: with no `app.school_id` set, tenant tables
      return zero rows.
3. **Cleanup:** once RLS covers all tenant tables, the per-handler `schoolId`
   filters become defense-in-depth (keep them; belt + suspenders).

## 4. Effort / risk

- Option C: ~0.5–1 day, no runtime risk. **Do first.**
- Option A: ~1–2 weeks done carefully (the GUC-per-request + pool + super-admin +
  derived-table work is the bulk). Roll out incrementally in staging; never flip all
  tables at once in prod.

## 5. Tables needing a `schoolId` column before RLS (no direct column today)

`subgroups` (→ via group), `teaching_sessions` (→ via group), `messages`
(→ via student), `parent_student` (→ via student), `teacher_students` (→ via
student), `dashboard_tabs` (no parent — needs its own column; this is also the
deferred dashboard-tabs isolation item). For these, either add the column (+ backfill)
or write a join-based RLS policy.

## 6. Bottom line

App-layer isolation is now verified and tested, but it is not structural. Option C
(CI tests) should land before/with multi-tenant onboarding as the immediate
guardrail; Option A (RLS) is the durable backstop to schedule as a follow-up
project once onboarding is underway.
