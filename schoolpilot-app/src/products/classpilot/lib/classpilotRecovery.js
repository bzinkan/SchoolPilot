import { normalizeObservedAtForDisplay } from './studentMonitoringDisplay.js';

export const CLASSPILOT_READ_DEADLINE_MS = 8_000;
export const CLASSPILOT_FAST_READ_MS = 5_000;
export const CLASSPILOT_PREVIEW_WATCHDOG_MS = 8_000;
export const CLASSPILOT_FAST_STUDENT_LIMIT = 100;

export function normalizeClasspilotPreviewTimestamp(value, now = Date.now()) {
  return typeof value === 'number' || typeof value === 'string'
    ? normalizeObservedAtForDisplay(value, now)
    : null;
}

export function selectClasspilotFastStudents(students, { eligibleIds, nearViewportIds, tracking, priorityStudentId }) {
  const eligible = students.filter(student => eligibleIds.has(student.studentId));
  const priority = eligible.find(student => student.studentId === priorityStudentId);
  return [
    ...(priority ? [priority] : []),
    ...eligible.filter(student => student !== priority && (!tracking || nearViewportIds.has(student.studentId))),
  ].slice(0, CLASSPILOT_FAST_STUDENT_LIMIT);
}

export function stepClasspilotPreviewRecovery(recoveries, { students, screenshots, denied, observationStatus, now }) {
  const targets = students.slice(0, CLASSPILOT_FAST_STUDENT_LIMIT);
  const retained = new Set(targets.map(student => student.studentId));
  for (const id of recoveries.keys()) if (!retained.has(id)) recoveries.delete(id);
  const due = [];
  let nextAt = now + CLASSPILOT_FAST_READ_MS;
  let gapRecoveries = 0;
  for (const student of targets) {
    const id = student.studentId;
    if (denied.has(id) || observationStatus(student) !== 'observed'
      || student.acceptedCapabilities?.screenshotActiveObservationCadenceV1 !== true) {
      recoveries.delete(id); continue;
    }
    const frame = screenshots.get(id);
    const capturedAt = normalizeClasspilotPreviewTimestamp(frame?.timestamp, now);
    const bindingKey = JSON.stringify([student.realtimeBinding || '', frame?.bindingVersion || '']);
    let entry = recoveries.get(id);
    if (!entry || entry.bindingKey !== bindingKey) {
      entry = { bindingKey, capturedAt, nextAt: (capturedAt ?? now) + CLASSPILOT_PREVIEW_WATCHDOG_MS, recovering: false };
      recoveries.set(id, entry);
    }
    if (capturedAt !== entry.capturedAt) {
      entry.capturedAt = capturedAt;
      if (capturedAt !== null && now - capturedAt < CLASSPILOT_PREVIEW_WATCHDOG_MS) {
        entry.recovering = false;
        entry.nextAt = capturedAt + CLASSPILOT_PREVIEW_WATCHDOG_MS;
      }
    }
    if (now >= entry.nextAt) {
      if (!entry.recovering) gapRecoveries += 1;
      entry.recovering = true;
      entry.nextAt = now + CLASSPILOT_FAST_READ_MS;
      due.push(id);
    }
    nextAt = Math.min(nextAt, entry.nextAt);
  }
  return { due, nextAt, gapRecoveries };
}

export function classpilotReadTimeout() {
  return Object.assign(new Error('Monitoring refresh timed out'), { code: 'CLASSPILOT_READ_TIMEOUT' });
}

// A lease PUT can commit after a caller stops waiting. Keep its raw promise
// alive so a late completion still revokes that exact viewer, never a successor.
export function withClasspilotLeaseDeadline(promise, cleanup, deadlineMs = CLASSPILOT_READ_DEADLINE_MS) {
  let timedOut = false;
  let timer;
  const tracked = Promise.resolve(promise).then(value => {
    if (timedOut) void Promise.resolve(cleanup()).catch(() => {});
    return value;
  }, error => {
    if (timedOut) void Promise.resolve(cleanup()).catch(() => {});
    throw error;
  });
  return Promise.race([tracked, new Promise((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(classpilotReadTimeout()); }, deadlineMs);
  })]).finally(() => clearTimeout(timer));
}

