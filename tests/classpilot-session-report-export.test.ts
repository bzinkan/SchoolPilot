import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  classpilotSessionReportCsv,
  classpilotSessionReportDto,
} from "../src/services/classpilotSessionReportPresentation.js";

describe("immutable ClassPilot report CSV", () => {
  it("projects JSON and CSV from the same frozen report without internal authority or full URLs", () => {
    const report = {
      teachingSessionId: "teaching-session",
      windowStart: new Date("2026-08-22T12:00:00.000Z"),
      windowEnd: new Date("2026-08-22T13:00:00.000Z"),
      timezone: "America/New_York",
      reportVersion: 2,
      coverageAlgorithmVersion: "heartbeat-coverage-v2",
      rosterCount: 1,
      eligibleStudentCount: 1,
      completeCount: 1,
      partialCount: 0,
      noneCount: 0,
      notExpectedCount: 0,
      unavailableCount: 0,
      totalEligibleSeconds: 3_600,
      totalObservedSeconds: 3_590,
      totalGapSeconds: 10,
      totalUnclassifiedSeconds: 15,
      totalOffTaskSeconds: 20,
      totalOffTaskEventCount: 1,
      totalSafetyAlertCount: 1,
    } as any;
    const student = {
      studentId: "student",
      studentNameSnapshot: "=Formula Student",
      status: "complete",
      eligibleSeconds: 3_600,
      observedSeconds: 3_590,
      gapSeconds: 10,
      coveragePercent: 99,
      heartbeatCount: 360,
      firstObservedAt: new Date("2026-08-22T12:00:00.000Z"),
      lastObservedAt: new Date("2026-08-22T12:59:50.000Z"),
      gapIntervals: [{
        start: "2026-08-22T12:30:00.000Z",
        end: "2026-08-22T12:30:10.000Z",
        durationSeconds: 10,
        cause: "unknown",
        studentSessionId: "internal-session-secret",
      }],
      eventCounts: { monitoring_gap: 1 },
      topDomains: [{ domain: "example.edu", seconds: 30, visits: 2 }],
      unclassifiedSeconds: 15,
      offTaskSeconds: 20,
      offTaskEventCount: 1,
      offTaskEvents: [{
        domain: "games.example",
        category: "non-educational",
        start: "2026-08-22T12:10:00.000Z",
        end: "2026-08-22T12:10:20.000Z",
        seconds: 20,
      }],
      safetyAlerts: [{
        category: "violence",
        domain: "unsafe.example",
        occurredAt: "2026-08-22T12:11:00.000Z",
        evidenceAvailability: "available",
        reviewStatus: "Confirmed",
      }],
      // These internal fields exist on persistence rows and must not enter the
      // shared JSON/CSV projection.
      deviceId: "internal-device-secret",
      studentSessionId: "internal-session-secret",
    } as any;

    const dto = classpilotSessionReportDto(report, [student]);
    const serializedDto = JSON.stringify(dto);
    assert.equal(dto.reportVersion, 2);
    assert.equal(dto.totals.observedSeconds, 3_590);
    assert.deepEqual(dto.students[0]?.safetyAlerts, student.safetyAlerts);
    assert.doesNotMatch(serializedDto, /internal-device-secret|internal-session-secret/);

    const csv = classpilotSessionReportCsv(dto);
    assert.match(csv, /"Report Version"/);
    assert.match(csv, /"heartbeat-coverage-v2"/);
    assert.match(csv, /"'\=Formula Student"/);
    assert.match(csv, /unsafe\.example/);
    assert.match(csv, /Confirmed/);
    assert.match(csv, /available/);
    assert.doesNotMatch(csv, /internal-device-secret|internal-session-secret|secret=/);
  });

  it("loads explicit captures through their exact request tuple and heartbeat link", () => {
    const storage = readFileSync(
      new URL("../src/services/storage.ts", import.meta.url),
      "utf8"
    );
    assert.match(
      storage,
      /sourceId: classpilotEvidenceCaptureRequests\.heartbeatId/
    );
    for (const exactJoin of [
      /evidenceArtifacts\.id, classpilotEvidenceCaptureRequests\.artifactId/,
      /evidenceArtifacts\.schoolId, classpilotEvidenceCaptureRequests\.schoolId/,
      /evidenceArtifacts\.deviceId, classpilotEvidenceCaptureRequests\.deviceId/,
      /evidenceArtifacts\.studentId, classpilotEvidenceCaptureRequests\.studentId/,
      /evidenceArtifacts\.studentSessionId, classpilotEvidenceCaptureRequests\.studentSessionId/,
      /evidenceArtifacts\.sourceId, classpilotEvidenceCaptureRequests\.id/,
    ]) {
      assert.match(storage, exactJoin);
    }
    assert.match(
      storage,
      /evidenceArtifacts: \[[\s\S]{0,200}ambientEvidenceArtifacts[\s\S]{0,100}safetyCaptureEvidenceArtifacts/
    );
  });

  it("keeps raw-event CSV as legacy and exposes a separate immutable report endpoint", () => {
    const route = readFileSync(
      new URL("../src/routes/classpilot/monitoringEvents.ts", import.meta.url),
      "utf8"
    );
    assert.match(route, /teaching-sessions\/:id\/report\/export\.csv/);
    assert.match(route, /classpilotSessionReportDto\(report, studentReports\)/);
    assert.match(route, /classpilotSessionReportCsv\(reportDto\)/);
    assert.match(route, /teaching-sessions\/:id\/events\/export\.csv/);
  });
});
