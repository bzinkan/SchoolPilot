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

Generate shadow deployment/change-management evidence locally:

```bash
npm run soc2:deployment-evidence
```

Deployment evidence is written to `soc2-evidence/deployments/` and uploaded in
CI as `soc2-evidence-deployment`. It records PR/commit/build metadata and file
hashes without deploying, using AWS credentials, or approving production changes.
