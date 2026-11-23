# PassPilot kiosk scheduling

Teachers opt in at **PassPilot → Settings → Kiosk schedule**, also linked from
My Class. Administrators can choose a teacher; office staff cannot edit schedules.
Existing teachers default to Manual. Preferences belong to the teacher and school,
so newly claimed and remembered/resumed kiosks inherit them independently of the
teacher's selected class tab.

## Assignment contract

- Follow PassPilot schedule uses assigned standalone classes, weekly blocks,
  optional effective dates, and dated replacements (including empty days off).
  Administrator closures always win. Times use the school timezone. Overlapping
  and overnight blocks are rejected; adjacent and repeated meetings are supported.
- Follow ClassPilot requires active ClassPilot entitlement and explicit teacher
  opt-in. Administrators select the teacher; teachers manage their own preference.
  The kiosk follows that teacher's primary/co-teacher assignments as students
  change classes. It works with either school-wide PassPilot class source and
  never migrates grades, creates mappings, or changes manual class tabs.
  Ordinary classes use the scheduling helpers, calendar, approved swaps, applied
  profiles, frozen occurrences/rosters and skips. An open dashboard, teaching
  session or connected Chromebook is unnecessary.
- Active assigned testing and scheduled coverage take precedence. Rosters use
  unreleased supervision assignments, including offline students. Pending or
  failed testing blocks block checkout; ambiguous assignments require staff
  selection. Ad hoc claims and saved testing-group membership do not activate a
  testing assignment. Reads do not activate sessions or send device commands.
- Send to Kiosk creates an individual/bulk temporary override. Its deadline is
  the next effective schedule transition or school-local midnight. Later schedule
  edits can shorten it. Resume automatic clears the override immediately; only
  an explicit setting change selects Manual permanently. These manual targets
  use the school's PassPilot class source, so a legacy grade can temporarily
  override a teacher's ClassPilot schedule before returning to that timetable.
- Polling resolves today plus a bounded seven-day preview, never the Dashboard's
  multi-day projection. A null next assignment means none in that preview.
  Five-second polling plus boundary/focus/reconnect refreshes keep the display
  current. Effective assignment, roster, ownership and supervision revisions
  invalidate the displayed revision and unfinished student forms.

Session-bound clients send both the existing class-model header and
`X-PassPilot-Kiosk-Activity: scheduled-activities-v1`. Snapshots and student lists
can omit a class ID. They return activity identity/kind/name, roster, return-only
students, server time, boundary and assignment revision. Checkouts echo
`assignmentRevision`. The server resolves it again under the school lifecycle,
PassPilot configuration, calendar and student authority locks. A conflict requires
a fresh student selection; the browser never retries against a new assignment.
Older clients retain manual behavior and receive HTTP 426 for automatic mode.
The class-model capability is required for ClassPilot automatic mode even when
the school continues using legacy PassPilot grades.

Each class-assigned kiosk lists, looks up, and returns active passes only for its
current class, matched by both class source and class ID. The server rechecks the
assignment when returning a pass, so a stale kiosk screen cannot return a pass
from its previous class after reassignment or a schedule transition. The kiosk's
**Return a pass** lookup uses the same class scope. Classless testing and coverage
assignments and kiosks without a current class keep their existing return
behavior. Teachers can still return an outstanding pass from any class in the
PassPilot dashboard. Overdue deadlines do not automatically return a pass.
Checkout eligibility and history permissions are unchanged. Device continuity
IDs never authorize a return; current PassPilot/kiosk authorization, school
isolation, and valid kiosk sessions still apply.

Authenticated teachers and school managers can also find and return an exact
same-school active pass regardless of who issued it. This return-only authority
does not grant access to another teacher's pass history, notes, or cancellation
actions. New kiosk clients include the selected pass ID when checking in so a
stale selection cannot return a newly issued replacement pass.

Testing/coverage passes retain their supervision context, immutable activity name,
activity kind and issuing kiosk origin. They have no fabricated class ID. History,
exports and timeline events preserve that attribution; regular-teacher roster
membership does not grant access to another teacher's activity passes.
Regular ClassPilot kiosk passes retain the official class ID and name while
standalone passes retain their grade ID. Reports can include both sources;
ClassPilot membership alone does not grant access to legacy student history.
Teacher opt-in and kiosk checkout never set a legacy school's canonical-write
cutover marker. No additional migration is needed for teacher-based scheduling
on top of the original kiosk-scheduling schema.

## Public kiosk API and launch tickets

- Public kiosk requests require `X-School-Id` plus either `X-Kiosk-Token` or the compatibility `X-Kiosk-Pin`. `POST /api/passpilot/kiosk/auth` exchanges a valid PIN for a 15-minute token; current school lifecycle, PassPilot license, kiosk enablement, and PIN-hash state are rechecked on every request, so revocation or PIN rotation takes effect immediately.
- `GET /api/passpilot/kiosk/snapshot?classId=...` is the bounded polling contract. It returns config, the optional teacher-bound kiosk session, roster students, active passes, revisions, and an ETag. The existing `/config`, `/students`, and PIN routes remain available during migration.
- `POST /api/passpilot/kiosk/client-health` accepts only the bounded `snapshot_failure` / `snapshot_recovery` enum contract after at least three consecutive failures. Event types are rate-limited for five minutes using an opaque Redis key with a bounded local fallback.
- `POST /api/classpilot/kiosk/launch-ticket/preflight` requires `X-School-Id` plus that exact school's `X-ClassPilot-Enrollment-Key`, applies no-store/rate-limit policy, and negotiates `scopedAuthorityChecksV1` plus `kioskLaunchTicketV2` without a directory identifier. The extension must not call `chrome.enterprise.deviceAttributes` unless this preflight accepts V2.
- `POST /api/classpilot/kiosk/launch-ticket` revalidates the exact school/key, ClassPilot and PassPilot entitlements, school lifecycle, kiosk configuration, Redis, and accepted ticket capability. V1 remains a disabled 60-second compatibility path. V2 returns a one-use 600-second ticket and immediately reduces the raw directory identifier to the new school-scoped HMAC ID plus the exact legacy 2.6.9 deterministic ID; only those opaque identifiers, the school, and bounded timestamps enter Redis. The raw identifier is never stored, logged, returned, or placed in a URL.
- `POST /api/passpilot/kiosk/launch-ticket/redeem` requires current kiosk PIN/token authorization before consuming the ticket. It returns only `continuityOnly: true` plus an opaque school-scoped UUID-shaped `deviceId`; this ID preserves same-school kiosk continuity and is never a kiosk credential. Tickets are HMAC-keyed and atomically consumed with Redis `GETDEL` in production.
- Public kiosk hot paths execute tenant queries inside one RLS checkout. Kiosk tokens, PINs, device IDs, session IDs, and school/student identifiers must never be added to kiosk metric labels or logs. Student roster DTOs remain separate from kiosk/Chromebook device records.

