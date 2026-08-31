import test from "node:test";
import assert from "node:assert/strict";

import { assertClasspilotSynchronousAuthorityResult } from
  "../src/services/classpilotSynchronousAuthority.js";

test("ClassPilot authority callbacks reject a top-level asynchronous result", () => {
  assert.doesNotThrow(() => assertClasspilotSynchronousAuthorityResult(undefined));
  assert.doesNotThrow(() => assertClasspilotSynchronousAuthorityResult({ delivered: true }));
  assert.doesNotThrow(() => assertClasspilotSynchronousAuthorityResult([
    Promise.resolve(true),
  ]));

  assert.throws(
    () => assertClasspilotSynchronousAuthorityResult(Promise.resolve(true)),
    /must complete synchronously/
  );
  assert.throws(
    () => assertClasspilotSynchronousAuthorityResult({ then: () => undefined }),
    /must complete synchronously/
  );
});
