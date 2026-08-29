import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateHeartbeatCoverage,
  calculateHeartbeatCoverageV1,
  HEARTBEAT_COVERAGE_ALGORITHM_VERSION,
  HEARTBEAT_HEALTH_TOLERANCE_SECONDS,
  trackingPolicyDisabledIntervals,
} from "../src/services/classpilotHeartbeatCoverage.js";
import {
  sanitizeExtensionMonitoringEvent,
  sanitizeMonitoringUrl,
} from "../src/services/classpilotMonitoringEventSanitizer.js";
import {
  materializeStudents,
  serverTrackingDisabledIntervals,
} from "../src/services/classpilotMonitoringReports.js";
import type { ClasspilotSessionReport, TeachingSession } from "../src/schema/classpilot.js";
import type { ClasspilotSessionReportInput } from "../src/services/storage.js";
import {
  assertClasspilotRetentionHours,
  parseClasspilotRetentionDays,
} from "../src/util/classpilotRetention.js";
import { isWithinTrackingWindow } from "../src/services/schoolHours.js";
import {
  decodeClasspilotEventCursor,
  encodeClasspilotEventCursor,
  formulaSafeCsvCell,
} from "../src/util/classpilotEventCursor.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 7, 13, 14, 0, seconds));

const typedTeachingSession: TeachingSession = {
  id: "teaching-session",
  groupId: "group",
  teacherId: "teacher",
  schoolId: "school",
  startTime: at(0),
  controlUpdatedAt: null,
  sessionMode: "live",
  scheduledConflictId: null,
  scheduledDate: null,
  scheduledTimezone: null,
  scheduledStartAt: null,
  scheduledEndAt: null,
  scheduledTeacherEmail: null,
  scheduledTeacherName: null,
  classNameSnapshot: "Class",
  timezoneSnapshot: "UTC",
  rosterSnapshotCompletedAt: at(0),
  scheduledState: null,
  scheduledFinalizationReason: null,
  endTime: at(60),
  createdAt: at(0),
};

const typedSessionReport: ClasspilotSessionReport = {
  id: "report",
  schoolId: "school",
  teachingSessionId: typedTeachingSession.id,
  state: "ready",
  windowStart: at(0),
  windowEnd: at(60),
  timezone: "UTC",
  reportVersion: 2,
  coverageAlgorithmVersion: "heartbeat-coverage-v2",
  eventSchemaVersion: 2,
  authorizationMarker: { version: 1, salt: "0123456789abcdef", digests: [] },
  trackingPolicy: null,
  rosterCount: 1,
  eligibleStudentCount: 1,
  completeCount: 1,
  partialCount: 0,
  noneCount: 0,
  notExpectedCount: 0,
  unavailableCount: 0,
  totalEligibleSeconds: 60,
  totalObservedSeconds: 60,
  totalGapSeconds: 0,
  totalUnclassifiedSeconds: 0,
  totalOffTaskSeconds: 0,
  totalOffTaskEventCount: 0,
  totalSafetyAlertCount: 1,
  settleAt: at(60),
  attemptCount: 1,
  leaseOwner: null,
  leaseExpiresAt: null,
  nextAttemptAt: at(60),
  lastError: null,
  materializedAt: at(60),
  expiresAt: new Date("2026-09-13T14:01:00.000Z"),
  detailExpiredAt: null,
  createdAt: at(0),
  updatedAt: at(60),
};

