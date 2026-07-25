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

test('accepts only the bound GoPilot school and child resources', () => {
  assert.deepEqual(
    respond(personas.gopilotParent, {
      url:
        `${baseUrl}/api/students/` +
        `${personas.gopilotParent.childId}/pickups`,
      schoolId: personas.gopilotParent.schoolId,
    }),
    { pickups: [] }
  );
  assert.deepEqual(
    respond(personas.gopilotParent, {
      url:
        `${baseUrl}/api/schools/` +
        `${personas.gopilotParent.schoolId}/sessions/active`,
      schoolId: personas.gopilotParent.schoolId,
    }),
    { session: null }
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
      respond(personas.gopilotParent, {
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

test('rejects unbound school and child resource identifiers', () => {
  assert.throws(
    () =>
      respond(personas.gopilotParent, {
        url: `${baseUrl}/api/students/preview-other-child/pickups`,
        schoolId: personas.gopilotParent.schoolId,
      }),
    /preview_api_resource_binding_invalid/
  );
  assert.throws(
    () =>
      respond(personas.gopilotParent, {
        url: `${baseUrl}/api/schools/preview-other-school/settings`,
        schoolId: personas.gopilotParent.schoolId,
      }),
    /preview_api_resource_binding_invalid/
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
