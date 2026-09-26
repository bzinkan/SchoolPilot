# My Desk private notebook

Implementation and rollout contract for the included ClassPilot teacher workspace. This document
describes the proposed release; it is not evidence of production deployment,
storage provisioning, retention operation, or a privacy/legal approval.
The seating-chart mode, schema, and privacy contract are
documented in [MYDESK_PRIVATE_SEATING.md](MYDESK_PRIVATE_SEATING.md).
The narrow teacher-started AI paperwork-import exception is documented in
[MYDESK_AI_IMPORT.md](MYDESK_AI_IMPORT.md); it has a separate default-off gate.

## Scope and ownership

Teachers and school administrators keep their own general, class, and student
notes, including photo-only entries. Every API/content request must resolve the
active school and current membership, enforce the operational mode and ClassPilot
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
ownership-scoped cleanup transaction, even after membership or feature access is
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

Ordinary PDF inputs use the same bounded native inspection helper as imports.
Linux prlimit bounds address space/CPU/output, and the helper bounds wall time,
subprocess output and waiting work. One native operation may run at once, with at
most four waiting requests; My Desk image transforms share this permit with PDF
work. Accepted ordinary PDF bytes remain unchanged;
encrypted, unreadable, corrupt and excessive files are rejected. Ordinary
attachments allow up to 1,000 pages; AI imports allow 20 pages total.


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

This is separate from screen-preview/timeline retention. Disabling My Desk or
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

- `MYDESK_MODE`: exact `off`/`on`, default `off`; once on, all eligible current
  and future ClassPilot schools receive My Desk automatically. Retired school
  allowlists are rejected. No school-admin setting or individual opt-in exists.
- `MYDESK_ATTACHMENTS_BUCKET`: configured for both API and worker, including
  while the operational mode is off, so deletion retries continue.
Tests inject an in-memory object-store implementation; there is no runtime switch
that permits production to silently fall back to volatile storage.

Terraform's ECS definitions are bootstrap templates, not the live serving API and
worker definitions. New My Desk bucket configuration changes both templates;
copying these templates onto the services would discard unrelated runtime values.
Never do that to activate My Desk.

## Reviewed rollout

Follow [MYDESK_PRODUCTION_RELEASE.md](MYDESK_PRODUCTION_RELEASE.md) for combined six-table admission,
private storage, production verification, automatic access and rollback. The
storage apply retains the existing requirement for explicit operator go/no-go on
the exact saved plan, with verified DPAPI and AES-GCM state backups. The
combined PR #510 manifest is the starting point; do not package an older
notebook-only predecessor or alter checksummed migrations. Teacher desktop and
physical Android acceptance takes place in live production after activation.
Retain the private bucket, IAM, RLS and cleanup worker when modes are disabled.
