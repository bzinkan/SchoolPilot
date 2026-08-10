import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { establishWebSession } from "../src/services/webSession.js";

describe("authenticated web session establishment", () => {
  it("regenerates stale state and initializes the idle clock", async () => {
    let regenerated = false;
    const session: Record<string, any> = {
      userId: "old-user",
      role: "school_admin",
      csrfToken: "old-csrf-token",
      lastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
      regenerate(callback: (error?: Error) => void) {
        regenerated = true;
        for (const key of Object.keys(this)) {
          if (key !== "regenerate") delete this[key];
        }
        callback();
      },
    };
    const before = Date.now();

    await establishWebSession(
      { session } as any,
      {
        userId: "new-user",
        email: "teacher@example.invalid",
        role: "teacher",
        schoolId: "school-1",
        schoolSessionVersion: 7,
      }
    );

    assert.equal(regenerated, true);
    assert.equal(session.userId, "new-user");
    assert.equal(session.email, "teacher@example.invalid");
    assert.equal(session.role, "teacher");
    assert.equal(session.schoolId, "school-1");
    assert.equal(session.schoolSessionVersion, 7);
    assert.ok(session.lastActivityAt >= before);
    assert.equal(session.csrfToken, undefined);
  });
});
