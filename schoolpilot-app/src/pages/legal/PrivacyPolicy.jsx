import { useEffect } from 'react';
import Subprocessors from './Subprocessors';

export default function PrivacyPolicy() {
  useEffect(() => {
    if (window.location.hash === '#service-providers') {
      document.getElementById('service-providers')?.scrollIntoView();
    }
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Navigation */}
      <nav className="bg-slate-900 border-b border-slate-800">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <a href="/" className="flex items-center gap-3 no-underline">
            <svg width="40" height="40" viewBox="0 0 64 64" fill="none">
              <rect width="64" height="64" rx="14" fill="#1e3a5f" />
              <path d="M16 24 L48 32 L16 40 L22 32 Z" fill="#fff" />
              <path d="M22 32 L48 32 L16 40 Z" fill="#eab308" />
            </svg>
            <span className="text-2xl font-bold text-white">Schoolpilot</span>
          </a>
          <a
            href="/"
            className="inline-flex items-center gap-2 text-white hover:bg-white/10 px-4 py-2 rounded-md transition-colors no-underline text-sm"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
            Back to Home
          </a>
        </div>
      </nav>

      {/* Content */}
      <div className="container mx-auto px-4 py-12 max-w-4xl">
        <h1 className="text-4xl font-bold text-slate-900 mb-8">Privacy Policy</h1>
        <p className="text-slate-600 mb-8">Last updated: November 9, 2026</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">1. Introduction</h2>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot ("we," "our," or "us") is committed to protecting the privacy of students, teachers,
              parents, and school administrators who use our school management platform. This Privacy Policy explains
              how we collect, use, disclose, and safeguard your information when you use our service, including
              ClassPilot (classroom monitoring), PassPilot (digital hall passes), and GoPilot (dismissal management).
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">2. Information We Collect</h2>

            <h3 className="text-xl font-medium text-slate-800 mb-3">2.1 Account Information</h3>
            <p className="text-slate-700 leading-relaxed mb-4">
              Schools or Schoolpilot provision accounts and student records. Depending on the sign-in method
              and integrations a school enables, we collect:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2 mb-4">
              <li>Name and email address supplied by the school or an authorized sign-in provider</li>
              <li>School affiliation</li>
              <li>Role and school permissions, including teacher, administrator, office staff, or student status; historical parent account records may also be retained</li>
              <li>Sign-in identifiers from Google, or from Microsoft Entra ID when enabled for the school, and a password hash for password-based accounts</li>
              <li>Profile picture (if provided by Google)</li>
            </ul>

            <h3 className="text-xl font-medium text-slate-800 mb-3">2.2 Classroom Data</h3>
            <p className="text-slate-700 leading-relaxed mb-4">
              To provide our monitoring and management services, we collect:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2 mb-4">
              <li>Google Classroom roster information (class names, student enrollments)</li>
              <li>Active-tab and open-tab activity, including tab URLs, titles, favicons, and timestamps during authorized monitoring</li>
              <li>Screen capture thumbnails for an authorized classroom, supervision, or administrator observation context, and separately authorized safety evidence captures, which may contain visible website content</li>
              <li>Student and teacher communications sent through ClassPilot</li>
              <li>For schools that separately enable MailPilot, student Gmail message headers and text for safety review, including sender, recipients, subject, and a bounded message excerpt in saved alerts</li>
              <li>Device connection status</li>
              <li>Hall pass records including destinations and timestamps (PassPilot)</li>
              <li>Staff-entered arrival, release, and dismissal records (GoPilot)</li>
              <li>Private notes, filing preferences, seating layouts, and attachments that authors saved in My Desk before it was paused. My Desk, including its AI paperwork and contact imports, is paused and not available in ClassPilot until further notice, so no new My Desk content is collected through ClassPilot while it is paused</li>
              <li>School discipline records explicitly submitted by a teacher before My Desk was paused, with selected evidence copies and correction/withdrawal history; these are separate from private notebook content</li>
            </ul>

            <h3 className="text-xl font-medium text-slate-800 mb-3">2.3 Technical Data</h3>
            <p className="text-slate-700 leading-relaxed">
              We automatically collect certain technical information including browser type, device information,
              IP address, and usage logs to maintain and improve our service.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              During an authorized managed-kiosk launch or managed shared-device sign-in flow, the ClassPilot
              extension may read and send the Chromebook directory identifier to Schoolpilot only after the
              server confirms support for that flow.
              Schoolpilot immediately converts it to school-scoped opaque identifiers. The raw directory identifier
              is not stored, logged, returned to the browser, or placed in a URL. The resulting continuity identifier
              does not replace student sign-in credentials or the kiosk PIN or signed-token authorization requirement.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">3. How We Use Your Information</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              We use the collected information to:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Provide real-time classroom monitoring capabilities to teachers</li>
              <li>Manage digital hall passes and record departures, destinations, and returns</li>
              <li>Facilitate safe and efficient school dismissal</li>
              <li>Sync classroom rosters from Google Classroom</li>
              <li>Display student screen previews within an authorized classroom, supervision, or administrator observation context</li>
              <li>Generate usage reports for teachers and administrators</li>
              <li>Classify monitored URL/domain signals and generate automated safety alerts for authorized human review</li>
              <li>During normal monitored browsing, request closure of a specific current tab for qualifying harmful-search or unsafe-page detections after authorization and target checks; after-hours safety-only collection remains reporting-only, and a sent closure request is not proof of client-confirmed closure</li>
              <li>Check student-authored ClassPilot chat and text poll responses with safety rules and, when AI enrichment is enabled and available, send matching text to Anthropic for severity assessment</li>
              <li>When a school separately enables MailPilot, review student Gmail text for potential safety concerns and provide alerts to authorized administrators</li>
              <li>My Desk (private notes, school discipline records, student contact profiles, seating charts, and AI-assisted paperwork and contact imports) is paused and not available in ClassPilot until further notice. No paperwork or contact documents can be submitted for AI extraction through ClassPilot while it is paused. My Desk content saved before the pause is retained and deleted as described in Section 4</li>
              <li>Maintain and improve our service</li>
              <li>Communicate important updates about the service</li>
              <li>Ensure compliance with school policies and legal requirements</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">4. Data Retention and Deletion</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Our retention policy limits data to the period needed to provide our services. The
              following periods include automated controls and school-directed policy commitments:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li><strong>Ordinary screen previews:</strong> An image retained for an authorized classroom, supervision, or administrator observation context is held for no more than 120 seconds and expires automatically; capture-health checks without an authorized preview context do not retain image pixels</li>
              <li><strong>Safety and evidence captures:</strong> Image content uses a separate deployment retention policy (30 days by default), after which the image is purged while bounded review metadata may remain</li>
              <li><strong>ClassPilot heartbeat history, the daily usage summaries derived from it (including Monitored Browser Time), and session-report detail:</strong> Uses the school's selected whole-number period from 1 through 365 days, default 30, and is purged or redacted by an hourly scheduled job</li>
              <li><strong>ClassPilot chat, poll and safety records:</strong> These use the school's activity-history retention period where applicable. Additional cleanup operates in counting mode until deletion is separately activated; counting expired records does not delete them. Open safety cases remain for administrator resolution; closed cases have a minimum 90-day retention period and may remain longer while linked evidence or other retention conditions apply. Records needed for pending delivery can also remain. Schools may request the current deletion mode and completion evidence</li>
              <li><strong>Hall pass records:</strong> Policy requires retention for the current school year for analytics</li>
              <li><strong>PassPilot pass rules (when a school turns them on):</strong> PassPilot rule denial records are kept for 400 days and then deleted automatically. Destination capacity, pass limits and encounter restrictions remain until an administrator deletes them or the school's data is destroyed under the executed agreement. A denial never records another student's identity</li>
              <li><strong>Dismissal records:</strong> Policy requires retention for the current school year for safety audits</li>
              <li><strong>MailPilot alerts and scan logs (when enabled):</strong> Reviewed email alerts and scan logs are purged after the deployment's retention period, default 90 days. Unreviewed email alerts remain for administrator resolution. Minimal safety-case provenance can remain under separate case-retention rules after email content is removed</li>
              <li><strong>My Desk private notes and approved attachments:</strong> Retained until author deletion or the agreed account-destruction process</li>
              <li><strong>Submitted school discipline records:</strong> Independent school-owned snapshots, selected evidence copies and version history remain under the executed agreement and verified school destruction process. Private-source deletion or staff departure does not erase them; correction and withdrawal preserve earlier versions. Abandoned evidence preparations expire after 24 hours and enter durable cleanup</li>
              <li><strong>My Desk AI paperwork imports (not available while My Desk is paused):</strong> Incomplete uploads expire after 24 hours, and review expires seven days after upload completion. Completion, cancellation, or expiry scrubs drafts and queues temporary source files for deletion. Minimal operational retry and cleanup records remain. Local deletion does not establish deletion of provider-retained data; reviewed provider/account terms apply</li>
              <li><strong>Reviewed contact profiles:</strong> Approved values and immutable version history remain school-owned under the executed agreement and verified destruction process. Contact import sources, previews and unapproved suggestions are temporary: unfinished uploads expire after 24 hours, review expires after seven days, and completion/cancellation/expiry queues durable cleanup. These sources are not retained as permanent student attachments</li>
              <li><strong>Account, audit, and teacher-downloaded files:</strong> Follow separate documented or contractual policies and are not governed by the ClassPilot heartbeat-retention setting</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              School-year retention for hall-pass and dismissal records is a policy commitment; an
              automatic school-year purge has not been verified. Schools may request the current
              deletion procedure and completion evidence.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              Schools may submit a verified deletion request at any time by contacting us at privacy@school-pilot.net.
              Current roster and school controls deactivate access and are not proof of permanent destruction.
            </p>
            <h3 className="text-xl font-medium text-slate-800 mb-3 mt-6">4.1 Data Return and Destruction on Contract Termination</h3>
            <p className="text-slate-700 leading-relaxed">
              Contract termination disables service access. Data return and the approved scope and timing of
              permanent destruction follow the executed agreement and a verified operator process. Schools may
              request an available export by contacting privacy@school-pilot.net. We provide written confirmation
              for the records included in a completed permanent-destruction operation; a soft-deleted account is
              not represented as proof that every linked record was destroyed.
            </p>
            <h3 className="text-xl font-medium text-slate-800 mb-3 mt-6">4.2 No Data Mining, No Advertising</h3>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot <strong>does not use student data for commercial purposes</strong>. Specifically,
              we will never: (a) use student PII for behavioral targeting, (b) use student PII to serve targeted
              advertisements, (c) build user profiles for non-educational purposes, (d) sell, rent, or lease
              student data to third parties, or (e) use student data to train third-party AI/ML models.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">5. FERPA Compliance</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Schoolpilot is designed to comply with the Family Educational Rights and Privacy Act (FERPA).
              We act as a "school official" under FERPA, meaning:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>We use education records only for legitimate educational purposes</li>
              <li>We are under direct control of the school regarding data use</li>
              <li>We do not sell or rent student information; service-provider processing must be limited to the school-authorized purposes and applicable data-protection requirements described in this policy</li>
              <li>We maintain appropriate security measures to protect student data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">6. COPPA Compliance</h2>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot may process student personal information, including information from children under
              13, only at the direction of a contracting school or district and for the educational purposes
              described in this policy. Student accounts are created and managed by schools. The school provides
              consent on behalf of parents where COPPA's school-consent exception applies and remains responsible
              for required notices and any additional consent required by its policies or applicable law. We do
              not use student information for advertising, behavioral profiling, or other commercial purposes.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">7. Data Security</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Our security measures include:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>TLS encryption for connections to the production service</li>
              <li>Encryption at rest for the production database and object storage</li>
              <li>Automated code, dependency, secret, and container vulnerability checks in our development workflows</li>
              <li>Role-based access controls</li>
              <li>Google sign-in and password-based authentication subject to school policy; the optional Microsoft sign-in integration is not currently available in production</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              Our <a href="/security" className="text-blue-600 underline">Security</a> page distinguishes
              implemented controls from planned assessments. Automated checks do not constitute an independent
              security audit or certification.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">8. Data Sharing</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              We do not sell, trade, or rent personal information. We may share data only:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>With authorized school personnel within your institution</li>
              <li>With service providers as needed to operate school-enabled features, subject to school-authorized purposes and applicable confidentiality and data-protection requirements</li>
              <li>When required by law or to protect rights and safety</li>
              <li>With your explicit consent</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              For ClassPilot browser classification, the URL and page title may be sent to Google's
              Gemini API during authorized monitoring, including configured after-hours safety monitoring.
              Student roster identities are not attached to that request, but URLs and titles can contain
              personal information, search terms, or access tokens. See our{" "}
              <a href="/ai-transparency" className="text-blue-600 underline">AI Transparency</a> page and{" "}
              <a href="#service-providers" className="text-blue-600 underline">Service Providers</a> section for the
              disclosed data flows. Schoolpilot's deletion of data does not itself delete provider-retained data.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              When a school separately enables MailPilot, Gmail message sender, recipient, subject, and text
              may be sent to Anthropic's API for safety classification. The optional staff assistant, when
              enabled, sends staff prompts, conversation history and authorized tool results to Anthropic.
              It is unavailable in the current app interface and its backend is disabled by default.
              My Desk paperwork and contact imports remain paused and unavailable. The section below
              describes the providers, data involved and agreement-review limitations.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              Separately from MailPilot and the assistant, ClassPilot student chat messages and text poll
              responses that match local safety rules may be sent to Anthropic for safety enrichment when
              that processing is enabled and available. Requests contain up to 500 characters of message
              text, which can itself contain personal information.
            </p>
            <Subprocessors />
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">9. Monitoring Limitations</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Schoolpilot is designed with student privacy in mind:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Monitoring follows the school's configured policy, which may permit full monitoring or limited safety monitoring outside designated school hours</li>
              <li>Students receive clear visual indicators when monitoring is active</li>
              <li>Teachers can monitor students only within their current authorized classroom or supervision context; class assignment alone does not grant active monitoring access</li>
              <li>Personal devices are not monitored outside of school-managed contexts</li>
              <li>In observation-lease mode, ambient screenshots are captured only while an authorized teacher or administrator is actively observing; an exact-bound safety capture may be requested separately</li>
              <li>For managed extensions using tracking-window leases, capture-health checks may continue without an open teacher dashboard while the student is authenticated and school tracking policy permits it. Previews are retained temporarily only for an authorized classroom, supervision, or administrator observation context; other capture-health checks retain non-image timing evidence and discard pixels. Separately authorized safety evidence follows its own retention rules</li>
              <li>Readable previews are bound to the current student's session and exact authorized context and revision; a prior context's preview cannot supply the current view</li>
              <li>During mixed-version rollout, a school may explicitly retain the legacy scheduled-screenshot mode for older managed extensions</li>
              <li>Live View streaming is retired and unavailable; authorized screenshot previews are a separate feature</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">10. Parental Rights: Access, Amendment, and Deletion</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              FERPA gives parents and eligible students the right to inspect and review education records and
              to seek amendment of records they believe are inaccurate, misleading, or violate the student's
              privacy rights. FERPA rights transfer to the student at age 18 or upon attendance at a postsecondary
              institution at any age. Requests to Schoolpilot, including requests for deletion under applicable
              law or school agreements, are coordinated through the school. We commit to the following response
              standards:
            </p>
            <h3 className="text-xl font-medium text-slate-800 mb-3">10.1 Right of Access (45-Day Response)</h3>
            <p className="text-slate-700 leading-relaxed mb-4">
              Upon a verified request from a school on behalf of a parent or eligible student, Schoolpilot will provide a complete
              copy of the student's records held in our platform within <strong>forty-five (45) days</strong> of
              the request. Records will be provided in a commonly readable format (CSV, PDF, or JSON).
            </p>
            <h3 className="text-xl font-medium text-slate-800 mb-3">10.2 Right to Amend / Correct</h3>
            <p className="text-slate-700 leading-relaxed mb-4">
              Parents or eligible students may request correction of inaccurate information. The school submits the correction request
              to privacy@school-pilot.net. We will correct verified inaccuracies within <strong>fifteen (15)
              business days</strong>. If a correction is declined by the school, the parent or eligible student retains the right to
              a hearing under FERPA; Schoolpilot will comply with any resulting school directive.
            </p>
            <h3 className="text-xl font-medium text-slate-800 mb-3">10.3 Right to Deletion</h3>
            <p className="text-slate-700 leading-relaxed mb-4">
              Parents or eligible students may request deletion of data not required for the school's legitimate educational interest.
              Schoolpilot verifies each school-submitted request, confirms the approved scope and applicable
              legal or contractual timeline, and provides completion evidence for records permanently destroyed.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              To exercise these rights, contact your school administrator or email us at privacy@school-pilot.net.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">11. Data Breach Notification</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Schoolpilot maintains an incident response program and commits to the following breach notification
              standards:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>
                <strong>Discovery to Initial Notification:</strong> Upon discovery of any unauthorized access,
                acquisition, or disclosure of student personally identifiable information, Schoolpilot will notify
                the affected school's designated data contact within <strong>seventy-two (72) hours</strong>.
              </li>
              <li>
                <strong>Notification Contents:</strong> The initial notice will include, to the extent known:
                (a) a description of the incident, (b) the types of information involved, (c) the approximate
                number of affected individuals, (d) steps taken to contain the incident, and (e) recommended
                protective actions.
              </li>
              <li>
                <strong>Follow-up Report:</strong> A detailed post-incident report will be provided to affected
                schools within <strong>thirty (30) days</strong>, including root cause analysis and remediation steps.
              </li>
              <li>
                <strong>Regulatory Notifications:</strong> Schoolpilot will cooperate with the school on any
                required state or federal notifications (including state data breach laws and FERPA).
              </li>
              <li>
                <strong>Cost of Notification:</strong> If the breach is caused by Schoolpilot's negligence,
                Schoolpilot will bear reasonable costs of required parent notifications.
              </li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              To report a suspected security incident, contact <strong>security@school-pilot.net</strong> immediately.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">12. Changes to This Policy</h2>
            <p className="text-slate-700 leading-relaxed">
              We may update this Privacy Policy from time to time. We will notify schools of significant
              changes via email and update the "Last updated" date at the top of this page. Continued use
              of our service after changes constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">13. Contact Us</h2>
            <p className="text-slate-700 leading-relaxed">
              If you have questions about this Privacy Policy or our data practices, please contact us:
            </p>
            <div className="mt-4 p-4 bg-slate-100 rounded-lg">
              <p className="text-slate-700">
                <strong>Email:</strong> privacy@school-pilot.net<br />
                <strong>Support:</strong> info@school-pilot.net
              </p>
            </div>
          </section>
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-slate-950 text-slate-400 py-8 mt-12">
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm">&copy; {new Date().getFullYear()} Schoolpilot. All rights reserved.</p>
          <div className="mt-4 space-x-4 text-sm">
            <a href="/privacy" className="hover:text-amber-400 transition-colors">Privacy Policy</a>
            <a href="/terms" className="hover:text-amber-400 transition-colors">Terms of Service</a>
            <a href="/" className="hover:text-amber-400 transition-colors">Home</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
