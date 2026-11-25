# External AI processing

SchoolPilot API and background workers default to local operation. Only the exact value `SCHOOLPILOT_EXTERNAL_AI_MODE=on` allows a request to an external model. A provider key or a product switch alone cannot enable it. The same gate protects the transport used for SDK requests and retries.

| Feature | While external AI processing is paused |
| --- | --- |
| ClassPilot browser activity | Reviewed domain and search rules continue, along with school-specific classification and teacher classroom controls. Unresolved pages can stay unknown. Browser Gemini also requires its independent browser mode and key. |
| Class Chat and polls | Local safety rules and the human review workflow continue. Secondary model review is unavailable. |
| MailPilot | Authenticated, well-formed Gmail notifications, including duplicates, receive a pause-specific retry response before mailbox lookup or Gmail access. Each active watch keeps its processed cursor. Scan counts and findings do not advance for deferred mail. Existing findings remain available and watches may renew. |
| Staff assistant | New messages, continuations and pending tool confirmations are unavailable. |
| Teacher-initiated paperwork and contact imports | New AI processing is unavailable. Workers skip new claims, and already claimed work on a paused worker keeps its state. The original lease can expire. Ordinary cancellation and retention deadlines still apply. Existing authorized records remain available according to the underlying feature and access controls. |

## Operating the pause

Leave the global switch absent or set it to `off` on every API and worker task. Replace existing tasks. During a rolling deployment, tasks on the previous revision may still finish or initiate calls. Verify every serving and background task runs the intended digest with the mode absent or off. Exercise a synthetic unknown URL, scheduled classroom, teacher command, chat and poll. Confirm existing Safety Center records can be reviewed. Use only synthetic fixtures to validate provider transport suppression. Retain the rollout time and task revision with the verification record.

## Reactivation

Production reactivation requires the owner's decision and written legal approval for the specific provider, purposes, data, applicable school authorizations and provider terms. Review all configured optional product switches and credentials before changing the global mode, because more than one feature may become eligible together. Coordinate any required school communications, review the scope of unexpired import jobs that could resume, and record actual implementation and verification times.

Before resuming MailPilot, verify that the destination handling push notifications has an approved mailbox lookup path in its deployment role. Review expected retry volume, monitoring capacity and duplicate delivery costs after a long hold. Then check the oldest retained watch cursor against Gmail history availability and the subscription retry retention. A lengthy pause can outlast both. An expired cursor requires an authorized recovery or explicit coverage-gap determination. Preserve the prior cursor until the recovery scope is settled. Do not represent deferred messages as scanned or safe, or assume complete backfill. Previously sent requests and provider-held copies are separate historical records.
