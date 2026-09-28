# Paperwork progress and processing protocol 2

## User workflow

Notes and Discipline logs each have a permanent **Resume paperwork** action. Its
owner-scoped counts include every unexpired unfinished packet for that destination,
independently of the currently selected grade, class, student, and date filters.
Administrator entry preserves the Admin Panel return path; it never exposes another
author's packet. Existing packet URLs and completion receipts remain valid.

Progress reports durable pages prepared/checked and forms found/ready/reviewed.
The number of forms is provisional until all pages have been checked. A ready form
has both extracted fields and independent evidence. Teachers can correct fields and
confirm ready forms while preparation continues. Crop/rotation/join/reread, class
scope, and page-accounting changes wait until preparation settles. Final publication
still requires the complete, reviewed, page-accounted batch in one transaction.

Progress polling does not replace an unsaved form. A changed selected-item revision
requires comparison/reload; other forms and progress can refresh independently.
Save for later leaves only after its saved draft is acknowledged. Errors retain the
editor and retry request identifier. No additional notifications are sent.

## Processing contract

`import_processing_stages` records owner-scoped source/page/form stages, generations,
attempts, deadlines and leases. It contains operational identifiers only. A short
database admission transaction limits provider requests to two globally, including
the shared contact processor. Leased legacy jobs reserve capacity during a mixed
rollout. No database connection remains checked out for provider or native work.

The dispatcher polls every five seconds when idle and refills on completion. Two
import jobs remain the deployment-wide maximum; a single v2 job can use both provider
slots. Native processing retains one permit per process and its bounded queue.
Prepared crops are reused for evidence. Generation/revision fences reject cancelled,
expired, superseded, or unauthorized results. Stage retries preserve completed work
and the existing three-attempt/90-second provider limits. Cancellation does not
prematurely free a still-running provider request's permit.

Model/prompt versions and quotas remain frozen per packet. Review/upload expiry and
cleanup do not change. The contact AI switch remains independent and is not enabled
by this release. The shared stage budget also applies when contacts are enabled later.

## Deployment and rollback

The compatible backend release `cbb0166790ace8846a187121fb620330ea0ff08c`, image
`sha256:78f5bdab6be709be40f54c67535098c3d8515eb7b0131e953d440e46af761e48`,
was verified on API emergency 157 and worker 172 at
`2026-09-28T18:27:19.9525541Z`. Both services have the same exact 121-table runtime
CSV, SHA-256 `0e24d7a703856e5038fc13d43c1b8eccaf0632d293aa314635ac4a5164490946`.
Private `runtime-postflight.json` and
`552b4731ea284147b95812df779536f4-production-preflight.json` receipts confirm strict
service stability, three healthy API targets, all 121 enabled/forced canonical
tenant policies, a non-bypass application role, and completed migration
`20260928_import_processing_stages` with checksum
`16a1499823c645fa5ab175f56adae9da066ecfebd85e6f24230252f1524d4d8b`.
No queued/processing imports or held stage permits were present at verification.

This separate Terraform baseline adoption preserves the observed CSV order and
performs no Terraform apply. Historical inventories, migration checksums, and the
generic 75-table default remain unchanged. Paperwork AI remains on, Student
information AI remains off, and the absent pipeline-version override continues
to use compatible serial protocol 1. These receipts do not establish protocol 2
activation, performance/capacity acceptance, or authenticated teacher acceptance.

1. Verify the serving image, API/worker resources, RLS allowlists, migration ledger,
   and active legacy-claim count using identifiers/counts only. Preserve the observed
   configuration and store the release evidence outside the checkout.
2. Run CI against the final commit. The initial compatible backend deployment used
   the reviewed singleton admission `--enable-rls-table import_processing_stages`;
   omit this already-admitted flag on subsequent deployments. The additive
   migration installs and verifies forced tenant RLS; existing checksums and historical
   inventories remain untouched. The former verified 120-table baseline plus this
   table is represented by the new forward registry inventory, not by changing history.
3. Keep `MYDESK_IMPORT_PIPELINE_VERSION=1` during the compatible deployment and verify
   the old worker revision has drained. Never replace an active packet or clear its
   attempt count to make the migration pass.
4. Validate synthetic paired performance and maximum-load capacity with the candidate
   production image. Record first-ready time, complete time, memory, API latency, and
   quality results. A scripted provider is not evidence of actual Opus latency.
5. Deploy the matching frontend and verify Resume paperwork, persisted progress,
   and administrator return navigation while the compatible serial processor runs.
6. Use `deploy-mydesk-runtime-config.ps1` Plan/Apply with explicit `pipelineVersion:2`
   and `pipelineWidth:2`. Both services receive matching values; all images, sizes,
   secrets, unrelated flags, bucket permissions, and existing RLS settings are preserved.
   The workflow refuses v2 activation without the new table in both live allowlists.
7. The worker adopts eligible legacy checkpoints only after the previous lease ends.
   IDs, source assets, completed work, reviewed text, expiry, quota charges, model and
   prompt versions survive. Verify early fields and explicit final Save.

Rollback uses the same compatible code and `pipelineVersion:2,pipelineWidth:1` to
serialize each packet. Disabling the existing import mode stops extraction but leaves
cleanup operational. Never roll back to a worker that cannot interpret the stage ledger.
Do not silently downgrade an existing pipeline setting with an old configuration file.
Adopt a newly verified RLS allowlist into Terraform only as a separately reviewed
baseline change; no Terraform apply is part of activation.

Operational evidence excludes names, filenames, extracted text, source images, prompts,
and generated summaries. This change does not replace teacher review of real records.
