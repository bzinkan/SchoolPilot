import assert from 'node:assert/strict';
import test from 'node:test';
import { exactFocusPayload, focusTabCapability, focusPayloadForStudents, focusStatusLabel, focusCommandFeedback }
  from '../src/products/classpilot/lib/focusControls.js';

const row = (studentId, tabRef) => ({ studentId, tabRef, observedRevision: 7,
  acceptedCapabilities: { focusTabV1: true, scopedAuthorityChecksV1: true }, url: 'https://duplicate.example/', deviceId: 'must-not-leak' });
test('duplicate URLs retain each selected opaque ref and never enter the payload', () => {
  assert.deepEqual(exactFocusPayload([row('student-a', 'opaque-a'), row('student-b', 'opaque-b')]), {
    tabTargets: [{ studentId: 'student-a', tabRef: 'opaque-a', observedRevision: 7 }, { studentId: 'student-b', tabRef: 'opaque-b', observedRevision: 7 }] });
});
test('raw advertisement cannot override capability withdrawal', () => {
  assert.equal(focusTabCapability({ ...row('a', 'ref'), acceptedCapabilities: [],
    capabilities: { focusTabV1: true, scopedAuthorityChecksV1: true }, extensionCapabilities: ['focusTabV1', 'scopedAuthorityChecksV1'] }).enabled, false);
});
test('missing refs, stale revisions and two targets for one student cannot construct a command', () => {
  for (const value of [{ ...row('a', 'ref'), tabRef: '' }, { ...row('a', 'ref'), observedRevision: 0 }, { ...row('a', 'ref'), observedRevision: 1.2 }])
    assert.throws(() => exactFocusPayload([value]));
  assert.throws(() => exactFocusPayload([row('a', 'ref'), row('a', 'other')]));
  assert.throws(() => exactFocusPayload([]));
});
test('claimed contexts receive only their selected students and reject missing or duplicate bindings', () => {
  const payload = exactFocusPayload([row('a', 'ref-a'), row('b', 'ref-b')]);
  assert.deepEqual(focusPayloadForStudents(payload, ['b']), { tabTargets: [{ studentId: 'b', tabRef: 'ref-b', observedRevision: 7 }] });
  assert.throws(() => focusPayloadForStudents(payload, ['c']));
  assert.throws(() => focusPayloadForStudents(payload, ['a', 'a']));
});
test('desired Focus is pending and suspended states never claim active enforcement', () => {
  assert.match(focusStatusLabel({ classroomState: { restrictions: { focus: { active: true } } } }), /awaiting confirmation/);
  assert.equal(focusStatusLabel({ focus: { state: 'suspended', reason: 'authentication' } }), 'Focus paused for sign-in');
  assert.equal(focusStatusLabel({ focus: { state: 'active' } }), 'Focus confirmed');
});
test('a prior device assignment cannot confirm or describe a newly requested Focus', () => {
  const classroomState = { restrictions: { focus: { active: true, assignmentId: 'new-focus' } } };
  for (const focus of [
    { state: 'active', assignmentId: 'old-focus' },
    { state: 'suspended', assignmentId: 'old-focus', reason: 'attention' },
    { state: 'suspended', assignmentId: 'old-focus', reason: 'authentication' },
    { state: 'invalidated', assignmentId: 'old-focus', reason: 'focus_tab_closed' },
  ]) {
    assert.equal(focusStatusLabel({ classroomState, focus }), 'Focus requested; awaiting confirmation');
  }
});
test('matching Focus assignment retains its actual lifecycle label', () => {
  const classroomState = { restrictions: { focus: { active: true, assignmentId: 'current-focus' } } };
  for (const [focus, expected] of [
    [{ state: 'active', assignmentId: 'current-focus' }, 'Focus confirmed'],
    [{ state: 'suspended', assignmentId: 'current-focus', reason: 'attention' }, 'Focus paused for Attention'],
    [{ state: 'suspended', assignmentId: 'current-focus', reason: 'authentication' }, 'Focus paused for sign-in'],
    [{ state: 'invalidated', assignmentId: 'current-focus', reason: 'focus_tab_closed' }, 'Focus ended: target unavailable'],
  ]) {
    assert.equal(focusStatusLabel({ classroomState, focus }), expected);
    assert.equal(focusStatusLabel({ focus }), expected, 'coverage rows without desired assignment retain reported truth');
    assert.equal(focusStatusLabel({ classroomState: { restrictions: { focus: { active: true } } }, focus }), expected,
      'legacy desired state without an assignment cannot establish a mismatch');
  }
});
test('received ACKs remain pending and unavailable recipients do not become signed-out claims', () => {
  const feedback = focusCommandFeedback({ targets: [{ status: 'received' }, { status: 'unavailable' }] }, 'focus-tab');
  assert.match(feedback.title, /awaiting/); assert.match(feedback.description, /0 completed, 1 pending, 1 failed or unavailable/);
  assert.doesNotMatch(feedback.description, /signed out|saved/);
});
