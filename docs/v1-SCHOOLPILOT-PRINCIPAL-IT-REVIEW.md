# SchoolPilot Platform — Principal & IT Review

**Audience:** School Principals, IT Directors, and Technology Coordinators
**Scope:** Version 1 principal and IT overview. Classroom activity rules, safety notifications, privacy and backup statements reviewed November 25, 2026. Check the current school agreement and product guides for the features approved for your school.
**Vendor:** SchoolPilot LLC (Ohio)
**Contact:** support@school-pilot.net

---

## 1. Executive Summary

SchoolPilot is a unified K–12 platform that bundles three classroom-management products under a single sign-on and a single privacy posture. This review focuses on **ClassPilot**, our Chromebook classroom-monitoring system. PassPilot (hall passes) and GoPilot (dismissal & carpool) are summarized briefly at the end.

ClassPilot is positioned as a **"GoGuardian / Securely Light"** alternative: it provides the everyday classroom-management capabilities teachers actually use — live tab visibility, off-task alerts, content blocking, hand raising, end-of-class reports — without the enterprise price tag or the heavy device-management footprint of larger vendors.

**Key facts at a glance:**

| Item | Value |
|---|---|
| Product type | Web app + Chrome MV3 extension |
| Target devices | Managed Chromebooks (90%+ of K-12 fleet) |
| Identity model | **Student email**, not device serial |
| Hosting | AWS (us-east-1) |
| Multi-tenancy | Hard school-domain isolation (every record scoped by `schoolId`) |
| School privacy and security | Confirm applicable FERPA and COPPA obligations with the school. SOC 2 readiness is in progress. See §6. |
| Data retention | Periods differ for browser activity, previews, safety evidence, records, and backups. See §6 and the [Privacy Policy](https://school-pilot.net/privacy). |
| Pricing model | Per-student/year, no base fee: $3 (1 product) / $5 (2) / $7 (all 3); +$1 for the optional extended monitoring window — see §9 |

---

## 2. ClassPilot — Student Monitoring System

### 2.1 What ClassPilot Is

ClassPilot is a teacher dashboard that shows, in real time, what websites the students in a given class are looking at, with one-click tools to refocus students who drift off task. It runs on the standard Chromebook environment that most schools already manage via Google Workspace.

It is **not** a deep packet inspector, a screen recorder, or a parental-control rootkit. It is a teacher-facing classroom-management tool that surfaces what the school's existing Google Workspace already records — but in a form a teacher can actually use during a 45-minute class.

### 2.2 Identity Model — Student-Email Based, Not Device-Based

This is the most important architectural decision in ClassPilot and worth understanding before any other detail:

**Students are identified by their school Google account, not by Chromebook serial number.**

This means:
- If a student moves to a different Chromebook (loaner, library cart, home device), they show up in the teacher's roster the moment they sign in.
- A Chromebook with no one signed in is not tracked.
- A student signing in with a **personal Gmail** is the loophole every school worries about — this is closed at the Google Workspace policy level (sign-in restriction); the required configuration is documented in §8.
- IT staff do not have to enroll devices individually into ClassPilot — they only need to push the ClassPilot extension via Google Workspace's standard force-install mechanism.

### 2.3 The Chrome Extension

The student-side component is a single Manifest V3 Chrome extension, deployed through the Chrome Web Store and force-installed via Google Workspace policy.

**What the extension does:**
- Reads the active tab URL and title via standard `tabs` and `activeTab` permissions.
- Reports the active URL to the teacher dashboard via an authenticated WebSocket connection.
- Receives "close this tab," "open this URL," "limit tabs," and "block this domain" commands from the teacher.
- Renders an in-tab notification overlay when the teacher sends a hand-raise response or a quick message.
- Shows a small disclosure badge during a class session so the student knows monitoring is active (privacy transparency).

**Student privacy and visibility**

ClassPilot reports authorized browser activity. School-approved features can show current tabs and titles, temporary screen previews, and staff-initiated live views or downloads. Certain safety events have a separate evidence process. URLs and page titles can contain information a student entered. The school should describe each approved feature, tracking window, and after-hours setting in its family notice. See the [Privacy Policy](https://school-pilot.net/privacy).

### 2.4 Teacher Features

The teacher dashboard is the daily-driver UI. Designed to be glanceable during instruction, not a forensic console.

**Live class view:**
- All students currently signed in to the active class shown as cards with their current page title + favicon.
- A fresh student tile can show an Off-Task badge when a local website rule or the school’s approved-site list flags the page. See §2.5.
- Click a student card to see tab history for the current session.

**FAB — Floating Action Buttons (the teacher↔student interaction layer):**

The FAB groups the live, two-way classroom-engagement features. Both messaging and hand raising can be turned off school-wide by the admin if the school does not want them enabled.

- **Message** — short two-way text between a teacher and a single student or the whole class. Pops up in the student's browser. *(Toggleable)*
- **Hand raising** — students raise a virtual hand from the extension; the teacher sees an ordered queue and can acknowledge or dismiss. *(Toggleable)*
- **Poll** — push a quick poll to the class (multiple choice or yes/no) and see results live as students respond.
- **Attention** — locks all student screens with a full-screen "look up — instructions" prompt. Used to interrupt the class for verbal instructions.
- **Timer** — start a countdown timer that appears on every student's screen (e.g., "10 minutes to finish the quiz").

**Class control toolbar (separate from FAB — these are the teacher's enforcement tools):**

- **Tabs** — view all open tabs across the class and close them individually or in bulk.
- **Lock screens** — lock the screen of a single student, a group, or the entire class.
- **Flight Path** — push a pre-built browsing scene to the class (allowed/blocked URL set). Similar concept to GoGuardian "Scenes": one click swaps the class into "test mode," "research mode," "free-read mode," etc. Flight Paths are configurable per school.
- **Block** — add a domain to the school or class blocklist immediately; takes effect within seconds.

**Off-task indicators and class summaries**

The teacher can review the active page in the context of the assignment, allow a site for the class, or contact the student using available classroom tools. When a class ends, eligible reports are queued for delivery. Coverage gaps, connectivity and email delivery can affect what staff receive. Refer to the [teacher guide](CLASSPILOT_TEACHER_GUIDE.md) for current controls.

### 2.5 Local website rules and safety alerts

ClassPilot uses built-in domain and search rules during authorized monitoring. Teachers may see an Off-Task badge for a known game. An approved lesson site can remain clear. An unfamiliar site can stay Unknown and can still be flagged if it falls outside an active school approved-site list. A badge describes observed browsing in context. The teacher determines whether that activity fits the assignment.

Qualifying safety concerns enter Safety Center. Email is queued for eligible active school administrators. A school with no eligible recipients can have a recorded alert and no queued email. Delivery can be delayed or fail. Staff acknowledgment is a separate action. The school designates a primary responder and backup, checks the roster when staff change, and uses its own emergency procedures when urgent help is needed.

ClassPilot reviews browser activity, chat and text polls using local rules. Unfamiliar pages can remain unclassified.

### 2.6 Schedule & Auto-Sessions

Each class can have an "auto-schedule" — block start / block end times. The system automatically:
- Starts a session at block start
- Ends a session at block end
- Skips weekends and holidays per the school timezone

Class sessions and school tracking hours are separate controls. Verify the configured local days, timezone and hours, whether tracking-hour limits are enabled, and what the school authorizes while no class is active.

- With tracking hours enabled, `off` restricts monitoring outside the configured window.
- `limited` can allow eligible after-hours safety reports. After-hours safety-related tab closure is disabled in this mode.
- `full` allows broader after-hours monitoring subject to the other controls. Each permitted use needs to be covered by the school’s authorization and notice.

This setting is auditable and changes are logged.

---

## 3. Admin Features

### 3.1 Student Roster — Three Import Paths

Schools can populate their student roster three ways, choose any combination:

| Method | Effort | When to use |
|---|---|---|
| **Google Workspace import** | One-click after OAuth | Most schools — fastest path |
| **Google Classroom sync** | Per-course | When teachers already use Classroom and want courses to mirror automatically |
| **CSV upload** | Bulk drag-and-drop | Schools that maintain rosters in a SIS that exports CSV |

**Google Workspace import (recommended for most schools):**
- Admin clicks "Import from Google Workspace"
- One-time OAuth consent screen (read-only access to user directory)
- Pick an Organizational Unit (e.g., "Students" or "Grade 8")
- Preview the list, deselect anyone who shouldn't be imported
- Click Import — done

**Google Classroom sync:**
- Per-course basis
- Imports student rosters, assigns grade level automatically
- Re-syncing is idempotent — running it twice does not duplicate students

**CSV upload:**
- Standard format: email, name, role, grade
- Drag-and-drop with a preview before commit
- Errors flagged per row, the rest proceeds

### 3.2 Staff Roster

Same three import paths for teachers and school admins. Staff can be assigned the role of `teacher`, `school_admin`, or `super_admin`. Role changes are audit-logged.

### 3.3 Classes & Groups

- Admin creates official class rosters (e.g., "7th Science P3") and assigns a teacher.
- Teachers can additionally create their own ad-hoc groups for small-group work.
- Co-teachers can be assigned to a primary teacher's class and inherit the same scheduling boundaries.

### 3.4 School-Wide Settings

Configurable from a single Settings page:
- School name, timezone, grade levels
- Tracking hours (e.g., 08:00–15:00) and tracking days
- After-hours mode
- Max tabs per student
- School-wide blocked / allowed domain lists
- Hand-raising on/off
- Student messaging on/off
- Review eligible active school administrators, notification status and the school response procedure.
- Configurable browser-activity retention. Other data categories follow separate schedules.
- IP allowlist (admin login)

### 3.5 Audit Logs

Every administrative action is logged with the actor, timestamp, role, action verb, and entity. Searchable and filterable from the admin panel. Retained as long as the database retention policy.

Examples of logged actions: login, logout, settings changes, user creation/deletion, student creation/deletion, role changes, session start/end, message send, lock/unlock, Flight Path applied.

### 3.6 Workspace Security Audit (Planned / On Roadmap — not in current release)

A planned admin tool that will connect (read-only) to the school's Google Workspace and produce a scorecard of the Chrome management policies that affect ClassPilot's effectiveness (sign-in restriction, guest mode, add-user, incognito, developer tools, extension force-install, browser sign-in) — each finding rated and deep-linked to the exact Admin Console page to fix it.

**Status:** the backend is built; the admin-panel UI and the two additional Google read-only scopes it needs are held until Google's verification of those scopes completes. It is **not exposed in the current release**. Until it ships, the same checks are documented as a plain-text checklist in §8 (Required Google Workspace Configuration) — a school's IT admin can walk through it directly in Admin Console in 10–15 minutes.

### 3.7 Email Monitoring Add-On (MailPilot)

MailPilot does not analyze new school Gmail messages. Authorized staff can review existing findings.

---

## 4. Multi-School Architecture & Isolation

ClassPilot is designed to host many schools on the same infrastructure with strict isolation. This matters for districts that consolidate technology vendors and for diocesan / charter networks.

### 4.1 Isolation Model

Every database table that contains school data has a `schoolId` column. Every authenticated request resolves a single school context from the user's membership. Every database query filters by that school context. There is no path through the API where one school's data is queryable by another school's user — including super-admin views, which require an explicit `schoolId` parameter.

**Isolation is enforced at three layers:**
1. **Authentication** — JWT / session establishes the user identity.
2. **School context middleware** — derives the active `schoolId` from the membership table.
3. **Storage layer** — every query helper accepts and enforces `schoolId`.

A wrong-school query throws a runtime error rather than silently returning the wrong rows.

### 4.2 Domain Scoping

Each school is associated with one or more email domains (e.g., `desalescincy.org`). Student email addresses must match one of the school's registered domains to be importable. This prevents a roster import from accidentally pulling in users from another tenant of the same Workspace.

### 4.3 Isolation Testing

The platform includes integration tests that, when run, attempt to cross school boundaries (read another school's students, sessions, settings, audit logs) and assert that every attempt is rejected with `403 Forbidden`. These tests run in CI on every push to main.

### 4.4 Scaling Architecture

The platform is hosted on AWS and designed to scale horizontally:

| Layer | Service | Scaling behavior |
|---|---|---|
| Compute (API + WS) | ECS Fargate | Auto-scales by CPU/memory; current production runs 2–6 tasks |
| Database | RDS PostgreSQL (Multi-AZ) | Vertical scaling + read replicas as needed; current `db.t4g.medium` |
| Realtime fan-out | ElastiCache Redis | Pub/sub for WebSocket broadcast across all API tasks |
| Static frontend | S3 + CloudFront | Globally distributed, near-zero scaling concerns |
| Load balancer | Application Load Balancer | Public HTTPS termination + sticky WebSocket routing |

Adding a new school is an O(1) operation — a single record in the `schools` table plus the school's admin user. There is no per-school deploy or per-school infrastructure.

Current capacity is comfortable for thousands of concurrent classrooms across hundreds of schools on the current instance sizes; the architecture is straightforward to scale further without re-platforming.

---

## 5. Infrastructure Overview

### 5.1 Production Environment

- **Region:** AWS `us-east-1` (Northern Virginia)
- **Compute:** ECS Fargate (containerized Node.js + Express)
- **Database:** The production RDS PostgreSQL instance reported encrypted storage and a 14-day automated-backup retention setting on November 25, 2026.
- **Cache / pub-sub:** ElastiCache Redis with TLS in transit, AUTH password, encryption at rest
- **Frontend hosting:** S3 with CloudFront CDN
- **TLS / HTTPS:** Application Load Balancer with ACM-managed certificates; HSTS enforced
- **DNS:** Route 53
- **Secrets:** Environment variables injected from the ECS task definition; production secrets never live in the source repository

### 5.2 Backup & Disaster Recovery

Automated backups on the production RDS instance have a 14-day retention setting, verified November 25, 2026. Manual snapshots, restored copies, exports and object storage have separate rules. Request dated restore-test evidence for recovery claims.

### 5.3 Native Mobile (Companion Products Only)

GoPilot is available as a staff-only Android app via Capacitor. ClassPilot remains web-only because Chromebook monitoring does not require a mobile companion. JWT credentials in GoPilot Android persist only in Keystore-backed secure storage and are held in JavaScript memory while the staff member is signed in; they are never persisted to plaintext preferences. This document makes no iOS availability claim.

---

## 6. Security & Compliance

### 6.1 Posture Summary

| Framework | Status |
|---|---|
| FERPA | For a covered school, document the authority for disclosure, direct school control and permitted use in the school agreement. |
| COPPA | For covered collection from children under 13, identify the operator notice, who may authorize each use, and any parental consent needed. |
| SOC 2 Type I/II | **Readiness in progress; not certified.** Certification is deferred until revenue supports the audit cost (~$25K). Several technical controls are implemented and others remain in the SOC 2 remediation register. We can provide our Written Information Security Program (WISP), HECVAT Lite questionnaire, public subprocessor list, and readiness evidence summary. |
| NDPA / SDPC | Review the district’s data privacy agreement and applicable state supplement. Only an executed agreement establishes terms for that school. |
| iKeepSafe | Not certified (cost-deferred) |

### 6.2 Student records and school control

A school that receives covered federal funding should identify a FERPA basis before disclosing personally identifiable education records. When relying on the school-official exception, document the educational purpose, legitimate educational interest, direct school control and limits on use and redisclosure. Authorize staff access for the relevant school and purpose. [US Department of Education guidance](https://studentprivacy.ed.gov/faq/which-educational-agencies-or-institutions-does-ferpa-apply)

### 6.3 Children under thirteen

School authorization under COPPA depends on the actual educational use. SchoolPilot must provide the school with direct notice of collection, use and disclosure when relying on school authorization. Identify all intended purposes and third parties and determine whether a parent must separately consent. The operator remains responsible for its own COPPA obligations. Record the school’s authorization and make the agreed family notice available. [FTC guidance for schools](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions)

### 6.4 SOC 2 Readiness Controls (Selected)

SchoolPilot is building and evidencing the control families a SOC 2 Type II audit would assess. We are not yet audited because the audit fee (~$25K) is deferred until revenue supports it. Some controls are automated, while human approvals, risk acceptances, vendor DPA confirmations, incident decisions, training attestations, and CPA audit work are tracked separately and require accountable human sign-off.

**Logical access (CC6):**
- Strong password requirements + bcrypt hashing
- JWT with short TTLs for session security
- Postgres-backed account lockout (10 failed attempts → 30 minute lockout)
- Role-based access control (`teacher`, `school_admin`, `super_admin`)
- Session-cookie hardening: `SameSite=Lax`, `Secure`, `HttpOnly`
- CSRF defense-in-depth middleware
- One-time code exchange for OAuth (eliminated JWT-in-URL leakage)
- Android JWT persistence in OS-secured Keystore-backed storage

**Change management (CC8) — every push to main runs:**
- CodeQL static analysis (SAST)
- Gitleaks secret scanning
- Trivy container vulnerability scanning
- npm audit gating
- TypeScript type checking
- Production build verification
- Dependabot for automatic dependency PRs

**Audit & monitoring (CC7):**
- Per-request audit logging for all state-changing actions
- Centralized log retention with timestamp + actor + action + entity
- Rule-based security monitor running every 5 minutes (failed-auth spikes, off-hours admin bursts, cross-school access attempts, bulk-export anomalies)
- Email alerts to admin on critical events

**Encryption (CC6, A1, C1):**
- TLS 1.2+ for all client-server traffic (ALB + ACM)
- RDS encryption at rest (AWS-managed KMS)
- Redis encryption at rest + TLS in transit
- S3 encryption at rest
- Google OAuth refresh tokens stored encrypted with AES-256-GCM in the database

**Availability (A1):**
- Multi-AZ RDS deployment
- ECS auto-scaling with minimum 2 tasks
- CloudFront caching layer in front of the static frontend
- Health checks at the ALB and ECS task layers

**Confidentiality (C1):**
- Network ACLs limit RDS to ECS task security group
- No public ingress to the database
- Secrets injected at runtime; never committed
- Production `.env` files are gitignored; secrets live in the ECS task definition

**Vendor management:**
- [Service Providers](https://school-pilot.net/privacy#service-providers) identifies current providers, school-authorized integrations and previous classification providers.
- Each subprocessor is selected for compliance posture (SOC 2 Type II or equivalent)

### 6.5 Google OAuth & Workspace Integration

ClassPilot integrates with Google Workspace using standard OAuth 2.0 with **read-only scopes**. This section addresses questions IT directors commonly ask about the OAuth consent screen and Google's app verification process.

**Scopes requested (all read-only):**

| Scope | Why ClassPilot needs it |
|---|---|
| `classroom.courses.readonly` | List your Google Classroom courses for roster sync |
| `classroom.rosters.readonly` | Read student lists in courses you select for import |
| `admin.directory.user.readonly` | One-click staff/student import from your Workspace directory |
| `admin.directory.orgunit.readonly` | Filter imports by Organizational Unit (e.g., "Grade 8") |

> The two additional read-only scopes for the planned Workspace Security Audit (`admin.directory.device.chromeos.readonly`, `chrome.management.policy.readonly`) are **not requested in the current release** — they are held until that feature ships and its Google scope verification completes.

**What ClassPilot does NOT request:**
- No write access to your directory (cannot create, delete, or modify users)
- No write access to your Chrome policies (cannot change any Workspace setting)
- No mail, drive, calendar, or document access
- No student or staff personal data beyond name, email, and OU path

**Token storage & lifecycle:**
- OAuth refresh tokens are stored encrypted (AES-256-GCM) in the database
- Admins can disconnect from the ClassPilot Settings page at any time
- Admins can also revoke access from their Google account at `myaccount.google.com/permissions`
- Refresh-token rotation follows Google's standard schedule

**Google sign-in and Workspace permissions.** Confirm the client, requested OAuth scopes and delegated administrator permissions in the school’s current Google Admin Console. Approving an OAuth scope grants access only to that service.

### 6.6 Privacy Posture (Plain English)

- School-configured monitoring may include student identifiers, page addresses, page titles and authorized previews. Local off-task flags and safety rules have limited coverage.
- SchoolPilot does not sell student data or use it for student advertising.
- For access, correction, return or deletion, use the school’s privacy contact or privacy@school-pilot.net. Identify the record categories, applicable agreement, time limits and who holds any downloaded copies. Deactivating an account removes access and can leave records in storage.
- Describe all approved features and monitoring periods to families. The [Privacy Policy](https://school-pilot.net/privacy) gives data-category and retention details.

### 6.7 Public Documents Available

These are linked from `school-pilot.net`:
- Privacy Policy
- Terms of Service
- Subprocessors list
- Security overview
- Data Processing Agreement (on request)
- WISP — Written Information Security Program (on request)
- HECVAT Lite (on request)

---

## 7. Companion Products (Brief)

These are mentioned for completeness; they are separate licensed products within the same SchoolPilot platform.

### 7.1 PassPilot

Digital hall-pass system. Teachers issue passes from a phone or web; students see their pass on the same Chromebook. Office staff and admin see live in/out status.

### 7.2 GoPilot

School-operated dismissal management. Administrators and office staff queue car riders by internal car number or direct student/family search, while teachers release assigned students in order. Bus and walker workflows share the live queue. A staff-only Android app is supported; there is no GoPilot parent portal or iOS availability claim.

Both share the same identity model, school isolation, audit logging, and infrastructure as ClassPilot.

---

## 8. Required Google Workspace Configuration

ClassPilot relies on standard Google Workspace policies that any K-12 Workspace admin can configure in 10–15 minutes. This section is the checklist your IT team should walk through before — or during — pilot. None of these settings are unusual; most schools running monitoring software (GoGuardian, Securely, Lightspeed) require the same configuration.

All paths below are in **Google Admin Console** at `admin.google.com`.

### 8.1 Required — for ClassPilot to function at all

These are the must-have settings. Without them, the extension either won't install or won't be able to monitor the right population of students.

**1. Force-install the ClassPilot Chrome extension**
- Admin Console → **Devices → Chrome → Apps & extensions → Users & browsers**
- Select the OU containing your students (e.g., "Students" or "Grade 6–12")
- Click **+** → **Add Chrome app or extension by ID** → enter the ClassPilot extension ID (we provide this on contract signature)
- Set **Installation policy** to **Force install**
- Why: this is how every student's Chromebook gets the extension automatically. Without this step, no monitoring happens.

**2. Restrict sign-in to your school domain**
- Admin Console → **Devices → Chrome → Settings → Device → Sign-in settings**
- Set **Sign-in restriction** to `*@yourschool.org` (use your actual domain)
- Why: prevents students from signing into school Chromebooks with personal Gmail accounts, which is the most common way to bypass monitoring.

**3. Disable Guest mode**
- Same page (Sign-in settings)
- Set **Guest mode** to **Disable guest mode**
- Why: "Browse as Guest" on the login screen is a one-click bypass of every monitoring policy, including ClassPilot.

**4. Disable "Add another user" at sign-in**
- Same page (Sign-in settings)
- Set **Show user names and photos on the sign-in screen** to your preferred value, but make sure **"Allow adding new users"** is **Off**
- Why: without this, students can add a new personal Google account at the login screen, bypassing your sign-in restriction.

### 8.2 Strongly Recommended — for a clean monitoring posture

These aren't strictly required but materially improve the signal-to-noise ratio of monitoring and close common student workarounds.

**5. Block Incognito mode for student users**
- Admin Console → **Devices → Chrome → Settings → Users & browsers → Security**
- Apply to the **Students** OU
- Set **Incognito mode** to **Disallow incognito mode**
- Why: Incognito tabs are invisible to the Chrome extension. Students who learn this can browse anywhere.

**6. Block developer tools for student users**
- Same page (Users & browsers)
- Apply to the **Students** OU
- Set **Developer tools** to **Never allow use of built-in developer tools**
- Why: tech-savvy students can use DevTools (F12) to disable extensions, modify pages, or open Incognito tabs through a hidden flag.

**7. Force browser sign-in**
- Same page (Users & browsers → Sign-in settings)
- Set **Browser sign-in settings** to **Force users to sign-in to use the browser**
- Why: prevents students from using Chrome without signing in (which sidesteps user-level policies).

### 8.3 OAuth Trust — for the ClassPilot web app

ClassPilot's admin web app uses Google Sign-In + Google Workspace integration. Most Workspace tenants accept verified third-party apps without additional configuration, but if your district uses **API access restrictions** (Admin Console → Security → API controls), you'll need to allowlist ClassPilot:

- Admin Console → **Security → Access and data control → API controls → Manage Third-Party App Access**
- Click **Add app** → search for "ClassPilot" or paste our OAuth client ID (we provide on contract signature)
- Set **Access** to **Trusted**
- Why: in restricted Workspace tenants, third-party apps are blocked by default until trusted. Marking ClassPilot trusted lets your admins connect Workspace for roster import and lets the platform read directory data.

### 8.4 Verification — confirm it's working

After completing 8.1, the IT admin can verify the setup with these checks:

| Check | How to verify | Expected result |
|---|---|---|
| Extension force-installed | Devices → Chrome → Apps & extensions → look at any student device | ClassPilot listed, "Force-installed" badge |
| Sign-in restricted | Open a school Chromebook → try to sign in with a personal Gmail | Rejected by Google with "this account isn't allowed" |
| Guest mode off | At the Chromebook login screen | No "Browse as Guest" button visible |
| Extension active | Sign in as a test student → wait 30 seconds | Student appears in the teacher dashboard at `/classpilot` |

**Estimated total IT setup time:** 10–15 minutes for sections 8.1 + 8.2, plus 2–3 minutes for 8.3 if needed. The hard part is identifying the right OU; the policy changes themselves take seconds.

---

## 9. Frequently Asked IT Questions

**Q: Does ClassPilot require us to manage devices in any new MDM?**
No. ClassPilot uses standard Google Workspace device management — specifically the same force-install policy you'd use for any approved Chrome extension. There is no separate enrollment, no separate console, no device certificates.

**Q: What permissions does the Chrome extension request?**
`tabs`, `activeTab`, `storage`, `notifications`, `alarms`, `idle`, `webNavigation`, `identity`, `identity.email`, `scripting`, `declarativeNetRequest`, `tabCapture`, `offscreen`. Host permission: `<all_urls>` (required to detect the active tab URL for class members). The `declarativeNetRequest` permission supports domain blocking; `tabCapture` + `offscreen` support the WebRTC plumbing for optional teacher-initiated live view; `identity` confirms the signed-in account matches a school student.

**Q: What about students using personal Gmail accounts on school Chromebooks?**
This is closed at the Google Workspace policy level — see §8 (Required Google Workspace Configuration) for the three settings IT needs to apply: sign-in restriction to your school domain, disable guest mode, and disable the "add user" button at sign-in. Setup takes ~5 minutes in Admin Console.

**Q: How do you handle multi-school districts?**
Each school is a fully isolated tenant — separate roster, separate settings, separate audit logs, separate billing if needed. A super-admin user can be granted visibility across multiple schools in a district for cross-school reporting.

**Q: What happens if your service is down?**
A service interruption can delay or interrupt teacher visibility, commands and reporting. Review actual monitoring coverage after reconnection and use the school’s usual supervision procedures during the gap.

**Q: Can we self-host?**
Not currently. SchoolPilot is SaaS only.

**Q: Where is the data stored?**
Core hosting is in AWS us-east-1. Review the [subprocessor list](https://school-pilot.net/subprocessors) and the executed school agreement for separate provider handling and geographic commitments.

**Q: Can we get a SOC 2 report?**
We have not yet undergone a SOC 2 audit. We can provide our WISP, HECVAT Lite questionnaire, public subprocessor list, remediation register summary, and readiness evidence package. SOC 2 Type I certification is on our roadmap.

**Q: How long are records retained?**
Retention differs by data category, school settings, agreement, applicable law and separately retained copies. Identify the requested data and verify its disposition, including backup expiry, before issuing any destruction certificate.

**Q: What's the price?**
Per-school annual subscription, scaled by enrolled student count, no base fee:
- **1 product** (e.g., ClassPilot only): **$3 / student / year**
- **Any 2 products**: **$5 / student / year**
- **All 3 products** (ClassPilot + PassPilot + GoPilot): **$7 / student / year**
- Optional extended monitoring window, **+$1 / student / year**. The school approves the hours and arranges its own response coverage.

Example: a 500-student school running ClassPilot = **$1,500 / year**. Contact `support@school-pilot.net` for volume or multi-year discounts.

---

## 10. Recommended Onboarding Path

If your school decides to adopt ClassPilot, the typical sequence is:

1. **Sign Data Processing Agreement** with SchoolPilot LLC (we provide).
2. **Create the school in ClassPilot** — single admin user, your school's email domain.
3. **Apply the required Workspace policies** (see §8) — force-install extension, restrict sign-in, disable guest mode, disable add-user.
4. **Import staff** (one-click from Workspace).
5. **Import students** (one-click from Workspace, or sync per Google Classroom course).
6. **Configure school settings** — tracking hours, after-hours mode, retention.
7. **Pilot with 1–2 teachers** for two weeks.
8. **Rollout to remaining staff.**

Typical time-to-pilot from contract signature: **under 30 minutes of IT effort.**

---

## 11. Contact

- **Sales / DPA / pricing:** support@school-pilot.net
- **Technical / IT integration:** support@school-pilot.net
- **Security / compliance questions:** support@school-pilot.net
- **Marketing site:** school-pilot.net
- **Status page:** (in progress)

---

*This document is intended for evaluation and procurement. It is not a contract. Specific service-level commitments, indemnities, and warranties are governed by the SchoolPilot Master Services Agreement and Data Processing Agreement.*
