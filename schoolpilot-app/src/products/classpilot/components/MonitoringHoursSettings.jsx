import { apiRequest, queryClient } from '../../../lib/queryClient';
import { Input } from '../../../components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { useSettingsDraft } from '../hooks/useSettingsDraft';
import SettingsSaveState from './admin/SettingsSaveState';

const API = '/classpilot/admin/settings';
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const labels = { enableTrackingHours: 'Configured tracking hours', trackingStartTime: 'Start', trackingEndTime: 'End', trackingDays: 'Tracking days', afterHoursMode: 'After hours' };
export default function MonitoringHoursSettings({ settings, schoolId, queryKey }) {
  const editor = useSettingsDraft({ id: 'monitoring-hours', source: settings, fields: Object.keys(labels),
    save: (draft, baseline) => apiRequest('PATCH', `${API}/monitoring`, { ...draft, expectedVersion: baseline.version }, { headers: { 'X-School-Id': schoolId } }),
    refresh: async () => (await apiRequest('GET', API, undefined, { headers: { 'X-School-Id': schoolId } })).sections.monitoring,
    onSaved: saved => {
      queryClient.setQueryData(queryKey, current => current && ({ ...current, sections: { ...current.sections, monitoring: saved } }));
      void queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      void queryClient.invalidateQueries({ queryKey: ['classpilot-school-scheduling'] });
      void queryClient.invalidateQueries({ queryKey: ['classpilot-schedule-profiles'] });
      void queryClient.invalidateQueries({ queryKey: ['/classpilot/monitoring-interruptions'] });
    },
  });
  const value = editor.draft;
  const invalid = value.enableTrackingHours && (value.trackingStartTime === value.trackingEndTime || !value.trackingDays.length)
    || value.afterHoursMode === 'limited' && !value.enableTrackingHours;
  return <Card><CardHeader><CardTitle className="text-lg">Monitoring hours</CardTitle><CardDescription>Set tracking days, times, and after-hours behavior in the saved school timezone.</CardDescription></CardHeader><CardContent className="space-y-5">
    <fieldset disabled={editor.busy} className="min-w-0 space-y-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enableTrackingHours} onChange={event => editor.update('enableTrackingHours', event.target.checked)} />Use configured tracking hours</label>
      <div className="grid gap-3 sm:grid-cols-3"><label className="text-sm">Start<Input type="time" value={value.trackingStartTime} onChange={event => editor.update('trackingStartTime', event.target.value)} /></label><label className="text-sm">End<Input type="time" value={value.trackingEndTime} onChange={event => editor.update('trackingEndTime', event.target.value)} /></label><label className="text-sm">School timezone<Input value={settings.schoolTimezone} readOnly aria-describedby="monitoring-timezone-note" /></label></div>
      <p id="monitoring-timezone-note" className="text-xs text-muted-foreground">The school profile timezone also controls class schedules. Contact your SchoolPilot administrator to request a change.</p>
      <fieldset className="flex flex-wrap gap-3"><legend className="mb-2 text-sm">Tracking days</legend>{days.map(day => <label key={day} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={value.trackingDays.includes(day)} onChange={event => editor.update('trackingDays', event.target.checked ? [...value.trackingDays, day] : value.trackingDays.filter(item => item !== day))} />{day.slice(0, 3)}</label>)}</fieldset>
      <label className="block text-sm">After hours<select className="ml-3 rounded-md border bg-background p-2" value={value.afterHoursMode} onChange={event => editor.update('afterHoursMode', event.target.value)}><option value="off">Off</option><option value="limited">Safety only</option><option value="full">Full monitoring</option></select></label>
      <p className="text-xs text-muted-foreground">Safety only requires configured tracking hours and an updated extension. It checks minimal page data for safety alerts without browsing history, screenshots, teacher presence, Live View, or classroom commands.</p>
    </fieldset><SettingsSaveState editor={editor} labels={labels} saveLabel="Save monitoring hours" invalid={invalid} />
  </CardContent></Card>;
}
