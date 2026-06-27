# SchoolPilot SOC 2 Readiness

This folder tracks SchoolPilot's SOC 2 Type II readiness work. It is not the
private evidence repository and should not contain vendor agreements, personnel
records, incident details, screenshots, or production exports.

Target first-report criteria:

- Security
- Availability
- Confidentiality

Privacy controls should be built and evidenced because SchoolPilot handles
student data, but formal Privacy criteria are deferred until a CPA firm confirms
the first-report scope.

## Evidence Handling

Generated evidence should be written to a private evidence store such as
`SchoolPilot-SOC2-Evidence`. CI also uploads generated evidence packets as
workflow artifacts. Do not commit generated evidence packets to this repo.

Every evidence packet should include:

- Control IDs covered
- Owner
- Collection timestamp
- Source system
- Commit SHA, workflow run, or ticket reference
- Result and reviewer, when human approval is required

Automation may collect evidence and identify gaps, but it must not approve
human-owned decisions. Risk acceptances, vendor DPA confirmations, incident
decisions, training attestations, deployment approvals, and CPA audit judgments
require accountable human sign-off.

## Files

- `control-matrix.md` maps controls to owners, tests, evidence, and status.
- `governance-controls.json` is the machine-readable control/evidence tracker
  used by CI.
- `evidence-index.md` maps evidence types to private storage locations.
- `human-approval-boundary.md` defines which decisions automation cannot sign.
- `remediation-register.md` tracks gaps that must close before observation.
- `claim-register.md` tracks public or contractual claims against evidence.
- `templates/` contains reusable human-review evidence templates.

## Automated Check

Run the non-sensitive governance check locally:

```bash
npm run soc2:check
```

The check writes generated packets to `soc2-evidence/`, which is ignored by Git.
It fails on malformed governance metadata or overstated public SOC 2 claims. It
warns, but does not fail, when human approvals are still pending.

The check also drafts risk acceptance records from open remediation items using
`risk-acceptance-policy.json`. Drafts are written to
`soc2-evidence/risk-acceptances/` and are always marked pending founder
approval. Automation may prepare the record, expiration, owner, risk level, and
suggested compensating controls; the founder must still approve or reject the
risk.

Generate non-sensitive AI/privacy evidence locally:

```bash
npm run soc2:ai-privacy-evidence
```

AI/privacy evidence is written to `soc2-evidence/ai-privacy/` and uploaded in
CI as `soc2-evidence-ai-privacy`. It records metadata, source hashes, AI feature
inventory, data-flow summaries, test pointers, and public-claim review findings
for `SOC2-002`. It must not copy prompt bodies, API keys, raw logs,
transcripts, customer records, or student records.

Create a private draft AI data-flow review for `SOC2-002`:

```bash
npm run soc2:ai-private-evidence-kit -- --private-dir ../SchoolPilot-SOC2-Evidence
```

The private AI kit writes `ai/reviews/soc2-002-ai-data-flow-review.{json,md}`
into the private evidence repo. Drafts use
`status: draft_pending_founder_input`; they are checklists, not final
conclusions. The founder/security owner must complete the factual fields and
change the JSON record to `status: ready_for_approval` before the AI data-flow
review moves out of readiness gaps and into the GitHub approval queue.

Generate shadow deployment/change-management evidence locally:

```bash
npm run soc2:deployment-evidence
```

Deployment evidence is written to `soc2-evidence/deployments/` and uploaded in
CI as `soc2-evidence-deployment`. It records PR/commit/build metadata and file
hashes without deploying, using AWS credentials, or approving production changes.

Generate non-sensitive incident response evidence locally:

```bash
npm run soc2:incident-evidence
```

Incident evidence is written to `soc2-evidence/incidents/` and uploaded in CI as
`soc2-evidence-incidents`. It records metadata and evidence pointers for
`SOC2-001`; private incident details, logs, credentials, customer data, and
student data stay in `SchoolPilot-SOC2-Evidence/incidents/`.

Create private draft evidence templates for `SOC2-001`:

```bash
npm run soc2:incident-private-evidence-kit -- --private-dir ../SchoolPilot-SOC2-Evidence
```

