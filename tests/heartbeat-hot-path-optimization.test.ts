import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.REDIS_URL = "";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const classificationModule = await import(
  "../src/services/heartbeatClassificationBatcher.ts"
);
const authorizationModule = await import(
  "../src/services/classpilotTileAuthorization.ts"
);
const tileCacheModule = await import(
  "../src/services/heartbeatTileCache.ts"
);
const screenshotModule = await import(
  "../src/realtime/ws-redis.ts"
);

const {
  HEARTBEAT_CLASSIFICATION_BATCH_MAX_ROWS,
  HeartbeatClassificationBatcher,
  flushHeartbeatClassificationProducers,
  trackHeartbeatClassificationProducer,
} = classificationModule;
const { createClassPilotTileAuthorizationCoalescer } = authorizationModule;
const {
  HEARTBEAT_TILE_CACHE_MAX_RECORDS,
  HEARTBEAT_TILE_CACHE_TTL_SECONDS,
  createHeartbeatTileCache,
} = tileCacheModule;
const { decodeScreenshotData } = screenshotModule;

function classificationEntry(index: number, overrides: Record<string, unknown> = {}) {
  return {
    schoolId: "school-a",
    deviceId: `device-${index}`,
    heartbeatId: `heartbeat-${index}`,
    aiCategory: "educational",
    safetyAlert: null,
    ...overrides,
  } as any;
}

function cachedHeartbeat(index: number, studentId = "student-a") {
  return {
    id: `heartbeat-${index}`,
    deviceId: "device-a",
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
  };
}

describe("screenshot authority binding", () => {
  it("preserves current student/session bindings and rejects stale or corrupt data", () => {
    const current = decodeScreenshotData({
      screenshot: "data:image/jpeg;base64,Y3VycmVudA==",
      timestamp: Date.now(),
      studentId: "student-a",
      studentSessionId: "session-a",
    });
    assert.equal(current?.studentId, "student-a");
    assert.equal(current?.studentSessionId, "session-a");

    assert.equal(decodeScreenshotData({
      screenshot: "data:image/jpeg;base64,c3RhbGU=",
      timestamp: Date.now() - 121_000,
      studentId: "student-a",
      studentSessionId: "session-a",
    }), null);
    assert.equal(decodeScreenshotData("{not-json"), null);
    assert.equal(decodeScreenshotData({ timestamp: Date.now() }), null);
  });
});

