import { memo, useSyncExternalStore } from "react";
import { formatRelativeLastSeen, formatRemainingMinutes } from "../lib/studentMonitoringDisplay";

const MINUTE_MS = 60_000;
const minuteListeners = new Set();
let minuteSnapshot = Date.now();
let minuteBoundaryTimeout = null;
let minuteInterval = null;

function currentMinuteSnapshot() {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

function emitMinuteSnapshot() {
  const nextSnapshot = currentMinuteSnapshot();
  minuteSnapshot = nextSnapshot;
  for (const listener of minuteListeners) listener();
}

function stopMinuteClock() {
  if (minuteBoundaryTimeout !== null) globalThis.clearTimeout(minuteBoundaryTimeout);
  if (minuteInterval !== null) globalThis.clearInterval(minuteInterval);
  minuteBoundaryTimeout = null;
  minuteInterval = null;
}

function startMinuteClock() {
  if (minuteBoundaryTimeout !== null || minuteInterval !== null) return;
  minuteSnapshot = currentMinuteSnapshot();
  const firstDelay = MINUTE_MS - (Date.now() % MINUTE_MS);
  minuteBoundaryTimeout = globalThis.setTimeout(() => {
    minuteBoundaryTimeout = null;
    emitMinuteSnapshot();
    minuteInterval = globalThis.setInterval(emitMinuteSnapshot, MINUTE_MS);
  }, firstDelay);
}

function subscribeToMinuteClock(listener) {
  minuteListeners.add(listener);
  if (minuteListeners.size === 1) startMinuteClock();
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0) stopMinuteClock();
  };
}

function getMinuteSnapshot() {
  return minuteSnapshot;
}

// Every relative timestamp and countdown on the tile wall shares this one
// minute-boundary clock, so 800 tiles cost one timer.
// eslint-disable-next-line react-refresh/only-export-components
export function useMinuteClock() {
  return useSyncExternalStore(
    subscribeToMinuteClock,
    getMinuteSnapshot,
    getMinuteSnapshot,
  );
}

function LastSeenTime({ observedAt, className = "" }) {
  const nowMs = useMinuteClock();

  return (
    <span className={className}>
      {formatRelativeLastSeen(observedAt, nowMs)}
    </span>
  );
}

function ExpiryCountdownLeaf({ expiresAtMs, className = "" }) {
  const nowMs = useMinuteClock();
  const label = formatRemainingMinutes(expiresAtMs, nowMs);
  if (label === null) return null;
  return <span className={className}>{`· ${label}`}</span>;
}

export const ExpiryCountdown = memo(ExpiryCountdownLeaf);

export default memo(LastSeenTime);
