import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerSchema } from "../src/schema/validation.js";

const validRegistration = {
  email: "new-parent@example.invalid",
  password: "StrongPassword1",
  firstName: "New",
  lastName: "Parent",
};

describe("authentication registration context", () => {
  it("requires school creation and rejects retired school-slug enrollment", () => {
    assert.equal(registerSchema.safeParse(validRegistration).success, false);
    assert.equal(
      registerSchema.safeParse({
        ...validRegistration,
        schoolName: "New School",
        schoolSlug: "existing-school",
      }).success,
      false
    );
    assert.equal(
      registerSchema.safeParse({
        ...validRegistration,
        schoolSlug: "existing-school",
      }).success,
      false
    );
    assert.equal(
      registerSchema.safeParse({
        ...validRegistration,
        schoolName: "New School",
      }).success,
      true
    );

    const normalized = registerSchema.safeParse({
      ...validRegistration,
      schoolName: "  New School  ",
    });
    assert.equal(normalized.success, true);
    if (normalized.success) {
      assert.equal(normalized.data.schoolName, "New School");
    }
  });
});
