import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classpilotLiveViewSignalingEnabled,
  envFlag,
  intEnv,
  legacyMigrationsOnly,
  migrationsOnStartup,
  migrationsOnly,
  schedulerEnabled,
} from "../dist/config/runtime.js";

describe("runtime config", () => {
  it("parses feature flags with safe defaults", () => {
    assert.equal(schedulerEnabled({}), true);
    assert.equal(schedulerEnabled({ SCHEDULER_ENABLED: "false" }), false);
    assert.equal(schedulerEnabled({ SCHEDULER_ENABLED: "0" }), false);
    assert.equal(schedulerEnabled({ SCHEDULER_ENABLED: "yes" }), true);

    assert.equal(migrationsOnStartup({}), false);
    assert.equal(migrationsOnStartup({ RUN_MIGRATIONS_ON_STARTUP: "on" }), true);
    assert.equal(migrationsOnStartup({ RUN_MIGRATIONS_ON_STARTUP: "off" }), false);
    assert.equal(migrationsOnly({}), false);
    assert.equal(migrationsOnly({ RUN_MIGRATIONS_ONLY: "true" }), true);
    assert.equal(legacyMigrationsOnly({}), false);
    assert.equal(legacyMigrationsOnly({ RUN_LEGACY_MIGRATIONS_ONLY: "true" }), true);
  });

  it("parses integers without accepting invalid pool caps", () => {
    assert.equal(intEnv("DB_POOL_MAX", 50, {}), 50);
    assert.equal(intEnv("DB_POOL_MAX", 50, { DB_POOL_MAX: "20" }), 20);
    assert.equal(intEnv("DB_POOL_MAX", 50, { DB_POOL_MAX: "0" }), 50);
    assert.equal(intEnv("DB_POOL_MAX", 50, { DB_POOL_MAX: "-4" }), 50);
    assert.equal(intEnv("DB_POOL_MAX", 50, { DB_POOL_MAX: "not-a-number" }), 50);
  });

  it("keeps legacy Live View signaling off unless explicitly enabled", () => {
    assert.equal(classpilotLiveViewSignalingEnabled({}), false);
    for (const value of ["", "0", "false", "off", "no", "enabled", "maybe"]) {
      assert.equal(
        classpilotLiveViewSignalingEnabled({ CLASSPILOT_LIVE_VIEW_SIGNALING_ENABLED: value }),
        false,
        `CLASSPILOT_LIVE_VIEW_SIGNALING_ENABLED=${JSON.stringify(value)} must stay off`
      );
    }
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      assert.equal(classpilotLiveViewSignalingEnabled({ CLASSPILOT_LIVE_VIEW_SIGNALING_ENABLED: value }), true);
    }
    // Only the exact name counts; other Live View flags never enable it.
    assert.equal(classpilotLiveViewSignalingEnabled({ CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1: "true" }), false);
  });

  it("treats only explicit truthy strings as true", () => {
    assert.equal(envFlag("FLAG", true, {}), true);
    assert.equal(envFlag("FLAG", false, { FLAG: "1" }), true);
    assert.equal(envFlag("FLAG", false, { FLAG: "on" }), true);
    assert.equal(envFlag("FLAG", true, { FLAG: "no" }), false);
  });
});
