import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PASSPILOT_RULES_RLS_TABLES,
  parsePasspilotRulesMode,
  passpilotRulesRlsAdmitted,
  readPasspilotRulesMode,
} from "../src/config/passpilotRulesMode.js";
import type { PasspilotRuleDenialSnapshot } from "../src/services/passpilotRules.js";
import type { PasspilotRuleCode } from "../src/schema/passpilot.js";

// The rule services import the pool module, which requires a URL but does not
// connect until a query runs. These tests exercise pure functions only.
process.env.DATABASE_URL ||= "postgres://postgres:test@localhost:5432/schoolpilot_test";
const {
  PASSPILOT_PASS_DENIAL_RETENTION_DAYS,
  PASSPILOT_RULE_KIOSK_SEE_TEACHER_MESSAGE,
  PASSPILOT_RULE_NOT_AVAILABLE_CODE,
  PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE,
  PasspilotRuleError,
  canOverridePasspilotRules,
  isPasspilotRuleCode,
  isPasspilotRuleError,
  passpilotRuleAssistantMessage,
  passpilotRuleError,
  passpilotRuleKioskResponse,
  passpilotRuleStaffMessage,
  passpilotRuleTeacherResponse,
  purgeExpiredPasspilotPassDenials,
  resolvePasspilotRuleDay,
  selectBellPeriod,
  withoutNullRuleOverride,
} = await import("../src/services/passpilotRules.js");
const { canonicalEncounterPair } = await import("../src/services/passpilotRulesAdmin.js");

const registry = JSON.parse(
  readFileSync(new URL("../src/config/rlsRegistry.json", import.meta.url), "utf8"),
) as { reviewedEnablementRequests: Record<string, string[]> };

const ADMITTED = {
  PASSPILOT_RULES_MODE: "on",
  RLS_GUC_ENABLED: "true",
  RLS_ENABLED_TABLES: ["students", ...PASSPILOT_RULES_RLS_TABLES].join(","),
};

function denial(
  ruleCode: PasspilotRuleCode,
  overrides: Partial<PasspilotRuleDenialSnapshot> = {},
): PasspilotRuleDenialSnapshot {
  return {
    schoolId: "school-a",
    studentId: "student-a",
    destination: "bathroom",
    ruleCode,
    issuedVia: "teacher",
    actorUserId: "teacher-a",
    teacherId: "teacher-a",
    classSource: "legacy_grades",
    gradeId: "grade-a",
    classpilotGroupId: null,
    supervisionContextId: null,
    issuingKioskSessionId: null,
    windowKind: null,
    details: {},
    overridden: false,
    ...overrides,
  };
}

describe("PASSPILOT_RULES_MODE", () => {
  it("accepts only the exact values off and on", () => {
    assert.equal(parsePasspilotRulesMode({}), "off");
    assert.equal(parsePasspilotRulesMode({ PASSPILOT_RULES_MODE: "off" }), "off");
    assert.equal(parsePasspilotRulesMode({ PASSPILOT_RULES_MODE: "on" }), "on");
    for (const invalid of ["", "true", "ON", " on", "1", "enabled"]) {
      assert.throws(() => parsePasspilotRulesMode({ PASSPILOT_RULES_MODE: invalid }), /configuration is invalid/);
      assert.equal(readPasspilotRulesMode({ ...ADMITTED, PASSPILOT_RULES_MODE: invalid }), "off");
    }
  });

  it("fails closed until the whole reviewed bundle is RLS-enforced", () => {
    assert.deepEqual([...PASSPILOT_RULES_RLS_TABLES], registry.reviewedEnablementRequests.passpilotRules);
    assert.equal(readPasspilotRulesMode(ADMITTED), "on");
    assert.equal(readPasspilotRulesMode({ ...ADMITTED, RLS_GUC_ENABLED: "false" }), "off");
    assert.equal(readPasspilotRulesMode({ ...ADMITTED, RLS_GUC_ENABLED: undefined }), "off");
    for (const missing of PASSPILOT_RULES_RLS_TABLES) {
      const tables = PASSPILOT_RULES_RLS_TABLES.filter((table) => table !== missing).join(",");
      assert.equal(readPasspilotRulesMode({ ...ADMITTED, RLS_ENABLED_TABLES: tables }), "off", missing);
    }
    assert.equal(passpilotRulesRlsAdmitted({ RLS_GUC_ENABLED: "true", RLS_ENABLED_TABLES: "" }), false);
    assert.equal(readPasspilotRulesMode({ ...ADMITTED, PASSPILOT_RULES_MODE: "off" }), "off");
  });
});

