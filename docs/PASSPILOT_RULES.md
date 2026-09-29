# PassPilot issuance rules

Administrators configure destination capacity, daily and period pass limits, and
encounter restrictions at **PassPilot → School Setup → Rules**. The feature is
controlled by `PASSPILOT_RULES_MODE` (`off` by default) and is not active in any
environment until that mode is turned on through the governed runtime activation.

## Rule contract

Rules are evaluated by `enforcePasspilotIssuanceRules` (`src/services/passpilotRules.ts`)
inside every transactional pass insert: `createLegacyPass`, `createCanonicalPass` and
`createActivityKioskPass`. That covers teacher and administrator issuance, the legacy
and session kiosks, scheduled activity kiosks, and the AI assistant. The helper runs
after the per-school `passpilot-class-source` advisory lock and before the insert, so
every count is serialized with every other issuance for the school: two requests for
the last capacity slot produce exactly one pass. The `createPass` test seeder stays
rule-free. The evaluation instant is taken once, before the transaction starts.

Rules are checked in this order; the first violation denies the pass:

1. **Encounter restriction** — a pair of students who may not be out at the same
   time. A pass is denied while the paired student holds an active pass issued on
   the current school-local day. Pairs are symmetric and stored canonically.
   Disabled restrictions and deactivated students never block.
2. **Destination capacity** — per school and destination (bathroom, nurse, office,
   counselor, other classroom; a custom destination has no capacity), 1–500 passes
   out at once. Counts today's active passes of active students. Passes never
   expire automatically, so active passes left over from an earlier day do not
   block today's issuance.
3. **Daily limit** — 0–50 non-canceled passes per school-local day. A school default
   applies to every student; an enabled per-student limit overrides it field by
   field. A limit of 0 means no passes.
4. **Period limit** — 0–50 non-canceled passes within the current period window:
   - the ClassPilot bell period containing the issuance time, when the school has
     a bell schedule;
   - otherwise, for a scheduled activity kiosk, the kiosk's current timetable block
     (manual or temporarily overridden kiosks have no block);
   - otherwise the issuing class's scheduled (or live) ClassPilot session:
     canonical classes directly, legacy classes only through a confirmed ClassPilot
     link;
   - otherwise the period limit is **not enforced** for that pass.

   `GET /api/passpilot/admin/rules` reports `periodEnforcement`
   (`bell_schedule`, `class_window` or `unavailable`) and the Rules tab warns when a
   period limit is set but cannot be enforced everywhere. A failure while resolving
   the window (for example an unreadable bell schedule) makes the period limit
   unavailable for that pass; it never becomes an issuance error.

Day and window bounds are school-local (`schools.school_timezone`) and compared to
`passes.issued_at` (UTC `timestamp without time zone`) with `utcTimestampForSql`.

## Who sees what

- Administrators (`admin`, `school_admin`, super admin) receive the rule code, a
  factual message (for example `Bathroom is at capacity (3 of 3 out).` or
  `2 passes today (limit 2).`) and `canOverride: true`.
- Teachers and office staff receive the same factual message and code for capacity,
  daily and period limits. For an encounter restriction they receive only
  `PASSPILOT_RULE_NOT_AVAILABLE` with a generic message; nobody but an administrator
  learns that a restriction exists.
- The kiosk is student facing. Capacity reads `Bathroom is full right now. Please try
  again in a few minutes.`; every other rule reads `Please see your teacher before
  leaving.` with the generic `PASSPILOT_RULE_NOT_AVAILABLE` code. Kiosk routes answer
  409 directly instead of passing the denial to the error handler.
- The AI assistant returns `{ success: false, error }` with the staff message (the
  generic message for encounters). A rule denial is never escalated as a system error.
- Messages are counts and destinations only. They never name another student and
  never use labels such as "frequent" or "problem".

## Override

The teacher issue route accepts `overrideRuleCode`, read only while the mode is on.
Only administrators may override (403 `PASSPILOT_RULE_OVERRIDE_FORBIDDEN` for
teachers and office staff; 400 `PASSPILOT_RULE_OVERRIDE_INVALID` for an unknown code).
An override clears exactly one rule code; the remaining rules are still evaluated.
When two rules block a pass, adjust the rule settings instead. An applied override is
recorded three ways: `passes.rule_override_code`, a denial row with `overridden =
true`, and the strict audit action `passpilot.rule.override`. Kiosks and the AI
assistant never override.

## Rules API

`/api/passpilot/admin/rules` uses the settings authorization chain (admin and
school_admin; super admin). While the mode is off the router steps aside before
authentication, so every request gets the same JSON 404 as an unknown API path.

| Method | Path | Body |
|---|---|---|
| GET | `/` | — |
| PUT / DELETE | `/destinations/:destination` | `{ maxConcurrent: 1–500, enabled }` |
| PUT / DELETE | `/limits/default` | `{ dailyLimit: 0–50 or null, periodLimit: 0–50 or null, enabled }` |
| PUT / DELETE | `/limits/students/:studentId` | same as the default limit |
| POST | `/encounters` | `{ studentIdA, studentIdB, reasonNote? }` |
| PATCH / DELETE | `/encounters/:id` | `{ enabled }` |
| GET | `/students/:studentId/records` | — |

