import { useEffect, useMemo, useState } from 'react';

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const scheduleDateText = date => date ? dateFormat.format(new Date(`${date}T12:00:00Z`)) : 'Date unavailable';

// A server clock anchor avoids trusting the administrator computer's wall clock.
// Known boundaries hide expired controls immediately, even when the read fails.
export function useScheduleOverviewClock({ data, onRefresh }) {
  const [clock, setClock] = useState(() => performance.now());
  const checkedAt = Date.parse(data?.summariesCheckedAt);
  const receivedAt = data?.overviewReceivedAt;
  const requestStartedAt = data?.overviewRequestStartedAt;
  const serverNow = Number.isFinite(checkedAt) && Number.isFinite(receivedAt) ? checkedAt + Math.max(0, clock - receivedAt) : null;
  // The server check happened somewhere inside this request. Use its entire
  // duration as an uncertainty bound; network delay must not extend a control.
  const latestServerNow = serverNow === null || !Number.isFinite(requestStartedAt) ? null : serverNow + Math.max(0, receivedAt - requestStartedAt);
  const midnight = Date.parse(data?.nextSchoolDateAt);
  const deadlines = useMemo(() => [data?.nextSchoolDateAt, ...Object.values(data?.applicationSummaries || {}).map(summary => summary?.cancellation?.canRequest ? summary.cancellation.cutoffAt : null)].map(value => Date.parse(value)).filter(Number.isFinite), [data?.nextSchoolDateAt, data?.applicationSummaries]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setClock(performance.now()));
    return () => cancelAnimationFrame(frame);
  }, [checkedAt, receivedAt]);
  useEffect(() => {
    let timer;
    const refreshClock = () => {
      if (document.visibilityState === 'hidden') return;
      setClock(performance.now());
      void onRefresh();
    };
    const now = Number.isFinite(checkedAt) && Number.isFinite(receivedAt) ? checkedAt + Math.max(0, performance.now() - receivedAt) : null;
    const latest = now === null || !Number.isFinite(requestStartedAt) ? null : now + Math.max(0, receivedAt - requestStartedAt);
    const wait = latest === null ? null : Math.min(...deadlines.map(deadline => deadline > latest ? deadline - latest : deadline > now ? deadline - now : Infinity));
    if (Number.isFinite(wait)) timer = window.setTimeout(refreshClock, Math.min(2_147_483_647, Math.max(1, wait + 25)));
    document.addEventListener('visibilitychange', refreshClock);
    window.addEventListener('focus', refreshClock);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', refreshClock); window.removeEventListener('focus', refreshClock); };
  }, [checkedAt, receivedAt, requestStartedAt, deadlines, onRefresh, clock]);
  return { serverNow, latestServerNow, dateStale: latestServerNow !== null && Number.isFinite(midnight) && latestServerNow >= midnight };
}

export function cancellationState(application, summary, serverNow, unavailable, latestServerNow = serverNow) {
  if (application.status === 'cancelled') return { canRequest: false, reason: 'cancelled' };
  if (unavailable || !summary?.cancellation || serverNow === null || latestServerNow === null) return { canRequest: false, reason: 'unavailable' };
  const cutoff = Date.parse(summary.cancellation.cutoffAt);
  if (Number.isFinite(cutoff) && serverNow >= cutoff) return { canRequest: false, reason: 'started' };
  if (summary.cancellation.canRequest && (!Number.isFinite(cutoff) || latestServerNow >= cutoff)) return { canRequest: false, reason: 'unavailable' };
  return summary.cancellation;
}
