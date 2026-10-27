import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the overridden compiler through Drizzle's legacy loader, not tsx.
const requireFromDrizzle = createRequire(import.meta.resolve("drizzle-kit"));
const requireFromLoader = createRequire(requireFromDrizzle.resolve("@esbuild-kit/esm-loader"));
const { transform, transformSync } = requireFromLoader("@esbuild-kit/core-utils");
const source = "type Counter = { count: number }; const counter: Counter = { count: 42 }; export const answer: number = counter.count;";

function checkSourceMap(map, filePath) {
  assert.equal(map.version, 3);
  assert.deepEqual(map.sources, [filePath]);
  assert.deepEqual(map.sourcesContent, [source]);
  assert.ok(map.mappings.length > 0);
}

describe("Drizzle legacy loader compiler compatibility", () => {
  it("compiles TypeScript to executable CommonJS with a source map", () => {
    const filePath = resolve("drizzle-loader-fixture.cts");
    const result = transformSync(source, filePath);
    const module = { exports: {} };
    runInNewContext(result.code, { module }, { timeout: 1_000 });
    assert.equal(module.exports.answer, 42);
    checkSourceMap(result.map, filePath);
  });

  it("compiles TypeScript to executable ESM with a source map", async () => {
    const filePath = resolve("drizzle-loader-fixture.mts");
    const result = await transform(source, filePath);
    const compiled = await import(`data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`);
    assert.equal(compiled.answer, 42);
    checkSourceMap(result.map, filePath);
  });
});
