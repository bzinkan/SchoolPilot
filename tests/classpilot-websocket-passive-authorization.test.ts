import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLASSPILOT_PASSIVE_AUTH_TTL_MS,
  hasFreshPassiveWebSocketAuthorization,
  invalidatePassiveWebSocketAuthorizationLocal,
  mayUsePassiveWebSocketAuthorizationCache,
} from "../src/realtime/websocket.js";
import { selectClasspilotStaffSocketRole } from "../src/services/classpilotWebSocketAuthorization.js";

describe("ClassPilot passive WebSocket authorization", () => {
  it("expires after 30 seconds and invalidates immediately by school generation", () => {
    const schoolId = `passive-auth-${Date.now()}`;
    const now = Date.now();
    const client = {
      schoolId,
      passiveAuthorizationExpiresAt: now + CLASSPILOT_PASSIVE_AUTH_TTL_MS,
      passiveAuthorizationGeneration: 0,
    };

    assert.equal(hasFreshPassiveWebSocketAuthorization(client, now), true);
    assert.equal(
      hasFreshPassiveWebSocketAuthorization(
        client,
        now + CLASSPILOT_PASSIVE_AUTH_TTL_MS
      ),
      false
    );
    invalidatePassiveWebSocketAuthorizationLocal(schoolId);
    assert.equal(hasFreshPassiveWebSocketAuthorization(client, now), false);
  });

  it("never serves a student passive frame from the authorization TTL cache", () => {
    assert.equal(mayUsePassiveWebSocketAuthorizationCache("student"), false);
    for (const role of ["teacher", "office_staff", "school_admin", "super_admin"] as const) {
      assert.equal(mayUsePassiveWebSocketAuthorizationCache(role), true);
    }
  });

  it("chooses a canonical role independent of membership row order", () => {
    const forward = ["teacher", "office_staff", "school_admin"];
    const reversed = [...forward].reverse();
    assert.equal(
      selectClasspilotStaffSocketRole(forward, { entitled: true, isSuperAdmin: false }),
      "school_admin"
    );
    assert.equal(
      selectClasspilotStaffSocketRole(reversed, { entitled: true, isSuperAdmin: false }),
      "school_admin"
    );
    assert.equal(
      selectClasspilotStaffSocketRole(["school_admin"], { entitled: false, isSuperAdmin: true }),
      null
    );
  });
});
