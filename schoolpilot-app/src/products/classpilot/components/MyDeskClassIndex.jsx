import { useEffect, useRef, useState } from 'react';
import { myDeskApi, invalidateMyDesk } from '../lib/myDesk';
import { myDeskError } from '../lib/myDeskModel';

export default function MyDeskClassIndex({ classes, schoolId, viewerId, selectedId, onSelect }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const lifetime = useRef(null); const saving = useRef(false);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const saveDefault = async (grade, id) => {
    const controller = lifetime.current;
    if (saving.current || !controller || controller.signal.aborted) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const preferences = classes.data.preferences;
      await myDeskApi(schoolId, controller.signal).updatePreferences({ revision: preferences.revision,
        preferredClasses: { ...preferences.preferredClasses, [grade]: id } });
      controller.signal.throwIfAborted(); await invalidateMyDesk(schoolId, viewerId);
    } catch (failure) { if (!controller.signal.aborted) { setError(myDeskError(failure)); await classes.refetch(); } }
    finally { saving.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const row = item => <button key={item.id} aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}>{item.name}</button>;
  if (classes.isPending) return <p role="status">Loading classes…</p>;
  if (classes.isError) return <p role="alert" className="mydesk-error">Classes unavailable. <button onClick={() => classes.refetch()}>Retry</button></p>;
  // Older cached responses remain usable during a rolling update.
  if (!classes.data?.personalByGrade) return (classes.data?.current || []).map(row);
  return <>
    <p className="mydesk-index-label">My classes</p>
    {classes.data.personalByGrade.map(grade => <section key={grade.gradeLevel || 'ungraded'} aria-label={grade.gradeLevel ? `Grade ${grade.gradeLevel}` : 'Classes without grade metadata'}>
      <p className="mydesk-index-label">{grade.gradeLevel ? `Grade ${grade.gradeLevel}` : 'Other assigned classes'}</p>
      {grade.classes.map(row)}
      {grade.gradeLevel && (grade.classes.length > 1 || grade.preferenceStale) && <label className="mydesk-default-class">Default class
        <select aria-label={`Default class for grade ${grade.gradeLevel}`} value={grade.preferredClassId || ''} disabled={busy} onChange={event => { if (event.target.value) void saveDefault(grade.gradeLevel, event.target.value); }}>
          <option value="">{grade.preferenceStale ? 'Choose a replacement' : 'Choose once'}</option>{grade.classes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select><small>Used when a student belongs to several classes.</small>
      </label>}
    </section>)}
    {!classes.data.personalByGrade.length && <p className="text-xs text-muted-foreground px-3">No personal class assignments.</p>}
    {!!classes.data.otherCurrent?.length && <details><summary>Other authorized classes ({classes.data.otherCurrent.length})</summary>{classes.data.otherCurrent.map(row)}</details>}
    {error && <p className="mydesk-error" role="alert">{error}</p>}
  </>;
}
