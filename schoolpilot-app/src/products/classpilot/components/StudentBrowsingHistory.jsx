import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { useAuth } from '../../../contexts/AuthContext';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { formatDuration } from '../../../lib/classpilot-utils';

const historyFailure = error => error?.response?.data?.state || ([403, 404].includes(error?.response?.status) ? 'denied' : error?.response?.status === 503 ? 'unavailable' : 'failed');
const stateText = {
  empty: 'No observations were recorded in the selected accessible dates.',
  expired: 'These dates fall outside the school’s browsing retention period.',
  denied: 'You can view browsing only during classes or supervision you actually taught.',
  unavailable: 'Browsing history is temporarily unavailable. Try again.',
  failed: 'The history request failed. Retry to load these dates.',
};
function safeLink(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
function observationTime(value, timeZone) { return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }

export default function StudentBrowsingHistory({ studentId }) {
  const { activeMembership, user } = useAuth();
  const [dates, setDates] = useState({ startDate: '', endDate: '' });
  const params = new URLSearchParams(Object.entries(dates).filter(([, value]) => value));
  const base = `/classpilot/students/${encodeURIComponent(studentId)}/browsing-history`;
  const key = ['student-browsing-history', activeMembership?.schoolId, user?.id, activeMembership?.id, activeMembership?.role, studentId, dates.startDate, dates.endDate];
  const invalidRange = dates.startDate && dates.endDate && dates.startDate > dates.endDate;
  const domains = useQuery({ queryKey: [...key, 'domains'], queryFn: ({ signal }) => apiRequest('GET', `${base}/domains?${params}`, undefined, { signal }), enabled: Boolean(studentId) && !invalidRange, retry: false });
  const history = useInfiniteQuery({ queryKey: key, initialPageParam: null, queryFn: ({ pageParam, signal }) => { const query = new URLSearchParams(params); query.set('limit', '100'); if (pageParam) query.set('cursor', pageParam); return apiRequest('GET', `${base}?${query}`, undefined, { signal }); }, getNextPageParam: page => page.nextCursor || undefined, enabled: Boolean(studentId) && !invalidRange, retry: false });
  const meta = history.data?.pages[0] || domains.data;
  const entries = history.data?.pages.flatMap(page => page.entries) || [];
  const state = history.error ? historyFailure(history.error) : meta?.state;
  const timeZone = meta?.timeZone || 'America/New_York';
  return <div className="space-y-5" data-testid="student-browsing-history">
    <div className="space-y-2"><h3 className="text-sm font-semibold">Browsing history</h3><div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-xs"><span className="block">Start date</span><input type="date" aria-label="History start date" data-testid="history-start-date" value={dates.startDate || meta?.startDate || ''} className="rounded-md border bg-background px-3 py-2 text-sm" onChange={event => setDates(previous => ({ startDate: event.target.value, endDate: previous.endDate || meta?.endDate || event.target.value }))} /></label>
      <label className="space-y-1 text-xs"><span className="block">End date</span><input type="date" aria-label="History end date" data-testid="history-end-date" value={dates.endDate || meta?.endDate || ''} className="rounded-md border bg-background px-3 py-2 text-sm" onChange={event => setDates(previous => ({ startDate: previous.startDate || meta?.startDate || event.target.value, endDate: event.target.value }))} /></label>
      <Button size="sm" variant="outline" onClick={() => setDates({ startDate: '', endDate: '' })}>Today</Button>
    </div><p className="text-xs text-muted-foreground">Dates and times use {timeZone}.{meta?.retentionDays ? ` Detailed browsing is retained for ${meta.retentionDays} days.` : ''}{meta?.scope === 'supervised_intervals' ? ' Only your supervised intervals are included.' : ''}</p>
      {invalidRange && <p role="alert" className="text-sm text-destructive">The end date must be on or after the start date.</p>}
      {meta?.partiallyExpired && <p className="text-xs text-amber-700 dark:text-amber-400">Part of this date range has expired. Only retained observations are shown.</p>}
    </div>
    <section className="space-y-2" aria-label="Top domains by day"><h4 className="text-sm font-medium">Top domains by day</h4>
      {domains.isPending && !invalidRange && <p className="text-xs text-muted-foreground">Loading day summaries…</p>}
      {domains.data?.days?.map(day => <div key={day.date} className="rounded-lg border p-3"><p className="mb-2 text-sm font-medium">{day.date}</p><div className="space-y-1">{day.domains.map(domain => <div key={domain.domain} className="flex items-center justify-between gap-3 text-xs"><span className="min-w-0 break-all">{domain.domain}{domain.contentCategory && <span className="ml-2 text-muted-foreground">{domain.contentCategory}</span>}</span><span className="shrink-0 text-muted-foreground">~{formatDuration(domain.seconds)}</span></div>)}</div></div>)}
      {domains.data?.note && <p className="text-xs text-muted-foreground">{domains.data.note}</p>}
      {domains.error && <p className="text-xs text-muted-foreground">{stateText[historyFailure(domains.error)]}</p>}
    </section>
    <section className="space-y-2" aria-label="Observed browsing"><h4 className="text-sm font-medium">Observed browsing</h4><p className="text-xs text-muted-foreground">Durations estimate time between observations at most 60 seconds apart. Gaps, unsupported intervals and the final observation add no time.</p>
      {history.isPending && !invalidRange && <p role="status" className="text-sm">Loading observations…</p>}
      {!history.isPending && !invalidRange && entries.length === 0 && stateText[state] && <p role={history.error ? 'alert' : 'status'} className="rounded-lg border p-5 text-sm text-muted-foreground">{stateText[state]}</p>}
      {entries.map(entry => { const link = safeLink(entry.activeTabUrl); return <article key={entry.id} className="space-y-1 rounded-lg border p-3" data-testid="history-observation"><div className="flex flex-wrap items-start justify-between gap-2"><p className="min-w-0 break-words text-sm font-medium">{entry.activeTabTitle || 'Browser observation'}</p>{entry.aiCategory === 'non-educational' && <Badge variant="destructive">Off-task{entry.contentCategory ? `: ${entry.contentCategory}` : ''}</Badge>}</div>
        {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-primary underline">{entry.activeTabUrl}</a> : <p className="break-all text-xs text-muted-foreground">{entry.activeTabUrl || 'No page URL recorded'}</p>}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{observationTime(entry.timestamp, timeZone)}</span><span>{entry.estimatedSeconds > 0 ? `~${formatDuration(entry.estimatedSeconds)}` : 'Observation only'}</span>{entry.screenLocked && <span>Waypoint</span>}{entry.cameraActive && <span>Camera active</span>}</div>
      </article>; })}
      {history.error && entries.length > 0 && <p role="alert" className="text-sm text-destructive">{stateText[state]}</p>}
      {history.error && <Button variant="outline" size="sm" onClick={() => history.refetch()}>Retry history</Button>}
      {history.hasNextPage && <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>{history.isFetchingNextPage ? 'Loading…' : 'Load older observations'}</Button>}
      {entries.length > 0 && <p className="text-xs text-muted-foreground">Showing {entries.length} observations{history.hasNextPage ? '' : ' · End of retained results'}</p>}
    </section>
  </div>;
}
