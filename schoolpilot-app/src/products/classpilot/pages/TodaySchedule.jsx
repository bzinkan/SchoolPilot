import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { useAdminNavigation, useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { manualTodayDateLabel } from '../hooks/useManualToday';
import { TeacherSettingsTabs } from '../components/ScheduleRouteTabs';
import { SchedulePageHeader } from '../components/ScheduleChangeUI';
import { scheduleChangeError } from '../lib/scheduleChanges';
import { refreshTodaySchedule, todayChangeKey, todayScheduleKey, todayScheduleRequest, todayTime, todayWindow } from '../lib/todaySchedule';

const selectClass = 'h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm';
const changeLabels = { pending: 'Waiting for acceptance', applied: 'Applied', declined: 'Declined', cancelled: 'Cancelled', expired: 'Expired', superseded: 'Replaced by a newer change' };

function WindowReview({ before = [], after = [], timeZone }) {
  return <div className="grid gap-3 sm:grid-cols-2" data-testid="today-window-review">{before.map((window, index) => {
    const updated = after.find(item => item.groupId === window.groupId);
    return <div key={`${window.groupId}:${index}`} className="min-w-0 rounded-md border p-3 text-sm">
      <p className="font-semibold">{window.name}</p><p className="text-muted-foreground">{window.teacherName}</p>
      <p className="mt-2">Was: {todayWindow(window, timeZone)}</p>
      <p className="font-medium">Today: {updated ? todayWindow(updated, timeZone) : 'Skipped this period'}</p>
    </div>;
  })}</div>;
}

function TodayScheduleWorkspace({ schoolId, viewerId, scope }) {
  const { navigate } = useAdminNavigation();
  const [params] = useSearchParams();
  const [currentKey, setCurrentKey] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [review, setReview] = useState(null);
  const [changeId, setChangeId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now);
  const reviewHeading = useRef(null);
  const noticeRef = useRef(null);
  const currentSelect = useRef(null);
  const lifetime = useRef(true);
  useLayoutEffect(() => { lifetime.current = true; return () => { lifetime.current = false; }; }, []);
  const query = useQuery({
    queryKey: todayScheduleKey(schoolId, viewerId, scope),
    queryFn: ({ signal }) => todayScheduleRequest(schoolId, 'GET', '', undefined, signal),
    refetchInterval: 30_000, refetchOnWindowFocus: true, staleTime: 0,
  });
  const data = query.data;
  const enabled = data?.enabled === true;
  const dayExpired = Number.isFinite(Date.parse(data?.resumesAt)) && now >= Date.parse(data.resumesAt);
  const canRequest = enabled && data?.canRequest === true && !dayExpired && !query.isError;
  // The server scopes this list to assigned primary/co-teacher classes. Signed
  // meeting refs renew on polls; selection belongs to the actual class window.
  const meetings = (data?.classes || []).flatMap(group => (group.meetings || []).map(meeting => ({
    ...meeting, groupId: group.groupId, name: group.name, primaryTeacherId: group.primaryTeacherId,
    key: `${group.groupId}:${meeting.startsAt}:${meeting.endsAt}`,
  })));
  const selectable = meetings.filter(meeting => Date.parse(meeting.endsAt) > now)
    .sort((first, second) => Date.parse(first.startsAt) - Date.parse(second.startsAt) || Date.parse(first.endsAt) - Date.parse(second.endsAt));
  const current = selectable.find(meeting => meeting.key === currentKey)
    || (!currentKey && (selectable.find(meeting => meeting.state === 'current') || selectable[0]));
  const selected = selectable.find(meeting => meeting.key === selectedKey && meeting.primaryTeacherId === current?.primaryTeacherId)
    || (!selectedKey && selectable.find(meeting => meeting.groupId === params.get('selectedGroupId') && meeting.groupId !== current?.groupId && meeting.primaryTeacherId === current?.primaryTeacherId));
  const detail = useQuery({
    queryKey: todayChangeKey(schoolId, viewerId, scope, changeId),
    queryFn: ({ signal }) => todayScheduleRequest(schoolId, 'GET', `/changes/${encodeURIComponent(changeId)}`, undefined, signal),
    enabled: !!changeId, refetchInterval: 10_000, staleTime: 0,
  });
  const change = detail.data?.change;
  const acceptReview = detail.data?.preview;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const refetch = query.refetch;
  useEffect(() => {
    const expires = Date.parse(data?.resumesAt);
    if (!Number.isFinite(expires)) return;
    const timer = setTimeout(() => { setNow(Date.now()); void refetch(); }, Math.max(0, expires - Date.now()));
    return () => clearTimeout(timer);
  }, [data?.resumesAt, refetch]);
  const preview = useMutation({
    mutationFn: body => todayScheduleRequest(schoolId, 'POST', '/preview', body),
    onSuccess: (result, request) => {
      if (!lifetime.current) return;
      setReview({ ...result, request, idempotencyKey: crypto.randomUUID() });
      setChangeId(null); setError('');
      requestAnimationFrame(() => reviewHeading.current?.focus());
    },
    onError: failure => { if (lifetime.current) { setReview(null); setError(scheduleChangeError(failure)); void query.refetch(); } },
  });
  const write = useMutation({
    mutationFn: ({ path, body }) => todayScheduleRequest(schoolId, 'POST', path, body),
    onSuccess: result => {
      if (!lifetime.current) return;
      setReview(null); setError(''); setChangeId(result.change.id);
      setNotice({ schoolDate: result.change.scheduledDate || data?.schoolDate,
        message: result.change.status === 'pending' ? 'Request sent. Your current classes and schedule continue until the other teacher accepts.' : result.change.status === 'applied' ? 'Today’s schedule is updated. Automatic class times follow the new order today.' : `Request ${changeLabels[result.change.status]?.toLowerCase() || 'updated'}.` });
      refreshTodaySchedule();
      requestAnimationFrame(() => noticeRef.current?.focus());
    },
    onError: failure => {
      if (!lifetime.current) return;
      setError(scheduleChangeError(failure));
      if ([409, 403].includes(failure?.response?.status)) setReview(null);
      refreshTodaySchedule();
    },
  });
  const busy = preview.isPending || write.isPending;
  useAdminNavigationBlocker({ id: 'today-schedule', busy });
  const requestPreview = (action = 'swap', meeting = current) => {
    if (!canRequest || busy || !meeting || action === 'swap' && !selected) return;
    setError(''); setNotice('');
    preview.mutate({ expectedSchoolDate: data.schoolDate, action, currentGroupId: meeting.groupId, currentMeetingRef: meeting.meetingRef,
      ...(action === 'swap' ? { selectedGroupId: selected.groupId, selectedMeetingRef: selected.meetingRef } : {}),
    });
  };
  const changeSelection = (setter, value) => { setter(value); setReview(null); setError(''); setNotice(''); };
  const stale = review && (review.schoolDate !== data?.schoolDate || dayExpired || !canRequest
    || review.reviewToken && (!Number.isFinite(Date.parse(review.expiresAt)) || Date.parse(review.expiresAt) <= now));
  const acceptExpired = !acceptReview?.reviewToken || !Number.isFinite(Date.parse(acceptReview?.expiresAt)) || Date.parse(acceptReview.expiresAt) <= now
    || acceptReview.schoolDate !== data?.schoolDate || dayExpired;
  const action = name => write.mutate({ path: `/changes/${encodeURIComponent(change.id)}/actions`, body: {
    action: name, expectedRevision: change.revision, ...(name === 'accept' ? { reviewToken: acceptReview.reviewToken } : {}),
  } });
  return <div className="min-h-screen bg-background">
    <SchedulePageHeader eyebrow="Teaching tools" title="Today’s schedule" description="Swap two periods for both teachers. Keep your classes, students and regular schedule."
      actions={<><ThemeToggle /><Button variant="outline" className="border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800 hover:text-white" onClick={() => navigate('/classpilot')} data-testid="button-back-classpilot"><ArrowLeft className="mr-2 h-4 w-4" />Back to ClassPilot</Button></>}>
      <TeacherSettingsTabs />
    </SchedulePageHeader>
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6" data-testid="today-schedule-workspace">
      {query.isPending ? <p role="status">Loading today’s schedule…</p> : query.isError ? <div role="alert" className="space-y-3 rounded-lg border p-4"><p>Today’s schedule could not be refreshed. No changes can be made until it is available.</p><Button variant="outline" onClick={() => query.refetch()}>Retry today’s schedule</Button></div> : <>
        <p className="text-sm text-muted-foreground">{manualTodayDateLabel(data?.schoolDate)} · {data?.timeZone}. Changes apply today only; your regular schedule returns tomorrow.</p>
        {!enabled ? <p role="status" className="rounded-lg border p-4">New period swaps are not available at your school yet. Existing applied changes remain in effect, and pending requests can still be reviewed, declined or cancelled below.</p>
          : !data?.canRequest ? <p role="status" className="rounded-lg border p-4">Your school administrator has not enabled period swaps for your account. You can still review existing requests below.</p> : null}
        {dayExpired ? <p role="alert">The school date changed. Refresh today’s schedule before making a change.</p> : null}
        <section className="space-y-4 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="today-classes-heading">
          <h2 id="today-classes-heading" className="text-lg font-semibold">Your classes today</h2>
          {meetings.length === 0 ? <p className="text-sm text-muted-foreground">No scheduled class meetings are available for you today.</p> : <div className="space-y-2">{meetings.map(meeting => <div key={meeting.key} className="flex items-center justify-between gap-3 rounded-md border p-3" data-testid={`today-meeting-${meeting.groupId}`}>
            <div className="min-w-0 text-sm"><p className="font-medium">{meeting.name}</p><p className="text-muted-foreground">{todayWindow(meeting, data.timeZone)} · {meeting.state}</p></div>
            {canRequest && Date.parse(meeting.endsAt) > now ? <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`Actions for ${meeting.name}`} disabled={busy}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => requestPreview('skip', meeting)}>Skip this period</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
          </div>)}</div>}
          {canRequest ? <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-medium">First period<select ref={currentSelect} className={selectClass} value={current?.key || ''} disabled={busy} onChange={event => changeSelection(setCurrentKey, event.target.value)} data-testid="select-today-current"><option value="">Choose your earlier class</option>{selectable.map(meeting => <option key={meeting.key} value={meeting.key}>{meeting.name} · {todayWindow(meeting, data.timeZone)}</option>)}</select></label>
            <label className="space-y-2 text-sm font-medium">Class to teach first<select className={selectClass} value={selected?.key || ''} disabled={busy} onChange={event => changeSelection(setSelectedKey, event.target.value)} data-testid="select-today-selected"><option value="">Choose your other class</option>{selectable.filter(meeting => meeting.groupId !== current?.groupId && meeting.primaryTeacherId === current?.primaryTeacherId).map(meeting => <option key={meeting.key} value={meeting.key}>{meeting.name} · {todayWindow(meeting, data.timeZone)} · {meeting.state}</option>)}</select></label>
            <div className="sm:col-span-2"><Button disabled={busy || !current || !selected || current.groupId === selected.groupId || query.isFetching} onClick={() => requestPreview()} data-testid="button-preview-today-swap">{preview.isPending ? 'Checking…' : 'Review period swap'}</Button></div>
          </div> : null}
        </section>
      </>}
      {error ? <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p> : null}
      {notice && notice.schoolDate === data?.schoolDate ? <p role="status" tabIndex={-1} ref={noticeRef} className="rounded-md border p-3 text-sm outline-none" data-testid="today-schedule-notice">{notice.message}</p> : null}
      {review ? <section className="space-y-4 rounded-lg border bg-card p-4 sm:p-6" data-testid="today-swap-review">
        <h2 className="text-lg font-semibold outline-none" tabIndex={-1} ref={reviewHeading}>{review.action === 'skip' ? 'Skip this period today?' : review.mode === 'remainder' ? 'Swap the rest of this period and the later period?' : 'Swap these periods today?'}</h2>
        {review.requiresCounterpartSelection ? <label className="block space-y-2 text-sm font-medium">Choose the other teacher<select className={selectClass} value={review.selectedCounterpartTeacherId || ''} disabled={busy} onChange={event => preview.mutate({ ...review.request,
          currentMeetingRef: current?.meetingRef || review.request.currentMeetingRef,
          ...(review.request.action === 'swap' ? { selectedMeetingRef: selected?.meetingRef || review.request.selectedMeetingRef } : {}), counterpartTeacherId: event.target.value })} data-testid="select-today-counterpart"><option value="">Choose a matching teacher</option>{(review.eligibleCandidates || []).map(teacher => <option key={teacher.teacherId} value={teacher.teacherId}>{teacher.teacherName}</option>)}</select></label> : null}
        {meetings.filter(meeting => (review.before || []).some(window => window.groupId === meeting.groupId && window.startsAt === meeting.startsAt && window.endsAt === meeting.endsAt)
          && ['manual', 'skipped', 'ended'].includes(meeting.state) && Date.parse(meeting.endsAt) > now).map(meeting => <p className="rounded-md border p-3 text-sm" key={meeting.key} data-testid="today-restore-notice">{meeting.name} is currently {meeting.state}. Review its proposed remaining class time before applying this change.</p>)}
        <WindowReview before={review.before} after={review.after} timeZone={data?.timeZone} />
        {review.mode === 'remainder' ? <p className="text-sm">Only the time remaining in this period changes. Teaching already completed and Session Summaries are kept.</p> : null}
        <p className="text-sm">{review.action === 'skip' ? 'This cancels only this period. It does not start a replacement class.' : 'Both teachers keep their existing classes and students. Automatic starts and ends follow this order today.'} Your regular times return tomorrow.</p>
        {review.requiresAcceptance ? <p className="text-sm" data-testid="today-live-acceptance">{review.requiredAcceptance?.teacherName || 'The other teacher'} is teaching an affected Live class and must accept. Until then, no classes or times change.</p> : review.action !== 'skip' && review.canApply && !review.requiresCounterpartSelection ? <p className="text-sm">The other teacher has no affected Live class, so no acceptance or login is needed.</p> : null}
        {review.expiresAt ? <p className="text-xs text-muted-foreground">Review valid until {todayTime(review.expiresAt, data?.timeZone)}. Existing classroom settings and Flight Paths stay with their sessions; new sessions use their class’s saved preset.</p> : null}
        {(review.blockers || []).map((blocker, index) => <p role="alert" key={`${blocker.code}:${index}`} className="text-sm">{blocker.message}</p>)}
        {stale ? <p role="alert" className="text-sm">This review expired or your access changed. Review the latest periods again.</p> : null}
        <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => { setReview(null); currentSelect.current?.focus(); }}>Back to classes</Button><Button disabled={busy || !review.canApply || !review.reviewToken || stale || query.isFetching} onClick={() => write.mutate({ path: '/changes', body: { reviewToken: review.reviewToken, idempotencyKey: review.idempotencyKey } })} data-testid="button-apply-today-swap">
          {write.isPending ? 'Saving…' : review.requiresAcceptance ? `Send to ${review.requiredAcceptance?.teacherName || 'other teacher'}` : review.action === 'skip' ? 'Skip this period' : review.mode === 'remainder' ? 'Swap and start my class' : 'Apply today'}
        </Button></div>
      </section> : null}
      <section className="space-y-4 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="today-requests-heading">
        <h2 id="today-requests-heading" className="text-lg font-semibold">Requests and today’s changes</h2>
        {(data?.changes || []).length === 0 ? <p className="text-sm text-muted-foreground">No period changes today.</p> : <div className="space-y-2">{data.changes.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"><div><p className="font-medium">{changeLabels[item.status] || item.status}</p><p className="text-muted-foreground">{(item.after?.length ? item.after : item.before || []).map(window => window.name).join(' · ')}</p></div><Button variant="outline" disabled={busy} onClick={() => { setChangeId(item.id); setReview(null); setError(''); }} data-testid={`button-review-today-change-${item.id}`}>Review change</Button></div>)}</div>}
        {changeId ? <div className="space-y-3 border-t pt-4" data-testid="today-change-detail">{detail.isPending ? <p role="status">Refreshing this request…</p> : detail.isError ? <div role="alert"><p>The request could not be refreshed.</p><Button variant="link" onClick={() => detail.refetch()}>Retry request</Button></div> : change ? <>
          {detail.isFetching ? <p role="status" className="text-sm text-muted-foreground">Checking the latest request…</p> : null}
          <h3 className="font-semibold">{changeLabels[change.status] || change.status}</h3>
          <WindowReview before={acceptReview?.before || change.before} after={acceptReview?.after || change.after} timeZone={data?.timeZone} />
          {change.status === 'pending' ? <p className="text-sm">Your existing classes continue until acceptance. This request expires when the first affected period ends.</p> : null}
          {(acceptReview?.blockers || []).map((blocker, index) => <p role="alert" key={index} className="text-sm">{blocker.message}</p>)}
          {change.canAccept && acceptExpired ? <div role="alert" className="text-sm">The acceptance review expired. Refresh the request to check the remaining time. <Button variant="link" onClick={() => detail.refetch()}>Refresh request</Button></div> : null}
          <div className="flex flex-wrap gap-2">{change.canAccept ? <Button disabled={busy || acceptExpired || !acceptReview?.canApply || !canRequest || query.isError}
            aria-disabled={detail.isFetching || undefined} className={detail.isFetching ? 'opacity-50' : undefined}
            onClick={() => { if (!detail.isFetching) action('accept'); }} data-testid="button-accept-today-swap">Accept and apply</Button> : null}{change.canDecline ? <Button variant="outline" disabled={busy || detail.isFetching} onClick={() => action('decline')}>Decline</Button> : null}{change.canCancel ? <Button variant="outline" disabled={busy || detail.isFetching} onClick={() => action('cancel')}>Cancel request</Button> : null}<Button variant="ghost" disabled={busy} onClick={() => setChangeId(null)}>Close change</Button></div>
        </> : null}</div> : null}
      </section>
      <details className="text-sm"><summary className="cursor-pointer font-medium">Advanced</summary><Link className="mt-3 inline-block text-primary underline" to="/classpilot/my-settings/schedule-changes">Planned time swaps and earlier requests</Link><p className="mt-2 text-muted-foreground">Use the existing request workflow for future dates. Earlier pending requests and history remain available.</p></details>
    </main>
  </div>;
}

export default function TodaySchedule() {
  const { currentUser, isAdmin, isTeacher, isLoading } = useClassPilotAuth();
  if (isLoading) return <p role="status" className="p-6">Loading Teaching tools…</p>;
  if (!currentUser?.schoolId || !(isAdmin || isTeacher || currentUser.isSuperAdmin)) return <Navigate to="/classpilot" replace />;
  const scope = isAdmin || currentUser.isSuperAdmin ? 'admin' : 'teacher';
  return <TodayScheduleWorkspace key={`${currentUser.schoolId}:${currentUser.id}:${scope}`} schoolId={currentUser.schoolId} viewerId={currentUser.id} scope={scope} />;
}
