import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, Download, RefreshCw } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { apiRequest } from '../../../lib/queryClient';
import api from '../../../shared/utils/api';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { adminIdentityKey } from '../lib/adminNavigation';
import { formatUsageTime, requireUsageReport, usageCalendar, usageDateRange, usageError, usageGrades, usageLocalDate, usageQuery } from '../lib/digitalUsage';

const API = '/classpilot/admin/usage';
const selectClass = 'h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const STATE_LABELS = { final: 'Final', live: 'Live', unavailable: 'Unavailable', expired: 'Outside retention', future: 'Upcoming' };

function Picker({ label, value, onChange, children, disabled = false }) {
  return <label className="grid min-w-0 gap-2 text-sm font-medium">{label}<select aria-label={label} className={selectClass} value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>{children}</select></label>;
}

function Notice({ children, error = false }) {
  return <div role={error ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-sm ${error ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100'}`}>{children}</div>;
}

function Sites({ title, domains }) {
  const maximum = domains[0]?.seconds || 1;
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>Top 10 sites in computed days</CardDescription></CardHeader><CardContent>
    {domains.length ? <ol className="space-y-4">{domains.map(site => <li key={site.domain}><div className="flex justify-between gap-3 text-sm"><span className="min-w-0 break-all font-medium">{site.domain}</span><span className="shrink-0 tabular-nums">{formatUsageTime(site.seconds)}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded bg-muted" aria-hidden="true"><div className="h-full rounded bg-slate-600 dark:bg-slate-400" style={{ width: `${site.seconds / maximum * 100}%` }} /></div></li>)}</ol> : <p className="text-sm text-muted-foreground">No sites observed in this category.</p>}
  </CardContent></Card>;
}

function DailyUsage({ report }) {
  const days = usageCalendar(report);
  const maximum = Math.max(1, ...report.byDay.map(day => day.monitoredBrowserSeconds));
  const chartWidth = 760, chartHeight = 110, step = chartWidth / days.length;
  return <Card><CardHeader><CardTitle className="text-base">Daily observed time</CardTitle><CardDescription>School calendar days · {report.range.timeZone}. Gaps are unavailable; a zero means the day was computed with no browser activity observed.</CardDescription></CardHeader><CardContent className="space-y-5">
    <div aria-hidden="true"><svg viewBox={`0 0 ${chartWidth} ${chartHeight + 8}`} className="h-32 w-full" preserveAspectRatio="none">{days.map((day, index) => day.monitoredBrowserSeconds === null
      ? <rect key={day.date} x={index * step + step * 0.15} y="0" width={step * 0.7} height={chartHeight} fill="currentColor" className="text-slate-200 dark:text-slate-800" opacity="0.5" />
      : day.monitoredBrowserSeconds === 0 ? <rect key={day.date} x={index * step + step * 0.15} y={chartHeight} width={step * 0.7} height="2" fill="currentColor" className="text-slate-500" />
        : <g key={day.date}>{[
          [day.instructionalSeconds, 0, 'text-teal-600 dark:text-teal-400'],
          [day.offTaskSeconds, day.instructionalSeconds, 'text-amber-500 dark:text-amber-400'],
          [day.unknownSeconds, day.instructionalSeconds + day.offTaskSeconds, 'text-slate-500 dark:text-slate-400'],
        ].map(([seconds, below, color]) => <rect key={color} x={index * step + step * 0.15} y={chartHeight - (below + seconds) / maximum * chartHeight} width={step * 0.7} height={seconds / maximum * chartHeight} fill="currentColor" className={color} />)}</g>)}</svg><div className="flex justify-between text-xs text-muted-foreground"><span>{report.range.from}</span><span>{report.range.to}</span></div></div>
    <p className="text-xs text-muted-foreground">Teal: instructional · Amber: off-task · Gray: unknown · Pale columns: no report available</p>
    <div tabIndex={0} role="region" aria-label="Daily usage table" className="max-h-96 overflow-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><table className="w-full text-left text-sm"><caption className="sr-only">Daily Monitored Browser Time, including unavailable dates</caption><thead className="sticky top-0 bg-muted"><tr>{['School date', 'State', 'Observed time', 'Observed students'].map(title => <th key={title} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">{title}</th>)}</tr></thead><tbody>{days.map(day => <tr key={day.date} data-testid={`usage-day-${day.date}`} className="border-t"><th scope="row" className="whitespace-nowrap px-4 py-3 font-normal tabular-nums">{day.date}</th><td className="whitespace-nowrap px-4 py-3">{STATE_LABELS[day.state]}</td><td className="whitespace-nowrap px-4 py-3 tabular-nums">{formatUsageTime(day.monitoredBrowserSeconds)}</td><td className="px-4 py-3 tabular-nums">{day.activeMonitoredStudents ?? '—'}</td></tr>)}</tbody></table></div>
  </CardContent></Card>;
}

function Report({ report }) {
  const available = report.dataState !== 'unavailable';
  const totals = report.totals;
  const timestamp = value => value ? new Intl.DateTimeFormat('en-US', { timeZone: report.range.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not yet computed';
  return <div className="space-y-5" data-testid="usage-report">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4"><div><h2 className="text-lg font-semibold">{report.scope.label}</h2><p className="text-sm text-muted-foreground">{report.range.from} to {report.range.to} · {report.range.timeZone}</p></div><span className="rounded-full border px-3 py-1 text-xs font-medium">{available ? STATE_LABELS[report.dataState] : 'Unavailable'} · {report.range.computedDays} of {report.range.requestedDays} retained days computed</span></div>
    {report.range.partiallyExpired && <Notice>Part of this range is outside retention. Full-day reports are retained from {report.range.retainedFrom}; earlier dates are unavailable.</Notice>}
    {report.range.partiallyComputed && <Notice>{report.range.unavailableDates.length} retained {report.range.unavailableDates.length === 1 ? 'day is' : 'days are'} unavailable. Totals and sites include only computed days. Missing observations are not zero use.</Notice>}
    {!available ? <div className="rounded-xl border bg-card p-8 text-center"><Clock className="mx-auto mb-3 h-6 w-6 text-muted-foreground" aria-hidden="true" /><h3 className="font-semibold">No report available for this range</h3><p className="mt-2 text-sm text-muted-foreground">No retained day has a completed computation. Choose another range or check again after the next hourly rollup.</p></div> : <>
      {totals.monitoredBrowserSeconds === 0 && <Notice>No browser activity observed in the computed days.</Notice>}
      <div className="grid gap-4 sm:grid-cols-2"><Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Monitored Browser Time</p><p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums" data-testid="usage-total">{formatUsageTime(totals.monitoredBrowserSeconds)}</p><p className="mt-3 text-xs text-muted-foreground">Sum of observed browser time across students in computed days.</p></CardContent></Card><Card><CardContent className="pt-6"><p className="text-sm text-muted-foreground">Students observed</p><p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums" data-testid="usage-students">{totals.activeMonitoredStudents}</p><p className="mt-3 text-xs text-muted-foreground">Distinct students with browser observations in this range; not an enrollment count.</p></CardContent></Card></div>
      <div className="grid gap-3 sm:grid-cols-3">{[['Instructional', totals.instructionalSeconds, 'bg-teal-600'], ['Off-task', totals.offTaskSeconds, 'bg-amber-500'], ['Unknown', totals.unknownSeconds, 'bg-slate-500']].map(([label, seconds, color]) => <div key={label} className="rounded-lg border bg-card p-4"><div className="flex items-center gap-2 text-sm"><span className={`h-2 w-2 rounded-full ${color}`} aria-hidden="true" />{label}</div><p className="mt-2 text-xl font-semibold tabular-nums">{formatUsageTime(seconds)}</p></div>)}</div>
      <p className="text-xs text-muted-foreground">Unknown observations remain unclassified. Teacher-approved activity is excluded from off-task time. Classification is not proof of engagement or learning.</p>
    </>}
    <DailyUsage report={report} />
    {available && <div className="grid gap-4 lg:grid-cols-2"><Sites title="Educational sites" domains={report.topEducationalDomains} /><Sites title="Non-educational sites" domains={report.topNonEducationalDomains} /></div>}
    <div className="space-y-1 text-xs text-muted-foreground"><p>Last computed: {timestamp(report.computedAt)} · Report generated: {timestamp(report.generatedAt)}</p><p>Retention: {report.range.retentionDays} days · Full days retained from {report.range.retainedFrom} · First computed day in this range: {report.range.computedFrom || 'None'}</p><p>Live days can change until finalized after the school day ends.</p></div>
  </div>;
}

function UsagePage({ school, identity }) {
  const [scope, setScope] = useState('school');
  const [id, setId] = useState('');
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState('7d');
  const [clock, setClock] = useState(() => new Date());
  const today = usageLocalDate(clock, school.timezone);
  const [custom, setCustom] = useState(() => ({ from: today, to: today }));
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const exportController = useRef(null);
  const headers = { 'X-School-Id': school.id };
  useEffect(() => { const timer = setInterval(() => setClock(new Date()), 60_000); return () => { clearInterval(timer); exportController.current?.abort(); }; }, []);
  const read = (url, signal) => apiRequest('GET', url, undefined, { headers, signal });
  const students = useQuery({ queryKey: ['usage-students', identity], queryFn: ({ signal }) => read('/admin/teacher-students', signal), enabled: scope === 'student' || scope === 'grade', gcTime: 0 });
  const settings = useQuery({ queryKey: ['usage-grades', identity], queryFn: ({ signal }) => read('/classpilot/admin/settings', signal), enabled: scope === 'grade', gcTime: 0 });
  const classes = useQuery({ queryKey: ['usage-classes', identity], queryFn: ({ signal }) => read('/classpilot/admin/classes?status=all', signal), enabled: scope === 'class', gcTime: 0 });
  const studentList = students.data?.students || [];
  const options = scope === 'class' ? (classes.data?.classes || []).map(group => ({ id: group.id, label: `${group.name}${group.status === 'archived' ? ' (archived)' : ''}` }))
    : scope === 'grade' ? usageGrades(studentList, settings.data?.sections?.rosterGrades?.gradeLevels).map(grade => ({ id: grade, label: `Grade ${grade}` }))
      : studentList.map(student => ({ id: student.id, label: `${student.firstName || ''} ${student.lastName || ''}`.trim() || student.studentName || 'Student' }));
  const directoryLoading = scope === 'class' ? classes.isPending : scope === 'grade' ? students.isPending || settings.isPending : students.isPending;
  const directoryError = scope === 'class' ? classes.error : scope === 'grade' ? students.error || settings.error : students.error;
  const validSelection = scope === 'school' || (!directoryLoading && !directoryError && options.some(option => option.id === id));
  const range = usageDateRange(period, today, custom);
  const query = validSelection ? usageQuery(scope, id, range) : null;
  const report = useQuery({ queryKey: [API, identity, query], queryFn: async ({ signal }) => requireUsageReport(await read(`${API}?${query}`, signal)), enabled: query !== null, gcTime: 0, retry: false });
  const change = callback => { exportController.current?.abort(); setExportError(null); callback(); };
  const download = async () => {
    const controller = new AbortController(); exportController.current = controller; setExporting(true); setExportError(null);
    try {
      const response = await api.get(`${API}?${usageQuery(scope, id, range, 'csv')}`, { headers, signal: controller.signal, responseType: 'blob' });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(response.data), link = document.createElement('a');
      link.href = url; link.download = `monitored-browser-time-${scope}-${range.from}-to-${range.to}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { if (!controller.signal.aborted) setExportError(usageError(error)); }
    finally { if (exportController.current === controller) { exportController.current = null; setExporting(false); } }
  };
  return <div className="max-w-6xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="max-w-2xl"><h2 className="text-xl font-semibold tracking-tight">Browser activity observed by ClassPilot</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Monitored Browser Time covers browser activity observed on managed Chromebooks. It does not measure total device screen time, engagement, or learning.</p></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={!query || report.isFetching} onClick={() => { setClock(new Date()); void report.refetch(); }}><RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />Refresh</Button><Button size="sm" disabled={!query || !report.data || report.isFetching || report.isError || exporting || report.data.dataState === 'unavailable'} onClick={() => { void download(); }}><Download className="mr-2 h-4 w-4" aria-hidden="true" />{exporting ? 'Exporting…' : 'Export CSV'}</Button></div></div>
    <Card><CardContent className="space-y-4 pt-6"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Picker label="Scope" value={scope} onChange={value => change(() => { setScope(value); setId(''); setSearch(''); })}><option value="school">School</option><option value="grade">Grade</option><option value="class">Official class</option><option value="student">Student</option></Picker>
      {scope !== 'school' ? <Picker label={scope === 'class' ? 'Official class' : scope === 'grade' ? 'Grade' : 'Student'} value={id} disabled={directoryLoading || Boolean(directoryError)} onChange={value => change(() => setId(value))}><option value="">{directoryLoading ? 'Loading…' : `Choose a ${scope}`}</option>{options.filter(option => !search || option.id === id || option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(option => <option value={option.id} key={option.id}>{option.label}</option>)}</Picker> : <div className="grid content-center gap-1"><span className="text-xs text-muted-foreground">Reporting school</span><span className="truncate text-sm font-medium">{school.name}</span></div>}
      <Picker label="Date range" value={period} onChange={value => change(() => setPeriod(value))}><option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="custom">Custom range</option></Picker><div className="grid content-center gap-1"><span className="text-xs text-muted-foreground">School time zone</span><span className="text-sm">{school.timezone}</span></div></div>
      {scope === 'student' && <label className="grid max-w-sm gap-2 text-sm font-medium">Find a student<Input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search names" /></label>}
      {period === 'custom' && <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-sm font-medium">Start date<Input type="date" value={custom.from} onChange={event => change(() => setCustom(previous => ({ ...previous, from: event.target.value })))} /></label><label className="grid gap-2 text-sm font-medium">End date<Input type="date" value={custom.to} onChange={event => change(() => setCustom(previous => ({ ...previous, to: event.target.value })))} /></label></div>}
      {scope === 'class' && <p className="text-xs text-muted-foreground">Official class time is attributed to the frozen teaching-session roster. Supervision observations count toward school and student totals without an official class. Grade scope uses students’ current grades.</p>}
      {scope === 'grade' && <p className="text-xs text-muted-foreground">Grade scope groups observations by students’ current grades, not a historical grade snapshot.</p>}
    </CardContent></Card>
    {range.error && <Notice error>{range.error}</Notice>}
    {scope !== 'school' && directoryError && <Notice error>Could not load {scope} choices. {usageError(directoryError)} <Button variant="link" size="sm" onClick={() => { void (scope === 'class' ? classes.refetch() : students.refetch()); if (scope === 'grade') void settings.refetch(); }}>Retry choices</Button></Notice>}
    {scope !== 'school' && !directoryLoading && !directoryError && !validSelection && <p role="status" className="text-sm text-muted-foreground">Choose a {scope} to view its report.</p>}
    {query && report.isPending && <p role="status" className="py-8 text-center text-sm text-muted-foreground">Loading Monitored Browser Time…</p>}
    {query && report.isError && <Notice error>{usageError(report.error)} <Button variant="link" size="sm" onClick={() => { void report.refetch(); }}>Try again</Button></Notice>}
    {exportError && <Notice error>CSV was not exported. {exportError}</Notice>}
    {query && !report.isError && report.data && <Report report={report.data} />}
  </div>;
}

export default function AdminUsage() {
  const { user, activeMembership, activeSchoolId } = useAuth();
  const { school, currentUser, isAdmin, isLoading } = useClassPilotAuth();
  if (isLoading) return <p role="status">Checking administrator access…</p>;
  if (!(isAdmin || currentUser?.isSuperAdmin) || !school?.id) return <Notice error>Administrator access is required for Monitored Browser Time.</Notice>;
  const identity = adminIdentityKey(user, activeMembership, activeSchoolId);
  return <UsagePage key={`${identity}:${school.timezone}`} school={school} identity={identity} />;
}
