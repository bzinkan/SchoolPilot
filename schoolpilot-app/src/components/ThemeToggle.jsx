import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

const LOCKED_HINT = 'This theme sets its own look. Switch to Default to use light or dark mode.';

export function ThemeToggle() {
  const { theme, toggleTheme, dashboardThemeActive } = useTheme();
  // While a dashboard theme is active the toggle stays visible but inert, so
  // the hint can explain why. aria-disabled (not disabled) keeps the tooltip.
  const locked = Boolean(dashboardThemeActive);

  return (
    <button
      onClick={locked ? undefined : toggleTheme}
      aria-disabled={locked || undefined}
      className={`w-9 h-9 flex items-center justify-center rounded-lg border border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 transition-colors ${locked ? 'cursor-not-allowed opacity-50' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
      data-testid="button-theme-toggle"
      title={locked ? LOCKED_HINT : theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
    >
      {theme === 'light' ? (
        <Moon className="h-[18px] w-[18px]" />
      ) : (
        <Sun className="h-[18px] w-[18px]" />
      )}
    </button>
  );
}
