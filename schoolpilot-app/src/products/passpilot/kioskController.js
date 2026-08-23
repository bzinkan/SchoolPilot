export const KIOSK_HEALTHY_POLL_MS = 5_000;
export const KIOSK_FAILURE_BACKOFF_MS = Object.freeze([5_000, 10_000, 20_000, 30_000]);

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function comparableRevision(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
  return null;
}

function kioskHealthFailureReason(error) {
  if (error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') return 'timeout';
  if (Number(error?.status) >= 500) return 'server';
  if (Number(error?.status) >= 400 || error?.code === 'KIOSK_TOKEN_MISSING') return 'invalid_response';
  if (error?.name === 'TypeError' || !error?.status) return 'network';
  return 'unknown';
}

export function kioskFailureDelay(failureCount, random = Math.random) {
  const base = KIOSK_FAILURE_BACKOFF_MS[
    Math.min(Math.max(1, failureCount) - 1, KIOSK_FAILURE_BACKOFF_MS.length - 1)
  ];
  const jitter = 0.9 + (Math.max(0, Math.min(1, Number(random()) || 0)) * 0.2);
  return Math.round(base * jitter);
}

export function createKioskPollingController({
  request,
  onResult = () => {},
  onError = () => {},
  onStatus = () => {},
  onHealthEvent = () => {},
  getRevision = (value) => value?.revision ?? null,
  healthyDelayMs = KIOSK_HEALTHY_POLL_MS,
  random = Math.random,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let running = false;
  let timer = null;
  let inFlight = null;
  let refreshPending = false;
  let requestRevision = 0;
  let committedRequestRevision = 0;
  let latestDataRevision = null;
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let outageReported = false;

  const reportHealth = async (event, signal) => {
    try {
      await onHealthEvent(event, { signal });
    } catch {
      // Health telemetry is advisory. It must never replace kiosk state or
      // change the controller's data-polling outcome.
    }
  };

  const emitStatus = (isPolling = Boolean(inFlight)) => {
    onStatus({
      isPolling,
      isOffline: consecutiveFailures > 0,
      consecutiveFailures,
      lastSuccessAt,
      latestDataRevision,
    });
  };

  const schedule = (delay) => {
    if (!running) return;
    if (timer != null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void run();
    }, delay);
  };

  const run = async () => {
    if (!running) return;
    if (inFlight) {
      refreshPending = true;
      inFlight.abortController.abort();
      return;
    }

    const revision = ++requestRevision;
    const abortController = new AbortController();
    inFlight = { revision, abortController };
    emitStatus(true);
    let succeeded = false;

    try {
      const failuresBeforeRequest = consecutiveFailures;
      const result = await request({
        signal: abortController.signal,
        requestRevision: revision,
        latestDataRevision,
      });
      if (!running || abortController.signal.aborted || inFlight?.revision !== revision) return;

      const incomingRevision = getRevision(result);
      const incomingComparable = comparableRevision(incomingRevision);
      const latestComparable = comparableRevision(latestDataRevision);
      const duplicateDataRevision = incomingRevision != null
        && latestDataRevision != null
        && String(incomingRevision) === String(latestDataRevision);
      const staleDataRevision = incomingComparable != null
        && latestComparable != null
        && incomingComparable < latestComparable;

      if (!staleDataRevision && !duplicateDataRevision && revision > committedRequestRevision) {
        await onResult(result, { requestRevision: revision, dataRevision: incomingRevision });
        committedRequestRevision = revision;
        if (incomingRevision != null) latestDataRevision = incomingRevision;
      }
      consecutiveFailures = 0;
      lastSuccessAt = now();
      succeeded = true;
      if (outageReported && failuresBeforeRequest >= 3) {
        outageReported = false;
        await reportHealth({
          event: 'snapshot_recovery',
          consecutiveFailures: failuresBeforeRequest,
        }, abortController.signal);
      }
    } catch (error) {
      if (!running || abortController.signal.aborted || isAbortError(error)) return;
      consecutiveFailures += 1;
      await onError(error, { requestRevision: revision, consecutiveFailures });
      if (!outageReported && consecutiveFailures >= 3) {
        outageReported = true;
        await reportHealth({
          event: 'snapshot_failure',
          consecutiveFailures,
          reason: kioskHealthFailureReason(error),
        }, abortController.signal);
      }
    } finally {
      if (inFlight?.revision === revision) inFlight = null;
      if (running) {
        emitStatus(false);
        if (refreshPending) {
          refreshPending = false;
          void run();
        } else {
          schedule(succeeded
            ? healthyDelayMs
            : kioskFailureDelay(consecutiveFailures, random));
        }
      }
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      void run();
    },
    refresh() {
      if (!running) return;
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
      if (inFlight) {
        refreshPending = true;
        inFlight.abortController.abort();
        return;
      }
      void run();
    },
    stop() {
      running = false;
      refreshPending = false;
      if (timer != null) clearTimer(timer);
      timer = null;
      inFlight?.abortController.abort();
    },
    getState() {
      return {
        running,
        inFlight: Boolean(inFlight),
        requestRevision,
        committedRequestRevision,
        latestDataRevision,
        consecutiveFailures,
        lastSuccessAt,
      };
    },
  };
}

export class KioskRequestError extends Error {
  constructor(message, { status = 0, code = null, body = null } = {}) {
    super(message);
    this.name = 'KioskRequestError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function kioskResponseError(response, fallback) {
  const body = await response.json().catch(() => ({}));
  return new KioskRequestError(body?.error || fallback, {
    status: response.status,
    code: body?.code || null,
    body,
  });
}

const launchTicketRedemptions = new Map();

export async function redeemKioskLaunchTicket({ client, ticket }) {
  if (!ticket) return { handled: false, deviceId: null };
  const existing = launchTicketRedemptions.get(ticket);
  if (existing) return existing;

  // A one-use ticket request is deliberately independent of the polling
  // AbortController. React StrictMode can supersede the first effect after the
  // server consumes the ticket; sharing this promise lets the surviving effect
  // receive the same opaque continuity id without replaying the ticket.
  const attempt = (async () => {
    const response = await client.request('/api/passpilot/kiosk/launch-ticket/redeem', {
      method: 'POST',
      body: JSON.stringify({ ticket }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      return {
        handled: true,
        deviceId: typeof body?.deviceId === 'string' ? body.deviceId : null,
      };
    }
    if ([400, 404, 405].includes(response.status)) {
      // Continuity is optional. Invalid, expired, replayed, or unsupported
      // tickets fall back to the locally generated kiosk id.
      return { handled: true, deviceId: null };
    }
    throw new KioskRequestError(body?.error || 'Kiosk continuity is unavailable.', {
      status: response.status,
      code: body?.code || null,
      body,
    });
  })();
  launchTicketRedemptions.set(ticket, attempt);
  void attempt.finally(() => {
    if (launchTicketRedemptions.get(ticket) === attempt) launchTicketRedemptions.delete(ticket);
  }).catch(() => {});
  return attempt;
}

function tokenExpiry(data, now) {
  const numericExpiry = Number(data?.expiresAt);
  if (Number.isFinite(numericExpiry) && numericExpiry > 0) {
    return numericExpiry < 10_000_000_000 ? numericExpiry * 1_000 : numericExpiry;
  }
  const explicit = Date.parse(data?.expiresAt || '');
  if (Number.isFinite(explicit)) return explicit;
  const seconds = Number(data?.expiresInSeconds ?? data?.expiresIn);
  return now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 14 * 60_000);
}

export function createKioskApiClient({
  schoolId,
  pin,
  getSessionId = () => null,
  commonHeaders = {},
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
}) {
  let authMode = 'unknown';
  let token = null;
  let tokenExpiresAt = 0;

  const baseHeaders = (extra = {}) => ({
    'Content-Type': 'application/json',
    'X-School-Id': schoolId,
    ...commonHeaders,
    ...(getSessionId() ? { 'X-Kiosk-Session': getSessionId() } : {}),
    ...(authMode === 'token' && token
      ? { 'X-Kiosk-Token': token }
      : { 'X-Kiosk-Pin': pin }),
    ...extra,
  });

  const authenticate = async (signal, force = false) => {
    if (!force && authMode === 'legacy') return;
    if (!force && authMode === 'token' && token && tokenExpiresAt - now() > 30_000) return;

    const response = await fetchImpl('/api/passpilot/kiosk/auth', {
      method: 'POST',
      credentials: 'omit',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-School-Id': schoolId,
        'X-Kiosk-Pin': pin,
        ...commonHeaders,
      },
    });
    if (response.status === 404 || response.status === 405) {
      const body = await response.json().catch(() => ({}));
      if (body?.code) {
        throw new KioskRequestError(body.error || 'Kiosk authentication is unavailable.', {
          status: response.status,
          code: body.code,
          body,
        });
      }
      authMode = 'legacy';
      token = null;
      tokenExpiresAt = 0;
      return;
    }
    if (!response.ok) throw await kioskResponseError(response, 'Kiosk authentication is unavailable.');
    const data = await response.json().catch(() => ({}));
    const nextToken = data?.token || data?.kioskToken || data?.accessToken;
    if (!nextToken) {
      throw new KioskRequestError('Kiosk authentication returned no token.', {
        status: response.status,
        code: 'KIOSK_TOKEN_MISSING',
      });
    }
    authMode = 'token';
    token = String(nextToken);
    tokenExpiresAt = tokenExpiry(data, now);
  };

  const request = async (url, options = {}) => {
    await authenticate(options.signal);
    const extraHeaders = { ...(options.headers || {}) };
    delete extraHeaders['X-Kiosk-Token'];
    delete extraHeaders['X-Kiosk-Pin'];
    delete extraHeaders['X-School-Id'];
    const requestOptions = {
      ...options,
      credentials: 'omit',
      headers: baseHeaders(extraHeaders),
    };
    let response = await fetchImpl(url, requestOptions);
    if (response.status === 401 && authMode === 'token') {
      token = null;
      tokenExpiresAt = 0;
      await authenticate(options.signal, true);
      response = await fetchImpl(url, {
        ...requestOptions,
        headers: baseHeaders(extraHeaders),
      });
    }
    return response;
  };

  return {
    request,
    headers: baseHeaders,
    getAuthMode: () => authMode,
    clearToken() {
      if (authMode === 'token') authMode = 'unknown';
      token = null;
      tokenExpiresAt = 0;
    },
  };
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function kioskSnapshotRevision(response, payload) {
  const revisions = record(payload?.revisions);
  return payload?.revision
    ?? payload?.snapshotRevision
    ?? revisions.snapshot
    ?? response?.headers?.get?.('etag')
    ?? null;
}

export function normalizeKioskSnapshot(value) {
  const payload = record(value);
  const config = record(payload.config);
  const session = payload.session == null ? null : record(payload.session);
  const rosterValue = payload.roster ?? payload.students ?? config.students;
  const roster = Array.isArray(rosterValue)
    ? rosterValue
    : Array.isArray(rosterValue?.students)
      ? rosterValue.students
      : [];
  const passes = Array.isArray(payload.passes) ? payload.passes : [];
  const source = payload.source ?? config.source ?? session?.source ?? null;
  const classId = payload.classId ?? config.classId ?? session?.classId ?? null;
  const className = payload.className ?? config.className ?? session?.className ?? null;
  const kioskName = payload.kioskName ?? config.kioskName ?? session?.kioskName ?? null;
  const activePasses = new Map();
  for (const pass of passes) {
    const studentId = pass?.studentId || pass?.student_id;
    if (!studentId || pass?.status === 'returned' || pass?.returnedAt) continue;
    activePasses.set(String(studentId), pass);
  }

  return {
    revision: payload.revision ?? payload.snapshotRevision ?? record(payload.revisions).snapshot ?? null,
    kioskStyle: payload.kioskStyle ?? config.kioskStyle,
    source,
    classId,
    className,
    kioskName,
    session: session ? { ...session, source, classId, className, kioskName } : null,
    classes: Array.isArray(payload.classes) ? payload.classes : null,
    students: roster.map((student) => {
      const studentId = String(student?.id || student?.studentId || '');
      return activePasses.has(studentId) && !student?.activePass
        ? { ...student, activePass: activePasses.get(studentId) }
        : student;
    }),
  };
}
