# HECVAT Lite Self-Assessment — Schoolpilot

**Vendor:** Schoolpilot LLC
**Product:** Schoolpilot (ClassPilot, PassPilot, GoPilot)
**Website:** https://school-pilot.net
**Assessment Date:** April 19, 2026
**Assessor:** Internal self-assessment
**Contact:** security@school-pilot.net

---

## How to Use This Document

This is a completed HECVAT Lite (Higher Education Community Vendor Assessment Toolkit) self-assessment provided to school districts and higher-ed institutions to support procurement and security review.

The HECVAT Lite is a subset of the full HECVAT created by EDUCAUSE and the REN-ISAC. It is the industry-standard security questionnaire for EdTech vendors. Schoolpilot provides this self-assessment to streamline procurement — contact security@school-pilot.net if you require the full HECVAT or additional documentation under NDA.

**Response legend:**
- **Yes** — Requirement is fully met
- **No** — Requirement is not currently met
- **N/A** — Not applicable to the product
- **Partial** — Partially met with explanatory note

---

## Section 1 — General / Company Profile

| # | Question | Response |
|---|----------|----------|
| 1.1 | Company legal name | Schoolpilot LLC (Ohio) |
| 1.2 | Year company founded | 2024 |
| 1.3 | Number of employees with access to production systems | 1-5 |
| 1.4 | Does the company maintain cyber liability insurance? | In progress |
| 1.5 | Will the product be used by end users under the age of 13? | Yes — COPPA "school consent" exception applies |
| 1.6 | Does the company have a designated privacy or security officer? | Yes — security@school-pilot.net |

---

## Section 2 — Policies and Program

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 2.1 | Written Information Security Program (WISP) in place? | **Yes** | See `docs/WISP.md` — reviewed annually and after material changes |
| 2.2 | Privacy Policy published publicly? | **Yes** | https://school-pilot.net/privacy |
| 2.3 | Acceptable Use Policy for employees? | **Yes** | Part of WISP Section 4.2 |
| 2.4 | Access control / least privilege policy? | **Yes** | RBAC enforced at application layer; WISP Section 4.1 |
| 2.5 | Data classification policy? | **Yes** | WISP Section 3: Restricted / Confidential / Public |
| 2.6 | Background checks on staff with data access? | **Yes** | Required before production access |
| 2.7 | Annual security training for staff? | **Yes** | WISP Section 11; completion attestations are human-signed and stored privately |

---

## Section 3 — Data Protection

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 3.1 | Data encrypted in transit? | **Yes** | TLS 1.2+, HSTS enforced (`max-age=31536000`) via Helmet |
| 3.2 | Data encrypted at rest? | **Yes** | AWS RDS encryption enabled, S3 SSE |
| 3.3 | Encryption algorithm(s) used? | **Yes** | AES-256 at rest (AWS), TLS 1.2+ ECDHE in transit |
| 3.4 | Key management process documented? | **Yes** | AWS KMS managed keys; rotation per AWS default |
| 3.5 | Role-based access control (RBAC)? | **Yes** | admin / school_admin / teacher / office_staff / parent / super_admin |
| 3.6 | Multi-factor authentication for privileged accounts? | **Partial** | Production AWS access uses MFA where available. In-app MFA for super_admin and school admin accounts is deferred and tracked in the SOC 2 remediation register. |
| 3.7 | Password complexity enforced? | **Yes** | 10+ characters, uppercase, lowercase, digit required |
| 3.8 | Account lockout after failed attempts? | **Yes** | 10 failures in 15 min → 30 min lockout (per-account, distributed-IP resistant) |
| 3.9 | Session management (secure cookies, expiry)? | **Yes** | httpOnly + secure + SameSite cookies; 7-day rolling for teachers/parents; 1-hour idle timeout for admin roles |
| 3.10 | Session fixation / CSRF protection? | **Yes** | CSRF tokens on state-changing requests |
| 3.11 | Data retention policy documented? | **Yes** | Privacy Policy Section 4 + WISP Section 9 |
| 3.12 | Data return/destruction on contract termination? | **Yes** | 30-day turnaround, returned in export format or permanently destroyed per school's written direction |

---

