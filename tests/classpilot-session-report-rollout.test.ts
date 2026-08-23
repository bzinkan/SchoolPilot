import assert from "node:assert/strict";
import test from "node:test";
import {
  classpilotSessionReportV2Mode,
  classpilotSessionReportVersionForNewRow,
} from "../src/config/classpilotSessionReportRollout.js";
import { buildSessionSummaryEmail } from "../src/services/email.js";
import {
  calculateHeartbeatCoverage,
  calculateHeartbeatCoverageV1,
} from "../src/services/classpilotHeartbeatCoverage.js";
import {
  classpilotReportV2ShadowComparison,
  materializeStudents,
} from "../src/services/classpilotMonitoringReports.js";
import { classpilotSessionReportDto } from "../src/services/classpilotSessionReportPresentation.js";
import type {
  ClasspilotSessionReport,
  ClasspilotSessionStudentReport,
  TeachingSession,
} from "../src/schema/classpilot.js";
import type { ClasspilotSessionReportInput } from "../src/services/storage.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 7, 22, 14, 0, seconds));

const session = {
  id: "session",
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
} satisfies TeachingSession;

function report(version: 1 | 2): ClasspilotSessionReport {
  return {
    id: `report-${version}`,
    schoolId: "school",
    teachingSessionId: session.id,
    state: "ready",
    windowStart: at(0),
    windowEnd: at(60),
    timezone: "UTC",
    reportVersion: version,
    coverageAlgorithmVersion: `heartbeat-coverage-v${version}`,
    eventSchemaVersion: version,
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
    totalUnclassifiedSeconds: version === 2 ? 45 : 0,
    totalOffTaskSeconds: 0,
    totalOffTaskEventCount: 0,
    totalSafetyAlertCount: 0,
    settleAt: at(60),
    attemptCount: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: at(60),
    lastError: null,
    materializedAt: at(60),
    expiresAt: at(3600),
    detailExpiredAt: null,
    createdAt: at(0),
    updatedAt: at(60),
  };
}

