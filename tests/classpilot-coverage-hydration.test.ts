import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hydrateClasspilotCoverageStatuses,
  snapshotClasspilotCoverageHydrationMetrics,
} from "../src/services/classpilotCoverageHydration.js";

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
});
