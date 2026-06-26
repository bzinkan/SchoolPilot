# SOC 2 Control Matrix

Status values: Planned, Implementing, Operating, Exception, Ready.
Evidence modes live in `governance-controls.json`: automated, manual record,
or human approved. Human-approved evidence is tracked by automation but must be
signed by an accountable person.

| Control ID | Criteria | Control | Owner | Frequency | Implementation | Test Procedure | Evidence Source | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SP-SEC-001 | CC6.1, CC6.2 | Privileged access requires approved role assignment and planned MFA rollout. | Security & Privacy Officer | Continuous, quarterly review | MFA is deferred; privileged access review and role approval evidence are tracked until MFA is implemented. | Sample privileged users, verify approval evidence and any accepted MFA exceptions. | Access review packet, auth logs, user export, risk acceptance | Planned |
| SP-SEC-002 | CC6.3, CC6.6 | Tenant data is isolated by application authorization and PostgreSQL RLS. | Engineering | Continuous | Request tenant context binds DB GUC; tenant tables enforce RLS policies. | Run cross-tenant tests and production RLS coverage check. | CI evidence, RLS status export | Implementing |
| SP-SEC-003 | CC7.1, CC7.2 | Security events are logged, monitored, and investigated. | Security & Privacy Officer | Continuous, monthly review | Audit logs and security_events table capture security activity; monitor alerts on detections. | Verify event catalog coverage and sample alerts through resolution. | Alert review packet, incident log | Implementing |
| SP-SEC-004 | CC8.1 | Code changes require CI checks and approved deployment evidence. | Engineering | Per change | Protected branch, CI checks, OIDC deploy, digest-pinned artifact, production approval. | Sample deployments and trace commit to artifact to approval to production. | CI evidence, deploy evidence | Implementing |
| SP-SEC-005 | CC9.2 | Vendors handling customer data have human-confirmed DPAs and annual reviews. | Security & Privacy Officer | Annual, on change | Vendor inventory tracks subprocessors, data handled, private DPA evidence, security report, and risk decision. | Sample active vendors and verify current review/DPA evidence with human approval. | Vendor review packet | Planned |
| SP-AVL-001 | A1.2, A1.3 | Production backups are configured and restore-tested. | Engineering | Backup continuous, test at least annual | RDS automated backups, documented restore runbook, measured RTO/RPO. | Perform restore drill and record results. | Restore test packet, AWS backup export | Planned |
| SP-AVL-002 | A1.2 | Production services are monitored and alert on degradation. | Engineering | Continuous, monthly review | Health checks, CloudWatch metrics, security monitor, alert routing. | Sample alerts and verify owner response. | Monitoring review packet | Implementing |
| SP-CONF-001 | C1.1, C1.2 | Sensitive data is encrypted in transit and at rest. | Engineering | Continuous | TLS for public traffic and DB connections; encrypted RDS, S3, Redis. | Verify AWS config and app connection settings. | AWS config export, Terraform plan | Implementing |
| SP-CONF-002 | C1.1, CC6.7 | AI assistant data flows are restricted, authorized, and logged. | Engineering | Continuous | AI disabled by default; conversations scoped to user/school; tools enforce authorization and audit. | Test cross-user rejection, tool authorization, and audit events. | AI test evidence, audit-log sample | Implementing |