describe("heartbeat classification batching", () => {
  it("persists critical classifications immediately and bounds school batches to 100", async () => {
    const immediate: string[] = [];
    const batches: string[][] = [];
    const patched: string[] = [];
    const batcher = new HeartbeatClassificationBatcher({
      async persistImmediate(entry) {
        immediate.push(entry.heartbeatId);
      },
      async persistBatch(_schoolId, entries) {
        batches.push(entries.map((entry) => entry.heartbeatId));
      },
      async patchCache(entries) {
        patched.push(...entries.map((entry) => entry.heartbeatId));
        return true;
      },
    });

    await batcher.persist(
      classificationEntry(0, { aiCategory: "non-educational" })
    );
    await batcher.persist(
      classificationEntry(1, { safetyAlert: "violence" })
    );
    await Promise.all(
      Array.from({ length: 105 }, (_, index) =>
        batcher.persist(classificationEntry(index + 10))
      )
    );
    await batcher.flushAll();

    assert.deepEqual(immediate, ["heartbeat-0", "heartbeat-1"]);
    assert.deepEqual(
      batches.map((batch) => batch.length),
      [HEARTBEAT_CLASSIFICATION_BATCH_MAX_ROWS, 5]
    );
    assert.equal(new Set(patched).size, 107);
  });

  it("flushes within the 250 ms window and retries a failed batch safely", async () => {
    let attempts = 0;
    const batcher = new HeartbeatClassificationBatcher({
      async persistImmediate() {},
      async persistBatch() {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic retry");
      },
      async patchCache() {
        return true;
      },
    });

    await batcher.persist(classificationEntry(200));
    await delay(380);
    await batcher.flushAll();
    assert.equal(attempts, 2);
  });

  it("waits for write-through completion and invalidates when a cache patch fails", async () => {
    const events: string[] = [];
    let finishWrite!: (value: boolean) => void;
    const cacheWrite = new Promise<boolean>((resolve) => {
      finishWrite = resolve;
    });
    const batcher = new HeartbeatClassificationBatcher({
      async persistImmediate() {
        events.push("persisted");
      },
      async persistBatch() {},
      async patchCache() {
        events.push("patched");
        return false;
      },
      async invalidateCache() {
        events.push("invalidated");
        return true;
      },
    });

    const persistence = batcher.persist(
      classificationEntry(300, {
        aiCategory: "non-educational",
        cacheWrite,
      })
    );
    await delay(0);
    assert.deepEqual(events, ["persisted"]);
    finishWrite(true);
    await persistence;
    assert.deepEqual(events, ["persisted", "patched", "invalidated"]);
  });

  it("retries immediate critical persistence before completing", async () => {
    let attempts = 0;
    const batcher = new HeartbeatClassificationBatcher({
      async persistImmediate() {
        attempts += 1;
        if (attempts < 3) throw new Error("synthetic critical retry");
      },
      async persistBatch() {},
      async patchCache() {
        return true;
      },
      async invalidateCache() {
        return true;
      },
    });
    await batcher.persist(
      classificationEntry(301, { aiCategory: "non-educational" })
    );
    assert.equal(attempts, 3);
  });

  it("drains immediate persistence already running and started during shutdown", async () => {
    const releases: Array<() => void> = [];
    let starts = 0;
    const batcher = new HeartbeatClassificationBatcher({
      async persistImmediate() {
        starts += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
      },
      async persistBatch() {},
      async patchCache() {
        return true;
      },
    });

    const first = batcher.persist(
      classificationEntry(400, { aiCategory: "non-educational" })
    );
    await delay(0);
    let flushed = false;
    const flush = batcher.flushAll().then(() => { flushed = true; });
    await delay(0);

    // Once shutdown starts, even an educational row bypasses batching and is
    // tracked as an immediate write that the same flush must await.
    const duringShutdown = batcher.persist(classificationEntry(401));
    await delay(0);
    assert.equal(starts, 2);
    assert.equal(flushed, false);

    releases.shift()!();
    await first;
    await delay(0);
    assert.equal(flushed, false);
    releases.shift()!();
    await duringShutdown;
    await flush;
    assert.equal(flushed, true);
  });

  it("waits for a detached classification producer before shutdown proceeds", async () => {
    let release!: () => void;
    const producer = trackHeartbeatClassificationProducer(
      new Promise<void>((resolve) => { release = resolve; })
    );
    let flushed = false;
    const flush = flushHeartbeatClassificationProducers()
      .then(() => { flushed = true; });
    await delay(0);
    assert.equal(flushed, false);
    release();
    await producer;
    await flush;
    assert.equal(flushed, true);

    const source = readFileSync(
      new URL("../src/services/heartbeatClassificationBatcher.ts", import.meta.url),
      "utf8"
    );
    const shutdown = source.slice(
      source.indexOf("export async function flushHeartbeatClassificationBatches"),
      source.length
    );
    assert.ok(
      shutdown.indexOf("flushHeartbeatClassificationProducers()") <
        shutdown.indexOf("defaultBatcher.flushAll")
    );
  });
});

