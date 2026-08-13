import { useState } from 'react';
import { Car, LogOut, ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';

export default function GoPilotAccessDenied() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const signOut = async () => {
    setBusy(true);
    setError('');
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (cause) {
      setError(cause?.message || 'Sign out could not be completed safely on this device.');
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-12 text-slate-100">
      <section className="mx-auto flex min-h-[70vh] max-w-lg items-center justify-center">
        <div className="w-full rounded-2xl border border-slate-700 bg-slate-900 p-7 shadow-2xl shadow-black/20">
          <div className="mb-5 flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600">
              <Car className="h-6 w-6" aria-hidden="true" />
            </span>
            <div>
              <p className="font-semibold">GoPilot</p>
              <p className="text-sm text-slate-400">School-operated dismissal</p>
            </div>
          </div>
          <ShieldAlert className="mb-4 h-9 w-9 text-amber-300" aria-hidden="true" />
          <h1 className="text-2xl font-bold tracking-tight">GoPilot staff access is unavailable</h1>
          <p className="mt-3 leading-6 text-slate-300">
            This account is not provisioned for a GoPilot staff role. Ask a school administrator to update your access.
          </p>
          {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
          <button
            type="button"
            onClick={signOut}
            disabled={busy}
            className="mt-6 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 font-semibold text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </section>
    </main>
  );
}
