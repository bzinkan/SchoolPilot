import SecurityPostureList from './SecurityPostureList';
import { SECURITY_PAGES_UPDATED } from './securityPosture';

const linkClass = 'text-amber-600 hover:text-amber-700 underline';

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
        <p className="text-slate-600 mb-8">Last updated: {SECURITY_PAGES_UPDATED}</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <p className="text-slate-700 leading-relaxed">
              Security is foundational to Schoolpilot. We protect student data with administrative,
              technical, and physical safeguards in line with FERPA, COPPA, and state student data
              privacy laws. This page summarizes our security program and outlines how to report
              security issues.
            </p>
          </section>

          <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="font-semibold text-slate-900 mb-2">For procurement teams</p>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <a href="/security/summary" className={linkClass}>One-page summary (PDF)</a>
              <a href="/security/hecvat-lite" className={linkClass}>HECVAT Lite self-assessment</a>
              <a href="/subprocessors" className={linkClass}>Subprocessors</a>
              <a href="/privacy" className={linkClass}>Privacy Policy</a>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-2">Security and Privacy at a Glance</h2>
            <p className="text-slate-700 leading-relaxed mb-6">
              Where each safeguard stands today. Items marked <strong>Planned</strong> are on our roadmap
              and are not yet available; <strong>Partial</strong> items are described in the note beside them.
            </p>
            <SecurityPostureList />
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

          <section className="bg-slate-100 p-6 rounded-lg border border-slate-200">
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">For School Procurement Teams</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              We streamline EdTech procurement by publishing pre-completed assessment documents:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2 mb-4">
              <li>
                <strong>One-page security and privacy summary</strong> — <a href="/security/summary" className={linkClass}>view or save as PDF</a>
              </li>
              <li>
                <strong>HECVAT Lite Self-Assessment</strong> — The EDUCAUSE-standard security questionnaire,
                pre-completed and <a href="/security/hecvat-lite" className={linkClass}>published for your review</a>
              </li>
              <li>
                <strong>Subprocessor list and vendor review/DPA status</strong> — see <a href="/subprocessors" className={linkClass}>public Subprocessors page</a>
              </li>
            </ul>
            <p className="text-slate-700 leading-relaxed mb-4">Available on request:</p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2 mb-4">
              <li>
                <strong>Signed NDPA / SDPA / DPA</strong> — We honor the National Data Privacy Agreement
                (v1.0a and v2.0) and state-specific variants (California CSDPA, Texas TX-NDPA, Illinois SOPPA,
                New York Ed Law 2-d)
              </li>
              <li>
                <strong>Written Information Security Program</strong> (WISP) — under NDA
              </li>
            </ul>
            <p className="text-slate-700 leading-relaxed">
              Request documents: <a href="mailto:privacy@school-pilot.net?subject=Procurement%20%E2%80%94%20Security%20Documents%20Request" className={linkClass}>privacy@school-pilot.net</a>
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
