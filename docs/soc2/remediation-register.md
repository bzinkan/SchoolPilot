# SOC 2 Remediation Register

Priority values: P0 blocks observation, P1 required before observation, P2 improves audit posture.

| ID | Priority | Area | Gap | Owner | Target | Evidence Needed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SOC2-001 | P0 | Incident response | Historical credential exposure investigated; Anthropic API credential rotated same day; no suspicious access or customer/student exposure found. | Security & Privacy Officer | Completed before observation | Private SOC2-001 evidence kit, credential rotation record, log review, exposure assessment, approved closure decision, approved no-notification decision | Closed |
| SOC2-002 | P0 | AI/privacy | AI assistant claims and implementation do not fully align. | Engineering | Before observation | Data-flow review, updated public docs, audit events, tests | In progress |
| SOC2-003 | P0 | Privileged access | In-app privileged MFA and token revocation are deferred; access reviews and risk acceptance need evidence in the meantime. | Engineering | Before observation | MFA export when implemented, auth tests, access review, risk acceptance | Open |
| SOC2-004 | P0 | Deployment | Production deploys need OIDC, protected approval, artifact digest, and operating deployment evidence. Shadow deployment evidence generation exists first. | Engineering | Before observation | Workflow run, shadow deployment packet, approval, digest, deployment record | In progress |
| SOC2-005 | P1 | Tenant isolation | Production RLS must be fail-closed and evidenced. | Engineering | Before observation | Tenant-isolation evidence packet, RLS status export, DB grants/policies export, CI tests, human review | In progress |
| SOC2-006 | P1 | Infrastructure | ECS private networking, HTTPS origin, WAF, RDS Multi-AZ, Redis TLS/failover need hardening. | Engineering | Before observation | Terraform plan/apply, AWS config exports, failover tests | Open |
| SOC2-007 | P1 | Security testing | CodeQL warnings must block or have approved risk acceptance. | Engineering | Before observation | CodeQL output, suppression/risk records | Open |
| SOC2-008 | P1 | Evidence | Governance and operational evidence must be organized and repeatable. | Security & Privacy Officer | Before observation | Control matrix, governance tracker, evidence index, review packets, CI evidence packet | In progress |
| SOC2-009 | P2 | Mobile | Native token storage must fail closed in production; Android backup disabled for both apps. | Engineering | Before observation | Mobile build config, tests, manifest review | Open |
