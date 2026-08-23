import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequireGopilotEntitlement } from "../src/middleware/requireGopilotEntitlement.js";
import {
  gopilotSchoolEntitlementReason,
  isGopilotSchoolActive,
} from "../src/services/gopilotEntitlement.js";

const now = new Date("2026-08-22T12:00:00.000Z");
const activeSchool = {
  status: "active",
  isActive: true,
  planStatus: "active",
  activeUntil: new Date("2026-08-23T12:00:00.000Z"),
  disabledAt: null,
  deletedAt: null,
};

describe("canonical GoPilot entitlement", () => {
  it("classifies every school lifecycle revocation deterministically", () => {
    assert.equal(isGopilotSchoolActive(activeSchool, now), true);
    assert.equal(gopilotSchoolEntitlementReason({
      ...activeSchool,
      status: "suspended",
    }, now), "school_inactive");
    assert.equal(gopilotSchoolEntitlementReason({
      ...activeSchool,
      isActive: false,
    }, now), "school_inactive");
    assert.equal(gopilotSchoolEntitlementReason({
      ...activeSchool,
      disabledAt: new Date("2026-08-22T11:00:00.000Z"),
    }, now), "school_inactive");
    assert.equal(gopilotSchoolEntitlementReason({
      ...activeSchool,
      deletedAt: new Date("2026-08-22T11:00:00.000Z"),
    }, now), "school_inactive");
    assert.equal(gopilotSchoolEntitlementReason({
      ...activeSchool,
      planStatus: "canceled",
    }, now), "plan_canceled");
    assert.equal(gopilotSchoolEntitlementReason({
      ...activeSchool,
      activeUntil: now,
    }, now), "access_expired");
  });

  it("returns the stable HTTP denial contract without a super-admin bypass", async () => {
    const middleware = createRequireGopilotEntitlement(async (schoolId) => ({
      schoolId,
      entitled: false,
      reason: "license_inactive",
    }));
    let status = 0;
    let body: unknown;
    let nextCalls = 0;
    const response = {
      locals: { schoolId: "school-a" },
      status(value: number) {
        status = value;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };
    await middleware({ authUser: { isSuperAdmin: true } } as any, response as any, () => {
      nextCalls += 1;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(status, 403);
    assert.deepEqual(body, {
      error: "School is not entitled to GoPilot",
      code: "GOPILOT_NOT_ENTITLED",
      reason: "license_inactive",
    });
    assert.equal(nextCalls, 0);
  });
});
