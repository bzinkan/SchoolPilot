import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { supervisionActivityReportingEnabled, supervisionParticipationIntervals, supervisionReportPastRetention, supervisionCaptureTimeIsCurrent } from "../src/services/classpilotSupervisionReportLifecycle.js";
import type { ClasspilotSupervisionStudent } from "../src/schema/classpilot.js";

const at = (time: string) => new Date(`2026-09-14T${time}:00.000Z`);
const context = { startsAt: at("09:00"), endsAt: at("10:45"), endedAt: null };
const assignment = (id: string, start: string, end?: string): ClasspilotSupervisionStudent => ({
  id, schoolId: "school", contextId: "context", studentId: "student", source: "manual", assignedBy: "staff",
  assignedAt: at(start), releasedAt: end ? at(end) : null, releaseReason: end ? "released" : null,
});

describe("supervision activity lifecycle interval boundaries", () => {
  it("clips late joins and early departures to the actual staff tenure", () => {
    const rows = [assignment("first", "08:30", "09:20"), assignment("return", "09:35", "11:00")];
    assert.deepEqual(supervisionParticipationIntervals(at("09:10"), context, rows, at("10:00")), [
      { assignmentId: "first", start: at("09:10").toISOString(), end: at("09:20").toISOString() },
      { assignmentId: "return", start: at("09:35").toISOString(), end: at("10:00").toISOString() },
    ]);
  });

  it("uses adjacent staff windows and excludes zero-length assignments at handoff", () => {
    const rows = [assignment("one", "09:00", "10:00"), assignment("two", "10:00")];
    assert.deepEqual(supervisionParticipationIntervals(at("09:00"), context, rows, at("10:00")), [
      { assignmentId: "one", start: at("09:00").toISOString(), end: at("10:00").toISOString() },
    ]);
    assert.deepEqual(supervisionParticipationIntervals(at("10:00"), context, rows, at("10:45")), [
      { assignmentId: "two", start: at("10:00").toISOString(), end: at("10:45").toISOString() },
    ]);
  });

  it("keeps continuing participation open for extensions and clips delayed expiry", () => {
    const rows = [assignment("one", "09:00")];
    assert.equal(supervisionParticipationIntervals(at("09:00"), context, rows)[0]?.end, null);
    assert.equal(supervisionParticipationIntervals(at("09:00"), context, rows, at("11:00"))[0]?.end, at("10:45").toISOString());
    assert.equal(supervisionParticipationIntervals(at("09:00"), { ...context, endedAt: at("09:30") }, rows)[0]?.end, at("09:30").toISOString());
  });
});

describe("supervision report activation cutoff", () => {
  const original = process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM;
  after(() => {
    if (original === undefined) delete process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM;
    else process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM = original;
  });
  it("requires an explicit real UTC date and waits until the shared cutoff", () => {
    for (const value of ["", "true", "2026-02-30T00:00:00Z", "2026-09-14", "2026-09-14T09:00:00-04:00"]) {
      process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM = value;
      assert.equal(supervisionActivityReportingEnabled(at("09:00")), false, value);
    }
    process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM = at("09:00").toISOString();
    assert.equal(supervisionActivityReportingEnabled(at("08:59")), false);
    assert.equal(supervisionActivityReportingEnabled(at("09:00")), true);
  });
});

describe("supervision report retention", () => {
  it("honors a shorter current policy and never extends frozen expiry", () => {
    const report = { windowEnd: at("09:00"), expiresAt: new Date("2026-10-14T09:00:00.000Z") };
    assert.equal(supervisionReportPastRetention(report, new Date("2026-09-16T09:00:00.000Z"), new Date("2026-09-15T09:00:00.000Z")), true);
    assert.equal(supervisionReportPastRetention(report, new Date("2026-10-14T09:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z")), true);
    assert.equal(supervisionReportPastRetention(report, at("10:00"), new Date("2026-09-13T09:00:00.000Z")), false);
    assert.equal(supervisionReportPastRetention({ windowEnd: null, expiresAt: null }, at("10:00"), at("09:00")), false);
  });
});

describe("supervision capture clock", () => {
  it("does not treat a newly created tenure as empty using an older scheduler time", () => {
    const current = { startsAt: at("09:10"), createdAt: at("09:10"), updatedAt: at("09:10"), endedAt: null };
    const rows = [assignment("new", "09:10")];
    assert.equal(supervisionCaptureTimeIsCurrent(at("09:00"), current, at("09:10"), rows), false);
    assert.equal(supervisionCaptureTimeIsCurrent(at("09:11"), current, at("09:10"), rows), true);
  });

  it("rejects stale observations across a handoff, later join, and release", () => {
    const current = { startsAt: at("09:00"), createdAt: at("09:00"), updatedAt: at("09:00"), endedAt: null };
    assert.equal(supervisionCaptureTimeIsCurrent(at("09:29"), current, at("09:30"), [assignment("existing", "09:00")]), false);
    assert.equal(supervisionCaptureTimeIsCurrent(at("09:29"), current, at("09:00"), [assignment("later", "09:30")]), false);
    assert.equal(supervisionCaptureTimeIsCurrent(at("09:29"), current, at("09:00"), [assignment("released", "09:00", "09:30")]), false);
    assert.equal(supervisionCaptureTimeIsCurrent(at("09:30"), current, at("09:30"), [assignment("boundary", "09:30")]), true);
  });
});
