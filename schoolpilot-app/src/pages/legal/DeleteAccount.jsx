export default function DeleteAccount() {
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
        <h1 className="text-4xl font-bold text-slate-900 mb-8">Delete Your Account</h1>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8">
          <h2 className="text-xl font-semibold text-slate-900 mb-4">Request Account Deletion</h2>
          <p className="text-slate-600 mb-6">
            If you would like to delete your SchoolPilot account and all associated data, please send an email to the address below. We will process your request within 30 days.
          </p>

          <div className="bg-slate-50 rounded-lg p-6 mb-6">
            <p className="text-sm text-slate-500 mb-1">Send your request to:</p>
            <a href="mailto:support@school-pilot.net?subject=Account%20Deletion%20Request" className="text-lg font-semibold text-blue-600 hover:text-blue-700">
              support@school-pilot.net
            </a>
            <p className="text-sm text-slate-500 mt-3">Please include the email address associated with your account in your request.</p>
          </div>

          <h3 className="text-lg font-semibold text-slate-900 mb-3">What happens when your account is deleted</h3>
          <ul className="space-y-2 text-slate-600">
            <li className="flex items-start gap-2">
              <span className="text-red-500 mt-1">&#x2022;</span>
              Your personal information (name, email) will be permanently removed
            </li>
            <li className="flex items-start gap-2">
              <span className="text-red-500 mt-1">&#x2022;</span>
              Your school memberships and role assignments will be deleted
            </li>
            <li className="flex items-start gap-2">
              <span className="text-red-500 mt-1">&#x2022;</span>
              Your dismissal history and check-in records will be anonymized
            </li>
            <li className="flex items-start gap-2">
              <span className="text-red-500 mt-1">&#x2022;</span>
              This action is permanent and cannot be undone
            </li>
          </ul>

          <div className="mt-8 pt-6 border-t border-slate-200">
            <p className="text-sm text-slate-500">
              If you have questions about your data, please review our{' '}
              <a href="/privacy" className="text-blue-600 hover:text-blue-700">Privacy Policy</a>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
