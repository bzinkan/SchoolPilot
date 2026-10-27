import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Label } from '../../../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { classroomLinks, runClassroomAction } from '../lib/classroomActions';
import CommandRecipients from './CommandRecipients';
import ClassroomLoadError from './ClassroomLoadError';
import { planRecipientSend, recipientsRestoredMessage, snapshotRecipientNames } from '../lib/dashboardCommandContext';

const outcomeLabel = value => ({ completed: 'Opened', requesting: 'Request sent; awaiting confirmation', received: 'Received; awaiting confirmation',
  pending: 'Awaiting confirmation', committed: 'Requested; awaiting confirmation',
  failed: 'Failed', unavailable: 'Unavailable', expired: 'Expired', refused: 'Refused' }[value] || value);

export default function ClassroomActions({ schoolId, viewerId, scopeKey, students,
  disabled, postCommand, readCommand, assertCurrent, captureRecipients, availableRecipientIds }) {
  const [open, setOpen] = useState(false), [courseId, setCourseId] = useState(''), [resourceId, setResourceId] = useState('');
  const [openUrl, setOpenUrl] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [outcomes, setOutcomes] = useState([]);
  const [recipients, setRecipients] = useState(null);
  const lifetime = useRef({ active: true, controller: null, running: false });
  const current = useRef({ assertCurrent, availableRecipientIds, postCommand, readCommand, students });
  useLayoutEffect(() => { current.current = { assertCurrent, availableRecipientIds, postCommand, readCommand, students }; });
  useLayoutEffect(() => {
    const state = lifetime.current; state.active = true;
    return () => { state.active = false; state.running = false; state.controller?.abort(); };
  }, [scopeKey]);
  const request = (method, path, body, signal) => apiRequest(method, path, body, { signal, headers: { 'X-School-Id': schoolId } });
  const courses = useQuery({ queryKey: ['/api/classroom/action-courses', schoolId, viewerId], enabled: open,
    queryFn: ({ signal }) => request('GET', '/classroom/courses?purpose=classroom_resources', undefined, signal), retry: false });
  const resources = useQuery({ queryKey: ['/api/classroom/action-resources', courseId, schoolId, viewerId], enabled: open && Boolean(courseId),
    queryFn: ({ signal }) => request('GET', `/classroom/courses/${encodeURIComponent(courseId)}/resources`, undefined, signal), retry: false });
  const resource = resources.data?.resources?.find(item => item.id === resourceId);
  const links = classroomLinks(resource);
  const chooseResource = id => {
    const item = resources.data?.resources?.find(value => value.id === id), choices = classroomLinks(item);
    setResourceId(id); setOpenUrl(choices[0]?.url || ''); setNotice(''); setOutcomes([]);
  };
  const show = () => {
    try {
      current.current.assertCurrent();
      const snapshot = captureRecipients();
      setRecipients({ snapshot, confirmIds: null, unavailableIds: null, notice: '', action: null });
      setNotice(''); setOutcomes([]); setOpen(true);
    } catch (error) { setNotice(error.message || 'Choose students before opening Classroom assignments.'); }
  };
  const close = () => { lifetime.current.controller?.abort(); setOpen(false); lifetime.current.running = false; setBusy(false); setRecipients(null); setNotice(''); };
  const confirmPending = action => recipients?.action === action && recipients.confirmIds?.length > 0;
  const sendLabel = (action, label) => confirmPending(action) ? `Send to ${recipients.confirmIds.length} available` : label;
  const reviewRecipients = (entry, action, repeatGesture = false, acceptedIds = null) => {
    if (!entry?.snapshot) throw new Error('Close this dialog and choose students again.');
    current.current.assertCurrent();
    const step = planRecipientSend({ snapshot: entry.snapshot,
      confirmIds: acceptedIds || (entry.action === action ? entry.confirmIds : null),
      commandableIds: current.current.availableRecipientIds(), repeatGesture });
    if (step.action === 'send') return [...step.studentIds];
    if (step.action === 'ask') setRecipients({ ...entry, action, confirmIds: step.confirmIds, unavailableIds: step.unavailableIds, notice: '' });
    if (step.action === 'restored') setRecipients({ ...entry, action, confirmIds: null, unavailableIds: null,
      notice: recipientsRestoredMessage(snapshotRecipientNames(entry.snapshot, step.restoredIds)) });
    return null;
  };
  const capturedStudents = (recipients?.snapshot.ids || []).map((studentId, index) => ({
    ...students.find(student => student.studentId === studentId), studentId, studentName: recipients.snapshot.names[index],
  }));
  const connect = async () => {
    const controller = new AbortController(); lifetime.current.controller?.abort(); lifetime.current.controller = controller;
    try {
      const returnTo = new URL('/classpilot', window.location.origin).href;
      const data = await request('GET', `/google/auth-url?purpose=classroom_resources&returnTo=${encodeURIComponent(returnTo)}`, undefined, controller.signal);
      if (!lifetime.current.active || controller.signal.aborted) return;
      const url = new URL(data.url);
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('Invalid Google connection URL');
      window.location.assign(url.href);
    } catch { if (lifetime.current.active && !controller.signal.aborted) setNotice('Google could not be connected. Retry or contact your administrator.'); }
  };
  const run = async event => {
    const action = 'open';
    if (lifetime.current.running || busy || (confirmPending(action) && (event?.detail > 1 || event?.repeat))) return;
    const entry = recipients;
    let acceptedIds;
    try { acceptedIds = reviewRecipients(entry, action, event?.detail > 1 || event?.repeat); }
    catch (error) { setNotice(error.message); return; }
    if (!acceptedIds) return;
    lifetime.current.running = true;
    const controller = new AbortController(); lifetime.current.controller?.abort(); lifetime.current.controller = controller;
    const check = () => {
      if (!lifetime.current.active || controller.signal.aborted) throw new DOMException('Classroom action cancelled', 'AbortError');
      current.current.assertCurrent();
    };
    setBusy(true); setNotice(''); setOutcomes([]);
    try {
      check();
      await runClassroomAction({ action, url: openUrl,
        studentIds: acceptedIds, signal: controller.signal, assertCurrent: check,
        postCommand: (type, payload, ids) => { check(); return current.current.postCommand(type, payload, ids); },
        readCommand: (command, signal) => { check(); return current.current.readCommand(command, signal); },
        onUpdate: rows => { check(); setOutcomes(rows); },
      });
      check(); setNotice('Results show browser confirmations received so far. Pending actions may finish later in the activity history.');
    } catch (error) {
      if (lifetime.current.active && !controller.signal.aborted) {
        controller.abort(); setNotice(error.message || 'The Classroom action could not be completed.');
      }
    } finally { if (lifetime.current.active && lifetime.current.controller === controller) { lifetime.current.running = false; setBusy(false); } }
  };
  const canOpen = !busy && Boolean(recipients?.snapshot.ids.length) && Boolean(openUrl) && links.some(link => link.url === openUrl);
  return <>
    <Button size="sm" variant="outline" disabled={disabled || !students.length} onClick={show} data-testid="button-classroom-assignments">Classroom assignments</Button>
    {!open && notice && <p role="status" className="text-sm">{notice}</p>}
    <Dialog open={open} onOpenChange={value => value ? show() : close()}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto" data-testid="dialog-classroom-actions">
        <DialogHeader><DialogTitle>Google Classroom assignments</DialogTitle><DialogDescription>Choose an assignment or material to open for the students listed below, just like Open URL.</DialogDescription></DialogHeader>
        <CommandRecipients open={open} snapshot={recipients?.snapshot} unavailableIds={recipients?.unavailableIds} confirmIds={recipients?.confirmIds} notice={recipients?.notice} />
        {courses.isError ? <ClassroomLoadError error={courses.error} subject="Courses" onConnect={() => void connect()} onRetry={() => courses.refetch()} retrying={courses.isFetching} />
          : courses.isPending ? <p role="status">Loading courses…</p> : <div><Label htmlFor="classroom-actions-course">Course</Label><select id="classroom-actions-course" className="w-full rounded border bg-background p-2" value={courseId} disabled={busy} onChange={event => { setCourseId(event.target.value); setResourceId(''); setOpenUrl(''); setNotice(''); setOutcomes([]); }}><option value="">Choose a course</option>{(courses.data?.courses || []).map(course => <option key={course.id} value={course.id}>{course.name || course.courseName}</option>)}</select></div>}
        {courseId && (resources.isError ? <ClassroomLoadError error={resources.error} subject="Assignments" onConnect={() => void connect()} onRetry={() => resources.refetch()} retrying={resources.isFetching} />
          : resources.isPending ? <p role="status">Loading assignments and materials…</p> : <div><Label htmlFor="classroom-actions-resource">Assignment or material</Label><select id="classroom-actions-resource" className="w-full rounded border bg-background p-2" disabled={busy} value={resourceId} onChange={event => chooseResource(event.target.value)}><option value="">Choose an assignment or material</option>{(resources.data?.resources || []).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>)}
        {resource && <>
          <p className="text-sm text-muted-foreground">{resource.dueDate ? `Due ${resource.dueDate.year}-${String(resource.dueDate.month).padStart(2, '0')}-${String(resource.dueDate.day).padStart(2, '0')}` : 'No due date'}</p>
          {links.length ? <div><Label htmlFor="classroom-actions-open-url">Link to open</Label><select id="classroom-actions-open-url" className="w-full rounded border bg-background p-2" disabled={busy} value={openUrl} onChange={event => { setOpenUrl(event.target.value); setNotice(''); setOutcomes([]); }}>{links.map(link => <option key={link.id} value={link.url}>{link.title}</option>)}</select><p className="mt-1 break-all text-xs text-muted-foreground">{openUrl}</p></div> : <p>No usable browser links are available.</p>}
          <Button disabled={!canOpen} onClick={event => void run(event)}>{sendLabel('open', 'Open assignment')}</Button>
          <p className="text-sm text-muted-foreground">Opens the selected link in a new tab. Existing browsing restrictions still apply. Use the Dashboard controls afterward if you want to set Focus or a Waypoint.</p>
        </>}
        {busy && <p role="status">Waiting for per-student browser results…</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {outcomes.length > 0 && <section aria-label="Classroom action results" className="space-y-2 text-sm">{outcomes.map(row => <div className="rounded border p-2" key={row.studentId}><p className="font-medium">{capturedStudents.find(student => student.studentId === row.studentId)?.studentName || 'Student'}</p><p>{outcomeLabel(row.open)}</p>{row.error && <p className="text-destructive">{row.error}</p>}</div>)}</section>}
        <DialogFooter><Button variant="outline" onClick={close}>{busy ? 'Stop waiting and close' : 'Close'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
