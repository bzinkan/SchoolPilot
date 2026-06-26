# SOC 2 Claim Register

Use this register to prevent public/security claims from exceeding operating
evidence. Claims without current evidence should be revised or removed until the
control is operating.

| Claim ID | Source | Claim | Owner | Evidence Required | Status | Action |
| --- | --- | --- | --- | --- | --- | --- |
| CLAIM-001 | Security page, HECVAT, WISP | SchoolPilot maintains a documented security program. | Security & Privacy Officer | Approved WISP, annual review record, control matrix | Supported in repo, operating evidence needed | Keep, add evidence |
| CLAIM-002 | HECVAT, sales docs | SOC 2 Type II is planned, not completed. | Security & Privacy Officer | CPA engagement/readiness plan when available | Supported | Use "working toward SOC 2 Type II readiness" only |
| CLAIM-003 | AI Transparency, Subprocessors | AI data sent to subprocessors is limited and disclosed. | Engineering | AI data-flow inventory, audit events, redaction tests, updated public pages | Needs remediation | Revise after AI hardening |
| CLAIM-004 | WISP, HECVAT | Vendor DPAs and annual reviews exist for subprocessors. | Security & Privacy Officer | DPA copies, vendor review packet, subprocessor inventory | Not evidenced in repo | Store evidence privately or soften claim |
| CLAIM-005 | WISP, HECVAT | Restore testing is performed. | Engineering | Restore test packet with RTO/RPO and approver | Not evidenced in repo | Complete restore drill |
| CLAIM-006 | WISP, HECVAT | Privileged access is reviewed and protected. | Security & Privacy Officer | MFA export, quarterly access review, termination records | Needs remediation | Implement MFA/reviews |
| CLAIM-007 | Security page | Infrastructure uses AWS-managed certified data centers. | Engineering | AWS artifact reference, architecture diagram, AWS config export | Partially supported | Keep with AWS-scoped wording |
