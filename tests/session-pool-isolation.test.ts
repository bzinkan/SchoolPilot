import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import session, { type SessionData } from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Pool } from "pg";
import {
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
    assert.match(appSource, /pool:\s*sessionPool as any/);
    assert.match(appSource, /disableTouch:\s*true/);
    assert.doesNotMatch(appSource, /new PgStore\(\{[\s\S]{0,200}pool:\s*pool as any/);
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
    assert.match(
      tenantSource,
      /SELECT set_config\('app\.is_super',[\s\S]*set_config\('app\.school_id'/
    );
  });

  it("keeps tile history explicitly school scoped and clamps row count", () => {
    const routeSource = readFileSync(resolve(root, "src/routes/classpilot/devices.ts"), "utf8");
    const storageSource = readFileSync(resolve(root, "src/services/storage.ts"), "utf8");

    assert.match(routeSource, /Math\.min\(Math\.max\(limit,\s*1\),\s*100\)/);
    assert.match(
      storageSource,
      /where\(and\(eq\(heartbeats\.schoolId,\s*schoolId\),\s*eq\(heartbeats\.deviceId,\s*deviceId\)\)\)/
    );
  });
});
