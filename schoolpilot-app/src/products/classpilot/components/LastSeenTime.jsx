import { memo, useSyncExternalStore } from "react";
import { formatRelativeLastSeen } from "../lib/studentMonitoringDisplay";

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

function LastSeenTime({ observedAt, className = "" }) {
  const nowMs = useSyncExternalStore(
    subscribeToMinuteClock,
    getMinuteSnapshot,
    getMinuteSnapshot,
  );

  return (
    <span className={className}>
      {formatRelativeLastSeen(observedAt, nowMs)}
    </span>
  );
}

export default memo(LastSeenTime);
