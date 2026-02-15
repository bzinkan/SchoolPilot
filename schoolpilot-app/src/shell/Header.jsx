import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import ProductSwitcher from './ProductSwitcher';

export default function Header({ onToggleSidebar }) {
  const { user, activeMembership, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-slate-700 bg-slate-800 px-4 text-white">
      {/* Left side */}
      <div className="flex items-center gap-3">
        {/* Hamburger for mobile/tablet */}
        <button
          onClick={onToggleSidebar}
          className="rounded p-1 hover:bg-white/10 lg:hidden"
          aria-label="Toggle sidebar"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Logo */}
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-amber-400">SchoolPilot</span>
          {activeMembership && (
            <span className="hidden text-sm text-slate-400 sm:inline">
              | {activeMembership.schoolName}
            </span>
          )}
        </div>

        <ProductSwitcher />
      </div>

      {/* Right side - theme toggle + user menu */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleTheme}
          className="rounded-md p-1.5 hover:bg-white/10"
          aria-label="Toggle dark mode"
        >
          {theme === 'dark' ? (
            <svg className="h-5 w-5 text-amber-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          ) : (
            <svg className="h-5 w-5 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          )}
        </button>

      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-white/10"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-slate-900">
            {user?.firstName?.[0]}{user?.lastName?.[0]}
          </div>
          <span className="hidden sm:inline">{user?.firstName}</span>
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-48 rounded-md bg-card py-1 shadow-lg ring-1 ring-black/5 dark:ring-white/10">
            <div className="border-b border-border px-3 py-2">
              <p className="text-sm font-medium text-card-foreground">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
            <button
              onClick={() => { logout(); setMenuOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign out
            </button>
          </div>
        )}
      </div>
      </div>
    </header>
  );
}
