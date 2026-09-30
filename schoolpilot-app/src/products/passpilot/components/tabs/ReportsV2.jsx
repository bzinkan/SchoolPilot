import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import { reportError, reportRequest } from '../../reportData';
import { reportDuration, reportFilters, reportRatio, reportSchoolDate, reportScope, shiftReportDate, validateReportPage } from '../../reportModel';

const field = 'w-full rounded-md border bg-background px-3 py-2 text-sm';
const coverageLabels = { RECORDED_DENIALS_BEST_EFFORT: 'Recorded denials are best effort; some attempts may not have been recorded.',
  RETAINED_RECORDS_ONLY: 'Deleted records and retention gaps cannot be reconstructed. These counts cover retained records only.',
  HISTORICAL_BELL_PERIODS_UNAVAILABLE: 'Historical bell periods were not captured. Busiest times use school-local hours.',
  APPOINTMENT_FILTER_UNAVAILABLE: 'Appointment outcomes are unavailable with issuer or channel filters.',
  INVALID_COMPLETED_TIMESTAMPS: 'Some completed passes have invalid historical timestamps.',
  INVALID_PASS_DEADLINES: 'Some historical deadlines cannot be verified.' };
function Metric({ label, children }) { return <div className="rounded-md border p-3"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-semibold">{children}</dd></div>; }

export default function ReportsV2({ user, school, capabilities }) {
  const timeZone = capabilities.schoolTimezone, [schoolId, viewerId, authVersion, roles] = reportScope(user, school), cache = useQueryClient(), pendingExport = useRef(null);
  const scope = useMemo(() => [schoolId, viewerId, authVersion, roles], [schoolId, viewerId, authVersion, roles]);
  const [today] = useState(() => reportSchoolDate(Date.now(), timeZone));
  const [values, setValues] = useState({ fromDate: today, throughDate: today, classFilter: '', teacherId: '', studentId: '', destination: '', issuedVia: '' });
  const [message, setMessage] = useState(''), [exporting, setExporting] = useState(false), [denied, setDenied] = useState(false), [snapshotChanged, setSnapshotChanged] = useState(false);
  const key = ['passpilot-reports-v2', ...scope], filters = useMemo(() => {
    try { return { params: reportFilters(values, timeZone) }; } catch (error) { return { error: error.message }; }
  }, [values, timeZone]);
  const fail = async error => {
    if ([401, 403].includes(error.response?.status)) { setDenied(true); cache.removeQueries({ queryKey: key }); }
    if (error.response?.data?.code === 'PASSPILOT_REPORT_SNAPSHOT_CHANGED') setSnapshotChanged(true);
    setMessage(await reportError(error));
  };
  const load = async (path, signal) => {
    try { return await reportRequest(school.id, path, signal); }
    catch (error) { if (!signal?.aborted) await fail(error); throw error; }
  };
  const classes = useQuery({ queryKey: [...key, 'classes'], enabled: !denied, retry: false,
    queryFn: ({ signal }) => load('/passpilot/classes?scope=history', signal) });
  const issuers = useQuery({ queryKey: [...key, 'issuers'], enabled: !denied && capabilities.scope === 'school', retry: false,
    queryFn: ({ signal }) => load('/passpilot/passes/issuers', signal) });
  const queryString = new URLSearchParams(filters.params || {}).toString(), canRequest = !filters.error && !denied, enabled = canRequest && !snapshotChanged;
  const summary = useQuery({ queryKey: [...key, 'summary', queryString], enabled, retry: false, refetchInterval: 30000,
    queryFn: async ({ signal }) => {
      const result = await load(`/passpilot/reports/summary?${queryString}`, signal);
      if (result?.version !== 2 || result.schoolTimezone !== timeZone || !result.counts || !Array.isArray(result.coverage?.codes) || !Array.isArray(result.destinations)
        || !Array.isArray(result.periods?.buckets)) throw new Error('The report response could not be verified. Refresh the report.');
      return result;
    } });
  const pages = useInfiniteQuery({ queryKey: [...key, 'passes', queryString], enabled, retry: false, initialPageParam: null,
    queryFn: async ({ pageParam, signal }) => validateReportPage(await load(`/passpilot/reports/passes?${queryString}&limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, signal)),
    getNextPageParam: (last, all) => {
      if (!last.hasMore) return undefined;
      if (all.slice(0, -1).some(page => page.nextCursor === last.nextCursor)) throw new Error('Report pagination did not advance. Refresh the report.');
      return last.nextCursor;
    } });
  useEffect(() => () => { pendingExport.current?.abort(); cache.removeQueries({ queryKey: ['passpilot-reports-v2', ...scope] }); }, [cache, scope]);
  const update = patch => { pendingExport.current?.abort(); setExporting(false); setMessage(''); setSnapshotChanged(false); setValues(current => ({ ...current, ...patch })); };
  const refresh = async () => {
    setMessage('');
    await Promise.all([cache.resetQueries({ queryKey: [...key, 'summary'] }), cache.resetQueries({ queryKey: [...key, 'passes'] })]);
    setSnapshotChanged(false);
  };
  const exportCsv = async kind => {
    const controller = new AbortController(); pendingExport.current = controller; setExporting(true); setMessage('');
    try {
      const blob = await reportRequest(school.id, `/passpilot/reports/export.csv?${queryString}&kind=${kind}`, controller.signal, 'blob');
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      try { link.href = url; link.download = `PassPilot-${kind}-${values.fromDate}-${values.throughDate}.csv`; document.body.append(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      setMessage('CSV downloaded. The server recorded this export.');
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error.response?.data instanceof Blob) { try { error.response.data = JSON.parse(await error.response.data.text()); } catch { /* retain generic transport error */ } }
        await fail(error);
      }
    }
    finally { if (!controller.signal.aborted) setExporting(false); }
  };
  const data = summary.isError || denied || snapshotChanged ? null : summary.data, rows = pages.isError || denied || snapshotChanged ? [] : pages.data?.pages.flatMap(page => page.passes) || [];
  const dateTime = value => value ? new Date(value).toLocaleString('en-US', { timeZone }) : '—';
  return <div className="space-y-4 p-4"><header><h2 className="text-xl font-semibold">PassPilot reports</h2><p className="text-sm text-muted-foreground">{capabilities.scope === 'school' ? 'School pass history' : 'Authorized teacher history'} · {timeZone}</p></header>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div><Label htmlFor="report-from">From date</Label><Input id="report-from" type="date" value={values.fromDate} onChange={event => update({ fromDate: event.target.value })} /></div>
      <div><Label htmlFor="report-through">Through date</Label><Input id="report-through" type="date" value={values.throughDate} onChange={event => update({ throughDate: event.target.value })} /></div>
      <div><Label htmlFor="report-class">Class</Label><select id="report-class" className={field} value={values.classFilter} disabled={classes.isLoading || classes.isError} onChange={event => update({ classFilter: event.target.value })}><option value="">All authorized classes</option>{(classes.data?.classes || []).map(item => {
        const kind = item.filterKey?.type || (item.legacyGradeId || item.historyOnly ? 'gradeId' : 'classId'), id = item.filterKey?.value || item.legacyGradeId || item.classId || item.id;
        return <option key={`${kind}:${id}`} value={`${kind}:${id}`}>{item.name}{item.historyOnly ? ' (History only)' : item.status && item.status !== 'active' ? ' (Archived)' : ''}</option>;
      })}</select></div>
      {capabilities.scope === 'school' ? <div><Label htmlFor="report-issuer">Issuer</Label><select id="report-issuer" className={field} value={values.teacherId} disabled={issuers.isLoading || issuers.isError} onChange={event => update({ teacherId: event.target.value })}><option value="">All issuers</option>{(issuers.data?.issuers || []).map(issuer => <option key={issuer.id} value={issuer.id}>{issuer.displayName || issuer.name || 'Former staff member'}{issuer.status === 'former' ? ' (Former staff)' : ''}</option>)}</select></div> : null}
      <div><Label htmlFor="report-destination">Destination</Label><select id="report-destination" className={field} value={values.destination} onChange={event => update({ destination: event.target.value })}><option value="">All destinations</option>{['bathroom', 'nurse', 'office', 'counselor', 'other_classroom', 'custom'].map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></div>
      <div><Label htmlFor="report-channel">Issued through</Label><select id="report-channel" className={field} value={values.issuedVia} onChange={event => update({ issuedVia: event.target.value })}><option value="">All channels</option><option value="teacher">Teacher</option><option value="kiosk">Kiosk</option></select></div></div>
    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => update({ fromDate: shiftReportDate(today, -6), throughDate: today })}>Last 7 school dates</Button><Button variant="outline" disabled={!canRequest || summary.isFetching || pages.isFetching} onClick={refresh}>Refresh report</Button><Button disabled={!enabled || exporting || !data} onClick={() => exportCsv('summary')}>Export summary CSV</Button><Button disabled={!enabled || exporting || !data} onClick={() => exportCsv('passes')}>Export passes CSV</Button></div>
    {values.studentId ? <p className="text-sm">Filtered to the selected student. <Button variant="outline" size="sm" onClick={() => update({ studentId: '' })}>Clear student filter</Button></p> : null}
    {filters.error ? <p role="alert">{filters.error}</p> : null}{message ? <p role="status">{message}</p> : null}
    {denied ? <p role="alert">Report access changed. Refresh this page before continuing.</p> : null}
    {snapshotChanged ? <p role="alert">Report records changed during the request. Refresh the report to load a consistent snapshot.</p> : null}
    {summary.isLoading && enabled ? <p role="status">Loading report…</p> : null}{summary.isError ? <p role="alert">{summary.error.message}</p> : null}
    {classes.isError || issuers.isError ? <p role="alert">Some filters could not be loaded. Refresh the page to retry.</p> : null}
    {data ? <><p className="text-sm text-muted-foreground">As of {dateTime(data.asOf)}. {data.coverage.state === 'no_data' ? 'No retained records in this range; this does not establish that no events occurred.' : 'Coverage is partial. Only retained, authorized records are included.'}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{data.coverage.codes.map(code => <li key={code}>{coverageLabels[code] || 'Some historical report data could not be verified.'}</li>)}</ul>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Passes issued">{data.counts.total}</Metric><Metric label="Completed average duration">{reportDuration(data.completedDuration.averageSeconds)}</Metric><Metric label="Completed overdue rate">{reportRatio(data.completedOverdueRate)}</Metric><Metric label="Currently overdue open passes">{data.currentlyOverdueCount} of {data.openCount} open</Metric><Metric label="Cancelled passes">{data.counts.canceled}</Metric><Metric label="Recorded denials (best effort)">{data.recordedDenials.count}</Metric>
        {capabilities.administratorEvidence && data.overrides ? <Metric label="Recorded rule overrides">{data.overrides.count}</Metric> : null}
        {data.appointments ? <Metric label="Missed appointments (ended windows)">{reportRatio(data.appointments.missedRate)}</Metric> : null}</dl>
      <p className="text-sm text-muted-foreground">Completed duration uses valid return timestamps without rounding before averaging. Completed overdue rate includes only valid returned passes with a valid deadline; open and cancelled passes are excluded.</p>
      {data.appointments ? <p className="text-sm text-muted-foreground">Appointment outcomes: {data.appointments.completed} completed, {data.appointments.activated} with a pass open, {data.appointments.missed} missed, {data.appointments.cancelled} cancelled. Future, still-open and cancelled windows are excluded from the missed-rate denominator. Historical class filtering uses the current student roster.</p> : null}
      <div className="grid gap-4 sm:grid-cols-2"><section className="rounded-md border p-3"><h3 className="font-semibold">Destinations</h3><ul>{data.destinations.map(item => <li key={item.destination} className="flex justify-between gap-3"><span>{item.destination.replaceAll('_', ' ')}</span><span>{item.count}</span></li>)}</ul></section><section className="rounded-md border p-3"><h3 className="font-semibold">Busiest school-local hours</h3><p className="text-xs text-muted-foreground">Hourly issuance counts. Historical bell periods are unavailable.</p><ul>{data.periods.buckets.map(item => <li key={item.hour} className="flex justify-between gap-3"><span>{item.label}</span><span>{item.count}</span></li>)}</ul></section></div></> : null}
    <section><h3 className="mb-2 font-semibold">Pass history</h3>{pages.isLoading && enabled ? <p role="status">Loading pass history…</p> : null}{pages.isError ? <p role="alert">{pages.error.message}</p> : null}
      <div className="max-w-full overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Student', 'Issuer / class', 'Destination', 'Status', 'Issued', 'Returned', 'Completed duration'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-t"><td className="p-2"><button className="text-primary underline" aria-label={`Filter to ${row.studentName}`} onClick={() => update({ studentId: row.studentId })}>{row.studentName}</button></td><td className="p-2">{row.teacherName || 'Former staff'}<br />{row.className || 'Unattributed'}</td><td className="p-2">{row.customDestination || row.destination?.replaceAll('_', ' ')}</td><td className="p-2">{row.status}{row.currentlyOverdue ? ' · Currently overdue' : ''}</td><td className="p-2">{dateTime(row.issuedAt)}</td><td className="p-2">{dateTime(row.returnedAt)}</td><td className="p-2">{reportDuration(row.completedDurationSeconds)}</td></tr>)}</tbody></table></div>
      {pages.isSuccess && !rows.length ? <p>No retained pass history for these filters.</p> : null}{pages.hasNextPage ? <Button className="mt-3" variant="outline" disabled={pages.isFetchingNextPage || denied} onClick={() => pages.fetchNextPage()}>Load more passes</Button> : null}
    </section></div>;
}
