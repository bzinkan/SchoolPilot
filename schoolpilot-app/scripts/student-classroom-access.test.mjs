import assert from 'node:assert/strict';
import test from 'node:test';
import * as classroom from '../src/products/classpilot/lib/classroomFocus.js';

const review = (mode = 'focus', patch = {}) => ({
  schemaVersion: 1, purpose: 'student-classroom-access', mode, studentCount: 2,
  courseCount: 12, itemCount: 25, linkCount: 30, reviewToken: 'opaque-student-proof',
  expiresAt: Date.now() + 60_000,
  scopes: [{ type: 'website', hostname: 'reading.example.test', url: 'https://reading.example.test', label: 'Entire website', description: 'Whole website and subdomains.' }],
  warnings: [], ...patch,
});

test('all-courses Focus sends only the opaque proof and never client-derived student permissions', () => {
  assert.deepEqual(classroom.classroomFocusPayload(review()), {
    url: 'https://classroom.google.com/', classroomAccess: { reviewToken: 'opaque-student-proof' },
  });
});

test('Flight Path review retains its exact saved version without copying preview websites into the command', () => {
  const path = { id: 'path-a', updatedAt: '2026-11-16T20:00:00.000Z', allowedDomains: ['classroom.google.com'] };
  assert.deepEqual(classroom.classroomFlightPathPayload(path, review('flight-path')), {
    flightPathId: 'path-a', expectedFlightPathUpdatedAt: path.updatedAt,
    classroomAccess: { reviewToken: 'opaque-student-proof' },
  });
  assert.throws(() => classroom.classroomFlightPathPayload(path, review('focus')));
  assert.throws(() => classroom.classroomFlightPathPayload({ ...path, updatedAt: null }, review('flight-path')));
});

test('student reviews reject the wrong purpose, target mode, missing counts, incomplete scopes and expired proofs', () => {
  assert.equal(classroom.studentClassroomAccessReviewValid(review(), 'focus'), true);
  for (const patch of [{ purpose: 'classroom' }, { mode: 'flight-path' }, { studentCount: 0 },
    { courseCount: -1 }, { reviewToken: '' }, { expiresAt: Date.now() - 1 }, { scopes: [] },
    { itemCount: 1.5 }, { warnings: null }]) {
    assert.equal(classroom.studentClassroomAccessReviewValid(review('focus', patch), 'focus'), false);
    assert.throws(() => classroom.classroomFocusPayload(review('focus', patch)));
  }
});

test('Classroom detection includes saved website entries and does not mistake a specific assignment resource for a website grant', () => {
  assert.equal(classroom.flightPathIncludesClassroom({ allowedDomains: ['classroom.google.com'] }), true);
  assert.equal(classroom.flightPathIncludesClassroom({ allowedDomains: [], resources: [{ type: 'website', hostname: 'classroom.google.com' }] }), true);
  assert.equal(classroom.flightPathIncludesClassroom({ allowedDomains: [], resources: [{ type: 'section', hostname: 'classroom.google.com', pathPrefix: '/c/course-a/a/assignment-a' }] }), false);
  assert.equal(classroom.flightPathIncludesClassroom({ allowedDomains: ['classroom.google.com.evil.test'] }), false);
});
