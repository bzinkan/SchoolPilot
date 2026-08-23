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

const LivePassDuration = memo(function LivePassDuration({ issuedAt }) {
  const nowMs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return formatLivePassDuration(issuedAt, nowMs);
});

export default LivePassDuration;
