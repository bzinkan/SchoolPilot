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
        totalSeconds: 80,
        heartbeatCount: 8,
        topDomains: [
          { domain: "https://www.example.com/private?token=secret", seconds: 20 },
          { domain: "docs.google.com", seconds: 20 },
          { domain: "classroom.google.com", seconds: 10 },
          { domain: "drive.google.com", seconds: 10 },
          { domain: "slides.google.com", seconds: 10 },
          { domain: "forms.google.com", seconds: 10 },
          { domain: "chrome://settings", seconds: 10 },
        ],
        topActivities: [
          {
            kind: "google_docs",
            domain: "https://docs.google.com/document/d/private-document-id/edit?token=activity-secret#fragment",
            seconds: 20,
          },
          { kind: "google_slides", domain: "docs.google.com", seconds: 10 },
          { kind: "google_forms", domain: "docs.google.com", seconds: 10 },
          { kind: "google_sheets", domain: "docs.google.com", seconds: 10 },
          { kind: "google_classroom", domain: "classroom.google.com", seconds: 10 },
          { kind: "google_drive", domain: "drive.google.com", seconds: 10 },
          { kind: "domain", domain: "example.com", seconds: 10 },
          { kind: "not-a-real-activity", domain: "docs.google.com/private", seconds: 10 },
        ],
        computedAt: new Date("2026-08-22T16:01:00.000Z"),
      },
      {
        studentId: "student-b",
        totalSeconds: 20,
        heartbeatCount: 2,
        // A legacy row has no topActivities. The host alone cannot honestly
        // distinguish Docs, Slides, Forms, or Sheets on docs.google.com.
        topDomains: [{ domain: "docs.google.com", seconds: 20 }],
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
  assert.equal(first.schemaVersion, 2);
  assert.match(first.revision, /^student-data-v2:[A-Za-z0-9_-]{32}$/);
  assert.equal(first.monitoredSeconds, 100);
  assert.equal(first.studentsTruncated, false);
  assert.equal(first.activitySource, "heartbeats");
  assert.equal(first.screenshotsUsedForTimeCalculations, false);
  assert.equal(first.topActivitiesLimit, 10);
  assert.equal(first.activityCoverage, "stored-session-top-activities");
  const ada = first.students.find((student) => student.studentId === "student-a");
  const bert = first.students.find((student) => student.studentId === "student-b");
  assert.ok(ada);
  assert.ok(bert);
  assert.deepEqual(
    new Set(ada.topActivities.map((activity) => activity.kind)),
    new Set([
      "domain",
      "google_docs",
      "google_slides",
      "google_forms",
      "google_sheets",
      "google_classroom",
      "google_drive",
    ])
  );
  assert.deepEqual(bert.topActivities, [{
    kind: "google_workspace_unspecified",
    domain: "docs.google.com",
    seconds: 20,
  }]);
  assert.deepEqual(bert.topActivity, bert.topActivities[0]);
  assert.ok(first.students.every((student) => (
    student.topDomains.reduce((sum, domain) => sum + domain.seconds, 0) <= student.monitoredSeconds
  )));
  assert.ok(first.students.every((student) => (
    student.topActivities.reduce((sum, activity) => sum + activity.seconds, 0) <= student.monitoredSeconds
  )));
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(
    serialized,
    /private|token=secret|activity-secret|document\/d|chrome:\/\/|deviceId|not-a-real-activity/i
  );
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
