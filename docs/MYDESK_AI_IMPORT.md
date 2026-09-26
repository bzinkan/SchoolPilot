# My Desk AI paperwork import

Implementation and rollout contract for teacher-started paperwork imports in
ClassPilot web. This document does not authorize deployment or establish that
provider/account settings, cleanup, or privacy controls are operating in
production. The underlying private notebook contract is
[MYDESK_PRIVATE_NOTEBOOK.md](MYDESK_PRIVATE_NOTEBOOK.md).

## Authorized scope

An author deliberately uploads selected paperwork for AI-assisted transcription
and organization. This is a narrow exception to My Desk's ordinary exclusion of
notebook content from AI. Existing notebook entries, seating charts, school
rosters, and unrelated files are not submitted. Imports require both the base
My Desk gate and the separate import gate, ClassPilot entitlement, and a real
active teacher or school-administrator membership. An administrator owns a
separate notebook; support impersonation and cross-author access remain denied.

The output is a set of editable private-note drafts. It does not create formal
discipline records, student timeline events, shared evidence packets, parent
communications, or administrator reports. Teacher approval saves ordinary
author-owned My Desk notes. No model may approve or publish a draft.

## Import, extraction, and review

An import accepts at most five PDF/JPEG/PNG/WebP source files, 10 MiB each, with
at most 20 rendered pages and 50 forms. PDF page-count and encryption validation
uses Poppler `pdfinfo` before `pdftoppm` renders pages; images are decoded and
normalized. Both PDF operations run as bounded subprocesses in the application
image. Do not assume the ordinary notebook's 1,000-page PDF storage
limit is an AI processing budget. Rendered previews and approved crops remain
private objects served through authenticated, no-store endpoints, without
presigned URLs or public redirects.
The initial request fixes the exact source-file count, from one to five. Upload
completion occurs only when that many reserved sources are ready; subsequent
reservations cannot extend the packet or reset its retention deadline.

Authors select authorized current classes. The extraction model sees selected
document page images and fixed extraction instructions, not the school roster.
It returns names and source regions as suggestions. The server matches normalized
names against the selected authorized rosters; duplicate, incomplete, or unknown
names require explicit teacher resolution. Students/class membership are checked
again when saving. Model confidence never establishes a student identity.

The review workspace supports multiple forms per page, manual splitting/cropping,
joining continuation regions, and rotation. Each source page must be accounted
for. Each included form requires explicit review of its student, class, category,
date, title, brief summary, and approved image. Every other form must be explicitly
excluded. A page with multiple students must not silently become the attachment
for each student's note. Preserve source-region provenance separately from the
teacher-edited draft while the import remains under review; display both so the
teacher can compare them. Extracted/generated text is not an original source.

Batch approval saves all included reviewed notes and approved attachments in one
database transaction. A stale review or unauthorized target rejects the batch;
the teacher resolves it before retrying. Request fingerprints, revision checks,
and an operational commit receipt prevent a lost response from creating another
batch. Approved objects transfer to the normal notebook lifecycle; promotion
markers prevent the temporary-source cleanup from deleting those attachments.

## Model boundary and processing controls

On production Linux, PDF validation and rendering use fixed executable paths,
no shell, a stripped environment, bounded output, deadlines, and `prlimit`
address-space/CPU limits. Missing `pdfinfo`, `pdftoppm`, or `prlimit` fails closed;
there is no unbounded parser fallback. Parser stdout can include document metadata
and must never enter logs or returned errors. Temporary files are removed after
each operation. The backend unit, ordinary DB, and restricted RLS CI jobs install
Poppler and verify both executables through `prlimit`; required PDF page-count
validation tests must not be skipped when a binary is missing. Windows development
uses the Poppler executables but does not establish the Linux memory-limit behavior.

The Anthropic SDK is used directly in a separate extraction service. It has no
assistant tools, browsing, external-link fetching, automatic mutations, provider
Files API, or explicit prompt caching. Uploaded text/images and model output are
untrusted data, including instructions printed inside a document. Fixed prompts
do not replace strict output validation: bound fields and arrays, reject invalid
page/region references, allow uncertainty, and require human review. Test hostile
instructions, malformed responses, multiple students, ambiguous names, incomplete
continuations, and incorrect dates against synthetic fixtures.

Processing is asynchronous and durable, with at most two imports processing
globally, three attempts per stage, and a 90-second AI call deadline. Daily page
budgets default to 100 per author per school and 500 per school. Quota counters
debit initial packet pages and distinct source pages for explicit rereads or
new manual-form AI reads; automatic retries do not debit again. A bounded
school-local-date ledger covers the seven-day review window and survives
source/draft cleanup. Model and prompt version identifiers are frozen when initial
processing starts, reused for retries, and retained as operational provenance.
External processing holds no tenant DB connection;
claim/finalization use short scoped transactions and lease checks. Workers recheck
current author authority before processing and must not revive terminal imports.
Revocation, cancellation, expiry, or disabling the gate stops new extraction;
cleanup continues independently of those access gates.

## Data flow, privacy, and retention

