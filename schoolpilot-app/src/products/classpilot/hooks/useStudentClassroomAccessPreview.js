import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';
import { activityRequestHeaders } from '../lib/dashboardActivity';
import { studentClassroomAccessReviewValid } from '../lib/classroomFocus';

export function useStudentClassroomAccessPreview({ schoolId, viewerId, mode, authority, contextAuthorityRevision,
  targetStudentIds, flightPathId, expectedFlightPathUpdatedAt, groupId, expectedRevision, url, scopeKey, enabled = false }) {
  const binding = JSON.stringify({ schoolId, viewerId, mode, authority, contextAuthorityRevision, targetStudentIds,
    flightPathId, expectedFlightPathUpdatedAt, groupId, expectedRevision, url, scopeKey, enabled });
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const request = useRef(null);
  const key = JSON.stringify([binding, attempt]);
  if (result && result.key !== key) setResult(null);
  const visible = enabled && result?.key === key ? result : null;
  useLayoutEffect(() => () => request.current?.abort(), [key]);
  useEffect(() => {
    const [serialized] = JSON.parse(key);
    const input = JSON.parse(serialized);
    const automatic = input.mode === 'automatic-flight-path';
    if (!input.enabled || !input.schoolId || !input.viewerId
      || (automatic ? !input.groupId : !input.authority || !input.targetStudentIds?.length)) return;
    const controller = new AbortController();
    request.current = controller;
    let expiryTimer;
    const endpoint = automatic ? `/groups/${encodeURIComponent(input.groupId)}/automatic-flight-path/classroom-preview`
      : '/classpilot/commands/classroom-access/preview';
    const path = input.flightPathId ? { flightPathId: input.flightPathId, expectedFlightPathUpdatedAt: input.expectedFlightPathUpdatedAt } : {};
    const body = automatic ? { ...path, expectedRevision: input.expectedRevision }
      : { mode: input.mode, ...input.authority, targetScope: 'students', targetStudentIds: input.targetStudentIds, ...path };
    apiRequest('POST', endpoint, body, { signal: controller.signal,
      headers: activityRequestHeaders(input.schoolId, input.contextAuthorityRevision) })
      .then(data => {
        if (controller.signal.aborted) return;
        if (!studentClassroomAccessReviewValid(data, input.mode)) throw new Error('Classroom access could not be reviewed completely. Review again before applying.');
        setResult({ key, data });
        expiryTimer = setTimeout(() => setResult(current => current?.key === key ? { ...current, expired: true } : current), data.expiresAt - Date.now());
      }).catch(failure => { if (!controller.signal.aborted) setResult({ key, failure }); });
    return () => { controller.abort(); clearTimeout(expiryTimer); };
  }, [key]);
  return {
    preview: visible?.data && !visible.expired ? visible.data : null,
    pending: enabled && !visible,
    failure: visible?.failure || null,
    error: visible?.expired ? 'This Classroom access review expired. Review again before applying.' : null,
    review: () => setAttempt(value => value + 1),
    invalidate: () => setResult(current => current?.key === key ? { ...current, expired: true } : current),
  };
}
