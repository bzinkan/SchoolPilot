import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUp, ArrowDown, ArrowRight, LockKeyhole, Unlock, Plus, Printer, Shuffle, Undo2, StickyNote, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '../../../components/ui/alert-dialog';
import { useMyDeskStudents } from '../hooks/useMyDesk';
import { myDeskApi, invalidateMyDesk } from '../lib/myDesk';
import { myDeskError } from '../lib/myDeskModel';
import { guardPrivateWorkspaceHistory } from '../lib/privateWorkspaceNavigation';
import { createLayout, addDesk, moveDesk, removeDesk, assignStudent, unassignStudent, toggleSeatLock, shuffleSeats, unassignedStudents, rosterChanges, reconcileRoster, MAX_SEATS, GRID } from '../lib/seatingModel';
import SeatingBoard from './SeatingBoard';
import SeatingPrint from './SeatingPrint';
import SeatingRoomTools from './SeatingRoomTools';
import SeatingRoomDrawing from './SeatingRoomDrawing';
import { arrangeMeasured, changeRoomItem } from '../lib/seatingMeasuredModel';
import NoteComposerDialog from './NoteComposerDialog';

const draftOf = chart => ({ name: chart.name, layout: chart.layout, roster: chart.roster, rosterRevision: chart.rosterRevision });
const isConflict = error => error?.response?.data?.code === 'MYDESK_SEATING_REVISION_CONFLICT';

