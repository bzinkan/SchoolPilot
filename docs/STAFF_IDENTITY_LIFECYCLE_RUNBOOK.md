# Staff Identity Lifecycle Runbook

Staff email corrections must preserve `users.id`. Never delete and recreate a
staff account to correct an email address. Classes and other live ownership
records reference the immutable user ID, not the person's name or email.

## Correct an email

1. Open **ClassPilot → Admin → Staff & Settings** and select the staff row by
   membership ID, displayed name, and email. Do not select by name alone.
2. Edit the email on the existing row. The API requires the email originally
   displayed by the form and returns the unchanged user ID plus normalized
   email.
3. Ask the staff member to sign out and back in. The correction increments
   `auth_version`, invalidating existing HTTP, JWT, Socket.IO, and WebSocket
   credentials.
4. Confirm the existing classes and roster counts are unchanged.

For a same-name warning, choose **Edit existing email** or **Reactivate** when
it is the same person. Use **This is a different person** only after confirming
that the people are distinct; that decision is audited. A multi-school
identity requires Super Admin review and must satisfy every active school's
domain policy.

## Remove access or change to a non-teaching role

Use the guided staff transition. Review its revisioned impact, end every listed
active session/kiosk/schedule workflow, and make an explicit decision for every
dependency. Required ownership needs an active same-school replacement;
optional relationships may be removed. The transaction rechecks the revision,
replacement eligibility, and schedule conflicts before changing access.

Legacy delete and role-change routes fail with
`STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT` when this workflow is required.

## Controlled identity repair

The repair CLI is dry-run-first and emits only IDs and counts. All-school mode
is inventory-only:

```text
npm run repair:classpilot-staff-identity -- --all-schools
```

An exact-school dry run requires the reviewed source and target user IDs:

```text
npm run repair:classpilot-staff-identity -- --school-id <school-uuid> --source-user-id <old-user-uuid> --target-user-id <current-user-uuid>
```

Execution is permitted only as a controlled ECS one-off task, including when a
developer shell is configured for a nonproduction database. The task override must set
`STAFF_IDENTITY_REPAIR_EXECUTION_ADMISSION=controlled-ecs-one-off-v1`; the CLI
also verifies the task through the ECS v4 metadata endpoint before opening a
database connection. Copy the exact dry-run revision and provide a verified
Super Admin actor:

```text
npm run repair:classpilot-staff-identity -- --school-id <school-uuid> --source-user-id <old-user-uuid> --target-user-id <current-user-uuid> --execute --revision <staff-impact-v2:...> --proof <staff-repair-proof-v1:...> --super-admin-actor-id <actor-uuid> --acknowledge staff-identity-repair-v1
```

Execution also requires `--proof <staff-repair-proof-v1:...>` copied exactly
from the same dry run. The proof binds the school, both memberships, impact
revision, and pre-repair class/roster/history counts.

Do not repair identities with direct SQL or a request endpoint. The recovery
transaction preserves class IDs, rosters, schedules, and history, and records a
transactional audit event.

## Staged release

1. Repair the known staff assignment through the existing class editor and
   verify user IDs, class IDs, and roster counts.
2. Run the normal production migration one-off with
   `--apply-staff-identity-contracts` omitted. The deploy controller explicitly
   sets `APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS=false` for that one-off. This
   applies the additive `auth_version` migration while deferring the final
   contract.
3. Deploy the backend, drain old API instances, then deploy the frontend.
4. Run the all-school inventory. Resolve every class ownership finding and
   normalized-email collision.
5. From a clean, green `main`, run the explicit production backend-only
   stage-five deployment:

   ```bash
   ./scripts/deploy.sh production --backend --apply-staff-identity-contracts
   ```

   Run this from the same clean, green `main` SHA used by step 3. This is a
   migration-only path: it proves the active API and singleton worker are both
   pinned to that main image digest, rejects a retained rollout flag on either
   service, reuses the exact active API revision for the one-off, and never
   builds, pushes, registers, or updates an API/worker service revision.

   The flag is valid only for a production backend migration and sets
   `APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS=true` only in the migration
   one-off. The one aggregate preflight counts normalized-email collisions and
   every live staff-ownership violation while the covered tables are locked.
   Email normalization, the unique index, and all integrity triggers then
   commit in one ledger-managed transaction. Any nonzero count or DDL failure
   rolls back the entire contract; the email index cannot be left partially
   installed. The single durable migration-ledger marker keeps the contract
   manifest active for every later one-off even after the flag is omitted.
6. Rerun the inventory immediately and the next day. Any nonzero result or
   repeated lifecycle-guard violation requires investigation.

No ClassPilot extension release or student/device assignment change is part of
this procedure.
