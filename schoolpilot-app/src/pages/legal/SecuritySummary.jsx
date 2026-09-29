import { useEffect } from 'react';
import SecurityPostureList from './SecurityPostureList';
import { SECURITY_PAGES_UPDATED } from './securityPosture';

const PRINT_STYLES = `
@page { size: letter; margin: 0.4in; }
@media print { html, body { background: #fff !important; } }
.sp-print-exact { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`;

export default function SecuritySummary() {
  useEffect(() => {
    const previousTitle = document.title;
    // Browsers use the title as the default "Save as PDF" file name.
    document.title = 'Schoolpilot Security and Privacy Summary';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 print:bg-white print:p-0">
      <style>{PRINT_STYLES}</style>

      <div className="mx-auto mb-4 flex max-w-[8.5in] items-center justify-between gap-4 print:hidden">
        <a href="/security" className="text-sm text-slate-600 hover:text-slate-900">
          ← Back to Security
        </a>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          Print or save as PDF
        </button>
      </div>

      <main className="sp-print-exact mx-auto max-w-[8.5in] bg-white p-6 text-slate-800 shadow-sm sm:p-8 print:max-w-none print:p-0 print:shadow-none">
        <header className="mb-3 flex flex-col gap-2 border-b-2 border-slate-900 pb-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex items-center gap-3">
            <svg className="shrink-0" width="32" height="32" viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <rect width="64" height="64" rx="14" fill="#1e3a5f" />
              <path d="M16 24 L48 32 L16 40 L22 32 Z" fill="#fff" />
              <path d="M22 32 L48 32 L16 40 Z" fill="#eab308" />
            </svg>
            <div>
              <h1 className="text-lg font-bold leading-tight text-slate-900">Security and Privacy Summary</h1>
              <p className="text-[11px] text-slate-600">
                Schoolpilot LLC (Ohio) · ClassPilot, PassPilot and GoPilot for K-12 schools
              </p>
            </div>
          </div>
          <p className="shrink-0 text-[10px] text-slate-500 sm:text-right">
            Updated {SECURITY_PAGES_UPDATED}
            <br />
            school-pilot.net/security
          </p>
        </header>

        <SecurityPostureList dense />

        <footer className="mt-1 border-t border-slate-200 pt-2 text-[10px] leading-relaxed text-slate-600">
          <p>
            <strong className="text-slate-800">Documents:</strong> full HECVAT Lite at
            school-pilot.net/security/hecvat-lite · subprocessors at school-pilot.net/subprocessors ·
            privacy policy at school-pilot.net/privacy · WISP under NDA · NDPA and state DPAs signed on request.
          </p>
          <p>
            <strong className="text-slate-800">Contacts:</strong> security@school-pilot.net (security and incidents) ·
            privacy@school-pilot.net (privacy, DPAs, documents) · hello@school-pilot.net (general)
          </p>
        </footer>
      </main>
    </div>
  );
}