// The race also bounds adapters/interceptors that fail to settle on abort.
// It is deliberately used only for snapshots, never classroom commands.
export function withClasspilotReadDeadline(read, signal, deadlineMs = CLASSPILOT_READ_DEADLINE_MS) {
  const controller = new AbortController();
  let timer;
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(new DOMException('Monitoring request cancelled', 'AbortError')); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(classpilotReadTimeout()); }, deadlineMs);
  });
  return Promise.race([stopped, Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new DOMException('Monitoring request cancelled', 'AbortError');
    return read(controller.signal);
  })]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}

// One latest pending target set per exact cohort. Full reconciliation and
// notifications share permits, requests and the five-second start ceiling.
export function createClasspilotScreenshotQueue({ concurrency = 3, intervalMs = CLASSPILOT_FAST_READ_MS, onSample = () => {} } = {}) {
  const cohorts = new Map();
  let active = 0;
  let timer = null;
  let generation = 0;
  const now = () => performance.now();
  const cancelled = () => new DOMException('Preview context changed', 'AbortError');
  const settle = (waiter, error, value) => {
    waiter.signal?.removeEventListener('abort', waiter.abort);
    if (error) waiter.reject(error); else waiter.resolve(value);
  };
  const drain = () => {
    clearTimeout(timer); timer = null;
    let nextAt = Infinity;
    const ordered = [...cohorts.values()].sort((a, b) => Number(Boolean(b.pending?.priority)) - Number(Boolean(a.pending?.priority)));
    for (const state of ordered) {
      if (!state.pending || state.running) continue;
      const due = state.lastStarted + intervalMs;
      if (due > now()) { nextAt = Math.min(nextAt, due); continue; }
      if (active >= concurrency) break;
      const job = state.pending;
      state.pending = null; state.running = job; state.lastStarted = now();
      job.controller = new AbortController();
      active += 1;
      const started = Date.now();
      const jobGeneration = generation;
      Promise.resolve().then(() => {
        if (jobGeneration !== generation || job.controller.signal.aborted) throw cancelled();
        return job.read([...job.ids], job.controller.signal);
      }).then(value => {
        if (jobGeneration !== generation) throw cancelled();
        onSample({ latencyMs: Date.now() - started, outcome: 'success' });
        job.waiters.forEach(waiter => settle(waiter, null, value));
      }).catch(error => {
        onSample({ latencyMs: Date.now() - started, outcome: error?.code === 'CLASSPILOT_READ_TIMEOUT' ? 'timeout' : 'error' });
        job.waiters.forEach(waiter => settle(waiter, error));
      }).finally(() => {
        active -= 1;
        state.running = null;
        drain();
      });
    }
    if (nextAt !== Infinity && active < concurrency) timer = setTimeout(drain, Math.max(1, nextAt - now()));
  };
  return {
    retain(keys) {
      for (const [key, state] of cohorts) {
        if (keys.has(key)) continue;
        for (const job of [state.pending, state.running]) {
          if (!job) continue;
          job.controller?.abort();
          job.waiters.splice(0).forEach(waiter => settle(waiter, cancelled()));
        }
        state.pending = null;
        cohorts.delete(key);
      }
      drain();
    },
    read({ key, studentIds, read, signal, priority = false }) {
      if (signal?.aborted) return Promise.reject(cancelled());
      if (!studentIds.length || studentIds.length > 50) return Promise.reject(new Error('Preview requests require 1–50 students'));
      let state = cohorts.get(key);
      if (!state) { state = { lastStarted: -Infinity, running: null, pending: null }; cohorts.set(key, state); }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal };
        // Join an existing read only when it already covers every target.
        const job = state.running && studentIds.every(id => state.running.ids.has(id))
          ? state.running
          : state.pending || (state.pending = { ids: new Set(), read, waiters: [], priority });
        job.priority ||= priority;
        studentIds.forEach(id => job.ids.add(id));
        job.waiters.push(waiter);
        waiter.abort = () => {
          job.waiters = job.waiters.filter(entry => entry !== waiter);
          settle(waiter, cancelled());
          if (!job.waiters.length) {
            if (state.pending === job) state.pending = null;
            job.controller?.abort();
          }
          drain();
        };
        signal?.addEventListener('abort', waiter.abort, { once: true });
        drain();
      });
    },
    clear() {
      generation += 1; clearTimeout(timer); timer = null;
      for (const state of cohorts.values()) {
        for (const job of [state.pending, state.running]) {
          if (!job) continue;
          job.controller?.abort();
          job.waiters.splice(0).forEach(waiter => settle(waiter, cancelled()));
        }
        state.pending = null;
      }
      cohorts.clear();
    },
  };
}

