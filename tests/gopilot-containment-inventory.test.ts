import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("GoPilot containment inventory CLI", () => {
  it("is structurally read-only and emits only school IDs and aggregate counts", async () => {
    const source = readFileSync(
      new URL("../src/cli/auditGopilotContainment.ts", import.meta.url),
      "utf8"
    );
    assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
    const outputProjection = source.slice(
      source.indexOf("const schools = result.rows.map"),
      source.indexOf("process.stdout.write(`${JSON.stringify", source.indexOf("const schools = result.rows.map"))
    );
    assert.doesNotMatch(outputProjection, /row\.(?:first_name|last_name|email|car_number|invite_token|phone|student_id)\b/i);
    assert.match(outputProjection, /schoolId: row\.school_id/);
    assert.match(source, /REPORT_VERSION = "gopilot-school-driven-inventory-v1"/);
    assert.match(source, /mode: "read_only"/);

    const cli = await import("../src/cli/auditGopilotContainment.js");
    const originalWrite = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      assert.equal(await cli.runGopilotContainmentInventory(["--help"]), 0);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.match(output, /Read-only/);
    assert.match(output, /school IDs and counts only/);
  });
});
