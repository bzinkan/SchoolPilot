import { memo, useSyncExternalStore } from 'react';
import { formatLivePassDuration } from '../passDuration';

const listeners = new Set();
let currentTimeMs = Date.now();
let ticker = null;

function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) {
    currentTimeMs = Date.now();
    ticker = window.setInterval(() => {
      currentTimeMs = Date.now();
      for (const notify of listeners) notify();
    }, 3_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  };
}

function getSnapshot() {
  return currentTimeMs;
}

function getServerSnapshot() {
  return 0;
}

// The hook and component intentionally share this module so every PassPilot
// surface subscribes to the same module-scoped ticker.
// eslint-disable-next-line react-refresh/only-export-components
export function usePassNow() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const LivePassDuration = memo(function LivePassDuration({ issuedAt }) {
  const nowMs = usePassNow();
  return formatLivePassDuration(issuedAt, nowMs);
});

export default LivePassDuration;