test("heartbeat-coverage-v2 uses an exact sixty-second healthy boundary", () => {
  assert.equal(HEARTBEAT_COVERAGE_ALGORITHM_VERSION, "heartbeat-coverage-v2");
  assert.equal(HEARTBEAT_HEALTH_TOLERANCE_SECONDS, 60);
  const exact = calculateHeartbeatCoverage({
    windowStart: at(0),
    windowEnd: at(120),
    authenticatedIntervals: [{ start: at(0), end: at(120), studentSessionId: "a" }],
    heartbeats: [{ timestamp: at(0) }, { timestamp: at(60) }, { timestamp: at(120) }],
  });
  assert.equal(exact.status, "complete");
  assert.equal(exact.gapSeconds, 0);

  const over = calculateHeartbeatCoverage({
    windowStart: at(0),
    windowEnd: at(121),
    authenticatedIntervals: [{ start: at(0), end: at(121), studentSessionId: "a" }],
    heartbeats: [{ timestamp: at(0) }, { timestamp: at(61) }, { timestamp: at(121) }],
  });
  assert.equal(over.status, "partial");
  assert.equal(over.gapSeconds, 1);
  assert.deepEqual(over.gaps.map((gap) => [gap.start.toISOString(), gap.end.toISOString()]), [
    [at(60).toISOString(), at(61).toISOString()],
  ]);
});

test("report v2 attributes forward for at most fifteen seconds without burst inflation", () => {
  const result = calculateHeartbeatCoverage({
    windowStart: at(0),
    windowEnd: at(60),
    authenticatedIntervals: [{ start: at(0), end: at(60), studentSessionId: "a" }],
    heartbeats: [
      { timestamp: at(0), url: "https://www.example.com/a?secret=1", category: "educational" },
      { timestamp: at(0), url: "https://www.example.com/a?secret=1", category: "educational" },
      { timestamp: at(2), url: "https://example.com/b", category: "educational" },
      { timestamp: at(10), url: "https://example.com/c", category: "educational" },
      { timestamp: at(40), url: "https://unknown.example/path", category: "unknown" },
    ],
  });

  assert.equal(result.observedSeconds, 60);
  assert.equal(result.topDomains.find((entry) => entry.domain === "example.com")?.seconds, 25);
  assert.equal(result.topDomains.find((entry) => entry.domain === "unknown.example")?.seconds, 15);
  assert.equal(result.topDomains.reduce((sum, entry) => sum + entry.seconds, 0), 40);
  assert.deepEqual(result.topActivities, [
    { kind: "domain", domain: "example.com", seconds: 25, visits: 1 },
    { kind: "domain", domain: "unknown.example", seconds: 15, visits: 1 },
  ]);
  assert.equal(result.unclassifiedSeconds, 35);
});

test("v1 and v2 add Google app activities without changing their domain attribution", () => {
  const heartbeats = [
    { timestamp: at(0), url: "https://docs.google.com/document/d/private-doc/edit", category: "educational" },
    { timestamp: at(10), url: "https://docs.google.com/presentation/d/private-slides/edit", category: "educational" },
    { timestamp: at(20), url: "https://docs.google.com/forms/d/private-form/viewform", category: "educational" },
    { timestamp: at(30), url: "https://docs.google.com/spreadsheets/d/private-sheet/edit", category: "educational" },
    { timestamp: at(40), url: "https://classroom.google.com/u/0/h", category: "educational" },
    { timestamp: at(50), url: "https://drive.google.com/drive/my-drive", category: "educational" },
  ];
  const common = {
    windowStart: at(0),
    windowEnd: at(60),
    authenticatedIntervals: [{ start: at(0), end: at(60), studentSessionId: "a" }],
  };
  const v1 = calculateHeartbeatCoverageV1({ ...common, heartbeats });
  const v2 = calculateHeartbeatCoverage({ ...common, heartbeats });

  assert.deepEqual(v1.topDomains, [
    { domain: "docs.google.com", seconds: 40, visits: 4 },
    { domain: "classroom.google.com", seconds: 10, visits: 1 },
    { domain: "drive.google.com", seconds: 10, visits: 1 },
  ]);
  assert.deepEqual(v2.topDomains, [
    { domain: "docs.google.com", seconds: 40, visits: 1 },
    { domain: "classroom.google.com", seconds: 10, visits: 1 },
    { domain: "drive.google.com", seconds: 10, visits: 1 },
  ]);
  const expectedActivities = [
    { kind: "google_classroom", domain: "classroom.google.com", seconds: 10, visits: 1 },
    { kind: "google_docs", domain: "docs.google.com", seconds: 10, visits: 1 },
    { kind: "google_drive", domain: "drive.google.com", seconds: 10, visits: 1 },
    { kind: "google_forms", domain: "docs.google.com", seconds: 10, visits: 1 },
    { kind: "google_sheets", domain: "docs.google.com", seconds: 10, visits: 1 },
    { kind: "google_slides", domain: "docs.google.com", seconds: 10, visits: 1 },
  ];
  assert.deepEqual(v1.topActivities, expectedActivities);
  assert.deepEqual(v2.topActivities, expectedActivities);
  assert.equal(JSON.stringify(v2.topActivities).includes("private-"), false);
});

