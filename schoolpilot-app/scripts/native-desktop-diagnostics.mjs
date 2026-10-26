// Content-free diagnostics shared by real local synthetic acceptance harnesses.
// Never persist request URLs, identifiers, bodies, messages, or image bytes.
export function nativeRequestOperation(request) {
  const pathname = new URL(request.url()).pathname;
  if (!pathname.startsWith('/api/classpilot/native/')) return null;
  if (pathname.includes('/observation-leases/')) return request.method() === 'PUT' ? 'lease_put'
    : request.method() === 'DELETE' ? 'lease_delete' : 'native_other';
  if (pathname.endsWith('/tiles/desktop')) {
    try { return request.postDataJSON()?.selectedSources?.length ? 'selected_read' : 'metadata'; }
    catch { return 'native_other'; }
  }
  return 'native_other';
}

export function safeNativeErrorCode(body) {
  return typeof body?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(body.code) ? body.code : 'UNCLASSIFIED';
}

export function attachNativeRequestDiagnostics(page, { metrics, event, elapsed }) {
  const pending = new WeakMap();
  const viewers = new Map();
  metrics.requests = [];
  const viewerOrdinal = request => {
    let key;
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes('/observation-leases/')) key = pathname.split('/').at(-1);
    else { try { key = request.postDataJSON()?.viewerInstanceId; } catch { /* No request body. */ } }
    if (typeof key !== 'string' || !key) return null;
    if (!viewers.has(key)) viewers.set(key, viewers.size + 1);
    return viewers.get(key);
  };
  page.on('request', request => {
    const operation = nativeRequestOperation(request);
    if (!operation) return;
    const sample = { index: metrics.requests.length + 1, elapsedMs: elapsed(), operation,
      viewerOrdinal: viewerOrdinal(request), method: request.method(), status: null, headersMs: null,
      durationMs: null, errorCode: null, transportCode: null };
    pending.set(request, { started: performance.now(), sample });
    metrics.requests.push(sample);
  });
  page.on('response', async response => {
    const entry = pending.get(response.request());
    if (!entry) return;
    entry.sample.status = response.status();
    entry.sample.headersMs = Math.round(performance.now() - entry.started);
    if (!response.ok()) {
      let body;
      try { body = await response.json(); } catch { /* Status remains useful. */ }
      entry.sample.errorCode = safeNativeErrorCode(body);
      event('native_http_error', { requestIndex: entry.sample.index, operation: entry.sample.operation,
        viewerOrdinal: entry.sample.viewerOrdinal, status: response.status(), code: entry.sample.errorCode,
        headersMs: entry.sample.headersMs });
    }
  });
  page.on('requestfinished', request => {
    const entry = pending.get(request);
    if (entry) entry.sample.durationMs = Math.round(performance.now() - entry.started);
  });
  page.on('requestfailed', request => {
    const entry = pending.get(request);
    if (!entry) return;
    const raw = request.failure()?.errorText || '';
    entry.sample.transportCode = /^net::ERR_[A-Z_]+$/.test(raw) ? raw : 'UNCLASSIFIED';
    entry.sample.durationMs = Math.round(performance.now() - entry.started);
    event('native_transport_error', { requestIndex: entry.sample.index, operation: entry.sample.operation,
      viewerOrdinal: entry.sample.viewerOrdinal, code: entry.sample.transportCode, durationMs: entry.sample.durationMs });
  });
}
