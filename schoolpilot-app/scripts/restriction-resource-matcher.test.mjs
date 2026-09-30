import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  extractRestrictionResourceIdentity,
  isUrlAllowedByRestrictionResource,
  isUrlAllowedByStudentPreciseRestrictions,
  isValidRestrictionResource,
} from '../src/products/classpilot/lib/restrictionResourceMatcher.js';
import { isStudentUrlOffTask } from '../src/products/classpilot/lib/dashboardCommandContext.js';

// The dashboard's off-task copy of the precise matcher must agree with the
// server and ClassPilot 2.10.0 on the shared case file.
const cases = JSON.parse(readFileSync(
  new URL('../../tests/fixtures/restriction-resource-matcher-cases.json', import.meta.url),
  'utf8',
));

test('identity cases match the shared contract', () => {
  for (const testCase of cases.identity) {
    assert.deepEqual(extractRestrictionResourceIdentity(testCase.url), testCase.expect, testCase.name);
  }
});

test('match cases match the shared contract', () => {
  for (const testCase of cases.match) {
    assert.equal(
      isUrlAllowedByRestrictionResource(testCase.url, cases.resources[testCase.resource]),
      testCase.allowed,
      testCase.name,
    );
  }
});

test('validation cases match the shared contract (public-suffix cases are server only)', () => {
  for (const testCase of cases.validate.filter((entry) => !entry.serverOnly)) {
    assert.equal(isValidRestrictionResource(testCase.value), testCase.valid, testCase.name);
  }
});

test('a student on an allowed precise resource is not flagged off-task', () => {
  const video = cases.resources.youtubeVideo;
  const student = (restrictions, activeTabUrl) => ({
    activeTabUrl,
    aiClassification: { category: 'non-educational' },
    flightPathActive: restrictions.flightPath?.active === true,
    classroomState: { restrictions },
  });
  const path = { flightPath: { active: true, allowedDomains: ['khanacademy.org'], resources: [video] } };
  assert.equal(isStudentUrlOffTask({ student: student(path, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9') }), false);
  assert.equal(isStudentUrlOffTask({ student: student(path, 'https://www.youtube.com/watch?v=9bZkp7q19f0') }), true,
    'another video stays off-task');
  const waypoint = { screenLock: { active: true, url: video.canonicalUrl, resource: video } };
  assert.equal(isUrlAllowedByStudentPreciseRestrictions('https://youtu.be/dQw4w9WgXcQ', { classroomState: { restrictions: waypoint } }), true);
  assert.equal(isUrlAllowedByStudentPreciseRestrictions('https://youtu.be/dQw4w9WgXcQ', {
    classroomState: { restrictions: { screenLock: { active: false, resource: video } } },
  }), false, 'an inactive Waypoint allows nothing');
});
