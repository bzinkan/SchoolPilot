import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function SchoolSwitcher() {
  const { memberships, activeMembership, switchSchool } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!activeMembership) return null;

  // Single membership: just show the name, no dropdown
  if (memberships.length <= 1) {
    return (
      <span className="hidden text-sm text-slate-400 sm:inline">
        | {activeMembership.schoolName}
      </span>
    );
  }

  return (
    <div className="relative hidden sm:block" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
      >
        <span>| {activeMembership.schoolName}</span>
        <svg className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-56 rounded-md bg-card shadow-lg ring-1 ring-black/5 dark:ring-white/10">
          <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border">
            Switch School
          </div>
          {memberships.map((m) => {
            const isActive = m.schoolId === activeMembership.schoolId;
            return (
              <button
                key={m.schoolId}
                onClick={() => {
                  switchSchool(m.schoolId);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors ${
                  isActive ? 'bg-muted font-semibold text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                }`}
              >
                <div className={`h-2 w-2 rounded-full ${isActive ? 'bg-amber-400' : 'bg-transparent'}`} />
                <span>{m.schoolName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
