import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getToolsForContext } from "../dist/services/chatTools.js";

process.env.DATABASE_URL ||= "postgres://postgres:test@localhost:5432/schoolpilot_test";

async function loadExecuteTool() {
  const mod = await import("../dist/services/chatToolExecutor.js");
  return mod.executeTool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPassDurationDescription(tool: unknown): string {
  assert.ok(isRecord(tool));
  assert.ok(isRecord(tool.input_schema));
  assert.ok(isRecord(tool.input_schema.properties));
  assert.ok(isRecord(tool.input_schema.properties.duration));
  const description = tool.input_schema.properties.duration.description;
  if (typeof description !== "string") {
    assert.fail("issue_pass duration description must be a string");
  }
  return description;
}

describe("AI chat tool privacy and authorization", () => {
  it("does not expose individual browsing history to AI chat", async () => {
    const { toolMeta } = getToolsForContext("teacher", ["CLASSPILOT"]);
    const executeTool = await loadExecuteTool();

    assert.equal(toolMeta.has("get_student_browsing_history"), false);

    const result = await executeTool(
      "get_student_browsing_history",
      { studentId: "student-1" },
      {
        userId: "user-1",
        schoolId: "school-1",
        schoolName: "current school",
        userName: "current user",
        userRole: "teacher",
        licensedProducts: ["CLASSPILOT"],
        getTranscript: () => "",
      }
    );

    assert.equal(result.success, false);
    assert.match(result.error || "", /not authorized/);
  });

  it("denies product tools when the school lacks the matching license", async () => {
    const executeTool = await loadExecuteTool();
    const result = await executeTool(
      "list_classes",
      {},
      {
        userId: "user-1",
        schoolId: "school-1",
        schoolName: "current school",
        userName: "current user",
        userRole: "teacher",
        licensedProducts: [],
        getTranscript: () => "",
      }
    );

    assert.equal(result.success, false);
    assert.match(result.error || "", /not authorized/);
  });

  it("gives PassPilot-only teachers an authorized class inventory for pass issuance", () => {
    const { tools, toolMeta } = getToolsForContext("teacher", ["PASSPILOT"]);

    assert.equal(toolMeta.has("list_passpilot_classes"), true);
    assert.equal(toolMeta.has("issue_pass"), true);
    assert.equal(toolMeta.has("list_classes"), false);

    const issuePass = tools.find((tool) => tool.name === "issue_pass");
    const durationDescription = getPassDurationDescription(issuePass);
    assert.match(durationDescription, /optional overdue threshold override/i);
    assert.match(durationDescription, /school's PassPilot setting/i);
    assert.doesNotMatch(durationDescription, /default:\s*5/i);
  });
});
