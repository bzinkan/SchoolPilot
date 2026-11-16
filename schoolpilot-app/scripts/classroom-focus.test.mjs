import assert from 'node:assert/strict';
import test from 'node:test';
import { classroomFocusPayload, classroomFocusReviewValid, isClassroomFocusUrl, supportsClassroomFocus } from '../src/products/classpilot/lib/classroomFocus.js';

test('only an explicit Classroom HTTP(S) website selects Classroom Focus', () => {
  for (const value of ['classroom.google.com', 'https://classroom.google.com/c/class-a', 'http://classroom.google.com/', 'https://classroom.google.com./'])
    assert.equal(isClassroomFocusUrl(value), true, value);
  for (const value of ['', 'classroom.google.com.evil.test', 'https://google.com/?site=classroom.google.com',
    'https://person:secret@classroom.google.com/', 'https://classroom.google.com:8080', 'javascript:classroom.google.com', 'docs.google.com'])
    assert.equal(isClassroomFocusUrl(value), false, value);
});

test('Classroom Focus requires every accepted dependency and refuses version or raw advertisement guesses', () => {
  const capabilities = ['scopedAuthorityChecksV1', 'preciseRestrictionResourcesV1', 'classroomFocusScopeV1'];
  assert.equal(supportsClassroomFocus({ acceptedCapabilities: capabilities }), true);
  assert.equal(supportsClassroomFocus({ capabilities: Object.fromEntries(capabilities.map(value => [value, true])) }), true);
  for (const missing of capabilities) assert.equal(supportsClassroomFocus({ acceptedCapabilities: capabilities.filter(value => value !== missing) }), false);
  assert.equal(supportsClassroomFocus({ extensionVersion: '3.0.6', extensionCapabilities: capabilities }), false);
  assert.equal(supportsClassroomFocus({ capabilities }), false);
  assert.equal(supportsClassroomFocus({ acceptedCapabilities: [], capabilities: Object.fromEntries(capabilities.map(value => [value, true])) }), false,
    'an explicit negotiated withdrawal takes precedence over an older alias');
});

test('only a complete unexpired server review produces the opaque Classroom command payload', () => {
  const review = { schemaVersion: 1, purpose: 'classroom', boundary: 'website', course: { id: 'course-a', name: 'Science' },
    itemCount: 2, linkCount: 3, reviewToken: 'opaque-proof', expiresAt: Date.now() + 60_000,
    scopes: [{ label: 'Scope' }], warnings: [], skipped: [], effectiveAllowedDomains: ['classroom.google.com'],
    authoring: { allowedDomains: ['classroom.google.com', 'outside.example.test'], resources: [] } };
  assert.equal(classroomFocusReviewValid(review), true);
  assert.deepEqual(classroomFocusPayload(review), { url: 'https://classroom.google.com/', classroomFocus: { courseId: 'course-a', reviewToken: 'opaque-proof' } });
  for (const patch of [{ purpose: 'waypoint' }, { reviewToken: '' }, { expiresAt: Date.now() - 1 },
    { course: { id: '', name: 'Science' } }, { scopes: [] }, { skipped: [{ url: 'https://missing.example.test' }] },
    { itemCount: -1 }, { authoring: {} }]) {
    assert.equal(classroomFocusReviewValid({ ...review, ...patch }), false);
    assert.throws(() => classroomFocusPayload({ ...review, ...patch }));
  }
});
