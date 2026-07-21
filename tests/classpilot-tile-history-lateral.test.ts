import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";

const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: any[]) => {
  const timer = (originalSetInterval as any)(...args);
  timer.unref?.();
  return timer;
}) as typeof setInterval;

const { default: db, pool, sessionPool } = await import("../dist/db.js");
const { runWithTenantContext } = await import(
  "../dist/middleware/tenantContext.js"
);
const storage = await import("../dist/services/storage.js");
const schema = await import("../dist/schema/index.js");
const { eq, like } = await import("drizzle-orm");
const { PgDialect } = await import("drizzle-orm/pg-core");

const {
  buildHeartbeatTileHistoryBatchQuery,
  createSchool,
  getHeartbeatTileHistoryBatch,
} = storage;
const { heartbeats, schools } = schema;

const tag = `tile-history-lateral-${Date.now()}-${randomUUID().slice(0, 8)}`;
const cohortSize = 40;
const retainedPerStudent = 16;
const historyLimit = 10;
const baseTimestamp = new Date("2026-07-20T12:00:00.000Z");
const foreignSchoolId = `${tag}-foreign-school`;
let schoolId = "";

const accesses = Array.from({ length: cohortSize }, (_, index) => ({
  studentId: `${tag}-student-${String(index + 1).padStart(2, "0")}`,
  // Students one and two intentionally share a Chromebook. Exact student_id
  // matching must keep their histories isolated despite the shared device.
  deviceId: index < 2
    ? `${tag}-shared-device`
    : `${tag}-device-${String(index + 1).padStart(2, "0")}`,
  schoolId: "",
  studentSessionId: null,
}));

const inSchool = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ schoolId }, fn);

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ isSuper: true }, fn);

before(async () => {
  const school = await createSchool({
    name: tag,
    domain: `${tag}.example.edu`,
    slug: tag,
    status: "active",
    planStatus: "active",
  } as any);
  schoolId = school.id;
  for (const access of accesses) access.schoolId = schoolId;

  await inSchool(async () => {
    await db.insert(heartbeats).values(
      accesses.flatMap((access, studentIndex) =>
        Array.from({ length: retainedPerStudent }, (_, historyIndex) => ({
          id: `${tag}-hb-${studentIndex}-${historyIndex}`,
          schoolId,
          deviceId: access.deviceId,
          studentId: access.studentId,
          activeTabTitle: `student-${studentIndex}-history-${historyIndex}`,
          activeTabUrl: `https://example.invalid/${studentIndex}/${historyIndex}`,
          timestamp: new Date(baseTimestamp.getTime() - historyIndex * 1_000),
        }))
      )
    );

    await db.insert(heartbeats).values({
      id: `${tag}-hb-unrelated-shared-student`,
      schoolId,
      deviceId: accesses[0]!.deviceId,
      studentId: `${tag}-unrequested-student`,
      activeTabTitle: "unrelated shared-device heartbeat",
      timestamp: new Date(baseTimestamp.getTime() + 60_000),
    });
  });

  // This future row has the exact requested device/student identifiers but a
  // foreign school. The fallback's explicit school predicate excludes it;
  // the request-path RLS denial is exercised in classpilot-tile-read-scope.
  await asSystem(async () => {
    await db.insert(heartbeats).values({
      id: `${tag}-hb-foreign-school`,
      schoolId: foreignSchoolId,
      deviceId: accesses[0]!.deviceId,
      studentId: accesses[0]!.studentId,
      activeTabTitle: "foreign-school heartbeat",
      timestamp: new Date(baseTimestamp.getTime() + 120_000),
    });
  });
});

after(async () => {
  try {
    await asSystem(async () => {
      await db.delete(heartbeats).where(like(heartbeats.id, `${tag}-%`));
      if (schoolId) {
        await db.delete(schools).where(eq(schools.id, schoolId));
      }
    });
  } finally {
    await Promise.allSettled([pool.end(), sessionPool.end()]);
  }
});

