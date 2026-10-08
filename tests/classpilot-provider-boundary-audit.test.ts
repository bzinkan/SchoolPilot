import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

type ClassifyUrl = typeof import("../src/services/aiClassification.js").classifyUrl;

// Source-bound synthetic acceptance evidence for CP-AI-001. The October 7
// characterization remains historical evidence in the claim audit; this suite
// checks the reviewed credential policy against actual outgoing requests.
// No fixture, credential, or provider response is real; fetch never uses a network.
const marker = "[REDACTED_CREDENTIAL]";
const credential = "SYNTHETIC_NOT_A_CREDENTIAL";
const safeFixtures = [
  {
    name: "access token in query", url: `https://audit-query.test/work?access_token=${credential}`,
    expectedUrl: `https://audit-query.test/work?access_token=${marker}`, forbidden: [credential],
  },
  {
    name: "credentials in URL userinfo", url: "https://synthetic-user:synthetic-password@audit-userinfo.test/work",
    expectedUrl: "https://audit-userinfo.test/work", forbidden: ["synthetic-user", "synthetic-password"],
  },
  {
    name: "userinfo retains actual destination rather than educational lookalike", url: "https://test.mapnwea.org:synthetic-password@audit-destination.test/work",
    expectedUrl: "https://audit-destination.test/work", forbidden: ["test.mapnwea.org", "synthetic-password"],
  },
  {
    name: "token in plain key/value fragment", url: `https://audit-fragment.test/work#access_token=${credential}&lesson=fractions`,
    expectedUrl: `https://audit-fragment.test/work#access_token=${marker}&lesson=fractions`, forbidden: [credential],
  },
  {
    name: "repeated mixed-case hyphen aliases preserve unrelated bytes", url: "https://audit-repeated.test/Work?b=three+words&a=1&ACCESS-TOKEN=SYNTHETIC_FIRST&access_token=SYNTHETIC_SECOND&a=2#lesson=fractions",
    expectedUrl: `https://audit-repeated.test/Work?b=three+words&a=1&ACCESS-TOKEN=${marker}&access_token=${marker}&a=2#lesson=fractions`,
    forbidden: ["SYNTHETIC_FIRST", "SYNTHETIC_SECOND"],
  },
  {
    name: "encoded names and values within two decoding passes", url: "https://audit-encoded.test/work?%2561ccess%255ftoken=SYNTHETIC%255FENCODED&q=fractions%2Bmath",
    expectedUrl: `https://audit-encoded.test/work?%2561ccess%255ftoken=${marker}&q=fractions%2Bmath`,
    forbidden: ["SYNTHETIC%255FENCODED", "SYNTHETIC%5FENCODED", "SYNTHETIC_ENCODED"],
  },
  {
    name: "separable Authorization Bearer value", url: "https://audit-authorization.test/work?authorization=Bearer%20SYNTHETIC_AUTH_BEARER&lesson=fractions",
    expectedUrl: `https://audit-authorization.test/work?authorization=${marker}&lesson=fractions`,
    forbidden: ["Bearer%20SYNTHETIC_AUTH_BEARER", "SYNTHETIC_AUTH_BEARER"],
  },
];
const allowedFixtures = [
  { name: "email in query", url: "https://audit-email.test/work?student=synthetic%40example.test", title: "Synthetic assignment" },
  { name: "ordinary search terms", url: "https://audit-search.test/search?q=synthetic+private+question", title: "Synthetic search results" },
  { name: "identity-only title", url: "https://audit-identity.test/work", title: "Synthetic Student synthetic@example.test" },
  { name: "ordinary identifiers and words about authentication", url: "https://audit-identifiers.test/work?code=lesson-2&key=diagram&id=7&state=completed", title: "How passwords and tokens protect accounts" },
  { name: "ordinary code in nested resource URL", url: `https://audit-nested-resource.test/work?next=${encodeURIComponent("https://learning.test/lesson?code=lesson-2")}`, title: "Synthetic assignment" },
  { name: "maximum permitted title", url: "https://audit-title-limit.test/work", title: "x".repeat(512) },
  { name: "maximum permitted URL", url: "https://audit-url-limit.test/work?q=".padEnd(4096, "x"), title: "Synthetic assignment" },
];
const unavailableFixtures = [
  { name: "credential assignment in title", url: "https://audit-title.test/work", title: `Synthetic Student synthetic@example.test token=${credential}` },
  { name: "quoted credential key in title", url: "https://audit-title-quoted-key.test/work", title: `{"access_token":"${credential}"}` },
  { name: "quoted credential key in query", url: `https://audit-query-quoted-key.test/work?"access_token"=${credential}` },
  { name: "quoted credential key in fragment", url: `https://audit-fragment-quoted-key.test/work#"access_token"=${credential}` },
  { name: "Bearer credential in title", url: "https://audit-bearer.test/work", title: `Authorization: Bearer ${credential}` },
  { name: "credential-bearing path", url: `https://audit-path.test/access_token=${credential}/lesson` },
  { name: "credential-bearing nested redirect", url: `https://audit-nested.test/work?next=${encodeURIComponent(`https://nested.test/lesson?access_token=${credential}`)}` },
  { name: "credential-bearing hash route", url: `https://audit-hash-route.test/work#/lesson?access_token=${credential}` },
  { name: "ambiguous token assignment", url: `https://audit-ambiguous.test/work?token=${credential}` },
  { name: "AWS signed URL", url: `https://audit-aws.test/work?X-Amz-Signature=${credential}` },
  { name: "Google signed URL", url: `https://audit-google.test/work?X-Goog-Signature=${credential}` },
  { name: "SAML payload", url: `https://audit-saml.test/work?SAMLResponse=${credential}` },
  { name: "OAuth authorization code context", url: `https://audit-oauth.test/oauth/callback?code=${credential}&state=synthetic-state` },
  { name: "OAuth code in nested redirect", url: `https://audit-nested-oauth.test/work?next=${encodeURIComponent(`https://auth.test/oauth/callback?code=${credential}`)}` },
  { name: "OAuth code and client context in nested redirect", url: `https://audit-nested-oauth-context.test/work?next=${encodeURIComponent(`https://auth.test/work?code=${credential}&client_id=synthetic-client`)}` },
  { name: "OAuth code in hash route", url: `https://audit-hash-oauth.test/work#/oauth/callback?code=${credential}` },
  { name: "OAuth code and client context in hash route", url: `https://audit-hash-oauth-context.test/work#/lesson?code=${credential}&client_id=synthetic-client` },
  { name: "OAuth code in title URL", url: "https://audit-title-oauth.test/work", title: `https://auth.test/oauth/callback?code=${credential}` },
  { name: "OAuth title code with URL authentication route", url: "https://audit-cross-oauth-route.test/oauth/callback", title: `code=${credential}` },
  { name: "OAuth title code with URL client context", url: "https://audit-cross-oauth-client.test/work?client_id=synthetic-client", title: `code=${credential}` },
  { name: "OAuth URL code with title client context", url: `https://audit-cross-oauth-title.test/work?code=${credential}`, title: "client_id=synthetic-client" },
  { name: "authentication-only context", url: `https://audit-auth-only.test/login?access_token=${credential}`, title: "Sign in" },
  { name: "malformed escape", url: `https://audit-malformed.test/work?access_token=${credential}&q=%ZZ` },
  { name: "third encoded credential form", url: "https://audit-encoded-deep.test/work?%252561ccess%25255ftoken=SYNTHETIC_DEEP" },
  { name: "residual credential in unrelated context", url: `https://audit-residual.test/work?access_token=${credential}&q=${credential}` },
  { name: "residual Bearer credential in unrelated context", url: `https://audit-residual-bearer.test/work?authorization=Bearer%20${credential}&q=${credential}` },
  { name: "residual Basic credential in unrelated context", url: `https://audit-residual-basic.test/work?authorization=Basic%20${credential}&q=${credential}` },
  { name: "quoted credential value with bare residual", url: `https://audit-residual-quoted.test/work?access_token=%22${credential}%22&q=${credential}` },
  { name: "semicolon credential value with bare residual", url: `https://audit-residual-separator.test/work?access_token=${credential};resource=lesson&q=${credential}` },
  { name: "relative URL", url: `/audit-relative/work?access_token=${credential}` },
  { name: "non-HTTP provider fallback URL", url: "ftp://audit-scheme.test/work" },
  { name: "ambiguous backslash authority", url: "https://audit-authority.test\\@other.test/work" },
  { name: "oversized URL", url: `https://audit-url-bound.test/work?q=${"x".repeat(4096)}` },
  { name: "oversized title", url: "https://audit-title-bound.test/work", title: "x".repeat(513) },
];

function modelResponse(): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{
    text: JSON.stringify({ category: "unknown", safetyAlert: "none" }),
  }] } }] }), { headers: { "Content-Type": "application/json" } });
}

