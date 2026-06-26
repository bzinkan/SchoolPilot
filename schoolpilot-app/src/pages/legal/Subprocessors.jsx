export default function Subprocessors() {
  return (
    <div className="min-h-screen bg-slate-50">
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
          <a href="/" className="inline-flex items-center gap-2 text-white hover:bg-white/10 px-4 py-2 rounded-md transition-colors no-underline text-sm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
            Back to Home
          </a>
        </div>
      </nav>

      <div className="container mx-auto px-4 py-12 max-w-4xl">
        <h1 className="text-4xl font-bold text-slate-900 mb-4">Subprocessors</h1>
        <p className="text-slate-600 mb-8">Last updated: April 13, 2026</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot uses the following third-party service providers ("subprocessors") to operate
              the Service. Each subprocessor is bound by contractual obligations to handle data in
              accordance with applicable privacy laws, including FERPA and COPPA. All subprocessors handling
              student personally identifiable information (PII) have executed Data Processing Agreements
              with Schoolpilot.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Infrastructure</h2>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Subprocessor</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Data Processed</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Location</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Amazon Web Services</strong> (AWS)</td>
                    <td className="px-4 py-3 text-slate-700">Application hosting, database (RDS), storage (S3), content delivery (CloudFront), caching (ElastiCache / Redis)</td>
                    <td className="px-4 py-3 text-slate-700">All customer data</td>
                    <td className="px-4 py-3 text-slate-700">United States (us-east-1)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-slate-600 text-sm mt-2">
              AWS maintains SOC 1 / 2 / 3 Type II, ISO 27001, ISO 27017, ISO 27018, and FedRAMP certifications.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Authentication & Identity</h2>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Subprocessor</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Data Processed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Google LLC</strong> (OAuth, Workspace API, Classroom API)</td>
                    <td className="px-4 py-3 text-slate-700">Single sign-on, Workspace directory sync, Classroom roster import</td>
                    <td className="px-4 py-3 text-slate-700">Email, name, classroom membership</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Email</h2>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Subprocessor</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Data Processed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Twilio SendGrid</strong></td>
                    <td className="px-4 py-3 text-slate-700">Transactional email (welcome, password reset, session summaries, alerts)</td>
                    <td className="px-4 py-3 text-slate-700">Recipient email address, message content</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-slate-600 text-sm mt-2">
              No student PII is sent through email except in teacher-initiated session summary emails addressed
              to the teacher themselves, which may include aggregated student activity.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Payment Processing</h2>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Subprocessor</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Data Processed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Stripe, Inc.</strong></td>
                    <td className="px-4 py-3 text-slate-700">Subscription billing and payment processing</td>
                    <td className="px-4 py-3 text-slate-700">School billing contact, payment method (Stripe-tokenized)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-slate-600 text-sm mt-2">
              Stripe is PCI-DSS Level 1 certified. No payment card data touches Schoolpilot servers — Stripe
              Elements tokenizes card details on the client. No student PII is sent to Stripe.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">AI / Content Classification</h2>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Subprocessor</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Data Processed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Anthropic PBC</strong> (Claude API)</td>
                    <td className="px-4 py-3 text-slate-700">URL content classification for student safety; optional AI assistant when enabled for authorized school staff</td>
                    <td className="px-4 py-3 text-slate-700">URL strings and page titles for classification. For the optional assistant, staff prompts and authorized, minimized tool results may be processed.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-slate-600 text-sm mt-2">
              Anthropic's API terms contractually prohibit using customer data to train models. Schoolpilot
              sends only URL strings and page titles for classification. The optional AI assistant is disabled
              by default, limited by school role and product license, and designed to avoid model-bound
              sensitive fields such as attendance reasons and individual browsing history. See our <a href="/ai-transparency" className="text-amber-600 hover:text-amber-700 underline">AI Transparency</a> page for full details.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Notification of Changes</h2>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot will provide notice to schools at least <strong>thirty (30) days</strong> before
              adding any new subprocessor that will process student personally identifiable information,
              unless such notice would be impractical due to emergency circumstances. Schools may object
              to a new subprocessor and request termination of their contract if the subprocessor creates
              unacceptable risk.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Questions</h2>
            <p className="text-slate-700 leading-relaxed">
              For questions about our subprocessors or to request copies of executed Data Processing
              Agreements (under NDA), contact <a href="mailto:privacy@school-pilot.net" className="text-amber-600 hover:text-amber-700 underline">privacy@school-pilot.net</a>.
            </p>
          </section>
        </div>
      </div>

      <footer className="bg-slate-950 text-slate-400 py-8 mt-12">
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm">&copy; {new Date().getFullYear()} Schoolpilot. All rights reserved.</p>
          <div className="mt-4 space-x-4 text-sm">
            <a href="/privacy" className="hover:text-amber-400 transition-colors">Privacy Policy</a>
            <a href="/terms" className="hover:text-amber-400 transition-colors">Terms of Service</a>
            <a href="/subprocessors" className="hover:text-amber-400 transition-colors">Subprocessors</a>
            <a href="/" className="hover:text-amber-400 transition-colors">Home</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
