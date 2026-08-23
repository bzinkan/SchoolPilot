import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("database diagnostics never emit query parameters or raw SQL", () => {
  const source = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  assert.match(source, /DB_QUERY_DIAGNOSTICS/);
  assert.match(source, /shapeSha256/);
  assert.match(source, /parameterCount: params\.length/);
  assert.doesNotMatch(source, /logger:\s*process\.env\.NODE_ENV/);
  assert.doesNotMatch(source, /console\.(?:log|debug|info)\([^\n]*(?:params|query)\s*[,)]/);
});
