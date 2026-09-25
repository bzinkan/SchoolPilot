# My Desk private seating charts

This is the implementation and proposed rollout contract for seating charts in
ClassPilot web. It is not evidence of production deployment or an operating
privacy/retention control. The notebook prerequisites and storage cleanup remain
governed by [MYDESK_PRIVATE_NOTEBOOK.md](MYDESK_PRIVATE_NOTEBOOK.md).

## Access and stored data

Every request requires the base My Desk gate, the seating gate, ClassPilot
entitlement, and the author's current staff membership in the active school.
Teachers and school administrators own separate charts. Administrative access
does not permit reading another author's charts. Author predicates enforce that
boundary; forced tenant RLS provides school isolation. There is no shared chart,
Chromebook/device assignment, student-facing view, AI input, or timeline event.

`mydesk_seating_charts` stores the author's chart name, desk positions and lock
state, selected school student IDs, and class/roster name snapshots. The live
composite class FK detaches only `group_id` on class deletion; `filing_group_id`
and snapshots retain historical context. Past-class charts remain privately
readable and deletable. Editing requires access to the current class; copying a
layout to a current class clears student assignments and desk locks.

The version-1 layout permits at most 100 desks on a 1200 by 900 coordinate board,
with 100 by 60 desks snapped to a 10-unit grid. Application validation rejects
overlap, duplicate desk/student IDs, and positions outside the board. Roster
snapshots contain at most 1,000 students. Server-derived roster revisions detect
stale names or assignments; clients must refresh before saving a changed roster.
Student records supply names and IDs, never device identities.
Derived names are bounded to 500 characters, student IDs to 128, and serialized
roster snapshots to 1,000,000 bytes before saving. The database also enforces a
1-MiB JSON ceiling; oversized source records require correction before saving.

Writes use the existing short school-scoped database transaction. Class advisory
locks serialize current-chart selection; class and roster row locks protect the
save snapshot. The first chart for an author's class is current. Deleting the
current chart does not automatically select a replacement. A partial unique
index enforces at most one active current chart per school, author, and filing
class. Revisions prevent overwriting another edit. Create request IDs and hashes
prevent duplicate creates; the last 100 mutation receipts store only operation
IDs, hashes, revisions, and kinds for bounded retry recognition.

## Privacy and retention

Charts and roster snapshots remain in PostgreSQL until author deletion or the
verified school-account destruction process. Chart deletion atomically clears
the chart/class names, layout, roster snapshot, roster revision, live class ID,
and current status. The remaining request tombstone retains only ownership,
filing/request IDs, hashes, operational receipts, and timestamps; it is not a
recoverable chart. No S3 object or new scheduled cleanup job is involved.

Audit events contain operation identifiers only. Chart names, student names,
layout content, and roster snapshots must not enter audit/error logs or release
evidence. The existing My Desk no-store responses and upstream private-error
boundary also cover seating routes. Printing uses the browser's own print flow;
delivered charts and prints cannot be recalled by the server.

Disabling either feature gate or revoking membership prevents access without
deleting records. Permanent account destruction must include seating rows and
their tombstones before hard-deleting the referenced users/schools, plus the
existing backup-retention process. Soft deletion is not proof of complete
destruction. Apply the executed agreement and WISP section 9.

## Rollout and rollback

1. Complete and verify the separate M1 notebook deployment and admission first:
   both `mydesk_attachments` and `mydesk_notes` must already be in the matching
   live API and worker RLS allowlists. This seating release does not combine or
   substitute for M1's reviewed admission. Keep both pilot flags empty until the
   required migrations and access checks have passed.
   The current combined backend manifest installs both notebook and seating
   migrations. It is not an M1-only artifact: using it for step 1 would create
   and enforce seating RLS before its separate allowlist admission. Package and
   review an M1-only predecessor release, verify it live, then release this
   combined artifact with seating admission. Do not infer that an empty feature
   flag defers a schema migration or that the deploy helper verifies all catalog
   tables; explicitly inspect the table policies after each release.
   If a reviewed immutable build from before seating changes exists, verify its
   source revision and manifest before using it. This working branch contains
   combined, uncommitted work and does not supply such a release. Otherwise
   prepare a separate M1 commit/PR: review the notebook-only dependency closure,
   including route/schema exports, migration manifest, bootstrap, RLS inventory,
   environment flags, and frontend capabilities. Its manifest must include the
   unchanged `mydesk-private-notebook-20260925` migration and exclude seating;
   its admission inventory must contain the notebook pair without seating.
   Run M1 schema/API/storage/RLS and build checks on that exact commit, review the
   diff, and build/tag an immutable artifact from it. Do not hand-copy selected
   runtime files or edit a built image to manufacture the predecessor. Deploy and
   verify that artifact before building/releasing the reviewed seating commit.
   Once AI import code is included, the combined manifest also creates its three
   tables. A seating-only admission needs a reviewed predecessor artifact without
   that import migration. Follow [MYDESK_AI_IMPORT.md](MYDESK_AI_IMPORT.md) for the
   later three-table admission; neither feature gate defers DDL.
