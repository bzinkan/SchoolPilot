import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classpilotCoverageSummaryRevision } from "../src/services/classpilotCoverageSummary.js";

describe("ClassPilot coverage summary", () => {
  it("is deterministic across query insertion order", () => {
    const first = classpilotCoverageSummaryRevision({
      availableStudentIds: ["student-b", "student-a"],
      claimedStudentIds: ["student-c", "student-c"],
      contexts: [
        { id: "context-b", updatedAt: "2026-08-22T12:00:00.000Z" },
        { id: "context-a", updatedAt: "2026-08-22T11:00:00.000Z" },
      ],
    });
    const reversed = classpilotCoverageSummaryRevision({
      availableStudentIds: ["student-a", "student-b"],
      claimedStudentIds: ["student-c"],
      contexts: [
        { id: "context-a", updatedAt: "2026-08-22T11:00:00.000Z" },
        { id: "context-b", updatedAt: "2026-08-22T12:00:00.000Z" },
      ],
    });
    assert.equal(first, reversed);
    assert.match(first, /^coverage-v1:[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(first, /student|context/);
  });
});