### Kiosk credentials and ticket rotation

`KIOSK_TOKEN_SECRET` falls back to `JWT_SECRET`. The opaque health rate-limit
keys can rotate independently with `KIOSK_HEALTH_HMAC_SECRET`. Keep
`CLASSPILOT_KIOSK_TICKET_HMAC_SECRET` stable during ordinary deployments.
Its rotation also resets managed-device continuity. Use the reviewed
coordinated rollout and preserve purpose-separated HMACs.

### PassPilot Overdue Lifecycle
- `schools.default_pass_duration` is the administrator-configurable overdue threshold for newly issued passes (1-240 whole minutes), not an automatic return timer.
- A pass remains `active` after `expires_at` until an explicit return or cancellation. Active-pass reads and duplicate-issuance checks must not filter or mutate rows based on `expires_at`.
- Derive overdue presentation as `status === "active" && now >= expiresAt`; do not persist a new overdue status. Retain historical `expired` rows unchanged.
- Teacher, kiosk, and AI issuance use the school threshold when no per-pass duration override is provided. Existing passes keep their recorded `duration` and `expires_at` when the setting changes.
- Return authority is independent of the issuing teacher, kiosk, class, or activity. Authorized same-school kiosks and PassPilot teachers/managers can return an exact active pass, including overdue passes, even between class assignments. Keep checkout, history, cancellation, school isolation, and kiosk authentication separate. The bounded **Return a pass** lookup exposes only return-selection identity; kiosk clients include the selected pass ID to reject stale selections.

## Release procedure (requires a separate deployment request)

This implementation does not deploy or alter production. For a later release:

1. Use the [backend deployment runbook](PRODUCTION_DEPLOYMENT.md#deploy-sequence--backend), admitting the new
   singleton with `--enable-rls-table passpilot_teacher_kiosk_settings` only on
   its first rollout. Preserve every other live RLS setting. The checksum-ledger
   expand migration is `passpilot-kiosk-schedule-20260924`.
2. Before the frontend, verify the migration completed and the deployment's
   catalog gate confirms enabled/forced RLS plus the tenant policy. Confirm the
   API and worker share the new allowlist entry. Retain the historical Terraform
   baseline until a separate observation/adoption change.
3. Verify the additive schema and constraints using a privileged migration
   connection. These queries contain no student data:

   ```sql
   SELECT id, status, checksum FROM schema_migrations
   WHERE id = 'passpilot-kiosk-schedule-20260924';
   SELECT relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE oid = 'passpilot_teacher_kiosk_settings'::regclass;
   SELECT policyname, qual, with_check FROM pg_policies
   WHERE tablename = 'passpilot_teacher_kiosk_settings';
   SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'passes'
     AND column_name IN ('supervision_context_id','activity_kind',
                         'activity_name_snapshot','issuing_kiosk_session_id');
   SELECT conname, convalidated FROM pg_constraint
   WHERE conrelid = 'passes'::regclass AND conname = 'passes_activity_shape_check';
   ```

4. Publish the compatible frontend only after the backend is healthy. Verify a
   Manual kiosk, then opt in fixture teachers for each supported source. Exercise
   a transition, temporary override/resume, testing partial release, stale
   checkout conflict, and return after transition before wider opt-in.
5. Monitor `passpilot_kiosk_hot_path_summary`: `assignmentFailures`,
   `staleCheckoutConflicts`, `returnFailures`, and `snapshotMs`. These are fixed,
   process-wide aggregates without student, school or kiosk identifiers.

For containment, `PASSPILOT_AUTOMATIC_KIOSK_ENABLED=false` disables automatic
resolution and new automatic checkout. Teachers can explicitly choose Manual;
eligible outstanding returns remain available. Preserve the additive schema and
activity-aware pass/return handlers during rollback; never downgrade to code that
cannot represent issued activity passes. No Chrome extension or Store release is
needed.

## Verification

`tests/passpilot-kiosk-schedule.test.ts` covers date/time rules, DST, closures,
overlaps, priority, gaps and effective boundaries. The serial integration suite
uses local PostgreSQL fixtures and the real Express router for assignment,
entitlement, concurrency, return continuity, reporting access, parent checks and
non-owner RLS denial. It also measures concurrent snapshots and verifies reads
create no ClassPilot sessions or supervision state.

Run `npm run test:passpilot-kiosk-schedule` in `schoolpilot-app` for both kiosk
interfaces and the schedule editor. This test is also in the frontend release
suite. Backend type/build, test type/cast ratchets, registry checks, existing kiosk
regressions, frontend lint/build and the repository CI lanes remain required.
