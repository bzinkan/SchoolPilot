import { ChevronRight, CircleAlert, FileWarning, Info } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Card, CardDescription, CardHeader } from '../../../components/ui/card';
import { classroomToolName, displayCount, formatAdoptionDate } from '../lib/adoptionHealth';

export function SectionFeedback({ query, label, children }) {
  if (query.isPending) return <p role="status" className="px-5 py-5 text-sm text-muted-foreground">Loading {label.toLowerCase()}…</p>;
  if (query.isError) return <div role="alert" className="m-5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
    <p>Could not load {label.toLowerCase()}.</p><p className="mt-1">The data is unavailable. No reporting conclusion can be drawn.</p>
    <Button variant="outline" size="sm" className="mt-3" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Try again</Button>
  </div>;
  return query.data ? children : null;
}

export function NeedsAttention({ query, page, onPageChange, onSelect, timezone }) {
  const data = !query.isError ? query.data : null;
  return <section aria-labelledby="adoption-needs-attention"><Card>
    <CardHeader className="pb-4"><div className="flex flex-wrap items-center gap-2"><CircleAlert className="h-4 w-4" aria-hidden="true" /><h2 id="adoption-needs-attention" className="text-base font-semibold">Needs attention</h2>
      {data && <span className={`rounded px-2 py-0.5 text-xs ${data.total > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>{displayCount(data.total)} confirmed {data.total === 1 ? 'failure' : 'failures'}</span>}
    </div><CardDescription>Recorded summary-generation failures with supporting error evidence.</CardDescription></CardHeader>
    <SectionFeedback query={query} label="confirmed failures">
      {data?.total === 0 ? <div className="border-t px-5 py-6"><p className="text-sm font-medium">No confirmed failures recorded</p><p className="mt-1 text-xs text-muted-foreground">This does not establish that all monitoring was available.</p></div>
        : <><div>{data?.failures.map(failure => <article key={failure.teachingSessionId} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 border-t px-5 py-5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
          <span className="rounded-md bg-destructive/10 p-2 text-destructive"><FileWarning className="h-4 w-4" aria-hidden="true" /></span>
          <div className="min-w-0"><p className="text-sm font-medium">Session summary unavailable for {failure.className}</p><p className="mt-1 text-xs text-muted-foreground">{failure.teacherName} · {formatAdoptionDate(failure.windowEnd, timezone)}</p>
            <p className="mt-2 text-sm">{failure.attemptCount > 0 ? `Summary generation failed after ${failure.attemptCount} ${failure.attemptCount === 1 ? 'attempt' : 'attempts'}.` : 'Summary generation failed.'}</p></div>
          <Button variant="outline" size="sm" className="col-start-2 justify-self-start sm:col-start-auto sm:self-center" onClick={() => onSelect({ id: failure.teachingSessionId, name: failure.className })}>View status<ChevronRight className="ml-1 h-3 w-3" aria-hidden="true" /></Button>
        </article>)}</div>
        {data && data.total > data.pageSize && <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground"><span>Page {page} of {Math.ceil(data.total / data.pageSize)} · {displayCount(data.total)} failures</span><div className="flex gap-2"><Button variant="outline" size="sm" aria-label="Previous failures" disabled={page <= 1 || query.isFetching} onClick={() => onPageChange(page - 1)}>Previous</Button><Button variant="outline" size="sm" aria-label="Next failures" disabled={page * data.pageSize >= data.total || query.isFetching} onClick={() => onPageChange(page + 1)}>Next</Button></div></div>}
      </>}
    </SectionFeedback>
  </Card></section>;
}

export function Disclosure({ title, description, summary, open, onToggle, children, panel = false }) {
  return <details open={open} onToggle={event => onToggle(event.currentTarget.open)} className={`group min-w-0 ${panel ? 'overflow-hidden rounded-lg border bg-card text-card-foreground' : 'border-b'}`}>
    <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)] items-center gap-2 px-1 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:grid-cols-[auto_minmax(0,1fr)_auto] [&::-webkit-details-marker]:hidden">
      <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 ${panel ? 'ml-4' : ''}`} aria-hidden="true" />
      <span className={`min-w-0 ${panel ? 'mr-5 sm:mr-0' : ''}`}><span className="block text-sm font-medium">{title}</span>{description && <span className="mt-1 block text-xs text-muted-foreground">{description}</span>}</span>
      {summary && <span className={`col-start-2 text-xs text-muted-foreground sm:col-start-auto ${panel ? 'mr-5' : ''}`}>{summary}</span>}
    </summary>{open && children}
  </details>;
}

export function ReportingAvailability({ query, readyCount, open, onToggle, onSelect, timezone }) {
  const data = query.data;
  return <Disclosure panel title="Reporting availability" description="Observation coverage and unavailable data" summary={readyCount === undefined ? null : `${displayCount(readyCount)} summaries ready`} open={open} onToggle={onToggle}>
    <SectionFeedback query={query} label="reporting availability"><div className="border-t">
      <div className="space-y-2 px-5 py-4 text-sm"><p>{data?.reportCounts.ready ? `${displayCount(data.summariesWithMissingObservations)} of ${displayCount(data.reportCounts.ready)} ready summaries include missing observations.` : 'No ready summaries are available for observation coverage in this period.'}</p>
        <p className="text-xs text-muted-foreground">Missing observations have an unknown cause and do not establish a failure. Sleep or connectivity changes may explain them.</p>
        <p className="text-xs text-muted-foreground">Overall observed coverage: <span className="tabular-nums">{data?.coveragePercent == null ? '—' : `${data.coveragePercent}%`}</span>. Coverage uses total observed time divided by total eligible time in ready summaries.</p>
      </div>
      {data?.classes.map(row => <article key={row.groupId} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 border-t px-5 py-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]"><Info className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0"><p className="text-sm font-medium">{row.className} · {row.coveragePercent == null ? 'Coverage unavailable' : `${row.coveragePercent}% observed coverage`}</p><p className="mt-1 text-xs text-muted-foreground">{row.teacherName} · {displayCount(row.summariesWithMissingObservations)} of {displayCount(row.readySummaryCount)} ready summaries include missing observations. Cause unknown.</p><p className="mt-1 text-xs text-muted-foreground">Latest completed session: {formatAdoptionDate(row.lastSessionEnd, timezone)}</p></div>
        <Button variant="outline" size="sm" className="col-start-2 justify-self-start sm:col-start-auto sm:self-center" onClick={() => onSelect({ id: row.latestReadySessionId, name: row.className })}>View latest summary</Button></article>)}
      <div className="flex flex-wrap gap-x-4 gap-y-2 border-t px-5 py-3 text-xs text-muted-foreground"><span>{displayCount(data?.reportCounts.ready)} ready</span><span>{displayCount(data?.reportCounts.preparing)} preparing</span><span>{displayCount(data?.reportCounts.failed)} generation failed</span><span>{displayCount(data?.reportCounts.unavailable)} unavailable</span></div>
      <p className="border-t px-5 py-3 text-xs text-muted-foreground">Monitoring not expected: {displayCount(data?.notExpectedStudentRecords)} student records across class sessions. Student records unavailable: {displayCount(data?.unavailableStudentRecords)}. These are not unique-student or attendance counts.</p>
    </div></SectionFeedback>
  </Disclosure>;
}

