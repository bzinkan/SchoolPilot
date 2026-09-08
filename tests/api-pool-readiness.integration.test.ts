import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { PoolClient } from "pg";

test("real API pool events quarantine only the stalled task and HTTP probes remain database-free", { timeout: 90_000 }, async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "readiness integration requires the coordinated local PostgreSQL fixture");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname),
    "readiness integration refuses non-loopback databases");
  process.env.SCHEDULER_ENABLED = "false";
  process.env.DB_POOL_MAX = "2";
  process.env.SESSION_DB_POOL_MAX = "2";
  process.env.RLS_GUC_ENABLED = "true";
  process.env.REDIS_URL = "";
  process.env.NODE_ENV = "test";

  const {
    apiPoolReadiness, pool, sessionPool, prewarmMainPool,
    startApiPoolReadiness, stopApiPoolReadiness, drainApiPoolReadiness,
  } = await import("../src/db.js");
  const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
  const { createApp } = await import("../src/app.js");
  const monitor = (await import("../src/services/errorMonitor.js")).default;
  t.mock.method(monitor, "trackError", () => {});
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  let mainAcquisitions = 0;
  let sessionAcquisitions = 0;
  pool.on("acquire", () => { mainAcquisitions++; });
  sessionPool.on("acquire", () => { sessionAcquisitions++; });
  const held = new Set<PoolClient>();
  const hold = async (target: typeof pool) => {
    const client = await target.connect();
    held.add(client);
    return client;
  };
  const release = (client: PoolClient) => {
    assert.equal(held.delete(client), true);
    client.release();
  };
  const sampleAt = async (now: number) => {
    assert.ok(now >= clock);
    clock = now;
    await apiPoolReadiness.sample();
  };
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const checkHttp = async (readyStatus: number) => {
    const before = { mainAcquisitions, sessionAcquisitions };
    for (let index = 0; index < 3; index++) {
      const readiness = await fetch(`${origin}/readyz`);
      assert.equal(readiness.status, readyStatus);
      assert.equal(readiness.headers.get("cache-control"), "no-store");
      assert.equal(readiness.headers.get("set-cookie"), null);
      assert.deepEqual(await readiness.json(), { status: readyStatus === 200 ? "ok" : "unavailable" });
      const live = await fetch(`${origin}/livez`);
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { status: "ok" });
    }
    assert.deepEqual({ mainAcquisitions, sessionAcquisitions }, before,
      "HTTP health traffic must not consume either database pool");
  };

  try {
    await checkHttp(503);
    assert.equal(await prewarmMainPool(), 2);
    assert.equal(pool.options.max, 2);
    assert.equal(sessionPool.options.max, 2);
    startApiPoolReadiness();
    await sampleAt(0);
    await sampleAt(60_000);
    await checkHttp(200);

    const mainFirst = await hold(pool);
    const mainSecond = await hold(pool);
    await sampleAt(100_000);
    await assert.rejects(runWithTenantContext({ schoolId: "readiness-fixture" }, async () => {
      assert.fail("an exhausted pool cannot dispatch tenant work");
    }));
    assert.equal(pool.totalCount, 2);
    assert.equal(pool.idleCount, 0);
    assert.equal(pool.waitingCount, 0, "the detector must retain failed demand after checkout times out");
    const beforeProbes = sessionAcquisitions;
    await sampleAt(160_000);
    assert.equal(apiPoolReadiness.status().ready, true);
    await sampleAt(170_000);
    assert.equal(sessionAcquisitions - beforeProbes, 2);
    assert.equal(sessionPool.totalCount, sessionPool.idleCount, "both independent probes release their clients");
    await checkHttp(503);

    release(mainFirst);
    assert.equal(apiPoolReadiness.status().ready, true, "a real pg release immediately restores admission");
    await sampleAt(175_000);
    await checkHttp(200);
    await runWithTenantContext({ schoolId: "readiness-fixture" }, async () => {});
    release(mainSecond);
    assert.equal(pool.totalCount, pool.idleCount);

    // An independent pool unable to acquire a client is deliberately ambiguous:
    // do not recycle this API merely because both paths are unavailable.
    const blockedMain = await Promise.all([hold(pool), hold(pool)]);
    const blockedSession = await Promise.all([hold(sessionPool), hold(sessionPool)]);
    await sampleAt(200_000);
    apiPoolReadiness.recordAcquisitionFailure();
    await sampleAt(260_000);
    assert.equal(apiPoolReadiness.status().ready, true);
    assert.equal(sessionPool.waitingCount, 0);
    await checkHttp(200);
    for (const client of blockedSession) release(client);
    await sampleAt(270_000);
    assert.equal(apiPoolReadiness.status().ready, true);
    await sampleAt(280_000);
    await checkHttp(503);
    for (const client of blockedMain) release(client);
    await sampleAt(285_000);
    await checkHttp(200);

    // Exercise the exact pg query-timeout disposal behavior relied on by the
    // production adapter, using a local slow query instead of a network fault.
    const removed = once(sessionPool, "remove");
    const slowProbe = { text: "SELECT pg_sleep(3)", query_timeout: 2_000 };
    await assert.rejects(sessionPool.query(slowProbe), /timeout/i);
    await removed;
    assert.equal(sessionPool.waitingCount, 0);
    assert.equal(sessionPool.totalCount, sessionPool.idleCount, "query timeout cannot strand a probe lease");
    await sessionPool.query("SELECT 1");

    stopApiPoolReadiness();
    await drainApiPoolReadiness();
    await checkHttp(503);
  } finally {
    stopApiPoolReadiness();
    await drainApiPoolReadiness();
    for (const client of held) client.release(true);
    held.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await monitor.disposeAndWait();
    await Promise.all([pool.end(), sessionPool.end()]);
  }
});
