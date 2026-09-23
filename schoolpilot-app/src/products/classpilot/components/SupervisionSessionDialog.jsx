import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog';

const selectClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';
const studentId = student => student.studentId || student.id;
const studentName = student => student.studentName || student.name || [student.firstName, student.lastName].filter(Boolean).join(' ') || 'Student';
const errorMessage = error => error.response?.data?.error || error.message || 'The request could not be completed.';
const roots = ['/api/coverage/contexts', '/api/coverage/summary', '/api/coverage/available-students', '/api/coverage/claimed-students', '/api/coverage/reroute-targets', '/api/students-aggregated', '/api/classpilot/dashboard-activity', '/api/classpilot/observable-activities'];

export default function SupervisionSessionDialog(props) {
  const { currentUser, school } = useClassPilotAuth();
  if (!props.open || !currentUser?.schoolId) return null;
  return <SessionReview key={`${currentUser.schoolId}:${currentUser.id}:${currentUser.role}:${props.action}:${props.group?.id || ''}:${props.context?.id || ''}`}
    {...props} currentUser={currentUser} timezone={school?.timezone || 'America/New_York'} />;
}

function SessionReview({ onOpenChange, action = 'start', group, students, context, onSuccess, currentUser, timezone }) {
  const schoolId = currentUser.schoolId;
  const actorId = currentUser.id;
  const isAdmin = currentUser.isSuperAdmin || ['admin', 'school_admin'].includes(currentUser.role);
  const alive = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [initialStudents] = useState(() => students ? [...students] : null);
  const [groupId, setGroupId] = useState(group?.id || '');
  const [targetId, setTargetId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [staffId, setStaffId] = useState(actorId);
  const [kind, setKind] = useState('other');
  const [name, setName] = useState(group?.name || 'Supervision');
  const [end, setEnd] = useState(context?.endsAt ? formatInTimeZone(context.endsAt, timezone, "yyyy-MM-dd'T'HH:mm") : '');
  const [selection, setSelection] = useState(() => initialStudents || group?.id ? null : new Set());
  const [search, setSearch] = useState('');
  const [review, setReview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const options = useQuery({
    queryKey: ['/api/coverage/session-options', schoolId, actorId, groupId],
    queryFn: ({ signal }) => apiRequest('GET', '/coverage/session-options', undefined, { signal, headers: { 'X-School-Id': schoolId }, params: groupId ? { supervisionGroupId: groupId } : {} }),
    enabled: action !== 'end_time', retry: false,
  });
  const targets = useQuery({
    queryKey: ['/api/coverage/reroute-targets', schoolId, actorId],
    queryFn: ({ signal }) => apiRequest('GET', '/coverage/reroute-targets', undefined, { signal, headers: { 'X-School-Id': schoolId } }),
    enabled: action === 'send', retry: false,
  });
  const target = targets.data?.targets?.find(row => row.id === targetId);
  const existing = target?.activeContexts?.find(row => row.id === destinationId);
  const rows = initialStudents || options.data?.students || [];
  const ids = selection || new Set(rows.map(studentId));
  const chosen = rows.filter(row => ids.has(studentId(row)));
  const endValue = end || (options.data?.defaultEndsAt ? formatInTimeZone(options.data.defaultEndsAt, timezone, "yyyy-MM-dd'T'HH:mm") : '');
  const formatTime = value => value ? new Intl.DateTimeFormat(undefined, { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Unavailable';
  const invalidate = () => Promise.all(roots.map(root => queryClient.invalidateQueries({ queryKey: [root] })));
  const edit = fn => { fn(); setReview(null); setError(''); };
  const getReview = async (onlyIds) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const requestedIds = onlyIds || chosen.map(studentId);
      const request = action === 'end_time' ? { action, destinationContextId: context.id, endsAt: fromZonedTime(endValue, timezone).toISOString() } : {
        action, studentIds: requestedIds,
        ...(action === 'send' ? { supervisionGroupId: target?.supervisionGroupId, assignedStaffId: target?.assignedStaffId,
          ...(destinationId ? { destinationContextId: destinationId } : {}) } : { ...(groupId ? { supervisionGroupId: groupId } : {}), assignedStaffId: staffId }),
        ...(!destinationId ? { contextType: kind, name: action === 'send' ? target?.name : name.trim(), endsAt: fromZonedTime(endValue, timezone).toISOString() } : {}),
      };
      const data = await apiRequest('POST', '/coverage/preview', request, { headers: { 'X-School-Id': schoolId } });
      if (!alive.current) return;
      if (onlyIds) setSelection(new Set(onlyIds));
      setReview(data);
    } catch (err) { if (alive.current) setError(errorMessage(err)); }
    finally { if (alive.current) setBusy(false); }
  };
  const commit = async () => {
    if (!review || busy || uncertain) return;
    setBusy(true); setError('');
    try {
      const path = action === 'start' ? '/coverage/contexts' : action === 'send' ? '/coverage/send' : `/coverage/contexts/${encodeURIComponent(context.id)}`;
      const data = await apiRequest(action === 'end_time' ? 'PATCH' : 'POST', path, { ...review.request, reviewToken: review.reviewToken }, { headers: { 'X-School-Id': schoolId } });
      await invalidate();
      if (alive.current) setResult(data);
    } catch (err) {
      await invalidate();
      if (!alive.current) return;
      const status = err.response?.status;
      setError(status === 409 ? `${errorMessage(err)} Review the current details before trying again.` : errorMessage(err));
      if (!status || status >= 500) setUncertain(true);
      else setReview(null);
    } finally { if (alive.current) setBusy(false); }
  };
  const reconcile = async () => {
    setBusy(true); setError('');
    try {
      await apiRequest('GET', '/coverage/contexts', undefined, { headers: { 'X-School-Id': schoolId } });
      await invalidate();
      if (!alive.current) return;
      onOpenChange(false);
      onSuccess?.({ uncertain: true });
    } catch (err) { if (alive.current) setError(errorMessage(err)); }
    finally { if (alive.current) setBusy(false); }
  };
  const excluded = review?.students?.filter(row => !row.eligible) || [];
  const included = review?.students?.filter(row => row.eligible) || [];
  const label = action === 'send' ? 'Send students' : action === 'end_time' ? 'Change end time' : review?.destination?.purpose === 'testing' || kind === 'state_testing' ? 'Start testing' : 'Start supervision';
  const done = () => { onOpenChange(false); onSuccess?.(result); };
  return <Dialog open onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="supervision-session-dialog">
      <DialogHeader>
        <DialogTitle>{result ? 'Supervision updated' : action === 'end_time' ? 'Change end time' : action === 'send' ? 'Send students' : 'Start a session'}</DialogTitle>
        <DialogDescription>{result ? 'Review the outcome for each selected student.' : action === 'end_time' ? 'This change affects everyone currently in this session.' : 'Choose the students, supervisor, and end time. Saved group membership stays unchanged.'}</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {uncertain ? <div className="space-y-3 rounded-md border p-4" role="status"><p>The outcome could not be confirmed. Refresh supervision to see the current assignments before starting another transfer.</p><Button onClick={reconcile} disabled={busy}>Refresh supervision</Button></div>
      : result ? <div className="space-y-3" data-testid="supervision-results"><p className="font-medium">{review?.destination?.name} · {review?.destination?.supervisorName}</p><p className="text-sm">Ends {formatTime(result.context?.endsAt || review?.destination?.endsAt)} ({timezone})</p>
        <ul className="divide-y rounded-md border">{(result.outcomes || review?.students || []).map(row => <li key={row.studentId} className="flex justify-between gap-4 p-3 text-sm"><span>{row.name || review.students.find(student => student.studentId === row.studentId)?.name || 'Student'}</span><span>{row.status === 'already_assigned' ? 'Already in this session' : row.status === 'unavailable' ? row.reason || 'Unavailable' : action === 'end_time' ? 'End time updated' : 'Assigned'}</span></li>)}</ul>
      </div> : review ? <div className="space-y-4" data-testid="supervision-review">
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 rounded-md border bg-muted/20 p-4 text-sm"><dt>Session</dt><dd className="font-medium">{review.destination.name}</dd><dt>Purpose</dt><dd>{review.destination.purpose === 'testing' ? 'Testing' : review.destination.purpose === 'claim' ? 'Claimed students' : 'Supervision'}</dd><dt>Supervisor</dt><dd>{review.destination.supervisorName}</dd><dt>Ends</dt><dd>{formatTime(review.destination.endsAt)} ({timezone})</dd></dl>
        <ul className="max-h-64 overflow-y-auto divide-y rounded-md border">{review.students.map(row => <li key={row.studentId} className="p-3 text-sm"><div className="flex justify-between gap-3"><span className="font-medium">{row.name}</span><span>{row.eligible ? row.status === 'already_assigned' ? 'Already assigned' : 'Ready' : 'Unavailable'}</span></div>{row.currentOwner && <p className="mt-1 text-muted-foreground">Currently: {typeof row.currentOwner === 'string' ? row.currentOwner : row.currentOwner.name || row.currentOwner.supervisorName || 'Under supervision'}</p>}{row.reason && <p className="mt-1 text-muted-foreground">{row.reason}</p>}</li>)}</ul>
        {excluded.length > 0 && <div className="space-y-2"><p className="text-sm">{excluded.length} selected student{excluded.length === 1 ? ' is' : 's are'} unavailable. No assignments have changed.</p><Button variant="outline" disabled={busy || included.length === 0} onClick={() => getReview(included.map(row => row.studentId))}>Continue with {included.length} available student{included.length === 1 ? '' : 's'}</Button></div>}
      </div> : <fieldset disabled={busy} className="space-y-4">
        {(options.isError || targets.isError) && <p role="alert" className="text-sm text-destructive">Session options could not load. <button className="underline" onClick={() => { void options.refetch(); if (action === 'send') void targets.refetch(); }}>Retry</button></p>}
        {action === 'send' ? <div className="grid gap-2"><Label htmlFor="supervision-target">Send to</Label><select id="supervision-target" className={selectClass} value={targetId} onChange={event => edit(() => { setTargetId(event.target.value); setDestinationId(''); })}><option value="">Choose a group and authorized supervisor</option>{targets.data?.targets?.map(row => <option key={row.id} value={row.id}>{row.name} · {row.assignedStaff?.displayName || 'Staff'}</option>)}</select>{target && <><Label htmlFor="supervision-destination">Session</Label><select id="supervision-destination" className={selectClass} value={destinationId} onChange={event => edit(() => setDestinationId(event.target.value))}><option value="">Create a new session</option>{target.activeContexts?.map(row => <option key={row.id} value={row.id}>{row.name} ({row.purpose === 'testing' ? 'Testing' : 'Supervision'}) · ends {formatTime(row.endsAt)}</option>)}</select></>}</div> : action === 'start' && <div className="grid gap-2"><Label htmlFor="supervision-group">Saved group</Label><select id="supervision-group" className={selectClass} value={groupId} onChange={event => edit(() => { setGroupId(event.target.value); setSelection(event.target.value ? null : new Set()); setName(options.data?.groups?.find(row => row.id === event.target.value)?.name || 'Supervision'); })}><option value="">Choose students directly</option>{options.data?.groups?.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div>}
        {action !== 'end_time' && !destinationId && <div className="grid gap-4 sm:grid-cols-2"><div className="grid gap-2"><Label htmlFor="supervision-purpose">Purpose</Label><select id="supervision-purpose" className={selectClass} value={kind} onChange={event => edit(() => setKind(event.target.value))}><option value="other">Supervision</option><option value="state_testing">Testing</option></select></div>{action === 'start' && <div className="grid gap-2"><Label htmlFor="supervision-name">Session name</Label><Input id="supervision-name" value={name} maxLength={120} onChange={event => edit(() => setName(event.target.value))} /></div>}</div>}
        {action === 'start' && <div className="grid gap-2"><Label htmlFor="supervision-staff">Supervisor</Label>{isAdmin ? <select id="supervision-staff" className={selectClass} value={staffId} onChange={event => edit(() => setStaffId(event.target.value))}>{options.data?.staff?.map(row => <option key={row.id} value={row.id}>{row.displayName}</option>)}</select> : <p className="text-sm">{currentUser.displayName}</p>}</div>}
        {existing ? <p className="rounded-md border bg-muted/20 p-3 text-sm">Ends {formatTime(existing.endsAt)} ({timezone}). Adding students keeps this deadline.</p> : <div className="grid gap-2"><Label htmlFor="supervision-end">End time ({timezone})</Label><Input id="supervision-end" type="datetime-local" value={endValue} onChange={event => edit(() => setEnd(event.target.value))} /></div>}
        {action !== 'end_time' && <fieldset className="space-y-2"><legend className="text-sm font-medium">Students ({chosen.length} selected)</legend><Input aria-label="Search session students" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search students" />
          <div className="max-h-56 overflow-y-auto rounded-md border">{rows.filter(row => studentName(row).toLowerCase().includes(search.toLowerCase())).map(row => <label key={studentId(row)} className="flex items-center gap-3 border-b p-3 text-sm last:border-b-0"><input type="checkbox" checked={ids.has(studentId(row))} onChange={event => edit(() => { const next = new Set(ids); if (event.target.checked) next.add(studentId(row)); else next.delete(studentId(row)); setSelection(next); })} /><span>{studentName(row)}</span></label>)}{rows.length === 0 && <p className="p-3 text-sm text-muted-foreground">{options.isPending ? 'Loading students…' : 'No students available in this scope.'}</p>}</div>
        </fieldset>}
      </fieldset>}
      <DialogFooter className="gap-2">
        {result ? <Button onClick={done}>Done</Button> : <><Button variant="outline" onClick={() => review && !uncertain ? setReview(null) : onOpenChange(false)} disabled={busy}>{review && !uncertain ? 'Back' : 'Cancel'}</Button>{!uncertain && (review ? <Button disabled={busy || excluded.length > 0 || (action !== 'end_time' && included.length === 0)} onClick={commit} data-testid="confirm-supervision-review">{busy ? 'Saving…' : label}</Button> : <Button onClick={() => getReview()} disabled={busy || action !== 'end_time' && (options.isPending || options.isError || chosen.length === 0) || action === 'send' && !target || (!destinationId && !endValue) || action === 'start' && !name.trim()} data-testid="review-supervision">{busy ? 'Checking…' : 'Review'}</Button>)}</>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