## Section 4 — Data Storage and Location

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 4.1 | Where is production data stored? | **Yes** | Amazon Web Services, us-east-1 (United States) |
| 4.2 | Is data stored outside the United States? | **No** | All production data stays in us-east-1 |
| 4.3 | Is data segregated from other customers? | **Yes** | Multi-tenant database with row-level `school_id` scoping enforced at application layer |
| 4.4 | Is customer data commingled with other customers? | **Partial** | Multi-tenant schema with per-row tenant isolation; physical DB shared, logical rows isolated |
| 4.5 | Backups encrypted? | **Yes** | RDS automated backups inherit encryption-at-rest |
| 4.6 | Backup retention period? | **Yes** | 7-day automated snapshots + on-demand manual snapshots |
| 4.7 | Data center certifications (SOC, ISO)? | **Yes** | AWS maintains SOC 1/2/3 Type II, ISO 27001, ISO 27017, ISO 27018, FedRAMP Moderate |

---

## Section 5 — Student Data and FERPA/COPPA

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 5.1 | Is the vendor a "school official" under FERPA? | **Yes** | Privacy Policy Section 5 |
| 5.2 | Under direct control of the school regarding data use? | **Yes** | Privacy Policy Section 5 |
| 5.3 | Student data used only for educational purposes? | **Yes** | Privacy Policy Section 4.2 — explicit no-data-mining clause |
| 5.4 | Student data used for advertising? | **No** | Explicitly prohibited in Privacy Policy Section 4.2 |
| 5.5 | Student data sold to third parties? | **No** | Explicitly prohibited in Privacy Policy Section 8 |
| 5.6 | Student data used to train AI/ML models? | **No** | Prohibited per Privacy Policy Section 4.2. AI subprocessor (Anthropic) contractually prohibits training on customer data. |
| 5.7 | COPPA compliance mechanism? | **Yes** | Relies on school consent exception (34 CFR § 99.31(a)(1)) |
| 5.8 | Parent right of access to student records? | **Yes** | 45-day response commitment in Privacy Policy Section 10 |
| 5.9 | Parent right to amend / correct records? | **Yes** | 15 business-day response in Privacy Policy Section 10.2 |
| 5.10 | Signed DPA / SDPA / NDPA available? | **Yes** | Terms Section 7 — incorporated by reference upon execution |
| 5.11 | Customer (school) owns all student data? | **Yes** | Explicit in Terms Section 7 |

---

## Section 6 — Authentication and SSO

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 6.1 | Does the product support SSO? | **Partial** | Google OAuth supported for teacher/admin login. SAML 2.0 on the roadmap. |
| 6.2 | Does the product support SAML 2.0? | **No** | Roadmap item — contact for ETA |
| 6.3 | Does the product support OAuth / OIDC? | **Yes** | Google OAuth for authentication |
| 6.4 | Does the product support ADFS? | **No** | SAML (future) will enable ADFS compatibility |
| 6.5 | Does the product support local authentication (username/password)? | **Yes** | bcrypt (12 rounds), complexity-enforced |
| 6.6 | Can local auth be disabled in favor of SSO? | **N/A** | Not yet — to be added with SAML support |

---

## Section 7 — Application Security

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 7.1 | Secure development lifecycle (SDLC) documented? | **Yes** | WISP Section 5.5: PR review, CI security audit, no prod data in dev |
| 7.2 | Code review on all changes? | **Yes** | PR-based review required before merge to main |
| 7.3 | Dependency vulnerability scanning? | **Yes** | `npm audit` runs on every CI build; critical-level blocks deploy |
| 7.4 | Static application security testing (SAST)? | **Partial** | TypeScript type checker + ESLint in CI; dedicated SAST tooling on roadmap |
| 7.5 | Dynamic application security testing (DAST)? | **No** | Planned with third-party pentest |
| 7.6 | Input validation framework? | **Yes** | Zod schema validation on all API inputs; Drizzle ORM parameterized queries prevent SQL injection |
| 7.7 | Content Security Policy (CSP) headers? | **Yes** | Helmet default CSP enabled |
| 7.8 | Rate limiting on authentication endpoints? | **Yes** | IP-based (15 attempts / 15 min) + per-account lockout (10 attempts → 30 min) |
| 7.9 | Third-party penetration test conducted? | **No** | Planned for next funding cycle |
| 7.10 | Published responsible disclosure / security contact? | **Yes** | https://school-pilot.net/security |

