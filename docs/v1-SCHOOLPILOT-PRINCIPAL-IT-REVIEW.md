# SchoolPilot Platform — Principal & IT Review

**Audience:** School Principals, IT Directors, and Technology Coordinators
**Prepared:** 2026
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
| Compliance posture | FERPA-compliant, COPPA-aware, SOC 2 readiness in progress (not certified — see §6) |
| Data retention | Configurable per school (default 30 days) |
| Pricing model | Per-student/year, no base fee: $3 (1 product) / $5 (2) / $7 (all 3); +$1 for 24/7 monitoring — see §9 |

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

**What the extension does NOT do:**
- It does not capture keystrokes, passwords, or form data.
- It does not record audio or video.
- It does not screenshot or record the student's screen.
- It does not run outside school hours unless the school explicitly enables after-hours mode in settings (off by default).
- It does not modify SSL/TLS, install root certificates, or perform any network-level interception.

**Extension footprint:** ~60 KB. No native binaries. No background CPU when no session is active.

### 2.4 Teacher Features

The teacher dashboard is the daily-driver UI. Designed to be glanceable during instruction, not a forensic console.

**Live class view:**
- All students currently signed in to the active class shown as cards with their current page title + favicon.
- Color-coding for on-task vs. off-task (AI classification, see §2.5).
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

**Off-task alerts:**
When the AI classifier (see §2.5) flags content as likely off-task during an active session, the teacher gets a non-blocking toast notification on the dashboard. The teacher can:
- Acknowledge and let it ride
- Send a quick "stay on task" message to the student
- Open the student's current page in a teacher-side tab to verify

**End-of-class email report:**
When a teacher ends a class session, an email is delivered to the teacher's school email address within a few minutes. The report includes:
- Class name, date, duration, students present
- Top 10 domains visited across the class
- Per-student top URLs (or a "no concerns" line)
- Any AI-flagged off-task content and the teacher's response
- A simple text "anything notable?" summary
- A CSV attachment for the teacher's records

**Goal of the email:** the teacher can review the class on their phone over coffee, not by logging into another portal. This is a frequent request from veteran teachers who are not going to add another dashboard to their day.

### 2.5 AI Off-Task Classification

Students' active URLs and page titles are classified by an LLM (Anthropic Claude Haiku) into:
- **On task** — relevant to the active assignment / class subject
- **Borderline** — gray area; logged but not surfaced
- **Off task** — clearly unrelated (games, social, video)
- **Concerning** — adult content, weapons content, self-harm signals

Only **off task** and **concerning** classifications trigger UI/teacher notifications. The classification is text-only; no page content is sent to the LLM beyond URL + page title + the teacher's stated class subject.

**Concerning content** triggers an immediate email to the school admin email and an audit log entry. The school admin can opt out of these emails in settings.

### 2.6 Schedule & Auto-Sessions

Each class can have an "auto-schedule" — block start / block end times. The system automatically:
- Starts a session at block start
- Ends a session at block end
- Skips weekends and holidays per the school timezone

Teachers can manually start and end sessions at any time within those boundaries. Outside the boundaries, sessions cannot be started (prevents accidental after-hours monitoring).

After-hours behavior is governed by a school-level **After Hours Mode** setting:
- `off` (default) — no monitoring outside scheduled tracking days/hours
- `limited` — heartbeats only, no classification, no email reports
- `full` — full monitoring continues

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
- AI safety emails on/off
- Retention period (default 720 hours = 30 days)
- IP allowlist (admin login)

### 3.5 Audit Logs

Every administrative action is logged with the actor, timestamp, role, action verb, and entity. Searchable and filterable from the admin panel. Retained as long as the database retention policy.

Examples of logged actions: login, logout, settings changes, user creation/deletion, student creation/deletion, role changes, session start/end, message send, lock/unlock, Flight Path applied.

### 3.6 Workspace Security Audit (Planned / On Roadmap — not in current release)