describe("PassPilot rule errors and messages", () => {
  it("builds a 409 exposable error that survives module duplication checks", () => {
    const error = passpilotRuleError(denial("PASSPILOT_RULE_DAILY_LIMIT", { details: { count: 2, limit: 2 }, windowKind: "day" }));
    assert.ok(error instanceof PasspilotRuleError);
    assert.equal(error.code, "PASSPILOT_RULE_DAILY_LIMIT");
    assert.equal(error.status, 409);
    assert.equal(error.expose, true);
    assert.equal(error.message, "2 passes today (limit 2).");
    assert.equal(isPasspilotRuleError(error), true);
    const lookalike = { code: "PASSPILOT_RULE_DAILY_LIMIT", status: 409, passpilotRule: error.passpilotRule };
    assert.equal(isPasspilotRuleError(lookalike), true);
    assert.equal(isPasspilotRuleError(Object.assign(new Error("x"), { code: "PASSPILOT_RULE_DAILY_LIMIT", status: 409 })), false);
    assert.equal(isPasspilotRuleError(Object.assign(new Error("x"), { code: "PASSPILOT_CLASS_ACCESS_DENIED", status: 409, passpilotRule: {} })), false);
    assert.equal(isPasspilotRuleCode("PASSPILOT_RULE_ENCOUNTER"), true);
    assert.equal(isPasspilotRuleCode(PASSPILOT_RULE_NOT_AVAILABLE_CODE), false);
  });

  it("writes factual, non-stigmatizing staff messages", () => {
    assert.equal(passpilotRuleStaffMessage(denial("PASSPILOT_RULE_DAILY_LIMIT", { details: { count: 1, limit: 1 } })), "1 pass today (limit 1).");
    assert.equal(passpilotRuleStaffMessage(denial("PASSPILOT_RULE_DESTINATION_CAPACITY", { details: { count: 3, limit: 3 } })),
      "Bathroom is at capacity (3 of 3 out).");
    assert.equal(passpilotRuleStaffMessage(denial("PASSPILOT_RULE_DESTINATION_CAPACITY", { destination: "nurse", details: { count: 1, limit: 1 } })),
      "Nurse is at capacity (1 of 1 out).");
    assert.equal(passpilotRuleStaffMessage(denial("PASSPILOT_RULE_PERIOD_LIMIT", {
      windowKind: "bell_period", details: { count: 2, limit: 2, windowLabel: "Period 3" },
    })), "2 passes during Period 3 (limit 2).");
    assert.equal(passpilotRuleStaffMessage(denial("PASSPILOT_RULE_PERIOD_LIMIT", {
      windowKind: "class_window", details: { count: 1, limit: 1, windowLabel: "Biology" },
    })), "1 pass during this class session (limit 1).");
    assert.equal(passpilotRuleStaffMessage(denial("PASSPILOT_RULE_PERIOD_LIMIT", {
      windowKind: "kiosk_block", details: { count: 1, limit: 1, windowLabel: "Math" },
    })), "1 pass during Math (limit 1).");
    const encounter = denial("PASSPILOT_RULE_ENCOUNTER", { details: { restrictionId: "restriction-1" } });
    assert.doesNotMatch(passpilotRuleStaffMessage(encounter), /student-|restriction-1/);
    // An unshaped encounter error never names or implies a restriction.
    assert.equal(passpilotRuleError(encounter).message, PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE);
    for (const message of [
      passpilotRuleStaffMessage(denial("PASSPILOT_RULE_DAILY_LIMIT", { details: { count: 12, limit: 3 } })),
      PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE,
      PASSPILOT_RULE_KIOSK_SEE_TEACHER_MESSAGE,
    ]) {
      assert.doesNotMatch(message, /frequent|problem|abuse|excessive|violat/i);
    }
  });

  it("gives encounter codes and override only to administrators", () => {
    for (const role of ["admin", "school_admin", "super_admin"]) assert.equal(canOverridePasspilotRules(role), true, role);
    for (const role of ["office_staff", "teacher", null, undefined, "kiosk"]) assert.equal(canOverridePasspilotRules(role), false, String(role));

    const encounter = passpilotRuleError(denial("PASSPILOT_RULE_ENCOUNTER", { details: { restrictionId: "restriction-1" } }));
    const admin = passpilotRuleTeacherResponse(encounter, "school_admin");
    assert.equal(admin.code, "PASSPILOT_RULE_ENCOUNTER");
    assert.equal(admin.canOverride, true);
    assert.deepEqual(admin.rule, { kind: "encounter" });
    for (const role of ["teacher", "office_staff"]) {
      const staff = passpilotRuleTeacherResponse(encounter, role);
      assert.deepEqual(staff, { error: PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE, code: PASSPILOT_RULE_NOT_AVAILABLE_CODE, canOverride: false });
    }

    const capacity = passpilotRuleError(denial("PASSPILOT_RULE_DESTINATION_CAPACITY", { details: { count: 2, limit: 2 } }));
    const teacher = passpilotRuleTeacherResponse(capacity, "teacher");
    assert.equal(teacher.code, "PASSPILOT_RULE_DESTINATION_CAPACITY");
    assert.equal(teacher.canOverride, false);
    assert.deepEqual(teacher.rule, { kind: "destination_capacity", count: 2, limit: 2, destination: "bathroom" });
    assert.equal(passpilotRuleAssistantMessage(encounter), PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE);
    assert.equal(passpilotRuleAssistantMessage(capacity), "Bathroom is at capacity (2 of 2 out).");
  });

  it("keeps kiosk bodies student-facing and no more specific than the message", () => {
    const capacity = passpilotRuleKioskResponse(passpilotRuleError(denial("PASSPILOT_RULE_DESTINATION_CAPACITY", {
      issuedVia: "kiosk", details: { count: 4, limit: 4 },
    })));
    assert.deepEqual(capacity, {
      error: "Bathroom is full right now. Please try again in a few minutes.",
      code: "PASSPILOT_RULE_DESTINATION_CAPACITY",
    });
    for (const code of ["PASSPILOT_RULE_DAILY_LIMIT", "PASSPILOT_RULE_PERIOD_LIMIT", "PASSPILOT_RULE_ENCOUNTER"] as const) {
      const body = passpilotRuleKioskResponse(passpilotRuleError(denial(code, { issuedVia: "kiosk", details: { count: 5, limit: 5 } })));
      assert.deepEqual(Object.keys(body).sort(), ["code", "error"]);
      assert.deepEqual(body, { error: PASSPILOT_RULE_KIOSK_SEE_TEACHER_MESSAGE, code: PASSPILOT_RULE_NOT_AVAILABLE_CODE }, code);
    }
  });
});

