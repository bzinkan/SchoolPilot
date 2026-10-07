import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

type ClassifyUrl = typeof import("../src/services/aiClassification.js").classifyUrl;

// Synthetic characterization evidence, not a security acceptance gate. These
// findings are pending remediation in docs/CLASSPILOT_AI_CLAIM_AUDIT.md. A future
// reviewed minimization change must replace the corresponding exposure assertions.
// No fixture, credential, or provider response is real; fetch never reaches a network.
const fixtures = [
  { name: "email in query", url: "https://audit-email.test/work?student=synthetic%40example.test", title: "Synthetic assignment" },
  { name: "access token in query", url: "https://audit-query.test/work?access_token=SYNTHETIC_NOT_A_CREDENTIAL", title: "Synthetic assignment" },
  { name: "credentials in URL userinfo", url: "https://synthetic-user:synthetic-password@audit-userinfo.test/work", title: "Synthetic assignment" },
  { name: "token in fragment", url: "https://audit-fragment.test/work#access_token=SYNTHETIC_NOT_A_CREDENTIAL", title: "Synthetic assignment" },
  { name: "search terms", url: "https://audit-search.test/search?q=synthetic+private+question", title: "Synthetic search results" },
  { name: "identity and token in title", url: "https://audit-title.test/work", title: "Synthetic Student synthetic@example.test token=SYNTHETIC_NOT_A_CREDENTIAL" },
];

function modelResponse(): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{
    text: JSON.stringify({ category: "unknown", safetyAlert: "none" }),
  }] } }] }), { headers: { "Content-Type": "application/json" } });
}

describe("ClassPilot provider-boundary audit (synthetic; remediation pending)", () => {
  const priorKey = process.env.GEMINI_API_KEY;
  const priorAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  let classifyUrl: ClassifyUrl;
  const requests: RequestInit[] = [];
  let respond: () => Response | Promise<Response>;

  before(async () => {
    process.env.GEMINI_API_KEY = "synthetic-audit-key";
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).hostname, "generativelanguage.googleapis.com");
      assert.ok(init);
      requests.push(init);
      return respond();
    };
    ({ classifyUrl } = await import("../src/services/aiClassification.js"));
  });
  beforeEach(() => {
    requests.length = 0;
    respond = modelResponse;
  });
  after(() => {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
    if (priorAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorAnthropicKey;
  });

  for (const fixture of fixtures) {
    it(`records current unredacted provider input: ${fixture.name}`, async () => {
      const result = await classifyUrl(fixture.url, fixture.title);
      assert.equal(result?.source, "ai");
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.ok(request);
      const body = JSON.parse(String(request.body));
      assert.deepEqual(Object.keys(body).sort(), ["contents", "generationConfig"]);
      assert.equal(body.contents.length, 1);
      assert.equal(body.contents[0].parts.length, 1);
      assert.ok(body.contents[0].parts[0].text.endsWith(`URL: ${fixture.url}\nTitle: ${fixture.title}`));
      assert.equal(await classifyUrl(fixture.url, fixture.title), result);
      assert.equal(requests.length, 1, "cache reuse does not undo the first model-bound disclosure");
    });
  }

  it("does not call the provider for known school sites or disabled fallback", async () => {
    await classifyUrl("https://www.ixl.com/math", "Synthetic Student");
    await classifyUrl("https://audit-school.test/work", "Synthetic Student", { schoolDomain: "audit-school.test" });
    const result = await classifyUrl("https://audit-disabled.test/work", "Synthetic Student", { useAiFallback: false });
    assert.equal(result?.source, "unknown");
    assert.equal(requests.length, 0);
  });

  it("does not read or log the mocked provider's HTTP error body", async (context) => {
    let bodyReads = 0;
    const errorResponse = new Response("synthetic provider failure", { status: 503 });
    context.mock.method(errorResponse, "json", async () => { bodyReads++; throw new Error("unexpected error-body read"); });
    context.mock.method(errorResponse, "text", async () => { bodyReads++; return "synthetic@example.test SYNTHETIC_NOT_A_CREDENTIAL"; });
    const logs = ["log", "warn", "error"].map(method => context.mock.method(console, method as "log" | "warn" | "error", () => {}));
    respond = () => errorResponse;
    const result = await classifyUrl("https://audit-http-error.test/work", "Synthetic error fixture");
    assert.equal(result?.source, "unknown");
    assert.equal(result?.safetyAlert, null);
    assert.equal(bodyReads, 0);
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
    assert.equal(requests.length, 1, "failed response does not mean input was withheld");
  });

  it("contains a mocked transport exception without logging its sensitive message", async (context) => {
    const logs = ["log", "warn", "error"].map(method => context.mock.method(console, method as "log" | "warn" | "error", () => {}));
    respond = () => { throw new Error("synthetic@example.test SYNTHETIC_NOT_A_CREDENTIAL"); };
    const result = await classifyUrl("https://audit-transport-error.test/work", "Synthetic error fixture");
    assert.equal(result?.source, "unknown");
    assert.equal(result?.safetyAlert, null);
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
  });
});