2. Run the schema behavior, restricted-role API, validator, frontend, and
   registry/admission tests, backend/frontend checks, and `npm run soc2:check`.
   The additive ledger migration is `mydesk-private-seating-20260925`; do not
   change the earlier notebook migration. Drizzle cannot express column-only
   `ON DELETE SET NULL (group_id)`: run the canonical migration after nonproduction
   `db:push` and verify it repairs that FK.
3. Preserve live task-definition fields and capture rollback digests/families.
   Use the exact reviewed one-release admission after confirming step 1:

   ```bash
   ./scripts/deploy.sh production --backend --activate-emergency --enable-rls-table mydesk_seating_charts
   ```

   Verify the migration ledger, enabled/forced RLS and tenant policy on the new
   table, matching API/worker allowlists, and healthy services. Omit the admission
   flag on later deploys. Keep the generic and production Terraform RLS baseline
   unchanged until verified live adoption; record any baseline update in a
   separate reviewed change. The registry's complete post-seating inventory is
   106 tables; this is not a claim that production has adopted that inventory.
4. The only seating infrastructure setting is
   `MYDESK_SEATING_ENABLED_SCHOOL_IDS`, default empty. It is added to both existing
   API/worker bootstrap templates when the notebook bucket is configured. Seating
   adds no bucket, IAM permission, service, or scheduler. Terraform templates are
   not the live task definitions; do not replace serving definitions with them.
   Any real Terraform operation still requires CLAUDE.md's separate saved-plan,
   backup, and operator go/no-go procedure. Mocked/offline checks are not an apply.
5. Deploy frontend after backend verification. Admit a reviewed school to both
   `MYDESK_ENABLED_SCHOOL_IDS` and `MYDESK_SEATING_ENABLED_SCHOOL_IDS` in the live
   runtime configuration. Verify two teachers and an administrator cannot read
   one another's charts; save/retry/conflict handling, roster-change rejection,
   current-chart switching, past-class reading/copying, deletion, and printing.
   Retain only non-content operator evidence privately.

Rollback first empties the seating allowlist; the base notebook may remain
enabled. Retain admitted RLS entries, schema, chart data, notebook bucket/IAM,
and the attachment cleanup worker. Prefer a feature-aware repaired image once
charts exist; selecting an older image requires the repository's existing
data-compatibility gates. No AWS apply, deployment, production migration, or
runtime activation is authorized by this document.

## Local verification — September 25, 2026

Verification used synthetic local schools and students, not production data.

- Full backend regression command: 2,568 passed, zero failures, three conditional
  skips. The separate seating HTTP suite passed all eight cases under both the
  ordinary database connection and a restricted, non-owner RLS role.
- Full restricted RLS lane: 146 passed, zero failures; its Redis availability
  skip was exercised successfully with isolated Redis in the full backend run.
  Existing notebook ownership and request-lifecycle cases also passed.
- Five seating schema behavior tests and sixteen registry/admission checks
  passed. Fresh Drizzle bootstrap plus canonical composite-FK repair, Terraform
  validation, two mocked plans, and SOC2 documentation checks passed.
- Seating frontend: fourteen tests passed (eight browser workflows and six
  model tests). Existing My Desk: fourteen tests passed. Router/dashboard
  regression checks, frontend lint (zero errors; existing warnings), backend
  typecheck/build, frontend production build, and preview smoke passed.
- Synthetic thirty-seat and hundred-seat charts produced single-page Letter
  and A4 PDFs. Rendered output was visually inspected; browser checks verified
  names remain inside desks and controls, locks, and private notes are excluded.
  Desktop and phone-size browser workflows passed.

Real Android verification remains a pilot prerequisite: no device was connected.
No production migration, AWS provisioning, deployment, or flag activation was
performed. The separately reviewed M1 predecessor release and the admission
sequence above remain required.
