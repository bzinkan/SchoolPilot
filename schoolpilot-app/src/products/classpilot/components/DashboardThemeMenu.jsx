import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, Palette } from 'lucide-react';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { teacherPreferencesKey } from '../lib/teachingTools';
import { describeDashboardTheme, readyDashboardThemePresets } from '../../../shared/themes/presets';

// Quick switch beside the light/dark toggle. Writes the signed-in teacher's own
// preference through the same revision-checked PATCH as Teaching tools.
export default function DashboardThemeMenu({ theme, schoolId, viewerId }) {
  const navigate = useNavigate();
  const { preferences, themesEnabled } = theme;
  const key = teacherPreferencesKey(schoolId, viewerId);
  const save = useMutation({
    mutationFn: dashboardTheme => apiRequest('PATCH', '/classpilot/teacher/preferences',
      { expectedRevision: preferences.revision, dashboardTheme }, { headers: { 'X-School-Id': schoolId } }),
    onSuccess: response => queryClient.setQueryData(key, response),
    onError: error => {
      // A stale revision means another tab or Teaching tools saved first: show that value.
      if (error?.response?.status === 409 && error.response.data?.current) queryClient.setQueryData(key, error.response.data.current);
    },
  });
  if (!themesEnabled || !preferences) return null;
  const stored = preferences.dashboardTheme;
  const currentId = stored?.kind === 'preset' ? stored.preset : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="w-9 h-9 flex items-center justify-center rounded-lg border border-chrome-control-border text-chrome-muted hover:bg-chrome-control-hover transition-colors disabled:opacity-50"
          data-testid="button-dashboard-theme"
          aria-label="Dashboard theme"
          title={`Dashboard theme: ${describeDashboardTheme(stored)}`}
          disabled={save.isPending}
        >
          <Palette className="h-[18px] w-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Dashboard theme</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => { if (currentId !== null) save.mutate(null); }} data-testid="dashboard-theme-option-default">
          <span className="flex-1">Default</span>
          {currentId === null ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
        </DropdownMenuItem>
        {readyDashboardThemePresets().map(preset => (
          <DropdownMenuItem key={preset.id} onSelect={() => { if (currentId !== preset.id) save.mutate({ kind: 'preset', preset: preset.id }); }}
            data-testid={`dashboard-theme-option-${preset.id}`}>
            <span className="flex-1">{preset.label}</span>
            {currentId === preset.id ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/classpilot/my-settings?section=appearance')} data-testid="dashboard-theme-customize">
          Customize…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
