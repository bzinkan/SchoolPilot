import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerifiedSchoolIdentities,
  identityHasAnyRole,
  primaryRoleFromRoles,
} from "../src/services/schoolIdentityModel.js";

function row(input: {
  id: string;
  userId?: string;
  schoolId: string;
  role: string;
  createdAt: string;
  deletedAt?: Date | null;
}) {
  return {
    membership: {
      id: input.id,
      userId: input.userId ?? "user-1",
      schoolId: input.schoolId,
      role: input.role,
      status: "active",
      carNumber: null,
      kioskName: null,
      gopilotRole: null,
      createdAt: new Date(input.createdAt),
    },
    school: {
      id: input.schoolId,
      name: input.schoolId,
      deletedAt: input.deletedAt ?? null,
    },
  } as any;
}

describe("canonical school identity", () => {
  it("authorizes all active roles while selecting one deterministic display role", () => {
    const [identity] = buildVerifiedSchoolIdentities([
      row({ id: "teacher", schoolId: "school-a", role: "teacher", createdAt: "2025-01-01" }),
      row({ id: "office", schoolId: "school-a", role: "office_staff", createdAt: "2025-01-02" }),
    ]);

    assert.deepEqual(identity?.roles, ["office_staff", "teacher"]);
    assert.equal(identity?.primaryRole, "office_staff");
    assert.equal(identityHasAnyRole(identity!, ["teacher"]), true);
    assert.equal(identityHasAnyRole(identity!, ["admin"]), false);
  });

  it("is independent of database row order and sorts schools deterministically", () => {
    const rows = [
      row({ id: "b", schoolId: "school-b", role: "teacher", createdAt: "2025-02-01" }),
      row({ id: "a2", schoolId: "school-a", role: "teacher", createdAt: "2025-01-02" }),
      row({ id: "a1", schoolId: "school-a", role: "admin", createdAt: "2025-01-01" }),
    ];
    const forward = buildVerifiedSchoolIdentities(rows);
    const reverse = buildVerifiedSchoolIdentities([...rows].reverse());

    assert.deepEqual(
      forward.map(({ schoolId, roles, primaryRole }) => ({ schoolId, roles, primaryRole })),
      reverse.map(({ schoolId, roles, primaryRole }) => ({ schoolId, roles, primaryRole }))
    );
    assert.deepEqual(forward.map(({ schoolId }) => schoolId), ["school-a", "school-b"]);
  });

  it("uses the documented display-role priority", () => {
    assert.equal(primaryRoleFromRoles(["parent", "teacher", "school_admin"]), "school_admin");
  });
});
