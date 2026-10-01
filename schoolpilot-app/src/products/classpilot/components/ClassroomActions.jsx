import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Label } from '../../../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { useRestrictionScopePreview } from '../hooks/useRestrictionScopePreview';
import { classroomLinks, classroomCanFocus, classroomLessonStarts, reviewedFlightPathMatches, runClassroomAction } from '../lib/classroomActions';
import RestrictionScopeReview from './RestrictionScopeReview';

const outcomeLabel = value => ({ completed: 'Confirmed', requesting: 'Request sent; awaiting confirmation', received: 'Received; awaiting confirmation',
  pending: 'Awaiting confirmation', committed: 'Requested; awaiting confirmation',
  failed: 'Failed', unavailable: 'Unavailable', expired: 'Expired', refused: 'Refused' }[value] || value);

export default function ClassroomActions({ schoolId, viewerId, scopeKey, students, preciseResourcesEnabled,
  disabled, postCommand, readCommand, assertCurrent }) {
  const [open, setOpen] = useState(false), [courseId, setCourseId] = useState(''), [resourceId, setResourceId] = useState('');
  const [selectedLinks, setSelectedLinks] = useState([]), [openUrl, setOpenUrl] = useState('');
  const [boundary, setBoundary] = useState('resource'), [lessonUrl, setLessonUrl] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [outcomes, setOutcomes] = useState([]);
  const lifetime = useRef({ active: true, controller: null });
  useLayoutEffect(() => {
    const state = lifetime.current; state.active = true;
    return () => { state.active = false; state.controller?.abort(); };
  }, [scopeKey]);
  const request = (method, path, body, signal) => apiRequest(method, path, body, { signal, headers: { 'X-School-Id': schoolId } });
  const courses = useQuery({ queryKey: ['/api/classroom/action-courses', schoolId, viewerId], enabled: open,
    queryFn: ({ signal }) => request('GET', '/classroom/courses?purpose=classroom_resources', undefined, signal), retry: false });
  const resources = useQuery({ queryKey: ['/api/classroom/action-resources', courseId, schoolId, viewerId], enabled: open && Boolean(courseId),
    queryFn: ({ signal }) => request('GET', `/classroom/courses/${encodeURIComponent(courseId)}/resources`, undefined, signal), retry: false });
  const resource = resources.data?.resources?.find(item => item.id === resourceId);
  const links = classroomLinks(resource), chosenLinks = links.filter(link => selectedLinks.includes(link.id));
  const scopeReview = useRestrictionScopePreview({ schoolId, viewerId, enabled: open && preciseResourcesEnabled && chosenLinks.length > 0,
    input: { purpose: 'classroom', boundary, selectedResourceIds: resource ? [resource.id] : [],
      resources: resource ? [{ id: resource.id, links: chosenLinks.map(link => ({ url: link.url })) }] : [] },
    context: [scopeKey, courseId, resourceId, students.map(student => student.studentId), preciseResourcesEnabled],
  });
  const reviewedStarts = classroomLessonStarts(scopeReview.preview, chosenLinks);
  const startUrl = reviewedStarts.some(item => item.url === lessonUrl) ? lessonUrl : reviewedStarts[0]?.url || '';
  const chooseResource = id => {
    const item = resources.data?.resources?.find(value => value.id === id), choices = classroomLinks(item);
    setResourceId(id); setSelectedLinks(choices.map(link => link.id)); setOpenUrl(choices[0]?.url || '');
    setLessonUrl(''); setNotice(''); setOutcomes([]);
  };
  const close = () => { lifetime.current.controller?.abort(); setOpen(false); setBusy(false); };
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
  const run = async action => {
    const controller = new AbortController(); lifetime.current.controller?.abort(); lifetime.current.controller = controller;
    const check = () => {
      if (!lifetime.current.active || controller.signal.aborted) throw new DOMException('Classroom action cancelled', 'AbortError');
      assertCurrent();
    };
    setBusy(true); setNotice(''); setOutcomes([]);
    try {
      check();
      let flightPath;
      if (action === 'lesson') {
        if (!preciseResourcesEnabled || scopeReview.pending || !scopeReview.preview?.scopes.length || !startUrl)
          throw new Error('Review the lesson scope before continuing.');
        const review = scopeReview.preview;
        const created = await request('POST', '/flight-paths/from-classroom', { courseId, selectedResourceIds: [resource.id],
          resources: [{ id: resource.id }], resourceLinks: review.authoring.resourceLinks, boundary,
          name: resource.title || 'Classroom lesson', description: 'Reviewed Google Classroom lesson resources', reuseReviewedSource: true,
        }, controller.signal);
        check(); flightPath = created.flightPath;
        if (!reviewedFlightPathMatches(flightPath, review.authoring)) throw new Error('The saved lesson scope differs from the review. Review the scope again.');
      }
      await runClassroomAction({ action, url: action === 'lesson' ? startUrl : openUrl,
        studentIds: students.map(student => student.studentId), flightPath, signal: controller.signal, assertCurrent: check,
        postCommand: (type, payload, ids) => { check(); return postCommand(type, payload, ids); }, readCommand,
        onUpdate: rows => { check(); setOutcomes(rows); },
      });
      check(); setNotice('Results show browser confirmations received so far. Pending actions may finish later in the activity history.');
    } catch (error) {
      if (lifetime.current.active && !controller.signal.aborted) {
        controller.abort(); setNotice(error.message || 'The Classroom action could not be completed.');
      }
    } finally { if (lifetime.current.active && lifetime.current.controller === controller) setBusy(false); }
  };
  const canOpen = !busy && !disabled && students.length > 0 && Boolean(openUrl) && links.some(link => link.url === openUrl);
  return <>
    <Button size="sm" variant="outline" disabled={disabled || !students.length} onClick={() => setOpen(true)} data-testid="button-classroom-assignments">Classroom assignments</Button>
    <Dialog open={open} onOpenChange={value => value ? setOpen(true) : close()}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto" data-testid="dialog-classroom-actions">
        <DialogHeader><DialogTitle>Google Classroom assignments</DialogTitle><DialogDescription>Choose a link from your own courses. Actions target the {students.length} student{students.length === 1 ? '' : 's'} shown below.</DialogDescription></DialogHeader>
        <details className="rounded border p-2 text-sm"><summary>Students receiving this action ({students.length})</summary><ul>{students.map(student => <li key={student.studentId}>{student.studentName || student.studentEmail || 'Student'}</li>)}</ul></details>
        {courses.isError ? <div role="alert"><p>Your Google Classroom courses could not be loaded.</p><Button variant="outline" onClick={() => void connect()}>Connect my Google account</Button><Button variant="ghost" onClick={() => courses.refetch()}>Retry courses</Button></div>
          : courses.isPending ? <p role="status">Loading courses…</p> : <div><Label htmlFor="classroom-actions-course">Course</Label><select id="classroom-actions-course" className="w-full rounded border bg-background p-2" value={courseId} disabled={busy} onChange={event => { setCourseId(event.target.value); setResourceId(''); setSelectedLinks([]); setOpenUrl(''); setLessonUrl(''); setOutcomes([]); }}><option value="">Choose a course</option>{(courses.data?.courses || []).map(course => <option key={course.id} value={course.id}>{course.name || course.courseName}</option>)}</select></div>}
        {courseId && (resources.isError ? <p role="alert">Assignments could not be loaded. <Button variant="link" onClick={() => resources.refetch()}>Retry assignments</Button></p>
          : resources.isPending ? <p role="status">Loading assignments and materials…</p> : <div><Label htmlFor="classroom-actions-resource">Assignment or material</Label><select id="classroom-actions-resource" className="w-full rounded border bg-background p-2" disabled={busy} value={resourceId} onChange={event => chooseResource(event.target.value)}><option value="">Choose an assignment or material</option>{(resources.data?.resources || []).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>)}
        {resource && <>
          <p className="text-sm text-muted-foreground">{resource.dueDate ? `Due ${resource.dueDate.year}-${String(resource.dueDate.month).padStart(2, '0')}-${String(resource.dueDate.day).padStart(2, '0')}` : 'No due date'}</p>
          {links.length ? <div><Label htmlFor="classroom-actions-open-url">Link to open</Label><select id="classroom-actions-open-url" className="w-full rounded border bg-background p-2" disabled={busy} value={openUrl} onChange={event => setOpenUrl(event.target.value)}>{links.map(link => <option key={link.id} value={link.url}>{link.title}</option>)}</select><p className="mt-1 break-all text-xs text-muted-foreground">{openUrl}</p></div> : <p>No usable browser links are available.</p>}
          <div className="flex flex-wrap gap-2"><Button disabled={!canOpen} onClick={() => void run('open')}>Open</Button><Button variant="outline" disabled={!canOpen || !classroomCanFocus(students)} title={classroomCanFocus(students) ? undefined : 'A negotiated ClassPilot Focus update is required.'} onClick={() => void run('open-focus')}>Open + Focus</Button></div>
          <p className="text-xs text-muted-foreground">Open uses the current browsing restrictions. Open + Focus requests Focus for each student's confirmed new tab; results may differ by student.</p>
          {preciseResourcesEnabled ? <section className="space-y-3 rounded border p-3" aria-label="Classroom lesson scope">
            <p className="text-sm font-medium">Open as Lesson</p>
            <fieldset className="space-y-2"><legend className="text-sm">Include these resources in the lesson</legend>{links.map(link => <label key={link.id} className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy} checked={selectedLinks.includes(link.id)} onChange={() => { setSelectedLinks(previous => previous.includes(link.id) ? previous.filter(id => id !== link.id) : [...previous, link.id]); setLessonUrl(''); }} /><span className="min-w-0"><span className="block">{link.title}</span><span className="block break-all text-xs text-muted-foreground">{link.url}</span></span></label>)}</fieldset>
            <fieldset className="flex flex-wrap gap-4 text-sm"><legend>Allowed scope</legend><label><input type="radio" name="classroom-actions-boundary" disabled={busy} checked={boundary === 'resource'} onChange={() => { setBoundary('resource'); setLessonUrl(''); }} /> Resource or Section</label><label><input type="radio" name="classroom-actions-boundary" disabled={busy} checked={boundary === 'website'} onChange={() => { setBoundary('website'); setLessonUrl(''); }} /> Entire website and subdomains</label></fieldset>
            <RestrictionScopeReview review={scopeReview} disabled={busy || !chosenLinks.length} />
            {reviewedStarts.length > 0 && <div><Label htmlFor="classroom-actions-lesson-start">Reviewed starting resource</Label><select id="classroom-actions-lesson-start" className="w-full rounded border bg-background p-2" value={startUrl} disabled={busy} onChange={event => setLessonUrl(event.target.value)}>{reviewedStarts.map((item, index) => <option key={`${item.url}:${index}`} value={item.url}>{item.label}: {item.url}</option>)}</select></div>}
            <p className="text-xs text-muted-foreground">The Flight Path must be confirmed on a student's browser before their starting resource opens. Students can move among the reviewed resources. This action does not set Focus.</p>
            <Button disabled={busy || disabled || !students.length || scopeReview.pending || !reviewedStarts.length || !startUrl} onClick={() => void run('lesson')}>Open as Lesson</Button>
          </section> : <p className="text-xs text-muted-foreground">Open as Lesson is unavailable until precise resource restrictions are enabled for your school.</p>}
        </>}
        {busy && <p role="status">Waiting for per-student browser results…</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {outcomes.length > 0 && <section aria-label="Classroom action results" className="space-y-2 text-sm">{outcomes.map(row => <div className="rounded border p-2" key={row.studentId}><p className="font-medium">{students.find(student => student.studentId === row.studentId)?.studentName || 'Student'}</p><p>Restrictions: {outcomeLabel(row.restriction)} · Open: {outcomeLabel(row.open)} · Focus: {outcomeLabel(row.focus)}</p>{row.error && <p className="text-destructive">{row.error}</p>}</div>)}</section>}
        <DialogFooter><Button variant="outline" onClick={close}>{busy ? 'Stop waiting and close' : 'Close'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
