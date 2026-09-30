import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FORMS_SHORT_LINK_MAX_HOPS,
  MAX_FORMS_SHORT_LINKS_PER_REQUEST,
  isFormsShortLink,
  resolveFormsShortLink,
  resolveRestrictionResourceInputs,
  restrictionResourceInputsNeedResolution,
  restrictionResourceRequestNeedsResolution,
  type ShortLinkFetch,
  type ShortLinkResponse,
} from "../src/services/restrictionResourceResolver.js";
import { RestrictionResourceError, normalizeAllowedResource } from "../src/services/restrictionResources.js";

const FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSdPublishedFormIdAbCdEfGhIjKlMnOpQrStUvWx/viewform?usp=send_form";

type Call = { url: string; method: string; redirect: string; hasSignal: boolean };

function response(status: number, location?: string): ShortLinkResponse {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "location" ? location ?? null : null) },
    body: null,
  };
}

function scriptedFetch(script: Array<ShortLinkResponse | Error | "hang">, calls: Call[] = []): ShortLinkFetch {
  let index = 0;
  return async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect, hasSignal: init.signal instanceof AbortSignal });
    const step = script[index++];
    if (!step) throw new Error("unexpected extra request");
    if (step === "hang") {
      return new Promise<ShortLinkResponse>((_resolve, reject) => {
        // AbortSignal.timeout timers are unref'd; keep the test process alive
        // until the abort fires, as a serving API process would be.
        const keepAlive = setTimeout(() => reject(new Error("abort never fired")), 5_000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        }, { once: true });
      });
    }
    if (step instanceof Error) throw step;
    return step;
  };
}

async function unresolvedCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RestrictionResourceError);
    assert.equal(error.status, 400);
    return error.code;
  }
  assert.fail("expected the short link to stay unresolved");
}

describe("forms.gle short-link resolver", () => {
  it("follows one HEAD redirect to the Forms page, manually and with a timeout signal", async () => {
    const calls: Call[] = [];
    const resolved = await resolveFormsShortLink("forms.gle/AbCdEf123456", {
      fetch: scriptedFetch([response(302, FORM_URL)], calls),
    });
    assert.equal(resolved, FORM_URL);
    assert.deepEqual(calls, [{ url: "https://forms.gle/AbCdEf123456", method: "HEAD", redirect: "manual", hasSignal: true }]);
    assert.equal(normalizeAllowedResource({ url: resolved }).type, "resource");
  });

  it("fetches an http short link over https", async () => {
    const calls: Call[] = [];
    await resolveFormsShortLink("http://forms.gle/AbCdEf123456", { fetch: scriptedFetch([response(301, FORM_URL)], calls) });
    assert.equal(calls[0]!.url, "https://forms.gle/AbCdEf123456");
  });

  it("falls back to GET only when HEAD answers 405", async () => {
    const calls: Call[] = [];
    await resolveFormsShortLink("https://forms.gle/AbCdEf123456", {
      fetch: scriptedFetch([response(405), response(307, FORM_URL)], calls),
    });
    assert.deepEqual(calls.map((call) => call.method), ["HEAD", "GET"]);
    assert.equal(await unresolvedCode(resolveFormsShortLink("https://forms.gle/AbCdEf123456", {
      fetch: scriptedFetch([response(403)]),
    })), "RESOURCE_SHORT_LINK_UNRESOLVED", "no GET retry for any other refusal");
  });

  it("follows chained short links and resolves relative Locations", async () => {
    const resolved = await resolveFormsShortLink("https://forms.gle/AbCdEf123456", {
      fetch: scriptedFetch([response(302, "/ZyXwVu654321"), response(302, FORM_URL)]),
    });
    assert.equal(resolved, FORM_URL);
  });

  it(`stops after ${FORMS_SHORT_LINK_MAX_HOPS} hops`, async () => {
    const loop = Array.from({ length: FORMS_SHORT_LINK_MAX_HOPS + 1 }, () => response(302, "https://forms.gle/ZyXwVu654321"));
    const calls: Call[] = [];
    assert.equal(await unresolvedCode(resolveFormsShortLink("https://forms.gle/AbCdEf123456", {
      fetch: scriptedFetch(loop, calls),
    })), "RESOURCE_SHORT_LINK_UNRESOLVED");
    assert.equal(calls.length, FORMS_SHORT_LINK_MAX_HOPS);
  });

  it("rejects a redirect to anything but forms.gle or a docs.google.com Forms page", async () => {
    for (const location of [
      "https://evil.example.com/forms/d/e/x/viewform",
      "http://docs.google.com/forms/d/e/1FAIpQLSdPublishedFormIdAbCdEfGhIjKlMnOpQrStUvWx/viewform",
      "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ_-abcd/edit",
      "https://user:pass@docs.google.com/forms/d/e/x/viewform",
      "https://docs.google.com:8443/forms/d/e/x/viewform",
      "https://accounts.google.com/ServiceLogin?continue=https://docs.google.com/forms/",
      "javascript:alert(1)",
    ]) {
      assert.equal(await unresolvedCode(resolveFormsShortLink("https://forms.gle/AbCdEf123456", {
        fetch: scriptedFetch([response(302, location)]),
      })), "RESOURCE_SHORT_LINK_UNRESOLVED", location);
    }
  });

  it("treats an interstitial, a missing Location, a network error and a timeout as unresolved", async () => {
    for (const script of [[response(200)], [response(302)], [response(404)], [new Error("ECONNRESET")]]) {
      assert.equal(await unresolvedCode(resolveFormsShortLink("https://forms.gle/AbCdEf123456", {
        fetch: scriptedFetch(script),
      })), "RESOURCE_SHORT_LINK_UNRESOLVED");
    }
    const startedAt = Date.now();
    assert.equal(await unresolvedCode(resolveFormsShortLink("https://forms.gle/AbCdEf123456", {
      fetch: scriptedFetch(["hang"]),
      timeoutMs: 25,
    })), "RESOURCE_SHORT_LINK_UNRESOLVED");
    assert.ok(Date.now() - startedAt < 2_000, "the per-request timeout aborts a hung lookup");
  });

  it("never fetches a URL that is not a forms.gle short link", async () => {
    for (const value of [
      "https://evil.example.com/AbCdEf123456",
      "https://forms.gle/AbCdEf123456?next=https://evil.example.com",
      "https://forms.gle.evil.example.com/AbCdEf123456",
      "https://user@forms.gle/AbCdEf123456",
      "https://forms.gle/ab",
      "ftp://forms.gle/AbCdEf123456",
      42,
    ]) {
      const calls: Call[] = [];
      assert.equal(await unresolvedCode(resolveFormsShortLink(value, { fetch: scriptedFetch([], calls) })), "RESOURCE_SHORT_LINK_UNRESOLVED");
      assert.equal(calls.length, 0, String(value));
      assert.equal(isFormsShortLink(value), false, String(value));
    }
    assert.equal(isFormsShortLink("forms.gle/AbCdEf123456"), true);
  });
});

