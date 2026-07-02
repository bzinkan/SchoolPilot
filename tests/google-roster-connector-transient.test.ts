import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isTransientGoogleError } from "../dist/util/transientGoogleError.js";

describe("Google roster connector transient error detection", () => {
  it("classifies retryable Google failures without treating auth/config errors as transient", () => {
    assert.equal(isTransientGoogleError({ response: { status: 503 }, message: "backend error" }), true);
    assert.equal(isTransientGoogleError({ code: 429, message: "Quota exceeded" }), true);
    assert.equal(isTransientGoogleError({ message: "request timed out" }), true);
    assert.equal(isTransientGoogleError({ response: { status: 403 }, message: "Not authorized" }), false);
    assert.equal(isTransientGoogleError({ response: { status: 400 }, message: "Bad request" }), false);
  });
});
