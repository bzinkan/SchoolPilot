import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  databasePoolLimits,
  databasePoolMinimums,
  maximumLaunchDatabaseConnections,
  maximumRollingDeploymentDatabaseConnections,
  prewarmDatabasePool,
  schedulerDatabaseAllowed,
  type PrewarmPool,
} from "../src/config/databasePools.js";

const root = resolve(import.meta.dirname, "..");

describe("API main database-pool prewarm", () => {
  it("allows scheduler pools only for workers and explicit migration modes", () => {
    assert.equal(schedulerDatabaseAllowed({ SCHEDULER_ENABLED: "false" }), false);
    assert.equal(schedulerDatabaseAllowed({ SCHEDULER_ENABLED: "true" }), true);
    assert.equal(schedulerDatabaseAllowed({
      SCHEDULER_ENABLED: "false",
      RUN_MIGRATIONS_ONLY: "true",
    }), true);
    assert.equal(schedulerDatabaseAllowed({
      SCHEDULER_ENABLED: "false",
      RUN_MIGRATIONS_ON_STARTUP: "true",
    }), true);
    assert.equal(schedulerDatabaseAllowed({
      SCHEDULER_ENABLED: "false",
      RUN_LEGACY_MIGRATIONS_ONLY: "true",
    }), true);
  });

  it("opens and verifies all 16 API main clients concurrently", async () => {
    const expectedConnections = databasePoolMinimums({
      SCHEDULER_ENABLED: "false",
      DB_POOL_MAX: "999",
    }).main;
    let connectCalls = 0;
    let queryCalls = 0;
    let releaseCalls = 0;
    let checkedOut = 0;
    let peakCheckedOut = 0;

    const fakePool: PrewarmPool = {
      async connect() {
        connectCalls += 1;
        checkedOut += 1;
        peakCheckedOut = Math.max(peakCheckedOut, checkedOut);
        return {
          async query(queryText: string) {
            queryCalls += 1;
            assert.equal(queryText, "SELECT 1");
          },
          release(error?: Error | boolean) {
            assert.equal(error, undefined);
            releaseCalls += 1;
            checkedOut -= 1;
          },
        };
      },
    };

    await prewarmDatabasePool(fakePool, expectedConnections);

    assert.equal(expectedConnections, 16);
    assert.equal(connectCalls, 16);
    assert.equal(queryCalls, 16);
    assert.equal(peakCheckedOut, 16);
    assert.equal(releaseCalls, 16);
    assert.equal(checkedOut, 0);
  });

  it("waits for every attempt and releases every acquired client on probe failure", async () => {
    const released: Array<{ id: number; error?: Error | boolean }> = [];
    let connectCalls = 0;
    let queryCalls = 0;
    const fakePool: PrewarmPool = {
      async connect() {
        const id = ++connectCalls;
        return {
          async query(queryText: string) {
            queryCalls += 1;
            assert.equal(queryText, "SELECT 1");
            if (id === 7) throw new Error("synthetic prewarm probe failure");
          },
          release(error?: Error | boolean) {
            released.push({ id, error });
          },
        };
      },
    };

    await assert.rejects(
      prewarmDatabasePool(fakePool, 16),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Failed to prewarm 16 database connections/);
        assert.equal(error.errors.length, 1);
        assert.match(String(error.errors[0]), /synthetic prewarm probe failure/);
        return true;
      }
    );

    assert.equal(connectCalls, 16);
    assert.equal(queryCalls, 16);
    assert.equal(released.length, 16);
    assert.match(
      released.find(({ id }) => id === 7)?.error instanceof Error
        ? (released.find(({ id }) => id === 7)?.error as Error).message
        : "",
      /synthetic prewarm probe failure/
    );
    assert.equal(
      released.filter(({ id, error }) => id !== 7 && error === undefined).length,
      15
    );
  });

  it("releases all successful checkouts when one concurrent checkout fails", async () => {
    const released: number[] = [];
    let connectCalls = 0;
    let queryCalls = 0;
    const fakePool: PrewarmPool = {
      async connect() {
        const id = ++connectCalls;
        if (id === 11) throw new Error("synthetic checkout failure");
        return {
          async query() {
            queryCalls += 1;
          },
          release() {
            released.push(id);
          },
        };
      },
    };

    await assert.rejects(
      prewarmDatabasePool(fakePool, 16),
      /Failed to prewarm 16 database connections/
    );
    assert.equal(connectCalls, 16);
    assert.equal(queryCalls, 15);
    assert.equal(released.length, 15);
    assert.equal(released.includes(11), false);
  });

  it("continues releasing the cohort when one client release throws", async () => {
    const released: number[] = [];
    let connectCalls = 0;
    const fakePool: PrewarmPool = {
      async connect() {
        const id = ++connectCalls;
        return {
          async query() {},
          release() {
            released.push(id);
            if (id === 5) throw new Error("synthetic release failure");
          },
        };
      },
    };

    await assert.rejects(
      prewarmDatabasePool(fakePool, 16),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        assert.match(String(error.errors[0]), /synthetic release failure/);
        return true;
      }
    );
    assert.equal(released.length, 16);
    assert.deepEqual(released, Array.from({ length: 16 }, (_, index) => index + 1));
  });

  it("retains API connections at its configured cap and leaves worker minimum at zero", () => {
    const configuredApi = {
      SCHEDULER_ENABLED: "false",
      DB_POOL_MAX: "12",
    };
    const cappedApi = {
      SCHEDULER_ENABLED: "false",
      DB_POOL_MAX: "999",
    };
    const worker = {
      SCHEDULER_ENABLED: "true",
      DB_POOL_MAX: "999",
    };

    assert.equal(databasePoolLimits(configuredApi).main, 12);
    assert.equal(databasePoolMinimums(configuredApi).main, 12);
    assert.equal(databasePoolLimits(cappedApi).main, 16);
    assert.equal(databasePoolMinimums(cappedApi).main, 16);
    assert.equal(databasePoolLimits(worker).main, 2);
    assert.equal(databasePoolMinimums(worker).main, 0);
    assert.equal(maximumLaunchDatabaseConnections(), 124);
    assert.equal(maximumRollingDeploymentDatabaseConnections(2), 104);
    assert.ok(maximumRollingDeploymentDatabaseConnections(2) < 150);
    assert.equal(maximumRollingDeploymentDatabaseConnections(3), 140);
    assert.ok(maximumRollingDeploymentDatabaseConnections(3) < 150);
  });

  it("wires prewarm only into serving startup before HTTP listen", () => {
    const dbSource = readFileSync(resolve(root, "src/db.ts"), "utf8");
    const indexSource = readFileSync(resolve(root, "src/index.ts"), "utf8");
    const workerSource = readFileSync(resolve(root, "src/worker.ts"), "utf8");
    const startServer = indexSource.slice(
      indexSource.indexOf("async function startServer"),
      indexSource.indexOf("async function runMigrationsAndExit")
    );
    const migrationsOnly = indexSource.slice(
      indexSource.indexOf("async function runMigrationsAndExit"),
      indexSource.indexOf("if (migrationsOnly())")
    );

    assert.match(dbSource, /min:\s*poolMinimums\.main/);
    assert.match(dbSource, /prewarmDatabasePool\(pool,\s*poolMinimums\.main\)/);
    assert.ok(startServer.indexOf("await prewarmMainPool()") > -1);
    assert.ok(
      startServer.indexOf("await prewarmMainPool()") <
        startServer.indexOf("server.listen(")
    );
    assert.doesNotMatch(migrationsOnly, /prewarmMainPool/);
    assert.doesNotMatch(workerSource, /prewarmMainPool|prewarmDatabasePool/);
  });
});
