import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import express from "express";
import rateLimit, { MemoryStore } from "express-rate-limit";
import {
  getUsageCapacityDiagnostics, getUsageCapacityOperation, recordUsageCapacityCounter,
  resetUsageCapacityDiagnostics, runWithUsageCapacityOperation, startUsageCapacityCheckout,
  startUsageCapacityOperation, trackUsageCapacityMiddleware,
} from "../src/services/usageCapacityDiagnostics.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const value = (operation: "heartbeat_handler" | "heartbeat_middleware" | "heartbeat_final_delivery") =>
  getUsageCapacityDiagnostics().operations[operation]!;
beforeEach(resetUsageCapacityDiagnostics);
afterEach(() => {
  for (const row of Object.values(getUsageCapacityDiagnostics().operations)) {
    assert.equal(row.activeOperations, 0);
    assert.equal(row.activeCheckouts, 0);
    assert.equal(row.pendingCheckouts, 0);
  }
});

test("HTTP finish cannot end a handler awaiting late checkout, COMMIT and RESET", async () => {
  const checkout = deferred(), commit = deferred(), reset = deferred(), done = deferred();
  const app = express();
  app.get("/", async (_req, res) => {
    const end = startUsageCapacityOperation("heartbeat_handler");
    try {
      res.json({ ok: true });
      await runWithUsageCapacityOperation("heartbeat_final_delivery", async () => {
        recordUsageCapacityCounter("checkoutAttempts");
        await checkout.promise;
        const release = startUsageCapacityCheckout();
        recordUsageCapacityCounter("checkoutSuccess");
        try { await commit.promise; }
        finally { await reset.promise; release(); }
      });
    } finally { end(); done.resolve(); }
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200); await response.json();
    assert.equal(value("heartbeat_handler").activeOperations, 1);
    assert.equal(value("heartbeat_final_delivery").pendingCheckouts, 1);
    resetUsageCapacityDiagnostics();
    assert.equal(value("heartbeat_handler").activeOperations, 1);
    assert.equal(value("heartbeat_final_delivery").pendingCheckouts, 1);
    checkout.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(value("heartbeat_final_delivery").pendingCheckouts, 0);
    assert.equal(value("heartbeat_final_delivery").activeCheckouts, 1);
    commit.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(value("heartbeat_handler").activeOperations, 1);
    assert.equal(value("heartbeat_final_delivery").activeCheckouts, 1);
    reset.resolve(); await done.promise;
    assert.equal(value("heartbeat_handler").activeOperations, 0);
    assert.equal(value("heartbeat_final_delivery").activeCheckouts, 0);
  } finally {
    checkout.resolve(); commit.resolve(); reset.resolve(); await done.promise;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("client abort does not release a pre-handler Redis await or the later handler", async () => {
  const entered = deferred(), redis = deferred(), handlerEntered = deferred(), handlerDone = deferred(), complete = deferred();
  const app = express();
  class DelayedStore extends MemoryStore {
    override async increment(key: string) {
      entered.resolve(); await redis.promise; return super.increment(key);
    }
  }
  const store = new DelayedStore();
  app.use(trackUsageCapacityMiddleware("heartbeat_middleware", rateLimit({ store, limit: 5, windowMs: 60_000 })));
  app.get("/", async (_req, _res) => {
    const end = startUsageCapacityOperation("heartbeat_handler");
    try { handlerEntered.resolve(); await handlerDone.promise; }
    finally { end(); complete.resolve(); }
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const client = request(`http://127.0.0.1:${address.port}/`);
  client.on("error", () => {}); client.end();
  try {
    await entered.promise; client.destroy();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(value("heartbeat_middleware").activeOperations, 1);
    assert.equal(value("heartbeat_handler").activeOperations, 0);
    redis.resolve(); await handlerEntered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(value("heartbeat_middleware").activeOperations, 0);
    assert.equal(value("heartbeat_handler").activeOperations, 1);
    handlerDone.resolve(); await complete.promise;
  } finally {
    redis.resolve(); handlerDone.resolve(); await complete.promise;
    store.shutdown();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("late failed checkout remains visible after response and reset without changing error identity", async () => {
  const finish = deferred(), failure = new Error("synthetic private error");
  const end = startUsageCapacityOperation("heartbeat_handler");
  const promise = runWithUsageCapacityOperation("heartbeat_final_delivery", async () => {
    recordUsageCapacityCounter("checkoutAttempts");
    await finish.promise;
    recordUsageCapacityCounter("checkoutFailure");
    throw failure;
  }).finally(end);
  assert.equal(getUsageCapacityOperation(), "unclassified");
  resetUsageCapacityDiagnostics(); finish.resolve();
  await assert.rejects(promise, error => error === failure);
  assert.equal(value("heartbeat_final_delivery").counters.checkoutFailure, 1);
  assert.equal(value("heartbeat_final_delivery").pendingCheckouts, 0);
  end(); // Idempotent lifetime cleanup cannot underflow.
  assert.doesNotMatch(JSON.stringify(getUsageCapacityDiagnostics()), /synthetic private/);
});

test("actual heartbeat owner uses finally outside all post-response work and middleware coverage stays narrow", () => {
  const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf('router.post("/device/heartbeat"'), source.indexOf('router.post("/device/screenshot"'));
  assert.match(route, /startUsageCapacityOperation\("heartbeat_handler"\);\s*let finishForegroundTelemetry: \(\) => void = \(\) => \{\};\s*try \{/);
  assert.match(route, /await Promise\.all\(teacherReplyPublications\);[\s\S]*return finalDelivery\.value;[\s\S]*finally \{[\s\S]*endHeartbeatHandler\(\);/);
  assert.match(route, /catch \(err\) \{\s*recordUsageCapacityCounter\("heartbeatHandlerFailures", "heartbeat_handler"\);\s*next\(err\);/);
  for (const middleware of ["requireCryptographicDeviceAuth", "requireClasspilotEntitlement", "deviceHeartbeatLimiter"]) {
    assert.ok(route.includes(`trackUsageCapacityMiddleware("heartbeat_middleware", ${middleware})`));
  }
  assert.doesNotMatch(route, /(?:once|on)\(["'](?:close|finish)["'],\s*endHeartbeatHandler/);
});
