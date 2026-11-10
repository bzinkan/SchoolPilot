import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contentCategories from "../src/services/classpilotContentCategories.js";
import * as browserSeverity from "../src/services/classpilotBrowserSafetySeverity.js";
import * as requestInput from "../src/services/classpilotAiRequestInput.js";
import * as performanceMetrics from "../src/services/runtimePerformanceMetrics.js";
import type { AiClassification, AiClassificationOptions } from "../src/services/aiClassification.js";

type FastClassification = (url: string, title?: string, options?: AiClassificationOptions) => AiClassification | null;
type Classifier = {
  classifyUrl: typeof import("../src/services/aiClassification.js").classifyUrl;
  classifyImmediateEducationalUrl: typeof import("../src/services/aiClassification.js").classifyImmediateEducationalUrl;
  classifyImmediateHeartbeatUrl: FastClassification;
};

const source = readFileSync(new URL("../src/services/aiClassification.ts", import.meta.url), "utf8");
const executable = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const require = createRequire(import.meta.url);

function assertClassifier(value: unknown): asserts value is Classifier {
  assert.ok(value && typeof value === "object");
  assert.equal(typeof Reflect.get(value, "classifyUrl"), "function");
  assert.equal(typeof Reflect.get(value, "classifyImmediateEducationalUrl"), "function");
  assert.equal(typeof Reflect.get(value, "classifyImmediateHeartbeatUrl"), "function");
}

// Run the real module with only provider I/O and clock controlled. Capturing its
// Map constructors lets the namespace tests supply foreign cache entries without
// adding production cache-reset/inspection methods or changing source bytes.
function fixture() {
  let now = 1_800_000_000_000;
  let denyProviderInput = false;
  let providerCalls = 0;
  let respond = async () => modelResponse("educational");
  const maps: Array<Map<unknown, unknown>> = [];
  class CapturedMap extends Map<unknown, unknown> {
    constructor(entries?: readonly (readonly [unknown, unknown])[] | null) { super(entries); maps.push(this); }
  }
  class Clock extends Date { static now() { return now; } }
  const dependencies: Record<string, unknown> = {
    "./classpilotContentCategories.js": contentCategories,
    "./classpilotBrowserSafetySeverity.js": browserSeverity,
    "./runtimePerformanceMetrics.js": performanceMetrics,
    "./classpilotAiRequestInput.js": { ...requestInput,
      prepareClasspilotAiRequestInput: (...args: Parameters<typeof requestInput.prepareClasspilotAiRequestInput>) => (
        denyProviderInput ? { kind: "unavailable", reasonCode: "credential_context" } : requestInput.prepareClasspilotAiRequestInput(...args)
      ),
    },
  };
  const exported: unknown = {};
  runInNewContext(executable, {
    exports: exported,
    require(name: string) { return Object.hasOwn(dependencies, name) ? dependencies[name] : require(name); },
    process: { env: { GEMINI_API_KEY: "synthetic-key" } },
    fetch: async () => { providerCalls++; return respond(); },
    URL, Buffer, AbortController, AbortSignal, performance, setTimeout, clearTimeout,
    Date: Clock, Map: CapturedMap,
  });
  assertClassifier(exported);
  const fast: FastClassification = (...args) => exported.classifyImmediateHeartbeatUrl(...args);
  return {
    api: exported, fast, calls: () => providerCalls,
    advance(ms: number) { now += ms; },
    denyProviderInput() { denyProviderInput = true; },
    respond(value: () => Response | Promise<Response>) { respond = async () => value(); },
    movePageEntry(from: RegExp, to: string) {
      const cache = maps.find(map => [...map.keys()].some(key => typeof key === "string" && key.startsWith("page|")));
      assert.ok(cache, "the real classifier must first cache a completed model result");
      const entry = [...cache.entries()].find(([key]) => typeof key === "string" && key.startsWith("page|"));
      assert.ok(entry && typeof entry[0] === "string");
      const next = entry[0].replace(from, to);
      assert.notEqual(next, entry[0]);
      cache.delete(entry[0]); cache.set(next, entry[1]);
    },
  };
}

