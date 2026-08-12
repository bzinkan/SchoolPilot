import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RequestHandler } from "express";
import { rejectDisabledGoPilotParent } from "../src/middleware/rejectDisabledGoPilotParent.js";
import {
  GOPILOT_PARENT_PORTAL_DISABLED,
  canTransitionAuthorizedPickup,
  disabledGoPilotParentPortalHandler,
  isDisabledNativeGoPilotOAuthRedirect,
  isAuthorizedPickupManagerRole,
  rejectGoPilotParentRegistration,
  toAuthorizedPickupDto,
} from "../src/util/gopilotParentContainment.js";
import { effectiveGoPilotRole } from "../src/services/gopilotAccess.js";

async function runMiddleware(
  middleware: RequestHandler,
  request: Record<string, unknown>,
  locals: Record<string, unknown> = {}
) {
  let status = 200;
  let body: unknown;
  let nextCalls = 0;
  let nextError: unknown;
  const response = {
    locals,
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as any;
  await middleware(request as any, response, (error?: unknown) => {
    nextCalls += 1;
    nextError = error;
  });
  return { status, body, nextCalls, nextError };
}

describe("GoPilot parent containment", () => {
  it("rejects school-slug registration before any downstream validation or mutation", async () => {
    const known = await runMiddleware(rejectGoPilotParentRegistration, {
      body: { schoolSlug: "known-school", email: "known@example.invalid" },
    });
    const unknown = await runMiddleware(rejectGoPilotParentRegistration, {
      body: { schoolSlug: "missing-school", email: "unknown@example.invalid" },
    });

    assert.deepEqual(known, {
      status: 410,
      body: { code: GOPILOT_PARENT_PORTAL_DISABLED },
      nextCalls: 0,
      nextError: undefined,
    });
    assert.deepEqual(unknown, known, "school and account existence must not change the response");

    const staff = await runMiddleware(rejectGoPilotParentRegistration, {
      body: { schoolName: "Staff School", schoolSlug: "   " },
    });
    assert.equal(staff.nextCalls, 1, "staff school registration remains available");
    assert.equal(staff.body, undefined);
  });

  it("terminates retired child and linking surfaces without invoking data handlers", async () => {
    const first = await runMiddleware(disabledGoPilotParentPortalHandler, {
      params: { studentId: "student-that-exists" },
      body: { carNumber: "12" },
    });
    const second = await runMiddleware(disabledGoPilotParentPortalHandler, {
      params: { studentId: "student-that-does-not-exist" },
      body: { carNumber: "9999" },
    });

    assert.deepEqual(first, {
      status: 410,
      body: { code: GOPILOT_PARENT_PORTAL_DISABLED },
      nextCalls: 0,
      nextError: undefined,
    });
    assert.deepEqual(second, first, "child and car-number existence must not be disclosed");
  });

  it("rejects a historical parent role before a resource-specific handler runs", async () => {
    const existingTarget = await runMiddleware(
      rejectDisabledGoPilotParent,
      { params: { id: "known-pickup" } },
      { gopilotRole: "parent" }
    );
    const missingTarget = await runMiddleware(
      rejectDisabledGoPilotParent,
      { params: { id: "missing-pickup" } },
      { gopilotRole: "parent" }
    );

    assert.deepEqual(existingTarget, {
      status: 410,
      body: { code: GOPILOT_PARENT_PORTAL_DISABLED },
      nextCalls: 0,
      nextError: undefined,
    });
    assert.deepEqual(missingTarget, existingTarget);

    const staff = await runMiddleware(
      rejectDisabledGoPilotParent,
      { params: { id: "any" } },
      { gopilotRole: "office_staff" }
    );
    assert.equal(staff.nextCalls, 1);
  });

  it("treats a GoPilot parent override as authoritative over a base staff role", () => {
    assert.equal(
      effectiveGoPilotRole({ role: "admin", gopilotRole: "parent" } as any),
      "parent"
    );
    assert.equal(
      effectiveGoPilotRole({ role: "teacher", gopilotRole: "parent" } as any),
      "parent"
    );
    assert.equal(
      effectiveGoPilotRole({ role: "teacher", gopilotRole: null } as any),
      "teacher"
    );
  });

  it("keeps the device-bearing aggregate behind an exact ClassPilot/base-staff gate", () => {
    const compatSource = readFileSync(
      new URL("../src/routes/compat.ts", import.meta.url),
      "utf8"
    );
    const authStart = compatSource.indexOf("const classPilotStaffAuth = [");
    const authEnd = compatSource.indexOf("] as const;", authStart);
    const routeStart = compatSource.indexOf('router.get("/students-aggregated"');
    const routeEnd = compatSource.indexOf("// Export (ClassPilot)", routeStart);
    const auth = compatSource.slice(authStart, authEnd);
    const route = compatSource.slice(routeStart, routeEnd);
    assert.match(auth, /requireProductLicense\("CLASSPILOT"\)/);
    assert.match(auth, /requireRole\("admin", "school_admin", "office_staff", "teacher"\)/);
    assert.doesNotMatch(auth, /GOPILOT/);
    assert.match(route, /\.\.\.classPilotStaffAuth/);
    assert.match(route, /deviceId/);
  });

  it("does not let retained GoPilot links select ClassPilot digest recipients", () => {
    const schedulerSource = readFileSync(
      new URL("../src/services/scheduler.ts", import.meta.url),
      "utf8"
    );
    const competitiveSource = readFileSync(
      new URL("../src/routes/classpilot/competitive.ts", import.meta.url),
      "utf8"
    );
    const preview = competitiveSource.slice(
      competitiveSource.indexOf('router.get("/parent-digests/preview"'),
      competitiveSource.indexOf('// GET /api/classpilot/parent-digests/settings')
    );
    assert.doesNotMatch(schedulerSource, /sendParentTransparencyDigests/);
    assert.doesNotMatch(schedulerSource, /parentStudent|parent_student/);
    assert.match(preview, /recipients: \[\]/);
    assert.match(preview, /deliveryAvailable: false/);
    assert.doesNotMatch(preview, /getApprovedParentLinksForStudent/);
  });

  it("keeps the generic student route free of GoPilot roles and family metadata", () => {
    const studentSource = readFileSync(
      new URL("../src/routes/students.ts", import.meta.url),
      "utf8"
    );
    assert.match(studentSource, /requireProductLicense\("CLASSPILOT", "PASSPILOT"\)/);
    assert.doesNotMatch(studentSource, /getRequestGoPilotRole|hasActiveGoPilotLicense|getTeacherHomeroomIds/);
    assert.doesNotMatch(studentSource, /familyGroupStudents|familyGroups/);
    assert.match(
      studentSource,
      /router\.get\([\s\S]*?requireRole\("admin", "school_admin", "teacher", "office_staff"\)/
    );
  });

  it("marks GoPilot setup aliases and applies product-aware staff guards", () => {
    const routeIndex = readFileSync(
      new URL("../src/routes/index.ts", import.meta.url),
      "utf8"
    );
    const usersSource = readFileSync(
      new URL("../src/routes/users.ts", import.meta.url),
      "utf8"
    );
    const directorySource = readFileSync(
      new URL("../src/routes/google/directory.ts", import.meta.url),
      "utf8"
    );
    for (const guardedSource of [usersSource, directorySource]) {
      assert.match(guardedSource, /goPilotSetup/);
      assert.match(guardedSource, /getRequestGoPilotRole/);
      assert.match(guardedSource, /hasActiveGoPilotLicense|requireProductLicense/);
    }
    assert.match(routeIndex, /delete req\.headers\["x-gopilot-setup"\]/);
    assert.match(routeIndex, /res\.locals\.goPilotSetup = true/);
    assert.doesNotMatch(usersSource, /req\.headers\["x-gopilot-setup"\]/);
    assert.doesNotMatch(directorySource, /req\.headers\["x-gopilot-setup"\]|req\.body\?\.source === "gopilot_setup"/);
  });

  it("requires strict sanitized audit records for GoPilot staff mutations", () => {
    const usersSource = readFileSync(new URL("../src/routes/users.ts", import.meta.url), "utf8");
    for (const action of ["gopilot.staff.created", "gopilot.staff.updated", "gopilot.staff.removed"]) {
      assert.match(usersSource, new RegExp(action.replaceAll(".", "\\.")));
    }
    assert.match(usersSource, /logAuditStrict/);
    assert.doesNotMatch(usersSource, /changes:\s*req\.body|metadata:\s*req\.body/);
  });

  it("never issues OAuth codes to the retired unverified GoPilot custom scheme", () => {
    assert.equal(isDisabledNativeGoPilotOAuthRedirect("/gopilot"), true);
    assert.equal(isDisabledNativeGoPilotOAuthRedirect("/gopilot/teacher"), true);
    assert.equal(isDisabledNativeGoPilotOAuthRedirect("/classpilot"), false);
    assert.equal(isDisabledNativeGoPilotOAuthRedirect(""), false);

    const authSource = readFileSync(
      new URL("../src/routes/auth.ts", import.meta.url),
      "utf8"
    );
    assert.doesNotMatch(authSource, /com\.schoolpilot\.gopilot:\/\/auth\/callback/);
    assert.match(authSource, /GOPILOT_NATIVE_OAUTH_DISABLED/);
  });
});

describe("staff-managed authorized pickups", () => {
  it("admits only school administrators and office staff", () => {
    assert.equal(isAuthorizedPickupManagerRole("admin"), true);
    assert.equal(isAuthorizedPickupManagerRole("school_admin"), true);
    assert.equal(isAuthorizedPickupManagerRole("office_staff"), true);
    assert.equal(isAuthorizedPickupManagerRole("teacher"), false);
    assert.equal(isAuthorizedPickupManagerRole("parent"), false);
    assert.equal(isAuthorizedPickupManagerRole("super_admin"), false);
    assert.equal(isAuthorizedPickupManagerRole(null), false);
  });

  it("enforces monotonic pending, approved, and revoked transitions", () => {
    assert.equal(canTransitionAuthorizedPickup("pending", "pending"), true);
    assert.equal(canTransitionAuthorizedPickup("pending", "approved"), true);
    assert.equal(canTransitionAuthorizedPickup("pending", "revoked"), true);
    assert.equal(canTransitionAuthorizedPickup("approved", "approved"), true);
    assert.equal(canTransitionAuthorizedPickup("approved", "revoked"), true);
    assert.equal(canTransitionAuthorizedPickup("approved", "pending"), false);
    assert.equal(canTransitionAuthorizedPickup("revoked", "revoked"), true);
    assert.equal(canTransitionAuthorizedPickup("revoked", "approved"), false);
    assert.equal(canTransitionAuthorizedPickup("revoked", "pending"), false);
  });

  it("returns an explicit DTO and drops secret or device fields", () => {
    const dto = toAuthorizedPickupDto({
      id: "pickup-1",
      studentId: "student-1",
      name: "Trusted Adult",
      relationship: "Grandparent",
      phone: "555-0100",
      photoUrl: null,
      status: "approved",
      createdAt: new Date("2026-08-12T12:00:00.000Z"),
      classpilotPinHash: "must-not-leak",
      classpilotPinEncrypted: "must-not-leak",
      deviceId: "must-not-leak",
      addedBy: "internal-user-id",
    } as any);

    assert.deepEqual(Object.keys(dto).sort(), [
      "createdAt",
      "id",
      "name",
      "phone",
      "photoUrl",
      "relationship",
      "status",
      "studentId",
    ]);
    assert.equal("classpilotPinHash" in dto, false);
    assert.equal("classpilotPinEncrypted" in dto, false);
    assert.equal("deviceId" in dto, false);
    assert.equal("addedBy" in dto, false);
  });

  it("serializes pickup transitions under a tenant-scoped row lock", () => {
    const storageSource = readFileSync(
      new URL("../src/services/storage.ts", import.meta.url),
      "utf8"
    );
    const pickupSource = readFileSync(
      new URL("../src/routes/gopilot/pickups.ts", import.meta.url),
      "utf8"
    );
    const transition = storageSource.slice(
      storageSource.indexOf("export async function transitionAuthorizedPickupStatus"),
      storageSource.indexOf("// ============================================================================\n// GoPilot - Custody Alerts")
    );

    assert.match(transition, /eq\(authorizedPickups\.schoolId, schoolId\)/);
    assert.match(transition, /\.for\("update"\)/);
    assert.match(transition, /eq\(authorizedPickups\.status, current\.status\)/);

    const putRoute = pickupSource.slice(
      pickupSource.indexOf("router.put(\"/:id\""),
      pickupSource.indexOf("router.delete(\"/:id\"")
    );
    const deleteRoute = pickupSource.slice(
      pickupSource.indexOf("router.delete(\"/:id\""),
      pickupSource.indexOf("// ============================================================================\n// Custody Alerts")
    );
    assert.match(putRoute, /transitionAuthorizedPickupStatus/);
    assert.match(deleteRoute, /transitionAuthorizedPickupStatus/);
  });
});