export function classpilotReconnectDelay(attempt, random = Math.random()) {
  return Math.min(30_000, 1000 * 2 ** Math.min(6, Math.max(0, attempt - 1))) * (0.75 + random * 0.25);
}

export function classpilotSnapshotRequest(request, method, path, body, options = {}) {
  return method === 'GET' || path === '/classpilot/tiles/screenshots' || path === '/classpilot/tiles/history'
    ? withClasspilotReadDeadline(signal => request(method, path, body, { ...options, signal }), options.signal)
    : request(method, path, body, options);
}

export function createClasspilotTransportMonitor({ socket, onHealth, onPhase, onStable, onTimeout }) {
  let deadline = null, heartbeat = null, stable = null;
  let authenticated = false, probes = false, pendingNonce = null, pendingLegacy = false, disposed = false;
  const clearDeadline = () => { clearTimeout(deadline); deadline = null; };
  const fail = () => {
    if (disposed) return;
    onHealth(false); onPhase('recovering'); onTimeout();
  };
  const expect = (ms) => { clearDeadline(); deadline = setTimeout(fail, ms); };
  const probe = () => {
    if (disposed || document.visibilityState !== 'visible' || socket.readyState !== 1 || !authenticated || deadline) return;
    pendingNonce = probes ? `probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}` : null;
    pendingLegacy = !probes;
    socket.send(JSON.stringify(probes ? { type: 'transport-probe', nonce: pendingNonce } : { type: 'ping' }));
    expect(5_000);
  };
  const pause = () => { clearDeadline(); clearInterval(heartbeat); heartbeat = null; clearTimeout(stable); stable = null; };
  expect(8_000);
  return {
    opened() { onPhase('authenticating'); expect(5_000); },
    authenticated(message) {
      const first = !authenticated;
      authenticated = true; probes = message.transportProbeV1 === true;
      clearDeadline(); pendingNonce = null; pendingLegacy = false;
      onHealth(false); onPhase('subscribing');
      probe();
      if (!heartbeat) heartbeat = setInterval(probe, 10_000);
      if (first) stable = setTimeout(() => { if (!disposed && authenticated) onStable(); }, 30_000);
    },
    message(message) {
      if ((pendingNonce && message.type === 'transport-probe-reply' && message.nonce === pendingNonce)
        || (pendingLegacy && message.type === 'pong')) {
        pendingNonce = null; pendingLegacy = false; clearDeadline(); onHealth(true); onPhase('live');
      }
    },
    visibility() {
      if (document.visibilityState !== 'visible') { pause(); onHealth(false); onPhase('paused'); return; }
      if (authenticated) { pause(); onPhase('recovering'); probe(); heartbeat = setInterval(probe, 10_000); stable = setTimeout(onStable, 30_000); }
      else expect(socket.readyState === 1 ? 5_000 : 8_000);
    },
    dispose() { disposed = true; pause(); },
  };
}
