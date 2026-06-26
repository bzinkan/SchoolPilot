# Written Information Security Program (WISP)

**Company:** Schoolpilot
**Effective Date:** April 12, 2026
**Last Reviewed:** April 12, 2026
**Owner:** Security & Privacy Officer (security@school-pilot.net)
**Review Cycle:** Annual, or after any material change or security incident

---

## 1. Purpose and Scope

This Written Information Security Program (WISP) establishes administrative, technical, and physical safeguards designed to protect the confidentiality, integrity, and availability of **Personally Identifiable Information (PII)** — including student education records covered by FERPA and data of children under 13 covered by COPPA — handled by Schoolpilot ("the Company") across its products: ClassPilot, PassPilot, and GoPilot.

This program applies to all Schoolpilot employees, contractors, systems, networks, and third-party service providers that access, process, or store customer data.

## 2. Roles and Responsibilities

| Role | Responsibilities |
|------|------------------|
| **Security & Privacy Officer** | Owns this WISP; annual review; incident response coordination; vendor security reviews. Contact: security@school-pilot.net |
| **Engineering Lead** | Implements technical controls; code review for security; maintains dependency hygiene |
| **All Personnel** | Follow security policies; report suspected incidents immediately; complete annual security awareness training |

## 3. Data Classification

| Classification | Examples | Handling |
|----------------|----------|----------|
| **Restricted** | Student PII, education records, authentication credentials, API keys | Encrypted at rest and in transit; access logged; least-privilege access |
| **Confidential** | School configuration, internal business data | Access-controlled; not publicly accessible |
| **Public** | Marketing pages, documentation, privacy policy | No restrictions |

## 4. Administrative Safeguards

### 4.1 Access Control
- **Role-Based Access Control (RBAC)** enforced at the application layer. Four roles: `admin`, `teacher`, `office_staff`, `parent`. Additional `super_admin` role reserved for Schoolpilot internal staff.
- **Least privilege**: Teachers can only monitor students in groups they are assigned to.
- **Multi-Factor Authentication (MFA)** required for production AWS access where supported. In-app privileged/admin MFA is tracked as a SOC 2 remediation item and should not be represented as fully operating until deployed and evidenced.
- **Password requirements**: Minimum 8 characters; hashed with bcrypt (12 salt rounds); no plaintext storage.
- **Session management**: 7-day expiration; httpOnly + secure cookies; rolling renewal.

### 4.2 Personnel Security
- Background checks for all employees with access to production systems.
- Signed confidentiality agreement required before access to customer data.
- Access revoked within 24 hours of employee termination.
- Annual security awareness training for all personnel.

### 4.3 Vendor / Third-Party Management
All third-party service providers handling PII are reviewed annually and must sign Data Processing Agreements. Current providers:

| Vendor | Purpose | Data Processed |
|--------|---------|----------------|
| **AWS (us-east-1)** | Hosting, database, storage | All customer data (SOC 2, ISO 27001, FERPA-aligned) |
| **SendGrid** | Transactional email | Email addresses only |
| **Stripe** | Payment processing | School billing info (PCI-DSS Level 1) |
| **Anthropic Claude** | AI URL classification | URL strings only, no student PII |
| **Google OAuth / Workspace API** | Authentication, roster sync | Email, name, classroom rosters (verified for restricted scopes) |

## 5. Technical Safeguards

### 5.1 Encryption
- **In transit**: TLS 1.2+ for all client-server communication. HSTS with `max-age=31536000` enforced via Helmet.
- **At rest**: AWS RDS PostgreSQL with encryption enabled; S3 buckets encrypted with SSE-S3; Redis TLS in transit.

### 5.2 Network Security
- Production ECS tasks in private VPC subnets; RDS not publicly accessible.
- CloudFront + ALB as only public ingress; WAF-style filtering via security groups.
- CORS allowlist enforced for API origins.
- CSRF tokens on state-changing requests.

### 5.3 Application Security
- Helmet.js security headers: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy.
- Rate limiting on authentication endpoints to prevent brute-force.
- Parameterized queries via Drizzle ORM (no raw SQL injection risk).
- Dependency vulnerability scanning via `npm audit` on every CI run (critical-severity vulnerabilities block deploys).
- Automated tests run on every pull request before merge.

