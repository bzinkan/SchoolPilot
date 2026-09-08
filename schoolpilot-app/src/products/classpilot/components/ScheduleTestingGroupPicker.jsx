import { useEffect, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import SupervisionGroupEditor from './SupervisionGroupEditor';

const API = '/coverage/supervision-groups';
const inputClass = 'min-w-0 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const staffLabel = person => person.displayName || person.email || 'Unavailable staff member';

export default function ScheduleTestingGroupPicker({ open, onOpenChange, schoolId, actorId, remaining, onAdd, onGroupSaved }) {
  const [filters, setFilters] = useState({ search: '', categoryId: '', grade: '', page: 1 });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState({});
  const [staff, setStaff] = useState({});
  const [times, setTimes] = useState({ startTime: '09:00', endTime: '10:45' });
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [refreshGroup, setRefreshGroup] = useState(null);
  const [refreshingGroup, setRefreshingGroup] = useState(false);
  const submitted = useRef(false);
  const opener = useRef(document.activeElement);
  const createButton = useRef(null);
  const restoreOpener = useRef(false);
  const returnFromEditor = useRef(false);
  const closePicker = value => {
    if (!value) restoreOpener.current = true;
    onOpenChange(value);
  };
  const openGroupEditor = () => {
    restoreOpener.current = false;
    returnFromEditor.current = true;
    setCreating(true);
  };
  useEffect(() => {
    const timer = setTimeout(() => setFilters(current => current.search === search ? current : { ...current, search, page: 1 }), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: ['/api/coverage/supervision-groups/browse', schoolId, actorId, 'testing-picker', filters],
    queryFn: ({ signal }) => apiRequest('GET', `${API}/browse`, undefined, { signal, headers: { 'X-School-Id': schoolId }, params: { ...filters, active: 'true' } }),
    enabled: open && Boolean(schoolId), retry: false,
  });
  const ids = Object.keys(selected);
  const details = useQueries({ queries: ids.map(id => ({
    queryKey: ['/api/coverage/supervision-groups/detail', schoolId, actorId, id, 'summary'],
    queryFn: ({ signal }) => apiRequest('GET', `${API}/${encodeURIComponent(id)}`, undefined, { signal, headers: { 'X-School-Id': schoolId }, params: { view: 'summary' } }),
    enabled: open && Boolean(schoolId), staleTime: 0, retry: false,
  })) });
  const groups = query.data?.groups || [];
  const chosen = ids.map((id, index) => details[index].data?.group || selected[id]);
  const pending = details.some(result => result.isFetching || result.isPending);
  const failed = details.some(result => result.isError);
  const invalidStaff = chosen.some(group => !group.active || !group.staff?.some(person => person.id === staff[group.id]));
  const invalidTimes = !times.startTime || !times.endTime || times.startTime >= times.endTime;
  const toggle = (group, checked) => {
    setSelected(current => { const next = { ...current }; if (checked) next[group.id] = group; else delete next[group.id]; return next; });
    setStaff(current => ({ ...current, [group.id]: checked && group.staff?.length === 1 ? group.staff[0].id : '' }));
  };
  const selectPage = () => {
    setSelected(current => ({ ...current, ...Object.fromEntries(groups.map(group => [group.id, group])) }));
    setStaff(current => ({ ...current, ...Object.fromEntries(groups.filter(group => !selected[group.id]).map(group => [group.id, group.staff?.length === 1 ? group.staff[0].id : ''])) }));
  };
  const changeFilter = patch => setFilters(current => ({ ...current, ...patch, page: 1 }));
  const add = () => {
    if (submitted.current || !ids.length || ids.length > remaining || invalidTimes || invalidStaff || pending || failed) return;
    submitted.current = true;
    onAdd(chosen.map(group => ({ id: crypto.randomUUID(), name: group.name.slice(0, 80), coverageGroupId: group.id, assignedStaffId: staff[group.id], ...times })), chosen);
    closePicker(false);
  };
  return <>
    <Dialog open={open && !creating} onOpenChange={closePicker}>
      <DialogContent onOpenAutoFocus={event => {
        if (returnFromEditor.current) {
          event.preventDefault();
          returnFromEditor.current = false;
          createButton.current?.focus();
        }
      }} onCloseAutoFocus={event => {
        event.preventDefault();
        if (restoreOpener.current && opener.current?.isConnected && !opener.current.closest('[hidden], [inert]')) {
          if (opener.current.matches(':disabled')) {
            const blocks = [...(opener.current.closest('[data-testid="schedule-profile-workspace"]')?.querySelectorAll('[data-block-editor-id]') || [])];
            blocks.at(-1)?.querySelector('input:not(:disabled)')?.focus();
          } else opener.current.focus();
        }
      }} className="flex max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-4xl flex-col overflow-hidden">
        <DialogHeader><DialogTitle>Add testing groups</DialogTitle><DialogDescription>Select groups, set a common testing window, and review each staff assignment. Each group becomes its own editable testing block.</DialogDescription></DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <div className="flex flex-wrap items-center justify-between gap-2"><p role="status" className="text-sm">{ids.length} groups selected · {remaining} blocks available</p><Button ref={createButton} variant="outline" onClick={openGroupEditor}>Create group</Button></div>
          {notice && <p role="status" className="rounded-md border p-3 text-sm">{notice}</p>}
          {refreshGroup && <Button variant="outline" disabled={refreshingGroup} onClick={async () => {
            setRefreshingGroup(true);
            const refreshed = await onGroupSaved?.(refreshGroup);
            setRefreshingGroup(false);
            if (refreshed) { setRefreshGroup(null); setNotice('Group information refreshed. Your profile is still a draft.'); }
          }}>{refreshingGroup ? 'Refreshing group information…' : 'Retry group refresh'}</Button>}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm"><span>Find a supervision group or staff</span><input className={inputClass} value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label className="space-y-1 text-sm"><span>Group category</span><select className={inputClass} value={filters.categoryId} onChange={event => changeFilter({ categoryId: event.target.value })}><option value="">All categories</option><option value="uncategorized">Uncategorized</option>{query.data?.facets?.categories?.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label className="space-y-1 text-sm"><span>Group grade</span><select className={inputClass} value={filters.grade} onChange={event => changeFilter({ grade: event.target.value })}><option value="">All grades</option>{query.data?.facets?.grades?.map(grade => <option key={grade.gradeLevel || 'ungraded'} value={grade.gradeLevel || 'ungraded'}>{grade.gradeLevel ? `Grade ${grade.gradeLevel}` : 'No grade'}</option>)}</select></label>
          </div>
          {query.isPending ? <p role="status">Loading supervision groups…</p> : query.isError ? <div role="alert"><p>Supervision groups could not load.</p><Button variant="outline" onClick={() => query.refetch()}>Retry groups</Button></div> : <>
            <Button variant="outline" size="sm" disabled={!groups.length || query.isFetching} onClick={selectPage}>Select this page</Button>
            <div className="divide-y rounded-md border">{groups.map(group => <label key={group.id} className="flex items-start gap-3 p-3 text-sm"><input className="mt-1" type="checkbox" checked={Boolean(selected[group.id])} onChange={event => toggle(group, event.target.checked)} /><span><span className="block font-medium">{group.name}</span><span className="text-muted-foreground">{group.category?.name || 'Uncategorized'} · {group.studentCount} students · {group.staff?.map(staffLabel).join(', ') || 'No staff assigned'}</span></span></label>)}{!groups.length && <p className="p-4 text-sm">No matching active groups. Change filters or create a group.</p>}</div>
            <div className="flex items-center justify-between gap-2 text-sm"><Button size="sm" variant="outline" disabled={filters.page <= 1 || query.isFetching} onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>Previous groups</Button><span>{query.data?.total || 0} matching groups · Page {query.data?.page || filters.page} of {Math.max(1, query.data?.totalPages || 1)}</span><Button size="sm" variant="outline" disabled={filters.page >= (query.data?.totalPages || 1) || query.isFetching} onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>Next groups</Button></div>
          </>}
          <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm"><span>Common testing start</span><input type="time" className={inputClass} value={times.startTime} onChange={event => setTimes(current => ({ ...current, startTime: event.target.value }))} /></label><label className="space-y-1 text-sm"><span>Common testing end</span><input type="time" className={inputClass} value={times.endTime} onChange={event => setTimes(current => ({ ...current, endTime: event.target.value }))} /></label></div>
          {ids.length > 0 && <section className="space-y-3"><h3 className="font-semibold">Review selected groups</h3><p className="text-sm text-muted-foreground">Assigned staff can supervise this group. The schedule review checks their availability at these times.</p>{chosen.map(group => <div key={group.id} className="rounded-md border p-3"><div className="flex items-center justify-between gap-3"><label className="min-w-0 flex-1 space-y-1 text-sm"><span>{group.name} — assigned staff</span><select className={inputClass} value={staff[group.id] || ''} onChange={event => setStaff(current => ({ ...current, [group.id]: event.target.value }))}><option value="">Choose assigned staff</option>{staff[group.id] && !group.staff?.some(person => person.id === staff[group.id]) && <option value={staff[group.id]}>Unavailable staff assignment</option>}{group.staff?.map(person => <option key={person.id} value={person.id}>{staffLabel(person)}</option>)}</select></label><Button size="sm" variant="ghost" aria-label={`Remove selected group ${group.name}`} onClick={() => toggle(group, false)}>Remove</Button></div>{!group.staff?.length && <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">Assign staff to this group in Supervision Groups before adding it.</p>}{(!group.studentCount || group.inactiveStudentCount > 0) && <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">Review this roster before applying: {group.studentCount} active students, {group.inactiveStudentCount || 0} inactive members.</p>}{!group.active && <p role="alert">This group is no longer active.</p>}</div>)}</section>}
          {pending && <p role="status">Checking selected groups…</p>}
          {failed && <div role="alert"><p>Some selected groups could not be checked.</p><Button variant="outline" onClick={() => details.filter(result => result.isError).forEach(result => result.refetch())}>Retry selected groups</Button></div>}
          {ids.length > remaining && <p role="alert">Select no more than {remaining} groups. A profile can contain 30 testing blocks.</p>}
          {invalidTimes && <p role="alert">Choose a testing end after its start.</p>}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t pt-3"><Button variant="outline" onClick={() => closePicker(false)}>Cancel</Button><Button disabled={!ids.length || ids.length > remaining || invalidTimes || invalidStaff || pending || failed} onClick={add}>Add {ids.length || ''} testing {ids.length === 1 ? 'block' : 'blocks'}</Button></div>
      </DialogContent>
    </Dialog>
    <SupervisionGroupEditor open={creating} schoolId={schoolId} groupId={null} onOpenChange={setCreating} onSaved={async ({ group, refreshWarning }) => {
      toggle(group, true); setCreating(false);
      setNotice(refreshWarning ? 'Group saved; list refresh unavailable. Your profile is still a draft.' : 'Group saved. Your profile is still a draft; discarding the profile will not delete this group.');
      void query.refetch();
      if (await onGroupSaved?.(group) === false) {
        setRefreshGroup(group);
        setNotice('Group saved; list refresh unavailable. Retry the group refresh; do not create the group again.');
      }
    }} />
  </>;
}
