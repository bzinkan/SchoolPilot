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
const { eq } = await import("drizzle-orm");

const {
  getHeartbeatTrackingSettingsForSchool,
  getSettingsForSchool,
  invalidateHeartbeatTrackingSettingsCache,
  upsertSettings,
} = storage;
const { schools, settings } = schema;

const tag = `heartbeat-settings-${Date.now()}-${randomUUID().slice(0, 8)}`;
let schoolAId = "";
let schoolBId = "";

const inSchool = <T>(schoolId: string, fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ schoolId }, fn);

before(async () => {
  const [schoolA, schoolB] = await Promise.all([
    storage.createSchool({
      name: `${tag} A`,
      domain: `${tag}-a.example.edu`,
      slug: `${tag}-a`,
      status: "active",
      planStatus: "active",
    } as any),
    storage.createSchool({
      name: `${tag} B`,
      domain: `${tag}-b.example.edu`,
      slug: `${tag}-b`,
      status: "active",
      planStatus: "active",
    } as any),
  ]);
  schoolAId = schoolA.id;
  schoolBId = schoolB.id;

  await inSchool(schoolAId, () =>
    upsertSettings(schoolAId, {
      schoolName: `${tag} A`,
      wsSharedKey: "fixture-a",
      enableTrackingHours: true,
      trackingStartTime: "08:00",
      trackingEndTime: "15:00",
      trackingDays: ["Monday", "Tuesday"],
      schoolTimezone: "America/New_York",
      afterHoursMode: "off",
      enrollmentKey: "fixture-a",
      enrollmentKeyRequired: true,
      blockedDomains: ["blocked.example.invalid"],
    })
  );
  await inSchool(schoolBId, () =>
    upsertSettings(schoolBId, {
      schoolName: `${tag} B`,
      wsSharedKey: "fixture-b",
      enableTrackingHours: false,
      trackingStartTime: "07:30",
      trackingEndTime: "14:30",
      trackingDays: ["Wednesday"],
      schoolTimezone: "America/Chicago",
      afterHoursMode: "limited",
    })
  );
});

after(async () => {
  try {
    invalidateHeartbeatTrackingSettingsCache(schoolAId);
    invalidateHeartbeatTrackingSettingsCache(schoolBId);
    await runWithTenantContext({ isSuper: true }, async () => {
      if (schoolAId) {
        await db.delete(settings).where(eq(settings.schoolId, schoolAId));
        await db.delete(schools).where(eq(schools.id, schoolAId));
      }
      if (schoolBId) {
        await db.delete(settings).where(eq(settings.schoolId, schoolBId));
        await db.delete(schools).where(eq(schools.id, schoolBId));
      }
    });
  } finally {
    await Promise.allSettled([pool.end(), sessionPool.end()]);
  }
});

