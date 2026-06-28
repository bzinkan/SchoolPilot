# SchoolPilot SOC 2 Agent Runbook

Use this file before doing SOC 2 work in this repository. It is a routing guide
for coding agents, not an audit report, certification statement, evidence
record, or current compliance status.

## Sources of Truth

When SOC 2 facts conflict, prefer these sources in this order:

1. `docs/soc2/governance-controls.json` for machine-readable controls and
   evidence metadata.
2. `docs/soc2/control-matrix.md` for control owners, status, tests, and
   evidence.
3. `docs/soc2/remediation-register.md` for open gaps and target remediation.
4. `docs/soc2/evidence-index.md` for where evidence belongs.
5. `docs/soc2/human-approval-boundary.md` for decisions automation cannot
   make.
6. `../SchoolPilot-SOC2-Evidence` for private evidence, completed approvals,
   private exports, vendor evidence, and incident details.
7. GitHub issue `SOC 2 approvals pending` / issue #146 for actionable approval
   queue items.
8. The Super Admin SOC 2 dashboard for a read-only operational view of the same
   readiness and approval signals.

Do not duplicate live approval status in this file. Check the sources above.

## Agent Rules

Automation may draft evidence packets, readiness gaps, risk acceptances,
approval queues, private evidence templates, and recommendations.

Automation must not:

- approve or reject human-owned decisions unless the founder/security owner has
  explicitly given that decision and rationale
- invent incident facts, vendor terms, audit conclusions, or production state
- certify SOC 2 readiness or imply Type II compliance is complete
- copy private evidence bodies, contracts, logs, credentials, tokens, customer
  data, student data, or approval rationales into this repo or public artifacts
- enable MFA, change login behavior, revoke sessions, deploy, query production
  DB, or change AWS unless the task explicitly asks for that behavior
- call evidence-only work "no-user-impact" if it changes app runtime behavior,
  auth, MFA, school IT, teacher, student, parent, AWS, production DB, or deploys

## Command Guide

Run the governance check when changing SOC 2 docs, security/privacy/legal
claims, evidence scripts, control metadata, remediation status, or public claims:

```bash
npm run soc2:check
```

Generate non-sensitive evidence packets:

```bash
npm run soc2:deployment-evidence
npm run soc2:incident-evidence
npm run soc2:tenant-isolation-evidence
npm run soc2:ai-privacy-evidence
npm run soc2:privileged-access-evidence
npm run soc2:monitoring-evidence
```

Create private draft evidence templates. Drafts are not approvals and usually
must be completed and marked `ready_for_approval` before they become actionable:

```bash
npm run soc2:incident-private-evidence-kit -- --private-dir ../SchoolPilot-SOC2-Evidence
npm run soc2:ai-private-evidence-kit -- --private-dir ../SchoolPilot-SOC2-Evidence
npm run soc2:privileged-access-private-evidence-kit -- --private-dir ../SchoolPilot-SOC2-Evidence
npm run soc2:monitoring-private-evidence-kit -- --private-dir ../SchoolPilot-SOC2-Evidence
```

Generate private readiness metadata and the approval queue:

```bash
npm run soc2:private-evidence-readiness -- --private-dir ../SchoolPilot-SOC2-Evidence
npm run soc2:approval-queue
npm run soc2:approval-issue
```

Record a human-owned approval only when the founder/security owner has explicitly
provided the decision and rationale:

```bash
npm run soc2:approval-decision -- --approval-id <id> --decision approved|not_approved --approver "<name>" --rationale "<why>"
```

## Change Checklist

If SOC 2 docs or control status change, keep the control matrix, remediation
register, evidence index, governance JSON, and relevant tests aligned.

If new evidence automation is added, include tests, CI artifact upload, docs,
private readiness behavior when private evidence gates approval, and approval
queue behavior when human review is required.

If private evidence is required, write only to `../SchoolPilot-SOC2-Evidence` or
the configured `SOC2_PRIVATE_EVIDENCE_DIR`. Do not commit generated local
packets under `soc2-evidence/`.

If a user-facing or production behavior changes, update the impact statement and
do not describe the work as evidence-only.

## Current Known Posture

Verify these against the sources of truth before relying on them:

- MFA is deferred and not live.
- Privileged access, monitoring, incident, AI/privacy, deployment, and tenant
  isolation work is increasingly automated for evidence and readiness tracking.
- The approval queue and Super Admin SOC 2 dashboard are review surfaces, not
  approval engines.
- Private evidence remains outside this repo in `../SchoolPilot-SOC2-Evidence`.
- SOC 2 Type II still requires time-based operation, sustained evidence, human
  approvals, and CPA auditor review.
