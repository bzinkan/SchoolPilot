import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { attachNativeRequestDiagnostics, nativeRequestOperation, safeNativeErrorCode } from './native-desktop-diagnostics.mjs';

const request = (pathname, body, method = 'POST') => ({ url: () => `http://127.0.0.1:4100${pathname}`,
  postDataJSON: () => body, method: () => method, failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
const tiles = '/api/classpilot/native/tiles/desktop';
test('native diagnostics distinguish metadata, selected reads and lease operations without recording contents', async () => {
  const page = new EventEmitter(), metrics = {}, events = [];
  attachNativeRequestDiagnostics(page, { metrics, event: (type, data) => events.push({ type, ...data }), elapsed: () => 42 });
  const privateViewer = 'PRIVATE_VIEWER_UUID';
  const lease = request(`/api/classpilot/native/observation-leases/${privateViewer}`, { targets: ['PRIVATE_TARGET'] }, 'PUT');
  const metadata = request(tiles, { studentIds: ['PRIVATE_STUDENT'] });
  const selected = request(tiles, { viewerInstanceId: privateViewer, selectedSources: [{ sourceRef: 'PRIVATE_SOURCE' }] });
  const release = request(`/api/classpilot/native/observation-leases/${privateViewer}`, null, 'DELETE');
  for (const req of [lease, metadata, selected, release]) page.emit('request', req);
  page.emit('response', { request: () => selected, status: () => 503, ok: () => false,
    json: async () => ({ code: 'NATIVE_UNAVAILABLE', message: 'PRIVATE_MESSAGE', screenshot: 'PRIVATE_PIXELS' }) });
  page.emit('requestfinished', selected);
  page.emit('requestfailed', lease);
  await Promise.resolve();
  assert.deepEqual(metrics.requests.map(item => item.operation), ['lease_put', 'metadata', 'selected_read', 'lease_delete']);
  assert.deepEqual(metrics.requests.map(item => item.viewerOrdinal), [1, null, 1, 1]);
  assert.equal(metrics.requests[2].errorCode, 'NATIVE_UNAVAILABLE');
  assert.equal(metrics.requests[0].transportCode, 'net::ERR_ABORTED');
  assert.ok(metrics.requests.every(item => item.elapsedMs === 42));
  const serialized = JSON.stringify({ metrics, events });
  assert.equal(serialized.includes('PRIVATE_'), false);
  assert.equal(serialized.includes('/api/'), false);
  assert.equal(serialized.includes('127.0.0.1'), false);
  assert.equal(nativeRequestOperation(request('/api/auth/login', {})), null);
  assert.equal(safeNativeErrorCode({ code: 'private free-form content' }), 'UNCLASSIFIED');
});
