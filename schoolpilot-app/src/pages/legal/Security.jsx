export default function Security() {
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
        <h1 className="text-4xl font-bold text-slate-900 mb-4">Security at Schoolpilot</h1>
        <p className="text-slate-600 mb-8">Last updated: April 13, 2026</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <p className="text-slate-700 leading-relaxed">
              Security is foundational to Schoolpilot. We protect student data with administrative,
              technical, and physical safeguards in line with FERPA, COPPA, and state student data
              privacy laws. This page summarizes our security program and outlines how to report
              security issues.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Reporting a Security Vulnerability</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              We welcome reports of suspected security vulnerabilities from researchers, school IT
              staff, and the public. If you believe you have discovered a vulnerability in Schoolpilot
              or any of our products (ClassPilot, PassPilot, GoPilot), please report it promptly:
            </p>
            <div className="p-4 bg-slate-100 rounded-lg">
              <p className="text-slate-700 mb-2"><strong>Email:</strong> <a href="mailto:security@school-pilot.net" className="text-amber-600 hover:text-amber-700 underline">security@school-pilot.net</a></p>
              <p className="text-slate-700"><strong>Subject:</strong> [SECURITY] &lt;brief description&gt;</p>
            </div>
            <h3 className="text-xl font-medium text-slate-800 mb-3 mt-6">What to Include</h3>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>A description of the vulnerability and potential impact</li>
              <li>Steps to reproduce (including URLs, account types, and specific inputs if applicable)</li>
              <li>Any supporting screenshots, logs, or proof-of-concept code</li>
              <li>Your name and contact info (for follow-up and attribution, if you wish)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Our Commitment to Researchers</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              If you report a vulnerability to us in good faith and in accordance with this policy:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>We will acknowledge receipt within <strong>3 business days</strong></li>
              <li>We will provide a status update within <strong>10 business days</strong></li>
              <li>We will not pursue legal action or initiate law enforcement investigation against you</li>
              <li>We will credit you in our security advisory (if you wish) once the issue is resolved</li>
            </ul>
            <h3 className="text-xl font-medium text-slate-800 mb-3 mt-6">What We Ask in Return</h3>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Do not access, modify, or delete data belonging to other users</li>
              <li>Do not perform denial-of-service or brute-force testing against production systems</li>
              <li>Do not attempt to access student records beyond what's necessary to demonstrate the vulnerability</li>
              <li>Give us a reasonable time to investigate and patch before public disclosure (typically 90 days)</li>
              <li>Do not use social engineering against our employees, customers, or infrastructure providers</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Security Program Summary</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Schoolpilot maintains a documented Written Information Security Program (WISP) covering:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li><strong>Encryption in transit</strong> — TLS 1.2+ with HSTS enforced</li>
              <li><strong>Encryption at rest</strong> — AWS RDS (PostgreSQL) and S3 server-side encryption</li>
              <li><strong>Access control</strong> — Role-based access with least-privilege defaults</li>
              <li><strong>Authentication</strong> — bcrypt password hashing (12 rounds), session security with httpOnly + secure cookies, CSRF protection, account lockout after 10 failed attempts</li>
              <li><strong>Audit logging</strong> — Administrative actions logged to a dedicated audit trail</li>
              <li><strong>Vulnerability monitoring</strong> — Automated dependency scanning on every release, deterministic breach detection monitor running continuously</li>
              <li><strong>Incident response</strong> — Documented playbook with 72-hour customer notification SLA</li>
              <li><strong>Background checks</strong> — Required for all employees with access to production systems</li>
              <li><strong>Vendor management</strong> — Annual review of all subprocessors (see <a href="/subprocessors" className="text-amber-600 hover:text-amber-700 underline">Subprocessors</a>)</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              The full WISP is available to customers and qualified assessors under NDA. Contact
              <a href="mailto:security@school-pilot.net" className="text-amber-600 hover:text-amber-700 underline ml-1">security@school-pilot.net</a> to request a copy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Compliance</h2>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li><strong>FERPA</strong> — Operates as a "school official" with legitimate educational interest</li>
              <li><strong>COPPA</strong> — Relies on the school consent exception; no direct collection from children under 13</li>
              <li><strong>State data privacy laws</strong> — NDPA-compatible; honors state-specific notification requirements</li>
              <li><strong>Infrastructure certifications (via AWS)</strong> — SOC 2 Type II, ISO 27001, FedRAMP Moderate (AWS-maintained)</li>
            </ul>
          </section>

          <section className="bg-slate-100 p-6 rounded-lg border border-slate-200">
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">For School Procurement Teams</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              We streamline EdTech procurement by maintaining pre-completed assessment documents.
              Contact us to receive:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2 mb-4">
              <li>
                <strong>HECVAT Lite Self-Assessment</strong> — The EDUCAUSE-standard security questionnaire,
                pre-completed for your review
              </li>
              <li>
                <strong>Signed NDPA / SDPA / DPA</strong> — We honor the National Data Privacy Agreement
                (v1.0a and v2.0) and state-specific variants (California CSDPA, Texas TX-NDPA, Illinois SOPPA,
                New York Ed Law 2-d)
              </li>
              <li>
                <strong>Written Information Security Program</strong> (WISP) summary — under NDA
              </li>
              <li>
                <strong>Subprocessor list and vendor review/DPA status</strong> — see <a href="/subprocessors" className="text-amber-600 hover:text-amber-700 underline">public Subprocessors page</a>
              </li>
            </ul>
            <p className="text-slate-700 leading-relaxed">
              Request documents: <a href="mailto:privacy@school-pilot.net?subject=Procurement%20%E2%80%94%20Security%20Documents%20Request" className="text-amber-600 hover:text-amber-700 underline">privacy@school-pilot.net</a>
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Data Breach Notification</h2>
            <p className="text-slate-700 leading-relaxed">
              Upon discovery of any unauthorized access, acquisition, or disclosure of student personally
              identifiable information, Schoolpilot will notify affected schools within <strong>seventy-two
              (72) hours</strong>. A detailed follow-up report is provided within 30 days. Full breach
              notification terms are detailed in our <a href="/privacy" className="text-amber-600 hover:text-amber-700 underline">Privacy Policy</a>.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">Contact</h2>
            <div className="p-4 bg-slate-100 rounded-lg">
              <p className="text-slate-700">
                <strong>Security Incidents:</strong> <a href="mailto:security@school-pilot.net" className="text-amber-600 hover:text-amber-700 underline">security@school-pilot.net</a><br />
                <strong>Privacy Inquiries:</strong> <a href="mailto:privacy@school-pilot.net" className="text-amber-600 hover:text-amber-700 underline">privacy@school-pilot.net</a><br />
                <strong>General:</strong> <a href="mailto:hello@school-pilot.net" className="text-amber-600 hover:text-amber-700 underline">hello@school-pilot.net</a>
              </p>
            </div>
          </section>
        </div>
      </div>

      <footer className="bg-slate-950 text-slate-400 py-8 mt-12">
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm">&copy; {new Date().getFullYear()} Schoolpilot. All rights reserved.</p>
          <div className="mt-4 space-x-4 text-sm">
            <a href="/privacy" className="hover:text-amber-400 transition-colors">Privacy Policy</a>
            <a href="/terms" className="hover:text-amber-400 transition-colors">Terms of Service</a>
            <a href="/security" className="hover:text-amber-400 transition-colors">Security</a>
            <a href="/subprocessors" className="hover:text-amber-400 transition-colors">Subprocessors</a>
            <a href="/" className="hover:text-amber-400 transition-colors">Home</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