test("heartbeat activity rollups are deterministically bounded to ten entries", () => {
  const heartbeats = Array.from({ length: 12 }, (_, index) => ({
    timestamp: at(index),
    url: `https://site-${String(index).padStart(2, "0")}.example/private`,
    category: "educational",
  }));
  const common = {
    windowStart: at(0),
    windowEnd: at(30),
    authenticatedIntervals: [{ start: at(0), end: at(30) }],
  };
  const v1 = calculateHeartbeatCoverageV1({ ...common, heartbeats });
  const v2 = calculateHeartbeatCoverage({ ...common, heartbeats });

  assert.equal(v1.topActivities.length, 10);
  assert.equal(v2.topActivities.length, 10);
  assert.deepEqual(v1.topActivities, [...v1.topActivities].sort((left, right) =>
    right.seconds - left.seconds
      || left.kind.localeCompare(right.kind)
      || left.domain.localeCompare(right.domain)));
  assert.deepEqual(v2.topActivities, [...v2.topActivities].sort((left, right) =>
    right.seconds - left.seconds
      || left.kind.localeCompare(right.kind)
      || left.domain.localeCompare(right.domain)));
});

test("report v2 groups off-task samples and applies teacher-intent exemptions first", () => {
  const result = calculateHeartbeatCoverage({
    windowStart: at(0),
    windowEnd: at(90),
    authenticatedIntervals: [{ start: at(0), end: at(90), studentSessionId: "a" }],
    heartbeats: [
      { timestamp: at(0), url: "https://games.example/a", category: "non-educational" },
      { timestamp: at(10), url: "https://games.example/b", category: "non-educational" },
      { timestamp: at(25), url: "https://games.example/c", category: "non-educational" },
      { timestamp: at(50), url: "https://games.example/teacher", category: "non-educational", teacherIntentExempt: true },
      { timestamp: at(70), url: "https://social.example/a", category: "non-educational" },
    ],
  });

  assert.equal(result.offTaskSeconds, 55);
  assert.equal(result.offTaskEventCount, 2);
  assert.deepEqual(result.offTaskEvents.map((event) => [event.domain, event.seconds]), [
    ["games.example", 40],
    ["social.example", 15],
  ]);
});

test("report windows are half-open at the class boundary", () => {
  const result = calculateHeartbeatCoverage({
    windowStart: at(0),
    windowEnd: at(61),
    authenticatedIntervals: [{ start: at(0), end: at(61), studentSessionId: "a" }],
    heartbeats: [{ timestamp: at(0) }, { timestamp: at(61) }],
  });
  assert.equal(result.heartbeatCount, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.gapSeconds, 1);
});

test("coverage merges authenticated device switches and subtracts delegated time", () => {
  const result = calculateHeartbeatCoverage({
    windowStart: at(0),
    windowEnd: at(180),
    authenticatedIntervals: [
      { start: at(0), end: at(90), studentSessionId: "device-a" },
      { start: at(90), end: at(180), studentSessionId: "device-b" },
    ],
    excludedIntervals: [{ start: at(60), end: at(120) }],
    heartbeats: [
      { timestamp: at(0), url: "https://example.com/a?q=secret" },
      { timestamp: at(60), url: "https://example.com/b" },
      { timestamp: at(120), url: "https://school.example/path" },
      { timestamp: at(180), url: "https://school.example/path" },
    ],
  });
  assert.equal(result.eligibleSeconds, 120);
  assert.equal(result.status, "complete");
  assert.equal(result.gapSeconds, 0);
});

