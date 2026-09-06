import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

type ClassifyUrl = typeof import("../src/services/aiClassification.js").classifyUrl;
function modelResponse(safetyAlert = "none", category = "educational"): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{
    text: JSON.stringify({ category, safetyAlert }),
  }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Gemini Flash-Lite URL classification", () => {
  const priorKey = process.env.GEMINI_API_KEY;
  const priorFetch = globalThis.fetch;
  let classifyUrl: ClassifyUrl;
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  let respond: () => Response | Promise<Response>;

  before(async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      requests.push({ url: requestUrl, init });
      return respond();
    };
    ({ classifyUrl } = await import("../src/services/aiClassification.js"));
  });

  beforeEach(() => {
    requests.length = 0;
    respond = () => modelResponse();
  });

  after(() => {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  });

  it("uses structured, minimal-thinking Gemini output for an unfamiliar domain", async () => {
    const result = await classifyUrl("https://unlisted-example.test/lesson", "Lesson resource");

    assert.equal(result?.category, "educational");
    assert.equal(result?.safetyAlert, null);
    assert.equal(result?.source, "ai");
    assert.match(result?.rulesetVersion ?? "", /browser-safety-2026-09-05\.2/);
    assert.match(requestUrl, /models\/gemini-3\.5-flash-lite:generateContent\?key=test-gemini-key$/);
    assert.equal(requestInit?.method, "POST");

    const body = JSON.parse(String(requestInit?.body));
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "MINIMAL" });
    assert.deepEqual(body.generationConfig.responseSchema.properties.safetyAlert.enum, [
      "self-harm", "violence", "sexual", "drugs", "weapons", "hate", "gambling", "none",
    ]);
  });

  it("recognizes official NWEA testing, login, practice, and resource hosts without calling AI", async () => {
    respond = () => { throw new Error("NWEA must not reach the provider"); };
    const urls = [
      "https://test.mapnwea.org/", "https://test.mapnwea.org/#/nopopup",
      "https://practice.mapnwea.org/", "https://student.mapnwea.org/",
      "https://readingfluency.mapnwea.org/", "https://teach.mapnwea.org/",
      "https://auth.nwea.org/", "https://studentresources.nwea.org/",
      "https://check.nwea.org/", "https://www.nwea.org/map-growth/",
      "https://TEST.MAPNWEA.ORG./#question=2", "https://test.mapnwea.org/?q=suicide&item=health",
    ];
    for (const url of urls) {
      const result = await classifyUrl(url, "Reading assessment: suicide prevention and violence in history");
      assert.equal(result?.category, "educational", url);
      assert.equal(result?.contentCategory, "Education", url);
      assert.equal(result?.safetyAlert, null, url);
      assert.equal(result?.source, "known-list", url);
      assert.ok(["nwea.org", "mapnwea.org"].includes(result?.matchedTerm ?? ""), url);
    }
    assert.equal(requests.length, 0);
  });

  it("does not give lookalike hosts, URL mentions, or shared infrastructure NWEA's educational rule", async () => {
    respond = () => modelResponse("none", "unknown");
    for (const url of [
      "https://notmapnwea.org/", "https://mapnwea.org.lookalike.test/",
      "https://nwea.org.lookalike.test/", "https://test.mapnwea.org@untrusted.test/",
      "https://elsewhere.test/?next=https://test.mapnwea.org", "https://cdn.launchdarkly.com/",
    ]) {
      const result = await classifyUrl(url, "NWEA MAP Growth");
      assert.equal(result?.category, "unknown", url);
      assert.equal(result?.source, "ai", url);
    }
    assert.equal(requests.length, 6);
  });

  it("does not reuse either a safe or unsafe model decision on another page of the same host", async () => {
    for (const unsafeFirst of [false, true]) {
      const host = `cache-direction-${unsafeFirst}.test`;
      const firstConcern = unsafeFirst ? "violence" : "none";
      const secondConcern = unsafeFirst ? "none" : "violence";
      respond = () => modelResponse(firstConcern, unsafeFirst ? "non-educational" : "educational");
      const first = await classifyUrl(`https://${host}/first`, "First page");
      respond = () => modelResponse(secondConcern, unsafeFirst ? "educational" : "non-educational");
      const second = await classifyUrl(`https://${host}/second`, "Second page");
      assert.equal(first?.safetyAlert, unsafeFirst ? "violence" : null);
      assert.equal(second?.safetyAlert, unsafeFirst ? null : "violence");
      assert.equal((await classifyUrl(`https://${host}/first`, "First page"))?.safetyAlert, first?.safetyAlert);
    }
    assert.equal(requests.length, 4, "identical page/title reuses only its own model decision");
  });

  it("preserves scheme, port, path, query order, duplicates, fragment, and title in model cache identity", async () => {
    const base = "https://exact-input.test/lesson?a=1&a=2&b=3#one";
    const inputs: Array<[string, string]> = [
      [base, "Lesson"], [base.replace("https:", "http:"), "Lesson"],
      [base.replace(".test/", ".test:8443/"), "Lesson"], [base.replace("/lesson", "/Lesson"), "Lesson"],
      [base.replace("a=1&a=2&b=3", "b=3&a=1&a=2"), "Lesson"],
      [base.replace("a=1&a=2", "a=2"), "Lesson"], [base.replace("#one", "#two"), "Lesson"],
      [base, "Changed title"],
    ];
    for (const [index, [url, title]] of inputs.entries()) {
      const concern = index % 2 ? "violence" : "none";
      respond = () => modelResponse(concern);
      const result = await classifyUrl(url, title);
      assert.equal(result?.safetyAlert, concern === "none" ? null : "violence");
      assert.equal(requests.length, index + 1);
      assert.equal(await classifyUrl(url, title), result, "same exact input is reused");
      assert.equal(requests.length, index + 1);
    }
  });

  it("coalesces identical in-flight observations while independently classifying other pages and titles", async () => {
    const releases: Array<() => void> = [];
    respond = () => new Promise<Response>((resolve) => {
      const index = requests.length;
      releases.push(() => resolve(modelResponse(index === 1 ? "violence" : "none")));
    });
    const url = "https://concurrent-pages.test/page";
    const pending = [classifyUrl(url, "First"), classifyUrl(url, "First"),
      classifyUrl(`${url}?query=another`, "First"), classifyUrl(url, "Changed")];
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(requests.length, 3, "same page/title shares work; changed page or title does not");
    } finally {
      for (const release of releases) release();
    }
    const results = await Promise.all(pending);
    assert.equal(results[0]?.safetyAlert, "violence");
    assert.equal(results[1], results[0]);
    assert.equal(results[2]?.safetyAlert, null);
    assert.equal(results[3]?.safetyAlert, null);
  });

  it("retains school-domain authority and fallback-mode separation", async () => {
    const url = "https://school-context.test/page";
    const school = await classifyUrl(url, "Resource", { schoolDomain: "school-context.test" });
    assert.equal(school?.source, "school-domain");
    assert.equal((await classifyUrl(url, "Resource", { useAiFallback: false }))?.source, "unknown");
    assert.equal(requests.length, 0);
    respond = () => modelResponse("violence", "non-educational");
    assert.equal((await classifyUrl(url, "Resource"))?.safetyAlert, "violence");
    assert.equal((await classifyUrl(url, "Resource", { schoolDomain: "school-context.test" }))?.safetyAlert, null);
    assert.equal(requests.length, 1);
  });

  it("handles malformed or failed provider responses without creating a safety alert or poisoning the cache", async () => {
    const url = "https://provider-failure.test/page";
    for (const text of ["null", "[]", "true", "not json"]) {
      respond = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
      const result = await classifyUrl(url, "Resource");
      assert.equal(result?.source, "unknown");
      assert.equal(result?.safetyAlert, null);
    }
    respond = () => new Response("", { status: 503 });
    assert.equal((await classifyUrl(url, "Resource"))?.safetyAlert, null);
    respond = () => modelResponse();
    assert.equal((await classifyUrl(url, "Resource"))?.source, "ai");
    assert.equal(requests.length, 6);
  });
});
