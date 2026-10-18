import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { teacherPreferencesKey } from '../lib/teachingTools';

// One-time notice the first time a dashboard renders a theme the school
// calendar chose for the teacher (docs/CLASSPILOT_DASHBOARD_THEMES.md §9.6).
// Fixed to the viewport, so tiles and header never move; dismissed per teacher
// in this browser; "Plain dashboard" saves { kind: 'none' } through the same
// revision-checked write as the picker.
const noticeKey = (schoolId, viewerId) => `cp:theme-notice:v1:${schoolId}:${viewerId}`;
const readDismissed = key => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
const writeDismissed = key => { try { localStorage.setItem(key, '1'); } catch { /* per-viewer convenience only */ } };

export default function DashboardThemeNotice({ theme, schoolId, viewerId }) {
  const navigate = useNavigate();
  const key = noticeKey(schoolId, viewerId);
  // Dismissal is remembered per teacher in this browser; reading it during
  // render keeps a school switch from flashing a notice already dismissed.
  const [dismissedKey, setDismissedKey] = useState(null);
  const dismissed = dismissedKey === key || readDismissed(key);
  const setDismissed = () => setDismissedKey(key);
  const preferences = theme?.preferences;
  const automatic = Boolean(theme?.themesEnabled && theme?.active && preferences && preferences.dashboardTheme == null
    && preferences.effectiveDashboardTheme?.source === 'school' && !preferences.dashboardThemeLocked);
  const plain = useMutation({
    mutationFn: () => apiRequest('PATCH', '/classpilot/teacher/preferences',
      { expectedRevision: preferences.revision, dashboardTheme: { kind: 'none' } }, { headers: { 'X-School-Id': schoolId } }),
    onSuccess: response => { queryClient.setQueryData(teacherPreferencesKey(schoolId, viewerId), response); writeDismissed(key); setDismissed(); },
    onError: error => { if (error?.response?.status === 409 && error.response.data?.current) queryClient.setQueryData(teacherPreferencesKey(schoolId, viewerId), error.response.data.current); },
  });
  if (!automatic || dismissed) return null;
  const keep = () => { writeDismissed(key); setDismissed(); };
  return (
    <div role="status" data-testid="dashboard-theme-notice"
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
      <span>Your dashboard follows the school calendar. Change it any time in Appearance.</span>
      <Button size="sm" variant="outline" onClick={() => { keep(); navigate('/classpilot/my-settings?section=appearance'); }}>Appearance</Button>
      <Button size="sm" variant="outline" disabled={plain.isPending} onClick={() => plain.mutate()} data-testid="dashboard-theme-notice-plain">Plain dashboard</Button>
      <Button size="sm" onClick={keep} data-testid="dashboard-theme-notice-keep">Keep it</Button>
    </div>
  );
}
