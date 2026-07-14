import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("school time formatter caching", () => {
  it("bounds Intl formatter construction for a production-sized heartbeat set", async () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    let constructionCount = 0;

    class CountingDateTimeFormat extends OriginalDateTimeFormat {
      constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        constructionCount += 1;
        super(...args);
      }
    }

    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      writable: true,
      value: CountingDateTimeFormat,
    });

    try {
      const schoolTime = await import(`../dist/util/schoolTime.js?formatter-cache=${Date.now()}`);
      const formatLocalDate = schoolTime.createLocalDateFormatter("America/New_York");
      const first = new Date("2026-01-15T17:30:00.000Z");

      for (let index = 0; index < 21_596; index += 1) {
        assert.equal(formatLocalDate(new Date(first.getTime() + (index % 540) * 10_000)), "2026-01-15");
      }

      assert.equal(constructionCount, 2, "one validation formatter and one date formatter should be reused");

      const beforePartsFormatter = constructionCount;
      for (let index = 0; index < 100; index += 1) {
        assert.equal(
          schoolTime.localDateStartUtc("2026-01-15", "America/New_York").toISOString(),
          "2026-01-15T05:00:00.000Z"
        );
      }
      assert.equal(constructionCount, beforePartsFormatter + 1, "one zoned-parts formatter should be reused");

      const beforeInvalid = constructionCount;
      for (let index = 0; index < 21_596; index += 1) {
        assert.equal(schoolTime.localDateInTimeZone(first, "Not/A-TimeZone"), "2026-01-15");
      }
      assert.equal(constructionCount, beforeInvalid + 1, "an invalid timezone should be validated only once");

      const beforeBoundedFill = constructionCount;
      for (let index = 0; index < 65; index += 1) {
        schoolTime.localDateInTimeZone(first, `Invalid/Zone-${index}`);
      }
      assert.equal(constructionCount, beforeBoundedFill + 65);

      const beforeEvictedLookup = constructionCount;
      schoolTime.localDateInTimeZone(first, "Invalid/Zone-0");
      assert.equal(constructionCount, beforeEvictedLookup + 1, "the oldest timezone validation should be evicted");
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", {
        configurable: true,
        writable: true,
        value: OriginalDateTimeFormat,
      });
    }
  });

  it("preserves local-date and daylight-saving boundaries", async () => {
    const schoolTime = await import(`../dist/util/schoolTime.js?boundary-cache=${Date.now()}`);

    assert.equal(
      schoolTime.localDateInTimeZone(new Date("2026-01-15T04:59:59.000Z"), "America/New_York"),
      "2026-01-14"
    );
    assert.equal(
      schoolTime.localDateInTimeZone(new Date("2026-07-15T04:00:00.000Z"), "America/New_York"),
      "2026-07-15"
    );
    assert.equal(
      schoolTime.localDateStartUtc("2026-03-08", "America/New_York").toISOString(),
      "2026-03-08T05:00:00.000Z"
    );
    assert.equal(
      schoolTime.localDateStartUtc("2026-03-09", "America/New_York").toISOString(),
      "2026-03-09T04:00:00.000Z"
    );
    assert.equal(
      schoolTime.localDateInTimeZone(new Date("2026-01-15T17:30:00.000Z"), "x".repeat(129)),
      "2026-01-15"
    );
  });
});