describe("aligned tile authorization coalescing", () => {
  const request = {
    schoolId: "school-a",
    staffId: "teacher-a",
    role: "teacher" as const,
    isSuperAdmin: false,
    sessionScope: "session-a",
  };

  const authorizedScope = () =>
    new Map([
      [
        "device-0",
        {
          device: { deviceId: "device-0", schoolId: "school-a" },
          authorizedStudentIds: ["student-0"],
        },
      ],
    ]) as any;

  it("shares one in-flight scope load across 40 concurrent calls", async () => {
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await delay(10);
      return new Map(
        Array.from({ length: 40 }, (_, index) => [
          `device-${index}`,
          {
            device: { deviceId: `device-${index}`, schoolId: "school-a" },
            authorizedStudentIds: [`student-${index}`],
          },
        ])
      ) as any;
    };
    const coalescer = createClassPilotTileAuthorizationCoalescer(loader);

    const cohort = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        coalescer.authorize(request, `device-${index}`, "history")
      )
    );
    assert.equal(loads, 1);
    assert.equal(cohort.filter(Boolean).length, 40);
  });

  it("reloads a settled denial immediately so a new grant is visible", async () => {
    let loads = 0;
    let allowed = false;
    const coalescer = createClassPilotTileAuthorizationCoalescer(async () => {
      loads += 1;
      return allowed ? authorizedScope() : (new Map() as any);
    });

    assert.equal(
      await coalescer.authorize(request, "device-0", "history"),
      undefined
    );
    allowed = true;
    assert.ok(await coalescer.authorize(request, "device-0", "history"));
    assert.equal(loads, 2);
  });

  it("reloads a settled grant immediately so a revocation is visible", async () => {
    let loads = 0;
    let allowed = true;
    const coalescer = createClassPilotTileAuthorizationCoalescer(async () => {
      loads += 1;
      return allowed ? authorizedScope() : (new Map() as any);
    });

    assert.ok(await coalescer.authorize(request, "device-0", "history"));
    allowed = false;
    assert.equal(
      await coalescer.authorize(request, "device-0", "history"),
      undefined
    );
    assert.equal(loads, 2);
  });

  it("uses the two-second bound only to replace a still-pending load", async () => {
    let now = 1_000;
    let loads = 0;
    const releases: Array<(scope: any) => void> = [];
    const coalescer = createClassPilotTileAuthorizationCoalescer(
      async () => {
        loads += 1;
        return new Promise((resolve) => releases.push(resolve));
      },
      { now: () => now }
    );

    const first = coalescer.authorize(request, "device-0", "history");
    await Promise.resolve();
    assert.equal(loads, 1);

    now += 2_001;
    const replacement = coalescer.authorize(request, "device-0", "history");
    await Promise.resolve();
    assert.equal(loads, 2);

    releases[0]!(authorizedScope());
    assert.ok(await first);

    const coalescedReplacement = coalescer.authorize(
      request,
      "device-0",
      "history"
    );
    assert.equal(loads, 2);

    releases[1]!(authorizedScope());
    const [replacementAccess, coalescedAccess] = await Promise.all([
      replacement,
      coalescedReplacement,
    ]);
    assert.ok(replacementAccess);
    assert.ok(coalescedAccess);
  });
});

