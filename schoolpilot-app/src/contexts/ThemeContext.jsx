import { createContext, useCallback, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('sp_theme');
    if (stored === 'dark' || stored === 'light') return stored;
    // Default to system preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  // A ClassPilot dashboard theme replaces light/dark while it is active. The
  // stored preference is left untouched so it returns when the theme clears.
  const [dashboardThemeActive, setDashboardThemeActiveState] = useState(false);
  const setDashboardThemeActive = useCallback(active => setDashboardThemeActiveState(Boolean(active)), []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(dashboardThemeActive ? 'light' : theme);
    localStorage.setItem('sp_theme', theme);
  }, [theme, dashboardThemeActive]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, dashboardThemeActive, setDashboardThemeActive }}>
      {children}
    </ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
