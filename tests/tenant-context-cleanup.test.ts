import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, mock, type TestContext } from "node:test";
import type { Request, Response, NextFunction } from "express";
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
  bindTenantContext,
  drainTenantContextReleases,
  getTenantContextReleaseSnapshot,
  runWithTenantContext,
} = await import("../src/middleware/tenantContext.js");
const { getTenantStore } = await import("../src/db/tenantContext.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type FixtureClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: never[] }>;
  release(error?: Error): void;
};

class TenantResponse extends EventEmitter implements Pick<Response, "locals" | "destroyed" | "closed" | "writableEnded" | "writableFinished"> {
  locals: { schoolId: string; releaseTenantContext?: () => Promise<void> };
  destroyed = false;
  closed = false;
  writableEnded = false;
  writableFinished = false;

  constructor(schoolId = "cancelled-request-school") {
    super();
    this.locals = { schoolId };
  }

  closeResponse() {
    this.destroyed = true;
    this.closed = true;
    this.emit("close");
  }

  finishResponse() {
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("finish");
  }
}

function invokeBinding(response: TenantResponse, next: NextFunction) {
  const request: Pick<Request, "aborted" | "destroyed" | "authUser"> = {
    aborted: false,
    destroyed: false,
    authUser: undefined,
  };
  // State is checked against Express; event methods come from a real
  // EventEmitter. Full HTTP behavior is outside this checkout-race fixture.
  const responseSurface: Pick<Response, "locals" | "destroyed" | "closed" | "writableEnded" | "writableFinished"> = response;
  return Promise.resolve(bindTenantContext(request as Request, responseSurface as Response, next));
}

function enableRls(t: TestContext) {
  const previous = process.env.RLS_GUC_ENABLED;
  process.env.RLS_GUC_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.RLS_GUC_ENABLED;
    else process.env.RLS_GUC_ENABLED = previous;
  });
}

const afterEventLoopTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const isReset = (sql: string) => sql.includes("'app.school_id', ''");