test("tracking policy excludes configured off-hours without relying on extension telemetry", () => {
  const policy = {
      enableTrackingHours: true,
      trackingStartTime: "08:00",
      trackingEndTime: "15:00",
      trackingDays: ["Thursday"],
      schoolTimezone: "America/New_York",
      afterHoursMode: "off",
  } as const;
  const disabled = trackingPolicyDisabledIntervals(
    policy,
    new Date("2026-08-13T11:00:00.000Z"),
    new Date("2026-08-13T14:00:00.000Z")
  );
  assert.deepEqual(disabled.map((interval) => [interval.start.toISOString(), interval.end.toISOString()]), [
    ["2026-08-13T11:00:00.000Z", "2026-08-13T12:00:00.000Z"],
  ]);
});

test("extension-authored monitoring-off events cannot shrink report eligibility", () => {
  const base = {
    session: {} as any,
    roster: [],
    authenticatedSessions: [],
    heartbeats: [],
    exclusions: [],
    trackingPolicy: {} as any,
  };
  const extensionInput = {
    ...base,
    monitoringEvents: [
      { studentId: "student", eventType: "monitoring_state_changed", origin: "extension", occurredAt: at(30), metadata: { state: "off" } },
      { studentId: "student", eventType: "monitoring_state_changed", origin: "extension", occurredAt: at(90), metadata: { state: "on" } },
    ],
  } as any;
  assert.deepEqual(serverTrackingDisabledIntervals(extensionInput, "student", at(0), at(120)), []);

  const serverInput = {
    ...extensionInput,
    monitoringEvents: extensionInput.monitoringEvents.map((event: any) => ({ ...event, origin: "server" })),
  };
  assert.deepEqual(
    serverTrackingDisabledIntervals(serverInput, "student", at(0), at(120))
      .map((interval) => [interval.start.toISOString(), interval.end.toISOString()]),
    [[at(30).toISOString(), at(90).toISOString()]]
  );
});

test("mid-session roster capture does not charge pre-capture authenticated time", () => {
  const [student] = materializeStudents({
    windowStart: at(0),
    windowEnd: at(120),
  } as any, {
    session: {} as any,
    roster: [{ studentId: "student", studentName: "Student", capturedAt: at(60) }],
    authenticatedSessions: [{
      id: "student-session",
      studentId: "student",
      startedAt: at(0),
      endedAt: at(120),
      lastSeenAt: at(120),
    }],
    heartbeats: [
      { studentId: "student", timestamp: at(0), activeTabUrl: null },
      { studentId: "student", timestamp: at(60), activeTabUrl: null },
    ],
    exclusions: [],
    monitoringEvents: [],
    trackingPolicy: {
      enableTrackingHours: false,
      trackingStartTime: null,
      trackingEndTime: null,
      trackingDays: [],
      schoolTimezone: "America/New_York",
      afterHoursMode: "off",
    },
  });
  assert.equal(student?.eligibleSeconds, 60);
  assert.equal(student?.heartbeatCount, 1);
  assert.equal(student?.status, "complete");
});

