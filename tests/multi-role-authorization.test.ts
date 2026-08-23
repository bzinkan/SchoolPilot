import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  buildVerifiedSchoolIdentities,
} from "../src/services/schoolIdentityModel.js";
import {
  requestHasAnySchoolRole,
  selectRequestSchoolRole,
} from "../src/services/schoolAuthorization.js";
import {
  selectClasspilotStaffSocketRole,
} from "../src/services/classpilotWebSocketAuthorization.js";
import {
  capabilitiesForGoPilotRoles,
  goPilotIdentityHasAnyRole,
  goPilotRolesFromMemberships,
} from "../src/services/gopilotAccess.js";

function membershipRow(id: string, role: string) {
  return {
    membership: {
      id,
      userId: "user-1",
      schoolId: "school-1",
      role,
      status: "active",
      createdAt: new Date(`2026-01-0${id === "office" ? "1" : "2"}T00:00:00.000Z`),
    },
    school: { id: "school-1", deletedAt: null },
  };
}

function requestContext(identity: ReturnType<typeof buildVerifiedSchoolIdentities>[number]) {
  return {
    req: { authUser: { id: "user-1", isSuperAdmin: false } },
    res: {
      locals: {
        schoolId: "school-1",
        schoolIdentity: identity,
        // This stays office_staff for compatibility and is deliberately not
        // the authority source used by the helpers below.
        membershipRole: identity.primaryRole,
      },
    },
  };
}

describe("canonical multi-role authorization", () => {
  it("grants teacher authority to office_staff + teacher without changing display role", () => {
    for (const rows of [
      [membershipRow("office", "office_staff"), membershipRow("teacher", "teacher")],
      [membershipRow("teacher", "teacher"), membershipRow("office", "office_staff")],
    ]) {
      const [identity] = buildVerifiedSchoolIdentities(rows);
      assert.ok(identity);
      const { req, res } = requestContext(identity);

      assert.equal(identity.primaryRole, "office_staff");
      assert.equal(res.locals.membershipRole, "office_staff");
      assert.equal(requestHasAnySchoolRole(req, res, ["teacher"]), true);
      assert.equal(requestHasAnySchoolRole(req, res, ["admin", "school_admin"]), false);
      assert.equal(
        selectRequestSchoolRole(req, res, ["admin", "school_admin", "teacher", "office_staff"]),
        "teacher"
      );
    }
  });

  it("fails closed for stale provenance and never authorizes from singular display role", () => {
    const [identity] = buildVerifiedSchoolIdentities([
      membershipRow("teacher", "teacher"),
    ]);
    assert.ok(identity);

    assert.equal(requestHasAnySchoolRole(
      { authUser: { id: "different-user", isSuperAdmin: false } },
      { locals: { schoolId: "school-1", schoolIdentity: identity } },
      ["teacher"]
    ), false);
    assert.equal(requestHasAnySchoolRole(
      { authUser: { id: "user-1", isSuperAdmin: false } },
      { locals: { schoolId: "school-1", membershipRole: "teacher" } },
      ["teacher"]
    ), false);
  });

  it("selects ClassPilot realtime authority independently of membership row order", () => {
    assert.equal(
      selectClasspilotStaffSocketRole(
        ["office_staff", "teacher"],
        { entitled: true, isSuperAdmin: false }
      ),
      "teacher"
    );
    assert.equal(
      selectClasspilotStaffSocketRole(
        ["teacher", "office_staff"],
        { entitled: true, isSuperAdmin: false }
      ),
      "teacher"
    );
  });

  it("unions GoPilot capabilities and role gates rather than using primaryRole only", () => {
    const forward = [
      { role: "teacher", gopilotRole: null },
      { role: "teacher", gopilotRole: "office_staff" },
    ];
    const reverse = [...forward].reverse();
    assert.deepEqual(goPilotRolesFromMemberships(forward), ["office_staff", "teacher"]);
    assert.deepEqual(goPilotRolesFromMemberships(reverse), ["office_staff", "teacher"]);
    const identity = {
      primaryRole: "office_staff" as const,
      roles: ["office_staff", "teacher"] as const,
    };
    assert.equal(goPilotIdentityHasAnyRole(identity, ["teacher"]), true);
    assert.deepEqual(
      capabilitiesForGoPilotRoles(identity.roles),
      capabilitiesForGoPilotRoles([...identity.roles].reverse())
    );
    assert.equal(capabilitiesForGoPilotRoles(identity.roles).manageDismissal, true);
    assert.equal(capabilitiesForGoPilotRoles(identity.roles).teacherAttendance, true);
  });

  it("keeps named route-local gates on the canonical helper", async () => {
    const files = [
      "../src/routes/classpilot/commands.ts",
      "../src/routes/classpilot/coverage.ts",
      "../src/routes/classpilot/sessions.ts",
      "../src/routes/classpilot/monitoringEvents.ts",
      "../src/routes/google/oauth.ts",
    ];
    for (const file of files) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      assert.match(source, /requestHasAnySchoolRole/);
    }
  });
});