describe("authorized latest-history Redis cache", () => {
  it("reads a student cohort in one Redis operation and filters shared devices per student", async () => {
    const commands: string[][] = [];
    const studentARows = Array.from({ length: 10 }, (_, index) =>
      JSON.stringify(cachedHeartbeat(index, "student-a"))
    );
    const sharedRows = Array.from({ length: 20 }, (_, index) => {
      const row = cachedHeartbeat(
        index,
        index % 2 === 0 ? "student-b" : "student-c"
      );
      row.deviceId = "device-shared";
      return JSON.stringify(row);
    });
    const cache = createHeartbeatTileCache(async (args) => {
      commands.push(args);
      return [studentARows, sharedRows];
    });

    const results = await cache.readBatch(
      "school-a",
      [
        { studentId: "student-a", deviceId: "device-a" },
        { studentId: "student-b", deviceId: "device-shared" },
      ],
      10
    );
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.[0], "EVAL");
    assert.equal(commands[0]?.[2], "2");
    const studentA = results.get("student-a");
    const studentB = results.get("student-b");
    assert.equal(studentA?.status, "hit");
    assert.equal(studentB?.status, "hit");
    if (studentA?.status === "hit") {
      assert.ok(studentA.heartbeats.every((row) => row.studentId === "student-a"));
    }
    if (studentB?.status === "hit") {
      assert.ok(studentB.heartbeats.every((row) => row.studentId === "student-b"));
    }

    let outageCommands = 0;
    const unavailable = createHeartbeatTileCache(async () => {
      outageCommands += 1;
      throw new Error("synthetic batch Redis outage");
    });
    const outage = await unavailable.readBatch(
      "school-a",
      [
        { studentId: "student-a", deviceId: "device-a" },
        { studentId: "student-b", deviceId: "device-shared" },
      ],
      10
    );
    assert.equal(outageCommands, 1);
    assert.equal(outage.get("student-a")?.status, "unavailable");
    assert.equal(outage.get("student-b")?.status, "unavailable");
  });

  it("writes a school/device-scoped bounded key with the 15-minute TTL", async () => {
    const commands: string[][] = [];
    const cache = createHeartbeatTileCache(async (args) => {
      commands.push(args);
      return 1;
    });
    assert.equal(await cache.write(cachedHeartbeat(0) as any), true);
    const command = commands[0]!;
    assert.equal(command[0], "EVAL");
    assert.equal(command[2], "1");
    assert.equal(command.at(-2), String(HEARTBEAT_TILE_CACHE_MAX_RECORDS));
    assert.equal(command.at(-1), String(HEARTBEAT_TILE_CACHE_TTL_SECONDS));
    assert.doesNotMatch(command[3]!, /school-a|device-a/);
  });

  it("authorizes every cached row and falls back on incomplete or corrupt data", async () => {
    const completeRows = Array.from(
      { length: 20 },
      (_, index) => JSON.stringify(cachedHeartbeat(index, index % 2 ? "student-b" : "student-a"))
    );
    const cache = createHeartbeatTileCache(async () => completeRows);

    const authorized = await cache.read("school-a", "device-a", ["student-a"]);
    assert.equal(authorized.status, "hit");
    if (authorized.status === "hit") {
      assert.equal(authorized.heartbeats.length, 10);
      assert.ok(authorized.heartbeats.every((row) => row.studentId === "student-a"));
    }

    const tooNarrow = await cache.read("school-a", "device-a", ["student-b-missing"]);
    assert.equal(tooNarrow.status, "authorization-filtered");

    const pendingRows = completeRows.map((row, index) => {
      const parsed = JSON.parse(row);
      if (index === 0) parsed.classificationPending = true;
      return JSON.stringify(parsed);
    });
    const pending = createHeartbeatTileCache(async () => pendingRows);
    assert.equal(
      (await pending.read("school-a", "device-a", null)).status,
      "incomplete"
    );

    const incomplete = createHeartbeatTileCache(async () => completeRows.slice(0, 9));
    assert.equal(
      (await incomplete.read("school-a", "device-a", null)).status,
      "incomplete"
    );

    const crossSchool = createHeartbeatTileCache(async () => completeRows);
    assert.equal(
      (await crossSchool.read("school-b", "device-a", null)).status,
      "incomplete"
    );

    const unavailable = createHeartbeatTileCache(async () => {
      throw new Error("synthetic Redis outage");
    });
    assert.equal(
      (await unavailable.read("school-a", "device-a", null)).status,
      "unavailable"
    );
  });

  it("can delete affected keys when classification patching is unavailable", async () => {
    const commands: string[][] = [];
    const cache = createHeartbeatTileCache(async (args) => {
      commands.push(args);
      return args[0] === "DEL" ? 1 : undefined;
    });
    const patch = {
      schoolId: "school-a",
      deviceId: "device-a",
      heartbeatId: "heartbeat-a",
      aiCategory: "non-educational",
      safetyAlert: "violence",
    };
    const patched = await cache.patchClassifications([patch]);
    assert.equal(patched, false);
    assert.equal(await cache.invalidate([patch]), true);
    assert.equal(commands.at(-1)?.[0], "DEL");
    assert.doesNotMatch(commands.at(-1)?.[1] ?? "", /school-a|device-a/);
  });

  it("fails closed when a write misses an existing cache and when a patch matches no row", async () => {
    let rows = Array.from(
      { length: 20 },
      (_, index) => JSON.stringify(cachedHeartbeat(index))
    );
    const cache = createHeartbeatTileCache(async (args) => {
      if (args[0] === "EVAL" && args[1]?.includes("LPUSH")) {
        // Transient write failure leaves an older, otherwise complete list.
        return undefined;
      }
      if (args[0] === "EVAL" && args[1]?.includes("local matched")) {
        return 0;
      }
      if (args[0] === "DEL") {
        rows = [];
        return 1;
      }
      if (args[0] === "LRANGE") return rows;
      return undefined;
    });

    const heartbeat = cachedHeartbeat(99) as any;
    assert.equal(await cache.write(heartbeat), false);
    assert.equal(await cache.invalidate([heartbeat]), true);
    assert.equal((await cache.read("school-a", "device-a", null)).status, "miss");

    const patch = {
      schoolId: "school-a",
      deviceId: "device-a",
      heartbeatId: "heartbeat-missing",
      aiCategory: "educational",
      safetyAlert: null,
    };
    assert.equal(await cache.patchClassifications([patch]), false);
  });
});

