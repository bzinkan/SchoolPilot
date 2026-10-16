import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unusedCookieIsolationActor, assertStagingIssuedCookie } from '../scripts/check-classpilot-staging-cookie-isolation.mjs';

function fixture() {
  const teacherAuth = Array.from({ length: 20 }, (_, index) => ({ teacherId: `teacher-${index}`, schoolId: 'primary', role: 'teacher',
    teacherCookie: `schoolpilot.staging.sid=synthetic-${index}`, csrfToken: 'synthetic-csrf-token-only',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), studentIds: Array.from({ length: 40 }, (_, student) => `student-${index}-${student}`) }));
  const source = { schemaVersion: 2, baseUrl: 'https://staging.school-pilot.net', schoolId: 'primary', teacherAuth };
  return { source, selected: { ...source, teacherAuth: teacherAuth.slice(0, 1) } };
}

test('cookie proof consumes an unused teacher and never logs out an active fleet identity', () => {
  const { source, selected } = fixture();
  const actor = unusedCookieIsolationActor(source, selected);
  assert.equal(actor.teacherId, 'teacher-1');
  assert.notEqual(actor.teacherId, selected.teacherAuth[0].teacherId);
  assert.throws(() => unusedCookieIsolationActor(source, source));
  assert.throws(() => unusedCookieIsolationActor(source, { ...selected, schoolId: 'foreign' }));
  const mixed = fixture(); mixed.selected.teacherAuth[0] = { ...mixed.selected.teacherAuth[0], teacherCookie: 'schoolpilot.staging.sid=retired' };
  assert.throws(() => unusedCookieIsolationActor(mixed.source, mixed.selected));
  source.teacherAuth[1].teacherCookie = 'schoolpilot.sid=synthetic-production';
  assert.throws(() => unusedCookieIsolationActor(source, selected));
});

test('native proof accepts only host-only staging issuance and exact staging logout clearing', () => {
  const issued = 'schoolpilot.staging.sid=synthetic; Path=/; HttpOnly; Secure; SameSite=Lax';
  const cleared = 'schoolpilot.staging.sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax';
  const header = value => [{ name: 'set-cookie', value }];
  assert.doesNotThrow(() => assertStagingIssuedCookie(header(issued)));
  assert.doesNotThrow(() => assertStagingIssuedCookie([...header('AWSALB=synthetic; Path=/'), ...header(cleared)], true));
  assert.throws(() => assertStagingIssuedCookie(header(issued + '; Domain=.school-pilot.net')));
  assert.throws(() => assertStagingIssuedCookie([...header(issued), ...header('schoolpilot.sid=; Path=/')]));
  assert.throws(() => assertStagingIssuedCookie(header(issued), true));
  assert.throws(() => assertStagingIssuedCookie(header(issued.replace('; Secure', ''))));
  assert.throws(() => assertStagingIssuedCookie(header(issued.replace('; SameSite=Lax', '; SameSite=None'))));
});
