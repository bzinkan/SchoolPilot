export default function AITransparency() {
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
        <h1 className="text-4xl font-bold text-slate-900 mb-8">AI Transparency</h1>
        <p className="text-slate-600 mb-8">Last updated: November 25, 2026</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">External AI Processing Is Paused</h2>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot's use of external AI providers, including Google Gemini and Anthropic Claude,
              is paused pending legal approval. Schoolpilot sends no new requests to external AI providers.
              Google sign-in and school-authorized Workspace and Classroom connections continue.
              Teachers can still use classroom controls, chat and polls.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">How ClassPilot Reviews Browsing</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              During school-authorized monitoring, ClassPilot applies local website and search rules.
              These rules also apply to configured after-hours safety monitoring. An unfamiliar page can
              remain unclassified and appear as Unknown. The activity categories are:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-slate-700">
              <li><strong>Educational</strong> — Content related to learning, research, or school work</li>
              <li><strong>Non-educational</strong> — Activity classified as unrelated to school work (e.g., sports or entertainment)</li>
              <li><strong>Unknown</strong> — Activity that cannot be confidently categorized, including when classification is unavailable</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              Potential safety concerns are recorded separately from these categories. A category
              alone does not confirm or rule out a safety concern.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Previous Browser Classification Requests</h2>
            <p className="text-slate-700 leading-relaxed">
              Before the pause, ClassPilot could send the active URL and page title to Gemini with
              classification instructions. Those requests did not include separate roster identifiers,
              screenshots, page bodies, or full browsing histories. URLs and titles can themselves contain
              names, email addresses, search terms, or access tokens. Provider terms and account settings
              govern retention of data previously sent.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Safety Protections</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              A detected safety concern can create an alert in Safety Center and queue a notification
              to authorized school administrators. Repeated observations may be combined, and an
              administrator's exact-URL safety approval can suppress subsequent alerts for that URL.
            </p>
            <ul className="list-disc pl-6 space-y-2 text-slate-700">
              <li>Administrators review the concern and choose an appropriate response.</li>
              <li>Administrators can approve an exact URL for safety review or explicitly block a website.</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              During normal monitored browsing, qualifying harmful-search or unsafe-page detections
              can request automatic closure of the specific current tab after authorization and target
              checks. A sent request does not confirm that the Chromebook closed the tab. Missing or
              ambiguous targets do not become a request to close other tabs. After-hours safety-only
              collection is reporting-only and does not request tab closure. Safety detections do not
              automatically add website blocks; school website policies and authorized classroom
              restrictions are enforced separately. Notification delivery and staff review are not
              guaranteed to be immediate.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Teacher Controls</h2>
            <p className="text-slate-700 leading-relaxed">
              Teachers can use authorized classroom tools, including Flight Paths and opening a site
              for a student, to express that a site is relevant to a lesson. These teacher-intent
              exemptions affect off-task classification. They do not suppress safety alerts or override
              independent school website restrictions. Safety approvals are an administrator review action.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Student Chat and Poll Safety Review</h2>
            <p className="text-slate-700 leading-relaxed">
              ClassPilot checks student-authored chat messages and text poll responses with local safety
              rules. A rule match can still create an alert for school staff to review. Anthropic enrichment is
              paused. Before the pause, a request could include up to 500 characters of matching text
              to assess severity and explain the flag. Messages can contain names, email addresses or
              other personal information.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">MailPilot Email Safety Classification</h2>
            <p className="text-slate-700 leading-relaxed">
              MailPilot's external email safety scanning is paused. MailPilot does not analyze new Gmail
              messages or generate new scan alerts while the pause is in effect. Existing email alerts
              remain available for authorized administrator review under the usual retention rules.
              A school-authorized Gmail connection may remain in place.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              Before the pause, separately authorized MailPilot scanning could send Anthropic the
              message direction, sender, recipients, subject and up to 4,000 characters of message
              text. For flagged messages, Schoolpilot could save the sender, recipients, subject,
              an excerpt of up to 600 characters, and classification and review information.
              See our <a href="/privacy" className="text-blue-600 underline">Privacy Policy</a>.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Optional AI Assistant</h2>
            <p className="text-slate-700 leading-relaxed">
              The optional staff assistant is unavailable. It cannot generate replies or execute
              assistant-requested actions during the pause. Its design allows staff prompts,
              conversation history and authorized tool results to be included in requests to Anthropic.
              These can contain personal information. Tools are limited by role, product license and
              school. They omit attendance reasons and individual browsing history.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Third-Party AI Providers</h2>
            <p className="text-slate-700 leading-relaxed">
              For the terms applicable to previous browser-classification requests, see Google's{" "}
              <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                Gemini API Terms
              </a>. For Anthropic requests, the provider's{" "}
              <a href="https://www.anthropic.com/legal/commercial-terms" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                Commercial Terms
              </a>{" "}
              and{" "}
              <a href="https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                Privacy Center
              </a>{" "}
              describe the terms applicable to customer API data.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              Applicable provider/account settings and agreements determine provider retention, access,
              and training-use terms. Providers and agreement-review limitations are listed in the{" "}
              <a href="/privacy#service-providers" className="text-blue-600 underline">Service Providers section of our Privacy Policy</a>.
              Removing data from Schoolpilot does not itself delete a provider's
              retained copy. This page does not promise provider-side deletion or zero retention.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Teacher-Started Paperwork and Contact Imports</h2>
            <p className="text-slate-700 leading-relaxed">
              <strong>Paused:</strong> these imports are part of My Desk, which is paused and not available
              in ClassPilot until further notice. New paperwork and contact imports and external processing of pending imports are paused. The rest of this section explains how the imports work
              if the feature returns.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              When this separately controlled feature is available, a teacher or school administrator can
              deliberately upload paperwork or select a saved photo/PDF attachment for Anthropic-assisted
              extraction into their own private My Desk drafts. Selected page images may contain student
              names and conduct details. Note text, unselected files, school rosters and seating charts
              are not submitted, and existing notes are never scanned automatically. Student matching
              happens inside Schoolpilot, and uncertain matches require the author's selection.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              AI can misread names, dates, handwriting, or form boundaries. The author compares drafts
              with source images, corrects them, and explicitly approves every included entry before
              saving. The selected destination is clear: private notes stay author-only, while a
              reviewed Discipline logs import creates shared school incidents after explicit confirmation.
              AI extraction never publishes automatically or sends parent messages.
              Temporary source files and drafts are removed through the import cleanup process;
              approved notes and attachments follow notebook retention. Local removal does not
              establish deletion of provider-retained data. Provider/account terms and extraction
              quality must be reviewed before activation. A saved private note and selected evidence
              may also be explicitly copied to school discipline records; private note approval alone
              never shares it. School discipline evidence follows its separate school-record retention.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              A separately controlled contact-import workflow accepts PDF, photos, DOCX, XLSX and CSV.
              Staff select pages, sheets or text sections before sending their images or extracted text
              to Anthropic. These may include student names, adult relationships, phone numbers and
              email addresses. Current school profiles and rosters are not sent. Staff resolve uncertain
              student/adult matches and contact fields, then explicitly review and save shared profiles.
              Approved values and version history remain school-owned; original contact files, previews
              and unapproved suggestions are temporary and queued for deletion after completion,
              cancellation or expiry. Contact extraction requires its own provider, quality and capacity
              checks before activation. It does not change parent accounts or pickup permissions.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Questions</h2>
            <p className="text-slate-700 leading-relaxed">
              If you have questions about our use of AI or data practices, please contact us at{" "}
              <a href="mailto:support@school-pilot.net" className="text-blue-600 underline">
                support@school-pilot.net
              </a>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
