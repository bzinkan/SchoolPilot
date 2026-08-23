import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeEntitledProducts } from "../src/services/productEntitlement.js";

const activeSchool = {
  status: "active",
  isActive: true,
  planStatus: "active",
  activeUntil: null,
  disabledAt: null,
  deletedAt: null,
};

describe("canonical product entitlement projection", () => {
  it("requires an active school lifecycle and unexpired active licenses", () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    assert.deepEqual(activeEntitledProducts({
      school: activeSchool,
      now,
      licenses: [
        { product: "CLASSPILOT", status: "active", expiresAt: null },
        { product: "GOPILOT", status: "active", expiresAt: new Date("2026-08-23T00:00:00.000Z") },
        { product: "PASSPILOT", status: "active", expiresAt: new Date("2026-08-22T11:59:59.000Z") },
        { product: "MAILPILOT", status: "inactive", expiresAt: null },
      ],
    }), ["CLASSPILOT", "GOPILOT"]);
  });

  it("returns no products after any school lifecycle revocation", () => {
    const license = [{ product: "CLASSPILOT", status: "active", expiresAt: null }];
    for (const school of [
      { ...activeSchool, status: "suspended" },
      { ...activeSchool, isActive: false },
      { ...activeSchool, planStatus: "canceled" },
      { ...activeSchool, disabledAt: new Date() },
      { ...activeSchool, deletedAt: new Date() },
      { ...activeSchool, activeUntil: new Date("2026-08-21T00:00:00.000Z") },
    ]) {
      assert.deepEqual(activeEntitledProducts({
        school,
        licenses: license,
        now: new Date("2026-08-22T00:00:00.000Z"),
      }), []);
    }
  });
});
