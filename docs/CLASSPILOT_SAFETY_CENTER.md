# Safety Center administrator guide

Open **ClassPilot → Admin panel → Safety Center**. The card appears below Coverage and immediately above Database Cleanup. Its count shows open, unreviewed alerts.

Every new distinct student safety alert is emailed to every active school administrator, including both `admin` and `school_admin` roles. Severity helps administrators assess the report; it does not suppress the initial email. Teachers, office staff, and the operational Central Email Copy recipient are not added to these safety emails. Browser and enabled MailPilot detections use this workflow.

Repeated observations of the same URL and concern update the report's observation count. They do not create repeated initial emails or undo a prior acknowledgment. All eligible initial alerts already due for the same student report and recipient at the worker's reservation cutoff share one email. The worker reserves up to twenty complete notification groups per pass; it does not split a group at an alert-row limit. Email bodies show at most twenty alert details and twenty report links, with complete counts and authenticated links for additional details. Unacknowledged alerts receive one follow-up after fifteen minutes; there is no recurring reminder loop. Ordinary off-task browsing and connectivity interruptions do not generate safety emails.

## How browser classification works

ClassPilot first checks recognized search-engine queries for reviewed concern patterns, then applies known website and school-domain rules. For an unfamiliar page, the optional Gemini fallback receives its URL and title only. It does not read assessment questions, page body text, or screenshots. An educational, off-task, or unknown classification alone never creates a safety alert.

The first-party `nwea.org` and `mapnwea.org` domains, including their subdomains, are explicitly educational with no safety alert. This covers MAP testing, practice, authentication and student resources; those pages bypass the model even when an assessment title contains a sensitive topic. These domains were verified against NWEA's [2026–27 MAP Administration and Operations Guide](https://www.nwea.org/uploads/NYC_MAPAdminOpsGuide-AOG_NWEA_Guide.pdf). Lookalike hosts and unrelated shared infrastructure do not receive this rule. Independently configured website blocks remain effective.

Bare mentions of suicide or self-harm, prevention hotlines, health-class statistics, and generic support/recovery searches do not match the self-harm search rules. Explicit intent, dangerous method requests, and threats remain eligible. A support clause does not erase a separate explicit concern in the same query. Adding “research” to an explicit harmful request does not exempt it.

Model instructions require a clear indication in the supplied URL/title and exclude ambiguous topic mentions, ordinary assessments, prevention resources and academic research. Model decisions are cached for thirty minutes only for the same exact URL and title, including query and fragment. A safe or unsafe model result from one page cannot classify another page on the same website. Simultaneous identical requests share work; provider concurrency and queue limits remain bounded.

These changes reduce known false positives; they are not a guarantee of model accuracy. Browser confidence remains unavailable rather than an invented percentage. Administrators can review an alert and approve its exact URL to suppress future alerts school-wide. Review and notification rules still apply to every qualified distinct alert regardless of severity.

## Reviewing a student report

Use the case, review, student-name, and school-local date filters to find a report. Open it to see individual concerns, the reported URL when retained, available explanation and evidence, observations, assignment, notes, delivery status, and administrator history.

Alerts and administrator actions have independent pages of 100 entries. Use **Older alerts** or **Older actions** to continue, and the corresponding **Newest** button to return. Delivery details belong to the displayed alerts. Pagination preserves events that occurred within the same millisecond.

- **Mark reviewed** records the assessment and stops the alert's pending follow-up. It does not approve future activity.
- **Stop alerts for this URL** shows the exact retained URL before creating an approval for all students in this school. Scheme, meaningful port, path, query order, duplicate parameters, and fragment remain significant. A different page or query remains eligible. The approval does not override an existing website block.
- **Block website** shows the domain before adding it to the school's blocklist. The rule and review record commit together. A saved rule is separate from confirmation that a connected device applied it; offline and unsupported devices remain pending.

Use **Approved URLs** to revoke an approval. Revocation makes future observations eligible again and does not replay old emails. URL-specific actions are unavailable for MailPilot alerts or other reports lacking a trustworthy retained browser URL.

Assignment is limited to active school administrators. **Acknowledge current alerts** records receipt and stops their pending follow-ups; they remain unreviewed until an administrator assesses them. It does not cancel their initial administrator notification. Closing a case requires a resolution note. Later unsuppressed activity opens a new case. Reviewing one individual alert preserves unrelated concerns.

## Delivery and retention

The durable delivery log distinguishes pending, sending, accepted, cancelled, failed, and unknown outcomes. Transport failures retry with bounded backoff. Accepted messages are not retried. If a worker loses the outcome of an in-flight request, delivery is recorded as unknown rather than assumed successful or blindly resent. An email already in flight cannot be recalled after an administrator reviews the report.

Exact URL approvals are encrypted school configuration and persist until revoked. Raw browser URLs, heartbeats, email bodies, and screenshot content retain their independent retention limits. Minimal case provenance stays while a case is open and for at least the greater of 90 days or school retention after closure. The existing count/delete rollout control still governs case-spine deletion. Historical exported evidence packets are not rewritten.

AI detections leave tabs open. Existing teacher commands and explicit school/classroom restrictions continue to apply. The former Settings controls for AI safety emails and automatic tab closure do not control this workflow.

School Allowed Domains and Flight Paths express classroom intent for off-task reporting. They do not approve safety content across a website. Use the exact URL approval in Safety Center to stop future safety alerts for a reviewed page, including its specific query and fragment.

## Operator rollout

Apply the additive migrations and admit the reviewed tenant-table inventory before deploying the dependent API/UI and worker. Configure the existing secret-encryption key and email provider for durable URL approval and delivery. A missing provider is recorded as a delivery failure, not a successful send. Pilot alert volume and review actions before broad activation.

The Chrome extension is released from the separate ClassPilot repository. Current-tab website enforcement requires its new capability and exact binding ACK; do not infer applied enforcement from policy save alone. Five-second preview activation remains independently gated by fresh capacity evidence.
