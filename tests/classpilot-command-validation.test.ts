import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClasspilotCommandPayloadError,
  validateClasspilotCommandPayload,
} from "../src/services/classpilotCommandValidation.js";

function invalid(run: () => unknown, path?: string) {
  assert.throws(run, (error: any) => {
    assert.ok(error instanceof ClasspilotCommandPayloadError);
    assert.equal(error.code, "INVALID_COMMAND_PAYLOAD");
    return path ? error.fieldErrors.some((entry: any) => entry.path.includes(path)) : true;
  });
}

describe("ClassPilot teacher command payload validation", () => {
  it("normalizes HTTP URLs and rejects unknown command fields", () => {
    assert.deepEqual(validateClasspilotCommandPayload("open-tab", { url: "example.edu/path" }), {
      url: "https://example.edu/path",
    });
    invalid(() => validateClasspilotCommandPayload("open-tab", {
      url: "https://example.edu",
      deviceId: "must-not-cross-public-contract",
    }));
  });

  it("locks to CURRENT_URL or a canonical query-free HTTPS Waypoint", () => {
    assert.deepEqual(validateClasspilotCommandPayload("lock-screen", { url: "CURRENT_URL" }), {
      url: "CURRENT_URL",
    });
    assert.deepEqual(validateClasspilotCommandPayload("lock-screen", {
      url: "https://www.ixl.com/math/grade-5",
    }), { url: "https://www.ixl.com/math/grade-5" });
    assert.deepEqual(validateClasspilotCommandPayload("lock-screen", { url: "ixl.com" }), {
      url: "https://ixl.com/",
    });
    assert.deepEqual(validateClasspilotCommandPayload("lock-screen", {
      url: "HTTPS://EXAMPLE.EDU:443/course/../classroom",
    }), { url: "https://example.edu/classroom" });
    invalid(() => validateClasspilotCommandPayload("lock-screen", {
      url: "http://example.edu/classroom",
    }), "url");
    invalid(() => validateClasspilotCommandPayload("lock-screen", {
      url: "https://example.edu/classroom?token=secret",
    }), "url");
    invalid(() => validateClasspilotCommandPayload("lock-screen", {
      url: "https://example.edu/classroom#student-token",
    }), "url");
    invalid(() => validateClasspilotCommandPayload("lock-screen", {
      url: "https://student:secret@example.edu/classroom",
    }), "url");
    invalid(() => validateClasspilotCommandPayload("lock-screen", { url: "javascript:alert(1)" }), "url");
    invalid(() => validateClasspilotCommandPayload("lock-screen", { url: "https://" }), "url");
    invalid(() => validateClasspilotCommandPayload("lock-screen", { url: "" }));
    invalid(() => validateClasspilotCommandPayload("lock-screen", {}));
    invalid(() => validateClasspilotCommandPayload("lock-screen", {
      url: "CURRENT_URL",
      deviceId: "must-not-cross-public-contract",
    }));
  });

  it("requires exact tab identity and never accepts URL fallback rows", () => {
    assert.deepEqual(validateClasspilotCommandPayload("close-tabs", {
      tabsToClose: [{ studentId: "student-1", tabRef: "tab-2", observedRevision: 9 }],
    }), {
      tabsToClose: [{ studentId: "student-1", tabRef: "tab-2", observedRevision: 9 }],
    });
    invalid(() => validateClasspilotCommandPayload("close-tabs", {
      tabsToClose: [{ studentId: "student-1", url: "https://duplicate.example" }],
    }));
    invalid(() => validateClasspilotCommandPayload("close-tabs", {
      tabsToClose: [{
        studentId: "student-1",
        tabRef: "tab-2",
        observedRevision: 9,
        title: "Client metadata must not cross the exact-tab contract",
      }],
    }));
    invalid(() => validateClasspilotCommandPayload("close-tabs", {
      tabsToClose: Array.from({ length: 51 }, (_, index) => ({
        studentId: "student-1",
        tabRef: `tab-${index}`,
        observedRevision: 1,
      })),
    }));
    invalid(() => validateClasspilotCommandPayload("close-tabs", {
      specificUrls: ["https://duplicate.example"],
      tabsToClose: [{ studentId: "student-1", tabRef: "tab-2", observedRevision: 9 }],
    }));
    invalid(() => validateClasspilotCommandPayload("close-tabs", {
      pattern: "*.example.edu",
    }));
    invalid(() => validateClasspilotCommandPayload("close-tabs", {
      specificUrls: ["https://example.edu"],
    }));
    invalid(() => validateClasspilotCommandPayload("close-tabs", {
      closeAll: false,
    }));
    assert.deepEqual(validateClasspilotCommandPayload("close-tabs", {
      closeAll: true,
    }), { closeAll: true });
  });

  it("bounds timers and accepts managed single-label hostnames", () => {
    assert.deepEqual(validateClasspilotCommandPayload("temp-unblock", {
      domain: "intranet",
      durationMinutes: 5,
    }), { domain: "intranet", durationMinutes: 5 });
    invalid(() => validateClasspilotCommandPayload("timer", {
      action: "start",
      seconds: 3_601,
    }), "seconds");
  });

  it("keeps screen unlock separate from Flight Path removal", () => {
    assert.deepEqual(validateClasspilotCommandPayload("unlock-screen", {
      screenOnly: true,
    }), { screenOnly: true });
    invalid(() => validateClasspilotCommandPayload("unlock-screen", {}), "screenOnly");
    invalid(() => validateClasspilotCommandPayload("unlock-screen", { screenOnly: false }), "screenOnly");
  });

  it("enforces distinct bounded poll options", () => {
    invalid(() => validateClasspilotCommandPayload("poll", {
      action: "start",
      question: "Ready?",
      options: ["Yes", "yes"],
    }), "options");
    assert.deepEqual(validateClasspilotCommandPayload("poll", {
      action: "close",
      pollId: "poll-1",
    }), { action: "close", pollId: "poll-1" });
  });
});
