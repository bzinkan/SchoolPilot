import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hydrateClasspilotCoverageStatuses,
  snapshotClasspilotCoverageHydrationMetrics,
} from "../src/services/classpilotCoverageHydration.js";
import { markClasspilotRealtimeSignedOut, writeClasspilotRealtimeStatus } from "../src/services/classpilotRealtimeStatus.js";

describe("ClassPilot coverage bulk hydration", () => {
  it("hydrates 500 known exact bindings with no SQL and one Redis batch", async () => {
    const now = Date.now();
    const studentIds = Array.from({ length: 500 }, (_, index) => `student-${index}`);
    const knownSessions = studentIds.map((studentId, index) => ({
      id: `student-session-${index}`,
      studentId,
      deviceId: `internal-device-${index}`,
      lastSeenAt: new Date(now - index),
    }));
    snapshotClasspilotCoverageHydrationMetrics({ reset: true });

    const result = await hydrateClasspilotCoverageStatuses({
      schoolId: "coverage-hydration-school",
      studentIds,
      knownSessions,
      now,
    });

    assert.equal(result.size, 500);
    assert.equal(result.get("student-0")?.status, "online");
    assert.equal(result.get("student-0")?.isLoggedIn, true);
    assert.equal(result.get("student-0")?.loginState, "logged_in");
    assert.equal(result.get("student-0")?.lastSeenAt, now);
    const metrics = snapshotClasspilotCoverageHydrationMetrics();
    assert.equal(metrics.requests, 1);
    assert.equal(metrics.students, 500);
    assert.equal(metrics.sessionSqlStatements, 0);
    assert.equal(metrics.realtimeRedisCommands, 1);
    assert.ok(metrics.durationMs >= 0);

    const serialized = JSON.stringify([...result.values()]);
    assert.equal(serialized.includes("deviceId"), false);
    assert.equal(serialized.includes("studentSessionId"), false);
    assert.equal(serialized.includes("internal-device-"), false);
    assert.equal(serialized.includes("student-session-"), false);
  });

  it("deduplicates requested students and keeps the newest known binding", async () => {
    const now = Date.now();
    snapshotClasspilotCoverageHydrationMetrics({ reset: true });

    const result = await hydrateClasspilotCoverageStatuses({
      schoolId: "coverage-hydration-dedup-school",
      studentIds: ["student-a", "student-a", ""],
      knownSessions: [
        {
          id: "older-session",
          studentId: "student-a",
          deviceId: "older-device",
          lastSeenAt: new Date(now - 10_000),
        },
        {
          id: "newer-session",
          studentId: "student-a",
          deviceId: "newer-device",
          lastSeenAt: new Date(now),
        },
      ],
      now,
    });

    assert.equal(result.size, 1);
    assert.equal(result.get("student-a")?.lastSeenAt, now);
    const metrics = snapshotClasspilotCoverageHydrationMetrics();
    assert.equal(metrics.students, 1);
    assert.equal(metrics.sessionSqlStatements, 0);
    assert.equal(metrics.realtimeRedisCommands, 1);
  });

  it("projects scheduled-classroom and Focus support from the accepted set, never the advertisement", async () => {
    // The Claimed view gates tiles, tools and Live View on these two flags and
    // reads them from this projection. A device that has negotiated both must
    // read true; one that merely advertises them must stay false, because the
    // server-side tile read (devices.ts) admits a supervision-bound frame only
    // for a negotiated client and the dashboard must agree with it.
    const now = Date.now();
    const schoolId = "coverage-hydration-scheduled-school";
    const negotiated = {
      studentId: "coverage-hydration-scheduled-negotiated",
      studentSessionId: "coverage-hydration-scheduled-negotiated-session",
      deviceId: "coverage-hydration-scheduled-negotiated-device",
    };
    const advertisedOnly = {
      studentId: "coverage-hydration-scheduled-advertised",
      studentSessionId: "coverage-hydration-scheduled-advertised-session",
      deviceId: "coverage-hydration-scheduled-advertised-device",
    };
    for (const [target, acceptedCapabilities] of [
      [negotiated, ["scopedAuthorityChecksV1", "scheduledClassroomV1", "focusTabV1"]],
      [advertisedOnly, []],
    ] as const) {
      const write = await writeClasspilotRealtimeStatus({
        schoolId,
        ...target,
        heartbeatId: `${target.studentId}-heartbeat`,
        observedAt: now,
        trackingStatus: "ACTIVE",
        extensionCapabilities: ["scopedAuthorityChecksV1", "scheduledClassroomV1", "focusTabV1"],
        acceptedCapabilities: [...acceptedCapabilities],
        tabSnapshotRevision: 7,
        allOpenTabs: [{ tabRef: "coverage-exact-tab", title: "Example", url: "https://example.test/", active: true }],
      });
      assert.ok(write.snapshot);
    }

    const result = await hydrateClasspilotCoverageStatuses({
      schoolId,
      studentIds: [negotiated.studentId, advertisedOnly.studentId],
      knownSessions: [negotiated, advertisedOnly].map((target) => ({
        id: target.studentSessionId,
        studentId: target.studentId,
        deviceId: target.deviceId,
        lastSeenAt: new Date(now),
      })),
      now,
    });

    const accepted = result.get(negotiated.studentId)?.acceptedCapabilities;
    assert.equal(accepted?.scheduledClassroomV1, true);
    assert.equal(accepted?.scopedAuthorityChecksV1, true);
    assert.equal(accepted?.focusTabV1, true);
    assert.equal(result.get(negotiated.studentId)?.tabSnapshotRevision, 7);
    assert.equal(result.get(negotiated.studentId)?.allOpenTabs[0]?.tabRef, "coverage-exact-tab");
    const advertised = result.get(advertisedOnly.studentId)?.acceptedCapabilities;
    assert.equal(advertised?.scheduledClassroomV1, false,
      "an advertisement alone must not read as negotiated");
    assert.equal(advertised?.scopedAuthorityChecksV1, false);
    assert.equal(advertised?.focusTabV1, false);
  });

  it("projects domain preservation from the raw extension advertisement", async () => {
    const now = Date.now();
    const schoolId = "coverage-hydration-domain-preservation-school";
    const studentId = "coverage-hydration-domain-preservation-student";
    const studentSessionId = "coverage-hydration-domain-preservation-session";
    const deviceId = "coverage-hydration-domain-preservation-device";
    const write = await writeClasspilotRealtimeStatus({
      schoolId,
      studentId,
      studentSessionId,
      deviceId,
      heartbeatId: "coverage-hydration-domain-preservation-heartbeat",
      observedAt: now,
      trackingStatus: "ACTIVE",
      extensionCapabilities: [
        "domainPreservingRestrictionsV1",
        "studentAuthGatePresenceV1",
        "lateSignInRestrictionSsoV1",
        "restrictionAuthPassThroughV1",
      ],
      acceptedCapabilities: [],
    });
    assert.ok(write.snapshot);

    const result = await hydrateClasspilotCoverageStatuses({
      schoolId,
      studentIds: [studentId],
      knownSessions: [{
        id: studentSessionId,
        studentId,
        deviceId,
        lastSeenAt: new Date(now),
      }],
      now,
    });

    assert.equal(
      result.get(studentId)?.capabilities.domainPreservingRestrictionsV1,
      true
    );
    assert.equal(result.get(studentId)?.capabilities.studentAuthGatePresenceV1, true);
    assert.equal(result.get(studentId)?.capabilities.lateSignInRestrictionSsoV1, true);
    assert.equal(result.get(studentId)?.capabilities.restrictionAuthPassThroughV1, true);
    assert.equal(
      result.get(studentId)?.acceptedCapabilities.restrictionAuthPassThroughV1,
      false,
      "raw advertisement must remain visible without implying server acceptance"
    );
    assert.equal(result.get(studentId)?.studentAuthGatePresenceV1Enabled, false);
    assert.equal(result.get(studentId)?.lateSignInRestrictionSsoV1Enabled, false);
  });

  it("projects current-tab identity only from the exact current binding and actual tab snapshot", async () => {
    const now = Date.now();
    const schoolId = "coverage-active-tab-school";
    const samples = [
      { studentId: "valid", activeTabRef: "exact-active-tab", tabSnapshotRevision: 7 },
      { studentId: "missing-ref", activeTabRef: undefined, tabSnapshotRevision: 7 },
      { studentId: "missing-revision", activeTabRef: "exact-active-tab", tabSnapshotRevision: undefined },
      { studentId: "outside-snapshot", activeTabRef: "unknown-tab", tabSnapshotRevision: 7 },
      { studentId: "replacement", activeTabRef: "exact-active-tab", tabSnapshotRevision: 7 },
      { studentId: "signed-out", activeTabRef: "exact-active-tab", tabSnapshotRevision: 7 },
    ];
    for (const sample of samples) {
      const written = await writeClasspilotRealtimeStatus({
        schoolId, ...sample, studentSessionId: `${sample.studentId}-session`,
        deviceId: `${sample.studentId}-device`, heartbeatId: `${sample.studentId}-heartbeat`,
        observedAt: now, trackingStatus: "ACTIVE", activeTabUrl: "https://example.test/",
        allOpenTabs: [
          { tabRef: "exact-active-tab", title: "Example", url: "https://example.test/" },
          { tabRef: "other-same-url", title: "Example", url: "https://example.test/", active: true },
        ],
      });
      assert.ok(written.snapshot);
      if (sample.studentId === "signed-out") await markClasspilotRealtimeSignedOut({
        schoolId, studentId: sample.studentId, studentSessionId: `${sample.studentId}-session`,
        deviceId: `${sample.studentId}-device`, observedAt: now + 1, reason: "explicit_sign_out",
      });
    }
    const result = await hydrateClasspilotCoverageStatuses({
      schoolId, studentIds: samples.map(sample => sample.studentId), now,
      knownSessions: samples.map(sample => ({
        id: sample.studentId === "replacement" ? "replacement-new-session" : `${sample.studentId}-session`,
        studentId: sample.studentId, deviceId: `${sample.studentId}-device`, lastSeenAt: new Date(now),
      })),
    });
    assert.equal(result.get("valid")?.activeTabRef, "exact-active-tab");
    for (const sample of samples.filter(sample => sample.studentId !== "valid")) {
      assert.equal(result.get(sample.studentId)?.activeTabRef, null, `${sample.studentId} cannot acquire a current-tab identity`);
    }
    assert.ok(result.get("missing-revision")?.tabSnapshotRevision, "legacy presentation keeps its realtime revision fallback");
    const serialized = JSON.stringify([...result.values()]);
    assert.equal(serialized.includes("studentSessionId"), false);
    assert.equal(serialized.includes("deviceId"), false);
  });

  it("retains Focus confirmation only for valid active exact-session bindings", async () => {
    const now = Date.now();
    const schoolId = "coverage-focus-status-school";
    const samples = [
      { studentId: "active", focus: { state: "active", assignmentId: "focus-a" }, signedOut: false },
      { studentId: "paused", focus: { state: "suspended", assignmentId: "focus-b", reason: "attention" }, signedOut: false },
      { studentId: "invalidated", focus: { state: "invalidated", assignmentId: "focus-c", reason: "focus_tab_closed" }, signedOut: false },
      { studentId: "malformed", focus: { state: "active", assignmentId: "focus-d", deviceId: "must-not-leak" }, signedOut: false },
      { studentId: "missing", focus: undefined, signedOut: false },
      { studentId: "signed-out", focus: { state: "active", assignmentId: "focus-e" }, signedOut: true },
      { studentId: "replacement", focus: { state: "active", assignmentId: "focus-f" }, signedOut: false },
    ] as const;
    for (const sample of samples) {
      const written = await writeClasspilotRealtimeStatus({
        schoolId, studentId: sample.studentId,
        studentSessionId: `${sample.studentId}-session`, deviceId: `${sample.studentId}-device`,
        heartbeatId: `${sample.studentId}-heartbeat`, observedAt: now,
        trackingStatus: "ACTIVE", focus: sample.focus,
      });
      assert.ok(written.snapshot);
      if (sample.signedOut) {
        const signedOut = await markClasspilotRealtimeSignedOut({
          schoolId, studentId: sample.studentId,
          studentSessionId: `${sample.studentId}-session`, deviceId: `${sample.studentId}-device`,
          observedAt: now + 1, reason: "explicit_sign_out",
        });
        assert.equal(signedOut.snapshot?.state, "signed_out");
      }
    }
    const result = await hydrateClasspilotCoverageStatuses({
      schoolId, studentIds: samples.map(sample => sample.studentId), now,
      knownSessions: samples.map(sample => ({
        id: sample.studentId === "replacement" ? "replacement-new-session" : `${sample.studentId}-session`,
        studentId: sample.studentId, deviceId: `${sample.studentId}-device`, lastSeenAt: new Date(now),
      })),
    });
    assert.deepEqual(result.get("active")?.focus, samples[0].focus);
    assert.deepEqual(result.get("paused")?.focus, samples[1].focus);
    assert.deepEqual(result.get("invalidated")?.focus, samples[2].focus);
    for (const studentId of ["malformed", "missing", "signed-out", "replacement"]) {
      assert.equal(result.get(studentId)?.focus, undefined, `${studentId} must not acquire Focus confirmation`);
    }
    const serialized = JSON.stringify([...result.values()]);
    assert.equal(serialized.includes("must-not-leak"), false);
    assert.equal(serialized.includes("studentSessionId"), false);
    assert.equal(serialized.includes("deviceId"), false);
  });
});
