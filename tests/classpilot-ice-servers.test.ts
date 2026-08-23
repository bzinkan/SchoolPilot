import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClasspilotIceConfiguration } from "../src/services/classpilotIceServers.js";
import { readFileSync } from "node:fs";

describe("ClassPilot short-lived ICE configuration", () => {
  it("returns both TURN nodes and UDP/TCP/TURNS without identifying usernames", () => {
    const now = Date.parse("2026-08-22T12:00:00.000Z");
    const result = createClasspilotIceConfiguration({
      negotiationId: "signed-negotiation-containing-no-public-identifiers",
      negotiationExpiresAt: now + 15 * 60_000,
      now,
      env: {
        CLASSPILOT_TURN_HOSTS: "turn-a.example.test,turn-b.example.test",
        CLASSPILOT_TURN_REST_SECRET: "test-secret",
        CLASSPILOT_STUN_URLS: "stun:stun.example.test:3478",
      },
    });
    assert.ok(result);
    assert.equal(result.iceServers.length, 3);
    assert.deepEqual(result.iceServers[1]?.urls, [
      "turn:turn-a.example.test:3478?transport=udp",
      "turn:turn-a.example.test:3478?transport=tcp",
      "turns:turn-a.example.test:443?transport=tcp",
    ]);
    assert.match(result.iceServers[1]?.username || "", /^\d+:[A-Za-z0-9_-]{32}$/);
    assert.equal(result.expiresAt, "2026-08-22T12:10:00.000Z");
  });

  it("stays unavailable until two nodes and the REST secret are configured", () => {
    assert.equal(createClasspilotIceConfiguration({
      negotiationId: "negotiation",
      negotiationExpiresAt: Date.now() + 60_000,
      env: { CLASSPILOT_TURN_HOSTS: "only-one.example.test" },
    }), null);
  });

  it("requires the signed negotiation to remain actively claimed before issuing credentials", () => {
    const route = readFileSync("src/routes/classpilot/devices.ts", "utf8");
    const start = route.indexOf('"/device/live-view/ice-servers"');
    const end = route.indexOf('// POST /api/classpilot/device/heartbeat', start);
    const handler = route.slice(start, end);
    assert.match(handler, /classpilotLiveViewNegotiationAuthority/);
    assert.match(handler, /isClasspilotLiveViewNegotiationActive\(exactBinding, negotiationId\)/);
    assert.match(handler, /LIVE_VIEW_NEGOTIATION_SUPERSEDED/);
  });
});
