import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

// ─── Typography: Clash Display (bold geometric) + Satoshi (clean body) ───
const FONTS_URL = 'https://api.fontshare.com/v2/css?f[]=clash-display@600,700&f[]=satoshi@400,500,700&display=swap';

// ─── Palette: Deep navy + warm amber + product accent pops ───
const C = {
  bg: '#0a0e1a',
  bgCard: '#111827',
  bgGlow: '#1a1f35',
  text: '#f8fafc',
  textMuted: '#94a3b8',
  amber: '#fbbf24',
  amberGlow: 'rgba(251, 191, 36, 0.15)',
  classpilot: '#facc15',
  gopilot: '#3b82f6',
  passpilot: '#8b5cf6',
  border: 'rgba(148, 163, 184, 0.1)',
};

const products = [
  {
    name: 'ClassPilot',
    tag: 'Classroom Monitoring',
    color: C.classpilot,
    icon: '📡',
    desc: 'See every student screen in real-time. Block distracting sites, lock devices, and keep your class on task — all from one dashboard.',
    features: ['Live screen thumbnails', 'AI off-task detection', 'Website blocking', 'Teacher messaging'],
  },
  {
    name: 'GoPilot',
    tag: 'Dismissal Management',
    color: C.gopilot,
    icon: '🚗',
    desc: 'Coordinate car riders, buses, and walkers with a live dismissal queue. Parents get real-time pickup notifications.',
    features: ['Car number check-in', 'Real-time parent alerts', 'Teacher release flow', 'Multi-zone pickup'],
  },
  {
    name: 'PassPilot',
    tag: 'Digital Hall Passes',
    color: C.passpilot,
    icon: '🎫',
    desc: 'Replace paper passes with a digital system. Set limits, monitor durations, and see who is where — instantly.',
    features: ['One-tap pass creation', 'Destination limits', 'Duration tracking', 'Kiosk mode'],
  },
];

const stats = [
  { value: '10s', label: 'Screen refresh rate' },
  { value: '< 1s', label: 'Dismissal notifications' },
  { value: '100%', label: 'Google Workspace sync' },
  { value: '0', label: 'Paper passes needed' },
];

const testimonialPlaceholders = [
  { quote: 'Finally, a platform that does everything we need without stitching together five different tools.', name: 'School Administrator', role: 'K-8 School, Ohio' },
  { quote: 'The dismissal queue alone saves us 20 minutes every day. Parents love the notifications.', name: 'Office Manager', role: 'Elementary School' },
];

// ─── Animated counter ───
function AnimatedNumber({ value, suffix = '' }) {
  const [display, setDisplay] = useState('0');
  const ref = useRef(null);
  const hasAnimated = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated.current) {
          hasAnimated.current = true;
          const num = parseInt(value);
          if (isNaN(num)) {
            setDisplay(value);
            return;
          }
          let start = 0;
          const duration = 1200;
          const step = (ts) => {
            if (!start) start = ts;
            const progress = Math.min((ts - start) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setDisplay(Math.floor(eased * num).toString());
            if (progress < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
      },
      { threshold: 0.5 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [value]);

  return <span ref={ref}>{display}{suffix}</span>;
}

// ─── Scroll-triggered fade in ───
function FadeIn({ children, delay = 0, className = '' }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.15 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(32px)',
        transition: `all 0.7s cubic-bezier(0.16, 1, 0.3, 1) ${delay}s`,
      }}
    >
      {children}
    </div>
  );
}

