import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { useTheme } from '../../../contexts/ThemeContext';
import { teacherPreferencesKey } from '../lib/teachingTools';
import { resolveDashboardTheme } from '../../../shared/themes/presets';

// Reads the signed-in teacher's own dashboard theme and tells the ThemeProvider
// while one is active, so light/dark mode pauses for the console. Always the
// viewer's preference: observing another teacher's class never changes it.
// `apply: false` reads the preference without pausing light/dark mode, for
// surfaces outside the dashboard (the admin header's quick switch).
export function useDashboardTheme({ schoolId, viewerId, enabled = true, timeZone, apply = true }) {
  const query = useQuery({
    queryKey: teacherPreferencesKey(schoolId, viewerId),
    queryFn: ({ signal }) => apiRequest('GET', '/classpilot/teacher/preferences', undefined, { signal, headers: { 'X-School-Id': schoolId } }),
    select: data => (data && typeof data === 'object' && !Array.isArray(data) ? data : null),
    enabled: Boolean(enabled && schoolId && viewerId),
    staleTime: 60_000,
    retry: false,
  });
  const preferences = query.data ?? null;
  const themesEnabled = preferences?.dashboardThemesEnabled === true;
  const active = resolveDashboardTheme(preferences?.effectiveDashboardTheme ?? preferences?.dashboardTheme,
    { enabled: themesEnabled, timeZone, schoolId, uploadsEnabled: preferences?.dashboardThemeUploadsEnabled === true });
  const { setDashboardThemeActive } = useTheme();
  const activeId = active?.id ?? null;
  // Child effects run before the provider's, so the provider's own effect
  // re-applies the html class once this update lands. Cleared on unmount so
  // leaving the dashboard restores the stored light/dark preference.
  useEffect(() => {
    if (!apply) return undefined;
    setDashboardThemeActive(Boolean(activeId));
    return () => setDashboardThemeActive(false);
  }, [apply, activeId, setDashboardThemeActive]);
  return { preferences, themesEnabled, active, query };
}
