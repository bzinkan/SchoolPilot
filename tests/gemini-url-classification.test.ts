import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

type ClassifyUrl = typeof import("../src/services/aiClassification.js").classifyUrl;

describe("Gemini Flash-Lite URL classification", () => {
  const priorKey = process.env.GEMINI_API_KEY;
  const priorFetch = globalThis.fetch;
  let classifyUrl: ClassifyUrl;
  let requestUrl = "";
  let requestInit: RequestInit | undefined;

  before(async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{ text: '{"category":"educational","safetyAlert":"none"}' }],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    ({ classifyUrl } = await import("../src/services/aiClassification.js"));
  });

  after(() => {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  });

  it("uses structured, no-thinking Gemini output for an unfamiliar domain", async () => {
    const result = await classifyUrl("https://unlisted-example.test/lesson", "Lesson resource");

    assert.equal(result?.category, "educational");
    assert.equal(result?.safetyAlert, null);
    assert.equal(result?.source, "ai");
    assert.match(requestUrl, /models\/gemini-3\.5-flash-lite:generateContent\?key=test-gemini-key$/);
    assert.equal(requestInit?.method, "POST");

    const body = JSON.parse(String(requestInit?.body));
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "MINIMAL" });
    assert.deepEqual(body.generationConfig.responseSchema.properties.safetyAlert.enum, [
      "self-harm", "violence", "sexual", "drugs", "none",
    ]);
  });
});