describe("selectBellPeriod", () => {
  const config = {
    periods: [{ id: "p1", name: "Period 1" }, { id: "p2", name: "Period 2" }],
    profiles: [{ id: "std", name: "Standard", periods: { p1: { startTime: "08:00", endTime: "09:00" }, p2: { startTime: "09:00", endTime: "09:50" } } }],
  };
  const schoolDay = { instructional: true, profileId: "std" };

  it("uses half-open school-local windows in Los Angeles and UTC", () => {
    const la = (iso: string) => selectBellPeriod(config, schoolDay, "2026-09-29", "America/Los_Angeles", new Date(iso));
    assert.equal(la("2026-09-29T14:59:00Z"), null, "07:59 PDT is before the first period");
    assert.equal(la("2026-09-29T15:00:00Z")?.periodId, "p1", "08:00 PDT starts Period 1");
    assert.equal(la("2026-09-29T15:59:00Z")?.label, "Period 1");
    assert.equal(la("2026-09-29T16:00:00Z")?.periodId, "p2", "09:00 PDT belongs to Period 2, not Period 1");
    assert.equal(la("2026-09-29T16:50:00Z"), null, "09:50 PDT ends Period 2");
    const p1 = la("2026-09-29T15:30:00Z");
    assert.equal(p1?.startsAt.toISOString(), "2026-09-29T15:00:00.000Z");
    assert.equal(p1?.endsAt.toISOString(), "2026-09-29T16:00:00.000Z");
    const utc = (iso: string) => selectBellPeriod(config, schoolDay, "2026-09-29", "UTC", new Date(iso));
    assert.equal(utc("2026-09-29T07:59:59Z"), null);
    assert.equal(utc("2026-09-29T08:00:00Z")?.periodId, "p1");
    assert.equal(utc("2026-09-29T08:59:59Z")?.periodId, "p1");
    assert.equal(utc("2026-09-29T09:00:00Z")?.periodId, "p2");
  });

  it("resolves wall-clock boundaries across both DST transitions", () => {
    const early = { periods: [{ id: "zero", name: "Zero hour" }], profiles: [{ id: "std", name: "Std", periods: { zero: { startTime: "01:00", endTime: "03:00" } } }] };
    // 2026-03-08: 01:00 PST is 09:00Z; 03:00 PDT is 10:00Z (a one-hour period).
    const spring = (iso: string) => selectBellPeriod(early, schoolDay, "2026-03-08", "America/Los_Angeles", new Date(iso));
    assert.equal(spring("2026-03-08T08:59:59Z"), null);
    assert.equal(spring("2026-03-08T09:00:00Z")?.periodId, "zero");
    assert.equal(spring("2026-03-08T09:59:59Z")?.periodId, "zero");
    assert.equal(spring("2026-03-08T10:00:00Z"), null);
    // 2026-11-01: 01:00 resolves to the earlier PDT instant (08:00Z); 03:00 PST is 11:00Z.
    const autumn = (iso: string) => selectBellPeriod(early, schoolDay, "2026-11-01", "America/Los_Angeles", new Date(iso));
    assert.equal(autumn("2026-11-01T07:59:59Z"), null);
    assert.equal(autumn("2026-11-01T08:00:00Z")?.periodId, "zero");
    assert.equal(autumn("2026-11-01T10:59:59Z")?.periodId, "zero");
    assert.equal(autumn("2026-11-01T11:00:00Z"), null);
    // Monday after the spring change: 08:00 PDT is 15:00Z, not the 16:00Z of PST.
    assert.equal(selectBellPeriod(config, schoolDay, "2026-03-09", "America/Los_Angeles", new Date("2026-03-09T15:00:00Z"))?.periodId, "p1");
    assert.equal(selectBellPeriod(config, schoolDay, "2026-03-06", "America/Los_Angeles", new Date("2026-03-06T15:00:00Z")), null);
  });

  it("handles periods that cross the UTC date and non-instructional days", () => {
    const late = { periods: [{ id: "late", name: "Late" }], profiles: [{ id: "std", name: "Std", periods: { late: { startTime: "16:00", endTime: "17:00" } } }] };
    const window = selectBellPeriod(late, schoolDay, "2026-09-29", "America/Los_Angeles", new Date("2026-09-29T23:30:00Z"));
    assert.equal(window?.startsAt.toISOString(), "2026-09-29T23:00:00.000Z");
    assert.equal(window?.endsAt.toISOString(), "2026-09-30T00:00:00.000Z");
    assert.equal(selectBellPeriod(config, { instructional: false, profileId: "std" }, "2026-09-29", "UTC", new Date("2026-09-29T08:30:00Z")), null);
    assert.equal(selectBellPeriod(config, { instructional: true, profileId: null }, "2026-09-29", "UTC", new Date("2026-09-29T08:30:00Z")), null);
    assert.equal(selectBellPeriod(config, { instructional: true, profileId: "missing" }, "2026-09-29", "UTC", new Date("2026-09-29T08:30:00Z")), null);
    const overlapping = {
      periods: [{ id: "b", name: "B" }, { id: "a", name: "A" }],
      profiles: [{ id: "std", name: "Std", periods: { a: { startTime: "08:00", endTime: "10:00" }, b: { startTime: "08:00", endTime: "09:00" } } }],
    };
    assert.equal(selectBellPeriod(overlapping, schoolDay, "2026-09-29", "UTC", new Date("2026-09-29T08:30:00Z"))?.periodId, "b",
      "equal starts resolve by configured period order");
  });
});

