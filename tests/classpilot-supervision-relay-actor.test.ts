import assert from "node:assert/strict";
import { test } from "node:test";
import { CLASSPILOT_SUPERVISION_ADMIN_COMMAND_TYPES, classpilotSupervisionRelayActorAllowed } from "../src/services/classpilotCommandDelivery.js";

const scope = { actorId: "actor", assignedStaffId: "assigned", commandType: "open-tab", activeMembershipRole: null, isSuperAdmin: false };

test("supervision relay retains exactly the existing nine admin command exceptions", () => {
  assert.deepEqual([...CLASSPILOT_SUPERVISION_ADMIN_COMMAND_TYPES], ["open-tab", "close-tabs", "lock-screen", "unlock-screen", "teacher-message",
    "apply-flight-path", "remove-flight-path", "apply-block-list", "remove-block-list"]);
  for (const commandType of CLASSPILOT_SUPERVISION_ADMIN_COMMAND_TYPES) {
    for (const activeMembershipRole of ["admin", "school_admin"]) {
      assert.equal(classpilotSupervisionRelayActorAllowed({ ...scope, commandType, activeMembershipRole }), true);
    }
    assert.equal(classpilotSupervisionRelayActorAllowed({ ...scope, commandType, isSuperAdmin: true }), true);
    assert.equal(classpilotSupervisionRelayActorAllowed({ ...scope, commandType, activeMembershipRole: "teacher" }), false);
    assert.equal(classpilotSupervisionRelayActorAllowed({ ...scope, commandType }), false, "inactive or absent membership confers no admin authority");
  }
});

test("wider classroom tools require the current assigned active staff member", () => {
  for (const commandType of ["activate-tab", "focus-tab", "stop-focus", "poll", "timer", "lesson-activity"]) {
    assert.equal(classpilotSupervisionRelayActorAllowed({ ...scope, commandType, activeMembershipRole: "admin" }), false);
    assert.equal(classpilotSupervisionRelayActorAllowed({ ...scope, commandType, isSuperAdmin: true }), false);
    assert.equal(classpilotSupervisionRelayActorAllowed({ ...scope, commandType, actorId: "assigned", activeMembershipRole: "teacher" }), true);
    assert.equal(classpilotSupervisionRelayActorAllowed({ ...scope, commandType, actorId: "assigned" }), false);
  }
});