function modelResponse(category: string, safetyAlert = "none") {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{
    text: JSON.stringify({ category, contentCategory: category === "educational" ? "Education" : null, safetyAlert }),
  }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("a completed cached unknown can be inserted without starting another classification", async () => {
  const f = fixture(), url = "https://unclassified-fast.test/lesson";
  assert.equal(f.fast(url, "Lesson", { useAiFallback: false }), null, "an unseen unknown stays on the normal classifier path");
  const expected = await f.api.classifyUrl(url, "Lesson", { useAiFallback: false });
  assert.equal(expected?.category, "unknown");
  const result = f.fast(url, "Lesson", { useAiFallback: false });
  assert.equal(result?.category, "unknown");
  assert.equal(result?.safetyAlert, null);
  assert.equal(result?.source, "unknown");
  assert.equal(result?.classifiedAt, 1_800_000_000_000);
  assert.deepEqual({ ...result }, { ...expected });
  assert.equal(f.calls(), 0);
  assert.equal(f.api.classifyImmediateEducationalUrl(url, { useAiFallback: false }), null, "legacy educational-only callers keep their contract");
});

test("completed safe model decisions reuse all final fields for only the exact observed page and title", async () => {
  for (const category of ["educational", "unknown"]) {
    const f = fixture(), url = `https://model-${category}-fast.test/lesson?a=1&a=2#part`;
    f.respond(() => modelResponse(category));
    assert.equal(f.fast(url, "Lesson"), null);
    assert.equal(f.calls(), 0, "a fast-path miss must not start provider work");
    const expected = await f.api.classifyUrl(url, "Lesson");
    const result = f.fast(url, "Lesson");
    assert.equal(result?.category, category);
    assert.equal(result?.source, "ai");
    assert.equal(result?.classifiedAt, 1_800_000_000_000);
    assert.deepEqual({ ...result }, { ...expected });
    for (const [otherUrl, otherTitle] of [[url.replace("/lesson", "/Lesson"), "Lesson"],
      [url.replace("a=1&a=2", "a=2&a=1"), "Lesson"], [url.replace("#part", "#other"), "Lesson"],
      [url.replace("https:", "http:"), "Lesson"], [url.replace(".test/", ".test:8443/"), "Lesson"],
      [url, "Changed title"]]) {
      assert.equal(f.fast(otherUrl!, otherTitle), null);
    }
    assert.equal(f.calls(), 1);
  }
});

test("a deterministic unknown uses the first ordinary completion before becoming cache eligible", async () => {
  const f = fixture(), url = "https://apnews.com/lesson";
  assert.equal(f.fast(url, "News"), null);
  const expected = await f.api.classifyUrl(url, "News");
  assert.equal(expected?.category, "unknown");
  assert.equal(expected?.contentCategory, "News");
  assert.equal(f.fast(url, "News")?.category, "unknown");
  assert.equal(f.fast(url, "News")?.source, "known-list");
  assert.equal(f.calls(), 0);
});

test("absent, empty and literal Unknown titles never share model cache identity", async () => {
  const f = fixture(), url = "https://original-title-fast.test/lesson";
  await f.api.classifyUrl(url);
  assert.equal(f.fast(url)?.category, "educational");
  assert.equal(f.fast(url, ""), null);
  assert.equal(f.fast(url, "Unknown"), null);
  assert.equal(f.calls(), 1);
});

test("expired cached domain and model results cannot become immediate history", async () => {
  for (const model of [false, true]) {
    const f = fixture(), url = `https://expiry-${model}-fast.test/lesson`;
    const options = model ? {} : { useAiFallback: false };
    await f.api.classifyUrl(url, "Lesson", options);
    f.advance(30 * 60 * 1000 - 1);
    assert.ok(f.fast(url, "Lesson", options));
    f.advance(1);
    assert.equal(f.fast(url, "Lesson", options), null);
    assert.equal(f.calls(), model ? 1 : 0, "expiry never starts a provider call in the fast reader");
  }
});

test("unsafe searches override a warm educational search-domain cache", async () => {
  const f = fixture();
  assert.equal(f.fast("https://google.com/search?q=fractions", "Math")?.category, "educational");
  const url = "https://google.com/search?q=how+to+kill+myself";
  assert.equal(f.fast(url, "Math"), null);
  assert.equal((await f.api.classifyUrl(url, "Math"))?.safetyAlert, "self-harm");
  assert.equal(f.calls(), 0);
});

test("non-educational and safety classifications retain their fresh intent and safety path", async () => {
  const f = fixture();
  for (const url of ["https://youtube.com/watch?v=lesson", "https://gemini.google.com/", "https://pornhub.com/"]) {
    await f.api.classifyUrl(url, "Lesson");
    assert.equal(f.fast(url, "Lesson"), null);
  }
  for (const [category, safety] of [["non-educational", "none"], ["educational", "violence"], ["unknown", "sexual"]]) {
    const url = `https://unsafe-model-${category}-${safety}-fast.test/lesson`;
    f.respond(() => modelResponse(category!, safety));
    await f.api.classifyUrl(url, "Lesson");
    assert.equal(f.fast(url, "Lesson"), null);
  }
});

test("pending provider work is never treated as a completed cached decision", async () => {
  const f = fixture(), url = "https://pending-fast.test/lesson";
  let finish = () => {};
  f.respond(() => new Promise<Response>(resolve => { finish = () => resolve(modelResponse("educational")); }));
  const pending = f.api.classifyUrl(url, "Lesson");
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.fast(url, "Lesson"), null);
    assert.equal(f.calls(), 1);
  } finally { finish(); }
  await pending;
  assert.equal(f.fast(url, "Lesson")?.category, "educational");
});