### 5.4 Logging and Monitoring
- Application errors tracked via internal error monitor with email alerts to security@school-pilot.net.
- Audit log table records admin actions (user/role changes, school creation, license changes).
- CloudWatch logs retained for 30 days minimum.
- Failed authentication attempts rate-limited and alerted on spikes.

### 5.5 Development Practices
- All code changes peer-reviewed via pull request before production merge.
- Continuous integration runs TypeScript type-check, lint, and security audit.
- Separate environments: development, staging (where applicable), production.
- No production data used in development or testing.

## 6. Physical Safeguards

All infrastructure hosted in AWS data centers which maintain SOC 2 Type II, ISO 27001, and ISO 27017 certifications. Schoolpilot does not operate physical data centers.

## 7. Incident Response Plan

### 7.1 Detection and Reporting
Any employee, contractor, or external party who suspects a security incident must report it immediately to **security@school-pilot.net**.

### 7.2 Response Workflow
1. **Triage (0–4 hours)**: Security Officer assesses severity, scope, and potential data exposure.
2. **Containment (0–24 hours)**: Immediate actions to stop ongoing unauthorized access (key rotation, account lockout, etc.).
3. **Notification (within 72 hours of discovery)**: Affected schools notified via their designated data contact. Notification includes incident description, data types involved, estimated affected individuals, containment steps, and recommended protective actions.
4. **Investigation (30 days)**: Full root-cause analysis documented and shared with affected schools.
5. **Remediation**: Technical and process fixes implemented to prevent recurrence.
6. **Regulatory Reporting**: Schoolpilot cooperates with schools on FERPA and state-law notification obligations.

### 7.3 Severity Levels
| Level | Definition | Response |
|-------|-----------|----------|
| **Critical** | Confirmed PII exposure affecting 1+ students | Pager duty for Security Officer; 72-hour notification |
| **High** | Potential PII exposure, or confirmed exposure of non-PII credentials | Same-day triage; notify within 72 hours if PII confirmed |
| **Medium** | Vulnerability discovered with no confirmed exploitation | Remediate within 7 days |
| **Low** | Minor policy violation, no data impact | Remediate within 30 days |

## 8. Business Continuity and Disaster Recovery

- **Database backups**: AWS RDS automated daily snapshots with 7-day retention.
- **RTO (Recovery Time Objective)**: 4 hours for critical services.
- **RPO (Recovery Point Objective)**: 24 hours (maximum data loss window).
- **DR testing**: Annual restore-from-backup test documented.

## 9. Data Retention and Destruction

| Data Type | Retention | Destruction Method |
|-----------|-----------|--------------------|
| Screen captures | Max 24 hours (60–120 second Redis TTL) | TTL expiration (Redis) |
| Heartbeats / activity logs | Per school setting, default 30 days | Automated nightly purge job |
| Daily usage aggregates | Retained for school contract duration | Deleted on contract termination |
| Account data | Retained during active contract | Deleted within 30 days of termination |
| Audit logs | 2 years | Automated purge after retention period |

On contract termination, all school data is either returned to the school in export format or permanently destroyed within 30 days, per the school's written direction.

## 10. Compliance

Schoolpilot aligns with:
- **FERPA** (Family Educational Rights and Privacy Act, 20 U.S.C. § 1232g) — operates as a "school official" with legitimate educational interest under direct school control
- **COPPA** (Children's Online Privacy Protection Act) — relies on the school consent exception; no direct collection of data from children under 13
- **State data breach notification laws** in applicable jurisdictions
- **Student Data Privacy Consortium (SDPC)** model contract principles

## 11. Training

All personnel with access to customer data complete:
- Initial security and privacy training upon hire
- Annual refresher training
- Role-specific training (developers: secure coding; support: social engineering awareness)

## 12. Policy Review and Updates

This WISP is reviewed annually by the Security & Privacy Officer, and at any of the following trigger events:
- A material change in systems, data flows, or vendors
- A security incident of High or Critical severity
- A material change in applicable law or regulation
- Feedback from a customer audit or third-party certification assessment

Revision history is maintained in version control (Git).

---

## Contact

- **Security Incidents:** security@school-pilot.net
- **Privacy Inquiries:** privacy@school-pilot.net
- **General Support:** info@school-pilot.net

---

*This document is provided to customers and assessors upon request under NDA.*
