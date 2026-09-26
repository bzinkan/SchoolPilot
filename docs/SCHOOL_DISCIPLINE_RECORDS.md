# School discipline records

Implementation contract for deliberately saved school records. This document is
not evidence of deployment, extraction accuracy, completed destruction or retention
approval. Private notebooks retain their separate author-only boundary.

## Publication and access

Create incidents manually with files or through reviewed AI packets. Discipline
imports commit directly to school records; they need no intermediate private note.
Copying an existing private student note remains an explicit school-copy action.
Private categories/saves and AI extraction never publish automatically. No timeline
entry, notification, external report or punishment recommendation is generated.

The final preview shows subject student, incident date, description, optional
class, referral/detention flags, detention dates and selected evidence. Labels are
server-derived snapshots. Evidence contains approved forms/crops, not unrelated
multi-student pages. School copies survive source deletion and staff departure.

Every operation requires current active school membership and ClassPilot entitlement.
Active admin/school_admin roles automatically grant school access. Legacy
school_discipline_access rows are historical data and grant no authority; the old
permission-management interface is retired. Platform status and impersonation give
no bypass and school access never opens private notes, drafts, packets or charts.

Teachers read records only for active students in their current official
school-managed primary/co-teacher class assignments, including records from other
staff. Authorship gives no exception after assignment loss. Ad hoc monitoring,
coverage, personal groups or UI scope do not establish authority. Apply the same
predicate to counts, lists, exports, details, history, duplicates and attachments.
Downloads recheck access after fetching bytes; downloaded files cannot be recalled.

Same-school roster/authority notifications cancel shared-record requests, clear
their caches and close open editors/previews before fresh authorized reads.
Reconnect reconciles missed notifications; focus and visible polling revalidate
without discarding authorized drafts. This does not clear private notebook history.

Administrators may append reasoned corrections/withdrawals. Teachers may do so only
for their own currently authorized records. Published versions stay immutable;
withdrawal and supersession retain labeled restricted history.

## Students, totals and duplicate decisions

The directory includes zero-record students and deduplicates stable student IDs
across authorized current rosters. Grades view uses current roster grade; incident
detail retains historical snapshots. Filters use the configured school year when
available and explicit dates; history/export use matching scope. Former students
remain an administrator context, without expanding teacher access.

Referral and detention flags are independent: one incident may increment both.
A detention assignment counts once regardless of scheduled dates; this is not an
attendance/completion counter. Count active current versions only. Pending drafts,
withdrawn records and superseded versions do not inflate totals. Legacy categories
map deterministically without rewriting immutable snapshots.

Potential duplicate dates/evidence require an explicit reviewer decision. Keep a
separate incident, exclude a form, or add evidence to an incident the reviewer may
correct. Adding evidence does not add another counted incident. Recheck record
revision and access during the final atomic transaction.

## Persistence and durable cleanup

school_discipline_records, school_discipline_versions and
school_discipline_attachments hold current pointers, immutable versions and object
ownership. The legacy access table stays for history compatibility. Additive
migrations preserve old checksums and versions.

Reserve evidence keys before writes. Manual drafts stay hidden until reviewed
Save; unfinished uploads/copies expire after 24 hours. Image normalization, bounded
PDF validation, file limits and authenticated no-store bytes retain existing
protections. Stable request IDs and revision checks prevent duplicate saves.

AI review stays in author-owned import tables with an immutable destination.
Review hashes cover fields and evidence. The final transaction rechecks membership,
student/roster/source revisions and duplicate decisions, then writes all entries
and transfers evidence ownership. Lost-response retries return the original
receipt. Cleanup claims assets under lock and never deletes promoted evidence.
Interrupted writes retain durable cleanup work, independent of modes or membership.

## Data flow and retention

| Data | Access | Retention |
| --- | --- | --- |
| Active incidents and saved student/staff labels | Current authorized teachers and school administrators | School-owned under executed agreement and verified destruction |
| Approved form copies | Same authorized school readers via API bytes | Independent of private source/temporary import lifecycle |
| Earlier versions and reasons | Same currently authorized restricted history | No automatic erasure on correction/withdrawal |
| Unfinished incidents, imports and source packets | Author only | 24-hour upload/copy expiry; seven-day review; durable cleanup after finish/cancel/expiry |
| Retry receipts, legacy grants and cleanup records | Operational storage | Minimal operational evidence included in agreed destruction |

No automatic age-based school-record deletion is added. School/staff deactivation
blocks access without destroying records. Verified destruction fences writers,
confirms object removal and removes related rows in dependency order, including
backups under the agreement. Soft deletion or a running worker does not establish
physical destruction. See WISP section 9.

Search/export JSON bodies keep names/text out of URLs. CSV applies identical scope,
escapes formulas and fails explicitly above its limit. No-store responses and
identity-scoped caches prevent carryover; auth changes discard drafts and blobs.
Audits contain IDs/actions/counts/timing, never names, filenames, record text or
images. Existing private content is never retrospectively shared.

## Release

Deploy compatible additive backend/migrations before frontend. Follow
[MYDESK_PRODUCTION_RELEASE.md](MYDESK_PRODUCTION_RELEASE.md) from the actual verified
serving RLS baseline. The redesign reaches 119 tables after separate contact-table
admission; historical inventories remain immutable. Discipline AI stays default-off
until its independent provider, extraction and isolated capacity gates pass.
Restricted-RLS tests and synthetic behavior checks are required; real-device and
live cleanup verification remain rollout acceptance work.
