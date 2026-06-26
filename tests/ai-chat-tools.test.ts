import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getToolsForContext } from "../dist/services/chatTools.js";

process.env.DATABASE_URL ||= "postgres://postgres:test@localhost:5432/schoolpilot_test";

async function loadExecuteTool() {
  const mod = await import("../dist/services/chatToolExecutor.js");
  return mod.executeTool;
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
});