describe("school-local day bounds", () => {
  it("counts the Los Angeles day, not the UTC day", () => {
    // 06:30Z is 23:30 PDT on the previous local date.
    const lateEvening = resolvePasspilotRuleDay(new Date("2026-09-29T06:30:00Z"), "America/Los_Angeles");
    assert.equal(lateEvening.localDate, "2026-09-28");
    assert.equal(lateEvening.dayStart.toISOString(), "2026-09-28T07:00:00.000Z");
    assert.equal(lateEvening.dayEnd.toISOString(), "2026-09-29T07:00:00.000Z");
    const nextMorning = resolvePasspilotRuleDay(new Date("2026-09-29T07:00:00Z"), "America/Los_Angeles");
    assert.equal(nextMorning.localDate, "2026-09-29");
    const springDay = resolvePasspilotRuleDay(new Date("2026-03-08T20:00:00Z"), "America/Los_Angeles");
    assert.equal(springDay.dayEnd.getTime() - springDay.dayStart.getTime(), 23 * 3_600_000);
    assert.equal(resolvePasspilotRuleDay(new Date("2026-09-29T06:30:00Z"), null).timeZone, "America/New_York");
  });
});

describe("encounter pairs, DTOs, and retention", () => {
  it("stores pairs canonically regardless of request order", () => {
    assert.deepEqual(canonicalEncounterPair("b-student", "a-student"), ["a-student", "b-student"]);
    assert.deepEqual(canonicalEncounterPair("a-student", "b-student"), ["a-student", "b-student"]);
    assert.deepEqual(canonicalEncounterPair("0f3e", "0F3E"), ["0F3E", "0f3e"], "code-unit order matches the C collation");
  });

  it("omits a null ruleOverrideCode so off-mode pass responses are unchanged", () => {
    assert.deepEqual(withoutNullRuleOverride({ id: "p", ruleOverrideCode: null }), { id: "p" });
    assert.deepEqual(withoutNullRuleOverride({ id: "p", ruleOverrideCode: undefined }), { id: "p" });
    assert.deepEqual(withoutNullRuleOverride({ id: "p", ruleOverrideCode: "PASSPILOT_RULE_DAILY_LIMIT" }),
      { id: "p", ruleOverrideCode: "PASSPILOT_RULE_DAILY_LIMIT" });
  });

  it("conceals a retained encounter override from the default pass DTO without changing the record", () => {
    const retained = { id: "p", ruleOverrideCode: "PASSPILOT_RULE_ENCOUNTER" };
    assert.deepEqual(withoutNullRuleOverride(retained), { id: "p" });
    assert.equal(retained.ruleOverrideCode, "PASSPILOT_RULE_ENCOUNTER");
  });

  it("retains encounter override metadata only for administrator roles", () => {
    const retained = { id: "p", ruleOverrideCode: "PASSPILOT_RULE_ENCOUNTER" };
    for (const role of [undefined, null, "teacher", "office_staff", "parent", "ADMIN", "unknown"]) {
      assert.deepEqual(withoutNullRuleOverride(retained, role), { id: "p" }, String(role));
    }
    for (const role of ["admin", "school_admin", "super_admin"]) {
      assert.deepEqual(withoutNullRuleOverride(retained, role), retained, role);
    }
  });

  it("purges denials older than 400 days in bounded batches", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const results = [5000, 12];
    const connection = {
      query: async (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return { rowCount: results.shift() ?? 0 };
      },
    };
    const now = new Date("2026-09-29T12:00:00Z");
    assert.equal(PASSPILOT_PASS_DENIAL_RETENTION_DAYS, 400);
    assert.equal(await purgeExpiredPasspilotPassDenials(connection, now), 5012);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call.text, /DELETE FROM passpilot_pass_denials WHERE id IN \(\s*SELECT id FROM passpilot_pass_denials WHERE denied_at < \$1/);
      assert.match(call.text, /LIMIT 5000/);
      assert.deepEqual(call.values, [new Date("2025-08-25T12:00:00Z")]);
    }
  });
});
