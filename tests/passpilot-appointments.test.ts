import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createAppointmentSchema, editAppointmentSchema, activateAppointmentSchema,
  validateAppointmentWindow, appointmentSchoolYearCutoff } from "../src/services/passpilotAppointmentsValidation.js";
import { parsePasspilotAppointmentsMode, readPasspilotAppointmentsMode, PASSPILOT_APPOINTMENTS_RLS_TABLES, PASSPILOT_APPOINTMENTS_ATOMIC_WRITER_CONTRACT_VERSION } from "../src/config/passpilotAppointmentsMode.js";
import { PASSPILOT_APPOINTMENTS_SQL, passpilotAppointmentsMigration } from "../src/db/passpilotAppointmentsMigration.js";
import { schoolPilot27ExpandMigrations } from "../src/db/migrations27.js";

const input = { requestId: randomUUID(), studentId: "student", destination: "nurse",
  startsAt: "2026-11-01T01:10:00-04:00", endsAt: "2026-11-01T01:40:00-04:00" };
describe("appointment time and validation contract", () => {
  it("preserves either explicitly chosen fall-back instant", () => {
    const early = createAppointmentSchema.parse(input);
    const late = createAppointmentSchema.parse({ ...input, startsAt: "2026-11-01T01:10:00-05:00", endsAt: "2026-11-01T01:40:00-05:00" });
    assert.equal(late.startsAt.getTime() - early.startsAt.getTime(), 3600000);
    assert.equal(early.startsAt.toISOString(), "2026-11-01T05:10:00.000Z");
    assert.equal(late.startsAt.toISOString(), "2026-11-01T06:10:00.000Z");
  });
  it("rejects bare wall times, caller timezone/roles and unsupported issuance fields", () => {
    for (const extra of [{ startsAt: "2026-03-08T02:10:00" }, { schoolTimezone: "UTC" }, { role: "admin" }, { recurrence: "daily" }, { autoIssue: true }]) {
      assert.equal(createAppointmentSchema.safeParse({ ...input, ...extra }).success, false);
    }
    assert.equal(activateAppointmentSchema.safeParse({ expectedRevision: 1, classId: "class", manager: true }).success, false);
    assert.equal(editAppointmentSchema.safeParse({ expectedRevision: 1 }).success, false);
  });
  it("requires a positive bounded window and a matching custom destination", () => {
    const parsed = createAppointmentSchema.parse(input); validateAppointmentWindow(parsed);
    for (const patch of [{ endsAt: parsed.startsAt }, { endsAt: new Date(parsed.startsAt.getTime() + 86400001) },
      { customDestination: "private label" }, { destination: "custom", customDestination: null }]) {
      assert.throws(() => validateAppointmentWindow({ ...parsed, ...patch }), /appointment|destination/i);
    }
  });
  it("requires configured school-year boundaries and derives the exclusive local cutoff", () => {
    const parsed = createAppointmentSchema.parse(input);
    assert.throws(() => appointmentSchoolYearCutoff({ yearStart: null, yearEnd: null }, "America/New_York", parsed.startsAt, parsed.endsAt),
      { code: "APPOINTMENT_SCHOOL_YEAR_REQUIRED" });
    const cutoff = appointmentSchoolYearCutoff({ yearStart: "2026-08-01", yearEnd: "2027-06-30" }, "America/New_York", parsed.startsAt, parsed.endsAt);
    assert.equal(cutoff.toISOString(), "2027-07-01T04:00:00.000Z");
    assert.throws(() => appointmentSchoolYearCutoff({ yearStart: "2026-08-01", yearEnd: "2026-10-31" }, "America/New_York", parsed.startsAt, parsed.endsAt),
      { code: "APPOINTMENT_OUTSIDE_SCHOOL_YEAR" });
  });
});
describe("appointment rollout contract", () => {
  it("fails closed unless the exact mode, GUC and table admission agree", () => {
    assert.equal(PASSPILOT_APPOINTMENTS_ATOMIC_WRITER_CONTRACT_VERSION, 2, "Activation requires the corrected eligibility writers");
    assert.equal(parsePasspilotAppointmentsMode({}), "off");
    assert.throws(() => parsePasspilotAppointmentsMode({ PASSPILOT_APPOINTMENTS_MODE: "true" }), { code: "PASSPILOT_APPOINTMENTS_CONFIGURATION" });
    for (const env of [{}, { PASSPILOT_APPOINTMENTS_MODE: "on" }, { PASSPILOT_APPOINTMENTS_MODE: "on", RLS_GUC_ENABLED: "true", RLS_ENABLED_TABLES: "passes" }]) {
      assert.equal(readPasspilotAppointmentsMode(env), "off");
    }
    assert.equal(readPasspilotAppointmentsMode({ PASSPILOT_APPOINTMENTS_MODE: "on", RLS_GUC_ENABLED: "true", RLS_ENABLED_TABLES: "passes,passpilot_appointments" }), "off");
    assert.equal(readPasspilotAppointmentsMode({ PASSPILOT_APPOINTMENTS_MODE: "on", RLS_GUC_ENABLED: "true", RLS_ENABLED_TABLES: PASSPILOT_APPOINTMENTS_RLS_TABLES.join(",") }), "on");
    for (const missing of PASSPILOT_APPOINTMENTS_RLS_TABLES) {
      assert.equal(readPasspilotAppointmentsMode({ PASSPILOT_APPOINTMENTS_MODE: "on", RLS_GUC_ENABLED: "true",
        RLS_ENABLED_TABLES: PASSPILOT_APPOINTMENTS_RLS_TABLES.filter(table => table !== missing).join(",") }), "off", missing);
    }
  });
  it("ships an additive checksummed migration with invoker tenant isolation and explicit-return linkage", () => {
    assert.equal(passpilotAppointmentsMigration.checksum, createHash("sha256").update(PASSPILOT_APPOINTMENTS_SQL).digest("hex"));
    assert.equal(schoolPilot27ExpandMigrations.filter(m => m.id === passpilotAppointmentsMigration.id).length, 1);
    assert.match(PASSPILOT_APPOINTMENTS_SQL, /FORCE ROW LEVEL SECURITY/);
    assert.match(PASSPILOT_APPOINTMENTS_SQL, /ON DELETE SET NULL \(pass_id\)/);
    assert.match(PASSPILOT_APPOINTMENTS_SQL, /OLD.status='active' AND NEW.status IN \('returned','canceled'\)/);
    assert.match(PASSPILOT_APPOINTMENTS_SQL, /has_table_privilege\(current_user,'public.passpilot_appointments','SELECT'\)\s+OR NOT has_table_privilege\(current_user,'public.passpilot_appointments','UPDATE'\)/);
    assert.doesNotMatch(PASSPILOT_APPOINTMENTS_SQL, /SECURITY DEFINER|PASSPILOT_APPOINTMENTS_MODE|expires_at/);
  });
  it("keeps operational rollback and configured-year retention documented", () => {
    const doc = readFileSync(new URL("../docs/PASSPILOT_APPOINTMENTS.md", import.meta.url), "utf8");
    assert.match(doc, /APPOINTMENT_SCHOOL_YEAR_REQUIRED/);
    assert.match(doc, /current school year/);
    assert.match(doc, /schema-aware/);
    assert.match(doc, /overdue/);
  });
});