describe("heartbeat tracking settings cache", () => {
  it("caches only the narrow non-secret tracking projection used by heartbeats", async () => {
    const projected = await inSchool(schoolAId, () =>
      getHeartbeatTrackingSettingsForSchool(schoolAId)
    );
    assert.ok(projected);
    assert.deepEqual(Object.keys(projected).sort(), [
      "afterHoursMode",
      "enableTrackingHours",
      "schoolTimezone",
      "trackingDays",
      "trackingEndTime",
      "trackingStartTime",
    ]);
    assert.equal("enrollmentKey" in projected, false);
    assert.equal("blockedDomains" in projected, false);

    const storageSource = readFileSync(
      new URL("../src/services/storage.ts", import.meta.url),
      "utf8"
    );
    const typeStart = storageSource.indexOf(
      "export type HeartbeatTrackingSettings"
    );
    const cacheStart = storageSource.indexOf(
      "const heartbeatTrackingSettingsCache",
      typeStart
    );
    assert.ok(typeStart >= 0 && cacheStart > typeStart);
    const projectionType = storageSource.slice(typeStart, cacheStart);
    assert.doesNotMatch(
      projectionType,
      /enrollmentKey|autoEnrollStudents|blockedDomains|allowedDomains|wsSharedKey/
    );
    assert.match(
      storageSource,
      /HEARTBEAT_TRACKING_SETTINGS_CACHE_TTL_MS\s*=\s*5_000/
    );
    assert.match(storageSource, /heartbeatTrackingSettingsLoads/);
    assert.match(
      storageSource,
      /const loading = heartbeatTrackingSettingsLoads\.get\(schoolId\);[\s\S]*?if \(loading\) return loading;/
    );
    assert.match(storageSource, /heartbeatTrackingSettingsGenerations/);
    assert.match(storageSource, /registerCacheInvalidationHandler/);
    assert.match(storageSource, /publishCacheInvalidation/);
    assert.doesNotMatch(
      storageSource,
      /from\s+["']\.\.\/realtime\/ws-redis\.js["']/
    );
    assert.match(
      storageSource,
      /kind: "cache-invalidation",[\s\S]*?cache: "heartbeat-tracking-settings"/
    );

    const routeSource = readFileSync(
      new URL("../src/routes/classpilot/devices.ts", import.meta.url),
      "utf8"
    );
    const routeStart = routeSource.indexOf('router.post("/device/heartbeat"');
    const routeEnd = routeSource.indexOf(
      'router.post("/device/screenshot"',
      routeStart
    );
    assert.ok(routeStart >= 0 && routeEnd > routeStart);
    const heartbeatRoute = routeSource.slice(routeStart, routeEnd);
    const databaseSectionStart = heartbeatRoute.indexOf(
      "const heartbeatDbResult = await runWithTenantContext"
    );
    const databaseSectionEnd = heartbeatRoute.indexOf(
      "if (heartbeatDbResult.outcome",
      databaseSectionStart
    );
    assert.ok(
      databaseSectionStart >= 0 && databaseSectionEnd > databaseSectionStart
    );
    const databaseSection = heartbeatRoute.slice(
      databaseSectionStart,
      databaseSectionEnd
    );
    assert.match(
      databaseSection,
      /getHeartbeatTrackingSettingsForSchool\(schoolId\)/
    );
    assert.doesNotMatch(databaseSection, /getSettingsForSchool\(schoolId\)/);
  });

  it("invalidates local writes and never reuses one tenant's cached row in another tenant context", async () => {
    invalidateHeartbeatTrackingSettingsCache(schoolAId);
    const initial = await inSchool(schoolAId, () =>
      getHeartbeatTrackingSettingsForSchool(schoolAId)
    );
    assert.equal(initial?.trackingStartTime, "08:00");

    // Bypass the storage mutator to prove the cache is actually populated.
    await inSchool(schoolAId, () =>
      db
        .update(settings)
        .set({ trackingStartTime: "09:15" })
        .where(eq(settings.schoolId, schoolAId))
    );
    const stillCached = await inSchool(schoolAId, () =>
      getHeartbeatTrackingSettingsForSchool(schoolAId)
    );
    assert.equal(stillCached?.trackingStartTime, "08:00");

    // With RLS binding enabled, a mismatched tenant is not allowed to consume
    // school A's in-process cached value. Depending on whether the test role has
    // RLS policies enabled, its direct query either sees the fresh row or none.
    const fromTenantB = await inSchool(schoolBId, () =>
      getHeartbeatTrackingSettingsForSchool(schoolAId)
    );
    assert.notEqual(fromTenantB?.trackingStartTime, "08:00");

    invalidateHeartbeatTrackingSettingsCache(schoolAId);
    const manuallyInvalidated = await inSchool(schoolAId, () =>
      getHeartbeatTrackingSettingsForSchool(schoolAId)
    );
    assert.equal(manuallyInvalidated?.trackingStartTime, "09:15");

    await inSchool(schoolAId, () =>
      upsertSettings(schoolAId, { trackingStartTime: "10:30" })
    );
    const afterStorageWrite = await inSchool(schoolAId, () =>
      getHeartbeatTrackingSettingsForSchool(schoolAId)
    );
    assert.equal(afterStorageWrite?.trackingStartTime, "10:30");
  });

  it("never caches the full settings row or stale enrollment controls", async () => {
    const before = await inSchool(schoolAId, () =>
      getSettingsForSchool(schoolAId)
    );
    assert.equal(before?.enrollmentKey, "fixture-a");

    await inSchool(schoolAId, () =>
      db
        .update(settings)
        .set({ enrollmentKey: "fixture-a-rotated" })
        .where(eq(settings.schoolId, schoolAId))
    );

    const after = await inSchool(schoolAId, () =>
      getSettingsForSchool(schoolAId)
    );
    assert.equal(after?.enrollmentKey, "fixture-a-rotated");
  });
});
