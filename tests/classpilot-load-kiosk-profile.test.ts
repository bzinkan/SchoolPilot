import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("PassPilot kiosk load fixture validation is credential-free", () => {
  const result = spawnSync(process.execPath, [
    "scripts/load/passpilot-kiosk-load-test.mjs",
    "--validate-fixtures",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.clientCount, 100);
  assert.equal(output.profile.clients, 100);
  assert.equal(output.profile.classesPerSchool, 30);
  assert.equal(output.profile.studentsPerSchool, 500);
  assert.equal(result.stdout.includes("private-synthetic-token"), false);
  assert.equal(result.stdout.includes("synthetic-school"), false);
});
