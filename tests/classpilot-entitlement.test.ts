import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { activeStaffWebSocketRole } from "../src/realtime/websocket.js";
import { isClasspilotSchoolActive } from "../src/services/classpilotEntitlement.js";

describe("ClassPilot realtime entitlement", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const activeSchool = {
    status: "active",
    isActive: true,
    planStatus: "active",
    activeUntil: new Date("2026-08-20T12:00:00.000Z"),
    disabledAt: null,
    deletedAt: null,
  };

  it("treats disabled_at as an immediate school revocation", () => {
    assert.equal(isClasspilotSchoolActive(activeSchool, now), true);
    assert.equal(isClasspilotSchoolActive({
      ...activeSchool,
      disabledAt: new Date("2026-08-19T11:59:59.000Z"),
    }, now), false);
  });

  it("requires current entitlement for ordinary staff membership", async () => {
    const client = {
      role: "teacher" as const,
      schoolId: "school-1",
      userId: "teacher-1",
    };
    assert.equal(await activeStaffWebSocketRole(
      client,
      async () => ({ role: "teacher" }),
      async () => ({ entitled: false })
    ), null);
    assert.equal(await activeStaffWebSocketRole(
      client,
      async () => ({ role: "teacher" }),
      async () => ({ entitled: true })
    ), "teacher");
  });

  it("does not let super-admin bypass a revoked school entitlement", async () => {
    let membershipChecks = 0;
    const resolveMembership = async () => {
      membershipChecks += 1;
      return undefined;
    };
    const client = {
      role: "super_admin" as const,
      schoolId: "school-1",
      userId: "super-1",
    };
    assert.equal(await activeStaffWebSocketRole(
      client,
      resolveMembership,
      async () => ({ entitled: false })
    ), null);
    assert.equal(await activeStaffWebSocketRole(
      client,
      resolveMembership,
      async () => ({ entitled: true })
    ), "super_admin");
    assert.equal(membershipChecks, 0);
  });

  it("revalidates entitlement at staff auth, pong, and message boundaries", async () => {
    const source = await readFile(
      new URL("../src/realtime/websocket.ts", import.meta.url),
      "utf8"
    );
    assert.match(source, /const role = await activeStaffWebSocketRole\(\{/);
    assert.match(source, /job: "staffWebSocketPongRevalidation"/);
    assert.match(source, /job: "staffWebSocketMessageRevalidation"/);
    assert.doesNotMatch(source, /client\.role === "super_admin" \|\| staffPongRevalidation/);
    assert.doesNotMatch(source, /client\.role !== "super_admin" &&\s*message\.type !== "auth"/);
  });
});