describe("ClassPilot provider-boundary credential acceptance (synthetic)", () => {
  const priorKey = process.env.GEMINI_API_KEY;
  const priorAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  let classifyUrl: ClassifyUrl;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let respond: () => Response | Promise<Response>;

  before(async () => {
    process.env.GEMINI_API_KEY = "synthetic-audit-key";
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).hostname, "generativelanguage.googleapis.com");
      assert.ok(init);
      requests.push({ url: String(input), init });
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

  function requestText(expectedUrl: string, title: string): string {
    assert.equal(requests.length, 1);
    const body = JSON.parse(String(requests[0]!.init.body));
    assert.deepEqual(Object.keys(body).sort(), ["contents", "generationConfig"]);
    assert.equal(body.contents.length, 1);
    assert.equal(body.contents[0].parts.length, 1);
    const text = body.contents[0].parts[0].text;
    assert.ok(text.endsWith(`URL: ${expectedUrl}\nTitle: ${title}`));
    return JSON.stringify(requests[0]);
  }

  for (const fixture of safeFixtures) {
    it(`removes tested credentials from the actual request: ${fixture.name}`, async () => {
      const title = "Synthetic assignment";
      const result = await classifyUrl(fixture.url, title);
      assert.equal(result?.source, "ai");
      const serializedRequest = requestText(fixture.expectedUrl, title);
      for (const value of fixture.forbidden) assert.ok(!serializedRequest.includes(value), "browser credential must not appear in endpoint, headers, or body");
      assert.equal(await classifyUrl(fixture.url, title), result);
      assert.equal(requests.length, 1, "same original observation reuses its own accepted decision");
    });
  }

  for (const fixture of allowedFixtures) {
    it(`retains the explicitly allowed classification context: ${fixture.name}`, async () => {
      assert.equal((await classifyUrl(fixture.url, fixture.title))?.source, "ai");
      requestText(fixture.url, fixture.title);
    });
  }

  for (const fixture of unavailableFixtures) {
    it(`withholds the actual model request: ${fixture.name}`, async (context) => {
      const logs = ["log", "warn", "error"].map(method => context.mock.method(console, method as "log" | "warn" | "error", () => {}));
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = await classifyUrl(fixture.url, fixture.title ?? "Synthetic assignment");
        assert.equal(result?.source, "unknown");
        assert.equal(result?.category, "unknown");
        assert.equal(result?.safetyAlert, null);
      }
      assert.equal(requests.length, 0);
      for (const log of logs) assert.equal(log.mock.callCount(), 0);
    });
  }

  it("retains educational, harmful-intent, and prevention query/title context beside redacted credentials", async () => {
    for (const [index, retainedContext] of [
      [0, "fractions lesson"], [1, "I want to harm myself"], [2, "suicide prevention and crisis support"],
    ] as const) {
      const query = encodeURIComponent(retainedContext);
      const url = `https://audit-context-${index}.test/work?access_token=SYNTHETIC_CONTEXT_${index}&q=${query}`;
      const result = await classifyUrl(url, retainedContext);
      assert.equal(result?.source, "ai");
      const serializedRequest = requestText(`https://audit-context-${index}.test/work?access_token=${marker}&q=${query}`, retainedContext);
      assert.ok(!serializedRequest.includes(`SYNTHETIC_CONTEXT_${index}`));
      requests.length = 0;
    }
  });

  it("withheld observations do not poison ordinary fallback on the same domain", async () => {
    assert.equal((await classifyUrl(`https://audit-unavailable-cache.test/work?token=${credential}`, "Synthetic assignment"))?.source, "unknown");
    assert.equal(requests.length, 0);
    assert.equal((await classifyUrl("https://audit-unavailable-cache.test/work?q=fractions", "Synthetic assignment"))?.source, "ai");
    assert.equal(requests.length, 1);
  });

  it("does not call the provider for known school sites, local search rules, or disabled fallback", async () => {
    await classifyUrl(`https://www.ixl.com/math?access_token=${credential}`, `token=${credential}`);
    await classifyUrl(`https://audit-school.test/work?access_token=${credential}`, `token=${credential}`, { schoolDomain: "audit-school.test" });
    const search = await classifyUrl("https://www.google.com/search?q=how+to+kill+myself", "Synthetic search results");
    assert.equal(search?.source, "search");
    const result = await classifyUrl(`https://audit-disabled.test/work?token=${credential}`, "Synthetic Student", { useAiFallback: false });
    assert.equal(result?.source, "unknown");
    assert.equal(requests.length, 0);
  });

  it("does not read or log the mocked provider's HTTP error body and subsequently recovers", async (context) => {
    let bodyReads = 0;
    const errorResponse = new Response("synthetic provider failure", { status: 503 });
    context.mock.method(errorResponse, "json", async () => { bodyReads++; throw new Error("unexpected error-body read"); });
    context.mock.method(errorResponse, "text", async () => { bodyReads++; return `synthetic@example.test ${credential}`; });
    const logs = ["log", "warn", "error"].map(method => context.mock.method(console, method as "log" | "warn" | "error", () => {}));
    respond = () => errorResponse;
    const url = `https://audit-http-error.test/work?access_token=${credential}`;
    const result = await classifyUrl(url, "Synthetic error fixture");
    assert.equal(result?.source, "unknown");
    assert.equal(result?.safetyAlert, null);
    assert.equal(bodyReads, 0);
    requestText(`https://audit-http-error.test/work?access_token=${marker}`, "Synthetic error fixture");
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
    respond = modelResponse;
    assert.equal((await classifyUrl(url, "Synthetic error fixture"))?.source, "ai");
    assert.equal(requests.length, 2, "an unsuccessful model result is not cached");
  });

  it("contains a mocked transport exception without logging its sensitive message and subsequently recovers", async (context) => {
    const logs = ["log", "warn", "error"].map(method => context.mock.method(console, method as "log" | "warn" | "error", () => {}));
    respond = () => { throw new Error(`synthetic@example.test ${credential}`); };
    const url = `https://audit-transport-error.test/work?access_token=${credential}`;
    const result = await classifyUrl(url, "Synthetic error fixture");
    assert.equal(result?.source, "unknown");
    assert.equal(result?.safetyAlert, null);
    const serializedRequest = requestText(`https://audit-transport-error.test/work?access_token=${marker}`, "Synthetic error fixture");
    assert.ok(!serializedRequest.includes(credential));
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
    respond = modelResponse;
    assert.equal((await classifyUrl(url, "Synthetic error fixture"))?.source, "ai");
    assert.equal(requests.length, 2);
  });
});
