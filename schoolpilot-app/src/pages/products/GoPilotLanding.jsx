export default function GoPilotLanding() {
  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="bg-gradient-to-br from-indigo-600 to-purple-700 text-white min-h-screen flex items-center relative overflow-hidden">
        <div className="absolute inset-0 bg-black/10" />
        <div className="container mx-auto px-4 py-16 relative z-10">
          <div className="max-w-3xl mx-auto text-center">
            <div className="mb-8">
              <div className="w-16 h-16 bg-white rounded-xl flex items-center justify-center mx-auto mb-6">
                {/* Car icon */}
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 16H9m10 0h3v-3.15a1 1 0 0 0-.84-.99L16 11l-2.7-3.6a1 1 0 0 0-.8-.4H5.24a2 2 0 0 0-1.8 1.1l-.8 1.63A6 6 0 0 0 2 12.42V16h2"/>
                  <circle cx="6.5" cy="16.5" r="2.5"/>
                  <circle cx="16.5" cy="16.5" r="2.5"/>
                </svg>
              </div>
              <h1 className="text-4xl md:text-6xl font-bold mb-6">
                GoPilot
              </h1>
              <p className="text-xl md:text-2xl mb-8 opacity-90">
                School Dismissal, Made Safe & Simple
              </p>
              <p className="text-lg mb-12 opacity-80 max-w-2xl mx-auto">
                Real-time parent check-in, instant teacher notifications, and verified pickups.
                Streamline your car line while keeping every student safe.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-12">
              <a
                href="/get-started"
                className="bg-white text-indigo-600 px-8 py-4 rounded-lg font-semibold hover:bg-gray-50 transition duration-200 shadow-lg text-center no-underline"
              >
                Get Started
              </a>
              <a
                href="/get-started"
                className="bg-transparent border-2 border-white text-white px-8 py-4 rounded-lg font-semibold hover:bg-white hover:text-indigo-600 transition duration-200 text-center no-underline"
              >
                Log In
              </a>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
              <div className="bg-white/10 backdrop-blur-sm rounded-lg p-6">
                {/* Clock icon */}
                <svg className="w-8 h-8 mx-auto mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <polyline points="12 6 12 12 16 14"/>
                </svg>
                <h3 className="font-semibold mb-2">Real-Time Tracking</h3>
                <p className="text-sm opacity-80">Know exactly when parents arrive and where every student is</p>
              </div>
              <div className="bg-white/10 backdrop-blur-sm rounded-lg p-6">
                {/* Shield icon */}
                <svg className="w-8 h-8 mx-auto mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                <h3 className="font-semibold mb-2">Verified Pickups</h3>
                <p className="text-sm opacity-80">Authorized pickup lists and custody alert flags for every student</p>
              </div>
              <div className="bg-white/10 backdrop-blur-sm rounded-lg p-6">
                {/* Bell icon */}
                <svg className="w-8 h-8 mx-auto mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                <h3 className="font-semibold mb-2">Instant Alerts</h3>
                <p className="text-sm opacity-80">Teachers notified the moment a parent checks in</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 bg-white">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6">
              Everything You Need for Safe Dismissals
            </h2>
            <p className="text-lg text-gray-500 max-w-3xl mx-auto">
              GoPilot connects parents, teachers, and office staff in real-time
              to make dismissal smooth and secure.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {[
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                    <path d="M12 18h.01"/>
                  </svg>
                ),
                title: 'Multiple Check-in Methods',
                description: 'Parents choose: app tap, SMS text, or QR code. Whatever works best for your families.',
                color: 'bg-indigo-500',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                ),
                title: 'Instant Teacher Alerts',
                description: 'Teachers get notified the moment a parent arrives. One tap to dismiss the student.',
                color: 'bg-green-500',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                ),
                title: 'Verified Pickups',
                description: 'Authorized pickup lists, photo ID matching, and custody alert flags.',
                color: 'bg-red-500',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                ),
                title: 'Real-time Queue',
                description: 'Parents see their position and wait time. No more guessing or endless car lines.',
                color: 'bg-yellow-500',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 6v6"/>
                    <path d="M15 6v6"/>
                    <path d="M2 12h19.6"/>
                    <path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/>
                    <circle cx="7" cy="18" r="2"/>
                    <path d="M9 18h5"/>
                    <circle cx="16" cy="18" r="2"/>
                  </svg>
                ),
                title: 'Bus & Walker Support',
                description: 'Not just car riders. Manage all dismissal types from one dashboard.',
                color: 'bg-blue-500',
              },
              {
                icon: (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 16H9m10 0h3v-3.15a1 1 0 0 0-.84-.99L16 11l-2.7-3.6a1 1 0 0 0-.8-.4H5.24a2 2 0 0 0-1.8 1.1l-.8 1.63A6 6 0 0 0 2 12.42V16h2"/>
                    <circle cx="6.5" cy="16.5" r="2.5"/>
                    <circle cx="16.5" cy="16.5" r="2.5"/>
                  </svg>
                ),
                title: 'Google Workspace Integration',
                description: 'Import students, teachers, and homerooms directly from Google Workspace.',
                color: 'bg-purple-500',
              },
            ].map((feature, i) => (
              <div key={i} className="bg-white rounded-xl shadow-lg p-8 hover:shadow-xl transition duration-300">
                <div className={`w-12 h-12 ${feature.color} rounded-lg flex items-center justify-center mb-6 text-white`}>
                  {feature.icon}
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-4">{feature.title}</h3>
                <p className="text-gray-500">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-indigo-600 text-white">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-6">
            Ready to Transform Your Dismissal Process?
          </h2>
          <p className="text-xl mb-8 opacity-90 max-w-2xl mx-auto">
            Join schools already using GoPilot to create safer, faster dismissals.
            Set up in under 30 minutes with Google Workspace.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-8">
            <a
              href="/get-started"
              className="bg-white text-indigo-600 px-8 py-4 rounded-lg font-semibold hover:bg-gray-50 transition duration-200 shadow-lg inline-flex items-center justify-center gap-2 no-underline"
            >
              Get Started Free
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
            </a>
            <a
              href="/get-started"
              className="bg-transparent border-2 border-white text-white px-8 py-4 rounded-lg font-semibold hover:bg-white hover:text-indigo-600 transition duration-200 no-underline text-center"
            >
              Log In
            </a>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm opacity-80">
            <span className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              No credit card required
            </span>
            <span className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Free through June
            </span>
            <span className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Cancel anytime
            </span>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-white py-12">
        <div className="container mx-auto px-4">
          <div className="text-center">
            <div className="flex items-center justify-center gap-2 mb-6">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 16H9m10 0h3v-3.15a1 1 0 0 0-.84-.99L16 11l-2.7-3.6a1 1 0 0 0-.8-.4H5.24a2 2 0 0 0-1.8 1.1l-.8 1.63A6 6 0 0 0 2 12.42V16h2"/>
                  <circle cx="6.5" cy="16.5" r="2.5"/>
                  <circle cx="16.5" cy="16.5" r="2.5"/>
                </svg>
              </div>
              <span className="text-xl font-bold">GoPilot</span>
            </div>

            <p className="text-gray-400 text-sm mb-6">
              Safe, simple school dismissal management for K-8 schools.
            </p>

            <div className="flex justify-center gap-6 text-sm mb-6">
              <a href="/privacy" className="text-gray-400 hover:text-indigo-400 transition-colors">Privacy Policy</a>
              <a href="/terms" className="text-gray-400 hover:text-indigo-400 transition-colors">Terms of Service</a>
              <a href="/" className="text-gray-400 hover:text-indigo-400 transition-colors">Schoolpilot Home</a>
            </div>

            <div className="mb-8">
              <a
                href="mailto:info@school-pilot.net"
                className="text-indigo-400 hover:text-indigo-300"
              >
                info@school-pilot.net
              </a>
            </div>

            <div className="border-t border-gray-800 pt-8">
              <p className="text-sm text-gray-400">&copy; {new Date().getFullYear()} GoPilot. All rights reserved.</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
