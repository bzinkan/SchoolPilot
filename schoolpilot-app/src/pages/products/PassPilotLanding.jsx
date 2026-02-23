export default function PassPilotLanding() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-3 no-underline">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-md">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
                <rect x="9" y="3" width="6" height="4" rx="1"/>
                <path d="M9 14l2 2 4-4"/>
              </svg>
            </div>
            <span className="text-xl font-bold bg-gradient-to-r from-blue-600 to-blue-800 bg-clip-text text-transparent">
              PassPilot
            </span>
          </a>
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 transition-colors"
          >
            Sign In
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 py-24 text-center">
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6 text-slate-900">
          Digital Hall Pass Management
          <br />
          <span className="bg-gradient-to-r from-blue-600 to-blue-800 bg-clip-text text-transparent">
            for Schools
          </span>
        </h1>
        <p className="text-lg md:text-xl text-slate-500 max-w-2xl mx-auto mb-10">
          Track student movement safely and efficiently. Replace paper passes with a modern, real-time system that teachers and administrators love.
        </p>
        <div className="flex gap-4 justify-center flex-wrap">
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-6 py-3 text-base font-medium text-white shadow-lg hover:bg-blue-700 transition-colors"
          >
            Start Free Trial
          </a>
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-6 py-3 text-base font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            Sign In
          </a>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-4 pb-24">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
            }
            title="Real-Time Tracking"
            description="Monitor active passes with live countdowns. Know which students are out and for how long."
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <path d="M8 21h8M12 17v4"/>
              </svg>
            }
            title="Kiosk Mode"
            description="Set up a classroom kiosk for student self-checkout. Works with ID badges or manual lookup."
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            }
            title="Google Integration"
            description="Import students from Google Workspace or Classroom. Sign in with your school Google account."
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"/>
                <line x1="12" y1="20" x2="12" y2="4"/>
                <line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
            }
            title="Usage Analytics"
            description="View pass history and trends by student, class, or destination to identify patterns."
          />
        </div>
      </section>

      {/* How It Works */}
      <section className="bg-white py-20 border-t border-slate-100">
        <div className="max-w-4xl mx-auto px-4">
          <h2 className="text-3xl font-bold text-center text-slate-900 mb-12">How It Works</h2>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-2xl font-bold mx-auto mb-4">1</div>
              <h3 className="font-semibold text-slate-900 mb-2">Set Up Destinations</h3>
              <p className="text-sm text-slate-500">Add hallway destinations like bathroom, nurse, office. Set capacity limits for each.</p>
            </div>
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-2xl font-bold mx-auto mb-4">2</div>
              <h3 className="font-semibold text-slate-900 mb-2">Students Request Passes</h3>
              <p className="text-sm text-slate-500">Students tap to request. Teachers approve with one click from their dashboard or kiosk.</p>
            </div>
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-2xl font-bold mx-auto mb-4">3</div>
              <h3 className="font-semibold text-slate-900 mb-2">Monitor Movement</h3>
              <p className="text-sm text-slate-500">See who's out, where they're going, and how long they've been gone in real-time.</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-gradient-to-r from-blue-600 to-blue-800 text-white text-center">
        <div className="max-w-2xl mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">Ready to go paperless?</h2>
          <p className="text-lg opacity-90 mb-8">
            Start your free 30-day trial. No credit card required.
          </p>
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-md bg-white text-blue-700 px-8 py-4 text-lg font-semibold shadow-lg hover:bg-slate-50 transition-colors"
          >
            Start Free Trial →
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8 bg-white">
        <div className="max-w-6xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm text-slate-500">
            &copy; {new Date().getFullYear()} PassPilot. All rights reserved.
          </p>
          <div className="flex gap-6 text-sm">
            <a href="/privacy" className="text-slate-500 hover:text-blue-600 transition-colors">Privacy Policy</a>
            <a href="/terms" className="text-slate-500 hover:text-blue-600 transition-colors">Terms of Service</a>
            <a href="/" className="text-slate-500 hover:text-blue-600 transition-colors">Schoolpilot Home</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
      <div className="h-12 w-12 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 mb-4">
        {icon}
      </div>
      <h3 className="font-semibold text-slate-900 mb-2">{title}</h3>
      <p className="text-sm text-slate-500">{description}</p>
    </div>
  );
}
