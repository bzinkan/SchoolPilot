import assert from "node:assert/strict";
import { it } from "node:test";
import { indicatorPassMaskQuery } from "../src/services/passpilotIndicatorsRuntime.js";
import type { IndicatorPairing } from "../src/services/passpilotIndicatorsStore.js";

const pairing: IndicatorPairing = { version: 1, pairingId: "35370e6e-6f38-4c50-87c6-f97c38424aba", tokenHash: "a".repeat(64), schoolId: "school-1", userId: "teacher-1", classId: "class-1", classSource: "legacy_grades", issuedAt: 1, expiresAt: 2592000001 };

it("emits a mask query bound to school, issuing author, exact source class and an active same-school student", () => {
  for (const [source, column] of [["legacy_grades", "grade_id"], ["classpilot_groups", "classpilot_group_id"]] as const) {
    const query = indicatorPassMaskQuery({ ...pairing, classSource: source, waterCustomDestination: "Water" }).toSQL();
    assert.match(query.sql, new RegExp(`"passes"\\."${column}" = \\$\\d+`));
    assert.match(query.sql, /"passes"\."teacher_id" = \$\d+/);
    assert.match(query.sql, /"passes"\."school_id" = \$\d+/);
    assert.match(query.sql, /"passes"\."status" = \$\d+/);
    assert.match(query.sql, /"students"\."school_id" = "passes"\."school_id"/);
    assert.match(query.sql, /"students"\."id" = "passes"\."student_id"/);
    assert.match(query.sql, /"students"\."status" = \$\d+/);
    assert.ok(query.params.includes("school-1"));
    assert.ok(query.params.includes("teacher-1"));
    assert.ok(query.params.includes("class-1"));
    assert.ok(query.params.includes("Water"));
    assert.equal(query.params.filter((value) => value === "active").length, 2);
    assert.doesNotMatch(query.sql, /expires_at|returned_at|issued_at/);
  }
});