const input = {
  session,
  roster: [{ studentId: "student", studentName: "Student", capturedAt: at(0) }],
  authenticatedSessions: [{
    id: "student-session",
    studentId: "student",
    startedAt: at(0),
    endedAt: at(60),
    lastSeenAt: at(60),
  }],
  heartbeats: [
    {
      id: "heartbeat-a",
      studentId: "student",
      timestamp: at(0),
      activeTabUrl: "https://a.example/path",
      aiCategory: "educational",
      safetyAlert: null,
    },
    {
      id: "heartbeat-b",
      studentId: "student",
      timestamp: at(0),
      activeTabUrl: "https://b.example/path",
      aiCategory: "educational",
      safetyAlert: null,
    },
  ],
  aiDecisions: [],
  evidenceArtifacts: [],
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

const studentReport = {
  id: "student-report",
  schoolId: "school",
  reportId: "report-1",
  teachingSessionId: "session",
  studentId: "student",
  studentNameSnapshot: "Student",
  status: "complete",
  eligibleSeconds: 60,
  observedSeconds: 60,
  gapSeconds: 0,
  coveragePercent: 100,
  heartbeatCount: 2,
  firstObservedAt: at(0),
  lastObservedAt: at(0),
  gapIntervals: [],
  eventCounts: {},
  topDomains: [{ domain: "a.example", seconds: 10, visits: 1 }],
  unclassifiedSeconds: 45,
  offTaskSeconds: 0,
  offTaskEventCount: 0,
  offTaskEvents: [],
  safetyAlerts: [],
  createdAt: at(60),
} satisfies ClasspilotSessionStudentReport;

test("report-v2 rollout mode fails closed and only on creates version 2", () => {
  for (const value of [undefined, "", "ON", "invalid"]) {
    assert.equal(classpilotSessionReportV2Mode(value), "legacy");
    assert.equal(classpilotSessionReportVersionForNewRow(value), 1);
  }
  assert.equal(classpilotSessionReportVersionForNewRow("legacy"), 1);
  assert.equal(classpilotSessionReportVersionForNewRow("shadow"), 1);
  assert.equal(classpilotSessionReportVersionForNewRow("on"), 2);
});

test("stored report version selects frozen v1 or v2 arithmetic", () => {
  const v1 = materializeStudents(report(1), input);
  const v2 = materializeStudents(report(2), input);
  assert.equal(v1[0]?.heartbeatCount, 2);
  assert.equal(v1[0]?.topDomains.reduce((sum, domain) => sum + domain.seconds, 0), 20);
  assert.equal(v1[0]?.unclassifiedSeconds, 0);
  assert.equal(v2[0]?.heartbeatCount, 1);
  assert.equal(v2[0]?.topDomains.reduce((sum, domain) => sum + domain.seconds, 0), 15);
  assert.equal(v2[0]?.unclassifiedSeconds, 45);
  assert.deepEqual(classpilotReportV2ShadowComparison(v1, v2), {
    aggregateMismatch: true,
    invariantViolation: false,
  });

  const directV1 = calculateHeartbeatCoverageV1({
    windowStart: at(0),
    windowEnd: at(60),
    authenticatedIntervals: [{ start: at(0), end: at(60) }],
    heartbeats: input.heartbeats.map((heartbeat) => ({
      timestamp: heartbeat.timestamp,
      url: heartbeat.activeTabUrl,
    })),
  });
  const directV2 = calculateHeartbeatCoverage({
    windowStart: at(0),
    windowEnd: at(60),
    authenticatedIntervals: [{ start: at(0), end: at(60) }],
    heartbeats: input.heartbeats.map((heartbeat) => ({
      timestamp: heartbeat.timestamp,
      url: heartbeat.activeTabUrl,
      category: heartbeat.aiCategory,
    })),
  });
  assert.equal(directV1.heartbeatCount, 2);
  assert.equal(directV2.heartbeatCount, 1);
});

test("v1 JSON and email presentation remain the legacy contract", () => {
  const dto = JSON.parse(JSON.stringify(classpilotSessionReportDto(report(1), [studentReport])));
  assert.deepEqual(Object.keys(dto), [
    "teachingSessionId",
    "windowStart",
    "windowEnd",
    "timezone",
    "coverageAlgorithmVersion",
    "totals",
    "students",
  ]);
  assert.equal(dto.reportVersion, undefined);
  assert.equal(dto.totals.unclassifiedSeconds, undefined);
  assert.equal(dto.students[0].safetyAlerts, undefined);

  const baseEmail = {
    to: "teacher@example.edu",
    teacherName: "Teacher",
    className: "Class",
    date: "August 22, 2026",
    startTime: "10:00 AM",
    endTime: "11:00 AM",
    duration: "60 min",
    studentCount: 1,
    students: [{
      name: "Student",
      totalMinutes: 1,
      topDomains: [{ domain: "example.edu", minutes: 1 }],
      offTaskCount: 1,
      offTaskMinutes: 1,
      unclassifiedMinutes: 1,
      safetyAlerts: ["violence"],
      safetyUrls: ["unsafe.example"],
      safetyReviewStatuses: ["Confirmed"],
      coverageStatus: "complete" as const,
      coveragePercent: 100,
      gapMinutes: 0,
    }],
  };
  const legacy = buildSessionSummaryEmail({ ...baseEmail, reportVersion: 1 });
  const v2 = buildSessionSummaryEmail({ ...baseEmail, reportVersion: 2 });
  assert.doesNotMatch(legacy.html, /Screenshots are not used|Unclassified|Off-task \/ events|Review status/);
  assert.match(legacy.html, />Site<\/th>/);
  assert.match(v2.html, /Screenshots are not used|Unclassified|Off-task \/ events|Review status/);
});