---

## Section 8 — Vulnerability and Incident Management

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 8.1 | Documented incident response plan? | **Yes** | WISP Section 7 — four severity levels, defined workflow |
| 8.2 | Customer breach notification timeline? | **Yes** | 72 hours from discovery (Privacy Policy Section 11) |
| 8.3 | 30-day follow-up report commitment? | **Yes** | WISP Section 7.2 |
| 8.4 | Regulatory notification cooperation? | **Yes** | WISP Section 7.2; assists with FERPA and state-law obligations |
| 8.5 | Active security monitoring? | **Yes** | Deterministic rule-based security monitor (`src/services/securityMonitor.ts`) runs every 5 min; detects failed-auth spikes, bulk writes, cross-school access, off-hours admin bursts; alerts to security@school-pilot.net |
| 8.6 | Audit logging of administrative actions? | **Yes** | `audit_logs` table captures user/role/action/entity/timestamp; 2-year retention per WISP |
| 8.7 | Log review process? | **Yes** | Security monitor alerts + periodic human review of `security_events` table |

---

## Section 9 — Business Continuity and Disaster Recovery

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 9.1 | Documented business continuity plan? | **Yes** | WISP Section 8 |
| 9.2 | Recovery Time Objective (RTO)? | **Yes** | 4 hours for critical services |
| 9.3 | Recovery Point Objective (RPO)? | **Yes** | 24 hours (daily automated RDS snapshots) |
| 9.4 | Annual DR test conducted? | **Yes** | Annual restore-from-backup drill (WISP Section 8) |
| 9.5 | Geographic redundancy? | **Partial** | Primary: AWS us-east-1 with Multi-AZ RDS option. Full multi-region DR planned. |

---

## Section 10 — Third-Party Subprocessors

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 10.1 | Public list of subprocessors available? | **Yes** | https://school-pilot.net/subprocessors |
| 10.2 | Subprocessors bound by data processing agreements? | **In review** | DPA confirmations are tracked in private vendor review evidence and require human sign-off before being treated as operating evidence. |
| 10.3 | Notice period before adding new subprocessors? | **Yes** | 30 days per Subprocessors page |
| 10.4 | Customer right to object to new subprocessors? | **Yes** | Customer may terminate if subprocessor creates unacceptable risk |

---

## Section 11 — Certifications and Attestations

| # | Question | Response | Notes |
|---|----------|----------|-------|
| 11.1 | SOC 2 Type II? | **No** | Planned for next funding cycle (12-month observation window) |
| 11.2 | ISO 27001? | **No** | AWS infrastructure certified; Schoolpilot itself not certified |
| 11.3 | iKeepSafe FERPA / COPPA? | **Pending** | Documentation package prepared; submission pending |
| 11.4 | 1EdTech TrustEd Apps? | **Planned** | Registration in progress |
| 11.5 | Common Sense Education Privacy Evaluation? | **Planned** | Submission in progress |
| 11.6 | State data privacy registrations (CA, TX, IL)? | **On request** | Signed NDPAs available for state-specific requirements |

---

## Appendix — Documents Available on Request

Under NDA, the following documents are provided to schools and qualified assessors:

- Full Written Information Security Program (WISP)
- Executed Data Processing Agreements with subprocessors
- Incident Response Runbook
- Penetration test reports (when available)
- SOC 2 Type II report (not available yet; when available)

**Contact:** privacy@school-pilot.net or security@school-pilot.net

---

## Known Gaps (Honest Disclosure)

The following items are not yet met and are documented in our security roadmap:

1. **SOC 2 Type II certification** — planned post-funding (cost: ~$20K, 12-month observation)
2. **Third-party penetration test** — planned post-funding (~$10-15K)
3. **In-app MFA for school admins and super_admins** — deferred and tracked in the SOC 2 remediation register
4. **SAML 2.0 SSO** — on roadmap (Google OAuth currently supported)
5. **Cyber liability insurance** — in procurement
6. **AWS WAF** — planned; currently relying on CloudFront + security-group filtering

We believe transparency about roadmap gaps is more valuable to assessors than marketing claims. Updated versions of this document will be maintained as items are addressed.