Bodies are strict zod schemas (400 `PASSPILOT_RULES_INVALID`). Students must be active
students of the caller's school (400 `PASSPILOT_RULES_STUDENT_NOT_FOUND`), validated
before the same-school foreign key. A duplicate pair returns 409
`PASSPILOT_RULES_ENCOUNTER_EXISTS`. Every write filters by the caller's school, is
audited as `passpilot.rules.update` before success is returned, and responds with
the full rules document so the Rules tab can verify each save with a fresh GET.

## Data, retention and privacy

Four tenant tables (`passpilot_destination_policies`, `passpilot_pass_limits`,
`passpilot_encounter_restrictions`, `passpilot_pass_denials`) carry `school_id`, forced
row-level security with the canonical `tenant_isolation` policy, and same-school
foreign keys to `students(school_id, id)`.

- Denials are written best-effort after the issuance transaction rolls back, on the
  request's tenant context, with the same attribution columns as passes (issuer,
  class source, class, supervision context, issuing kiosk session) so later reports
  can apply the pass-history scope.
- An encounter denial never stores the other student's id or name; it keeps the restriction id only.
- PassPilot rule denial records are retained for 400 days, then deleted by the hourly
  `purgePasspilotPassDenials` scheduler job. The purge runs whether or not the mode
  is on.
- Destination capacity, pass limits and encounter restrictions remain until an administrator deletes them or the school's data is destroyed under the executed agreement.
- Deactivating a student leaves their rule rows in place (students are soft
  deactivated); encounter evaluation ignores deactivated students. Hard deletion of
  a student cascades to that student's rule rows.
- For a verified access request (Privacy Policy section 10.1), administrators export
  one student's rule records with `GET /students/:studentId/records`: the student's
  limit row, the number of encounter restrictions (the paired student is another
  student's record and is not disclosed) and the retained denial history. Each
  export is audited as `passpilot.rules.records.export`.

## Flag and activation

`PASSPILOT_RULES_MODE` accepts only `off` and `on`; any other value is off. Even `on`
stays off unless `RLS_GUC_ENABLED=true` and `RLS_ENABLED_TABLES` contains all four
rule tables. With the mode off the helper returns before any query, the rules router
404s and the Rules tab is hidden. The observable differences from the release
before this feature are the one admin-only `GET /api/passpilot/admin/rules` probe in
School Setup (which 404s) and nothing else: pass responses include
`ruleOverrideCode` only for an overridden pass.

This release adds no production setter. The mode is changed only through the governed
product runtime tool, `scripts/deploy-product-runtime-config.ps1`
(`docs/PRODUCT_RUNTIME_CONFIG_OPERATIONS.md`), never by editing a task definition. Its
`passpilotRules` gate refuses `PASSPILOT_RULES_MODE=on` unless the live API and worker
both have `RLS_GUC_ENABLED=true` and all four rule tables in `RLS_ENABLED_TABLES`.

## Release procedure (requires a separate deployment request)

1. Deploy the backend with the reviewed bundle once:
   `scripts/deploy.sh production --backend --activate-emergency --enable-rls-table passpilot_destination_policies,passpilot_pass_limits,passpilot_encounter_restrictions,passpilot_pass_denials`.
   The live API and worker allowlists must equal the verified 121-table baseline.
   The ledger migrations are `passpilot-rules-20260929` (tables, RLS, the nullable
   `passes.rule_override_code` and its NOT VALID check) and
   `passpilot-rules-indexes-online-20260929` (two `CREATE INDEX CONCURRENTLY` builds
   on `passes`). Leave `PASSPILOT_RULES_MODE` unset.
2. Verify with a privileged migration connection (no student data):

   ```sql
   SELECT id, status FROM schema_migrations
   WHERE id IN ('passpilot-rules-20260929', 'passpilot-rules-indexes-online-20260929');
   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE relname IN ('passpilot_destination_policies', 'passpilot_pass_limits',
                     'passpilot_encounter_restrictions', 'passpilot_pass_denials');
   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('passes_school_student_issued_idx', 'passes_school_destination_active_idx');
   ```

3. Publish the frontend after the backend is healthy. With the mode off, School Setup
   shows no Rules tab.
4. A later, separately approved run of `scripts/deploy-product-runtime-config.ps1`
   sets `PASSPILOT_RULES_MODE=on` (Plan, then Apply). A separate baseline adoption
   change records the observed 125-table allowlist in `infra/production.tfvars`.

Rollback is `PASSPILOT_RULES_MODE=off` (or unset): evaluation stops, the router
404s and the tab disappears. The tables, the column and the indexes stay; the
checksum-ledger migrations are never reverted. Denials keep expiring on schedule.

## Verification

- `tests/passpilot-rules.test.ts` — mode parser and RLS gate, messages and audience
  shaping, bell-period selection across DST, school-local day bounds, purge.
- `tests/passpilot-rules-contract.test.ts` — insert-site ordering, caller handling,
  migration checksums and manifest position, Drizzle parity, retention wording.
- `tests/passpilot-rules.integration.test.ts` (DB lane) — every rule on the teacher,
  kiosk, activity kiosk and AI paths, overrides, denial rows, the last-slot race and
  the previous-local-day boundary.
- `tests/passpilot-rules-rls.test.ts` (RLS lane) — school-scoped reads, cross-school
  writes rejected by `WITH CHECK`, and denial writes under forced RLS.
- `npm run test:passpilot-rules` in `schoolpilot-app` — Rules tab, override dialog
  and the kiosk denial message in Chromium.
