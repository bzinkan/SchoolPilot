# My Desk private notebook

Implementation and rollout contract for the ClassPilot web pilot. This document
describes the proposed release; it is not evidence of production deployment,
storage provisioning, retention operation, or a privacy/legal approval.
The later seating-chart gate, schema, privacy, and separate admission sequence are
documented in [MYDESK_PRIVATE_SEATING.md](MYDESK_PRIVATE_SEATING.md).
The narrow teacher-started AI paperwork-import exception is documented in
[MYDESK_AI_IMPORT.md](MYDESK_AI_IMPORT.md); it has a separate default-off gate.

## Scope and ownership

Teachers and school administrators keep their own general, class, and student
notes, including photo-only entries. Every API/content request must resolve the
active school and current membership, enforce the pilot gate and ClassPilot
entitlement, and require `author_id` to match the authenticated account. An
administrator role never grants access to another author's notebook. Tenant RLS
is a school-isolation backstop, not the author-authorization implementation.

My Desk does not write student timeline events, shared discipline records,
student evidence packets, parent communications, or administrator reports.
Ordinary notebook entries and seating charts are not AI inputs. Only source
pages deliberately uploaded through the separately enabled AI paperwork-import
workflow are sent for extraction; rosters and existing notes are excluded.
It runs in ClassPilot web, including supported phone browsers; there is
no native PassPilot route or extension change. Existing camera Permissions-Policy
is unchanged; the browser's file/camera picker supplies images.

Class/student filing IDs and names are historical snapshots. Live composite
foreign keys detach only `group_id` or `student_id` on parent deletion while
preserving the school ID. Past classes remain available to the author with a
current authorized school membership; historical access does not grant current
roster access. Drizzle cannot express PostgreSQL's column-list `SET NULL`, so use
the ledger migration, not `db:push`, to install or reconcile these two FKs.

## Persistence and save lifecycle

`mydesk_notes` stores pending/active/deleted entries and their school/author-scoped
request UUID and fingerprint. `mydesk_attachments` stores pending/uploading/ready/
delete_pending/deleted objects, reservation fingerprints, upload leases and
cleanup retries. Its composite note FK also binds the school and author. Do not
cascade-delete attachment rows or their cleanup keys.

The UI exposes Save, while the API reserves a hidden pending entry, uploads each
reserved photo, then completes the save transaction. Repeated request IDs return
the same operation; changed request content is a conflict. The completion
transaction requires nonempty text or a ready photo. `committed_at` separates a
successfully uploaded photo from one included in a saved entry, including when
editing an existing entry. Pending/staged photos never enter saved reads.

Parent-row locking serializes reservation counts, completion, edits and deletion.
Notebook database operations use short school-scoped connection leases that last
until the operation finishes, independently of the HTTP response. Image processing
and S3 transfers hold no tenant connection; finalization and failure cleanup acquire
a fresh scope, including after a browser disconnects. Super-administrator notebook
operations use the same school scope without a database bypass.
Every S3 key is durably reserved before a PUT. Upload leases and bounded SDK
timeouts prevent indefinite ownership; stale completions may not revive deleted
entries. Abandoned pending entries and uncommitted photo reservations expire
after 24 hours, including photos whose upload finished but whose save did not.
Before deleting the last committed photo, require remaining text/another photo,
or delete the entire note in the same transaction.

The dedicated worker uses `schedulerPool` and the scheduler advisory-lock wrapper
for cleanup. Claim work in short transactions, delete S3 objects outside database
locks, and record success/retry without content or filenames. Storage outages
must leave a durable retry record. Deleted attachment tombstones retain their
storage key and a daily cleanup deadline; the worker repeats DELETE indefinitely
until a separately verified permanent-erasure process retires the tombstone.
A late upload completion also requeues its exact attachment through an internal
ownership-scoped cleanup transaction, even after membership or pilot access is
revoked. The daily backstop covers a process dying before that repair. An initial
successful DELETE is not proof that no in-flight writer remains.

## Data flow and retention

| Data | Destination and access | Lifecycle |
| --- | --- | --- |
| Note text, labels, historical class/student names | PostgreSQL; author-facing API only | Retained until author deletion or verified school-account destruction |
| Original photo bytes | Transient API processing memory | Decode, orient, resize and re-encode; never persist originals |
| Normalized photos | Private SSE-S3 bucket under `mydesk/` | Authenticated byte-serving; durable cleanup on deletion/abandonment |
| Uploaded PDFs | Same private bucket; validated as readable, unencrypted PDFs | Original bytes and embedded document metadata/signatures are retained until deletion; no metadata-stripping or malware-free guarantee |
| Pending reservations and failed cleanup | PostgreSQL worker queue | 24-hour abandonment cutoff; bounded retry with retained keys |
| Operation audit records | Existing audit storage | IDs/actions/counts only; existing audit policy applies |

The server strips photo metadata and rejects normalization failures. The browser
sends the selected file; server normalization is the metadata-removal boundary.
Exact supported photo formats and phone picker behavior require fixture/device tests;
do not silently retain an unsupported original. Ordinary note photos are not
submitted to AI. The separate teacher-started paperwork workflow processes only
its selected source pages under MYDESK_AI_IMPORT.md. No photos go to public
malware-analysis services, analytics, or application logs.
PDF parsing runs in an isolated worker thread with a 15-second deadline, a
128-MiB old-generation heap limit, and discarded parser stdout/stderr. Validation
does not rewrite the accepted PDF bytes or remove embedded document metadata.

