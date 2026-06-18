import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Imports the COMPILED output (CI builds first) so we exercise exactly what ships.
import { classifyUrl } from "../dist/services/aiClassification.js";

describe("ClassPilot conservative URL classification", () => {
  it("treats known learning portals and ClassLink-style subdomains as educational", async () => {
    assert.equal((await classifyUrl("https://launchpad.classlink.com/home", "LaunchPad"))?.category, "educational");
    assert.equal((await classifyUrl("https://classroom.google.com/c/123", "Google Classroom"))?.category, "educational");
    assert.equal((await classifyUrl("https://student.desmos.com/activity", "Desmos"))?.category, "educational");
  });

  it("treats the configured school domain and subdomains as educational", async () => {
    const result = await classifyUrl(
      "https://library.desalescincy.org/resources",
      "School library",
      { schoolDomain: "desalescincy.org" }
    );

    assert.equal(result?.category, "educational");
    assert.equal(result?.safetyAlert, null);
  });

  it("flags obvious distraction domains locally", async () => {
    const result = await classifyUrl("https://www.youtube.com/watch?v=abc", "YouTube");

    assert.equal(result?.category, "non-educational");
    assert.equal(result?.safetyAlert, null);
  });

  it("leaves ambiguous unknown domains neutral when AI fallback is disabled", async () => {
    const result = await classifyUrl(
      "https://example-community-center.org/homework-help",
      "Homework help",
      { useAiFallback: false }
    );

    assert.equal(result?.category, "unknown");
    assert.equal(result?.safetyAlert, null);
  });

  it("checks unsafe search queries before returning a cached safe search domain", async () => {
    assert.equal((await classifyUrl("https://google.com/search?q=algebra", "Google"))?.category, "educational");

    const result = await classifyUrl("https://google.com/search?q=suicide%20method", "Google Search");

    assert.equal(result?.category, "non-educational");
    assert.equal(result?.safetyAlert, "self-harm");
  });
});
