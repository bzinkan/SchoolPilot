import test from "node:test";
import assert from "node:assert/strict";

import {
  buildClasspilotStudentDataResponse,
  parseClasspilotStudentDataScope,
  resolveClasspilotStudentDataWindow,
} from "../src/services/classpilotStudentData.js";
import {
  decodeClasspilotRosterCursor,
  encodeClasspilotRosterCursor,
  parseClasspilotRosterLimit,
  parseClasspilotRosterSearch,
} from "../src/services/classpilotRosterPagination.js";

test("Student Data periods use school-local calendar boundaries across DST", () => {
  const now = new Date("2026-03-08T16:00:00.000Z");
  const today = resolveClasspilotStudentDataWindow({
    period: "today",
    timeZone: "America/New_York",
    now,
  });
  assert.equal(today.startLocalDate, "2026-03-08");
  assert.equal(today.rangeStart.toISOString(), "2026-03-08T05:00:00.000Z");

  const week = resolveClasspilotStudentDataWindow({
    period: "week",
    timeZone: "America/New_York",
    now,
  });
  assert.equal(week.startLocalDate, "2026-03-02");
  assert.equal(week.rangeStart.toISOString(), "2026-03-02T05:00:00.000Z");

  const month = resolveClasspilotStudentDataWindow({
    period: "month",
    timeZone: "America/New_York",
    now,
  });
  assert.equal(month.startLocalDate, "2026-03-01");

  const year = resolveClasspilotStudentDataWindow({
    period: "year",
    timeZone: "America/New_York",
    now,
  });
  assert.equal(year.startLocalDate, "2026-01-01");
});

test("Student Data aggregation is deterministic, privacy-safe, and bounded by monitored time", () => {
  const base = {
    period: "today" as const,
    timeZone: "America/New_York",
    startLocalDate: "2026-08-22",
    endLocalDate: "2026-08-22",
    rangeStart: new Date("2026-08-22T04:00:00.000Z"),
    rangeEnd: new Date("2026-08-22T16:00:00.000Z"),
    identities: [
      { studentId: "student-a", name: "Ada Student" },
      { studentId: "student-b", name: "Bert Student" },
    ],
    usageRows: [
      {
        studentId: "student-a",
        totalSeconds: 20,
        heartbeatCount: 2,
        topDomains: [
          { domain: "https://www.example.com/private?token=secret", seconds: 9_999 },
          { domain: "chrome://settings", seconds: 10 },
        ],
        computedAt: new Date("2026-08-22T16:01:00.000Z"),
      },
      {
        studentId: "student-b",
        totalSeconds: 30,
        heartbeatCount: 3,
        topDomains: [
          { domain: "school.example", seconds: 20 },
          { domain: "docs.example", seconds: 10 },
        ],
        computedAt: new Date("2026-08-22T16:01:00.000Z"),
      },
    ],
  };
  const first = buildClasspilotStudentDataResponse({
    ...base,
    generatedAt: new Date("2026-08-22T16:02:00.000Z"),
  });
  const repeated = buildClasspilotStudentDataResponse({
    ...base,
    generatedAt: new Date("2026-08-22T16:03:00.000Z"),
  });

  assert.equal(first.revision, repeated.revision, "retrieval time must not rewrite the content revision");
  assert.equal(first.monitoredSeconds, 50);
  assert.equal(first.studentsTruncated, false);
  assert.equal(first.activitySource, "heartbeats");
  assert.equal(first.screenshotsUsedForTimeCalculations, false);
  assert.equal(first.students[0]?.topDomains[0]?.domain, "example.com");
  assert.equal(first.students[0]?.topDomains[0]?.seconds, 20);
  assert.ok(first.students.every((student) => (
    student.topDomains.reduce((sum, domain) => sum + domain.seconds, 0) <= student.monitoredSeconds
  )));
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /private|token=secret|chrome:\/\/|deviceId/i);
});

test("Student Data scope and live-state metadata are revision-bound without retrieval-time churn", () => {
  assert.equal(parseClasspilotStudentDataScope(undefined), undefined);
  assert.equal(parseClasspilotStudentDataScope("school"), "school");
  assert.equal(parseClasspilotStudentDataScope("mine"), "mine");
  assert.equal(parseClasspilotStudentDataScope("class"), "class");
  assert.throws(() => parseClasspilotStudentDataScope(["class"]));
  assert.throws(() => parseClasspilotStudentDataScope("other"));

  const base = {
    period: "today" as const,
    scope: {
      key: "class:science",
      kind: "class" as const,
      label: "Science",
      groupId: "science",
    },
    dataState: "live" as const,
    provisionalAsOf: new Date("2026-08-28T14:00:00.000Z"),
    timeZone: "America/New_York",
    startLocalDate: "2026-08-28",
    endLocalDate: "2026-08-28",
    rangeStart: new Date("2026-08-28T04:00:00.000Z"),
    rangeEnd: new Date("2026-08-28T14:00:00.000Z"),
    identities: [{ studentId: "student-a", name: "Ada Student" }],
    usageRows: [{
      studentId: "student-a",
      totalSeconds: 10,
      heartbeatCount: 1,
      topDomains: [{ domain: "school.example", seconds: 10 }],
      computedAt: new Date("2026-08-28T14:00:00.000Z"),
    }],
  };
  const first = buildClasspilotStudentDataResponse({
    ...base,
    generatedAt: new Date("2026-08-28T14:00:00.000Z"),
  });
  const laterRead = buildClasspilotStudentDataResponse({
    ...base,
    generatedAt: new Date("2026-08-28T14:00:30.000Z"),
  });
  const final = buildClasspilotStudentDataResponse({
    ...base,
    dataState: "final" as const,
    provisionalAsOf: null,
    generatedAt: new Date("2026-08-28T14:00:30.000Z"),
  });
  assert.equal(first.revision, laterRead.revision);
  assert.notEqual(first.revision, final.revision);
  assert.equal(first.scope.key, "class:science");
  assert.equal(first.dataState, "live");
  assert.equal(first.provisionalAsOf, "2026-08-28T14:00:00.000Z");
});

test("roster cursors are stable and page inputs are strictly bounded", () => {
  const cursor = encodeClasspilotRosterCursor({
    id: "student-1",
    firstName: "Ada",
    lastName: "Student",
  });
  assert.deepEqual(decodeClasspilotRosterCursor(cursor), {
    id: "student-1",
    firstName: "Ada",
    lastName: "Student",
  });
  assert.equal(parseClasspilotRosterLimit(undefined), 100);
  assert.equal(parseClasspilotRosterLimit("200"), 200);
  assert.equal(parseClasspilotRosterSearch("  Ada  "), "Ada");
  assert.throws(() => parseClasspilotRosterLimit("201"));
  assert.throws(() => parseClasspilotRosterLimit("1.5"));
  assert.throws(() => decodeClasspilotRosterCursor("not-a-cursor"));
  assert.throws(() => parseClasspilotRosterSearch("x".repeat(101)));
});
