import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  envFlag,
  intEnv,
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

    assert.equal(migrationsOnStartup({}), true);
    assert.equal(migrationsOnStartup({ RUN_MIGRATIONS_ON_STARTUP: "off" }), false);
    assert.equal(migrationsOnly({}), false);
    assert.equal(migrationsOnly({ RUN_MIGRATIONS_ONLY: "true" }), true);
  });

  it("parses integers without accepting invalid pool caps", () => {
    assert.equal(intEnv("DB_POOL_MAX", 50, {}), 50);
    assert.equal(intEnv("DB_POOL_MAX", 50, { DB_POOL_MAX: "20" }), 20);
    assert.equal(intEnv("DB_POOL_MAX", 50, { DB_POOL_MAX: "0" }), 50);
    assert.equal(intEnv("DB_POOL_MAX", 50, { DB_POOL_MAX: "-4" }), 50);
    assert.equal(intEnv("DB_POOL_MAX", 50, { DB_POOL_MAX: "not-a-number" }), 50);
  });

  it("treats only explicit truthy strings as true", () => {
    assert.equal(envFlag("FLAG", true, {}), true);
    assert.equal(envFlag("FLAG", false, { FLAG: "1" }), true);
    assert.equal(envFlag("FLAG", false, { FLAG: "on" }), true);
    assert.equal(envFlag("FLAG", true, { FLAG: "no" }), false);
  });
});