export default function SeatingEditor({ access, initialChart, Shell, ChartForm }) {
  const { schoolId, viewerId } = access; const navigate = useNavigate();
  const [saved, setSaved] = useState(initialChart); const [draft, setDraft] = useState(() => draftOf(initialChart)); const [history, setHistory] = useState([]);
  const [selectedSeat, setSelectedSeat] = useState(null); const [selectedStudent, setSelectedStudent] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [busy, setBusy] = useState(false); const [pending, setPending] = useState(null); const [error, setError] = useState(''); const [conflict, setConflict] = useState(false); const [authorityLost, setAuthorityLost] = useState(false);
  const [confirm, setConfirm] = useState(null); const [preset, setPreset] = useState('rows'); const [copy, setCopy] = useState(null); const [note, setNote] = useState(null);
  const [printOptions, setPrintOptions] = useState(false); const [paper, setPaper] = useState('letter'); const [printout, setPrintout] = useState(null); const [announcement, setAnnouncement] = useState('');
  const lifetime = useRef(null); const working = useRef(false); const transaction = useRef(null);
  const rosterQuery = useMyDeskStudents(schoolId, viewerId, saved.canEdit && !authorityLost ? saved.classId : null, { refetchOnMount: 'always' });
  const currentRoster = (rosterQuery.data?.students || []).map(student => ({ id: student.id, name: student.name || `${student.firstName} ${student.lastName}` }));
  const rosterNeedsReview = Boolean(saved.canEdit && rosterQuery.data && rosterQuery.data.rosterRevision !== draft.rosterRevision);
  const changes = rosterNeedsReview ? rosterChanges(draft.roster, currentRoster) : { added: [], removed: [], renamed: [] };
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(saved));
  const readOnly = !saved.canEdit || authorityLost;
  const editingDisabled = readOnly || busy || Boolean(pending) || rosterQuery.isPending || rosterQuery.isFetching || rosterQuery.isError || rosterNeedsReview || conflict;
  const selected = draft.layout.seats.find(seat => seat.id === selectedSeat);
  const selectedName = draft.roster.find(student => student.id === selected?.studentId)?.name;
  const unassigned = unassignedStudents(draft.layout, draft.roster);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    if (!dirty && !pending && !busy) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, pending, busy]);
  useEffect(() => {
    if (!dirty && !pending && !busy) return;
    return guardPrivateWorkspaceHistory(path => setConfirm({ kind: 'leave', path }));
  }, [dirty, pending, busy]);
  useEffect(() => {
    if (!printout) return;
    const afterPrint = () => setPrintout(null); window.addEventListener('afterprint', afterPrint);
    let inner; const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => window.print()); });
    return () => { cancelAnimationFrame(outer); if (inner) cancelAnimationFrame(inner); window.removeEventListener('afterprint', afterPrint); };
  }, [printout]);
  const change = fn => {
    if (editingDisabled) return;
    try { const next = fn(draft); setHistory([...history.slice(-49), draft]); setDraft(next); setError(''); }
    catch (failure) { setError(failure.message); }
  };
  const changeLayout = fn => change(value => ({ ...value, layout: fn(value.layout) }));
  const undo = () => { if (editingDisabled || !history.length) return; setDraft(history.at(-1)); setHistory(history.slice(0, -1)); setError(''); setSelectedStudent(null); };
  const requestLeave = path => { if (busy) return; if (dirty || pending) setConfirm({ kind: 'leave', path }); else navigate(path); };
  const adopt = chart => { setSaved(chart); setDraft(draftOf(chart)); setHistory([]); setPending(null); transaction.current = null; setConflict(false); setSelectedStudent(null); setSelectedSeat(null); };
  const save = async (kind = 'save') => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    if (!transaction.current) {
      if (editingDisabled || (kind === 'save' && !draft.name.trim())) { setError('Enter a chart name before saving.'); return; }
      transaction.current = { kind, payload: kind === 'current' ? { requestId: crypto.randomUUID(), revision: saved.revision } : { requestId: crypto.randomUUID(), revision: saved.revision, name: draft.name.trim(), layout: draft.layout, rosterRevision: draft.rosterRevision } };
    }
    const tx = transaction.current; working.current = true; setBusy(true); setError('');
    try {
      const api = myDeskApi(schoolId, controller.signal);
      const result = tx.kind === 'current' ? await api.currentSeatingChart(saved.id, tx.payload) : await api.updateSeatingChart(saved.id, tx.payload);
      controller.signal.throwIfAborted(); adopt(result.chart); setAnnouncement(tx.kind === 'current' ? 'Current chart updated.' : 'Chart saved.');
      await invalidateMyDesk(schoolId, viewerId); controller.signal.throwIfAborted();
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(myDeskError(failure));
        if (isConflict(failure)) { transaction.current = null; setPending(null); setConflict(true); }
        else if (failure.response?.status >= 400 && failure.response?.status < 500) {
          transaction.current = null; setPending(null);
          if (failure.response?.data?.code === 'MYDESK_SEATING_ROSTER_CHANGED') void rosterQuery.refetch();
          if (failure.response?.status === 403 || failure.response?.data?.code === 'MYDESK_SEATING_READ_ONLY') setAuthorityLost(true);
        } else setPending(tx);
      }
    } finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const reload = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    working.current = true; setBusy(true);
    try { const { chart } = await myDeskApi(schoolId, controller.signal).seatingChart(saved.id); controller.signal.throwIfAborted(); adopt(chart); setAuthorityLost(false); setError(''); void rosterQuery.refetch(); }
    catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const confirmAction = () => {
    const action = confirm; setConfirm(null);
    if (action.kind === 'leave') { navigate(action.path); return; }
    if (action.kind === 'reload') { void reload(); return; }
    if (action.kind === 'cancel') { if (pending) void reload(); else { adopt(saved); setError(''); } return; }
    if (action.kind === 'remove') { changeLayout(layout => removeDesk(layout, action.seat.id)); setSelectedSeat(null); return; }
    if (action.kind === 'layout') { changeLayout(() => action.layout); setSelectedSeat(null); return; }
    if (action.kind === 'roster') {
      try { const result = reconcileRoster(draft.layout, draft.roster, action.roster); setHistory([...history.slice(-49), draft]); setDraft({ ...draft, layout: result.layout, roster: action.roster, rosterRevision: action.revision }); setSelectedStudent(null); setError(''); }
      catch (failure) { setError(failure.message); }
    }
  };
  const remove = seat => { if (editingDisabled) return; if (seat.locked) { setError('Unlock the seat before removing its desk.'); return; } if (seat.studentId) setConfirm({ kind: 'remove', seat }); else { changeLayout(layout => removeDesk(layout, seat.id)); setSelectedSeat(null); } };
  const assign = (seatId, studentId) => { changeLayout(layout => assignStudent(layout, seatId, studentId)); setSelectedStudent(null); };
  const previewArrangement = () => {
    try { const layout = draft.layout.version === 2 ? arrangeMeasured(draft.layout, preset, draft.roster.length) : createLayout(preset, draft.roster.length); setConfirm({ kind: 'layout', layout }); setError(''); }
    catch (failure) { setError(failure.message); }
  };
  const keyUndo = event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { event.preventDefault(); undo(); } };
  const confirmText = confirm?.kind === 'remove' ? ['Remove this occupied desk?', 'The student returns to the unassigned list.'] : confirm?.kind === 'roster' ? ['Update this draft with the current roster?', 'Remaining students keep their seats. New students are unassigned; departed students leave empty, unlocked desks. Save when you are ready.'] : confirm?.kind === 'layout' ? ['Replace this draft layout?', 'Review the arrangement before applying. Room boundaries and fixtures stay in place; student placements are cleared. You can Undo before saving.'] : ['Discard unsaved changes?', pending ? 'A save response was interrupted. Cancel reloads the saved chart so an already completed save is preserved.' : 'Your last saved chart stays unchanged.'];
  return <Shell onNavigate={requestLeave}><main className="seating-editor" onKeyDown={keyUndo}>
    <div className="seating-editor-heading"><div><Button variant="ghost" onClick={() => requestLeave('/classpilot/my-desk/seating')}><ArrowLeft className="size-4" />All charts</Button><p>{saved.className}{saved.isCurrent && <span className="seating-current">Current</span>}</p><h1>{saved.name}</h1></div><div className="seating-save-tools"><span role="status">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span><Button variant="outline" disabled={dirty || busy || Boolean(pending)} onClick={() => setPrintOptions(true)}><Printer className="size-4" />Print</Button>{!readOnly && <><Button variant="ghost" disabled={busy || (!dirty && !pending)} onClick={() => setConfirm({ kind: 'cancel' })}>Cancel changes</Button><Button disabled={busy || (!pending && (editingDisabled || !dirty))} onClick={() => save()}>{pending ? 'Retry save' : 'Save chart'}</Button></>}</div></div>
    {readOnly && <div className="seating-notice">This saved chart is available for viewing and printing. <Button variant="outline" onClick={() => setCopy({ mode: 'layout', sessionId: crypto.randomUUID() })}>Reuse its empty layout</Button></div>}
    {rosterNeedsReview && <section className="seating-notice" aria-label="Roster changes"><h2>The class roster has changed</h2><p>{changes.added.length} added · {changes.removed.length} departed · {changes.renamed.length} renamed</p><ul>{changes.added.map(item => <li key={`added-${item.id}`}>Added: {item.name}</li>)}{changes.removed.map(item => <li key={`removed-${item.id}`}>Departed: {item.name}</li>)}{changes.renamed.map(item => <li key={`renamed-${item.id}`}>Renamed: {item.before} → {item.after}</li>)}</ul><Button disabled={busy || Boolean(pending) || rosterQuery.isFetching || rosterQuery.isError} onClick={() => setConfirm({ kind: 'roster', roster: currentRoster, revision: rosterQuery.data.rosterRevision })}>Review roster update</Button></section>}
    {!readOnly && rosterQuery.isError && <p role="alert" className="seating-error">The current roster could not be checked. <Button variant="outline" onClick={() => rosterQuery.refetch()}>Retry roster</Button></p>}
    {error && <div role="alert" className="seating-error"><p>{error}</p>{conflict && <><p>Your draft is still here. Reload the saved chart or keep this draft as a separately named chart.</p><Button variant="outline" disabled={busy} onClick={() => setConfirm({ kind: 'reload' })}>Reload saved chart</Button><Button variant="outline" onClick={() => setCopy({ mode: 'chart', initialDraft: draft, sessionId: crypto.randomUUID() })}>Save as new chart</Button></>}</div>}
    <p className="sr-only" role="status">{announcement}</p>
    {!readOnly && <div className="seating-toolbar"><label>Chart name<Input aria-label="Chart name" maxLength={120} value={draft.name} disabled={editingDisabled} onChange={event => change(value => ({ ...value, name: event.target.value }))} /></label><Button variant="outline" disabled={editingDisabled || !history.length} onClick={undo}><Undo2 className="size-4" />Undo</Button><Button variant="outline" disabled={editingDisabled || draft.layout.seats.length >= MAX_SEATS} onClick={() => changeLayout(addDesk)}><Plus className="size-4" />Add desk</Button><Button variant="outline" disabled={editingDisabled || draft.layout.seats.length < draft.roster.length} onClick={() => changeLayout(layout => shuffleSeats(layout, draft.roster))}><Shuffle className="size-4" />Shuffle</Button><label>Layout<select aria-label="Layout preset" value={preset} disabled={editingDisabled} onChange={event => setPreset(event.target.value)}><option value="rows">Rows</option><option value="pairs">Pairs</option><option value="groups">Groups</option><option value="blank">Blank room</option></select></label><Button variant="outline" disabled={editingDisabled || draft.layout.seats.some(seat => seat.locked)} onClick={previewArrangement}>Apply layout</Button>{!saved.isCurrent && <Button variant="ghost" disabled={editingDisabled || dirty} onClick={() => save('current')}>Make current</Button>}</div>}
    <p className="seating-hint">{draft.layout.seats.length} of {MAX_SEATS} desks{draft.layout.seats.length >= MAX_SEATS ? ' — desk limit reached.' : '.'}{dirty && ' Save changes before printing.'}{draft.layout.seats.some(seat => seat.locked) && ' Unlock all seats before replacing the layout.'}</p><div className="seating-workspace"><SeatingBoard layout={draft.layout} roster={draft.roster} selectedSeat={selectedSeat} selectedStudent={selectedStudent} selectedItem={selectedItem} onSelectItem={id => { setSelectedItem(id); setSelectedSeat(null); }} onGeometry={(collection, id, patch) => changeLayout(layout => changeRoomItem(layout, collection, id, patch))} disabled={editingDisabled} onSelectSeat={id => { setSelectedSeat(id); setSelectedItem(null); }} onAssign={assign} onMove={(id, x, y) => changeLayout(layout => moveDesk(layout, id, x, y))} onRemove={remove} />
      <aside className="seating-inspector"><SeatingRoomTools layout={draft.layout} roster={draft.roster} selectedSeat={selectedSeat} selectedItem={selectedItem} onSelectItem={id => { setSelectedItem(id); setSelectedSeat(null); }} disabled={editingDisabled} onChange={changeLayout} /><section><h2>{selected ? `Seat ${draft.layout.seats.indexOf(selected) + 1}` : 'Seat details'}</h2><label>Selected seat<select aria-label="Selected seat" value={selectedSeat || ''} onChange={event => setSelectedSeat(event.target.value || null)}><option value="">Choose a seat</option>{draft.layout.seats.map((seat, index) => <option key={seat.id} value={seat.id}>{index + 1}. {draft.roster.find(student => student.id === seat.studentId)?.name || 'Empty'}</option>)}</select></label>{selected && <><p className="seating-selected-name">{selectedName || 'Empty seat'}</p>{!readOnly && <><div className="seating-move-controls" aria-label="Move selected desk">{[[ArrowLeft, -GRID, 0, 'Move desk left'], [ArrowUp, 0, -GRID, 'Move desk up'], [ArrowDown, 0, GRID, 'Move desk down'], [ArrowRight, GRID, 0, 'Move desk right']].map(([Icon, x, y, label]) => <Button key={label} size="icon" variant="outline" aria-label={label} disabled={editingDisabled} onClick={() => changeLayout(layout => moveDesk(layout, selected.id, selected.x + x, selected.y + y))}><Icon className="size-4" /></Button>)}</div><Button variant="outline" disabled={editingDisabled || !selected.studentId} onClick={() => changeLayout(layout => toggleSeatLock(layout, selected.id))}>{selected.locked ? <Unlock className="size-4" /> : <LockKeyhole className="size-4" />}{selected.locked ? 'Unlock seat' : 'Lock seat'}</Button>{selected.studentId && <><Button variant="outline" disabled={editingDisabled || selected.locked} onClick={() => setSelectedStudent(selected.studentId)}>Move student</Button><Button variant="ghost" disabled={editingDisabled || selected.locked} onClick={() => changeLayout(layout => unassignStudent(layout, selected.id))}>Unassign student</Button><Button variant="outline" disabled={busy || rosterQuery.isPending || rosterQuery.isFetching || rosterQuery.isError || !currentRoster.some(student => student.id === selected.studentId)} onClick={() => setNote({ sessionId: crypto.randomUUID(), student: { id: selected.studentId, name: selectedName } })}><StickyNote className="size-4" />Add private note</Button></>}<Button variant="ghost" disabled={editingDisabled || selected.locked} onClick={() => remove(selected)}><Trash2 className="size-4" />Remove desk</Button></>}</>}</section>
        <section><h2>Unassigned <span>{unassigned.length}</span></h2>{selectedStudent && <p className="seating-placement-prompt" role="status">Choose a seat for {draft.roster.find(student => student.id === selectedStudent)?.name}. <button onClick={() => setSelectedStudent(null)}>Cancel placement</button></p>}{selectedStudent && <Button variant="outline" disabled={editingDisabled || !selected || selected.locked} onClick={() => assign(selected.id, selectedStudent)}>Place in selected seat</Button>}{!unassigned.length ? <p>Everyone has a seat.</p> : <ul className="seating-student-tray">{unassigned.map(student => <li key={student.id}><button type="button" disabled={editingDisabled} draggable={!editingDisabled} aria-pressed={selectedStudent === student.id} onDragStart={event => event.dataTransfer.setData('text/plain', student.id)} onClick={() => setSelectedStudent(selectedStudent === student.id ? null : student.id)}>{student.name}</button></li>)}</ul>}{draft.layout.seats.length < draft.roster.length && !readOnly && <p>Add {draft.roster.length - draft.layout.seats.length} more desks to shuffle the whole class.</p>}</section>
      </aside></div>
    <AlertDialog open={Boolean(confirm)} onOpenChange={open => { if (!open) setConfirm(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmText[0]}</AlertDialogTitle><AlertDialogDescription>{confirmText[1]}</AlertDialogDescription></AlertDialogHeader>{confirm?.kind === 'layout' && confirm.layout.version === 2 && <SeatingRoomDrawing layout={confirm.layout} roster={draft.roster} />}<AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction onClick={confirmAction}>{confirm?.kind === 'roster' ? 'Update draft' : confirm?.kind === 'remove' ? 'Remove desk' : confirm?.kind === 'layout' ? 'Replace layout' : 'Discard changes'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    {copy && <ChartForm key={copy.sessionId} access={access} source={saved} {...copy} onLeave={requestLeave} onClose={() => setCopy(null)} onSaved={chart => navigate(`/classpilot/my-desk/seating/${chart.id}`)} />}
    {note && <NoteComposerDialog key={note.sessionId} {...note} open schoolId={schoolId} viewerId={viewerId} groupId={saved.classId} today={access.schoolDate} timeZone={access.school?.timezone} onOpenChange={open => { if (!open) setNote(null); }} />}
    <Dialog open={printOptions} onOpenChange={setPrintOptions}><DialogContent><DialogHeader><DialogTitle>Print saved chart</DialogTitle><DialogDescription>Includes the chart name, class, seat numbers, student names, and classroom front.</DialogDescription></DialogHeader><label className="seating-paper-choice">Paper size<select aria-label="Paper size" value={paper} onChange={event => setPaper(event.target.value)}><option value="letter">Letter landscape</option><option value="a4">A4 landscape</option></select></label><Button onClick={() => { setPrintOptions(false); setPrintout({ chart: saved, paper }); }}>Open print preview</Button></DialogContent></Dialog>
    {printout && <SeatingPrint chart={printout.chart} paper={printout.paper} />}
  </main></Shell>;
}