test("report v2 freezes exact-bound evidence availability and human review labels", () => {
  const baseInput = {
    session: typedTeachingSession,
    roster: [{ studentId: "student", studentName: "Student", capturedAt: at(0) }],
    authenticatedSessions: [{
      id: "student-session",
      studentId: "student",
      startedAt: at(0),
      endedAt: at(60),
      lastSeenAt: at(60),
    }],
    heartbeats: [{
      id: "heartbeat",
      studentId: "student",
      timestamp: at(10),
      activeTabUrl: "https://unsafe.example/path?secret=yes",
      aiCategory: "non-educational",
      safetyAlert: "violence",
    }],
    aiDecisions: [{
      id: "decision",
      heartbeatId: "heartbeat",
      studentId: "student",
      domain: "unsafe.example",
      category: "non-educational",
      safetyAlert: "violence",
      teacherIntentSource: null,
      reviewStatus: "confirmed",
      createdAt: at(11),
    }],
    evidenceArtifacts: [{
      studentId: "student",
      studentSessionId: "student-session",
      sourceId: "heartbeat",
      status: "available",
    }],
    exclusions: [],
    monitoringEvents: [],
    trackingPolicy: {
      enableTrackingHours: false,
      trackingStartTime: null,
      trackingEndTime: null,
      trackingDays: [],
      schoolTimezone: "UTC",
      afterHoursMode: "off",
    },
  } satisfies ClasspilotSessionReportInput;
  const [student] = materializeStudents(typedSessionReport, baseInput);
  assert.deepEqual(student?.safetyAlerts, [{
    category: "violence",
    domain: "unsafe.example",
    occurredAt: at(10).toISOString(),
    evidenceAvailability: "available",
    reviewStatus: "Confirmed",
  }]);

  const [mismatched] = materializeStudents(typedSessionReport, {
    ...baseInput,
    evidenceArtifacts: [{
      studentId: "student",
      studentSessionId: "other-session",
      sourceId: "heartbeat",
      status: "available",
    }],
  });
  assert.equal(mismatched?.safetyAlerts[0]?.evidenceAvailability, "unavailable");
});

test("tracking policy handles cross-midnight windows and DST wall-clock boundaries", () => {
  const crossMidnight = trackingPolicyDisabledIntervals({
      enableTrackingHours: true,
      trackingStartTime: "20:00",
      trackingEndTime: "02:00",
      trackingDays: ["Thursday"],
      schoolTimezone: "America/New_York",
      afterHoursMode: "off",
  } as any, new Date("2026-08-14T00:00:00.000Z"), new Date("2026-08-14T08:00:00.000Z"));
  assert.deepEqual(crossMidnight.map((interval) => [interval.start.toISOString(), interval.end.toISOString()]), [
    ["2026-08-14T06:00:00.000Z", "2026-08-14T08:00:00.000Z"],
  ]);

  const fallBack = trackingPolicyDisabledIntervals({
      enableTrackingHours: true,
      trackingStartTime: "00:00",
      trackingEndTime: "03:00",
      trackingDays: ["Sunday"],
      schoolTimezone: "America/New_York",
      afterHoursMode: "off",
  } as any, new Date("2026-11-01T04:00:00.000Z"), new Date("2026-11-01T08:00:00.000Z"));
  assert.deepEqual(fallBack, []);
});

test("runtime tracking and reports attribute overnight hours to the starting weekday", () => {
  const policy = {
    enableTrackingHours: true,
    trackingStartTime: "20:00",
    trackingEndTime: "02:00",
    trackingDays: ["Monday"],
    schoolTimezone: "UTC",
  };
  assert.equal(isWithinTrackingWindow(policy, new Date("2026-08-17T21:00:00.000Z")), true);
  assert.equal(isWithinTrackingWindow(policy, new Date("2026-08-18T01:00:00.000Z")), true);
  assert.equal(isWithinTrackingWindow(policy, new Date("2026-08-18T03:00:00.000Z")), false);
  assert.deepEqual(trackingPolicyDisabledIntervals({
    ...policy,
    afterHoursMode: "off",
  }, new Date("2026-08-17T19:00:00.000Z"), new Date("2026-08-18T03:00:00.000Z"))
    .map((interval) => [interval.start.toISOString(), interval.end.toISOString()]), [
      ["2026-08-17T19:00:00.000Z", "2026-08-17T20:00:00.000Z"],
      ["2026-08-18T02:00:00.000Z", "2026-08-18T03:00:00.000Z"],
    ]);
});

test("signed-in time with no telemetry is none; no eligible time is not expected", () => {
  const none = calculateHeartbeatCoverage({
    windowStart: at(0),
    windowEnd: at(120),
    authenticatedIntervals: [{ start: at(0), end: at(120) }],
    heartbeats: [],
  });
  assert.equal(none.status, "none");
  assert.equal(none.coveragePercent, 0);
  assert.equal(none.gapSeconds, 120);

  const notExpected = calculateHeartbeatCoverage({
    windowStart: at(0),
    windowEnd: at(120),
    authenticatedIntervals: [],
    heartbeats: [],
  });
  assert.equal(notExpected.status, "not_expected");
  assert.equal(notExpected.coveragePercent, null);
});

