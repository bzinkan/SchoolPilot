import assert from "node:assert/strict";
import { test } from "node:test";
import { classpilotBrowserSafetySeverity } from "../src/services/classpilotBrowserSafetySeverity.js";

test("browser urgency follows supported concern and rule evidence without inventing imminence", () => {
  assert.equal(classpilotBrowserSafetySeverity({ safetyAlert: null }), "low");
  assert.equal(classpilotBrowserSafetySeverity({ safetyAlert: "self-harm", source: "search", matchedTerm: "want to die" }), "high");
  assert.equal(classpilotBrowserSafetySeverity({ safetyAlert: "violence", source: "search", matchedTerm: "school shooting plan" }), "high");
  assert.equal(classpilotBrowserSafetySeverity({ safetyAlert: "weapons", source: "search", matchedTerm: "conceal weapon at school" }), "high");
  for (const concern of ["sexual", "gambling", "drugs", "hate", "weapons", "violence", "unrecognized"]) {
    assert.equal(classpilotBrowserSafetySeverity({ safetyAlert: concern, source: "known-list", matchedTerm: "fixture.example" }), "medium");
    assert.equal(classpilotBrowserSafetySeverity({ safetyAlert: concern, source: "ai" }), "medium");
  }
  assert.equal(classpilotBrowserSafetySeverity({ safetyAlert: "violence", source: "ai", matchedTerm: "school shooting plan" }), "medium", "AI text is not a reviewed deterministic search match");
});