describe("authoring input resolution", () => {
  it("replaces only forms.gle inputs and keeps every other entry untouched", async () => {
    const inputs = [
      { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      { url: "https://forms.gle/AbCdEf123456" },
      { type: "website", hostname: "khanacademy.org" },
    ];
    assert.equal(restrictionResourceInputsNeedResolution(inputs), true);
    const resolved = await resolveRestrictionResourceInputs(inputs, { fetch: scriptedFetch([response(302, FORM_URL)]) });
    assert.deepEqual(resolved, [inputs[0], { url: FORM_URL }, inputs[2]]);
    const untouched = [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }];
    assert.equal(await resolveRestrictionResourceInputs(untouched, { fetch: scriptedFetch([]) }), untouched);
    assert.equal(await resolveRestrictionResourceInputs("not a list"), "not a list");
  });

  it("reports the failing entry and bounds the lookups per request", async () => {
    let caught: unknown;
    try {
      await resolveRestrictionResourceInputs([{ url: "https://www.nasa.gov/solar-system" }, { url: "https://forms.gle/AbCdEf123456" }], {
        fetch: scriptedFetch([response(404)]),
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof RestrictionResourceError);
    assert.equal(caught.index, 1);
    const tooMany = Array.from({ length: MAX_FORMS_SHORT_LINKS_PER_REQUEST + 1 }, (_, index) => ({
      url: `https://forms.gle/AbCdEf${String(index).padStart(6, "0")}`,
    }));
    const calls: Call[] = [];
    assert.equal(await unresolvedCode(resolveRestrictionResourceInputs(tooMany, { fetch: scriptedFetch([], calls) })), "RESOURCE_SHORT_LINK_UNRESOLVED");
    assert.equal(calls.length, 0);
  });

  it("marks only request bodies that would resolve a short link for rate limiting", () => {
    assert.equal(restrictionResourceRequestNeedsResolution({ resources: [{ url: "https://forms.gle/AbCdEf123456" }] }), true);
    assert.equal(restrictionResourceRequestNeedsResolution({ resources: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }] }), false);
    assert.equal(restrictionResourceRequestNeedsResolution({ allowedDomains: ["forms.gle"] }), false);
    const classroomImport = {
      courseId: "123",
      resources: [{ id: "a", links: [{ type: "form", url: "https://forms.gle/AbCdEf123456" }] }],
    };
    assert.equal(restrictionResourceRequestNeedsResolution(classroomImport), false, "a website-level import never resolves");
    assert.equal(restrictionResourceRequestNeedsResolution({ ...classroomImport, boundary: "resource" }), true);
    assert.equal(restrictionResourceRequestNeedsResolution({ boundary: "resource", resourceLinks: ["forms.gle/AbCdEf123456"] }), true);
    assert.equal(restrictionResourceRequestNeedsResolution(null), false);
  });
});
