import { useState } from 'react';
import api from '../shared/utils/api';

export default function GetStarted() {
  const [form, setForm] = useState({
    schoolName: '',
    domain: '',
    contactName: '',
    contactEmail: '',
    estimatedStudents: '',
  });
  const [products, setProducts] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const toggleProduct = (p) =>
    setProducts((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.post('/admin/trial-requests', {
        ...form,
        product: products.join(',') || null,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '14px 16px', borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.08)',
    color: '#fff', fontSize: 15, outline: 'none', boxSizing: 'border-box',
  };

  const labelStyle = {
    display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 6,
  };

  return (
    <div style={{
      fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #1e3a5f 0%, #0f172a 100%)',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Fraunces:wght@600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .gs-input::placeholder { color: #64748b; }
        .gs-btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .gs-btn { transition: all 0.2s ease; }
      `}</style>

      {/* Nav */}
      <nav style={{
        padding: '16px 24px',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
      }}>
        <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
            <svg width="32" height="32" viewBox="0 0 64 64" fill="none">
              <rect width="64" height="64" rx="14" fill="#1e3a5f" />
              <path d="M16 24 L48 32 L16 40 L22 32 Z" fill="#fff" />
              <path d="M22 32 L48 32 L16 40 Z" fill="#eab308" />
            </svg>
            <span style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 20, color: '#fff' }}>
              Schoolpilot
            </span>
          </a>
          <a href="/login" style={{ color: '#94a3b8', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}>
            Already have an account? Sign In
          </a>
        </div>
      </nav>

      {/* Form */}
      <div style={{ maxWidth: 520, margin: '0 auto', padding: '60px 24px 100px' }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h1 style={{
            fontFamily: "'Fraunces', serif", fontSize: 36, fontWeight: 700,
            color: '#fff', marginBottom: 16,
          }}>
            Get Started Free
          </h1>
          <p style={{ fontSize: 18, color: '#94a3b8', lineHeight: 1.7 }}>
            Try SchoolPilot free through the end of the school year. No credit card required.
          </p>
        </div>

        {submitted ? (
          <div style={{
            background: 'rgba(255,255,255,0.1)', borderRadius: 16, padding: 40, textAlign: 'center',
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, color: '#fff', margin: '16px 0 12px' }}>
              We're on it!
            </h3>
            <p style={{ fontSize: 16, color: '#94a3b8', lineHeight: 1.7 }}>
              Check your inbox for a confirmation email. We'll have your account ready within 24 hours.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gap: 16 }}>
              <div>
                <label style={labelStyle}>School Name *</label>
                <input className="gs-input" required style={inputStyle} value={form.schoolName} placeholder="Lincoln Elementary"
                  onChange={(e) => setForm({ ...form, schoolName: e.target.value })} />
              </div>
              <div>
                <label style={labelStyle}>Google Workspace Domain *</label>
                <input className="gs-input" required style={inputStyle} value={form.domain} placeholder="lincoln.k12.oh.us"
                  onChange={(e) => setForm({ ...form, domain: e.target.value })} />
                <p style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                  The domain your school uses for Google accounts (e.g. school.edu)
                </p>
              </div>
              <div>
                <label style={labelStyle}>Your Name *</label>
                <input className="gs-input" required style={inputStyle} value={form.contactName} placeholder="Jane Smith"
                  onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
              </div>
              <div>
                <label style={labelStyle}>Email *</label>
                <input className="gs-input" required type="email" style={inputStyle} value={form.contactEmail} placeholder="jsmith@lincoln.k12.oh.us"
                  onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              </div>
              <div>
                <label style={labelStyle}>Estimated Students *</label>
                <input className="gs-input" required type="number" min="1" style={inputStyle} value={form.estimatedStudents} placeholder="300"
                  onChange={(e) => setForm({ ...form, estimatedStudents: e.target.value })} />
              </div>
              <div>
                <label style={labelStyle}>Products you're interested in</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    { key: 'CLASSPILOT', label: 'ClassPilot', desc: 'Classroom device management', color: '#eab308' },
                    { key: 'PASSPILOT', label: 'PassPilot', desc: 'Digital hall passes', color: '#3b5bdb' },
                    { key: 'GOPILOT', label: 'GoPilot', desc: 'Dismissal management', color: '#6366f1' },
                  ].map((p) => {
                    const active = products.includes(p.key);
                    return (
                      <button type="button" key={p.key} onClick={() => toggleProduct(p.key)} style={{
                        padding: '10px 16px', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                        border: active ? `2px solid ${p.color}` : '2px solid rgba(255,255,255,0.2)',
                        background: active ? p.color : 'transparent',
                        color: active ? (p.key === 'CLASSPILOT' ? '#1e3a5f' : '#fff') : '#94a3b8',
                        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                        flex: '1 1 140px',
                      }}>
                        <span>{p.label}</span>
                        <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.8 }}>{p.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {error && <p style={{ color: '#f87171', fontSize: 14, marginTop: 12 }}>{error}</p>}

            <button type="submit" disabled={submitting} className="gs-btn" style={{
              width: '100%', marginTop: 24, padding: '16px', borderRadius: 12,
              background: '#eab308', color: '#1e3a5f', fontSize: 16, fontWeight: 700,
              border: 'none', cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.7 : 1,
            }}>
              {submitting ? 'Submitting...' : 'Start Your Free Trial'}
            </button>

            <p style={{ textAlign: 'center', fontSize: 13, color: '#64748b', marginTop: 12 }}>
              Free through end of school year. No credit card required.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
