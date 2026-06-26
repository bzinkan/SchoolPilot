# SOC 2 Evidence Index

This index describes where evidence belongs. Do not commit private artifacts,
vendor contracts, personnel records, incident details, screenshots, production
exports, or generated evidence packets to this repository.

| Evidence Area | Primary Controls | Collection Mode | Private Location |
| --- | --- | --- | --- |
| CI/build/test packets | SP-SEC-002, SP-SEC-004, SP-CONF-002 | Automated | GitHub Actions artifacts and `SchoolPilot-SOC2-Evidence/ci/` |
| Privileged access review | SP-SEC-001 | Human approved | `SchoolPilot-SOC2-Evidence/access-reviews/` |
| Security event review | SP-SEC-003 | Automated plus human approved | `SchoolPilot-SOC2-Evidence/security-events/` |
| Deployment approval | SP-SEC-004 | Automated plus human approved | `SchoolPilot-SOC2-Evidence/deployments/` |
| Vendor DPA and annual review | SP-SEC-005 | Human approved | `SchoolPilot-SOC2-Evidence/vendors/` |
| Risk acceptance drafts and approvals | All controls with accepted exceptions | Automated draft plus founder approval | `SchoolPilot-SOC2-Evidence/risk-acceptances/` |
| Backup and restore testing | SP-AVL-001 | Manual record plus human approved | `SchoolPilot-SOC2-Evidence/backups/` |
| Monitoring review | SP-AVL-002 | Automated plus human approved | `SchoolPilot-SOC2-Evidence/monitoring/` |
| Encryption configuration | SP-CONF-001 | Manual record | `SchoolPilot-SOC2-Evidence/encryption/` |
| AI data-flow review | SP-CONF-002 | Automated plus human approved | `SchoolPilot-SOC2-Evidence/ai/` |

Generated local packets should use `soc2-evidence/`, which is ignored by Git.