describe("tenant request disconnect races", { timeout: 5_000 }, () => {
  for (const state of ["destroyed", "closed", "writableEnded"] as const) {
    it(`does not acquire a tenant client when the response is already ${state}`, async (t) => {
      enableRls(t);
      const response = new TenantResponse();
      response[state] = true;
      const connect = t.mock.method(pool, "connect", async () => { throw new Error("unexpected checkout"); });
      t.mock.method(errorMonitor, "trackError", () => {});
      const next = t.mock.fn();
      await invokeBinding(response, next);
      assert.equal(connect.mock.callCount(), 0);
      assert.equal(next.mock.callCount(), 0);
      assert.equal(getTenantContextReleaseSnapshot().pending, 0);
    });
  }

  it("drains a client arriving after response close without initializing or dispatching it", async (t) => {
    enableRls(t);
    const checkoutAllowed = deferred();
    const sqlCalls: string[] = [];
    const releases: Array<Error | undefined> = [];
    const client: FixtureClient = {
      async query(sql) { sqlCalls.push(sql); return { rows: [] }; },
      release(error) { releases.push(error); },
    };
    t.mock.method(pool, "connect", async () => { await checkoutAllowed.promise; return client; });
    const response = new TenantResponse();
    const next = t.mock.fn();
    const binding = invokeBinding(response, next);
    let drained = false;
    let drain: Promise<void> | undefined;
    try {
      response.closeResponse();
      assert.equal(getTenantContextReleaseSnapshot().pending, 1, "shutdown must track a closed request awaiting checkout");
      drain = drainTenantContextReleases().then(() => { drained = true; });
      await afterEventLoopTurn();
      assert.equal(drained, false);
      assert.equal(releases.length, 0);
      checkoutAllowed.resolve();
      await binding;
      await drain;
      assert.equal(next.mock.callCount(), 0, "an abandoned request must not reach its handler");
      assert.equal(sqlCalls.length, 1);
      assert.ok(isReset(sqlCalls[0]!), "late checkout must be cleaned without setting abandoned tenant authority");
      assert.deepEqual(releases, [undefined]);
      assert.equal(getTenantContextReleaseSnapshot().pending, 0);
    } finally {
      checkoutAllowed.resolve();
      await binding;
      response.closeResponse();
      await drainTenantContextReleases();
      await drain;
    }
  });

  it("waits for in-flight GUC initialization before resetting a closed request", async (t) => {
    enableRls(t);
    const setupStarted = deferred();
    const setupAllowed = deferred();
    const order: string[] = [];
    const client: FixtureClient = {
      async query(sql) {
        if (isReset(sql)) order.push("reset");
        else {
          order.push("setup-start");
          setupStarted.resolve();
          await setupAllowed.promise;
          order.push("setup-end");
        }
        return { rows: [] };
      },
      release() { order.push("release"); },
    };
    t.mock.method(pool, "connect", async () => client);
    const response = new TenantResponse();
    const next = t.mock.fn();
    const binding = invokeBinding(response, next);
    let drained = false;
    let drain: Promise<void> | undefined;
    try {
      await setupStarted.promise;
      response.closeResponse();
      drain = drainTenantContextReleases().then(() => { drained = true; });
      await afterEventLoopTurn();
      assert.deepEqual(order, ["setup-start"], "RESET/release cannot race an unfinished tenant SET");
      assert.equal(drained, false);
      assert.equal(getTenantContextReleaseSnapshot().pending, 1);
      setupAllowed.resolve();
      await binding;
      await drain;
      assert.deepEqual(order, ["setup-start", "setup-end", "reset", "release"]);
      assert.equal(next.mock.callCount(), 0);
      assert.equal(getTenantContextReleaseSnapshot().pending, 0);
    } finally {
      setupAllowed.resolve();
      await binding;
      response.closeResponse();
      await drainTenantContextReleases();
      await drain;
    }
  });

  it("binds the correct tenant and resets once across finish, close, and explicit release", async (t) => {
    enableRls(t);
    const resetStarted = deferred();
    const resetAllowed = deferred();
    const sqlCalls: Array<{ sql: string; values?: unknown[] }> = [];
    const releases: Array<Error | undefined> = [];
    const client: FixtureClient = {
      async query(sql, values) {
        sqlCalls.push({ sql, values });
        if (isReset(sql)) { resetStarted.resolve(); await resetAllowed.promise; }
        return { rows: [] };
      },
      release(error) { releases.push(error); },
    };
    t.mock.method(pool, "connect", async () => client);
    const response = new TenantResponse("live-request-school");
    const next = t.mock.fn(() => {
      assert.equal(getTenantStore()?.schoolId, "live-request-school");
      assert.equal(getTenantStore()?.isSuper, false);
      assert.equal(getTenantStore()?.client, client);
    });
    try {
      await invokeBinding(response, next);
      assert.equal(next.mock.callCount(), 1);
      assert.deepEqual(sqlCalls[0]?.values, ["off", "live-request-school"]);
      assert.equal(releases.length, 0);
      assert.ok(response.locals.releaseTenantContext);
      response.finishResponse();
      response.closeResponse();
      const explicitRelease = response.locals.releaseTenantContext();
      assert.equal(response.locals.releaseTenantContext(), explicitRelease, "all completion paths share one release promise");
      await resetStarted.promise;
      assert.equal(sqlCalls.filter(({ sql }) => isReset(sql)).length, 1);
      assert.equal(releases.length, 0);
      resetAllowed.resolve();
      await explicitRelease;
      await drainTenantContextReleases();
      response.finishResponse();
      response.closeResponse();
      await afterEventLoopTurn();
      assert.deepEqual(releases, [undefined]);
      assert.equal(getTenantContextReleaseSnapshot().pending, 0);
      assert.equal(getTenantStore(), undefined, "tenant scope must not escape handler dispatch");
    } finally {
      resetAllowed.resolve();
      response.closeResponse();
      await drainTenantContextReleases();
    }
  });

  it("discards after setup and RESET fail during close, without dispatching an error handler", async (t) => {
    enableRls(t);
    const setupStarted = deferred();
    const setupAllowed = deferred();
    const setupFailure = new Error("setup failed");
    const resetFailure = new Error("reset failed");
    const order: string[] = [];
    const releases: Array<Error | undefined> = [];
    const client: FixtureClient = {
      async query(sql) {
        if (isReset(sql)) { order.push("reset-failed"); throw resetFailure; }
        order.push("setup-start");
        setupStarted.resolve();
        await setupAllowed.promise;
        order.push("setup-failed");
        throw setupFailure;
      },
      release(error) { releases.push(error); order.push("discard"); },
    };
    t.mock.method(pool, "connect", async () => client);
    const response = new TenantResponse();
    const next = t.mock.fn();
    const binding = invokeBinding(response, next);
    try {
      await setupStarted.promise;
      response.closeResponse();
      await afterEventLoopTurn();
      assert.deepEqual(order, ["setup-start"]);
      setupAllowed.resolve();
      await binding;
      await drainTenantContextReleases();
      assert.deepEqual(order, ["setup-start", "setup-failed", "reset-failed", "discard"]);
      assert.deepEqual(releases, [resetFailure]);
      assert.equal(next.mock.callCount(), 0);
      assert.equal(getTenantContextReleaseSnapshot().pending, 0);
    } finally {
      setupAllowed.resolve();
      await binding;
      response.closeResponse();
      await drainTenantContextReleases();
    }
  });

  it("preserves the original setup error for a live response after discarding a failed RESET", async (t) => {
    enableRls(t);
    const setupFailure = new Error("setup failed");
    const resetFailure = new Error("reset failed");
    const releases: Array<Error | undefined> = [];
    const client: FixtureClient = {
      async query(sql) { throw isReset(sql) ? resetFailure : setupFailure; },
      release(error) { releases.push(error); },
    };
    t.mock.method(pool, "connect", async () => client);
    const response = new TenantResponse();
    const next = t.mock.fn();
    await invokeBinding(response, next);
    response.closeResponse();
    await drainTenantContextReleases();
    assert.equal(next.mock.callCount(), 1);
    assert.equal(next.mock.calls[0]!.arguments[0], setupFailure);
    assert.deepEqual(releases, [resetFailure]);
    assert.equal(getTenantContextReleaseSnapshot().pending, 0);
  });

  it("keeps a late checkout failure observable without dispatching into a closed response", async (t) => {
    enableRls(t);
    const checkoutAllowed = deferred();
    const failure = new Error("checkout failed after close");
    const tracked = t.mock.method(errorMonitor, "trackError", () => {});
    t.mock.method(pool, "connect", async () => { await checkoutAllowed.promise; throw failure; });
    const response = new TenantResponse();
    const next = t.mock.fn();
    const binding = invokeBinding(response, next);
    response.closeResponse();
    checkoutAllowed.resolve();
    await binding;
    await drainTenantContextReleases();
    assert.equal(next.mock.callCount(), 0);
    assert.equal(tracked.mock.callCount(), 1);
    assert.equal(tracked.mock.calls[0]!.arguments[2]?.errorCode, "POOL_ACQUISITION_FAILED");
    assert.equal(wasTenantPoolAcquisitionFailureReported(failure), true);
    assert.equal(getTenantContextReleaseSnapshot().pending, 0);
  });

  it("repeated queued cancellations cannot exhaust a two-client pool or block the next live tenant", async (t) => {
    enableRls(t);
    const capacity = 2;
    let active = 0;
    let peak = 0;
    let released = 0;
    let initialized = 0;
    const waiters: Array<(client: FixtureClient) => void> = [];
    function lease(): FixtureClient {
      active++;
      peak = Math.max(peak, active);
      let returned = false;
      return {
        async query(sql) { if (!isReset(sql)) initialized++; return { rows: [] }; },
        release() {
          assert.equal(returned, false, "one physical pool permit cannot be returned twice");
          returned = true;
          active--;
          released++;
          const waiting = waiters.shift();
          if (waiting) waiting(lease());
        },
      };
    }
    t.mock.method(pool, "connect", () => active < capacity
      ? Promise.resolve(lease())
      : new Promise<FixtureClient>((resolve) => { waiters.push(resolve); }));
    const holders = [new TenantResponse("first-school"), new TenantResponse("second-school")];
    const cancelled = Array.from({ length: 16 }, () => new TenantResponse());
    const nextCancelled = t.mock.fn();
    const holdersNext = t.mock.fn();
    const fresh = new TenantResponse("fresh-school");
    const pendingBindings: Array<Promise<unknown>> = [];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.all(holders.map(response => invokeBinding(response, holdersNext)));
      assert.equal(holdersNext.mock.callCount(), 2);
      assert.equal(active, 2);
      for (const response of cancelled) {
        pendingBindings.push(invokeBinding(response, nextCancelled));
        response.closeResponse();
      }
      assert.equal(waiters.length, 16);
      for (const response of holders) response.finishResponse();
      await Promise.race([
        Promise.all(pendingBindings),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("cancelled checkouts exhausted the two-client pool")), 500); }),
      ]);
      await drainTenantContextReleases();
      assert.equal(nextCancelled.mock.callCount(), 0);
      assert.equal(waiters.length, 0);
      assert.equal(active, 0);
      assert.equal(peak, capacity);
      assert.equal(released, 18);
      assert.equal(initialized, 2, "abandoned queued requests do not install tenant authority");
      const nextFresh = t.mock.fn(() => assert.equal(getTenantStore()?.schoolId, "fresh-school"));
      await invokeBinding(fresh, nextFresh);
      assert.equal(nextFresh.mock.callCount(), 1);
      fresh.finishResponse();
      await drainTenantContextReleases();
      assert.equal(active, 0);
      assert.equal(released, 19);
      assert.equal(getTenantContextReleaseSnapshot().pending, 0);
    } finally {
      if (deadline) clearTimeout(deadline);
      // Also settle a failing baseline implementation: repeated events release
      // its late-attached listeners so the fixture itself leaves no waiters.
      for (let round = 0; round < cancelled.length + 2; round++) {
        for (const response of [...holders, ...cancelled, fresh]) response.closeResponse();
        await afterEventLoopTurn();
      }
      await Promise.allSettled(pendingBindings);
      await drainTenantContextReleases();
    }
  });
});

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