describe("ClassPilot cold tile-history fallback", () => {
  it("builds one exact, index-bounded lateral statement for forty pairs", () => {
    const compiled = new PgDialect().sqlToQuery(
      buildHeartbeatTileHistoryBatchQuery(schoolId, accesses, historyLimit)
    );
    const normalized = compiled.sql.replace(/\s+/g, " ").trim();

    assert.match(normalized, /^with "requested_tiles"|^with requested_tiles/i);
    assert.match(
      normalized,
      /from unnest\(\s*\$\d+::text\[\], \$\d+::text\[\]\s*\)/i
    );
    assert.match(normalized, /cross join lateral \(/i);
    assert.match(normalized, /where heartbeat\.school_id = \$/i);
    assert.match(normalized, /heartbeat\.device_id = requested\.device_id/i);
    assert.match(normalized, /heartbeat\.student_id = requested\.student_id/i);
    assert.match(
      normalized,
      /order by heartbeat\.timestamp desc limit \$/i
    );
    assert.match(
      normalized,
      /order by requested\.ordinal, heartbeat\.timestamp desc$/i
    );
    assert.doesNotMatch(normalized, /row_number|windowagg|history_rank/i);
    assert.equal((normalized.match(/cross join lateral/gi) ?? []).length, 1);

    assert.deepEqual(compiled.params[0], accesses.map((access) => access.studentId));
    assert.deepEqual(compiled.params[1], accesses.map((access) => access.deviceId));
    assert.ok(compiled.params.includes(schoolId));
    assert.ok(compiled.params.includes(historyLimit));

    const performanceInsightsTokenWindow = normalized.slice(0, 500).toLowerCase();
    for (const marker of ["requested_tiles", "lateral", "heartbeats"]) {
      assert.ok(
        performanceInsightsTokenWindow.includes(marker),
        `${marker} must remain in the tokenized SQL prefix used by diagnostic PI classification`
      );
    }
  });

  it("returns only each student's newest ten rows in one SQL execution", async () => {
    const source = readFileSync(
      new URL("../src/services/storage.ts", import.meta.url),
      "utf8"
    );
    const start = source.indexOf(
      "export async function getHeartbeatTileHistoryBatch("
    );
    const end = source.indexOf(
      "export async function getHeartbeatsByDeviceInRange(",
      start
    );
    assert.ok(start >= 0 && end > start);
    const functionSource = source.slice(start, end);
    assert.equal(
      functionSource.match(/\bdb\.execute\s*\(/g)?.length,
      1,
      "a fallback cohort must execute exactly one SQL statement"
    );

    const result = await inSchool(() =>
      getHeartbeatTileHistoryBatch(schoolId, accesses, historyLimit)
    );

    assert.equal(result.size, cohortSize);
    assert.equal(
      [...result.values()].reduce((total, rows) => total + rows.length, 0),
      cohortSize * historyLimit
    );
    assert.deepEqual([...result.keys()], accesses.map((access) => access.studentId));

    for (const [studentIndex, access] of accesses.entries()) {
      const rows = result.get(access.studentId);
      assert.ok(rows);
      assert.equal(rows.length, historyLimit);
      assert.deepEqual(
        rows.map((row: { activeTabTitle: string }) => row.activeTabTitle),
        Array.from(
          { length: historyLimit },
          (_, historyIndex) => `student-${studentIndex}-history-${historyIndex}`
        )
      );
      assert.ok(rows.every(
        (row: { schoolId: string | null; studentId: string | null; deviceId: string }) =>
          row.schoolId === schoolId &&
          row.studentId === access.studentId &&
          row.deviceId === access.deviceId
      ));
    }

    assert.equal(
      [...result.values()].flat().some(
        (row: { activeTabTitle: string }) =>
          row.activeTabTitle.includes("unrelated") ||
          row.activeTabTitle.includes("foreign-school")
      ),
      false
    );
  });

  it("preserves empty-history and empty-cohort behavior", async () => {
    const missing = {
      studentId: `${tag}-missing-student`,
      deviceId: `${tag}-missing-device`,
      schoolId,
      studentSessionId: null,
    };
    const missingResult = await inSchool(() =>
      getHeartbeatTileHistoryBatch(schoolId, [missing], historyLimit)
    );
    assert.deepEqual([...missingResult.entries()], []);

    const emptyResult = await inSchool(() =>
      getHeartbeatTileHistoryBatch(schoolId, [], historyLimit)
    );
    assert.deepEqual([...emptyResult.entries()], []);
  });

});
