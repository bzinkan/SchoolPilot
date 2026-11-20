import assert from "node:assert/strict";
import { it } from "node:test";
import express, { type RequestHandler } from "express";
import { createPasspilotIndicatorRouter } from "../src/routes/passpilot/indicators.js";
import type { PasspilotIndicatorService } from "../src/services/passpilotIndicators.js";
import type { AddressInfo } from "node:net";
import { csrfProtection } from "../src/middleware/csrfProtection.js";

it("keeps state bearer-only, no-store, and aggregate-only while staff setup keeps its own authorization", async () => {
  const token = "ppi_" + "a".repeat(43);
  let polls = 0;
  const service: PasspilotIndicatorService = {
    state: async (value) => { assert.equal(value, token); polls++; return { version: 1, mask: 3, maxAgeSeconds: 30 }; },
    listKiosks: async (owner) => {
      assert.deepEqual(owner, { schoolId: "school-1", userId: "teacher-1" });
      return [{ kioskSessionId: "kiosk-1", className: null, lastSeenAt: "2026-11-20T12:00:00.000Z" }];
    },
    pair: async (owner, input) => {
      assert.deepEqual(owner, { schoolId: "school-1", userId: "teacher-1" });
      assert.deepEqual(input, "classId" in input ? { classId: "class-1" } : { kioskSessionId: "kiosk-1" });
      return { pairingId: "pair-1", token, expiresAt: "2026-12-17T00:00:00.000Z" };
    },
    revoke: async (owner, id) => owner.userId === "teacher-1" && id === "35370e6e-6f38-4c50-87c6-f97c38424aba",
  };
  const staff: RequestHandler = (req, res, next) => {
    if (req.get("x-test-staff") !== "yes") { res.status(401).end(); return; }
    req.authUser = { id: "teacher-1" } as typeof req.authUser;
    res.locals.schoolId = "school-1";
    next();
  };
  const app = express();
  app.use(express.json());
  app.use("/api/passpilot/indicators", createPasspilotIndicatorRouter(service, [staff]));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/passpilot/indicators`;
  try {
    const unauthorized = await fetch(`${url}/state`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${url}/state?token=${token}`)).status, 401);
    const state = await fetch(`${url}/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(state.status, 200);
    assert.equal(state.headers.get("cache-control"), "no-store");
    assert.deepEqual(await state.json(), { version: 1, mask: 3, maxAgeSeconds: 30 });
    assert.equal(polls, 1);
    assert.equal((await fetch(`${url}/pairings/kiosks`)).status, 401);
    const kiosks = await fetch(`${url}/pairings/kiosks`, { headers: { "x-test-staff": "yes" } });
    assert.equal(kiosks.status, 200);
    assert.equal(kiosks.headers.get("cache-control"), "no-store");
    assert.deepEqual(await kiosks.json(), { kiosks: [{ kioskSessionId: "kiosk-1", className: null, lastSeenAt: "2026-11-20T12:00:00.000Z" }] });
    assert.equal((await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ classId: "class-1" }) })).status, 401);
    const paired = await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json", "x-test-staff": "yes" }, body: JSON.stringify({ classId: "class-1" }) });
    assert.equal(paired.status, 201);
    assert.equal(paired.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json", "x-test-staff": "yes" }, body: JSON.stringify({ kioskSessionId: "kiosk-1" }) })).status, 201);
    assert.equal((await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json", "x-test-staff": "yes" }, body: JSON.stringify({ classId: "class-1", kioskSessionId: "kiosk-1" }) })).status, 400);
    assert.equal((await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json", "x-test-staff": "yes" }, body: JSON.stringify({ classId: "class-1", schoolId: "school-2" }) })).status, 400);
    assert.equal((await fetch(`${url}/pairings/35370e6e-6f38-4c50-87c6-f97c38424aba`, { method: "DELETE", headers: { "x-test-staff": "yes" } })).status, 204);
    assert.equal((await fetch(`${url}/pairings/615e1373-55b6-4474-aea5-9f2eb4f14ad0`, { method: "DELETE", headers: { "x-test-staff": "yes" } })).status, 404);
    for (let attempt = 0; attempt < 6; attempt++) {
      assert.equal((await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json", "x-test-staff": "yes" }, body: "{}" })).status, 400);
    }
    assert.equal((await fetch(`${url}/pairings`, { method: "POST", headers: { "content-type": "application/json", "x-test-staff": "yes" }, body: "{}" })).status, 429);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("requires CSRF for cookie-authenticated pairing and revocation", () => {
  for (const [method, path] of [["POST", "/passpilot/indicators/pairings"], ["DELETE", "/passpilot/indicators/pairings/pair-1"]]) {
    let status = 0;
    let passed = false;
    const res = { status(code: number) { status = code; return this; }, json() { return this; } };
    csrfProtection({ method, path, headers: {}, session: { userId: "teacher-1", csrfToken: "csrf" } } as Parameters<typeof csrfProtection>[0], res as Parameters<typeof csrfProtection>[1], () => { passed = true; });
    assert.equal(status, 403);
    assert.equal(passed, false);
  }
});
