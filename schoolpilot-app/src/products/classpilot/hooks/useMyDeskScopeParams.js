import { useSearchParams } from 'react-router-dom';

/** The grade or class filter lives in the URL, so every My Desk tab carries it to the next. */
export function useMyDeskScopeParams() {
  const [params, setParams] = useSearchParams();
  const classId = params.get('classId') || '';
  const scope = { classId, gradeLevel: classId ? '' : params.get('gradeLevel') || '' };
  const setScope = next => setParams(previous => {
    const updated = new URLSearchParams(previous);
    updated.delete('gradeLevel'); updated.delete('classId');
    if (next.classId) updated.set('classId', next.classId); else if (next.gradeLevel) updated.set('gradeLevel', next.gradeLevel);
    return updated;
  }, { replace: true });
  return [scope, setScope];
}
