import assert from 'node:assert/strict';
import test from 'node:test';

import {
  baseUrl,
  personas,
  responseBodyFor,
} from './production-preview-smoke.mjs';

const fixedNow = new Date('2026-07-24T16:00:00.000Z');

function request({ url, method = 'GET', schoolId }) {
  return {
    url: () => url,
    method: () => method,
    headers: () =>
      schoolId === undefined ? {} : { 'x-school-id': schoolId },
  };
}

function respond(persona, options) {
  return responseBodyFor(
    { requestedPath: '/test', persona },
    request(options),
    { now: fixedNow }
  );
}

test('accepts an exact same-origin, GET-only, school-bound request', () => {
  assert.deepEqual(
    respond(personas.classpilotTeacher, {
      url:
        `${baseUrl}/api/admin/attendance?date=2026-07-24`,
      schoolId: personas.classpilotTeacher.schoolId,
    }),
    { records: [] }
  );
});

test('returns the exact additive coverage-summary DTO without query parameters', () => {
  assert.deepEqual(
    respond(personas.classpilotTeacher, {
      url: `${baseUrl}/api/coverage/summary`,
      schoolId: personas.classpilotTeacher.schoolId,
    }),
    {
      revision: 'coverage-v1:6hPA0vMwkd-Q454ouBPUBscd2jW89P3Ij7xF2T-GcVw',
      availableStudentCount: 0,
      claimedStudentCount: 0,
      activeContextCount: 0,
    }
  );
});

test('returns the school-bound Dashboard activity DTO with the rollout disabled', () => {
  assert.deepEqual(
    respond(personas.classpilotTeacher, {
      url: `${baseUrl}/api/classpilot/dashboard-activity`,
      schoolId: personas.classpilotTeacher.schoolId,
    }),
    {
      enabled: false,
      schoolId: personas.classpilotTeacher.schoolId,
      viewerId: personas.classpilotTeacher.auth.user.id,
      revision: 'activity-v1:preview-disabled',
      serverTime: fixedNow.toISOString(),
      current: null,
      activities: [],
      next: null,
      nextBoundaryAt: null,
    }
  );
});

test('Dashboard activity fixture preserves strict read, school, and persona boundaries', () => {
  const url = `${baseUrl}/api/classpilot/dashboard-activity`;
  assert.throws(
    () => respond(personas.classpilotTeacher, {
      url, method: 'POST', schoolId: personas.classpilotTeacher.schoolId,
    }),
    /preview_api_method_invalid/
  );
  for (const schoolId of [undefined, 'preview-other-school']) {
    assert.throws(
      () => respond(personas.classpilotTeacher, { url, schoolId }),
      /preview_api_school_binding_invalid/
    );
  }
  assert.throws(
    () => respond(personas.anonymous, { url }),
    /preview_api_request_not_allowlisted/
  );
});

test('manual-today status fixture uses the active school date and next midnight with teacher adjustments disabled', () => {
  const url = `${baseUrl}/api/classpilot/groups/manual-today`;
  assert.deepEqual(respond(personas.classpilotTeacher, {
    url, schoolId: personas.classpilotTeacher.schoolId,
  }), {
    schoolDate: '2026-07-24',
    timezone: 'America/New_York',
    resumesOn: '2026-07-25',
    resumesAt: '2026-07-25T04:00:00.000Z',
    canManageManualToday: false,
    teacherManualTodayAllowed: false,
    classes: [],
  });
  for (const [now, schoolDate, resumesOn, resumesAt] of [
    ['2026-10-31T02:00:00.000Z', '2026-10-30', '2026-10-31', '2026-10-31T04:00:00.000Z'],
    ['2026-11-02T02:00:00.000Z', '2026-11-01', '2026-11-02', '2026-11-02T05:00:00.000Z'],
  ]) {
    const status = responseBodyFor({ requestedPath: '/test', persona: personas.classpilotTeacher },
      request({ url, schoolId: personas.classpilotTeacher.schoolId }), { now: new Date(now) });
    assert.equal(status.schoolDate, schoolDate);
    assert.equal(status.resumesOn, resumesOn);
    assert.equal(status.resumesAt, resumesAt);
  }
});

test('manual-today preview allowlist admits only the exact read under the current school', () => {
  const url = `${baseUrl}/api/classpilot/groups/manual-today`;
  const schoolId = personas.classpilotTeacher.schoolId;
  assert.throws(() => respond(personas.classpilotTeacher, { url, method: 'POST', schoolId }), /preview_api_method_invalid/);
  for (const invalidSchoolId of [undefined, 'preview-other-school']) {
    assert.throws(() => respond(personas.classpilotTeacher, { url, schoolId: invalidSchoolId }), /preview_api_school_binding_invalid/);
  }
  assert.throws(() => respond(personas.anonymous, { url }), /preview_api_request_not_allowlisted/);
  assert.throws(() => respond(personas.classpilotTeacher, { url: `${url}?schoolDate=2026-07-24`, schoolId }), /preview_api_query_invalid/);
  for (const unlistedUrl of [`${url}/extra`, `${baseUrl}/api/classpilot/groups/preview-class/manual-today`]) {
    assert.throws(() => respond(personas.classpilotTeacher, { url: unlistedUrl, schoolId }), /preview_api_request_not_allowlisted/);
  }
});

