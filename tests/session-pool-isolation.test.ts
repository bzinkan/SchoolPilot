import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import session, { type SessionData } from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Pool } from "pg";
import {
  databasePoolIdleTimeouts,
  databasePoolLimits,
  maximumLaunchDatabaseConnections,
} from "../src/config/databasePools.js";

const root = resolve(import.meta.dirname, "..");
const PgStore = connectPgSimple(session);

function invokeStore(
  operation: (callback: (error?: unknown) => void) => void
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    operation((error?: unknown) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

describe("PostgreSQL session-pool isolation", () => {
  it("keeps session I/O off the request-bound RLS pool within the launch connection ceiling", () => {
    const dbSource = readFileSync(resolve(root, "src/db.ts"), "utf8");
    const appSource = readFileSync(resolve(root, "src/app.ts"), "utf8");

    assert.equal(maximumLaunchDatabaseConnections(), 148);
    assert.ok(maximumLaunchDatabaseConnections() < 150);
    assert.deepEqual(databasePoolLimits({
      SCHEDULER_ENABLED: "false",
      DB_POOL_MAX: "999",
      SESSION_DB_POOL_MAX: "999",
      SCHEDULER_DB_POOL_MAX: "999",
      SCHEDULER_LOCK_POOL_MAX: "999",
    }), {
      role: "api",
      main: 18,
      session: 2,
      scheduler: 1,
      schedulerLock: 1,
    });
    assert.deepEqual(databasePoolLimits({
      SCHEDULER_ENABLED: "true",
      DB_POOL_MAX: "999",
      SESSION_DB_POOL_MAX: "999",
      SCHEDULER_DB_POOL_MAX: "999",
      SCHEDULER_LOCK_POOL_MAX: "999",
    }), {
      role: "worker",
      main: 2,
      session: 1,
      scheduler: 5,
      schedulerLock: 8,
    });
    assert.equal(databasePoolLimits({ SCHEDULER_ENABLED: "0" }).role, "api");
    assert.equal(databasePoolLimits({ SCHEDULER_ENABLED: "FALSE" }).role, "api");
    assert.deepEqual(databasePoolLimits({
      SCHEDULER_ENABLED: "false",
      DB_POOL_MAX: "0",
      SESSION_DB_POOL_MAX: "-1",
      SCHEDULER_DB_POOL_MAX: "0",
      SCHEDULER_LOCK_POOL_MAX: "-8",
    }), {
      role: "api",
      main: 18,
      session: 2,
      scheduler: 1,
      schedulerLock: 1,
    });
    assert.deepEqual(databasePoolIdleTimeouts({ SCHEDULER_ENABLED: "false" }), {
      main: 75_000,
      session: 10_000,
    });
    assert.deepEqual(databasePoolIdleTimeouts({ SCHEDULER_ENABLED: "true" }), {
      main: 10_000,
      session: 10_000,
    });
    assert.ok(
      databasePoolIdleTimeouts({ SCHEDULER_ENABLED: "false" }).main > 30_000
    );
    assert.match(appSource, /pool:\s*sessionPool as any/);
    assert.match(appSource, /disableTouch:\s*true/);
    assert.doesNotMatch(appSource, /new PgStore\(\{[\s\S]{0,200}pool:\s*pool as any/);
    assert.match(dbSource, /idleTimeoutMillis:\s*poolIdleTimeouts\.main/);
    assert.match(dbSource, /idleTimeoutMillis:\s*poolIdleTimeouts\.session/);
  });

  it("disables expiry-only touches while preserving explicit session saves", async () => {
    const queries: string[] = [];
    const fakePool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ sid: "staff-session" }] };
      },
    } as unknown as Pool;
    const store = new PgStore({
      pool: fakePool,
      tableName: "session",
      createTableIfMissing: false,
      disableTouch: true,
      pruneSessionInterval: false,
    });
    const sessionData = {
      cookie: { maxAge: 60_000 },
      userId: "synthetic-teacher",
      role: "teacher",
    } as unknown as SessionData;

    await invokeStore((callback) =>
      store.touch("staff-session", sessionData, callback)
    );
    assert.deepEqual(queries, []);

    await invokeStore((callback) =>
      store.set("staff-session", sessionData, callback)
    );
    assert.equal(queries.length, 1);
    assert.match(queries[0], /^INSERT INTO "session"/);
    await store.close();
  });

  it("closes and exposes the isolated session pool with the other process pools", () => {
    const indexSource = readFileSync(resolve(root, "src/index.ts"), "utf8");
    const workerSource = readFileSync(resolve(root, "src/worker.ts"), "utf8");
    const healthSource = readFileSync(
      resolve(root, "src/services/healthMonitor.ts"),
      "utf8"
    );
    const dashboardSource = readFileSync(
      resolve(root, "src/services/monitoringDashboard.ts"),
      "utf8"
    );

    assert.match(indexSource, /pool\.end\(\),\s*sessionPool\.end\(\)/);
    assert.match(workerSource, /pool\.end\(\),\s*sessionPool\.end\(\)/);
    assert.match(healthSource, /sessionPool\.(waitingCount|totalCount)/);
    assert.match(dashboardSource, /sessionPool\.(waitingCount|totalCount)/);
  });

  it("sets both request RLS GUCs in one database round trip", () => {
    const tenantSource = readFileSync(resolve(root, "src/middleware/tenantContext.ts"), "utf8");
    assert.equal(
      tenantSource.match(/SELECT set_config\('app\.is_super',[\s\S]*?set_config\('app\.school_id'/g)?.length,
      2
    );
  });

  it("forwards async authorization failures through Express 4 error handling", () => {
    const contextSource = readFileSync(
      resolve(root, "src/middleware/requireSchoolContext.ts"),
      "utf8"
    );
    const activeSchoolSource = readFileSync(
      resolve(root, "src/middleware/requireActiveSchool.ts"),
      "utf8"
    );
    const licenseSource = readFileSync(
      resolve(root, "src/middleware/requireProductLicense.ts"),
      "utf8"
    );
    const roleSource = readFileSync(
      resolve(root, "src/middleware/requireRole.ts"),
      "utf8"
    );

    assert.match(
      contextSource,
      /requireSchoolContextWithoutTenantBinding:[\s\S]*Promise\.resolve\(resolveSchoolContext\(req,\s*res,\s*next\)\)\.catch\(next\)/
    );
    assert.match(
      contextSource,
      /export const requireSchoolContext:[\s\S]*Promise\.resolve\([\s\S]*resolveSchoolContext\([\s\S]*\.catch\(next\)/
    );
    assert.match(
      activeSchoolSource,
      /requireActiveSchool:[\s\S]*Promise\.resolve\(resolveActiveSchool\(req,\s*res,\s*next\)\)\.catch\(next\)/
    );
    assert.match(
      licenseSource,
      /return \(req,\s*res,\s*next\)[\s\S]*Promise\.resolve\(checkLicense\(req,\s*res,\s*next\)\)\.catch\(next\)/
    );
    assert.match(
      roleSource,
      /return \(req,\s*res,\s*next\)[\s\S]*Promise\.resolve\(checkRole\(req,\s*res,\s*next\)\)\.catch\(next\)/
    );
  });

  it("fails closed for revoked session schools and broken impersonation lookups", () => {
    const contextSource = readFileSync(
      resolve(root, "src/middleware/requireSchoolContext.ts"),
      "utf8"
    );
    const authenticateSource = readFileSync(
      resolve(root, "src/middleware/authenticate.ts"),
      "utf8"
    );
    const requiredImpersonation = authenticateSource.slice(
      authenticateSource.indexOf("export const authenticate"),
      authenticateSource.indexOf("// Strategy 1: Bearer JWT")
    );
    const optionalImpersonation = authenticateSource.slice(
      authenticateSource.indexOf("export const optionalAuth"),
      authenticateSource.indexOf("// JWT takes priority over session")
    );

    assert.match(
      contextSource,
      /const membership = await loadActiveMembershipContext\([\s\S]*if \(!membership\)[\s\S]*status\(403\)/
    );
    assert.match(requiredImpersonation, /return res\.status\(401\)/);
    assert.match(requiredImpersonation, /return next\(err\)/);
    assert.match(optionalImpersonation, /return next\(\)/);
    assert.match(optionalImpersonation, /return next\(err\)/);
  });

  it("keeps tile history explicitly school scoped and clamps row count", () => {
    const routeSource = readFileSync(resolve(root, "src/routes/classpilot/devices.ts"), "utf8");
    const storageSource = readFileSync(resolve(root, "src/services/storage.ts"), "utf8");

    assert.match(
      routeSource,
      /const staffAuth = \[[\s\S]*requireRole\("admin",\s*"school_admin",\s*"teacher",\s*"office_staff"\)/
    );
    assert.match(routeSource, /Math\.min\(Math\.max\(limit,\s*1\),\s*100\)/);
    assert.match(
      routeSource,
      /Number\.isNaN\(start\.getTime\(\)\)[\s\S]*Number\.isNaN\(end\.getTime\(\)\)[\s\S]*status\(400\)/
    );
    assert.match(
      storageSource,
      /getHeartbeatsByDevice[\s\S]*eq\(heartbeats\.schoolId,\s*schoolId\)[\s\S]*eq\(heartbeats\.deviceId,\s*deviceId\)/
    );
    assert.match(
      storageSource,
      /inArray\(heartbeats\.studentId,\s*authorizedStudentIds\)/
    );
    assert.match(
      storageSource,
      /getHeartbeatsByDeviceInRange[\s\S]*?\.orderBy\(desc\(heartbeats\.timestamp\)\)[\s\S]*?\.limit\(5_000\)/
    );
    assert.match(
      storageSource,
      /getLiveTileReadableDeviceForStaff[\s\S]*getHistoryTileAccessForStaff/
    );
    assert.match(
      routeSource,
      /withAuthorizedTileDevice[\s\S]*runWithTenantContext\([\s\S]*getLiveTileReadableDeviceForStaff[\s\S]*getHistoryTileAccessForStaff/
    );
    const screenshotStart = routeSource.indexOf(
      '// GET /api/classpilot/device/screenshot/:deviceId'
    );
    const screenshotEnd = routeSource.indexOf('// Events (item #3');
    assert.ok(screenshotStart > -1 && screenshotEnd > screenshotStart);
    const screenshotRoute = routeSource.slice(screenshotStart, screenshotEnd);
    assert.match(screenshotRoute, /\.\.\.tileReadAuth/);
    assert.match(screenshotRoute, /await withAuthorizedTileDevice/);
    assert.match(screenshotRoute, /"live"/);
    assert.ok(
      screenshotRoute.indexOf("await withAuthorizedTileDevice") <
        screenshotRoute.indexOf("await getScreenshot(deviceId)")
    );
    const historyStart = routeSource.indexOf(
      '// GET /api/classpilot/heartbeats/:deviceId'
    );
    const historyEnd = routeSource.indexOf('// Remote Control Commands');
    assert.ok(historyStart > -1 && historyEnd > historyStart);
    const historyRoute = routeSource.slice(historyStart, historyEnd);
    assert.match(historyRoute, /\.\.\.tileReadAuth/);
    assert.match(historyRoute, /await withAuthorizedTileDevice/);
    assert.match(historyRoute, /"history"/);
    assert.match(historyRoute, /authorizedStudentIds/);
  });
});
