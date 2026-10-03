import { useLayoutEffect, useRef, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';
import { teachingResourceErrorMessage } from '../lib/teachingResourceLibrary';

// Draft previews are deliberately uncached and bound to every authoring input.
// A late response cannot restore a review after an edit or school change.
export function useRestrictionScopePreview({ schoolId, viewerId, input, context, enabled = true }) {
  const key = JSON.stringify([schoolId, viewerId, enabled, input, context]);
  const current = useRef(key);
  const request = useRef(null);
  const [result, setResult] = useState(null);
  if (result && result.key !== key) setResult(null);
  useLayoutEffect(() => { current.current = key; return () => { request.current?.abort(); }; }, [key]);
  const visible = enabled && result?.key === key ? result : null;
  const review = async () => {
    if (!enabled || !schoolId || !viewerId) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const reviewedKey = key;
    setResult({ key, pending: true });
    try {
      const data = await apiRequest('POST', '/classpilot/flight-paths/preview-resources', input, {
        signal: controller.signal, headers: { 'X-School-Id': schoolId },
      });
      if (controller.signal.aborted || current.current !== reviewedKey) return;
      if (data?.schemaVersion !== 1 || data.purpose !== input.purpose || !Array.isArray(data.scopes)
        || !Array.isArray(data.warnings) || !Array.isArray(data.skipped) || !data.authoring
        || !Array.isArray(data.authoring.allowedDomains) || !Array.isArray(data.authoring.resources)
        || (input.purpose === 'waypoint' && typeof data.authoring.url !== 'string')
        || (input.purpose === 'classroom' && !Array.isArray(data.authoring.resourceLinks))
        || (input.boundary && data.boundary !== input.boundary)) throw new Error('The scope review was incomplete. Review again before saving.');
      setResult({ key: reviewedKey, data });
    } catch (error) {
      if (!controller.signal.aborted && current.current === reviewedKey) setResult({ key: reviewedKey, error: teachingResourceErrorMessage(error) });
    }
  };
  return { preview: visible?.data || null, pending: visible?.pending === true, error: visible?.error || null, review };
}