test('Today schedule preview fixture exposes only the exact disabled school-bound read', () => {
  const url = `${baseUrl}/api/classpilot/today-schedule`;
  const schoolId = personas.classpilotTeacher.schoolId;
  assert.deepEqual(respond(personas.classpilotTeacher, { url, schoolId }), {
    enabled: false, schoolDate: '2026-07-24', timeZone: 'America/New_York',
    resumesAt: '2026-07-25T04:00:00.000Z', canRequest: false, permissionSettingEnabled: false, classes: [], changes: [],
  });
  assert.throws(() => respond(personas.classpilotTeacher, { url, method: 'POST', schoolId }), /preview_api_method_invalid/);
  assert.throws(() => respond(personas.classpilotTeacher, { url, schoolId: 'another-school' }), /preview_api_school_binding_invalid/);
  for (const suffix of ['/preview', '/changes', '/changes/another-change']) {
    assert.throws(() => respond(personas.classpilotTeacher, { url: url + suffix, schoolId }), /preview_api_request_not_allowlisted/);
  }
});

test('does not allow historical GoPilot parent routes to fetch product data', () => {
  assert.throws(
    () => respond(personas.gopilotHistoricalParent, {
      url: `${baseUrl}/api/me/children`,
      schoolId: personas.gopilotHistoricalParent.schoolId,
    }),
    /preview_api_request_not_allowlisted/
  );
});

test('rejects API requests for any other origin before fulfillment', () => {
  assert.throws(
    () =>
      respond(personas.classpilotTeacher, {
        url: 'https://example.invalid/api/auth/me',
        schoolId: personas.classpilotTeacher.schoolId,
      }),
    /preview_api_origin_invalid/
  );
});

test('rejects every non-GET API request before fulfillment', () => {
  assert.throws(
    () =>
      respond(personas.classpilotTeacher, {
        url: `${baseUrl}/api/auth/me`,
        method: 'POST',
        schoolId: personas.classpilotTeacher.schoolId,
      }),
    /preview_api_method_invalid/
  );
});

test('rejects missing, wrong, or unexpected school bindings', () => {
  assert.throws(
    () =>
      respond(personas.classpilotTeacher, {
        url: `${baseUrl}/api/auth/me`,
      }),
    /preview_api_school_binding_invalid/
  );
  assert.throws(
    () =>
      respond(personas.gopilotHistoricalParent, {
        url: `${baseUrl}/api/auth/me`,
        schoolId: 'preview-other-school',
      }),
    /preview_api_school_binding_invalid/
  );
  assert.throws(
    () =>
      respond(personas.anonymous, {
        url: `${baseUrl}/api/auth/me`,
        schoolId: personas.classpilotTeacher.schoolId,
      }),
    /preview_api_school_binding_invalid/
  );
});

test('rejects unbound school resource identifiers', () => {
  assert.throws(
    () =>
      respond(personas.gopilotHistoricalParent, {
        url: `${baseUrl}/api/students/preview-other-child/pickups`,
        schoolId: personas.gopilotHistoricalParent.schoolId,
      }),
    /preview_api_request_not_allowlisted/
  );
  assert.throws(
    () =>
      respond(personas.gopilotHistoricalParent, {
        url: `${baseUrl}/api/schools/preview-other-school/settings`,
        schoolId: personas.gopilotHistoricalParent.schoolId,
      }),
    /preview_api_request_not_allowlisted/
  );
});

test('rejects missing, extra, duplicate, or incorrect query semantics', () => {
  const schoolId = personas.classpilotTeacher.schoolId;
  for (const url of [
    `${baseUrl}/api/admin/attendance`,
    `${baseUrl}/api/admin/attendance?date=2026-07-24&extra=1`,
    `${baseUrl}/api/admin/attendance?date=2026-07-24&date=2026-07-24`,
    `${baseUrl}/api/admin/attendance?date=2026-07-23`,
    `${baseUrl}/api/admin/attendance?date=2026-07-24&productContext=gopilot`,
    `${baseUrl}/api/settings?unexpected=true`,
    `${baseUrl}/api/coverage/summary?unexpected=true`,
    `${baseUrl}/api/classpilot/dashboard-activity?schoolId=preview-other-school`,
  ]) {
    assert.throws(
      () =>
        respond(personas.classpilotTeacher, {
          url,
          schoolId,
        }),
      /preview_api_query_invalid/
    );
  }
});