describe("heartbeat authority and lifecycle wiring", () => {
  it("uses cryptographic middleware and leaves active-session authority to the CTE", () => {
    const routeSource = readFileSync(
      new URL("../src/routes/classpilot/devices.ts", import.meta.url),
      "utf8"
    );
    const storageSource = readFileSync(
      new URL("../src/services/storage.ts", import.meta.url),
      "utf8"
    );
    const routeStart = routeSource.indexOf('router.post("/device/heartbeat"');
    const routeEnd = routeSource.indexOf(
      'router.post("/device/screenshot"',
      routeStart
    );
    assert.ok(routeStart >= 0 && routeEnd > routeStart);
    const route = routeSource.slice(routeStart, routeEnd);
    assert.match(route, /requireCryptographicDeviceAuth/);
    assert.doesNotMatch(route, /activeStudentSession/);
    assert.match(route, /error: "student_session_replaced"/);
    assert.match(route, /error: "Student session is no longer active"/);
    assert.match(route, /await heartbeatTileCacheWrite/);
    assert.match(route, /void invalidateHeartbeatTileCaches\(\[\{ schoolId, deviceId \}\]\)/);
    assert.match(storageSource, /student\.email AS student_email/);
    assert.match(storageSource, /eligible_session\.student_email/);
    assert.match(storageSource, /FOR UPDATE OF represented/);
    assert.match(storageSource, /row\.student_email \|\| ""/);
  });

  it("flushes classification batches before database pools close", () => {
    const indexSource = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8"
    );
    const fatalStart = indexSource.indexOf("async function fatalShutdown");
    const fatalEnd = indexSource.indexOf("async function gracefulShutdown", fatalStart);
    const fatal = indexSource.slice(fatalStart, fatalEnd);
    assert.ok(
      fatal.indexOf("flushHeartbeatClassificationWrites()") <
        fatal.indexOf("pool.end()")
    );
    const gracefulStart = fatalEnd;
    const gracefulEnd = indexSource.indexOf("// ---------------------------------------------------------------------------", gracefulStart);
    const graceful = indexSource.slice(gracefulStart, gracefulEnd);
    assert.ok(
      graceful.indexOf("flushHeartbeatClassificationWrites()") <
        graceful.indexOf("pool.end()")
    );
    assert.equal((indexSource.match(/\}, 15_000\);/g) ?? []).length, 2);
  });
});