// ─── Magnetic hover effect for cards ───
function MagneticCard({ children, color, className = '' }) {
  const ref = useRef(null);
  const [transform, setTransform] = useState('');
  const [glowPos, setGlowPos] = useState({ x: 50, y: 50 });

  const handleMouseMove = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const rotateX = (y - 0.5) * -8;
    const rotateY = (x - 0.5) * 8;
    setTransform(`perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.02)`);
    setGlowPos({ x: x * 100, y: y * 100 });
  };

  const handleMouseLeave = () => {
    setTransform('perspective(800px) rotateX(0) rotateY(0) scale(1)');
  };

  return (
    <div
      ref={ref}
      className={className}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        transform,
        transition: 'transform 0.3s ease-out',
        position: 'relative',
        overflow: 'hidden',
        background: `radial-gradient(circle at ${glowPos.x}% ${glowPos.y}%, ${color}08, transparent 60%), ${C.bgCard}`,
        border: `1px solid ${C.border}`,
        borderRadius: '20px',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: `${glowPos.y}%`,
          left: `${glowPos.x}%`,
          width: '200px',
          height: '200px',
          transform: 'translate(-50%, -50%)',
          background: `radial-gradient(circle, ${color}15, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />
      {children}
    </div>
  );
}

export default function LandingV2() {
  const navigate = useNavigate();
  const [scrollY, setScrollY] = useState(0);
  const [activeProduct, setActiveProduct] = useState(0);

  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONTS_URL;
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);

  useEffect(() => {
    const handleScroll = () => setScrollY(window.scrollY);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-rotate products
  useEffect(() => {
    const timer = setInterval(() => setActiveProduct(p => (p + 1) % 3), 4000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "'Satoshi', sans-serif", minHeight: '100vh', overflowX: 'hidden' }}>

      {/* ═══ NAV ═══ */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50,
        padding: '16px 32px',
        background: scrollY > 50 ? 'rgba(10, 14, 26, 0.85)' : 'transparent',
        backdropFilter: scrollY > 50 ? 'blur(20px)' : 'none',
        borderBottom: scrollY > 50 ? `1px solid ${C.border}` : 'none',
        transition: 'all 0.3s ease',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: `linear-gradient(135deg, ${C.amber}, #f59e0b)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'Clash Display', sans-serif", fontWeight: 700, fontSize: 18, color: '#0a0e1a',
          }}>S</div>
          <span style={{ fontFamily: "'Clash Display', sans-serif", fontWeight: 700, fontSize: 20 }}>SchoolPilot</span>
        </div>
        <div style={{ display: 'flex', gap: '32px', alignItems: 'center' }}>
          <a href="#products" style={{ color: C.textMuted, textDecoration: 'none', fontSize: 14, fontWeight: 500, transition: 'color 0.2s' }}
            onMouseOver={e => e.target.style.color = C.text} onMouseOut={e => e.target.style.color = C.textMuted}>Products</a>
          <a href="#how" style={{ color: C.textMuted, textDecoration: 'none', fontSize: 14, fontWeight: 500, transition: 'color 0.2s' }}
            onMouseOver={e => e.target.style.color = C.text} onMouseOut={e => e.target.style.color = C.textMuted}>How It Works</a>
          <button
            onClick={() => navigate('/login')}
            style={{
              padding: '10px 24px', borderRadius: 12, border: 'none', cursor: 'pointer',
              background: `linear-gradient(135deg, ${C.amber}, #f59e0b)`,
              color: '#0a0e1a', fontWeight: 700, fontSize: 14,
              fontFamily: "'Satoshi', sans-serif",
              transition: 'transform 0.2s, box-shadow 0.2s',
              boxShadow: `0 0 20px ${C.amberGlow}`,
            }}
            onMouseOver={e => { e.target.style.transform = 'translateY(-2px)'; e.target.style.boxShadow = `0 8px 30px ${C.amberGlow}`; }}
            onMouseOut={e => { e.target.style.transform = 'translateY(0)'; e.target.style.boxShadow = `0 0 20px ${C.amberGlow}`; }}
          >
            Get Started
          </button>
        </div>
      </nav>

      {/* ═══ HERO ═══ */}
      <section style={{ position: 'relative', padding: '180px 32px 120px', textAlign: 'center', maxWidth: 1200, margin: '0 auto' }}>
        {/* Ambient glow */}
        <div style={{
          position: 'absolute', top: '10%', left: '50%', transform: 'translateX(-50%)',
          width: 800, height: 400, borderRadius: '50%',
          background: `radial-gradient(ellipse, ${C.amber}08, transparent 70%)`,
          pointerEvents: 'none',
        }} />

        {/* Badge */}
        <FadeIn>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 20px', borderRadius: 100,
            background: C.amberGlow, border: `1px solid ${C.amber}30`,
            fontSize: 13, fontWeight: 600, color: C.amber,
            marginBottom: 32,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.amber, animation: 'pulse 2s infinite' }} />
            Now serving K-8 schools
          </div>
        </FadeIn>

        {/* Headline */}
        <FadeIn delay={0.1}>
          <h1 style={{
            fontFamily: "'Clash Display', sans-serif",
            fontSize: 'clamp(40px, 6vw, 80px)',
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: '-0.03em',
            marginBottom: 24,
          }}>
            One platform for
            <br />
            <span style={{
              background: `linear-gradient(135deg, ${C.classpilot}, ${C.gopilot}, ${C.passpilot})`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>
              everything school
            </span>
          </h1>
        </FadeIn>

        <FadeIn delay={0.2}>
          <p style={{
            fontSize: 'clamp(16px, 2vw, 20px)',
            color: C.textMuted,
            maxWidth: 580,
            margin: '0 auto 48px',
            lineHeight: 1.6,
          }}>
            Classroom monitoring. Dismissal management. Digital hall passes.
            Three tools that work together — or stand on their own.
          </p>
        </FadeIn>

        <FadeIn delay={0.3}>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => navigate('/get-started')}
              style={{
                padding: '16px 36px', borderRadius: 14, border: 'none', cursor: 'pointer',
                background: `linear-gradient(135deg, ${C.amber}, #f59e0b)`,
                color: '#0a0e1a', fontWeight: 700, fontSize: 16,
                fontFamily: "'Satoshi', sans-serif",
                boxShadow: `0 4px 30px ${C.amberGlow}`,
                transition: 'all 0.2s',
              }}
              onMouseOver={e => { e.target.style.transform = 'translateY(-3px)'; e.target.style.boxShadow = `0 12px 40px ${C.amberGlow}`; }}
              onMouseOut={e => { e.target.style.transform = 'translateY(0)'; e.target.style.boxShadow = `0 4px 30px ${C.amberGlow}`; }}
            >
              Start Free Trial
            </button>
            <button
              style={{
                padding: '16px 36px', borderRadius: 14, cursor: 'pointer',
                background: 'transparent',
                border: `1px solid ${C.border}`,
                color: C.text, fontWeight: 600, fontSize: 16,
                fontFamily: "'Satoshi', sans-serif",
                transition: 'all 0.2s',
              }}
              onMouseOver={e => { e.target.style.background = C.bgGlow; e.target.style.borderColor = C.textMuted; }}
              onMouseOut={e => { e.target.style.background = 'transparent'; e.target.style.borderColor = C.border; }}
            >
              Watch Demo
            </button>
          </div>
        </FadeIn>

        {/* Product switcher pills */}
        <FadeIn delay={0.4}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 64 }}>
            {products.map((p, i) => (
              <button
                key={p.name}
                onClick={() => setActiveProduct(i)}
                style={{
                  padding: '10px 24px', borderRadius: 100, cursor: 'pointer',
                  border: activeProduct === i ? `2px solid ${p.color}` : `1px solid ${C.border}`,
                  background: activeProduct === i ? `${p.color}15` : 'transparent',
                  color: activeProduct === i ? p.color : C.textMuted,
                  fontWeight: 600, fontSize: 14,
                  fontFamily: "'Satoshi', sans-serif",
                  transition: 'all 0.3s',
                }}
              >
                {p.icon} {p.name}
              </button>
            ))}
          </div>
        </FadeIn>

        {/* Dashboard preview placeholder */}
        <FadeIn delay={0.5}>
          <div style={{
            marginTop: 40,
            padding: 3,
            borderRadius: 20,
            background: `linear-gradient(135deg, ${products[activeProduct].color}40, transparent 50%, ${products[activeProduct].color}20)`,
            transition: 'all 0.5s ease',
          }}>
            <div style={{
              borderRadius: 18,
              background: C.bgCard,
              padding: '60px 40px',
              minHeight: 300,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 16,
            }}>
              <span style={{ fontSize: 48 }}>{products[activeProduct].icon}</span>
              <h3 style={{ fontFamily: "'Clash Display', sans-serif", fontSize: 24, fontWeight: 700 }}>
                {products[activeProduct].name}
              </h3>
              <p style={{ color: C.textMuted, fontSize: 14 }}>{products[activeProduct].tag}</p>
              <p style={{ color: C.textMuted, fontSize: 13, maxWidth: 400, textAlign: 'center' }}>
                Screenshot of {products[activeProduct].name} dashboard goes here
              </p>
            </div>
          </div>
        </FadeIn>
      </section>

      {/* ═══ STATS BAR ═══ */}
      <section style={{ borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, padding: '48px 32px' }}>
        <div style={{ maxWidth: 1000, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 32, textAlign: 'center' }}>
          {stats.map((s, i) => (
            <FadeIn key={i} delay={i * 0.1}>
              <div>
                <div style={{ fontFamily: "'Clash Display', sans-serif", fontSize: 36, fontWeight: 700, color: C.amber }}>
                  {s.value}
                </div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>{s.label}</div>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      {/* ═══ PRODUCTS ═══ */}
      <section id="products" style={{ padding: '120px 32px', maxWidth: 1200, margin: '0 auto' }}>
        <FadeIn>
          <div style={{ textAlign: 'center', marginBottom: 64 }}>
            <h2 style={{ fontFamily: "'Clash Display', sans-serif", fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 700, marginBottom: 16 }}>
              Three tools. One login.
            </h2>
            <p style={{ color: C.textMuted, fontSize: 18, maxWidth: 500, margin: '0 auto' }}>
              Pick what you need, or use them all. They're better together.
            </p>
          </div>
        </FadeIn>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 24 }}>
          {products.map((p, i) => (
            <FadeIn key={p.name} delay={i * 0.15}>
              <MagneticCard color={p.color} className="">
                <div style={{ padding: 36 }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: 16,
                    background: `${p.color}15`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 28, marginBottom: 20,
                  }}>
                    {p.icon}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                    <h3 style={{ fontFamily: "'Clash Display', sans-serif", fontSize: 24, fontWeight: 700 }}>{p.name}</h3>
                    <span style={{
                      padding: '4px 12px', borderRadius: 100,
                      background: `${p.color}15`, color: p.color,
                      fontSize: 12, fontWeight: 600,
                    }}>{p.tag}</span>
                  </div>
                  <p style={{ color: C.textMuted, fontSize: 15, lineHeight: 1.6, marginBottom: 24 }}>{p.desc}</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {p.features.map(f => (
                      <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.textMuted }}>
                        <div style={{ width: 20, height: 20, borderRadius: 6, background: `${p.color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ color: p.color, fontSize: 12 }}>✓</span>
                        </div>
                        {f}
                      </div>
                    ))}
                  </div>
                </div>
              </MagneticCard>
            </FadeIn>
          ))}
        </div>
      </section>

      {/* ═══ HOW IT WORKS ═══ */}
      <section id="how" style={{ padding: '120px 32px', background: C.bgGlow }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <FadeIn>
            <div style={{ textAlign: 'center', marginBottom: 64 }}>
              <h2 style={{ fontFamily: "'Clash Display', sans-serif", fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 700, marginBottom: 16 }}>
                Up and running in minutes
              </h2>
              <p style={{ color: C.textMuted, fontSize: 18 }}>No hardware. No training. Just sign in.</p>
            </div>
          </FadeIn>

          {[
            { step: '01', title: 'Sign in with Google', desc: 'Use your school Google Workspace account. Student rosters sync automatically.' },
            { step: '02', title: 'Choose your tools', desc: 'Enable ClassPilot, GoPilot, PassPilot — or all three. Each works independently.' },
            { step: '03', title: 'Deploy to your school', desc: 'ClassPilot installs on Chromebooks via Google Admin. GoPilot and PassPilot work in any browser.' },
          ].map((item, i) => (
            <FadeIn key={i} delay={i * 0.15}>
              <div style={{
                display: 'flex', gap: 32, alignItems: 'flex-start',
                padding: '32px 0',
                borderBottom: i < 2 ? `1px solid ${C.border}` : 'none',
              }}>
                <div style={{
                  fontFamily: "'Clash Display', sans-serif",
                  fontSize: 48, fontWeight: 700, color: `${C.amber}30`,
                  lineHeight: 1, flexShrink: 0, width: 80,
                }}>
                  {item.step}
                </div>
                <div>
                  <h3 style={{ fontFamily: "'Clash Display', sans-serif", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
                    {item.title}
                  </h3>
                  <p style={{ color: C.textMuted, fontSize: 16, lineHeight: 1.6 }}>{item.desc}</p>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      {/* ═══ SOCIAL PROOF ═══ */}
      <section style={{ padding: '120px 32px', maxWidth: 900, margin: '0 auto' }}>
        <FadeIn>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontFamily: "'Clash Display', sans-serif", fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 700 }}>
              Built for schools, by someone who gets it
            </h2>
          </div>
        </FadeIn>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24 }}>
          {testimonialPlaceholders.map((t, i) => (
            <FadeIn key={i} delay={i * 0.15}>
              <div style={{
                padding: 32, borderRadius: 20,
                background: C.bgCard, border: `1px solid ${C.border}`,
              }}>
                <div style={{ fontSize: 32, color: C.amber, marginBottom: 16, lineHeight: 1 }}>"</div>
                <p style={{ color: C.textMuted, fontSize: 15, lineHeight: 1.7, marginBottom: 24, fontStyle: 'italic' }}>
                  {t.quote}
                </p>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{t.name}</div>
                  <div style={{ color: C.textMuted, fontSize: 13 }}>{t.role}</div>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      {/* ═══ CTA ═══ */}
      <section style={{ padding: '120px 32px' }}>
        <FadeIn>
          <div style={{
            maxWidth: 800, margin: '0 auto', textAlign: 'center',
            padding: '80px 48px', borderRadius: 28,
            background: `linear-gradient(135deg, ${C.bgGlow}, ${C.bgCard})`,
            border: `1px solid ${C.border}`,
            position: 'relative', overflow: 'hidden',
          }}>
            {/* Glow orbs */}
            <div style={{ position: 'absolute', top: -100, right: -100, width: 300, height: 300, borderRadius: '50%', background: `${C.amber}08`, pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', bottom: -80, left: -80, width: 250, height: 250, borderRadius: '50%', background: `${C.gopilot}06`, pointerEvents: 'none' }} />

            <h2 style={{
              fontFamily: "'Clash Display', sans-serif",
              fontSize: 'clamp(28px, 4vw, 44px)',
              fontWeight: 700, marginBottom: 16,
              position: 'relative',
            }}>
              Ready to simplify your school?
            </h2>
            <p style={{ color: C.textMuted, fontSize: 18, marginBottom: 40, position: 'relative' }}>
              Start a free trial. No credit card required.
            </p>
            <button
              onClick={() => navigate('/get-started')}
              style={{
                padding: '18px 48px', borderRadius: 14, border: 'none', cursor: 'pointer',
                background: `linear-gradient(135deg, ${C.amber}, #f59e0b)`,
                color: '#0a0e1a', fontWeight: 700, fontSize: 18,
                fontFamily: "'Satoshi', sans-serif",
                boxShadow: `0 4px 40px ${C.amberGlow}`,
                position: 'relative',
                transition: 'all 0.2s',
              }}
              onMouseOver={e => { e.target.style.transform = 'translateY(-3px)'; e.target.style.boxShadow = `0 12px 50px ${C.amberGlow}`; }}
              onMouseOut={e => { e.target.style.transform = 'translateY(0)'; e.target.style.boxShadow = `0 4px 40px ${C.amberGlow}`; }}
            >
              Get Started Free
            </button>
          </div>
        </FadeIn>
      </section>

      {/* ═══ FOOTER ═══ */}
      <footer style={{ borderTop: `1px solid ${C.border}`, padding: '48px 32px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: `linear-gradient(135deg, ${C.amber}, #f59e0b)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: "'Clash Display', sans-serif", fontWeight: 700, fontSize: 14, color: '#0a0e1a',
            }}>S</div>
            <span style={{ fontWeight: 600, fontSize: 14 }}>SchoolPilot</span>
            <span style={{ color: C.textMuted, fontSize: 13 }}>© 2026</span>
          </div>
          <div style={{ display: 'flex', gap: 24 }}>
            {['Privacy', 'Terms', 'Support'].map(link => (
              <a key={link} href={`/${link.toLowerCase()}`} style={{ color: C.textMuted, textDecoration: 'none', fontSize: 13, transition: 'color 0.2s' }}
                onMouseOver={e => e.target.style.color = C.text} onMouseOut={e => e.target.style.color = C.textMuted}>
                {link}
              </a>
            ))}
          </div>
        </div>
      </footer>

      {/* Pulse animation keyframes */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
