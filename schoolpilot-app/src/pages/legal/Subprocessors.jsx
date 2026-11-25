export default function Subprocessors() {
  return (
    <section id="service-providers" className="scroll-mt-8 mt-8">
        <h3 className="text-xl font-semibold text-slate-900 mb-4">8.1 Service Providers</h3>
        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot uses the following service providers and school-authorized integrations to
              operate enabled features. Providers that process personal information on our behalf are
              often called "subprocessors." A provider receives only the data involved in the features
              used by the school; some integrations also operate under the school's own provider arrangements.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              Vendor reviews and data-processing agreement confirmations remain in progress. Inclusion
              in this list does not confirm that a separately executed Data Processing Agreement has
              been verified for every provider. Schools may request current review status and applicable
              executed agreements under NDA, where executed and available.
            </p>
          </section>

          <section>
            <h4 className="text-lg font-semibold text-slate-900 mb-4">Infrastructure</h4>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Provider</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Data Processed</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Location</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Amazon Web Services</strong> (AWS)</td>
                    <td className="px-4 py-3 text-slate-700">Application hosting, database (RDS), storage (S3), content delivery (CloudFront), caching (ElastiCache / Redis)</td>
                    <td className="px-4 py-3 text-slate-700">Customer records, files, cached previews and operational data for enabled features</td>
                    <td className="px-4 py-3 text-slate-700">Primary database and file storage: United States (us-east-1). CloudFront uses global edge locations.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-slate-600 text-sm mt-2">
              AWS publishes SOC reports, ISO certifications and FedRAMP authorizations for{" "}
              <a href="https://aws.amazon.com/compliance/services-in-scope/" target="_blank" rel="noopener noreferrer" className="text-amber-600 hover:text-amber-700 underline">in-scope services</a>.
              These do not certify Schoolpilot. External providers have their own processing and
              retention terms; primary US hosting does not establish US-only processing by every provider.
            </p>
          </section>

          <section>
            <h4 className="text-lg font-semibold text-slate-900 mb-4">Authentication, Identity & Rostering</h4>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Provider</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Data Processed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Google LLC</strong> (OAuth, Workspace API, Classroom API)</td>
                    <td className="px-4 py-3 text-slate-700">Sign-in, school-authorized Workspace directory and Classroom imports; existing Gmail connections for separately authorized MailPilot</td>
                    <td className="px-4 py-3 text-slate-700">Account identifiers, email, names, roster/class membership and selected Classroom resources; existing Gmail connections may receive mailbox-change notifications while new email safety scans are paused</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Microsoft Corporation</strong> (Entra ID; only when enabled)</td>
                    <td className="px-4 py-3 text-slate-700">Optional staff sign-in, requiring production configuration and school-specific tenant authorization</td>
                    <td className="px-4 py-3 text-slate-700">Authentication exchange, tenant/account identifiers and email claim. Microsoft sign-in is not currently available in production.</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Clever, Inc.</strong> (Secure Sync; awaiting district validation)</td>
                    <td className="px-4 py-3 text-slate-700">School-authorized roster import; not generally available until district validation is complete</td>
                    <td className="px-4 py-3 text-slate-700">When connected: district, school, student/staff and class identifiers, names, emails, grades and enrollment records</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h4 className="text-lg font-semibold text-slate-900 mb-4">Email</h4>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Provider</th>
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
              Depending on enabled features, a ClassPilot safety alert or session summary can contain recipient
              addresses, student identity, page title, normalized domain, alert category, and activity/coverage,
              off-task, or safety-summary fields. MailPilot safety alerts can contain student identity, message
              sender, subject, and a bounded snippet. Schools control recipients and feature enablement.
            </p>
          </section>

          <section>
            <h4 className="text-lg font-semibold text-slate-900 mb-4">Payment Processing</h4>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Provider</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Data Processed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Stripe, Inc.</strong></td>
                    <td className="px-4 py-3 text-slate-700">Subscription billing and payment processing</td>
                    <td className="px-4 py-3 text-slate-700">School billing contact, subscription/invoice details, aggregate student counts and payment information handled by Stripe</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-slate-600 text-sm mt-2">
              Schoolpilot uses Stripe-hosted checkout and invoice payment pages to collect payment details.
              Schoolpilot receives billing and payment-status information; individual student records
              are not part of the billing integration.
            </p>
          </section>

          <section>
            <h4 className="text-lg font-semibold text-slate-900 mb-4">AI / Content Classification</h4>
            <div className="overflow-x-auto">
              <table className="w-full border border-slate-200 rounded-lg">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Provider</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Purpose</th>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-slate-700">Data Processed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Google LLC</strong> (Gemini API)</td>
                    <td className="px-4 py-3 text-slate-700">Browser classification with Gemini is paused pending legal approval.</td>
                    <td className="px-4 py-3 text-slate-700">ClassPilot does not currently send browsing URLs or page titles to Gemini. Previous requests could include URLs and titles containing personal information, search terms, or access tokens.</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 text-slate-700"><strong>Anthropic PBC</strong> (Claude API)</td>
                    <td className="px-4 py-3 text-slate-700">Anthropic processing is paused pending legal approval. Affected features are chat and text-poll safety enrichment, MailPilot scanning, the optional staff assistant, and My Desk paperwork and contact imports.</td>
                    <td className="px-4 py-3 text-slate-700">Before the pause, a chat or poll request could include up to 500 characters of matching text. A school-authorized MailPilot request could include direction, sender, recipients, subject and up to 4,000 characters of email text. The optional assistant is designed to use staff prompts, conversation history and authorized tool results. My Desk imports are designed to use staff-selected images or extracted text that may contain student names, conduct details, adult relationships, phone numbers or email addresses.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-slate-600 text-sm mt-2">
              No new requests go to Anthropic during the pause. ClassPilot's local chat and text-poll safety
              rules continue, and schools may review existing alerts. Anthropic's{" "}
              <a href="https://www.anthropic.com/legal/commercial-terms" target="_blank" rel="noopener noreferrer" className="text-amber-600 hover:text-amber-700 underline">
                Commercial Terms
              </a>{" "}
              and{" "}
              <a href="https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training" target="_blank" rel="noopener noreferrer" className="text-amber-600 hover:text-amber-700 underline">
                Privacy Center
              </a>{" "}
              explain Anthropic's training-use limits for customer API inputs and outputs. See our <a href="/ai-transparency" className="text-amber-600 hover:text-amber-700 underline">AI Transparency</a> page for full details.
            </p>
            <p className="text-slate-600 text-sm mt-2">
              My Desk AI imports are paused with My Desk and cannot be started in ClassPilot until
              further notice. When available, they require separate operational activation and an
              explicit author upload or saved-attachment selection.
              Provider account retention and access terms are reviewed before activation. Deleting
              Schoolpilot's temporary source files does not itself delete provider-retained data.
            </p>
          </section>

          <section>
            <h4 className="text-lg font-semibold text-slate-900 mb-4">Optional Error Monitoring</h4>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot's internal error monitor stores sanitized operational diagnostics within our
              AWS infrastructure. The optional <strong>Sentry</strong> integration is gated off pending
              its required agreement and activation review. If enabled, it sends allowlisted diagnostic
              messages, stack information and release/category metadata, with request bodies, cookies,
              headers and user objects excluded and bounded text redaction applied. Redaction is not
              a guarantee that every possible personal value will be detected.
            </p>
          </section>

          <section>
            <h4 className="text-lg font-semibold text-slate-900 mb-4">Notification of Provider Changes</h4>
            <p className="text-slate-700 leading-relaxed">
              Schoolpilot will provide notice to schools at least <strong>thirty (30) days</strong> before
              adding any new subprocessor that will process student personally identifiable information,
              unless such notice would be impractical due to emergency circumstances. Schools may object
              to a new subprocessor and request termination of their contract if the subprocessor creates
              unacceptable risk.
            </p>
          </section>

          <section>
            <h4 className="text-lg font-semibold text-slate-900 mb-4">Provider Questions</h4>
            <p className="text-slate-700 leading-relaxed">
              For current provider review status or available executed Data Processing Agreements
              (under NDA), contact <a href="mailto:privacy@school-pilot.net" className="text-amber-600 hover:text-amber-700 underline">privacy@school-pilot.net</a>.
            </p>
          </section>
        </div>
    </section>
  );
}