test("school and AI-mode namespaces cannot reuse another scope's model decision", async () => {
  const f = fixture(), url = "https://scope-fast.test/lesson";
  await f.api.classifyUrl(url, "Lesson", { schoolDomain: "first-school.test" });
  assert.equal(f.fast(url, "Lesson", { schoolDomain: "first-school.test" })?.category, "educational");
  assert.equal(f.fast(url, "Lesson", { schoolDomain: "other-school.test" }), null);
  assert.equal(f.fast(url, "Lesson", { schoolDomain: "first-school.test", useAiFallback: false }), null);
  assert.equal(f.calls(), 1);
});

test("foreign model or provider-input policy cache namespaces cannot grant the fast path", async () => {
  for (const [from, to] of [[/\|model:[^|]+/, "|model:retired-model"],
    [/\|input-policy:[^|]+/, "|input-policy:retired-policy"]] as const) {
    const f = fixture(), url = "https://namespace-fast.test/lesson";
    await f.api.classifyUrl(url, "Lesson");
    f.movePageEntry(from, to);
    assert.equal(f.fast(url, "Lesson"), null);
    assert.equal(f.calls(), 1);
  }
});

test("a current provider-input denial takes precedence over an otherwise valid page cache", async () => {
  const f = fixture(), url = "https://policy-transition-fast.test/lesson";
  await f.api.classifyUrl(url, "Lesson");
  f.denyProviderInput();
  assert.equal(f.fast(url, "Lesson"), null);
  assert.equal((await f.api.classifyUrl(url, "Lesson"))?.category, "unknown");
  assert.equal(f.calls(), 1);
});

test("credential redaction never merges different original observations in the fast cache", async () => {
  const f = fixture();
  const first = "https://credential-fast.test/lesson?access_token=SYNTHETIC_FIRST&unit=math";
  const other = "https://credential-fast.test/lesson?access_token=SYNTHETIC_OTHER&unit=math";
  await f.api.classifyUrl(first, "Lesson");
  assert.equal(f.fast(first, "Lesson")?.category, "educational");
  assert.equal(f.fast(other, "Lesson"), null);
  assert.equal(f.fast(first, "Lesson password=SYNTHETIC_SECRET"), null);
  assert.equal(f.calls(), 1);
});
