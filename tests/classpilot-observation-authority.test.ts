import assert from "node:assert/strict";
import test from "node:test";
import {
  canObserveClasspilotSession,
  classpilotObservationSessionIsCurrent,
  classpilotReportingObservationSessionIsCurrent,
  type ClasspilotObservationSession,
} from "../src/services/classpilotObservationAuthority.js";

const now = new Date("2026-09-24T14:15:00Z");
const reporting: ClasspilotObservationSession = Object.freeze({
  sessionMode: "scheduled_report",
  scheduledState: "active",
  scheduledDate: "2026-09-24",
  startTime: new Date("2026-09-24T14:00:00Z"),
  scheduledStartAt: new Date("2026-09-24T14:00:00Z"),
  scheduledEndAt: new Date("2026-09-24T15:00:00Z"),
  rosterSnapshotCompletedAt: new Date("2026-09-24T14:00:00Z"),
  endTime: null,
});

test("admin observation does not require teacher presence or promote a frozen reporting occurrence", () => {
  assert.equal(classpilotReportingObservationSessionIsCurrent(reporting, now), true);
  assert.equal(classpilotObservationSessionIsCurrent(reporting, now), true);
  assert.equal(canObserveClasspilotSession({ session: reporting, administrator: true, assignedStaff: false, now }), true);
  assert.equal(canObserveClasspilotSession({ session: reporting, administrator: true, assignedStaff: true, now }), true);
  assert.equal(canObserveClasspilotSession({ session: reporting, administrator: false, assignedStaff: true, now }), false);
  assert.equal(canObserveClasspilotSession({ session: reporting, administrator: false, assignedStaff: false, now }), false);
  assert.equal(reporting.sessionMode, "scheduled_report");
  assert.equal(reporting.endTime, null);
});

test("reporting observation ends exactly at the frozen boundary and never opens future blocks", () => {
  assert.equal(classpilotReportingObservationSessionIsCurrent(reporting, new Date("2026-09-24T13:59:59.999Z")), false);
  assert.equal(classpilotReportingObservationSessionIsCurrent(reporting, new Date("2026-09-24T14:00:00Z")), true);
  assert.equal(classpilotReportingObservationSessionIsCurrent(reporting, new Date("2026-09-24T14:59:59.999Z")), true);
  assert.equal(classpilotReportingObservationSessionIsCurrent(reporting, new Date("2026-09-24T15:00:00Z")), false);
});

test("ended, skipped, unfrozen and malformed reporting occurrences fail closed", () => {
  const unavailable: Partial<ClasspilotObservationSession>[] = [
    { endTime: now }, { scheduledState: "skipped" }, { scheduledState: "finalized" },
    { scheduledState: null }, { scheduledDate: null }, { rosterSnapshotCompletedAt: null },
    { rosterSnapshotCompletedAt: "invalid" }, { scheduledStartAt: null },
    { scheduledStartAt: "invalid" }, { scheduledEndAt: null }, { scheduledEndAt: "invalid" },
    { scheduledEndAt: reporting.scheduledStartAt }, { sessionMode: "historical" },
  ];
  for (const change of unavailable) {
    const session = { ...reporting, ...change };
    assert.equal(classpilotReportingObservationSessionIsCurrent(session, now), false, JSON.stringify(change));
    assert.equal(canObserveClasspilotSession({ session, administrator: true, assignedStaff: true, now }), false);
  }
  assert.equal(classpilotObservationSessionIsCurrent(null, now), false);
  assert.equal(classpilotObservationSessionIsCurrent(reporting, new Date("invalid")), false);
});

test("report-to-live transition preserves administrator observation and restores assigned staff access", () => {
  const live = { ...reporting, sessionMode: "live" };
  assert.equal(classpilotReportingObservationSessionIsCurrent(live, now), false);
  assert.equal(canObserveClasspilotSession({ session: live, administrator: true, assignedStaff: false, now }), true);
  assert.equal(canObserveClasspilotSession({ session: live, administrator: false, assignedStaff: true, now }), true);
  assert.equal(canObserveClasspilotSession({ session: live, administrator: false, assignedStaff: false, now }), false);
  assert.equal(classpilotObservationSessionIsCurrent({ ...live, endTime: now }, now), false);
  assert.equal(classpilotObservationSessionIsCurrent({ ...live, scheduledEndAt: now }, now), false);
  assert.equal(classpilotObservationSessionIsCurrent({ ...live, startTime: "invalid" }, now), false);
  assert.equal(classpilotObservationSessionIsCurrent({ ...live, scheduledEndAt: null }, now), true);
});