A planned admin tool that will connect (read-only) to the school's Google Workspace and produce a scorecard of the Chrome management policies that affect ClassPilot's effectiveness (sign-in restriction, guest mode, add-user, incognito, developer tools, extension force-install, browser sign-in) — each finding rated and deep-linked to the exact Admin Console page to fix it.

**Status:** the backend is built; the admin-panel UI and the two additional Google read-only scopes it needs are held until Google's verification of those scopes completes. It is **not exposed in the current release**. Until it ships, the same checks are documented as a plain-text checklist in §8 (Required Google Workspace Configuration) — a school's IT admin can walk through it directly in Admin Console in 10–15 minutes.

### 3.7 Email Monitoring Add-On (MailPilot)

Optional add-on. Monitors school-hosted Gmail mailboxes for safety signals (self-harm language, threats, bullying). Requires a separate one-time Workspace OAuth grant and is disabled by default. Not described in detail here; available on request.

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
- **Database:** RDS PostgreSQL with daily automated snapshots, 30-day retention, encryption at rest (AWS-managed KMS keys)
- **Cache / pub-sub:** ElastiCache Redis with TLS in transit, AUTH password, encryption at rest
- **Frontend hosting:** S3 with CloudFront CDN
- **TLS / HTTPS:** Application Load Balancer with ACM-managed certificates; HSTS enforced
- **DNS:** Route 53
- **Secrets:** Environment variables injected from the ECS task definition; production secrets never live in the source repository

### 5.2 Backup & Disaster Recovery

- **Database backups:** Automated daily snapshots, 30-day retention. Point-in-time recovery for the last 7 days.
- **Manual snapshots:** Created before any major release or migration.
- **RPO target:** 24 hours.
- **RTO target:** 4 hours from snapshot to fully restored environment.
- **Configuration as code:** Infrastructure changes are managed via repeatable scripts; a complete rebuild from snapshot has been rehearsed.

### 5.3 Native Mobile (Companion Products Only)

PassPilot and GoPilot are also available as native iOS / Android apps via Capacitor. ClassPilot remains web-only because Chromebook monitoring does not require a mobile companion. JWT credentials on mobile are stored in Keychain (iOS) and Keystore (Android), not in JavaScript-accessible storage.

---

## 6. Security & Compliance

### 6.1 Posture Summary

| Framework | Status |
|---|---|
| FERPA | Compliant; full posture documented |
| COPPA | Compliant for the schools-as-agent model; data-processing agreement available |
| SOC 2 Type I/II | **Readiness in progress; not certified.** Certification is deferred until revenue supports the audit cost (~$25K). Several technical controls are implemented and others remain in the SOC 2 remediation register. We can provide our Written Information Security Program (WISP), HECVAT Lite questionnaire, public subprocessor list, and readiness evidence summary. |
| NDPA / SDPC | Standard contract available |
| iKeepSafe | Not certified (cost-deferred) |

### 6.2 FERPA Compliance

ClassPilot operates under the "school official" exception to FERPA: the school is the data controller; SchoolPilot is the processor acting under the school's direction. Specifically:

- The school owns and controls all student data in the platform.
- SchoolPilot does not sell, advertise against, or share student data with any third party for marketing.
- All access to student records is role-gated; only the school's authorized staff can view their students.
- Every access to a student record by an admin or super-admin is audit-logged.
- A school can request bulk export or bulk deletion of all student data at any time and receive it within 30 days.
- Retention is configurable per school; the default of 30 days for activity records is well within FERPA's expectations.

### 6.3 COPPA Compliance

For users under 13, the platform relies on **school consent under COPPA's school exception** rather than parental consent for each student. This is the same model used by Google Workspace for Education, GoGuardian, Securely, and other school-deployed monitoring tools. Specifically:

