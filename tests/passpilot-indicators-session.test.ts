import assert from "node:assert/strict";
import { it } from "node:test";
import { skipsWebSession } from "../src/app.js";

it("keeps only the exact indicator hardware GET off the staff session pool", () => {
  assert.equal(skipsWebSession({ method: "GET", path: "/api/passpilot/indicators/state" }), true);
  for (const [method, path] of [
    ["POST", "/api/passpilot/indicators/pairings"],
    ["DELETE", "/api/passpilot/indicators/pairings/123"],
    ["POST", "/api/passpilot/indicators/state"],
    ["GET", "/api/passpilot/indicators/state/extra"],
    ["GET", "/api/passpilot/indicators/pairings"],
  ]) assert.equal(skipsWebSession({ method: method!, path: path! }), false, `${method} ${path}`);
});
