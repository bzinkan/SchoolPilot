import { useEffect, useRef, useState } from 'react';
import { myDeskApi, invalidateMyDesk } from '../lib/myDesk';
import { myDeskError } from '../lib/myDeskModel';

/** Selected scope stays in the caller's session; only the display preference is saved. */
export default function MyDeskScopePicker({ classes, schoolId, viewerId, value, onChange, includeOtherClasses = false, disabled = false }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lifetime = useRef(null), saving = useRef(false);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, [schoolId, viewerId]);
  const viewBy = classes.data?.preferences?.viewBy || 'grades';
  const changeView = async next => {
    const controller = lifetime.current;
    if (saving.current || disabled || next === viewBy || !classes.data || !controller || controller.signal.aborted) return;
    saving.current = true; setBusy(true); setError('');
    try {
      await myDeskApi(schoolId, controller.signal).updatePreferences({ ...classes.data.preferences, viewBy: next });
      controller.signal.throwIfAborted();
      await invalidateMyDesk(schoolId, viewerId);
      controller.signal.throwIfAborted(); onChange({ gradeLevel: '', classId: '' });
    } catch (failure) { if (!controller.signal.aborted) { setError(myDeskError(failure)); await classes.refetch(); } }
    finally { saving.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  if (classes.isPending) return <p role="status">Loading your grades and classes…</p>;
  if (classes.isError) return <p role="alert">Your classes could not be loaded. <button type="button" onClick={() => classes.refetch()}>Retry</button></p>;
  const personal = (classes.data?.current || []).filter(group => group.personal);
  const other = includeOtherClasses ? classes.data?.otherCurrent || [] : [];
  return <div className="mydesk-scope-picker">
    <div role="group" aria-label="View by" className="mydesk-view-by"><span>View by</span>{[['grades', 'Grades'], ['classes', 'Classes']].map(([key, label]) =>
      <button key={key} type="button" aria-pressed={viewBy === key} disabled={disabled || busy} onClick={() => void changeView(key)}>{label}</button>)}</div>
    {viewBy === 'grades' ? <label>Grade<select aria-label="Grade filter" value={value.gradeLevel || ''} disabled={disabled || busy} onChange={event => onChange({ gradeLevel: event.target.value, classId: '' })}>
      <option value="">All my grades</option>{(classes.data?.grades || []).map(grade => <option key={grade.gradeLevel} value={grade.gradeLevel}>{grade.label}</option>)}
    </select></label> : <label>Class<select aria-label="Class filter" value={value.classId || ''} disabled={disabled || busy} onChange={event => onChange({ gradeLevel: '', classId: event.target.value })}>
      <option value="">All my classes</option><optgroup label="My classes">{personal.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</optgroup>
      {!!other.length && <optgroup label="Other authorized classes">{other.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</optgroup>}
    </select></label>}
    {error && <p role="alert" className="mydesk-error">{error}</p>}
  </div>;
}
