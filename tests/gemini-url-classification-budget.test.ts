import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";

type ClassifyUrl = typeof import("../src/services/aiClassification.js").classifyUrl;
type Classification = Awaited<ReturnType<ClassifyUrl>>;

function modelResponse(safetyAlert = "none"): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{
    text: JSON.stringify({ category: "educational", safetyAlert }),
  }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function controlledProvider() {
  const pending = new Set<(response: Response) => void>();
  const requests: Array<{ finish: (response: Response) => void }> = [];
  let active = 0;
  let peakActive = 0;
  let draining = false;
  const fetch: typeof globalThis.fetch = (_input, init) => {
    active += 1;
    peakActive = Math.max(peakActive, active);
    return new Promise<Response>((resolve, reject) => {
      let finished = false;
      const finish = (response: Response) => {
        if (finished) return;
        finished = true;
        active -= 1;
        pending.delete(finish);
        init?.signal?.removeEventListener("abort", abort);
        resolve(response);
      };
      const abort = () => {
        if (finished) return;
        finished = true;
        active -= 1;
        pending.delete(finish);
        init?.signal?.removeEventListener("abort", abort);
        reject(new DOMException("Controlled provider aborted", "AbortError"));
      };
      requests.push({ finish });
      pending.add(finish);
      init?.signal?.addEventListener("abort", abort, { once: true });
      if (init?.signal?.aborted) abort();
      else if (draining) finish(modelResponse());
    });
  };
  return {
    fetch,
    requests,
    get active() { return active; },
    get peakActive() { return peakActive; },
    finishWave() {
      // Reverse each wave to ensure completion order is not assumed by callers.
      for (const finish of [...pending].reverse()) finish(modelResponse());
    },
    drain() {
      draining = true;
      for (const finish of [...pending]) finish(modelResponse());
    },
  };
}

describe("Gemini URL classification provider budget", () => {
  const priorKey = process.env.GEMINI_API_KEY;
  const priorFetch = globalThis.fetch;
  let classifyUrl: ClassifyUrl;
  let provider = controlledProvider();

  before(async () => {
    process.env.GEMINI_API_KEY = "test-budget-key-never-sent";
    globalThis.fetch = (input, init) => provider.fetch(input, init);
    ({ classifyUrl } = await import("../src/services/aiClassification.js"));
  });

  after(() => {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  });

  it("admits ten active and one hundred queued distinct pages, safely sheds overflow, and reuses released permits", async () => {
    provider = controlledProvider();
    const work: Array<Promise<Classification>> = [];
    try {
      for (let index = 0; index < 111; index += 1) {
        work.push(classifyUrl(`https://provider-budget-pages.test/page/${index}`, `Distinct page ${index}`));
      }
      let overflowResult: Classification | undefined;
      const overflow = work[110];
      assert.ok(overflow);
      const overflowCompletion = overflow.then((result) => { overflowResult = result; });
      await nextTurn();
      assert.equal(provider.active, 10);
      assert.equal(provider.requests.length, 10, "queued requests must not reach the provider yet");
      assert.equal(overflowResult?.category, "unknown", "the 111th distinct request must finish without waiting for a permit");
      assert.equal(overflowResult?.safetyAlert, null);
      assert.equal(overflowResult?.source, "unknown");
      await overflowCompletion;

      // All one hundred queued pages must eventually be classified, not shed.
      for (let wave = 0; wave < 11; wave += 1) {
        assert.equal(provider.active, 10);
        provider.finishWave();
        await nextTurn();
      }
      const results = await Promise.all(work);
      assert.equal(provider.requests.length, 110);
      assert.equal(provider.peakActive, 10);
      assert.equal(provider.active, 0);
      for (const result of results.slice(0, 110)) {
        assert.equal(result?.source, "ai");
        assert.equal(result?.category, "educational");
        assert.equal(result?.safetyAlert, null);
      }

      // Retry the exact overflow input and nine new inputs after the queue drains.
      // This proves overflow was not cached and all ten permits were released.
      const recovery = [classifyUrl("https://provider-budget-pages.test/page/110", "Distinct page 110")];
      for (let index = 0; index < 9; index += 1) {
        recovery.push(classifyUrl(`https://provider-budget-pages.test/recovery/${index}`, `Recovery page ${index}`));
      }
      work.push(...recovery);
      await nextTurn();
      assert.equal(provider.active, 10);
      assert.equal(provider.requests.length, 120);
      provider.finishWave();
      for (const result of await Promise.all(recovery)) assert.equal(result?.source, "ai");
      assert.equal(provider.active, 0);
      assert.equal(provider.peakActive, 10);
    } finally {
      // Release current and future queued fetches even when an assertion fails.
      provider.drain();
      await Promise.allSettled(work);
    }
  });

  it("keeps distinct pages independent when the later request finishes first", async () => {
    provider = controlledProvider();
    const work: Array<Promise<Classification>> = [];
    try {
      const first = classifyUrl("https://provider-budget-order.test/lesson", "Lesson");
      const duplicate = classifyUrl("https://provider-budget-order.test/lesson", "Lesson");
      const second = classifyUrl("https://provider-budget-order.test/other", "Other page");
      work.push(first, duplicate, second);
      let firstFinished = false;
      const firstCompletion = first.then(() => { firstFinished = true; });
      await nextTurn();
      assert.equal(provider.requests.length, 2, "only identical page/title inputs share an in-flight request");
      const secondRequest = provider.requests[1];
      const firstRequest = provider.requests[0];
      assert.ok(secondRequest && firstRequest);
      secondRequest.finish(modelResponse("violence"));
      assert.equal((await second)?.safetyAlert, "violence");
      assert.equal(firstFinished, false);
      firstRequest.finish(modelResponse());
      const firstResult = await first;
      assert.equal(firstResult?.safetyAlert, null);
      assert.equal(await duplicate, firstResult);
      await firstCompletion;
      assert.equal(provider.active, 0);
    } finally {
      provider.drain();
      await Promise.allSettled(work);
    }
  });
});