Content GETs authorize the exact attachment/note/school/author relationship and
return bytes with `Cache-Control: private, no-store` and `X-Content-Type-Options:
nosniff`. Do not return presigned URLs, S3 keys, or public redirects. The browser
uses authenticated blob requests with the active school header and revokes local
object URLs on removal, navigation, logout, and school changes. Already delivered
bytes cannot be recalled; "author-only" describes server access, not an inability
to copy a photo already viewed.
Search and filtered export send authored search text in JSON POST bodies
(`/notes/search` and `/export`), keeping it out of normal notebook request URLs
and ALB access logs. GET requests with a nonempty `q` are rejected; clients must
not put private search text in query strings. Audit/error records omit search
text, note content, filenames, and storage keys.
The app also intercepts upstream My Desk parser/session failures before the general
error monitor; malformed JSON can otherwise embed private text in a parser error.
Those failures receive fixed responses and operational codes without raw error data.

This is separate from screen-preview/timeline retention. Disabling the pilot or
revoking membership blocks notebook access but does not silently destroy records.
Permanent destruction on contract termination follows the executed agreement and
verified operator process in WISP section 9. Include notebook DB records, retained
cleanup keys, and S3 objects in that process; verify worker/backups separately.
Do not represent soft deletion or a deployed worker as completed destruction.
The existing school-delete and staff-removal actions only disable access. For
permanent erasure, first queue the scoped notebook records, drain/fence outstanding
writers and verify object removal, then retire attachment and note tombstones
before deleting their user or school parents. The restrictive foreign keys make
that ordering explicit. Backup destruction follows the agreed retention process.

## Infrastructure and configuration

`infra/mydesk.tf` defines `schoolpilot-<environment>-mydesk-attachments` with four
public-access blocks, BucketOwnerEnforced ownership, AES256 default encryption,
TLS-only bucket policy, and seven-day incomplete-multipart cleanup. Live objects
have no blanket S3 expiration. The task-role policy grants only Get/Put/Delete
under `mydesk/*` and prefix-limited ListBucket for reconciliation. API and worker
currently share this task role; no account-wide S3 or ACL permission is granted.

- `MYDESK_ENABLED_SCHOOL_IDS`: explicit comma-separated pilot school UUIDs;
  empty means disabled, never all schools.
- `MYDESK_ATTACHMENTS_BUCKET`: configured for both API and worker, including
  while the pilot gate is off, so deletion retries continue.
Tests inject an in-memory object-store implementation; there is no runtime switch
that permits production to silently fall back to volatile storage.

Terraform's ECS definitions are bootstrap templates, not the live serving API and
worker definitions. New My Desk bucket configuration changes both templates;
copying these templates onto the services would discard unrelated runtime values.
Never do that to activate the pilot.

## Reviewed rollout

1. Merge only after backend/frontend checks and the focused schema, API,
   attachment, cleanup and UI tests pass. Run `npm run soc2:check` for these docs.
   Offline infrastructure checks: `terraform -chdir=infra init -backend=false
   -lockfile=readonly -input=false`, `terraform -chdir=infra validate -no-tests`,
   and the mocked `tests/mydesk.tftest.hcl` test. Windows filter paths use `\`.
2. Before any real plan/apply, follow CLAUDE.md and AWS_COST_ROLLOUT_OPERATIONS.md:
   unique external saved plan, verified DPAPI and OneDrive AES-GCM state backups
   before plan/before apply/after apply, and explicit operator go/no-go. Expected
   additions are exactly the six named `aws_s3_* .mydesk_attachments` resources
   and `module.ecs.aws_iam_role_policy.mydesk_attachments[0]`. Bootstrap API/worker
   template replacements caused only by the reviewed My Desk environment entries
   require review. Service changes, unrelated replacements, destruction, secret
   value changes, and RLS-baseline changes are outside this rollout. Abort on any
   unexplained drift; never approve a plan solely from resource counts.
3. Verify private bucket controls and the shared task-role policy. Keep the pilot
   allowlist empty. Preserve live task-definition fields and configure the same
   bucket on API and worker through the separately reviewed runtime update.
4. Deploy backend with the exact one-release bundle:

   Use an M1-only reviewed backend artifact for this first admission. The later
   combined seating/import manifest also installs and enforces their RLS; do not use
   that artifact as though those migrations were deferred by feature
   flag. Follow the explicit predecessor-release sequence in the seating runbook.

   ```bash
   ./scripts/deploy.sh production --backend --activate-emergency --enable-rls-table mydesk_attachments,mydesk_notes
   ```

   Require matching live API/worker admission sources and successful migration
   `mydesk-private-notebook-20260925`. Verify both tables have enabled/forced RLS
   and `tenant_isolation`, and the registered/live definitions retain the new
   allowlist. Omit the flag on later deploys; a deliberate removal requires
   re-admission. Keep generic/production Terraform allowlist values unchanged
   until actual rollout verification; then land a separate production-baseline
   adoption PR before any later Terraform apply.
5. Deploy frontend after backend is healthy. Admit only the reviewed pilot school
   through live task definitions, then verify author-only reads with two teachers
   and an administrator, a photo-only save and retry, phone capture, Past classes,
   and deletion followed by worker-confirmed object removal. Retain non-content
   operator evidence privately; do not place notes, names, filenames, keys, or
   photo bytes in release evidence committed to this repository.

Rollback first disables new My Desk access via the pilot gate while retaining
bucket/IAM configuration and a cleanup-capable worker. A frontend rollback may
hide the entry point; it does not stop cleanup. Capture exact live API/worker
digests/families before release and follow all existing feature data-compatibility
gates before selecting older images. Prefer a feature-aware repaired image once
notebook data exists; additive schema alone does not prove downgrade safety.
Never remove admitted RLS entries, drop tables/buckets, or lose queued deletions
as a rollback step.

No AWS apply, runtime activation, production migration, or deployment is authorized
merely by committing this runbook or Terraform configuration.
