import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("AI chat SSE latency guard", () => {
  const source = readFileSync("src/routes/chat.ts", "utf8");

  it("flushes SSE headers and writes an immediate opening frame", () => {
    assert.match(source, /function startSse\(/);
    assert.match(source, /res\.flushHeaders\?\.\(\)/);
    assert.match(source, /res\.write\(": connected\\n\\n"\)/);
  });

  it("uses the immediate SSE setup for both streaming chat routes", () => {
    const uses = source.match(/^\s*startSse\(res/gm) || [];
    assert.equal(uses.length, 2);
    assert.doesNotMatch(source, /"Cache-Control": "no-cache",\s*Connection: "keep-alive"/);
  });
});
