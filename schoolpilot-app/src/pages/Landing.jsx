import { useAuth } from "../contexts/AuthContext";
import { useLicenses } from "../contexts/LicenseContext";

export default function SchoolpilotLanding() {
  const { user } = useAuth();
  const { roleBasedDefaultPath } = useLicenses();
  const isSuperAdmin = user?.isSuperAdmin === true;
  const dashboardPath = isSuperAdmin ? '/super-admin/schools' : (roleBasedDefaultPath || '/classpilot');

  return (
    <div style={{ fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif", background: "#fafbfc", color: "#1a1a2e" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Fraunces:wght@600;700&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        html { scroll-behavior: smooth; }

        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .fade-in { animation: fadeInUp 0.6s ease-out forwards; }
        .delay-1 { animation-delay: 0.1s; opacity: 0; }
        .delay-2 { animation-delay: 0.2s; opacity: 0; }
        .delay-3 { animation-delay: 0.3s; opacity: 0; }

        .product-card:hover { transform: translateY(-8px); box-shadow: 0 20px 60px rgba(0,0,0,0.12); }
        .product-card { transition: all 0.3s ease; }

        .cta-btn:hover { transform: translateY(-2px); opacity: 0.9; }
        .cta-btn { transition: all 0.2s ease; }

        a:hover { opacity: 0.8; }
      `}</style>

      {/* Navigation */}
      <nav style={{
        background: "#fff",
        borderBottom: "1px solid rgba(0,0,0,0.05)",
        padding: "16px 24px",
      }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <SchoolpilotLogo size={40} />
            <span style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 22, color: "#1e3a5f" }}>
              Schoolpilot
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
            <a href="#products" style={{ color: "#64748b", textDecoration: "none", fontSize: 15, fontWeight: 500 }}>Products</a>
            <a href="#contact" style={{ color: "#64748b", textDecoration: "none", fontSize: 15, fontWeight: 500 }}>Contact</a>
            {user ? (
              <a href={dashboardPath} style={{
                background: "#1e3a5f", color: "#fff", padding: "10px 20px",
                borderRadius: 8, textDecoration: "none", fontSize: 14, fontWeight: 600,
              }}>Go to Dashboard</a>
            ) : (
              <a href="/login" style={{
                background: "#1e3a5f", color: "#fff", padding: "10px 20px",
                borderRadius: 8, textDecoration: "none", fontSize: 14, fontWeight: 600,
              }}>Sign In</a>
            )}
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section style={{
        padding: "100px 24px",
        background: "linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)",
        textAlign: "center",
      }}>
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          <h1 className="fade-in delay-1" style={{
            fontFamily: "'Fraunces', serif", fontSize: "clamp(36px, 5vw, 56px)",
            fontWeight: 700, lineHeight: 1.1, marginBottom: 24, color: "#0f172a",
          }}>
            School management tools that{" "}
            <span style={{
              background: "linear-gradient(135deg, #eab308 0%, #f59e0b 100%)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>
              work together
            </span>
          </h1>

          <p className="fade-in delay-2" style={{
            fontSize: 20, color: "#64748b", lineHeight: 1.7,
            maxWidth: 600, margin: "0 auto",
          }}>
            Classroom monitoring, digital hall passes, and dismissal management —
            built for K-12 schools. Simple. Affordable. Effective.
          </p>
        </div>
      </section>

      {/* Products Section */}
      <section id="products" style={{ padding: "100px 24px", background: "#fff" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 64 }}>
            <h2 style={{
              fontFamily: "'Fraunces', serif", fontSize: 36, fontWeight: 700,
              color: "#0f172a", marginBottom: 16,
            }}>
              Our Products
            </h2>
            <p style={{ fontSize: 18, color: "#64748b" }}>
              Three tools designed to make your school run smoother.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 32 }}>

            {/* ClassPilot */}
            <div className="product-card" style={{
              background: "#fff", borderRadius: 20, padding: 36,
              border: "1px solid #e2e8f0",
            }}>
              <div style={{ marginBottom: 24 }}>
                <ClassPilotLogo size={64} />
              </div>
              <h3 style={{ fontSize: 26, fontWeight: 700, color: "#0f172a", marginBottom: 12 }}>
                ClassPilot
              </h3>
              <p style={{ fontSize: 16, color: "#64748b", lineHeight: 1.7, marginBottom: 24 }}>
                Real-time classroom monitoring for Chromebooks. View student screens,
                control web access, lock devices, and keep your class focused and on task.
              </p>
              <a
                href="https://classpilot.net"
                className="cta-btn"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  background: "#eab308", color: "#1e3a5f",
                  padding: "12px 24px", borderRadius: 10,
                  textDecoration: "none", fontSize: 15, fontWeight: 600,
                }}
              >
                Learn More
                <ArrowRightIcon />
              </a>
            </div>

            {/* PassPilot */}
            <div className="product-card" style={{
              background: "#fff", borderRadius: 20, padding: 36,
              border: "1px solid #e2e8f0",
            }}>
              <div style={{ marginBottom: 24 }}>
                <PassPilotLogo size={64} />
              </div>
              <h3 style={{ fontSize: 26, fontWeight: 700, color: "#0f172a", marginBottom: 12 }}>
                PassPilot
              </h3>
              <p style={{ fontSize: 16, color: "#64748b", lineHeight: 1.7, marginBottom: 24 }}>
                Digital hall passes that track student movement. Set destination limits,
                monitor pass duration, and eliminate paper passes for good.
              </p>
              <a
                href="https://pass-pilot.net"
                className="cta-btn"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  background: "#6366f1", color: "#fff",
                  padding: "12px 24px", borderRadius: 10,
                  textDecoration: "none", fontSize: 15, fontWeight: 600,
                }}
              >
                Learn More
                <ArrowRightIcon />
              </a>
            </div>

            {/* GoPilot */}
            <div className="product-card" style={{
              background: "#fff", borderRadius: 20, padding: 36,
              border: "1px solid #e2e8f0",
            }}>
              <div style={{ marginBottom: 24 }}>
                <GoPilotLogo size={64} />
              </div>
              <h3 style={{ fontSize: 26, fontWeight: 700, color: "#0f172a", marginBottom: 12 }}>
                GoPilot
              </h3>
              <p style={{ fontSize: 16, color: "#64748b", lineHeight: 1.7, marginBottom: 24 }}>
                Dismissal management made simple. Coordinate car riders, buses, and walkers
                with real-time notifications and a live dismissal dashboard.
              </p>
              <a
                href="https://go-pilot.net"
                className="cta-btn"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  background: "#3b5bdb", color: "#fff",
                  padding: "12px 24px", borderRadius: 10,
                  textDecoration: "none", fontSize: 15, fontWeight: 600,
                }}
              >
                Learn More
                <ArrowRightIcon />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Contact Section */}
      <section id="contact" style={{ padding: "100px 24px", background: "#1e3a5f" }}>
        <div style={{ maxWidth: 600, margin: "0 auto", textAlign: "center" }}>
          <h2 style={{
            fontFamily: "'Fraunces', serif", fontSize: 36, fontWeight: 700,
            color: "#fff", marginBottom: 16,
          }}>
            Get in Touch
          </h2>
          <p style={{ fontSize: 18, color: "#94a3b8", marginBottom: 40, lineHeight: 1.7 }}>
            Have questions? Want a demo? We'd love to hear from you.
          </p>

          <a
            href="mailto:info@school-pilot.net"
            style={{
              display: "inline-flex", alignItems: "center", gap: 12,
              background: "#eab308", color: "#1e3a5f",
              padding: "18px 36px", borderRadius: 12,
              textDecoration: "none", fontSize: 18, fontWeight: 600,
            }}
          >
            <EmailIcon />
            info@school-pilot.net
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ background: "#0f172a", padding: "40px 24px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <SchoolpilotLogo size={32} />
            <span style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 18, color: "#fff" }}>
              Schoolpilot
            </span>
          </div>

          <div style={{ display: "flex", gap: 24 }}>
            <a href="https://classpilot.net" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>ClassPilot</a>
            <a href="https://pass-pilot.net" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>PassPilot</a>
            <a href="https://go-pilot.net" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>GoPilot</a>
          </div>

          <p style={{ color: "#475569", fontSize: 13 }}>
            &copy; 2025 Schoolpilot. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}

// ============================================================
// LOGOS
// ============================================================

function SchoolpilotLogo({ size = 64 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <rect width="64" height="64" rx="14" fill="#1e3a5f" />
      <path d="M16 24 L48 32 L16 40 L22 32 Z" fill="#fff" />
      <path d="M22 32 L48 32 L16 40 Z" fill="#eab308" />
    </svg>
  );
}

function ClassPilotLogo({ size = 64 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <rect width="48" height="48" rx="12" fill="#fbbf24"/>
      <path d="M12 24L36 14L30 36L24 28L36 14" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M24 28L26 34" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

function PassPilotLogo({ size = 64 }) {
  // eslint-disable-next-line react-hooks/purity
  const id = `pp-${Math.random()}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="12" fill={`url(#${id})`} />
      <rect x="20" y="18" width="24" height="32" rx="3" fill="#fff" />
      <rect x="26" y="14" width="12" height="8" rx="2" fill="#fff" />
      <rect x="28" y="16" width="8" height="4" rx="1" fill="#6366f1" />
      <path d="M26 34 L30 38 L38 28" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function GoPilotLogo({ size = 64 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <rect width="64" height="64" rx="12" fill="#3b5bdb" />
      <rect x="16" y="20" width="32" height="24" rx="6" fill="#fff" />
      <path d="M24 32 L26 26 L38 26 L40 32" stroke="#3b5bdb" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <path d="M22 32 L42 32 L42 36 L22 36 Z" fill="none" stroke="#3b5bdb" strokeWidth="2.5" />
      <circle cx="27" cy="36" r="2.5" fill="#3b5bdb" />
      <circle cx="37" cy="36" r="2.5" fill="#3b5bdb" />
    </svg>
  );
}

// ============================================================
// ICONS
// ============================================================

function ArrowRightIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/>
    </svg>
  );
}
