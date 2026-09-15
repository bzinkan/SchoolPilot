import { useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { plannerGradeName, plannerValidWindow, plannerWindowText } from './scheduleDayPlannerModel';
import { classPlacementUnavailable, reviewClassPlacement } from './scheduleClassPlacement';

const inputClass = 'min-w-0 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default function ScheduleClassForTime({ snapshot, stale, disabled, onClose, onApply, onReturnFocus }) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(snapshot.originalId);
  const [action, setAction] = useState('');
  const choicesId = useId();
  const committed = useRef(false);
  const original = snapshot.classes.find(row => row.id === snapshot.originalId);
  const selected = snapshot.classes.find(row => row.id === selectedId);
  const choices = useMemo(() => {
    const text = search.trim().toLocaleLowerCase();
    return snapshot.classes.filter(row => `${row.name} ${plannerGradeName(row.grade)} ${row.teacherName || ''} ${row.staff.map(person => person.name).join(' ')}`.toLocaleLowerCase().includes(text))
      .sort((a, b) => Number(b.id === snapshot.originalId) - Number(a.id === snapshot.originalId) || a.grade.localeCompare(b.grade, undefined, { numeric: true }) || a.name.localeCompare(b.name));
  }, [search, snapshot]);
  const plan = useMemo(() => reviewClassPlacement({ definition: snapshot.definition, classes: snapshot.classes, originalId: snapshot.originalId, selectedId, action }), [snapshot, selectedId, action]);
  const changedClass = selectedId !== snapshot.originalId;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(committed.current ? selectedId : null); }}>
      <DialogHeader><DialogTitle>Class for this time</DialogTitle><DialogDescription>Choose which existing class uses {plannerWindowText(original.proposedWindow)} on the preview for {snapshot.referenceDate}. Review both classes before updating the draft.</DialogDescription></DialogHeader>
      <p className="text-xs text-muted-foreground">This uses each class’s existing roster and teachers. Regular schedules and saved applications remain unchanged.</p>
      {stale && <p role="alert" className="text-sm text-destructive">The schedule changed while this review was open. Cancel and choose the class again before updating the draft.</p>}
      <label className="space-y-1 text-sm"><span>Find an existing class</span><input className={inputClass} type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <fieldset className="max-h-52 space-y-2 overflow-y-auto rounded-md border p-2" disabled={disabled || stale}>
        <legend className="sr-only">Existing classes across all grades</legend>
        {choices.map(row => {
          const unavailable = row.id === snapshot.originalId ? null : classPlacementUnavailable(row);
          const proposedTime = row.detailsUnavailable || row.status === 'unavailable' ? 'Unavailable' : plannerWindowText(row.proposedWindow);
          return <label key={row.id} data-placement-class-id={row.id} className={`flex gap-3 rounded border p-3 text-sm ${unavailable ? 'text-muted-foreground' : selectedId === row.id ? 'border-primary bg-primary/5' : ''}`}>
            <input type="radio" name="placement-class" className="mt-1" aria-label={`Use ${row.name}`} aria-describedby={`${choicesId}-${row.id}`} checked={selectedId === row.id} disabled={Boolean(unavailable)} onChange={() => { setSelectedId(row.id); setAction(''); }} />
            <span id={`${choicesId}-${row.id}`} className="min-w-0"><span className="block font-medium">{row.name}{row.id === snapshot.originalId ? ' · Current class' : ''}</span>
              <span className="block text-xs">{plannerGradeName(row.grade)} · {row.staff.map(person => person.name).join(', ') || row.teacherName || 'Staff unavailable'}</span>
              <span className="block text-xs">{row.studentCount == null ? 'Student count unavailable' : `${row.studentCount} ${row.studentCount === 1 ? 'student' : 'students'}`} · Proposed: {proposedTime}</span>
              {unavailable && <span className="block text-xs">{unavailable}</span>}
            </span>
          </label>;
        })}
        {!choices.length && <p className="p-2 text-sm text-muted-foreground">No classes match this search.</p>}
      </fieldset>
      {changedClass && <fieldset disabled={disabled || stale} className="space-y-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-semibold">What happens to the original class?</legend>
        <label className="flex gap-2 text-sm"><input type="radio" name="placement-action" aria-label="Swap class times" checked={action === 'swap'} disabled={!plannerValidWindow(selected?.proposedWindow)} onChange={() => setAction('swap')} /><span>Swap class times<span className="block text-xs text-muted-foreground">{selected.name} uses {plannerWindowText(original.proposedWindow)}; {original.name} uses {plannerWindowText(selected.proposedWindow)}.</span>{!plannerValidWindow(selected?.proposedWindow) && <span className="block text-xs text-muted-foreground">This class is skipped, so it has no proposed time to swap.</span>}</span></label>
        <label className="flex gap-2 text-sm"><input type="radio" name="placement-action" aria-label="Use selected class; original does not meet" checked={action === 'move-skip'} onChange={() => setAction('move-skip')} /><span>Use selected class; original does not meet<span className="block text-xs text-muted-foreground">{selected.name} uses {plannerWindowText(original.proposedWindow)}; {original.name} does not meet. {selected.name} will not also meet at its previous time.</span></span></label>
      </fieldset>}
      {changedClass && action && !plan.error && <section aria-label="Review class placement" className="space-y-3">
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Class</th><th className="p-2">Before</th><th className="p-2">After</th></tr></thead><tbody>{plan.changes.map(change => {
          const row = snapshot.classes.find(candidate => candidate.id === change.classId);
          return <tr className="border-t" key={change.classId} data-placement-change={change.classId}><th scope="row" className="p-2 font-medium">{change.name}<span className="block text-xs font-normal text-muted-foreground">{row.staff.map(person => person.name).join(', ') || row.teacherName || 'Staff unavailable'}</span><span className="block text-xs font-normal text-muted-foreground">{row.studentCount == null ? 'Student count unavailable' : `${row.studentCount} ${row.studentCount === 1 ? 'student' : 'students'}`}</span></th><td className="p-2">{plannerWindowText(change.before)}</td><td className="p-2">{plannerWindowText(change.after)}</td></tr>;
        })}</tbody></table></div>
        <div className="space-y-1 text-xs">{plan.changes.map(change => <p key={change.classId}>{change.name}: {change.includedBefore ? 'already included in this profile' : 'will be included in this profile'}.</p>)}</div>
        <p className="text-xs text-muted-foreground">Each class remains one meeting with its own roster and staff. These rules apply independently on eligible application dates; review each actual date before applying.</p>
      </section>}
      {changedClass && action && plan.error && <p role="alert" className="text-sm text-destructive">{plan.error}</p>}
      <DialogFooter className="gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel class placement</Button><Button type="button" disabled={disabled || stale || Boolean(plan.error)} onClick={() => { if (committed.current || disabled || stale || plan.error) return; committed.current = true; onApply(plan); }}>Update draft</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
