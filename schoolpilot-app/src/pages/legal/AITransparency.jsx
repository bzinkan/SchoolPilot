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
        <p className="text-slate-600 mb-8">Last updated: April 2, 2025</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">AI-Powered Content Classification</h2>
            <p className="text-slate-700 leading-relaxed">
              SchoolPilot uses <strong>Anthropic's Claude API</strong> to power our AI content classification
              system within ClassPilot, our classroom monitoring product. This feature helps keep students safe
              online by analyzing website content in real time.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">How It Works</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              When a student visits a website on a monitored Chromebook during a class session, the URL is sent to
              Anthropic's Claude API for classification. The AI determines whether the content is:
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
              Only the <strong>URL and page title</strong> of the website being visited are sent to the AI service
              for classification. No student names, personal information, browsing history, or any other
              personally identifiable information (PII) is transmitted to Anthropic. The classification is
              performed on a per-URL basis and results are not stored by the AI provider.
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
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Third-Party AI Provider</h2>
            <p className="text-slate-700 leading-relaxed">
              Our AI classification is powered by <strong>Anthropic</strong>, the maker of Claude.
              Anthropic's usage policies and privacy practices can be found at{" "}
              <a href="https://www.anthropic.com/policies" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                anthropic.com/policies
              </a>.
              SchoolPilot uses Anthropic's API, which does not use customer data for model training.
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
