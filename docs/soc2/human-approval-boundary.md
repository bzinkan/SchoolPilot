# Human Approval Boundary

SchoolPilot can automate evidence collection, reminders, gap detection, and
status reporting. It must not automate judgment or sign-off.

## Human-Owned Decisions

- Risk acceptances require an accountable approver, expiration date, owner, and
  compensating controls.
- Vendor DPAs require human confirmation that the signed agreement exists in the
  private evidence repository.
- Incident decisions require human severity, customer-impact, notification, and
  closure decisions.
- Training attestations require each covered person to attest completion.
- Production deployment approvals require the documented approving person or
  protected-environment approval.
- CPA audit work must be performed by an independent CPA firm.

## Automation Boundary

Automation may:

- collect CI/build/test evidence
- draft risk acceptance records from open remediation items
- draft pending approval queue records for founder review
- summarize open remediation items
- identify missing private evidence pointers
- warn when public claims exceed evidence
- generate packets for review
- recommend `approved`, `not_approved`, or `manual_review` for a human to decide

Automation may not:

- approve risk acceptances
- sign DPAs
- decide incident notification obligations
- attest training on behalf of a person
- certify SOC 2 readiness
- represent that a CPA audit has occurred

## Approval Queue

The approval queue is a draft inbox only. `npm run soc2:approval-queue` can
prepare pending records, evidence pointers, expiration dates, and recommended
decisions. `npm run soc2:approval-decision` records only the accountable
person's explicit `approved` or `not_approved` decision and writes it to the
private evidence repository.
