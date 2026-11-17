# Student Classroom Access Implementation Plan

> **For agentic workers:** Use coordinated implementation with disjoint file ownership and one independent whole-branch review. Steps use checkbox syntax for progress.

**Goal:** Permit each student's own published Classroom work across courses in website Focus and manual/automatic Flight Paths, keeping Google Search outside the allowed set.

**Architecture:** Student-subject DWD source discovery and separate administrator content approval feed purpose-bound review and per-target server state. Existing 3.0.7 wire primitives enforce the result; private source/proof provenance remains server-side. Automatic starts prepare sources before outer locks and freeze per-student session payloads.

**Tech stack:** TypeScript/Express/Drizzle/PostgreSQL, Google Classroom API, React/Vite, node:test and native Chromium extension acceptance.

**Spec:** `docs/superpowers/specs/2026-11-16-student-classroom-access-design.md`.

## Global constraints

- Exact current school/student/control authority; no teacher-facing device IDs or empty-target broadcast.
- No cross-student permission union; no external crawling or Google Search grants.
- No source/provider networking on heartbeat or under class/student authority locks.
- Keep existing 3.0.7 ZIP/tag/checksum unchanged; no Store upload.
- Four student reads and two course reads per student concurrently; 8-second calls, 12-second student and 30-second batch deadlines; existing per-student source/compiled budgets; aggregate private command ceiling 512 KiB.
- API/web deploy leaves Classroom capability off until separate administrator approval/managed-device verification/guarded activation.

## Review focus

1. A shared Chromebook's Chrome-profile account must never substitute for the active student's canonical Google identity (task 1).
2. Two selected students with different courses/individual assignments must never receive each other's outside websites (tasks 1/2/4).
3. A revoked/reconnected connector, changed saved path or stale source completing late cannot resurrect an old permission (tasks 1/2/3).
4. Automatic Today/report promotion cannot perform Google reads while authority locks are held or overwrite manual overrides (task 3).
5. A malformed/private provenance marker, domain-only path, Coverage restore or legacy client cannot silently drop a permission fence (tasks 2/5).

### Task 1: Student source and administrator content purpose

**Files:** `classpilotStudentClassroomAccessSource.ts`, `googleClassroomAccess.ts`, content setup routes, connector storage/schema/migration and source/admin tests.

**Interface:** `resolveStudentClassroomAccessSources({schoolId,studentIds}, dependencies?)` returns per-student scopes/counts/approval keys. Administrator content setup lives at `/api/google/roster-connector/classroom-access` and uses a canonical imported student for verification.

- [x] Write and run failing identity/domain/approval/visibility/pagination/deadline/budget/CAS tests; retain red receipts.
- [x] Implement student-subject source reads and separate content setup without widening roster scopes or damaging roster status on failure.
- [x] Bind source caches to approval generations and isolate invalidation by school; deliberately exclude known Search links with review warnings.
- [x] Run source/admin/migration/readiness and existing roster/source regressions; retain green receipts.

### Task 2: Manual review, per-target persistence and compiled delivery

**Files:** common Classroom review/compiler service; command validation/dispatcher/routes; state/delivery/lifecycle/teacher intent/precise rollback and command-transaction storage ranges.

**Interface:** generic review mode `focus` or `flight-path`; confirmation adds opaque `classroomAccess:{reviewToken}`. Private `classroomAccessV1` command maps and `classroomMaterials` provenance never reach public or wire projections.

- [x] Write/run red proof/mode/target/source/path mutation/Search and private-map tests.
- [x] Implement mode/path-bound proofs, per-target persistence/frame selection and compilation; recheck the exact saved path under lock.
- [x] Preserve provenance and approval-generation fences through state, restoration, all delivery transports and teacher intent; preserve successful login when content authorization is withdrawn.
- [x] Extend clear/rollback to domain-only derived paths, inactive/restorable states and automatic session maps.
- [x] Run affected command/projection/transport/history/intent/rollback suites and real HTTP/WebSocket fixtures.

### Task 3: Reviewed automatic policy and preflight lifecycle

**Files:** automatic policy/state/preparation services, group policy routes, scheduled/manual/Today helpers and automatic storage ranges.

**Interface:** group-specific `/automatic-flight-path/classroom-preview` binds policy/path/roster/source versions. Durable schema-2 approval is class/path/primary-teacher specific. Frozen session state contains separate per-student compiled payloads.

- [x] Write/run red setup/current-and-future permission, lock ordering, stale preparation and override tests.
- [x] Implement bounded preparation before outer manual/scheduled/Today authority locks; no Google calls in the initializer.
- [x] Freeze per-student state once; preserve it through reconciliation, Coverage, deferred login and Focus overlays.
- [x] Run automatic/scheduled/Today/session and restricted-RLS fixtures; fix public Group/audit projections without altering internal state.

### Task 4: Teacher and administrator UI

**Files:** Dashboard; generic Classroom access hook/library/review component; AutomaticFlightPathSetup; Google roster connector administrator setup component; native Dashboard/setup tests.

- [x] Write/run red behavioral tests for all-courses preview and no stale course/recipient/path proof, exact manual payloads, automatic review before save and disabled/incompatible targets.
- [x] Replace domain Classroom Focus course selection with per-student all-courses review; add it to manual Flight Path application and automatic preset setup. Leave This resource only unchanged.
- [x] Show administrator content-permission setup separately, with combined-scope copy and exact school student selection for verification.
- [x] Keep signed review invalidation on student/class/path/actor/school edits, expiry, closure and save; disclose website breadth and automatic future-publication permission.
- [x] Run affected browser tests, frontend lint/build and existing command recipient gates. Initial static assertion/fixture failures and one cold browser timeout are preserved with their successful final retries.

### Task 5: Native acceptance, review, CI and release

- [x] Use the canonical `ClassPilot-v3.0.7.zip` hash `bf884705903cc8234024933ba5d9ee297dd8a30f56393674655ed07f5963346a` for native per-student Focus/Flight Path, new-tab Google Search denial, assignments, blocks, Focus/Unfocus and restore acceptance. Do not rebuild it.
- [ ] Run required server checks/type ratchets and relevant complete test lanes; independent whole-branch review; resolve findings with meaningful red/green regressions.
- [ ] Commit/push PR; confirm all required CI checks; merge main. Deploy guarded backend then frontend from clean current main; verify digest/SHA/health/autoscaling and public assets. Preserve Classroom capability off.
- [ ] Save release/test/deploy receipts, verify unchanged 3.0.7 artifact identity, remove only this task's local/remote branch/worktree, preserve primary user work and report the administrator/managed-rollout prerequisites accurately.
