import { useMemo, useState } from 'react';
import { cancellationState, historyRemovalState, scheduleDateText } from './useScheduleOverviewClock';
import { CalendarDays, ChevronDown, Copy, MoreHorizontal, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu';

const EMPTY = [];
const countText = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
const outcomes = [
  ['active', 'active'], ['releasing', 'ending'], ['failed', 'could not start'], ['missed', 'missed'],
  ['unknown', 'status unavailable'], ['pending', 'awaiting start'], ['ended', 'finished'], ['cancelled', 'cancelled'],
];
const statusLabels = { pending: 'Awaiting start', active: 'Active', ended: 'Finished', failed: 'Could not start', missed: 'Missed', cancelled: 'Cancelled', releasing: 'Ending' };
const phaseLabels = { future: 'Scheduled', today: 'Applied today', past: 'Past date', cancelled: 'Cancelled', no_changes: 'No changes on this date' };
const cancelReasons = {
  started: 'Cancellation closed when the first affected class or testing window started.',
  cancelled: 'This application has been cancelled.',
  unavailable: 'Cancellation availability could not be checked. Refresh status to try again.',
  no_changes: 'No scheduled changes are associated with these dates.',
};

function timeText(value) {
  if (!value) return 'Does not meet';
  const format = time => {
    const [hour, minute] = time.split(':').map(Number);
    return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  };
  return `${format(value.startTime)}–${format(value.endTime)}`;
}

function changeText(customTimes, skippedClasses, testingBlocks) {
  return [testingBlocks && countText(testingBlocks, 'testing block'), customTimes && countText(customTimes, 'custom class time'), skippedClasses && countText(skippedClasses, 'skipped class', 'skipped classes')].filter(Boolean).join(' · ');
}

function TestingOutcomeSummary({ dates, fallbackCount, unavailable }) {
  const counts = {};
  for (const date of dates || EMPTY) for (const [key] of outcomes) counts[key] = (counts[key] || 0) + (date.testingOutcomes?.[key] || 0);
  if (unavailable || !dates) return <p className="text-sm text-muted-foreground">{fallbackCount ? `${countText(fallbackCount, 'testing block')} · Status unavailable` : 'Application status unavailable'}</p>;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (!total) return <p className="text-sm text-muted-foreground">No testing blocks</p>;
  return <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">{outcomes.filter(([key]) => counts[key]).map(([key, label]) => <span key={key} className={['failed', 'missed'].includes(key) ? 'font-medium text-destructive' : key === 'unknown' ? 'text-muted-foreground' : ''}>{countText(counts[key], 'testing block')} {label}</span>)}</p>;
}

function ApplicationRow({ application, summary, catalog, testingStatuses, statusReasons, unavailable, serverNow, latestServerNow, busy, blocked, onCancel, onDeleteHistory, expanded, onToggle }) {
  const cancelled = application.status === 'cancelled';
  const dates = [...application.dates].sort();
  const today = catalog.schoolLocalToday;
  const effectiveDates = summary?.dates.filter(date => date.phase !== 'no_changes') || EMPTY;
  const next = effectiveDates.filter(date => date.date >= today).map(date => date.date).sort()[0];
  const phase = cancelled ? 'cancelled' : effectiveDates.some(date => date.phase === 'today') ? 'today' : effectiveDates.some(date => date.phase === 'future') ? 'future' : effectiveDates.length ? 'past' : 'no_changes';
  const cancellation = cancellationState(application, summary, serverNow, unavailable, latestServerNow);
  const historyRemoval = historyRemovalState(application, summary, unavailable);
  const allDatesPast = dates.length > 0 && dates.every(date => date < today);
  const label = `${application.profileName} ${application.dates.join(', ')}`;
  const detailId = `application-details-${application.id}`;
  const classNames = new Map(catalog.classes.map(row => [row.id, row.name]));
  const classTimeCount = summary?.dates.reduce((sum, date) => sum + date.customTimeCount, 0);
  const skippedCount = summary?.dates.reduce((sum, date) => sum + date.skippedClassCount, 0);
  return <article aria-label={`${application.profileName} application`} data-application-id={application.id} className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-2">
        <h4 className="break-words font-semibold">{dates.length === 1 ? scheduleDateText(dates[0]) : `${dates.length} applied dates`} · {application.profileName}</h4>
        <div className="flex flex-wrap gap-2"><Badge variant="secondary">{cancelled ? 'Cancelled' : unavailable ? 'Date status unavailable' : phaseLabels[phase]}</Badge>{!catalog.profiles.some(profile => profile.id === application.profileId) && <Badge variant="outline">Saved profile deleted</Badge>}</div>
        {dates.length > 1 && <p className="text-sm text-muted-foreground">{scheduleDateText(dates[0])}–{scheduleDateText(dates.at(-1))}{!cancelled && next && !unavailable ? ` · ${next === today ? 'Applied today' : `Next: ${scheduleDateText(next)}`}` : ''}</p>}
      </div>
      {cancellation.canRequest && <Button size="sm" variant="outline" disabled={busy || blocked} onClick={event => onCancel(application, event.currentTarget)}>Cancel application<span className="sr-only"> {application.profileName}</span></Button>}
      {historyRemoval.canRequest && <Button size="sm" variant="outline" className="text-destructive" disabled={busy || blocked} onClick={event => onDeleteHistory(application, event.currentTarget)}><Trash2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />Delete from history<span className="sr-only"> {label}</span></Button>}
    </div>
    <TestingOutcomeSummary dates={summary?.dates} fallbackCount={application.testingWindows?.length || 0} unavailable={unavailable} />
    {summary && (classTimeCount > 0 || skippedCount > 0) && <p className="text-sm">{changeText(classTimeCount, skippedCount, 0)}</p>}
    {!cancellation.canRequest && <p className="max-w-3xl text-xs text-muted-foreground">{cancelReasons[cancellation.reason] || cancelReasons.unavailable}</p>}
    {allDatesPast && !historyRemoval.canRequest && <p className="text-xs text-muted-foreground">{historyRemoval.reason === 'supervision_pending' ? 'History can be removed after all supervision has ended and testing status is settled.' : 'History removal availability could not be confirmed. Refresh status to check again.'}</p>}
    <Button size="sm" variant="ghost" className="-ml-2" aria-expanded={expanded} aria-controls={detailId} aria-label={`${expanded ? 'Hide' : 'View'} details ${label}`} onClick={onToggle}><ChevronDown className={`mr-1.5 h-4 w-4 ${expanded ? 'rotate-180' : ''}`} />{expanded ? 'Hide details' : 'View details'}</Button>
    <div id={detailId} hidden={!expanded} className="space-y-4 border-t pt-4">
      {expanded && dates.map(date => {
        const day = summary?.dates.find(row => row.date === date);
        const windows = (application.testingWindows || EMPTY).filter(window => window.date === date);
        const classes = Object.entries(application.classWindows?.[date] || {});
        return <section key={date} aria-label={`Applied date ${date}`} className="space-y-2">
          <h5 className="text-sm font-semibold">{scheduleDateText(date)} <span className="font-normal text-muted-foreground">· {cancelled ? 'Cancelled' : unavailable || !day ? 'Status unavailable' : phaseLabels[day.phase]}</span></h5>
          {!classes.length && !windows.length && <p className="text-sm text-muted-foreground">No scheduled changes on this date.</p>}
          {classes.length > 0 && <div className="space-y-1.5"><p className="text-xs font-medium">Applied class changes</p>{classes.map(([id, window]) => <p key={id} className="flex flex-wrap justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm"><span>{classNames.get(id) || 'Unavailable class'}</span><span>{timeText(window)}</span></p>)}<p className="text-xs text-muted-foreground">Times are saved with this application. Class names reflect current Class Management labels.</p></div>}
          {windows.map((window, index) => {
            const status = unavailable ? null : testingStatuses.get(`${application.id}:${date}:${window.blockId}`);
            const outcome = unavailable ? 'unknown' : day?.testingStatusByBlock?.[window.blockId] || 'unknown';
            return <div key={`${window.blockId}-${index}`} className="rounded-md bg-muted/50 px-3 py-2 text-sm"><p className="flex flex-wrap justify-between gap-2"><span>{window.name}</span><span>{timeText(window)} · <span className="font-medium">{statusLabels[outcome] || 'Status unavailable'}</span></span></p>{['failed', 'missed'].includes(outcome) && <><p className="mt-1 text-destructive">{statusReasons[status?.code] || statusReasons.ACTIVATION_FAILED}</p><p className="mt-1 text-xs text-muted-foreground">Use Coverage to manage any testing still needed today. Failed or missed windows do not restart automatically.</p></>}</div>;
          })}
        </section>;
      })}
    </div>
  </article>;
}

export default function ScheduleProfilesOverview({ data, busy, blocked, refreshing, statusUnavailable, serverNow, latestServerNow, testingStatuses, statusReasons, onOpen, onDelete, onCancel, onDeleteHistory, onRefresh, applicationsHeadingRef }) {
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const profiles = useMemo(() => [...data.profiles].sort((a, b) => a.definition.name.localeCompare(b.definition.name) || a.id.localeCompare(b.id)), [data.profiles]);
  const summaries = data.applicationSummaries;
  const applicationsByProfile = useMemo(() => {
    const result = new Map();
    for (const application of data.applications) {
      const entries = result.get(application.profileId) || [];
      entries.push(application); result.set(application.profileId, entries);
    }
    return result;
  }, [data.applications]);
  const grouped = useMemo(() => {
    const nextDate = application => summaries?.[application.id]?.dates.filter(date => date.date >= data.schoolLocalToday && date.phase !== 'no_changes').map(date => date.date).sort()[0] || [...application.dates].sort().find(date => date >= data.schoolLocalToday) || application.dates.at(-1) || '';
    const visible = data.applications.filter(application => !application.historyHiddenAt);
    const current = visible.filter(application => application.status !== 'cancelled' && (summaries?.[application.id] ? summaries[application.id].dates.some(date => ['today', 'future'].includes(date.phase)) : application.dates.some(date => date >= data.schoolLocalToday)));
    const history = visible.filter(application => !current.includes(application));
    current.sort((a, b) => nextDate(a).localeCompare(nextDate(b)) || a.id.localeCompare(b.id));
    history.sort((a, b) => [...b.dates].sort().at(-1).localeCompare([...a.dates].sort().at(-1)) || a.id.localeCompare(b.id));
    return { current, history };
  }, [data.applications, data.schoolLocalToday, summaries]);
  const applicationRow = application => <ApplicationRow key={application.id} application={application} summary={summaries?.[application.id]} catalog={data} testingStatuses={testingStatuses} statusReasons={statusReasons} unavailable={statusUnavailable || !summaries?.[application.id]} serverNow={serverNow} latestServerNow={latestServerNow} busy={busy} blocked={blocked} onCancel={onCancel} onDeleteHistory={onDeleteHistory} expanded={expandedIds.has(application.id)} onToggle={() => setExpandedIds(current => { const next = new Set(current); if (next.has(application.id)) next.delete(application.id); else next.add(application.id); return next; })} />;
  return <div className="space-y-8">
    <section aria-label="Saved profiles" className="space-y-3">
      <h3 className="text-base font-semibold">Saved profiles</h3>
      <p className="max-w-3xl text-sm text-muted-foreground">Saved profiles are reusable plans. Editing them does not change schedules already applied to dates.</p>
      {profiles.length ? <table aria-label="Saved profiles" className="block w-full text-left text-sm xl:table"><thead className="hidden border-b text-xs text-muted-foreground xl:table-header-group"><tr><th className="px-3 py-3 font-medium">Profile</th><th className="px-3 py-3 font-medium">What changes</th><th className="px-3 py-3 font-medium">Next scheduled date</th><th className="px-3 py-3 font-medium">Actions</th></tr></thead><tbody className="block divide-y xl:table-row-group">{profiles.map(profile => {
        const definition = profile.definition;
        const changeSummary = changeText(definition.classRules.filter(rule => rule.action === 'time').length, definition.classRules.filter(rule => rule.action === 'skip').length, definition.testingBlocks.length);
        const assigned = (applicationsByProfile.get(profile.id) || EMPTY).filter(application => application.status !== 'cancelled');
        const missing = statusUnavailable || assigned.some(application => !summaries?.[application.id]);
        const next = assigned.map(application => summaries?.[application.id]?.nextFutureDate).filter(Boolean).sort()[0];
        const appliedToday = assigned.some(application => summaries?.[application.id]?.appliedToday);
        const included = data.classes.filter(row => definition.classIds.includes(row.id) || definition.grades.includes(String(row.gradeLevel))).length;
        return <tr key={profile.id} data-profile-id={profile.id} className="block space-y-2 py-4 align-top xl:table-row xl:space-y-0 xl:py-0"><td className="block break-words px-3 xl:table-cell xl:py-4"><span className="font-semibold">{definition.name}</span><span className="mt-1 block text-xs text-muted-foreground">{countText(included, 'class', 'classes')} included</span></td><td className="block px-3 xl:table-cell xl:max-w-60 xl:py-4"><span>{changeSummary || 'No schedule changes configured'}</span></td><td className="block px-3 xl:table-cell xl:py-4"><span className="mb-1 block text-xs text-muted-foreground xl:hidden">Next scheduled date</span><span>{missing ? 'Schedule dates unavailable' : next ? scheduleDateText(next) : 'No future dates'}</span>{!missing && appliedToday && <span className="mt-1 block text-xs font-medium">Applied today</span>}</td><td className="block px-3 xl:table-cell xl:py-4"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" aria-label={`Open profile ${definition.name}`} disabled={busy} onClick={() => onOpen('view', profile)}>Open profile</Button><Button size="sm" aria-label={`Choose dates & apply ${definition.name}`} disabled={busy || blocked} onClick={() => onOpen('apply', profile)}><CalendarDays className="mr-1.5 h-3.5 w-3.5" />Choose dates & apply</Button><DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="outline" disabled={busy} aria-label={`More actions for ${definition.name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem aria-label={`Edit ${definition.name}`} disabled={busy || blocked} onSelect={() => onOpen('edit', profile)}>Edit profile</DropdownMenuItem><DropdownMenuItem aria-label={`Duplicate ${definition.name}`} disabled={busy || blocked} onSelect={() => onOpen('edit', profile, true)}><Copy className="mr-2 h-4 w-4" />Duplicate</DropdownMenuItem><DropdownMenuItem aria-label={`Delete profile ${definition.name}`} className="text-destructive focus:text-destructive" disabled={busy || blocked} onSelect={() => onDelete(profile)}><Trash2 className="mr-2 h-4 w-4" />Delete profile</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></td></tr>;
      })}</tbody></table> : <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No profiles yet. Create your first special-day plan, then apply it to the dates you need.</p>}
    </section>
    <section aria-label="Schedule profile applications" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 ref={applicationsHeadingRef} tabIndex={-1} className="text-base font-semibold">Applied dates</h3><Button size="sm" variant="ghost" disabled={busy || refreshing} onClick={onRefresh}>Refresh status</Button></div>
      <p className="text-sm text-muted-foreground">These are the schedules saved for actual dates. Cancelling an application affects all its dates together.</p>
      <p className="text-xs text-muted-foreground">Testing status is separate from class changes. After testing starts, use Release or Extend in Coverage.</p>
      {statusUnavailable && <p role="status" className="text-sm text-muted-foreground">Current application status is unavailable. Refresh status to check again.</p>}
      {grouped.current.length ? grouped.current.map(applicationRow) : <p className="text-sm text-muted-foreground">No applications for today or future dates.</p>}
      {grouped.history.length > 0 && <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Earlier and cancelled applications <span className="font-normal text-muted-foreground">({grouped.history.length})</span></summary><div className="mt-4 space-y-3">{grouped.history.map(applicationRow)}</div></details>}
    </section>
  </div>;
}
