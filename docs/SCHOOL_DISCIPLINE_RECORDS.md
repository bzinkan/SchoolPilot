# School discipline records

Implementation contract for deliberately submitted school records. This document
does not establish production deployment, effective permissions, completed
destruction, or approval of a retention period. Private My Desk notes, drafts and
attachments remain governed by [MYDESK_PRIVATE_NOTEBOOK.md](MYDESK_PRIVATE_NOTEBOOK.md).

## A separate, explicit publication

A teacher chooses **Submit to school log** on a saved student
note, reviews its student, filing class, date, category and text, and selects the
ready attachments to include. General/class notes and unfinished uploads cannot
be submitted. A category such as detention or referral never makes a note shared.
AI imports save private notes first; a later teacher action is required for any
school submission. There is no automatic publication, timeline event, parent or
administrator notification, official external-report submission, or disciplinary
recommendation.

The submission creates a school-owned snapshot and separate copies of the chosen
evidence. Other private notes and unselected files are not exposed. Subsequent
source-note editing, deletion, class archival, or staff departure does not erase
or rewrite the school record. Historical notes use their stored student/class
IDs and labels; publishing them does not fetch a restricted current roster.
Teachers must review old labels before publication and correct a mistaken target
through the explicit correction flow.

## Access and staff permissions

Every operation requires the active school, current ClassPilot entitlement, and
a real active teacher/admin/school_admin membership. Impersonation is denied.
Super-administrator status gives no bypass. Teachers can read/export their own
submissions and their histories. Another teacher's private source-note identifier
is never returned to a school viewer.

School-wide viewing/export requires both an active admin/school_admin membership
and an explicit `school_discipline_access` grant. No grants exist by default.
An active school administrator manages these grants in Staff management through
the narrow discipline-access endpoint, including granting their own access. Every
grant, revocation and self-grant is audited. This permission does not enable My
Desk or confer access to another author's notebook, imports or seating charts.

Revoking the grant takes effect on subsequent requests. Downloads recheck after
reading the private object and before delivering bytes. Losing the last active
admin/school_admin membership permanently revokes its enabled grant through a
database trigger, including membership deletion, imports and other staff writers.
Reactivation or promotion requires a fresh explicit grant. A second qualifying
active membership preserves access until the last one ends. An already downloaded
file/export cannot be recalled by the server.

Designated viewers have read/export access only: no follow-up comments, edits,
status decisions or corrections on another author's records. Staff-management
authority is independently checked; the new endpoint does not widen unrelated
staff-editing permissions.

## Corrections, withdrawal and history

Only the submitting author can append a correction or withdraw a record, while
they retain qualifying school access. Each action requires the current revision,
a stable request ID, and an explanation. Published versions are immutable at the
database layer. Corrections supersede earlier versions; withdrawal adds a visible
withdrawn version and reason. Earlier text and evidence remain in version history.
A deliberate later correction may resubmit a withdrawn record.

An unchanged historical student/class target preserves its stored labels without
requiring current roster access. Selecting a different target requires current
class/student authorization, checked again when publishing. Existing evidence
may be selected from this record's history; replacement private evidence must
come from the author's saved note for the chosen student and class. Administrators
cannot perform these author actions. If the author has departed, authorized
school staff can export the record; an exceptional correction or destruction
request follows the verified school-support process rather than impersonation.

## Atomic publication and cleanup

`school_discipline_records` identifies the school-owned submission and current
revision; `school_discipline_versions` stores immutable published snapshots;
`school_discipline_attachments` owns independently reserved evidence copies;
`school_discipline_access` stores scoped grants and bounded retry receipts.
Composite school/parent FKs prevent cross-school version/evidence relationships.
All four tables enforce tenant RLS. Ownership/grant checks are separate from RLS.

Reserve every destination key before writing to the existing encrypted private
bucket under `mydesk/<school>/school-discipline/`. Copy and verify byte hashes
outside database transactions. Final publication locks the record/version/files,
rechecks source revision and evidence hashes, membership, entitlement and any
changed target, then commits the version, attachment ownership and audit together.
Partially copied submissions remain hidden. Stable request fingerprints and
receipts return the original result after a lost response, even if the private
source was later deleted. Changed requests or stale revisions return a conflict.
Bulk UI actions report individual submission outcomes; they are not one atomic
batch across several school records.

Two evidence-copy operations may run concurrently per API process. Durable leases
and bounded object I/O protect in-flight writes. After 24 hours, abandoned
preparations are scrubbed and their reserved objects enter durable cleanup.
Cleanup locks and rechecks publication before claiming deletion; committed
evidence is never an abandoned-copy candidate. Failed deletions retry, and
operational tombstones retain daily deletion retries for interrupted late writes.
Cleanup runs regardless of My Desk modes, grants, membership or entitlement.

## Data flow, export and retention

| Data | Destination/access | Lifecycle |
| --- | --- | --- |
| Submitted note fields, student/class labels and submitting staff label | School-scoped PostgreSQL; author and designated viewers | Retained as school records under the executed agreement and verified destruction process |
| Selected evidence copies | Existing encrypted private bucket; authorized API bytes only | Same school-record retention, independent of the source attachment |
| Corrections/withdrawal reasons and earlier versions | Immutable PostgreSQL history; same readers | Withdrawal marks the record; it does not erase history |
| Preparing copies and private source references | Short-lived reservation metadata | Abandoned after 24 hours; durable cleanup removes objects and scrubs content |
| Grants, retry receipts, deletion markers and audits | Operational storage | IDs/actions/counts/revisions only in audits; existing audit and agreed destruction policies apply |

Search/filter/export requests use JSON bodies to avoid names and text in URLs.
CSV exports honor the chosen own/school scope, status, student, submitting teacher,
category, dates and text filters; spreadsheet formula escaping applies. The 5,000
record limit fails explicitly rather than silently truncating. Evidence links
require current sign-in, school access and record permission. Version history is
paginated in pages of at most 100; school records use cursor pagination.

All responses and evidence bytes use no-store. Browser queries, drafts and blob
URLs are scoped to school and viewer, cleared on identity/school/impersonation
transitions. Audit/errors omit student/staff names, filenames, text, evidence,
search terms, and correction/withdrawal reasons. This is not the Safety Center's
automatic evidence-retention policy or the heartbeat-history setting.

There is no invented automatic disciplinary-record expiry. Staff removal and
school deactivation block access without destroying school-owned records. On
verified contractual destruction, fence active writers, delete independently
owned evidence and verify object removal, then remove attachment/version/record
and grant rows in dependency order before user/school parents. Include backups
and cleanup tombstones in the agreed process. Soft deletion and a running worker
do not prove completed destruction. See WISP section 9.

## Release and validation

Use the additive workspace/measured-seating/discipline migrations and the exact
five-table admission in [MYDESK_PRODUCTION_RELEASE.md](MYDESK_PRODUCTION_RELEASE.md).
Existing notebook/seating/import migration checksums and observed production
inventories remain untouched. Keep AI imports off until their separate review.
The deployed permission state starts with no school-wide viewers; a school
administrator deliberately grants access after release.

Behavioral tests cover real restricted-role RLS, author/admin/super-admin/tenant
boundaries, impersonation, historical labels, source revision races, grant changes
during byte retrieval, independent evidence retention, retry receipts, concurrent
corrections, partial-copy recovery, cleanup failures and promotion races. Before
release verify these flows and account switching with synthetic identities and
confirm cleanup against actual storage. No test result alone establishes an
operating production privacy or destruction control.
