import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("lane listing flushes every classified path to a paused subprocess reader", { timeout: 15_000 }, async (context) => {
  const temporaryRoot = resolve(tmpdir());
  const fixture = mkdtempSync(join(temporaryRoot, "schoolpilot-lane-listing-"));
  let child;
  const abortChild = () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  };
  context.signal.addEventListener("abort", abortChild, { once: true });
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "tests", "nested"), { recursive: true });
    copyFileSync(new URL("../scripts/run-test-lane.mjs", import.meta.url), join(fixture, "scripts", "run-test-lane.mjs"));
    const expected = new Map([
      ["tests/classpilot-final-delivery-context.integration.test.ts", "rls"],
      ["tests/classpilot-stop-focus-frame.test.ts", "db"],
      ["tests/deploy-classpilot-tile-auth-plan-gate.test.ts", "infrastructure"],
      ["tests/nested/deploy-synthetic-gate.test.mjs", "infrastructure"],
    ]);
    for (let index = 0; index < 2_048; index += 1) {
      expected.set(`tests/synthetic-${String(index).padStart(4, "0")}-${"listing-path-".repeat(8)}.test.ts`, "unit");
    }
    for (const path of expected.keys()) writeFileSync(join(fixture, path), "");
    writeFileSync(join(fixture, "tests", "not-a-test.ts"), "");
    const expectedListing = [...expected].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([path, lane]) => `${lane}\t${path}\n`).join("");
    assert.ok(Buffer.byteLength(expectedListing) > 256 * 1_024, "fixture must exceed normal pipe buffers");

    child = spawn(process.execPath, [join(fixture, "scripts", "run-test-lane.mjs"), "list"], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    if (context.signal.aborted) abortChild();
    const chunks = [];
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdout.pause();
    // Let the child fill its pipe before any consumer drains the listing.
    await delay(250);
    child.stdout.on("data", (chunk) => { chunks.push(chunk); }).resume();
    const [code, signal] = await closed;
    assert.equal(signal, null);
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    assert.equal(Buffer.concat(chunks).toString("utf8"), expectedListing);
  } finally {
    context.signal.removeEventListener("abort", abortChild);
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
    const fixtureRelative = relative(temporaryRoot, resolve(fixture));
    assert.ok(fixtureRelative && fixtureRelative !== ".." && !fixtureRelative.startsWith(`..${sep}`)
      && !isAbsolute(fixtureRelative) && basename(fixture).startsWith("schoolpilot-lane-listing-"),
    "recursive cleanup must remain inside the owned temporary fixture");
    rmSync(fixture, { recursive: true, force: true });
  }
});
