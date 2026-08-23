import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { screenshotBindingVersion } from "../src/realtime/ws-redis.js";
import { selectClasspilotSafetyEvidence } from "../src/services/classpilotSafetyEvidence.js";

const binding = {
  schoolId: "school-a",
  deviceId: "device-a",
  studentId: "student-a",
  studentSessionId: "session-a",
};
const observedAt = Date.now();
const classifiedUrl = "https://example.invalid/exact";

function screenshot(overrides: Record<string, unknown> = {}) {
  const timestamp = observedAt - 5_000;
  return {
    screenshot: "data:image/jpeg;base64,YmluZGluZw==",
    timestamp,
    capturedAt: new Date(timestamp).toISOString(),
    tabUrl: classifiedUrl,
    ...binding,
    bindingVersion: screenshotBindingVersion(binding),
    ...overrides,
  };
}

describe("ClassPilot safety evidence selection", () => {
  it("accepts only a fresh exact-binding exact-tab capture", () => {
    const selection = selectClasspilotSafetyEvidence({
      screenshot: screenshot(),
      binding,
      classifiedUrl,
      observedAt,
    });
    assert.equal(selection.available, true);
    assert.equal(selection.screenshot?.tabUrl, classifiedUrl);
  });

  it("records unavailable evidence for identity, tab, and capture-window mismatches", () => {
    const cases = [
      {
        value: screenshot({ studentSessionId: "session-b" }),
        reason: "exact_binding_unavailable",
      },
      {
        value: screenshot({ tabUrl: "https://example.invalid/other" }),
        reason: "tab_mismatch",
      },
      {
        value: screenshot({
          timestamp: observedAt - 30_001,
          capturedAt: new Date(observedAt - 30_001).toISOString(),
        }),
        reason: "capture_precedes_alert_window",
      },
    ];
    for (const testCase of cases) {
      const selection = selectClasspilotSafetyEvidence({
        screenshot: testCase.value,
        binding,
        classifiedUrl,
        observedAt,
      });
      assert.equal(selection.available, false);
      assert.equal(selection.screenshot, null);
      assert.equal(selection.unavailableReason, testCase.reason);
    }
  });
});