export function ClassroomTools({ query, open, onToggle }) {
  return <Disclosure title="Classroom tools used" summary={query.data && !query.isError ? `${displayCount(query.data.totalActions)} recorded actions` : null} open={open} onToggle={onToggle}>
    <SectionFeedback query={query} label="classroom tools"><div className="px-6 pb-4"><dl className="max-w-lg space-y-3 text-sm">{query.data?.tools.map(row => <div className="flex justify-between gap-3" key={row.commandType}><dt>{classroomToolName(row.commandType)}</dt><dd className="tabular-nums">{displayCount(row.count)}</dd></div>)}</dl>
      {query.data?.totalActions === 0 && <p className="text-sm text-muted-foreground">No classroom actions recorded in these completed sessions.</p>}<p className="mt-4 text-xs text-muted-foreground">Each action counts once, regardless of students targeted. Monitoring without actions is not counted.</p></div></SectionFeedback>
  </Disclosure>;
}

export function ObservedClients({ query, open, onToggle }) {
  return <Disclosure title="Chromebook reporting details" summary={query.data && !query.isError ? `${displayCount(query.data.totalClients)} clients observed` : null} open={open} onToggle={onToggle}>
    <SectionFeedback query={query} label="Chromebook reporting details"><div className="px-6 pb-4"><dl className="max-w-lg space-y-3 text-sm">{query.data?.versions.map(row => <div className="flex justify-between gap-3" key={row.version ?? 'unknown'}><dt>{row.version || 'Version not reported'}</dt><dd className="tabular-nums">{displayCount(row.count)}</dd></div>)}</dl>
      {query.data?.totalClients === 0 && <p className="text-sm text-muted-foreground">No client check-ins are available for these completed sessions.</p>}<p className="mt-4 text-xs text-muted-foreground">Latest extension versions observed within completed class windows, limited to retained check-ins. These counts are not a verified Chromebook inventory or managed deployment count.</p></div></SectionFeedback>
  </Disclosure>;
}
