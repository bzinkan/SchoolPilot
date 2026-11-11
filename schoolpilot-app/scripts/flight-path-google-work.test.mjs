import assert from 'node:assert/strict';
import test from 'node:test';
import { activeFlightPathAllowedDomains } from '../src/products/classpilot/lib/teachingResourceLibrary.js';
import { classroomLessonStarts } from '../src/products/classpilot/lib/classroomActions.js';

test('applied Google work domains win over a saved website list even when the school library is off', () => {
  const applied = ['classroom.google.com', 'docs.google.com', 'drive.google.com'];
  const student = { activeFlightPathName: 'Work', classroomState: { restrictions: { flightPath: { active: true, allowedDomains: applied } } } };
  const saved = [{ flightPathName: 'Work', allowedDomains: ['classroom.google.com'] }];
  assert.deepEqual(activeFlightPathAllowedDomains(student, saved), applied);
  assert.deepEqual(activeFlightPathAllowedDomains({ activeFlightPathName: 'Work' },
    [{ ...saved[0], effectiveAllowedDomains: applied }]), ['classroom.google.com'], 'an unapplied saved expansion is not current browser evidence');
});

test('reviewed Classroom lesson starts accept Google work apps while excluding unrelated links', () => {
  const docs = { title: 'Assignment', url: 'https://docs.google.com/document/d/example/edit' };
  const preview = { boundary: 'website', scopes: [{ hostname: 'classroom.google.com' }],
    authoring: { allowedDomains: ['classroom.google.com'] }, effectiveAllowedDomains: ['classroom.google.com', 'docs.google.com'] };
  assert.deepEqual(classroomLessonStarts(preview, [docs, { title: 'Elsewhere', url: 'https://unrelated.example' }]),
    [{ url: docs.url, label: 'Assignment' }]);
});
