import { useDashboardTheme } from '../../hooks/useDashboardTheme';
import DashboardThemeMenu from '../DashboardThemeMenu';

// The admin header's quick switch for the administrator's OWN dashboard theme.
// It reads the same preference the dashboard uses but never applies it here:
// admin pages keep their light/dark look, so nothing about the Admin Panel
// changes when a theme is chosen (docs/CLASSPILOT_DASHBOARD_THEMES.md §4.10).
export default function AdminDashboardThemeMenu({ schoolId, viewerId, timeZone }) {
  const theme = useDashboardTheme({ schoolId, viewerId, timeZone, enabled: Boolean(schoolId && viewerId), apply: false });
  if (!theme.themesEnabled || !theme.preferences) return null;
  return <DashboardThemeMenu theme={theme} schoolId={schoolId} viewerId={viewerId} />;
}
