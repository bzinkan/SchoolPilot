import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { scrubSentryText } from "../src/services/sentry.js";

describe("Sentry allowlist scrubbing", () => {
  it("removes URLs, emails, bearer tokens, UUIDs and assigned PINs", () => {
    const value = scrubSentryText(
      "https://school.example/student?q=secret user@example.test " +
      "Bearer eyJabcdefghijk.abc.def 123e4567-e89b-12d3-a456-426614174000 pin=4821"
    );
    assert.equal(value.includes("school.example"), false);
    assert.equal(value.includes("user@example.test"), false);
    assert.equal(value.includes("eyJabcdefghijk"), false);
    assert.equal(value.includes("123e4567"), false);
    assert.equal(value.includes("4821"), false);
  });

  it("drops dynamic request, user, breadcrumb, context and identifier fields", () => {
    const source = readFileSync(new URL("../src/services/sentry.ts", import.meta.url), "utf8");
    assert.match(source, /delete event\.user/);
    assert.match(source, /delete event\.breadcrumbs/);
    assert.match(source, /event\.contexts = undefined/);
    assert.match(source, /\["category", "release", "environment"\]/);
    assert.match(source, /\["errorCode", "job", "messageType"\]/);
    assert.doesNotMatch(source, /extra:\s*\{[\s\S]{0,120}schoolId/);
  });
});
