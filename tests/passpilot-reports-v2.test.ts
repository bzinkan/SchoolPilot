import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePasspilotReportsMode, readPasspilotReportsMode, PASSPILOT_REPORTS_RLS_TABLES } from "../src/config/passpilotReportsMode.js";
import { passpilotReportFiltersSchema, reportScopeFingerprint, encodeReportCursor, decodeReportCursor,
  encodePasspilotReportCsv } from "../src/services/passpilotReportsValidation.js";

describe("PassPilot Reports v2 boundaries", () => {
  it("defaults off and requires every preserved admission with exact v2", () => {
    assert.equal(parsePasspilotReportsMode({}), "off");
    for (const value of ["on", "V2", " v2", "v2 "]) assert.throws(() => parsePasspilotReportsMode({ PASSPILOT_REPORTS_MODE: value }));
    const enabled = { PASSPILOT_REPORTS_MODE: "v2", RLS_GUC_ENABLED: "true", RLS_ENABLED_TABLES: PASSPILOT_REPORTS_RLS_TABLES.join(",") };
    assert.equal(readPasspilotReportsMode(enabled), "v2");
    for (const table of PASSPILOT_REPORTS_RLS_TABLES) assert.equal(readPasspilotReportsMode({ ...enabled,
      RLS_ENABLED_TABLES: PASSPILOT_REPORTS_RLS_TABLES.filter(candidate => candidate !== table).join(",") }), "off");
    assert.equal(readPasspilotReportsMode({ ...enabled, RLS_GUC_ENABLED: "TRUE" }), "off");
  });
  it("requires bounded offset-bearing instants and rejects confidential or caller authority filters", () => {
    const valid = { from: "2026-11-01T00:00:00-04:00", through: "2026-11-02T00:00:00-05:00" };
    assert.equal(passpilotReportFiltersSchema.parse(valid).through.getTime() - passpilotReportFiltersSchema.parse(valid).from.getTime(), 25 * 3_600_000);
    assert.equal(passpilotReportFiltersSchema.parse({ ...valid, destination: "custom" }).destination, "custom");
    for (const extra of [{ from: "2026-11-01T00:00:00" }, { through: valid.from }, { through: "2028-01-01T00:00:00Z" },
      { classId: "class", gradeId: "grade" }, { ruleCode: "PASSPILOT_RULE_ENCOUNTER" }, { relationshipId: "private" },
      { schoolId: "other" }, { role: "admin" }, { schoolTimezone: "UTC" }]) {
      assert.equal(passpilotReportFiltersSchema.safeParse({ ...valid, ...extra }).success, false);
    }
  });
  it("pins cursors to normalized filters, actor, role and school", () => {
    const filters = passpilotReportFiltersSchema.parse({ from: "2026-09-01T00:00:00Z", through: "2026-09-02T00:00:00Z" });
    const scope = reportScopeFingerprint("school", "teacher", "teacher", filters);
    const cursor = encodeReportCursor({ issuedAtMs: "1788220800000", id: "pass", scope });
    assert.equal(decodeReportCursor(cursor, scope).id, "pass");
    for (const changed of [reportScopeFingerprint("other", "teacher", "teacher", filters),
      reportScopeFingerprint("school", "other", "teacher", filters), reportScopeFingerprint("school", "teacher", "office_staff", filters),
      reportScopeFingerprint("school", "teacher", "teacher", { ...filters, destination: "nurse" })]) assert.throws(() => decodeReportCursor(cursor, changed));
    for (const malformed of ["bad", Buffer.from(JSON.stringify({ issuedAtMs: "NaN", id: "pass", scope })).toString("base64url")]) assert.throws(() => decodeReportCursor(malformed, scope));
  });
  it("quotes fields and neutralizes whitespace/control-prefixed spreadsheet formulas", () => {
    const csv = encodePasspilotReportCsv([["Name", "Value"], ['A, "quoted"\nname', " =SUM(1,2)"], ["\t@danger", "\r\n+1"], ["\u0000-1", null], ["normal", 42]]);
    assert.ok(csv.startsWith("\ufeff\"Name\",\"Value\"\r\n"));
    assert.ok(csv.includes('"A, ""quoted""\nname"')); assert.ok(csv.includes('"\' =SUM(1,2)"'));
    assert.ok(csv.includes('"\'\t@danger"')); assert.ok(csv.includes('"\'\r\n+1"')); assert.ok(csv.includes('"\'\u0000-1"'));
    assert.ok(csv.endsWith('"normal","42"\r\n'));
  });
});
