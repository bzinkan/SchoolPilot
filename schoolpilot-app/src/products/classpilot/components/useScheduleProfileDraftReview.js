import { useEffect, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';

// Advisory reviews never share a token or busy state with application approval.
export function useScheduleProfileDraftReview({ enabled, schoolId, sessionId, referenceDate, definition, revision }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const requestKey = enabled ? JSON.stringify({ schoolId, sessionId, referenceDate, definition, revision, attempt }) : '';
  useEffect(() => {
    if (!requestKey) return undefined;
    const controller = new AbortController();
    let current = true;
    const timer = window.setTimeout(async () => {
      const { referenceDate: date, definition: draft } = JSON.parse(requestKey);
      try {
        const data = await apiRequest('POST', '/classpilot/admin/schedule-profiles/draft-review', { referenceDate: date, definition: draft }, { signal: controller.signal });
        if (current && data.referenceDate === date) setResult({ key: requestKey, data });
        else if (current) setResult({ key: requestKey, error: new Error('The review returned a different reference date. Retry this review.') });
      } catch (error) {
        if (current && !controller.signal.aborted) setResult({ key: requestKey, error });
      }
    }, 300);
    return () => { current = false; window.clearTimeout(timer); controller.abort(); };
  }, [requestKey]);
  const matching = Boolean(requestKey && result?.key === requestKey);
  return {
    data: matching ? result.data : null,
    error: matching ? result.error : null,
    pending: Boolean(requestKey && !matching),
    enabled,
    retry: () => setAttempt(value => value + 1),
  };
}
