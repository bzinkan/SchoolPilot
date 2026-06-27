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
        <p className="text-slate-600 mb-8">Last updated: June 27, 2026</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">AI-Powered Content Classification</h2>
            <p className="text-slate-700 leading-relaxed">
              SchoolPilot uses <strong>Anthropic's Claude API</strong> to support student-safety
              classification in ClassPilot and, when a school enables MailPilot, email safety
              classification. These features help schools identify unsafe content while keeping
              AI use limited to the specific safety workflows the school has enabled.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">How It Works</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              When a student visits a website on a monitored Chromebook during a class session, SchoolPilot
              may send the URL and page title to Anthropic's Claude API for classification. The AI determines
              whether the content is:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-slate-700">
              <li><strong>Educational</strong> — Content related to learning, research, or school work</li>
              <li><strong>Non-educational</strong> — Content that is not harmful but unrelated to school work (e.g., sports, entertainment)</li>
              <li><strong>Unsafe</strong> — Content that is inappropriate or harmful for students</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">What Data Is Sent</h2>
            <p className="text-slate-700 leading-relaxed">
              For ClassPilot website classification, only the <strong>URL and page title</strong> of the
              website being visited are sent to the AI service. No student names, personal information,
              full browsing history, or other personally identifiable information (PII) is included in that
              URL-classification request.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Safety Protections</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              When a website is classified as unsafe, the following actions are taken automatically:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-slate-700">
              <li>The tab is closed immediately on the student's device</li>
              <li>A safety alert is sent to the school administrator</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              Additionally, a curated list of known unsafe domains is maintained for instant blocking
              without needing AI classification.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Teacher Controls</h2>
            <p className="text-slate-700 leading-relaxed">
              Teachers have full control over their classroom. If a website is flagged as off-task but is
              relevant to the lesson, teachers can allow the domain through Flight Path (allowed sites list)
              or by opening the tab directly for the student. Teacher intent always takes priority over
              AI classification.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">MailPilot Email Safety Classification</h2>
            <p className="text-slate-700 leading-relaxed">
              If a school separately enables MailPilot email monitoring, SchoolPilot may use Anthropic's
              Claude API to classify student Gmail messages for safety concerns such as self-harm, violence,
              sexual content, drugs, or bullying. MailPilot is not enabled by default; it requires school
              authorization and operational setup. In that workflow, message text may be processed for
              safety classification, and SchoolPilot stores the resulting alert, severity, confidence, and
              review status for school safety staff.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Optional AI Assistant</h2>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot may offer an optional AI assistant for authorized school staff. This assistant is
              disabled by default and is enabled only after the school-facing data flow has been reviewed.
              When enabled, user prompts and authorized tool results may be processed by Anthropic to answer
              the request. Schoolpilot limits model-bound tool results by role, product license, and school,
              excludes sensitive fields such as attendance reasons and individual browsing history, and logs
              AI tool activity for audit review.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Third-Party AI Provider</h2>
            <p className="text-slate-700 leading-relaxed">
              Our AI classification workflows are powered by <strong>Anthropic</strong>, the maker of Claude.
              Anthropic's usage policies and privacy practices can be found at{" "}
              <a href="https://www.anthropic.com/policies" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                anthropic.com/policies
              </a>. SchoolPilot uses Anthropic's API. Anthropic's{" "}
              <a href="https://www.anthropic.com/legal/commercial-terms" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                Commercial Terms
              </a>{" "}
              and{" "}
              <a href="https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                Privacy Center
              </a>{" "}
              explain Anthropic's training-use limits for customer API inputs and outputs.
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
