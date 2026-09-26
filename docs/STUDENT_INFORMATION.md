# Student information and reviewed contact imports

This is the implementation and release contract, not proof of production
activation, provider retention, extraction accuracy or verified destruction.

## Shared profiles and private review

Student information is a school-owned contact profile separate from My Desk
private notes, discipline incidents, parent identities and pickup authorization.
Approved fields and version history are shared with current authorized staff.
Only the author can access an unfinished contact import, its sources and previews.

Active school admin/school_admin membership grants school-wide profile access.
Teachers require active students in current official primary/co-teacher
school-managed classes; authorship and an earlier assignment give no exception.
Coverage/monitoring/personal groups do not grant access. Every search, profile,
history, mutation and import commit uses the shared student predicate plus active
membership and ClassPilot entitlement. Platform status and impersonation give no
bypass. Identity/school changes clear caches, editor state and object URLs.

Same-school roster/authority notifications refresh shared-record access, cancel
open requests, remove cached shared profiles and remount editors/previews. Reconnect
also refreshes after potentially missed notifications. Focus, network recovery and
visible-page polling recheck active reads without discarding still-authorized drafts.
Denied profile reads hide fields and history. Private historical notes are not cleared.

Manual saves specify reviewed changes, a reason, base revision and stable request
ID. Explicitly remove contacts/fields; blank or missing import fields preserve
current values. Record contact name, relationship as stated, phone/email values
and explicitly supplied contact preferences without inferring custody, emergency
priority or permissions. Display conflicting or uncertain fields for human review.
Version history retains who changed what and when. It never changes parent login
accounts or authorized pickup/custody records.

## Import pipeline and limits

The independently controlled `STUDENT_INFORMATION_AI_IMPORT_MODE` defaults off and
requires `MYDESK_MODE=on`. It does not require discipline AI. Manual profiles remain
available while this extraction gate is off. The worker's source cleanup is
independent of availability, membership and entitlement.

Accept PDF, JPEG/PNG/WebP, DOCX, XLSX and CSV: at most five files, 10 MiB each,
20 pages/photos, five sheets, 500 rows and 50 columns, 500 proposed students and
1 MiB extracted text. Native PDF/image work uses existing bounded processing.
Office files are parsed as bounded data; macros, scripts, formulas and links are
not executed or fetched. Hidden and unsupported content needs explicit warning
review. Source previews let the teacher choose exactly which sections to send.

One page/photo is one admission unit; each started 4,000-character DOCX text section
or 25 spreadsheet rows is one unit. A job allows 20 units. Daily per-author/school
admission shares the existing 100/500 budget with paperwork imports. Source selection
and provider confirmation precede processing. Only selected images/extracted text
go to Anthropic; current profiles, rosters and unrelated sources remain local.

Tool-free extraction returns strict, validated suggestions. Documents/model outputs
are untrusted data. Match stable student identity within authorized rosters;
ambiguous names, adult associations, digits, emails and relationships require
resolution. Do not create students, follow embedded instructions or autonomously
write shared profiles. Joining continuation proposals requires explicit review.

Each reviewed item fixes student ID, base profile revision and the exact approved
changes. Final batch Save rechecks every student and profile revision under shared
lifecycle locks; all included profiles commit atomically or none do. Retry receipts
avoid duplicates. Changed source/fields invalidate review; rereading never silently
overwrites teacher edits. A lost response returns the saved receipt without replaying
changes against newer contact values.

## Storage, data flow and retention

| Data | Storage/access | Lifecycle |
| --- | --- | --- |
| Reviewed contact profile and immutable earlier versions | `student_contact_profiles`, `student_contact_profile_versions`; current authorized staff | School-owned under agreement and verified destruction process |
| Import lifecycle and teacher review | `student_information_imports`, `student_information_import_items`; author only | Scrub source/extraction/teacher drafts after complete/cancel/expiry |
| Source files, rendered/extracted sections and temporary assets | `student_information_import_assets` plus private encrypted bucket; author-only API bytes | 24-hour unfinished uploads; seven-day review; durable physical deletion |
| Retry/quota/cleanup receipts | Minimal operational rows | Retain only operational data necessary for reconciliation and agreed destruction |

Approved contact values remain in profile history; original contact sources are
not retained as permanent student attachments. Revoked membership or disabled modes
do not stop cleanup. Record keys before storage writes and retain cleanup records
until physical deletion is confirmed. Authentication/no-store protects previews;
no public object keys or bearer download links are exposed. Audit only identifiers,
actions, counts, versions and timing; never contact values, filenames, prompts or
document text/images. Local deletion is not proof of provider deletion. Include
profile history, temporary assets, receipts and backups in verified contractual
destruction; no automatic age-based profile purge is introduced.

## Independent release evidence

Before activation, review the actual provider account/model arrangements specifically
for contact documents and extracted text. Evaluate the fixed model and
`INFORMATION_PROMPT_VERSION` on at least 100 synthetic student profiles across
PDF/photo/DOCX/XLSX/CSV, with ambiguities and conflicting values. Require at least
99% exact phone/email accuracy on legible typed/tabular fields; report difficult
cases separately. Require zero wrong-student/adult associations, unreviewed writes,
silent omissions or execution of document instructions. Measure correction effort.

Use the production image in isolated capacity testing with maximum inputs and
other native/worker activity. Require no OOM/restarts, scheduler disruption,
database timeouts or service errors, peak memory below 70% and API p95 within 20%
of baseline. Stop load at 85% memory, readiness loss or sustained regression.
Behavioral tests must cover source selection, review invalidation, batch conflicts,
lost responses, revocation, identity switches, upload/delete races and cleanup.

The runtime configuration tool requires separate `-StudentInformationReadinessPath`
evidence, exact prompt/model/image and report hashes; discipline evidence cannot
substitute. The reviewed `studentInformation` RLS bundle contains exactly these five
tables and expands the historical 114-table inventory to 119. Deploy compatible
backend/worker and admission before frontend. The production release runbook records
the verified API151/worker166 119-table admission and separate observed Terraform
baseline adoption; historical inventories remain unchanged. No deployment or AI
activation occurs by editing these defaults or documentation.
