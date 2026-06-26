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

## Files

- `control-matrix.md` maps controls to owners, tests, evidence, and status.
- `remediation-register.md` tracks gaps that must close before observation.
- `claim-register.md` tracks public or contractual claims against evidence.
- `templates/` contains reusable human-review evidence templates.
