# SOC 2 Evidence Index

This index describes where evidence belongs. Do not commit private artifacts,
vendor contracts, personnel records, incident details, screenshots, production
exports, or generated evidence packets to this repository.

| Evidence Area | Primary Controls | Collection Mode | Private Location |
| --- | --- | --- | --- |
| CI/build/test packets | SP-SEC-002, SP-SEC-004, SP-CONF-002 | Automated | GitHub Actions artifacts and `SchoolPilot-SOC2-Evidence/ci/` |
| Private evidence readiness metadata | Approval queue prerequisites | Automated metadata only | GitHub Actions artifact `soc2-private-evidence-readiness` and ignored `soc2-evidence/private-readiness/` |
| Approval queue | Human-approved evidence items | Automated draft plus founder approval | GitHub issue `SOC 2 approvals pending`, GitHub Actions artifact `soc2-approval-queue`, and `SchoolPilot-SOC2-Evidence/approvals/` |
| Privileged access evidence packet | SP-SEC-001 | Automated | GitHub Actions artifact `soc2-evidence-privileged-access` and ignored `soc2-evidence/privileged-access/` |
| Privileged access review | SP-SEC-001 | Private draft plus human approved | `SchoolPilot-SOC2-Evidence/access-reviews/` |
| Privileged user/role export | SP-SEC-001 | Private manual or explicit database export | `SchoolPilot-SOC2-Evidence/access-reviews/exports/` |
| Tenant isolation and RLS evidence | SP-SEC-002 | Automated draft plus human approved | GitHub Actions artifact `soc2-evidence-tenant-isolation` and `SchoolPilot-SOC2-Evidence/tenant-isolation/` |
| Security event review | SP-SEC-003 | Automated plus human approved | `SchoolPilot-SOC2-Evidence/security-events/` |
| Incident evidence and decisions | SP-SEC-003 | Automated draft plus human approved | GitHub Actions artifact `soc2-evidence-incidents` and `SchoolPilot-SOC2-Evidence/incidents/` |
| SOC2-001 private incident drafts | SP-SEC-003 | Private draft templates plus founder completion | `SchoolPilot-SOC2-Evidence/incidents/credential-rotation/`, `SchoolPilot-SOC2-Evidence/incidents/log-review/`, `SchoolPilot-SOC2-Evidence/incidents/exposure-assessment/` |
| Founder-only training attestation | SP-SEC-003 | Automated draft plus founder approval | `SchoolPilot-SOC2-Evidence/training/` |
| Shadow deployment evidence | SP-SEC-004 | Automated | GitHub Actions artifact `soc2-evidence-deployment` and `SchoolPilot-SOC2-Evidence/deployments/` |
| Deployment approval | SP-SEC-004 | Automated plus human approved | `SchoolPilot-SOC2-Evidence/deployments/` |
| Vendor DPA and annual review | SP-SEC-005 | Human approved | `SchoolPilot-SOC2-Evidence/vendors/` |
| Risk acceptance drafts and approvals | All controls with accepted exceptions | Automated draft plus founder approval | `SchoolPilot-SOC2-Evidence/risk-acceptances/` |
| Backup and restore testing | SP-AVL-001 | Manual record plus human approved | `SchoolPilot-SOC2-Evidence/backups/` |
| Monitoring review | SP-AVL-002 | Automated plus human approved | `SchoolPilot-SOC2-Evidence/monitoring/` |
| Encryption configuration | SP-CONF-001 | Manual record | `SchoolPilot-SOC2-Evidence/encryption/` |
| AI/privacy evidence packet | SP-CONF-002 | Automated | GitHub Actions artifact `soc2-evidence-ai-privacy` and ignored `soc2-evidence/ai-privacy/` |
| AI data-flow review | SP-CONF-002 | Private draft plus human approved | `SchoolPilot-SOC2-Evidence/ai/reviews/` |

Generated local packets should use `soc2-evidence/`, which is ignored by Git.
Shadow deployment packets are written to `soc2-evidence/deployments/` and must
not include AWS credentials, production secrets, or customer data.
Incident evidence packets are written to `soc2-evidence/incidents/` and must
contain only non-sensitive metadata and pointers to private evidence.
Tenant isolation packets are written to `soc2-evidence/tenant-isolation/` and
must not include production DB exports, grants, policies, or customer data.
AI/privacy evidence packets are written to `soc2-evidence/ai-privacy/` and
must not include prompt bodies, API keys, raw logs, transcripts, customer
records, or student records.
Privileged access evidence packets are written to
`soc2-evidence/privileged-access/` and must not include password hashes, session
contents, raw user exports, secrets, customer records, or student records.
