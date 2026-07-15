import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

process.env.NODE_ENV = "test";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";
process.env.SCHEDULER_ENABLED = "false";

const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: any[]) => {
  const timer = (originalSetInterval as any)(...args);
  timer.unref?.();
  return timer;
}) as typeof setInterval;

const { pool, sessionPool } = await import("../dist/db.js");
const { default: router } = await import(
  "../dist/routes/classpilot/devices.js"
);
const { errorHandler } = await import("../dist/middleware/errorHandler.js");
const { default: errorMonitor } = await import(
  "../dist/services/errorMonitor.js"
);
const { createStudentToken } = await import(
  "../dist/services/deviceJwt.js"
);

after(async () => {
  globalThis.setInterval = originalSetInterval;
  await Promise.allSettled([pool.end(), sessionPool.end()]);
});

describe("ClassPilot school-status token authentication", () => {
  it("returns a sanitized 503 when an authenticated token lookup cannot reach the database", async (t) => {
    const secret = "school-status-database-secret";
    const databaseError = Object.assign(
      new Error(`pool unavailable; params=${secret}`),
      { code: "57P01", params: [secret] }
    );
    t.mock.method(pool, "connect", async () => {
      throw databaseError;
    });
    t.mock.method(errorMonitor, "trackError", () => {});
    const errorLog = t.mock.method(console, "error", () => {});

    const app = express();
    app.use(express.json());
    app.use("/api/classpilot", router);
    app.use(errorHandler);
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );

    try {
      const address = server.address() as AddressInfo;
      const studentToken = createStudentToken({
        schoolId: "school-status-test-school",
        studentId: "school-status-test-student",
        deviceId: "school-status-test-device",
        sessionId: "school-status-test-session",
      });
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/classpilot/school/status`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ studentToken }),
        }
      );
      const body = await response.json() as Record<string, unknown>;

      assert.equal(response.status, 503);
      assert.equal(body.error, "Student authentication service unavailable");
      assert.equal(body.code, "57P01");
      assert.notEqual(body.error, "studentEmail required");
      assert.doesNotMatch(JSON.stringify(body), new RegExp(secret, "i"));
      assert.doesNotMatch(
        JSON.stringify(errorLog.mock.calls.map((call) => call.arguments)),
        new RegExp(secret, "i")
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });
});
