# SOC 2 Remediation Register

Priority values: P0 blocks observation, P1 required before observation, P2 improves audit posture.

| ID | Priority | Area | Gap | Owner | Target | Evidence Needed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SOC2-001 | P0 | Incident response | Historical credential exposure needs formal incident record and rotation evidence. | Security & Privacy Officer | Before observation | Incident report, rotation records, log review, notification decision | Open |
| SOC2-002 | P0 | AI/privacy | AI assistant claims and implementation do not fully align. | Engineering | Before observation | Data-flow review, updated public docs, audit events, tests | In progress |
| SOC2-003 | P0 | Privileged access | Super-admin/production admin MFA and token revocation need implementation and evidence. | Engineering | Before observation | MFA export, auth tests, access review | Open |
| SOC2-004 | P0 | Deployment | Production deploys need OIDC, protected approval, artifact digest, and evidence record. | Engineering | Before observation | Workflow run, approval, digest, deployment record | Open |
| SOC2-005 | P1 | Tenant isolation | Production RLS must be fail-closed and evidenced. | Engineering | Before observation | RLS status export, DB grants/policies export, CI tests | In progress |
| SOC2-006 | P1 | Infrastructure | ECS private networking, HTTPS origin, WAF, RDS Multi-AZ, Redis TLS/failover need hardening. | Engineering | Before observation | Terraform plan/apply, AWS config exports, failover tests | Open |
| SOC2-007 | P1 | Security testing | CodeQL warnings must block or have approved risk acceptance. | Engineering | Before observation | CodeQL output, suppression/risk records | Open |
| SOC2-008 | P1 | Evidence | Governance and operational evidence must be organized and repeatable. | Security & Privacy Officer | Before observation | Control matrix, evidence index, review packets | In progress |
| SOC2-009 | P2 | Mobile | Native token storage must fail closed in production; Android backup disabled for both apps. | Engineering | Before observation | Mobile build config, tests, manifest review | Open |