test("event sanitizer strips URL secrets and rejects arbitrary metadata", () => {
  const url = sanitizeMonitoringUrl("https://user:pass@WWW.Example.COM/a b?q=secret#answer");
  assert.deepEqual(url, {
    normalizedDomain: "example.com",
    sanitizedPath: "/a%20b",
  });
  const event = sanitizeExtensionMonitoringEvent({
    sourceEventId: "evt-1",
    schemaVersion: 1,
    type: "navigation_blocked",
    occurredAt: at(1).toISOString(),
    url: "https://user:pass@example.com/test?token=secret#fragment",
    title: "  A\u0000 title  ",
    metadata: {
      policySource: "teacher",
      ruleId: 2001,
      keystrokes: "never store this",
      clipboard: "never store this",
    },
  }, at(2));
  assert.ok(event);
  assert.equal(event.normalizedDomain, "example.com");
  assert.equal(event.sanitizedPath, "/test");
  assert.equal(event.title, "A title");
  assert.deepEqual(event.metadata, { policySource: "teacher", ruleId: 2001 });
  assert.equal(JSON.stringify(event).includes("secret"), false);
  assert.equal(JSON.stringify(event).includes("keystrokes"), false);
});

test("extension cannot submit server-derived events", () => {
  assert.equal(sanitizeExtensionMonitoringEvent({
    sourceEventId: "evt-2",
    schemaVersion: 1,
    type: "monitoring_gap",
    occurredAt: at(1).toISOString(),
  }, at(2)), null);
});

test("blocked-navigation metadata accepts only the typed policy-source vocabulary", () => {
  const rejected = sanitizeExtensionMonitoringEvent({
    sourceEventId: "evt-policy-bad",
    schemaVersion: 1,
    type: "navigation_blocked",
    occurredAt: at(1).toISOString(),
    url: "https://example.test/path",
    metadata: { policySource: "made_up_policy" },
  }, at(2));
  assert.equal(rejected, null);

  const accepted = sanitizeExtensionMonitoringEvent({
    sourceEventId: "evt-policy-good",
    schemaVersion: 1,
    type: "navigation_blocked",
    occurredAt: at(1).toISOString(),
    url: "https://example.test/path",
    metadata: { policySource: "teacher" },
  }, at(2));
  assert.equal(accepted?.metadata.policySource, "teacher");
});

test("retention is constrained to whole days from one through 365", () => {
  assert.equal(assertClasspilotRetentionHours(24), 24);
  assert.equal(assertClasspilotRetentionHours("8760"), 8760);
  assert.throws(() => assertClasspilotRetentionHours(23), /whole number of days/);
  assert.throws(() => assertClasspilotRetentionHours(8784), /whole number of days/);
  assert.equal(parseClasspilotRetentionDays("720"), 30);
  assert.equal(parseClasspilotRetentionDays("999999"), 30);
  for (const invalid of ["25", "47", "720junk", "8783", "0x2d0", "7.2e2", 23.5, true]) {
    assert.equal(parseClasspilotRetentionDays(invalid), 30);
  }
  assert.throws(() => assertClasspilotRetentionHours("0x2d0"), /whole number of days/);
});

test("event cursors are opaque and CSV output neutralizes formulas", () => {
  const cursor = { occurredAt: at(42), id: "row-42" };
  assert.deepEqual(decodeClasspilotEventCursor(encodeClasspilotEventCursor(cursor)), cursor);
  assert.equal(decodeClasspilotEventCursor("garbage"), undefined);
  assert.equal(formulaSafeCsvCell("=HYPERLINK(\"https://bad\")"), '"\'=HYPERLINK(""https://bad"")"');
  assert.equal(formulaSafeCsvCell("   +1+1"), '"\'   +1+1"');
  assert.equal(formulaSafeCsvCell("normal"), '"normal"');
});