The private incident kit writes draft JSON/Markdown records for credential
rotation, security log review, and exposure assessment into the private evidence
repo. Drafts use `status: draft_pending_founder_input`; they are checklists, not
final conclusions. The founder/security owner must complete the factual fields
and change all three JSON records to `status: ready_for_approval` before the
incident closure and notification decisions move out of readiness gaps and into
the GitHub approval queue.

Generate non-sensitive tenant isolation/RLS evidence locally:

```bash
npm run soc2:tenant-isolation-evidence
```

Tenant isolation evidence is written to `soc2-evidence/tenant-isolation/` and
uploaded in CI as `soc2-evidence-tenant-isolation`. It records RLS policy/test
source hashes, CI artifact references, and private production export pointers
for `SOC2-005`; production DB exports, grants, policies, and customer data stay
in `SchoolPilot-SOC2-Evidence/tenant-isolation/`.

Generate non-sensitive private evidence readiness metadata locally:

```bash
npm run soc2:private-evidence-readiness -- --private-dir ../SchoolPilot-SOC2-Evidence
```

Private evidence readiness is written to `soc2-evidence/private-readiness/`.
It records completed approval IDs, decision statuses, expiration dates, relative
private evidence paths, file hashes, and missing/present checks only. It must not
copy private evidence contents, approval rationales, secrets, logs, credentials,
customer data, or student data into this repository or a public CI artifact.

Generate the pending approval queue locally:

```bash
npm run soc2:approval-queue
```

Approval queue drafts are written to `soc2-evidence/approvals/` and uploaded in
CI as `soc2-approval-queue`. The queue gathers human-owned decisions from the
governance tracker, risk acceptance drafts, local incident evidence, local tenant
isolation evidence, local AI/privacy evidence, local deployment evidence, and
optional private readiness metadata. When private readiness metadata is present,
already-decided approvals
are suppressed, approved unexpired risk acceptances stay out of the queue, and
items missing required private evidence appear as readiness gaps instead of
approval commands. Shadow deployment packets with no requested production deploy
do not create deployment approval commands.

CI on `main` also opens or updates the GitHub issue `SOC 2 approvals pending`.
When approvals are pending, the workflow assigns the issue to the notification
owner, adds the `soc2-approval-needed` label, and posts a mention comment when
the pending approval set changes. The issue is a review inbox. Authorized
approvers may comment:

```text
/approve APPROVAL-ID rationale
/reject APPROVAL-ID rationale
```

The GitHub comment workflow verifies the commenter, downloads the matching
`soc2-approval-queue` artifact, records the decision, and writes JSON/Markdown
evidence to the private `SchoolPilot-SOC2-Evidence` repository. Configure the
private evidence checkout with the `SOC2_EVIDENCE_REPO_TOKEN` GitHub secret.
Optionally set `SOC2_APPROVAL_AUTHORIZED_ACTORS` as a comma-separated repository
variable; it defaults to `bzinkan`.

On pull requests, CI keeps the approval queue secret-free and does not checkout
the private evidence repo. On `main`, CI uses `SOC2_EVIDENCE_REPO_TOKEN` to read
the private evidence repo, generates the non-sensitive
`soc2-private-evidence-readiness` artifact, and uses it to keep the GitHub issue
focused on actionable approvals.

Approval notifications default to `@bzinkan`. Optionally set
`SOC2_APPROVAL_NOTIFY_USERS` as a comma-separated repository variable to notify
and assign different GitHub users, and `SOC2_APPROVAL_LABEL` to override the
default `soc2-approval-needed` label. Notifications use GitHub issues only; no
email provider or app runtime path is involved.

Record an approve/not-approve decision into the private evidence repository:

```bash
npm run soc2:approval-decision -- --approval-id <id> --decision approved|not_approved --approver "<name>" --rationale "<why>"
```

Completed approvals default to `../SchoolPilot-SOC2-Evidence`, or to
`SOC2_PRIVATE_EVIDENCE_DIR` when that environment variable is set. This command
fails if the private evidence directory is missing so sensitive approval records
are not accidentally written into this application repository.
