import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSensitiveNoStorePath } from "../src/util/noStorePath.js";

describe("sensitive response caching policy", () => {
  it("covers auth, ClassPilot, kiosk, and chat surfaces", () => {
    for (const path of [
      "/api/auth/exchange-code",
      "/api/classpilot/teaching-sessions/session/report",
      "/api/device/heartbeat",
      "/api/tiles/screenshots",
      "/api/passpilot/kiosk/snapshot",
      "/api/kiosk/config",
      "/api/chat/conversations",
      "/api/ai-chat/message",
    ]) {
      assert.equal(isSensitiveNoStorePath(path), true, path);
    }
  });

  it("does not override unrelated public cache policy", () => {
    assert.equal(isSensitiveNoStorePath("/livez"), false);
    assert.equal(isSensitiveNoStorePath("/client-config.json"), false);
  });
});