| Data | Destination/access | Lifecycle |
| --- | --- | --- |
| Uploaded source packet and rendered pages | Existing private My Desk S3 prefix; exact school/author access | Delete through durable cleanup after completion, cancellation, or expiry |
| Selected page images and fixed extraction prompt | Configured Anthropic API account | Provider/account terms apply; verify before enablement |
| Extracted names, regions, drafts, review selections | Author-scoped PostgreSQL import tables | Scrub after completion, cancellation, or expiry |
| Approved crops and saved notes | Normal My Desk notes/attachments | Normal author deletion and agreed destruction process |
| Retry/commit receipts, daily quota counts, model/prompt versions, promotion/deletion markers | Operational PostgreSQL records | Retain minimum IDs, hashes, counts, states, versions, and timestamps needed for retries/cleanup/provenance |

Uploads expire after 24 hours if not completed. Review expires seven days after
upload completion. Completion/cancellation/expiry queues temporary objects for
deletion and scrubs private draft/source metadata. Deletion is durable and retried;
flag rollback does not stop it. Existing backup and verified account-destruction
requirements apply; account deactivation is not complete erasure.

Deleting SchoolPilot's local source copies does not delete a provider's retained
inputs or outputs. No zero-data-retention claim is made. Before activation, review
the actual account/contract for training use, retention, abuse monitoring, access,
and deletion requirements, and record the authorized human decision in the private
SOC2-002/vendor evidence. Do not infer those settings from an SDK flag or from the
fact that no Files API is used.

Logs, telemetry, audit events, and committed release evidence must omit filenames,
student names, document/region bytes, prompts, model responses, and note text. Use
IDs, counts, fixed error codes, timings, and model/prompt versions. Upstream parser
errors remain covered by the My Desk private-error boundary. CI/provider tests use
synthetic injected responses; implementation verification makes no live provider
call and uploads no real student records.
Schema/privacy/recovery tests do not establish OCR or extraction accuracy. Before
enabling a pilot, review the configured provider/account and have a human evaluate
synthetic packet outputs, student matching, source-region accuracy, and teacher
correction effort. Record that quality review separately from unit-test results.
The offline fixture runner generates only synthetic source images and expected
results, without a provider call:

```bash
node --import tsx scripts/evaluate-mydesk-import.mjs --output <external-directory>
```

Use a unique output directory outside the repository. The fixed fixture set has
34 pages, 64 form regions and 62 logical forms, including two continuations,
rotations, blank pages, ambiguous names/dates and malicious document instructions.
Handwriting-style fonts are only a difficult-case proxy; evaluate actual synthetic
handwritten camera samples separately. Source hashes and model/prompt versions
are frozen in the manifest.

After the configured account and provider review, use `--resume --run-provider`
with that same output directory for live evaluation. It sends synthetic fixtures,
never real student packets. Completed calls are checkpointed and not repeated;
an uncertain interrupted call requires explicit `--retry-uncertain`. A live run
holds an exclusive directory lock. Remove a stale lock only after establishing
that no evaluator is still running. Its private report records typed-form
detection precision/recall and key-field accuracy separately from difficult cases,
plus model output text. A human must review every crop and summary for critical
errors, then record correction time compared with manual entry.
Do not call an offline fixture-generation pass a successful model evaluation, and
do not commit generated reports or private approval evidence.

## Configuration and reviewed rollout

- `MYDESK_MODE` and `MYDESK_AI_IMPORT_MODE` must both be `on`. Each defaults off;
  once enabled the feature applies to all eligible current and future schools.
  Retired school allowlists are rejected. Seating remains independent.
- `MYDESK_AI_IMPORT_MODEL` defaults to `claude-sonnet-5`; changing it requires
  extraction evaluation and recorded model-version review.
- `MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES` and `MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES`
  default to 100 and 500. The five-file, 10 MiB/file, 20-page, 50-form bounds remain.
- Both API and worker retain `MYDESK_ATTACHMENTS_BUCKET` and scoped IAM, and use
  the existing `ANTHROPIC_API_KEY` secret reference. Cleanup runs with modes off.

Follow [MYDESK_PRODUCTION_RELEASE.md](MYDESK_PRODUCTION_RELEASE.md) for the six-table forward admission,
production readiness evidence, private runtime configuration and staged activation.
The combined manifest is already the release starting point; do not remove later
migrations or construct a notebook-only predecessor. Preserve all three original
checksums and adopt the observed RLS baseline only after live verification.

API and worker sizing must be measured from live definitions. One shared native
processing permit per process bounds both Poppler and all My Desk Sharp transforms;
two durable import jobs can overlap I/O. Validate task-level headroom and ordinary
scheduler/API behavior using isolated production tasks before loading the serving
worker. Per-child memory limits do not establish total-task safety.

The provider/account retention review and actual extraction/capacity results are
required before AI activation. After activation, teachers perform Android and
real-paperwork testing in production and approve every resulting note. Rollback
turns off the import mode while preserving committed notes, promoted attachments,
RLS and durable cleanup. No source-content evidence belongs in tracked files.
