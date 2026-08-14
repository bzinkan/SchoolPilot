import test from "node:test";
import assert from "node:assert/strict";
import {
  createClasspilotReportAuthorizationMarker,
  isClasspilotReportAuthorizedStaff,
  parseClasspilotReportAuthorizationMarker,
} from "../src/services/classpilotReportAuthorization.js";

test("report authorization markers retain no raw staff identifiers", () => {
  const options = {
    schoolId: "school-8d8b8f6e",
    teachingSessionId: "session-0f45b93e",
    staffIds: ["staff-3346badd", "staff-b2f94ad1"],
    salt: "fixed-report-salt-for-test-12345",
  };
  const marker = createClasspilotReportAuthorizationMarker(options);
  const serialized = JSON.stringify(marker);

  for (const staffId of options.staffIds) assert.doesNotMatch(serialized, new RegExp(staffId));
  assert.equal(parseClasspilotReportAuthorizationMarker(marker)?.version, 1);
  assert.equal(isClasspilotReportAuthorizedStaff({
    marker,
    schoolId: options.schoolId,
    teachingSessionId: options.teachingSessionId,
    staffId: options.staffIds[0]!,
  }), true);
  assert.equal(isClasspilotReportAuthorizedStaff({
    marker,
    schoolId: options.schoolId,
    teachingSessionId: options.teachingSessionId,
    staffId: "staff-not-authorized",
  }), false);
});

test("report authorization digests are bound to the exact school and session", () => {
  const marker = createClasspilotReportAuthorizationMarker({
    schoolId: "school-a",
    teachingSessionId: "session-a",
    staffIds: ["staff-a"],
    salt: "fixed-report-salt-for-test-67890",
  });
  assert.equal(isClasspilotReportAuthorizedStaff({
    marker,
    schoolId: "school-b",
    teachingSessionId: "session-a",
    staffId: "staff-a",
  }), false);
  assert.equal(isClasspilotReportAuthorizedStaff({
    marker,
    schoolId: "school-a",
    teachingSessionId: "session-b",
    staffId: "staff-a",
  }), false);
  assert.equal(isClasspilotReportAuthorizedStaff({
    marker: { version: 1, salt: "short", digests: marker.digests },
    schoolId: "school-a",
    teachingSessionId: "session-a",
    staffId: "staff-a",
  }), false);
});
