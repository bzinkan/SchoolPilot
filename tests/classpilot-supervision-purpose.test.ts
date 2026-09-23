import { test } from "node:test";
import assert from "node:assert/strict";
import { supervisionActivityPresentation } from "../src/services/classpilotSupervisionPurpose.js";

const context = { name: "Saved MAP test group", contextType: "supervision_group", scheduledConflictId: null,
  scheduleProfileApplicationId: null, scheduleProfileDate: null, scheduleProfileBlockId: null };

test("saved group names do not activate testing and only proven legacy pickups receive the neutral label", () => {
  assert.deepEqual(supervisionActivityPresentation(context, [{ source: "staff_claim" }, { source: "admin_assign" }]),
    { purpose: "claim", contextType: "supervision_group", name: "Claimed students" });
  assert.equal(supervisionActivityPresentation(context).purpose, "supervision");
  assert.equal(supervisionActivityPresentation(context, [{ source: "staff_claim" }, { source: "teacher_send" }]).name, context.name);
  assert.equal(supervisionActivityPresentation({ ...context, contextType: "direct_pickup" }).purpose, "claim");
  assert.equal(supervisionActivityPresentation({ ...context, scheduleProfileApplicationId: "incomplete" },
    [{ source: "staff_claim" }]).purpose, "supervision");
});

test("explicit manual testing and scheduled authority take precedence over claim-looking assignment sources", () => {
  for (const testing of [{ ...context, contextType: "state_testing" }, { ...context,
    scheduleProfileApplicationId: "application", scheduleProfileDate: "2026-09-22", scheduleProfileBlockId: "block" }]) {
    assert.equal(supervisionActivityPresentation(testing, [{ source: "staff_claim" }]).purpose, "testing");
    assert.equal(supervisionActivityPresentation(testing, [{ source: "staff_claim" }]).name, context.name);
  }
  assert.equal(supervisionActivityPresentation({ ...context, scheduledConflictId: "conflict" }, [{ source: "staff_claim" }]).purpose, "coverage");
});
