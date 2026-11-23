# MailPilot safety delivery

Authenticated Gmail pushes are acknowledged after their history range finishes processing. Failed fetches, unavailable classifications, alert persistence failures and cursor failures return HTTP 503 for Pub/Sub retry. Logs and watch errors use bounded operational codes without provider bodies or message content. Malformed payloads and inactive or disabled mailboxes are acknowledged without processing.

Each flagged Gmail message commits its raw email alert, shared safety alert, case audit events and administrator notification outbox in one transaction. Identity is scoped by school, student and Gmail message ID. A stable SHA256 source key makes a retained shared observation recognizable after its raw email is deleted. Retries search all cases, including closed and reviewed cases, and do not reopen cases, increment observation counts, recreate retained-away email content or generate another notification. Retained legacy partial alerts are repaired from their original classification; legacy reviewed mail is not reopened.

A batch may commit successful messages before another message fails, but its history cursor remains unchanged until every message succeeds. Subsequent retries skip those durable safety observations. Cursor completion checks the current watch identity and expected history cursor; stale completions cannot regress a newer cursor or jump beyond it. Routine watch renewal preserves the outstanding cursor and error. Scan counters describe processing attempts, so retries can increase scanned-message counts.

Safety Center review copies the actual review timestamp and reviewer to the exact source email row in the same transaction, without asserting that the classification was confirmed or dismissed. This review marker survives later case cleanup. The internal source key is omitted from MailPilot HTTP responses. Existing email retention ages remain authoritative; the review marker allows already reviewed mail to qualify for that existing cleanup.

Missing or Gmail-expired history is surfaced as `MAILPILOT_HISTORY_RESYNC_REQUIRED`. The handler does not silently replace that cursor with the latest watch cursor. Recovering an expired Gmail range requires an explicit mailbox backfill or operator decision; this change does not implement a full mailbox backfill. Live Pub/Sub acknowledgement deadlines/retry configuration and a real Gmail pilot still need operational verification.

`tests/mailpilot-notification.test.ts` tests the actual HTTP acknowledgement handler, authentication, retry status, exact decimal cursor comparison and partial-batch retry behavior without Gmail or a database. `tests/mailpilot-safety-durability.integration.test.ts` uses only a local isolated fixture and tests outbox-failure rollback, concurrent/closed-case replay, raw retention, legacy repair, review propagation, tenant/license boundaries and stale cursor completion. Run the database suite serially.

Google documents acknowledgement and retry behavior in its [Gmail push notification guide](https://developers.google.com/workspace/gmail/api/guides/push).

## Setup and ownership

MailPilot is a paid ClassPilot add-on. Setup requires authorized school
Workspace domain-wide delegation for the service account and the
`gmail.readonly` scope. Use protected `MAILPILOT_SA_KEY_JSON`,
`MAILPILOT_PUBSUB_TOPIC`, and `MAILPILOT_PUBSUB_VERIFY_TOKEN` settings.

A super admin enables paid entitlement for a school with active ClassPilot.
The school admin opens Email Monitor and uses the setup wizard. Their
Workspace super admin authorizes the displayed client ID and scope in
domain-wide delegation. Verify with the approved test mailbox before
enabling watches. Keep school setup, active monitoring and billing separate.

- **Schema**: `src/schema/mailpilot.ts` — `mailpilot_watches`, `email_alerts`, `email_scan_log`
- **Schema columns**: `mailpilot_entitled`, `classpilot_email_monitoring`, and `mailpilot_org_units` on `schools`
- **AI classifier**: `classifyEmail()` in `src/services/aiClassification.ts` — Claude Haiku with severity + confidence + reasoning, no cache (emails are unique). Returns `safetyAlert`, `bullying`, `severity`, `confidence`, `reasoning`.
- **Gmail client**: `src/services/mailpilotGmail.ts` — JWT impersonation via `new google.auth.JWT({ subject: studentEmail })`, `startWatch`/`stopWatch`, `listHistorySince`, `fetchMessage` (MIME walker: plain text preferred, HTML fallback with tag stripping)
- **Pub/Sub webhook**: `src/routes/mailpilot/pubsub.ts` — bearer-token auth via `MAILPILOT_PUBSUB_VERIFY_TOKEN` (legacy query string `?token=...` also supported). Acknowledge only after the history batch completes; transient processing failures return 503 for provider retry. Email alerts, shared safety cases, and the outbox commit atomically. Stable message identity prevents reviewed/closed cases from reopening on replay. Watch renewal preserves unfinished cursors; expired history requires explicit recovery, never a silent cursor jump. See `docs/MAILPILOT_DURABILITY.md`.
- **Setup routes**: `src/routes/mailpilot/setup.ts` — `/setup/info`, `/setup/verify` (tests DWD with one student), `/setup/enable` (flips operational monitoring + starts watches with concurrency cap of 5), `/setup/disable`, `/setup/resync` (diffs roster, adds/removes watches). All setup routes require `mailpilot_entitled=true`.
- **Alert routes**: `src/routes/mailpilot/alerts.ts` — list/stats/detail/review (confirmed | dismissed | escalated). Alert routes require both `mailpilot_entitled=true` and `classpilot_email_monitoring=true`.
- **Super admin toggle**: `POST /api/super-admin/schools/:id/email-monitoring` in `superAdmin.ts` — toggles paid MailPilot entitlement (`mailpilot_entitled`) and requires active CLASSPILOT license to enable. Disabling entitlement stops watches and clears operational monitoring.
- **Scheduler**: `renewMailpilotWatches()` in `scheduler.ts` — hourly, renews any watch expiring within 24h (Gmail watches expire every 7 days) only for entitled schools with monitoring enabled.
- **Frontend**: `schoolpilot-app/src/products/classpilot/pages/EmailMonitoring.jsx` (dashboard) + `EmailMonitoringSetup.jsx` (3-step wizard: Overview → Authorize DWD → Verify + Enable). Linked from Admin.jsx header via "Email Monitor" button.
