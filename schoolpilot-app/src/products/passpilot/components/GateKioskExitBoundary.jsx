import { X } from 'lucide-react';
import { discardKioskLaunchTicket } from '../kioskDeviceId';

const GATE_KIOSK_SESSION_KEYS = [
  'pp_kiosk_pin',
  'pp_kiosk_session_simple',
  'pp_kiosk_session_badge',
];

function isGateLaunch() {
  return new URLSearchParams(window.location.search).get('launch') === 'gate';
}

function clearGateKioskSession() {
  try {
    for (const key of GATE_KIOSK_SESSION_KEYS) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // A blocked storage API must never trap someone inside kiosk mode.
  }
  discardKioskLaunchTicket();
}

export default function GateKioskExitBoundary({ children }) {
  const gateLaunch = isGateLaunch();

  const exitKiosk = () => {
    clearGateKioskSession();
    window.location.replace('/');
  };

  return (
    <>
      {children}
      {gateLaunch && (
        <button
          type="button"
          onClick={exitKiosk}
          aria-label="Exit kiosk mode and return to ClassPilot sign-in"
          title="Return to ClassPilot sign-in"
          data-testid="gate-kiosk-exit"
          className="fixed right-4 top-4 z-[1100] flex h-11 w-11 items-center justify-center rounded-full border border-white/45 bg-slate-950/80 text-white shadow-lg backdrop-blur-sm transition hover:border-white hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
        >
          <X aria-hidden="true" className="h-6 w-6" strokeWidth={2.25} />
        </button>
      )}
    </>
  );
}
