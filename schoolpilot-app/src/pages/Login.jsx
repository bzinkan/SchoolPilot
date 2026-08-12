import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useNative } from '../contexts/NativeContext';
import api from '../shared/utils/api';
import { queryClient } from '../lib/queryClient';

export default function Login() {
  const { login, refetchUser, acceptToken, secureStorageError } = useAuth();
  const { isNative, product } = useNative();
  const [searchParams] = useSearchParams();
  const isGoPilotApp = isNative && product === 'gopilot';
  const [showEmailLogin, setShowEmailLogin] = useState(isGoPilotApp);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Handle OAuth one-time-code redirect — exchange for JWT (web only)
  // Code is single-use, 60s TTL. JWT comes back in response body, never in URL.
  useEffect(() => {
    const code = searchParams.get('code');
    if (code) {
      // Strip the code from URL immediately so it doesn't end up in browser history
      window.history.replaceState({}, '', '/login');
      if (isGoPilotApp) {
        setError('Google sign-in is not available in the GoPilot Android app. Use your school-issued staff email and password.');
        return;
      }
      api.post('/auth/exchange-code', { code })
        .then(async res => {
          const token = res.data?.token;
          if (token) {
            await acceptToken(token);
            queryClient.clear();
            await refetchUser({ throwOnError: true });
          } else {
            setError('Sign-in code was invalid or expired. Please try again.');
          }
        })
        .catch(() => {
          setError('Sign-in code was invalid or expired. Please try again.');
        });
      return;
    }

    const oauthError = searchParams.get('error');
    if (oauthError === 'no_account') {
      setError('No account found for that Google email. Please contact your school administrator.');
    } else if (oauthError === 'oauth_failed') {
      setError('Google sign-in failed. Please try again.');
    } else if (oauthError === 'no_email') {
      setError('Could not retrieve email from Google. Please try again.');
    } else if (oauthError === 'no_school') {
      setError('Your account does not have access to an active school. Please contact your school administrator.');
    } else if (oauthError === 'native_oauth_disabled') {
      setError('Google sign-in is not available in the GoPilot Android app. Use your school-issued staff email and password.');
    }
  }, [searchParams, refetchUser, acceptToken, isGoPilotApp]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      queryClient.clear();
      await login(email, password);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const retrySecureStorage = async () => {
    setLoading(true);
    setError('');
    try {
      await refetchUser({ throwOnError: true });
    } catch (err) {
      setError(err.message || 'Secure device storage is still unavailable.');
    } finally {
      setLoading(false);
    }
  };

  if (isGoPilotApp && secureStorageError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-indigo-950 p-5 text-slate-950">
        <section className="w-full max-w-md rounded-3xl bg-white p-7 shadow-2xl sm:p-9" role="alert" aria-labelledby="secure-storage-title">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">GoPilot security check</p>
          <h1 id="secure-storage-title" className="mt-2 text-2xl font-bold tracking-tight">Secure storage is unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">{secureStorageError}</p>
          <p className="mt-3 text-sm leading-6 text-slate-600">Sign-in is disabled because GoPilot will never store a staff credential in unprotected device preferences.</p>
          {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
          <button type="button" onClick={retrySecureStorage} disabled={loading} className="mt-6 min-h-11 w-full rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-60">
            {loading ? 'Checking secure storage…' : 'Retry security check'}
          </button>
          <p className="mt-4 text-center text-xs text-slate-500">If this continues, update or reinstall GoPilot and contact your school administrator.</p>
        </section>
      </main>
    );
  }

  // ── GoPilot native app login ──
  if (isGoPilotApp) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #4f46e5 0%, #6366f1 50%, #4338ca 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        position: 'relative',
        overflow: 'hidden',
      }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
          .gp-login input::placeholder { color: #94a3b8; }
          .gp-login input:focus { outline: none; border-color: #6366f1 !important; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2); }
          .gp-login .email-form {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.3s ease-out, opacity 0.3s ease-out;
            opacity: 0;
          }
          .gp-login .email-form.show {
            max-height: 400px;
            opacity: 1;
          }
        `}</style>

        {/* Background grid pattern */}
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.1) 1px, transparent 0)',
          backgroundSize: '40px 40px',
        }} />

        {/* Decorative gradient orbs */}
        <div style={{
          position: 'absolute',
          top: '-20%', right: '-10%',
          width: '600px', height: '600px',
          background: 'radial-gradient(circle, rgba(255, 255, 255, 0.08) 0%, transparent 70%)',
          borderRadius: '50%',
        }} />
        <div style={{
          position: 'absolute',
          bottom: '-20%', left: '-10%',
          width: '500px', height: '500px',
          background: 'radial-gradient(circle, rgba(139, 92, 246, 0.15) 0%, transparent 70%)',
          borderRadius: '50%',
        }} />

        {/* Login card */}
        <div className="gp-login" style={{
          background: '#ffffff',
          borderRadius: '24px',
          padding: '48px 40px',
          width: '100%',
          maxWidth: '420px',
          position: 'relative',
          zIndex: 1,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.3)',
        }}>

          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <div style={{
              width: '72px', height: '72px',
              borderRadius: '20px',
              background: '#4f46e5',
              marginBottom: '16px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 10px 30px rgba(79, 70, 229, 0.3)',
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-2-2.2-3.3C12.8 5.4 11.5 5 10.2 5H5.8C4.4 5 3.2 5.9 2.8 7.2L2 10c-.4 1.2-.2 2.5.5 3.5"/>
                <circle cx="7" cy="17" r="2"/>
                <circle cx="17" cy="17" r="2"/>
                <path d="M14 17H9"/>
              </svg>
            </div>
            <h1 style={{
              fontSize: '32px',
              fontWeight: 700,
              color: '#1e293b',
              letterSpacing: '-0.5px',
              marginBottom: '6px',
            }}>
              <span style={{ color: '#4f46e5' }}>Go</span>Pilot
            </h1>
            <p style={{ fontSize: '14px', color: '#94a3b8', fontWeight: 500 }}>
              by SchoolPilot
            </p>
          </div>

          {/* Error message */}
          {error && (
            <div style={{
              marginBottom: '16px',
              padding: '12px 16px',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '12px',
              fontSize: '13px',
              color: '#dc2626',
              textAlign: 'center',
            }}>
              {error}
            </div>
          )}

          {/* Main actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            <p style={{ color: '#64748b', fontSize: '13px', lineHeight: 1.5, textAlign: 'center' }}>
              Sign in with your school-issued staff account.
            </p>

            {/* Collapsible email/password form */}
            <div className={`email-form ${showEmailLogin ? 'show' : ''}`}>
              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

                {/* Divider */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', margin: '4px 0' }}>
                  <div style={{ flex: 1, height: '1px', background: '#e2e8f0' }} />
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>email login</span>
                  <div style={{ flex: 1, height: '1px', background: '#e2e8f0' }} />
                </div>

                {/* Email field */}
                <div>
                  <label style={{
                    display: 'block', fontSize: '14px', fontWeight: 500,
                    color: '#374151', marginBottom: '8px',
                  }}>Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@school.edu"
                    style={{
                      width: '100%', padding: '14px 16px', fontSize: '15px',
                      borderRadius: '12px', border: '1px solid #d1d5db',
                      background: '#f9fafb', color: '#1e293b',
                      transition: 'border-color 0.2s, box-shadow 0.2s', boxSizing: 'border-box',
                    }}
                  />
                </div>

                {/* Password field */}
                <div>
                  <label style={{
                    display: 'block', fontSize: '14px', fontWeight: 500,
                    color: '#374151', marginBottom: '8px',
                  }}>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="Enter your password"
                    style={{
                      width: '100%', padding: '14px 16px', fontSize: '15px',
                      borderRadius: '12px', border: '1px solid #d1d5db',
                      background: '#f9fafb', color: '#1e293b',
                      transition: 'border-color 0.2s, box-shadow 0.2s', boxSizing: 'border-box',
                    }}
                  />
                </div>

                {/* Submit button */}
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%', padding: '14px', fontSize: '15px', fontWeight: 600,
                    borderRadius: '12px', border: 'none',
                    background: '#4f46e5', color: '#ffffff',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s',
                    opacity: loading ? 0.7 : 1,
                    boxShadow: '0 4px 14px rgba(79, 70, 229, 0.3)',
                  }}
                >
                  {loading ? 'Signing in...' : 'Sign In with Email'}
                </button>
              </form>
            </div>
          </div>

          {/* Privacy note */}
          <div style={{
            marginTop: '28px', padding: '16px',
            background: '#f8fafc', borderRadius: '12px',
            border: '1px solid #e2e8f0',
          }}>
            <p style={{ fontSize: '12px', color: '#94a3b8', textAlign: 'center', lineHeight: 1.5, margin: 0 }}>
              By signing in, you agree to our{' '}
              <a href="/terms" style={{ color: '#4f46e5', textDecoration: 'none' }}>Terms of Service</a>
              {' '}and{' '}
              <a href="/privacy" style={{ color: '#4f46e5', textDecoration: 'none' }}>Privacy Policy</a>.
            </p>
          </div>

          <p style={{ marginTop: '20px', textAlign: 'center', fontSize: '13px', color: '#64748b', marginBottom: 0 }}>
            Staff access is provisioned by your school administrator.
          </p>
        </div>
      </div>
    );
  }

  // ── Web login (SchoolPilot branded — unchanged) ──
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      position: 'relative',
      overflow: 'hidden',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        .sp-login input::placeholder { color: #64748b; }
        .sp-login input:focus { outline: none; border-color: #eab308 !important; }
        .sp-login .email-form {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.3s ease-out, opacity 0.3s ease-out;
          opacity: 0;
        }
        .sp-login .email-form.show {
          max-height: 400px;
          opacity: 1;
        }
      `}</style>

      {/* Background grid pattern */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundImage: 'radial-gradient(circle at 1px 1px, #334155 1px, transparent 0)',
        backgroundSize: '40px 40px',
        opacity: 0.4,
      }} />

      {/* Decorative gradient orbs */}
      <div style={{
        position: 'absolute',
        top: '-20%', right: '-10%',
        width: '600px', height: '600px',
        background: 'radial-gradient(circle, rgba(234, 179, 8, 0.1) 0%, transparent 70%)',
        borderRadius: '50%',
      }} />
      <div style={{
        position: 'absolute',
        bottom: '-20%', left: '-10%',
        width: '500px', height: '500px',
        background: 'radial-gradient(circle, rgba(59, 130, 246, 0.08) 0%, transparent 70%)',
        borderRadius: '50%',
      }} />

      {/* Login card */}
      <div className="sp-login" style={{
        background: 'rgba(30, 41, 59, 0.8)',
        backdropFilter: 'blur(20px)',
        borderRadius: '24px',
        padding: '48px 40px',
        width: '100%',
        maxWidth: '420px',
        border: '1px solid rgba(71, 85, 105, 0.5)',
        position: 'relative',
        zIndex: 1,
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
      }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            width: '64px', height: '64px',
            borderRadius: '16px',
            marginBottom: '16px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 10px 30px rgba(234, 179, 8, 0.3)',
            overflow: 'hidden',
          }}>
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="64" height="64" rx="14" fill="#1e3a5f"/>
              <path d="M16 24 L48 32 L16 40 L22 32 Z" fill="#fff"/>
              <path d="M22 32 L48 32 L16 40 Z" fill="#eab308"/>
            </svg>
          </div>
          <h1 style={{
            fontSize: '28px',
            fontWeight: 700,
            color: '#f1f5f9',
            letterSpacing: '-0.5px',
            marginBottom: '8px',
          }}>
            <span style={{ color: '#eab308' }}>School</span>Pilot
          </h1>
          <p style={{ fontSize: '14px', color: '#94a3b8' }}>
            Sign in to your account
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div style={{
            marginBottom: '16px',
            padding: '12px 16px',
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '12px',
            fontSize: '13px',
            color: '#fca5a5',
            textAlign: 'center',
          }}>
            {error}
          </div>
        )}

        {/* Main actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Google sign in - PRIMARY */}
          <button
            onClick={() => { window.location.href = '/api/auth/google'; }}
            style={{
              width: '100%',
              padding: '16px',
              fontSize: '16px',
              fontWeight: 600,
              borderRadius: '12px',
              border: 'none',
              background: '#eab308',
              color: '#0f172a',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              transition: 'all 0.2s',
              boxShadow: '0 4px 14px rgba(234, 179, 8, 0.3)',
            }}
            onMouseOver={(e) => { e.currentTarget.style.background = '#facc15'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseOut={(e) => { e.currentTarget.style.background = '#eab308'; e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </button>
          <p style={{ fontSize: '12px', color: '#94a3b8', textAlign: 'center', lineHeight: 1.5, margin: '-6px 0 0' }}>
            This sign-in only verifies your Google identity. It does not grant SchoolPilot access to Gmail, Drive, Classroom, or Directory.
          </p>

          {/* Email login toggle */}
          <button
            onClick={() => setShowEmailLogin(!showEmailLogin)}
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              fontSize: '13px',
              cursor: 'pointer',
              padding: '8px',
              transition: 'color 0.2s',
            }}
            onMouseOver={(e) => { e.currentTarget.style.color = '#94a3b8'; }}
            onMouseOut={(e) => { e.currentTarget.style.color = '#64748b'; }}
          >
            {showEmailLogin ? 'Hide email login' : 'Sign in with email instead'}
          </button>

          {/* Collapsible email/password form */}
          <div className={`email-form ${showEmailLogin ? 'show' : ''}`}>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {/* Divider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', margin: '4px 0' }}>
                <div style={{ flex: 1, height: '1px', background: '#475569' }} />
                <span style={{ fontSize: '12px', color: '#64748b' }}>email login</span>
                <div style={{ flex: 1, height: '1px', background: '#475569' }} />
              </div>

              {/* Email field */}
              <div>
                <label style={{
                  display: 'block', fontSize: '14px', fontWeight: 500,
                  color: '#e2e8f0', marginBottom: '8px',
                }}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@school.edu"
                  style={{
                    width: '100%', padding: '14px 16px', fontSize: '15px',
                    borderRadius: '12px', border: '1px solid #475569',
                    background: 'rgba(15, 23, 42, 0.6)', color: '#f1f5f9',
                    transition: 'border-color 0.2s', boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Password field */}
              <div>
                <label style={{
                  display: 'block', fontSize: '14px', fontWeight: 500,
                  color: '#e2e8f0', marginBottom: '8px',
                }}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="Enter your password"
                  style={{
                    width: '100%', padding: '14px 16px', fontSize: '15px',
                    borderRadius: '12px', border: '1px solid #475569',
                    background: 'rgba(15, 23, 42, 0.6)', color: '#f1f5f9',
                    transition: 'border-color 0.2s', boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Submit button */}
              <button
                type="submit"
                disabled={loading}
                style={{
                  width: '100%', padding: '14px', fontSize: '15px', fontWeight: 600,
                  borderRadius: '12px', border: '1px solid #475569',
                  background: 'transparent', color: '#f1f5f9',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  opacity: loading ? 0.7 : 1,
                }}
                onMouseOver={(e) => { if (!loading) { e.currentTarget.style.background = 'rgba(71, 85, 105, 0.3)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
                onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                {loading ? 'Signing in...' : 'Sign In with Email'}
              </button>
            </form>
          </div>
        </div>

        {/* Privacy note */}
        <div style={{
          marginTop: '28px', padding: '16px',
          background: 'rgba(15, 23, 42, 0.5)', borderRadius: '12px',
          border: '1px solid rgba(71, 85, 105, 0.3)',
        }}>
          <p style={{ fontSize: '12px', color: '#94a3b8', textAlign: 'center', lineHeight: 1.5, margin: 0 }}>
            By signing in, you agree to our{' '}
            <a href="/terms" style={{ color: '#eab308', textDecoration: 'none' }}>Terms of Service</a>
            {' '}and{' '}
            <a href="/privacy" style={{ color: '#eab308', textDecoration: 'none' }}>Privacy Policy</a>.
          </p>
        </div>

        {/* Back to home */}
        <p style={{ marginTop: '24px', textAlign: 'center', fontSize: '14px', color: '#94a3b8', marginBottom: 0 }}>
          <a href="/" style={{ color: '#64748b', textDecoration: 'none', fontWeight: 500 }}>
            &larr; Back to SchoolPilot
          </a>
        </p>
      </div>
    </div>
  );
}