- The school's terms of service with parents authorize the school to consent on behalf of parents to school-approved educational services.
- ClassPilot is configured as a school-approved service when the school signs SchoolPilot's Data Processing Agreement.
- No advertising, no profile-building, no cross-context tracking.
- The extension displays a disclosure indicator to students when a class session is active.

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
- Mobile JWT storage in OS-secured Keychain/Keystore

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
- Public subprocessors list at school-pilot.net/subprocessors (AWS, SendGrid, Stripe, Anthropic, OpenAI, Google)
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

**Verification status:** ClassPilot's OAuth client is **verified by Google.** Both brand verification and data-access (scope) verification are complete and shown in the Google Cloud Verification Center as approved. Users see Google's standard consent screen with no unverified-app warning.

**Scopes requested in the current release:** `classroom.courses.readonly`, `classroom.rosters.readonly`, `classroom.profile.emails`, `admin.directory.user.readonly`, `admin.directory.orgunit.readonly`, and standard `openid` / `userinfo` scopes — all verified. The two additional scopes for the planned Workspace Security Audit are **not requested today**; they will be submitted for Google's lightweight sensitive-scope review when that feature is re-enabled (CASA / third-party assessment is **not required** — both are classified as sensitive, not restricted).

**For IT directors:** all current ClassPilot flows are covered by the existing Google verification. There is no "unverified app" warning when an administrator connects their Workspace — they see the same standard consent screen they'd see for any verified third-party education app.

### 6.6 Privacy Posture (Plain English)

- We collect the **minimum** data needed to make the product work: student email, browsing during active class sessions, page titles, and URLs.
- We do not record keystrokes, passwords, screen content, or audio.
- We do not sell student data.
- We do not advertise to students.
- We do not profile students across schools or for marketing.
- We retain activity data for 30 days by default (configurable).
- We honor deletion requests within 30 days.
- We tell students when monitoring is active via an in-browser indicator.

### 6.7 Public Documents Available

These are linked from `school-pilot.net`:
- Privacy Policy
- Terms of Service
- Subprocessors list
- Security overview
- AI Transparency notice
- Data Processing Agreement (on request)
- WISP — Written Information Security Program (on request)
- HECVAT Lite (on request)

---

## 7. Companion Products (Brief)

These are mentioned for completeness; they are separate licensed products within the same SchoolPilot platform.

### 7.1 PassPilot

Digital hall-pass system. Teachers issue passes from a phone or web; students see their pass on the same Chromebook. Office staff and admin see live in/out status. Available as a native Android/iOS app via Capacitor.

### 7.2 GoPilot

Carpool / dismissal management. Parents queue from their car via a phone app; teachers see incoming arrivals and release students in order. Built for the after-school pickup window. Also Capacitor-native.

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
Chromebooks continue to function normally. The extension fails open — students can browse, and the teacher dashboard simply doesn't update until service is restored. No monitoring data is lost during a brief outage; the extension queues and reports on reconnection.

**Q: Can we self-host?**
Not currently. SchoolPilot is SaaS only.

**Q: Where is the data stored?**
AWS us-east-1 (Northern Virginia). Data does not leave US AWS regions.

**Q: Can we get a SOC 2 report?**
We have not yet undergone a SOC 2 audit. We can provide our WISP, HECVAT Lite questionnaire, public subprocessor list, remediation register summary, and readiness evidence package. SOC 2 Type I certification is on our roadmap.

**Q: How long are records retained?**
Default: 30 days for browsing activity, indefinitely for audit logs. Retention is configurable by your school admin. Deletion requests honored within 30 days.

**Q: What's the price?**
Per-school annual subscription, scaled by enrolled student count, no base fee:
- **1 product** (e.g., ClassPilot only): **$3 / student / year**
- **Any 2 products**: **$5 / student / year**
- **All 3 products** (ClassPilot + PassPilot + GoPilot): **$7 / student / year**
- Optional **24/7 monitoring add-on**: **+$1 / student / year**

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
