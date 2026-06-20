import { useAuth } from "../contexts/AuthContext";
import { useLicenses } from "../contexts/LicenseContext";
import { useRef, useEffect, useState } from "react";

function PlaneCanvas() {
  const canvasRef = useRef(null);
  const stateRef = useRef({ planes: [], time: 0, width: 0, height: 0, inited: false });
  const rafRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const S = stateRef.current;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      S.width = rect.width;
      S.height = rect.height;
    };
    resize();
    window.addEventListener('resize', resize);

    // Three permanent planes — ClassPilot (yellow), PassPilot (blue), GoPilot (purple)
    if (!S.inited) {
      S.inited = true;
      const W = S.width || 800;
      const H = S.height || 400;
      S.planes = [
        { x: W * 0.2, y: H * 0.3, vx: 1.8, vy: 0.6, hue: 45, color: '#eab308', size: 24,
          angle: 0, wobble: 0, wobbleSpeed: 0.015, trail: [], spinTimer: 0, spinning: false, spinAngle: 0 },
        { x: W * 0.6, y: H * 0.6, vx: -1.5, vy: -0.8, hue: 230, color: '#3b5bdb', size: 22,
          angle: Math.PI, wobble: 2, wobbleSpeed: 0.012, trail: [], spinTimer: 0, spinning: false, spinAngle: 0 },
        { x: W * 0.8, y: H * 0.4, vx: -1.2, vy: 1.0, hue: 265, color: '#6366f1', size: 23,
          angle: Math.PI * 0.8, wobble: 4, wobbleSpeed: 0.018, trail: [], spinTimer: 0, spinning: false, spinAngle: 0 },
      ];
    }

    const animate = () => {
      S.time += 0.016;
      const { width: W, height: H } = S;
      ctx.clearRect(0, 0, W, H);

      S.planes.forEach(p => {
        // Wobble for natural flight
        p.wobble += p.wobbleSpeed;
        p.vy += Math.sin(p.wobble) * 0.015;
        p.vx += Math.cos(p.wobble * 0.7) * 0.01;

        // Keep speed in range
        const speed = Math.sqrt(p.vx ** 2 + p.vy ** 2);
        if (speed < 1.2) {
          p.vx *= 1.3;
          p.vy *= 1.3;
        }
        if (speed > 3.5) {
          p.vx *= 0.98;
          p.vy *= 0.98;
        }

        p.x += p.vx;
        p.y += p.vy;

        // Bounce off edges with smooth turning
        const pad = 20;
        if (p.x < pad) { p.vx = Math.abs(p.vx) * 0.9 + 0.3; p.x = pad; }
        if (p.x > W - pad) { p.vx = -Math.abs(p.vx) * 0.9 - 0.3; p.x = W - pad; }
        if (p.y < pad) { p.vy = Math.abs(p.vy) * 0.9 + 0.2; p.y = pad; }
        if (p.y > H - pad) { p.vy = -Math.abs(p.vy) * 0.9 - 0.2; p.y = H - pad; }

        // Random 360 spin
        p.spinTimer += 0.016;
        if (!p.spinning && p.spinTimer > 8 + Math.random() * 12) {
          p.spinning = true;
          p.spinAngle = 0;
          p.spinTimer = 0;
        }
        if (p.spinning) {
          p.spinAngle += 0.12;
          if (p.spinAngle >= Math.PI * 2) {
            p.spinning = false;
            p.spinAngle = 0;
          }
        }

        // Smooth angle to velocity direction
        const targetAngle = Math.atan2(p.vy, p.vx);
        let diff = targetAngle - p.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        p.angle += diff * 0.06;

        // Trail
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 50) p.trail.shift();

        // Draw trail
        if (p.trail.length > 1) {
          for (let i = 1; i < p.trail.length; i++) {
            const t = i / p.trail.length;
            ctx.beginPath();
            ctx.moveTo(p.trail[i - 1].x, p.trail[i - 1].y);
            ctx.lineTo(p.trail[i].x, p.trail[i].y);
            ctx.strokeStyle = `hsla(${p.hue}, 70%, 55%, ${t * 0.15})`;
            ctx.lineWidth = t * 2.5;
            ctx.lineCap = 'round';
            ctx.stroke();
          }
        }

        // Draw plane
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle + p.spinAngle);
        const pulse = 0.9 + Math.sin(S.time * 3 + p.wobble) * 0.1;
        const s = p.size * pulse;

        ctx.shadowColor = `hsla(${p.hue}, 80%, 55%, 0.1)`;
        ctx.shadowBlur = 20;

        // Top wing
        ctx.beginPath();
        ctx.moveTo(s * 1.2, 0);
        ctx.lineTo(-s * 0.6, -s * 0.55);
        ctx.lineTo(-s * 0.15, 0);
        ctx.closePath();
        ctx.fillStyle = `hsla(${p.hue}, 40%, 70%, 0.4)`;
        ctx.fill();

        // Bottom wing
        ctx.beginPath();
        ctx.moveTo(s * 1.2, 0);
        ctx.lineTo(-s * 0.6, s * 0.55);
        ctx.lineTo(-s * 0.15, 0);
        ctx.closePath();
        ctx.fillStyle = `hsla(${p.hue}, 35%, 55%, 0.35)`;
        ctx.fill();

        // Fold line
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.moveTo(s * 1.2, 0);
        ctx.lineTo(-s * 0.6, 0);
        ctx.strokeStyle = `hsla(${p.hue}, 50%, 80%, 0.25)`;
        ctx.lineWidth = 0.7;
        ctx.stroke();

        // Nose dot
        ctx.beginPath();
        ctx.arc(s * 1.1, 0, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, 60%, 85%, 0.3)`;
        ctx.fill();

        ctx.restore();
      });

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

// TEMP (test-school launch): show test schools a clean sign-in page. This hides
// the marketing sections — products grid + "Better together" banner, the
// "Request Information" CTA, the nav "Products"/"Get Started" links, and the hero
// subtitle. ALL of that code is preserved below; flip SHOW_MARKETING back to true
// to restore the full landing page after the first batch of test schools.
const SHOW_MARKETING = false;

export default function SchoolpilotLanding() {
  const { user } = useAuth();
  const { roleBasedDefaultPath } = useLicenses();
  const isSuperAdmin = user?.isSuperAdmin === true;
  const dashboardPath = isSuperAdmin ? '/super-admin/schools' : (roleBasedDefaultPath || '/classpilot');
  const [showDemo, setShowDemo] = useState(false);

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
            {SHOW_MARKETING && (
              <>
                <a href="#products" style={{ color: "#64748b", textDecoration: "none", fontSize: 15, fontWeight: 500 }}>Products</a>
                {/* Demo button hidden until new video is ready */}
                {/* <button onClick={() => setShowDemo(true)} style={{ color: "#64748b", background: "none", border: "none", fontSize: 15, fontWeight: 500, cursor: "pointer", padding: 0 }}>Demo</button> */}
                <a href="/get-started" style={{ color: "#64748b", textDecoration: "none", fontSize: 15, fontWeight: 500 }}>Get Started</a>
              </>
            )}
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
        position: "relative",
        overflow: "hidden",
      }}>
        {/* Animated paper airplanes canvas */}
        <PlaneCanvas />
        <div style={{ maxWidth: 800, margin: "0 auto", position: "relative", zIndex: 1 }}>
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

          {SHOW_MARKETING && (
          <p className="fade-in delay-2" style={{
            fontSize: 20, color: "#64748b", lineHeight: 1.7,
            maxWidth: 600, margin: "0 auto",
          }}>
            Classroom monitoring, digital hall passes, and dismissal management —
            built for K-12 schools. Simple. Affordable. Effective.
          </p>
          )}
        </div>
      </section>

      {/* Products Section — the three product cards are ALWAYS shown so test
          schools can see which products are involved. Only the marketing wrapper
          (the "Our Products" header + the "Better together" banner) stays gated
          behind SHOW_MARKETING. */}
      <section id="products" style={{ padding: "100px 24px", background: "#fff" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          {SHOW_MARKETING && (
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
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 24 }}>

            {/* ClassPilot */}
            <a href="/products/classpilot" className="product-card" style={{
              background: "#fff", borderRadius: 20, padding: 36,
              border: "1px solid #e2e8f0", textDecoration: "none",
              transition: "all 0.3s ease",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                <ClassPilotLogo size={52} />
                <div>
                  <h3 style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", margin: 0 }}>ClassPilot</h3>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#eab308", textTransform: "uppercase", letterSpacing: 1 }}>Monitoring</span>
                </div>
              </div>
              <p style={{ fontSize: 15, color: "#64748b", lineHeight: 1.7, marginBottom: 20 }}>
                See every student screen, lock devices, and apply site allow-lists during class — all from one dashboard.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {["Live screen thumbnails", "AI off-task detection", "Teacher site allow-lists", "Teacher messaging"].map(f => (
                  <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#64748b" }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: "#fef9c3", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ color: "#eab308", fontSize: 13, fontWeight: 700 }}>✓</span>
                    </div>
                    {f}
                  </div>
                ))}
              </div>
            </a>

            {/* PassPilot */}
            <a href="/products/passpilot" className="product-card" style={{
              background: "#fff", borderRadius: 20, padding: 36,
              border: "1px solid #e2e8f0", textDecoration: "none",
              transition: "all 0.3s ease",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                <PassPilotLogo size={52} />
                <div>
                  <h3 style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", margin: 0 }}>PassPilot</h3>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#3b5bdb", textTransform: "uppercase", letterSpacing: 1 }}>Hall Passes</span>
                </div>
              </div>
              <p style={{ fontSize: 15, color: "#64748b", lineHeight: 1.7, marginBottom: 20 }}>
                Replace paper passes with a digital system. Set limits, monitor durations, and see who is where — instantly.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {["One-tap pass creation", "Destination limits", "Duration tracking", "Kiosk mode"].map(f => (
                  <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#64748b" }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: "#ede9fe", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ color: "#3b5bdb", fontSize: 13, fontWeight: 700 }}>✓</span>
                    </div>
                    {f}
                  </div>
                ))}
              </div>
            </a>

            {/* GoPilot */}
            <a href="/products/gopilot" className="product-card" style={{
              background: "#fff", borderRadius: 20, padding: 36,
              border: "1px solid #e2e8f0", textDecoration: "none",
              transition: "all 0.3s ease",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                <GoPilotLogo size={52} />
                <div>
                  <h3 style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", margin: 0 }}>GoPilot</h3>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#6366f1", textTransform: "uppercase", letterSpacing: 1 }}>Dismissal</span>
                </div>
              </div>
              <p style={{ fontSize: 15, color: "#64748b", lineHeight: 1.7, marginBottom: 20 }}>
                Dismissal management made simple. Coordinate car riders, buses, and walkers with a live dashboard.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {["Car number check-in", "Real-time parent alerts", "Teacher release flow", "Multi-zone pickup"].map(f => (
                  <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#64748b" }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: "#eef2ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ color: "#6366f1", fontSize: 13, fontWeight: 700 }}>✓</span>
                    </div>
                    {f}
                  </div>
                ))}
              </div>
            </a>
          </div>

          {SHOW_MARKETING && (
          <div className="fade-in delay-3" style={{
            textAlign: "center", marginTop: 56, padding: "32px 24px",
            background: "linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%)",
            borderRadius: 16,
          }}>
            <p style={{
              fontFamily: "'Fraunces', serif", fontSize: "clamp(20px, 2.5vw, 26px)",
              fontWeight: 600, color: "#fff", margin: 0, letterSpacing: 0.3,
            }}>
              Three tools. One dashboard.{" "}
              <span style={{
                background: "linear-gradient(135deg, #eab308 0%, #f59e0b 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              }}>
                Better together
              </span>
              , but great on their own.
            </p>
          </div>
          )}
        </div>
      </section>

      {/* CTA Section */}
      {SHOW_MARKETING && (
      <section style={{ padding: "100px 24px", background: "#1e3a5f" }}>
        <div style={{ maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
          <h2 style={{
            fontFamily: "'Fraunces', serif", fontSize: 36, fontWeight: 700,
            color: "#fff", marginBottom: 16,
          }}>
            Request Information
          </h2>
          <p style={{ fontSize: 18, color: "#94a3b8", marginBottom: 40, lineHeight: 1.7 }}>
            Tell us what your school needs and we'll follow up with onboarding, IT, and billing details.
          </p>
          <a
            href="/get-started"
            className="cta-btn"
            style={{
              display: "inline-block",
              background: "#eab308", color: "#1e3a5f",
              padding: "16px 48px", borderRadius: 12,
              textDecoration: "none", fontSize: 16, fontWeight: 700,
            }}
          >
            Request Information
          </a>
        </div>
      </section>
      )}

      {/* AI Transparency one-liner */}
      <section style={{ padding: "20px 24px", background: "#f1f5f9", borderTop: "1px solid #e2e8f0", textAlign: "center" }}>
        <p style={{ fontSize: 14, color: "#64748b", margin: 0 }}>
          SchoolPilot uses <strong style={{ color: "#475569" }}>Anthropic's Claude API</strong> for AI-powered content classification to help keep students safe online.{" "}
          <a href="/ai-transparency" style={{ color: "#3b5bdb", textDecoration: "underline" }}>Learn more</a>
        </p>
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

          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
            <a href="/products/classpilot" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>ClassPilot</a>
            <a href="/products/passpilot" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>PassPilot</a>
            <a href="/products/gopilot" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>GoPilot</a>
            <a href="/terms" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>Terms</a>
            <a href="/privacy" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>Privacy</a>
            <a href="/security" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>Security</a>
            <a href="/subprocessors" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>Subprocessors</a>
            <a href="/ai-transparency" style={{ color: "#64748b", textDecoration: "none", fontSize: 14 }}>AI Transparency</a>
          </div>

          <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 13, lineHeight: 1.7 }}>
            <div style={{ color: "#cbd5e1", fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Contact</div>
            <a href="mailto:hello@school-pilot.net" style={{ color: "#94a3b8", textDecoration: "none" }}>hello@school-pilot.net</a>
          </div>

          <p style={{ color: "#475569", fontSize: 13 }}>
            &copy; {new Date().getFullYear()} Schoolpilot. All rights reserved.
          </p>
        </div>
      </footer>

      {/* Demo Video Modal */}
      {showDemo && (
        <div
          onClick={() => setShowDemo(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 9999, padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 900, borderRadius: 16, overflow: "hidden", background: "#000" }}
          >
            <div style={{ position: "relative", paddingBottom: "56.25%", height: 0 }}>
              <iframe
                src="https://www.loom.com/embed/30f5d4adb9cb4d9d8fc4b7a8e21bdd9e?autoplay=1"
                frameBorder="0"
                allowFullScreen
                allow="autoplay"
                style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
              />
            </div>
            <button
              onClick={() => setShowDemo(false)}
              style={{
                position: "absolute", top: 16, right: 16,
                background: "rgba(0,0,0,0.6)", color: "#fff", border: "none",
                width: 36, height: 36, borderRadius: "50%", fontSize: 20,
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              &times;
            </button>
          </div>
        </div>
      )}
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
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#3b5bdb" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="12" fill={`url(#${id})`} />
      <rect x="20" y="18" width="24" height="32" rx="3" fill="#fff" />
      <rect x="26" y="14" width="12" height="8" rx="2" fill="#fff" />
      <rect x="28" y="16" width="8" height="4" rx="1" fill="#3b5bdb" />
      <path d="M26 34 L30 38 L38 28" stroke="#3b5bdb" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function GoPilotLogo({ size = 64 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <rect width="64" height="64" rx="12" fill="#6366f1" />
      <rect x="16" y="20" width="32" height="24" rx="6" fill="#fff" />
      <path d="M24 32 L26 26 L38 26 L40 32" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <path d="M22 32 L42 32 L42 36 L22 36 Z" fill="none" stroke="#6366f1" strokeWidth="2.5" />
      <circle cx="27" cy="36" r="2.5" fill="#6366f1" />
      <circle cx="37" cy="36" r="2.5" fill="#6366f1" />
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

