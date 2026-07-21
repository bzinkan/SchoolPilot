import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const { createHeartbeatTileCache } = await import(
  "../src/services/heartbeatTileCache.ts"
);

function cachedHeartbeat(
  index: number,
  studentId: string,
  overrides: Record<string, unknown> = {}
) {
  return JSON.stringify({
    id: `heartbeat-${studentId}-${index}`,
    deviceId: "device-shared",
    studentId,
    studentEmail: `${studentId}@example.invalid`,
    schoolId: "school-a",
    activeTabTitle: `Tab ${index}`,
    activeTabUrl: `https://example.invalid/${index}`,
    favicon: null,
    screenLocked: false,
    flightPathActive: false,
    activeFlightPathName: null,
    isSharing: false,
    cameraActive: false,
    aiCategory: null,
    safetyAlert: null,
    extensionVersion: "2.5.7",
    chromeVersion: "145",
    screenshotHealth: null,
    timestamp: new Date(Date.now() - index * 1_000),
    classificationPending: false,
    ...overrides,
  });
}

async function readStudent(rows: string[]) {
  const commands: string[][] = [];
  const cache = createHeartbeatTileCache(async (args) => {
    commands.push(args);
    return [rows];
  });
  const result = await cache.readBatch(
    "school-a",
    [{ studentId: "student-a", deviceId: "device-shared" }],
    10
  );
  return { commands, result: result.get("student-a") };
}

describe("heartbeat tile cache batch qualification", () => {
  it("ignores pending classifications belonging to another student on a shared device", async () => {
    const rows = [
      cachedHeartbeat(0, "student-b", { classificationPending: true }),
      ...Array.from({ length: 10 }, (_, index) =>
        cachedHeartbeat(index, "student-a")
      ),
    ];

    const { commands, result } = await readStudent(rows);
    assert.equal(commands.length, 1);
    assert.equal(result?.status, "hit");
    if (result?.status === "hit") {
      assert.equal(result.heartbeats.length, 10);
      assert.ok(result.heartbeats.every((row) => row.studentId === "student-a"));
    }
  });

  it("ignores pending classifications beyond the returned ten requested-student rows", async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, index) =>
        cachedHeartbeat(index, "student-a")
      ),
      cachedHeartbeat(10, "student-a", { classificationPending: true }),
    ];

    const { commands, result } = await readStudent(rows);
    assert.equal(commands.length, 1);
    assert.equal(result?.status, "hit");
    if (result?.status === "hit") {
      assert.equal(result.heartbeats.length, 10);
      assert.ok(result.heartbeats.every((row) => row.id !== "heartbeat-student-a-10"));
    }
  });

  it("falls back when a selected row is pending", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      cachedHeartbeat(index, "student-a", {
        classificationPending: index === 9,
      })
    );

    const { commands, result } = await readStudent(rows);
    assert.equal(commands.length, 1);
    assert.equal(result?.status, "incomplete");
  });

  it("falls back for insufficient requested-student history or corrupt cache data", async () => {
    const insufficient = await readStudent([
      ...Array.from({ length: 9 }, (_, index) =>
        cachedHeartbeat(index, "student-a")
      ),
      ...Array.from({ length: 11 }, (_, index) =>
        cachedHeartbeat(index, "student-b")
      ),
    ]);
    assert.equal(insufficient.commands.length, 1);
    assert.equal(insufficient.result?.status, "authorization-filtered");

    const corrupt = await readStudent([
      ...Array.from({ length: 10 }, (_, index) =>
        cachedHeartbeat(index, "student-a")
      ),
      "{not-json",
    ]);
    assert.equal(corrupt.commands.length, 1);
    assert.equal(corrupt.result?.status, "incomplete");
  });

  it("falls back for Redis unavailability without issuing another operation", async () => {
    let commandCount = 0;
    const cache = createHeartbeatTileCache(async () => {
      commandCount += 1;
      throw new Error("synthetic Redis outage");
    });

    const results = await cache.readBatch(
      "school-a",
      [{ studentId: "student-a", deviceId: "device-shared" }],
      10
    );
    assert.equal(commandCount, 1);
    assert.equal(results.get("student-a")?.status, "unavailable");
  });
});
