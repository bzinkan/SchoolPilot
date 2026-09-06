# Roster integrations

School administrators manage imports from **Classes → Roster integrations**. This feature requires the roster migration, the four roster tables in the tenant RLS inventory, and the dedicated scheduler worker. No production or provider pilot was performed as part of implementation.

## Review and ownership

Create a connection with a stable source identifier. Upload a full OneRoster ZIP, or enter a Clever district data token and select **Sync now**. Map the external school organizations to the currently active, existing SchoolPilot school. Preview matches and changes; resolve ambiguous identities, optionally link existing classes and explicitly adopt fields; then apply the reviewed preview. Schools, licenses, staff invitations and administrator permissions are never created by import.

Initial person matches use exact normalized email or student number within the school. Conflicting matches require review; names are never identity keys. Teachers must map to active school teaching staff with the school email domain. Subsequent imports use stable provider identities and preserve internal IDs, history and PINs. Students missing from a source are never deactivated.

New records are owned by the source. Existing matched records retain their fields unless the administrator explicitly adopts them. A manual change to an owned field releases that field from source ownership. Membership removal is permitted only for that connection's owned membership when its physical row still matches and no manual or other-source contribution protects it. Source-created classes absent from a complete snapshot may be archived only when they have no manual or shared ownership. Existing class schedule, teacher and PassPilot workflow guards also apply.

Every mutation checkpoints its cursor and ownership changes in the same transaction. Requests perform up to 25 steps; the worker continues up to 100 per pass. Retrying a completed import returns its existing result. Roster or connection changes invalidate a preview with HTTP 409; review a fresh preview rather than applying stale assumptions. A failed partial import retains committed steps and resumes from its checkpoint, or can be previewed again against the current roster.

The saved plan includes named student and staff additions/removals, primary/co-teacher role changes, and actual before → after owned-field values. Its hash covers that review data. The review endpoint returns at most 50 changes per page and rejects a different plan hash; the UI exposes every page and binds acknowledgement to that preview. A class returning after this integration archived it is restored only when its source provenance and archive timestamp still match. Manual or unverifiable archives remain unresolved until an administrator restores the class in Classes. Restored source classes keep scheduling disabled.

## OneRoster contract

The adapter dispatches OneRoster 1.1 and 1.2 CSV bulk packages and rejects delta or mixed packages. Required core files are manifest, organizations, users, academic sessions, courses, classes and enrollments; 1.2 also requires roles. The complete package is validated before school selection, including duplicate identities, manifest declarations, role and parent references, cycles, dates and enrollment relationships. A class with multiple teachers requires one unambiguous primary teacher; changing the primary teacher across enrollment periods requires separate class records.

Core required fields include user `enabledUser` and `username`, academic session `schoolYear`, class `classType`, and (for 1.2) `roles.roleType`. The 1.2.1 CSV binding still uses `oneroster.version=1.2`. A supplied user profile must exist and belong to the role's user. Invalid role spellings reject the package. Custom `ext:` roster roles require a mapping feature that this importer does not support and are explicitly rejected; permitted extensions to non-role class/organization/session types are accepted for 1.2. Standard roles other than teacher/student never grant local permissions. Source `enabledUser=false` remains an active roster record and produces a warning: local access changes use the existing school account lifecycle workflow.

Role and enrollment date intervals are validated and reported with a preview warning; they do not schedule membership activation or removal. Export the intended current roster before applying a bulk snapshot.

ZIP limits are 25 MiB compressed, 250 MiB expanded, 100 entries and 250,000 CSV records. Files must be root CSV entries; traversal, encrypted archives and symbolic links are rejected without filesystem extraction. Entries are parsed as streams into the necessary validation/import columns; expanded entry buffers, passwords, descriptions and unrelated metadata are not retained. Declared sizes and streamed expansion are both checked, and field/row limits apply even to discarded columns. Optional recognized files receive CSV structure and recognized-reference checks, not full gradebook/resource validation, and their data is not imported. Actual FACTS, PowerSchool and Rediker exports still require representative vendor validation; passing the adapter tests is not OneRoster certification.

## Clever operation

Tokens are encrypted using the server's existing secret encryption service and are never returned by a read API or included in audit metadata. Configure `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY` according to the existing crypto service; its previous-key setting supports key rotation. Reconnect replaces the token; disconnect clears it, pauses the connection and stops queued work. Credential rejection requires reconnect. District sharing and the provider's required Secure Sync access must be arranged separately.

The worker verifies the district and fetches all pages of schools, users, sections, courses and terms before staging any changes. Pagination is restricted to the same fixed Clever API origin and resource, with loop, duplicate, row, byte and timeout limits. Teacher role data is consumed without granting any administrative role from multi-role users.

A queued sync is bound to its connection revision through fetching and automatic preview. Reconnecting or editing its mapping invalidates that work; it cannot silently apply data fetched under the prior configuration. An empty or malformed next-page link is a failed fetch, never proof of a complete roster.

Nightly sync is off until the first administrator-reviewed import completes. Once enabled it runs once per school-local date from 2:00 a.m.; a worker restart catches up later that date, and a skipped DST hour runs at the first later tick. **Sync now** also queues through the worker. `RLS_GUC_ENABLED=true` is required: jobs bind a dedicated scheduler-pool client to the school through tenant ALS. Missing configuration records `ROSTER_WORKER_RLS_REQUIRED` instead of silently reading empty tenant data.

The local clock uses the canonical `schools.school_timezone`, matching ClassPilot classes, dashboard and historical browsing. The legacy timezone field in `settings` does not override this school clock.

Automatic apply is held for incomplete or empty snapshots, unresolved identities, or removals greater than 10% **or** greater than 50 for any entity/membership type. Incomplete and unresolved snapshots cannot be overridden. An administrator may review a complete empty or large-removal snapshot explicitly. Partial paging never yields a removable snapshot. Holds remain visible in import history.

## Data retention and verification

Raw normalized source snapshots and detailed plans expire after 24 hours and are cleared immediately after completion. Connection identity mappings, field provenance, membership provenance, counts and audit metadata remain for idempotent reconciliation. No raw ZIP is retained and no student browser history is imported. Existing school lifecycle retention remains authoritative.

`node --import tsx --test tests/roster-integrations.test.ts tests/oneroster-csv-validation.test.ts` exercises formats, streamed ZIP bounds, required fields, role/profile references, identity and ownership planning, removal holds and Clever paging. `tests/roster-integrations.integration.test.ts` requires the local database fixture and checks transaction checkpoints, repeat imports, preserved PINs, stale previews, tenant isolation and manual enrollment preservation. Run database suites serially in the shared workspace.

Primary specification references: [OneRoster 1.2 CSV binding](https://www.imsglobal.org/spec/oneroster/v1p2/bind/csv/), [OneRoster 1.1 conformance guide](https://developers.imsglobal.org/ims-oneroster-v11-final-conformance-guide), [Clever sections](https://dev.clever.com/docs/sections), [Clever multi-role users](https://dev.clever.com/docs/multi-role-users-in-clever), [Clever Secure Sync design](https://dev.clever.com/docs/ss-design).
