import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { activityLegacyBody } from '../schoolpilot-app/src/products/classpilot/lib/dashboardActivity.js';
import { attachActualRenderedSocketObserver } from '../scripts/load/run-classpilot-rendered-dashboards.mjs';

const id = 'synthetic-session';
const request = extra => ({ type: 'subscribe-session', ...activityLegacyBody({ teachingSessionId: id }), requestId: 'synthetic-request', ...extra });
const ack = extra => ({ type: 'session-subscription-success', teachingSessionId: id, sessionId: id, requestId: 'synthetic-request', ...extra });
const emit = (socket, direction, message) => socket.emit(direction, { payload: JSON.stringify(message) });
function fixture() {
  const runtime = { actor: { teachingSessionId: id, schoolId: 'synthetic-school' }, socketGeneration: 0,
    frames: new Map(), realtime: new Map(), lastPaints: new Map() };
  const socket = new EventEmitter(), observer = attachActualRenderedSocketObserver(runtime, socket);
  return { runtime, socket, observer };
}
for (const [name, sent] of [
  ['actual UI sessionId', request()],
  ['teachingSessionId', request({ sessionId: undefined, teachingSessionId: id })],
  ['both matching aliases', request({ teachingSessionId: id })],
]) test(name + ' establishes exact correlated observer subscription', () => {
  const f = fixture(); emit(f.socket, 'framesent', sent); emit(f.socket, 'framereceived', ack());
  assert.equal(f.runtime.subscribed, true);
});
for (const [name, fields] of [
  ['missing aliases', { sessionId: undefined }],
  ['empty session alias', { sessionId: '' }],
  ['empty other alias', { teachingSessionId: '' }],
  ['null other alias', { teachingSessionId: null }],
  ['conflicting aliases', { teachingSessionId: 'other-session' }],
  ['reverse conflicting aliases', { sessionId: 'other-session', teachingSessionId: id }],
  ['wrong school', { schoolId: 'other-school' }],
  ['context scope', { supervisionContextId: 'other-context' }],
  ['null context scope', { supervisionContextId: null }],
  ['missing request ID', { requestId: undefined }],
  ['empty request ID', { requestId: '' }],
]) test(name + ' cannot acquire subscription from a matching-looking ACK', () => {
  const f = fixture(); emit(f.socket, 'framesent', request(fields)); emit(f.socket, 'framereceived', ack());
  assert.equal(f.runtime.subscribed, false);
});
for (const [name, fields] of [
  ['foreign request', { requestId: 'other-request' }],
  ['missing request', { requestId: undefined }],
  ['empty request', { requestId: '' }],
  ['missing aliases', { sessionId: undefined, teachingSessionId: undefined }],
  ['foreign teaching alias', { teachingSessionId: 'other-session' }],
  ['foreign legacy alias', { sessionId: 'other-session' }],
  ['empty supplied alias', { sessionId: '' }],
  ['wrong school', { schoolId: 'other-school' }],
  ['foreign context', { supervisionContextId: 'context' }],
]) test('ACK ' + name + ' cannot acquire exact subscription', () => {
  const f = fixture(); emit(f.socket, 'framesent', request()); emit(f.socket, 'framereceived', ack(fields));
  assert.equal(f.runtime.subscribed, false);
});
test('actual UI A-to-B-to-A and unsubscribe fence old request and generation', () => {
  const f = fixture(); emit(f.socket, 'framesent', request()); emit(f.socket, 'framereceived', ack()); assert.equal(f.runtime.subscribed, true);
  emit(f.socket, 'framesent', request({ sessionId: 'other-session', requestId: 'b' }));
  emit(f.socket, 'framereceived', ack()); assert.equal(f.runtime.subscribed, false);
  emit(f.socket, 'framesent', request({ requestId: 'new-a' })); emit(f.socket, 'framereceived', ack()); assert.equal(f.runtime.subscribed, false);
  emit(f.socket, 'framereceived', ack({ requestId: 'new-a' })); assert.equal(f.runtime.subscribed, true);
  emit(f.socket, 'framesent', { ...request(), type: 'unsubscribe-session' }); emit(f.socket, 'framereceived', ack()); assert.equal(f.runtime.subscribed, false);
  const next = new EventEmitter(); attachActualRenderedSocketObserver(f.runtime, next);
  emit(f.socket, 'framesent', request()); emit(f.socket, 'framereceived', ack()); assert.equal(f.runtime.subscribed, false);
  emit(next, 'framesent', request()); emit(next, 'framereceived', ack()); assert.equal(f.runtime.subscribed, true);
  f.socket.emit('close'); assert.equal(f.runtime.subscribed, true);
});
