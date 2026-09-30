import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { useAdminNavigation, useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { teachingToolsShouldBlock } from '../lib/teachingTools';
import { useRestrictionScopePreview } from '../hooks/useRestrictionScopePreview';
import RestrictionScopeReview from './RestrictionScopeReview';

export default function ClassroomWebsiteImport({ schoolId, viewerId, preciseResourcesEnabled = false }) {
  const { requestAction } = useAdminNavigation();
  const [open, setOpen] = useState(false), [courseId, setCourseId] = useState(''), [name, setName] = useState('');
  const [selected, setSelected] = useState(new Set()), [notice, setNotice] = useState('');
  const [boundary, setBoundary] = useState('website');
  const lifetime = useRef({ alive: true, controller: new AbortController() });
  useEffect(() => { const state = lifetime.current; state.alive = true; if (state.controller.signal.aborted) state.controller = new AbortController(); return () => { state.alive = false; state.controller.abort(); }; }, []);
  const request = (method, path, body, signal) => apiRequest(method, path, body, { signal: signal || lifetime.current.controller.signal, headers: { 'X-School-Id': schoolId } });
  const courses = useQuery({ queryKey: ['/api/classroom/courses', 'classroom_resources', schoolId, viewerId], enabled: open,
    queryFn: ({ signal }) => request('GET', '/classroom/courses?purpose=classroom_resources', undefined, signal), retry: false });
  const resources = useQuery({ queryKey: ['/api/classroom/resources', courseId, schoolId, viewerId], enabled: open && Boolean(courseId),
    queryFn: ({ signal }) => request('GET', `/classroom/courses/${encodeURIComponent(courseId)}/resources`, undefined, signal), retry: false });
  const chosen = (resources.data?.resources || []).filter(item => selected.has(item.id));
  const effectiveBoundary = preciseResourcesEnabled ? boundary : 'website';
  const scopeReview = useRestrictionScopePreview({ schoolId, viewerId, enabled: open && Boolean(courseId) && selected.size > 0,
    input: { purpose: 'classroom', boundary: effectiveBoundary, selectedResourceIds: [...selected], resources: chosen.map(item => ({ id: item.id, links: (item.links || []).map(link => ({ url: link.url })) })) },
    context: [courseId, name, preciseResourcesEnabled],
  });
  const reset = () => { setCourseId(''); setName(''); setSelected(new Set()); setBoundary('website'); setOpen(false); };
  const save = useMutation({ mutationFn: () => {
    if (!scopeReview.preview?.scopes.length || scopeReview.pending) throw new Error('Review the selected scope before creating the Flight Path.');
    return request('POST', '/flight-paths/from-classroom', {
      courseId, selectedResourceIds: [...selected], resources: chosen.map(item => ({ id: item.id })),
      // Provenance IDs remain; original links are never merged or re-resolved.
      resourceLinks: scopeReview.preview.authoring.resourceLinks, boundary: effectiveBoundary,
      name: name.trim(), description: 'Created from Google Classroom resources',
    });
  }, onSuccess: () => {
    if (!lifetime.current.alive) return;
    queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] }); reset(); setNotice('Flight Path created. Apply it explicitly from the Dashboard when ready.');
  }, onError: () => { if (lifetime.current.alive) setNotice('The Flight Path could not be created. Your selections are still here.'); } });
  useAdminNavigationBlocker({ id: 'classroom-website-import', dirty: open && Boolean(courseId || name || selected.size), busy: save.isPending,
    shouldBlock: transition => ['teaching-close:classroom', 'classroom-course-switch'].includes(transition.actionId) || teachingToolsShouldBlock(transition), onDiscard: reset });
  const close = () => { void requestAction(reset, { id: 'teaching-close:classroom' }); };
  const connect = () => { void requestAction(async () => {
    try {
      const returnTo = new URL('/classpilot/my-settings?section=websites', window.location.origin).href;
      const data = await request('GET', `/google/auth-url?purpose=classroom_resources&returnTo=${encodeURIComponent(returnTo)}`);
      if (!lifetime.current.alive) return false;
      const url = new URL(data.url);
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('Invalid Google connection URL');
      window.location.assign(url.href);
    } catch { if (lifetime.current.alive) setNotice('Google could not be connected. Try again or contact your school administrator.'); }
  }, { id: 'classroom-connect' }); };
  return <div className="space-y-2"><Button variant="outline" data-testid="button-import-classroom-flight-path" onClick={() => setOpen(true)}>From Classroom</Button>
    <p className="text-sm text-muted-foreground">Use your own Google Classroom resources to build a personal Flight Path.</p>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <Dialog open={open} onOpenChange={value => value ? setOpen(true) : close()}><DialogContent className="max-h-[85dvh] max-w-3xl overflow-y-auto" data-testid="dialog-classroom-flight-path">
      <DialogHeader><DialogTitle>Create Flight Path from Classroom</DialogTitle><DialogDescription>Choose assignments or materials and their linked websites. This does not import student rosters.</DialogDescription></DialogHeader>
      {courses.isError ? <div role="alert" className="space-y-2"><p>Classroom courses could not be loaded. Your own school Google account may need to be connected.</p><Button variant="outline" onClick={connect}>Connect my Google account</Button><Button variant="ghost" onClick={() => courses.refetch()}>Retry courses</Button></div>
        : courses.isPending ? <p role="status">Loading courses…</p> : <div className="space-y-2"><Label htmlFor="personal-classroom-course">Course</Label><select id="personal-classroom-course" disabled={save.isPending} className="w-full rounded-md border bg-background p-2" value={courseId} onChange={event => {
          const value = event.target.value;
          void requestAction(() => { setOpen(true); setCourseId(value); setSelected(new Set()); setName((courses.data?.courses || []).find(course => course.id === value)?.name || 'Classroom Flight Path'); }, { id: 'classroom-course-switch' });
        }}><option value="">Choose a course</option>{(courses.data?.courses || []).map(course => <option key={course.id} value={course.id}>{course.name || course.courseName}</option>)}</select></div>}
      <div className="space-y-2"><Label htmlFor="classroom-flight-path-name">Flight Path name</Label><Input id="classroom-flight-path-name" disabled={save.isPending} value={name} onChange={event => setName(event.target.value)} /></div>
      <fieldset className="space-y-2"><legend className="text-sm font-medium">Allowed scope</legend>
        <label className="flex items-start gap-2 text-sm"><input type="radio" name="classroom-boundary" disabled={save.isPending} checked={effectiveBoundary === 'website'} onChange={() => setBoundary('website')} />
          <span>Website<span className="block text-xs text-muted-foreground">Entire linked websites and their subdomains.</span></span></label>
        {preciseResourcesEnabled && <label className="flex items-start gap-2 text-sm"><input type="radio" name="classroom-boundary" disabled={save.isPending} checked={effectiveBoundary === 'resource'} onChange={() => setBoundary('resource')} />
          <span>Resource<span className="block text-xs text-muted-foreground">One supported video, document or form; other links define a Section and paths below it. Links that cannot use this boundary are left out.</span></span></label>}
      </fieldset>
      {courseId && (resources.isError ? <p role="alert">Resources could not be loaded. <Button variant="link" onClick={() => resources.refetch()}>Retry resources</Button></p>
        : resources.isPending ? <p role="status">Loading resources…</p> : <div className="max-h-72 space-y-2 overflow-auto">{(resources.data?.resources || []).map(resource => <label key={resource.id} className="flex gap-3 rounded border p-3 text-sm"><input type="checkbox" disabled={save.isPending} checked={selected.has(resource.id)} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(resource.id)) next.delete(resource.id); else next.add(resource.id); return next; })} /><span className="min-w-0"><span className="block font-medium">{resource.title}</span><span className="block break-words text-muted-foreground">{resource.links?.length || 0} linked websites</span></span></label>)}</div>)}
      {courseId && selected.size > 0 && <RestrictionScopeReview review={scopeReview} disabled={save.isPending || resources.isPending || resources.isError} />}
      <DialogFooter><Button variant="outline" onClick={close}>Cancel</Button><Button disabled={!courseId || !name.trim() || !selected.size || !scopeReview.preview?.scopes.length || scopeReview.pending || resources.isPending || resources.isError || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Creating…' : 'Create Flight Path'}</Button></DialogFooter>
    </DialogContent></Dialog></div>;
}
