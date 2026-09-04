import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { WebSocketServer } from "ws";
import { wasTenantPoolAcquisitionFailureReported } from "../src/util/operationalErrors.js";

// Unit CI intentionally has no database configuration. Production modules
// validate this at import time; all database operations below are mocked.
// Force an inert fixture URL so this test never inherits a developer database.
process.env.DATABASE_URL = "postgresql://unit:unit@127.0.0.1:1/schoolpilot_unit";
const { pool } = await import("../src/db.js");
const { drainHealthMonitor, startHealthMonitor, stopHealthMonitor } = await import("../src/services/healthMonitor.js");
const { default: errorMonitor, ErrorMonitor } = await import("../src/services/errorMonitor.js");
const {
  drainTenantContextReleases,
  getTenantContextReleaseSnapshot,
  runWithTenantContext,
} = await import("../src/middleware/tenantContext.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("tenant context cleanup during drain", () => {
  it("reports an acquisition failure once without creating another database write", async (t) => {
    const previous = process.env.RLS_GUC_ENABLED;
    process.env.RLS_GUC_ENABLED = "true";
    const failure = new Error("private checkout failure");
    const connect = t.mock.method(pool, "connect", async () => { throw failure; });
    let captures = 0;
    let alertCalls = 0;
    let persistCalls = 0;
    const monitor = new ErrorMonitor({
      startMetrics: false,
      startHousekeeping: false,
      metricsSink: () => {},
      capture: () => { captures++; },
      flushExternal: async () => {},
      persist: async () => { persistCalls++; return "persisted"; },
      dispatchAlert: async () => {
        alertCalls++;
        return [{ channel: "email", attempted: true, delivered: true }];
      },
    });
    const tracked = t.mock.method(errorMonitor, "trackError", (...args: Parameters<typeof errorMonitor.trackError>) => monitor.trackError(...args));
    let enteredTenant = false;
    try {
      await assert.rejects(runWithTenantContext({ schoolId: "test-school" }, async () => {
        enteredTenant = true;
      }), (error) => error === failure);
      assert.equal(enteredTenant, false);
      assert.equal(connect.mock.callCount(), 1);
      assert.equal(tracked.mock.callCount(), 1);
      const args = tracked.mock.calls[0]!.arguments;
      assert.equal(args[0], "database_connectivity");
      assert.equal(args[2]?.errorCode, "POOL_ACQUISITION_FAILED");
      assert.equal(args[3]?.persist, false);
      assert.equal(wasTenantPoolAcquisitionFailureReported(failure), true);
      assert.doesNotMatch(JSON.stringify(args), /private checkout|test-school/);
      // Exercise the real central monitor as generic callers see the original
      // exception, a direct wrapper, or three wrappers around that exception.
      errorMonitor.trackError("scheduler_failure", failure, { job: "schedulerFallback" });
      errorMonitor.trackError("api_error", new Error("request failed", { cause: failure }));
      errorMonitor.trackError("health_failure", new Error("outer", {
        cause: new Error("middle", { cause: new Error("inner", { cause: failure }) }),
      }));
      await monitor.flush();
      assert.equal(captures, 1);
      assert.equal(alertCalls, 1);
      assert.equal(persistCalls, 0, "propagating the checkout failure cannot create another DB write");
      assert.equal(monitor.getStats().totals.captured, 1);
      assert.equal(monitor.getStats().totals.alertAttempted, 1);
      assert.equal(monitor.getStats().totals.alertDelivered, 1);
      assert.deepEqual(Object.keys(monitor.getStats().byCategory), ["database_connectivity"]);

      monitor.trackError("api_error", new Error("independent failure"), {}, { persist: false, alert: false });
      assert.equal(monitor.getStats().totals.captured, 2, "unmarked failures remain visible");
      monitor.trackError("fatal_process_error", failure, {}, { persist: false, alert: false });
      assert.equal(monitor.getStats().totals.captured, 3, "process termination remains a separate critical event");
    } finally {
      await monitor.disposeAndWait();
      if (previous === undefined) delete process.env.RLS_GUC_ENABLED;
      else process.env.RLS_GUC_ENABLED = previous;
    }
  });

  it("waits for the RESET before releasing and completing the shutdown drain", async () => {
    const previous = process.env.RLS_GUC_ENABLED;
    process.env.RLS_GUC_ENABLED = "true";
    const resetStarted = deferred();
    const resetAllowed = deferred();
    let releases = 0;
    const connect = mock.method(pool, "connect", async () => ({
      async query(sql: string) {
        if (sql.includes("'app.school_id', ''")) {
          resetStarted.resolve();
          await resetAllowed.promise;
        }
        return { rows: [] };
      },
      release() { releases += 1; },
    }));
    try {
      const operation = runWithTenantContext({ schoolId: "test-school" }, async () => 42);
      await resetStarted.promise;
      assert.equal(getTenantContextReleaseSnapshot().pending, 1);
      let drained = false;
      const drain = drainTenantContextReleases().then(() => { drained = true; });
      await Promise.resolve();
      assert.equal(drained, false);
      assert.equal(releases, 0);
      resetAllowed.resolve();
      assert.equal(await operation, 42);
      await drain;
      assert.equal(releases, 1);
      assert.equal(getTenantContextReleaseSnapshot().pending, 0);
    } finally {
      resetAllowed.resolve();
      connect.mock.restore();
      if (previous === undefined) delete process.env.RLS_GUC_ENABLED;
      else process.env.RLS_GUC_ENABLED = previous;
    }
  });

  it("discards a connection if clearing its tenant authority fails", async () => {
    const previous = process.env.RLS_GUC_ENABLED;
    process.env.RLS_GUC_ENABLED = "true";
    const failure = new Error("reset failed");
    let discardedWith: Error | undefined;
    const connect = mock.method(pool, "connect", async () => ({
      async query(sql: string) {
        if (sql.includes("'app.school_id', ''")) throw failure;
        return { rows: [] };
      },
      release(error?: Error) { discardedWith = error; },
    }));
    try {
      assert.equal(await runWithTenantContext({ schoolId: "test-school" }, async () => 42), 42);
      assert.equal(discardedWith, failure);
      await drainTenantContextReleases();
      assert.equal(getTenantContextReleaseSnapshot().pending, 0);
    } finally {
      connect.mock.restore();
      if (previous === undefined) delete process.env.RLS_GUC_ENABLED;
      else process.env.RLS_GUC_ENABLED = previous;
    }
  });

  it("fences periodic health checks and drains an already running database check", async (t) => {
    const queryAllowed = deferred();
    let queries = 0;
    const server = new WebSocketServer({ noServer: true });
    t.mock.method(pool, "query", async () => {
      queries += 1;
      await queryAllowed.promise;
      return { rows: [] };
    });
    t.mock.method(console, "log", () => {});
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      startHealthMonitor(server);
      t.mock.timers.tick(15_000);
      await Promise.resolve();
      assert.equal(queries, 1);
      stopHealthMonitor();
      t.mock.timers.tick(600_000);
      let drained = false;
      const drain = drainHealthMonitor().then(() => { drained = true; });
      await Promise.resolve();
      assert.equal(drained, false);
      queryAllowed.resolve();
      await drain;
      assert.equal(queries, 1, "the stopped loop must not proceed into the sentinel write check");
    } finally {
      queryAllowed.resolve();
      stopHealthMonitor();
      t.mock.timers.reset();
      await drainHealthMonitor();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
