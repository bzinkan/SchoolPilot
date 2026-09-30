import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { appointmentFixture, type AppointmentFixture, type AppointmentTenant } from "./helpers/passpilotAppointmentFixture.js";
import type { getPasspilotReportSummary, getPasspilotReportPage, getPasspilotReportCapabilities } from "../src/services/passpilotReports.js";
import registry from "../src/config/rlsRegistry.json" with { type: "json" };

process.env.NODE_ENV = "test"; process.env.REDIS_URL = "";
process.env.PASSPILOT_REPORTS_MODE = "v2"; process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = registry.inventories.passpilotAppointmentsPostExpand.tables.join(",");
type Summary = Awaited<ReturnType<typeof getPasspilotReportSummary>>;
type Page = Awaited<ReturnType<typeof getPasspilotReportPage>>;
type Capabilities = Awaited<ReturnType<typeof getPasspilotReportCapabilities>>;
let f: AppointmentFixture, legacy: AppointmentTenant, canonical: AppointmentTenant, other: AppointmentTenant, privileged: Client;
before(async () => {
  f = await appointmentFixture(); legacy = await f.createTenant(); canonical = await f.createTenant(true); other = await f.createTenant();
  privileged = new Client({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  await privileged.connect(); await privileged.query("SELECT set_config('app.is_super','on',false)");
});
afterEach(async () => { await f.reset(); process.env.PASSPILOT_REPORTS_MODE = "v2"; });
after(async () => { await privileged.end(); await f.close(); });
const base = () => new Date(Math.floor((Date.now() - 3_600_000) / 60_000) * 60_000);
function query(extra: Record<string, string> = {}) {
  return new URLSearchParams({ from: new Date(Date.now() - 86_400_000).toISOString(), through: new Date(Date.now() + 86_400_000).toISOString(), ...extra });
}
async function request(t: AppointmentTenant, person = t.admin, endpoint = "summary", params = query()) {
  return fetch(`${f.url}/passpilot/reports/${endpoint}${params ? `?${params}` : ""}`, { headers: f.headers(t, person) });
}
async function report(t = legacy, person = t.admin, params = query()): Promise<Summary> {
  const result = await request(t, person, "summary", params); assert.equal(result.status, 200, await result.clone().text());
  return await result.json() as Summary;
}
async function pass(t: AppointmentTenant, index: number, patch: { status?: string; teacherId?: string | null; gradeId?: string | null; classId?: string | null;
  issuedAt?: Date; expiresAt?: Date; returnedAt?: Date | null; destination?: string; issuedVia?: string; override?: string | null } = {}) {
  const issuedAt = patch.issuedAt || base(), id = randomUUID();
  await f.sql(`INSERT INTO passes(id,school_id,student_id,teacher_id,grade_id,classpilot_group_id,destination,status,issued_at,expires_at,returned_at,issued_via,rule_override_code,notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Private pass note')`,
  [id, t.schoolId, t.students[index], patch.teacherId === undefined ? t.teacher.id : patch.teacherId,
    patch.gradeId === undefined ? t.canonical ? null : t.classId : patch.gradeId,
    patch.classId === undefined ? t.canonical ? t.classId : null : patch.classId,
    patch.destination || "office", patch.status || "returned", issuedAt.toISOString(), (patch.expiresAt || new Date(+issuedAt + 300_000)).toISOString(),
    patch.returnedAt === undefined ? new Date(+issuedAt + 300_000).toISOString() : patch.returnedAt?.toISOString() ?? null,
    patch.issuedVia || "teacher", patch.override || null]);
  return id;
}
async function denial(t: AppointmentTenant, code: string, teacher = t.teacher, classId = t.classId) {
  await f.sql(`INSERT INTO passpilot_pass_denials(school_id,student_id,destination,rule_code,issued_via,teacher_id,grade_id,classpilot_group_id,details,overridden)
    VALUES($1,$2,'office',$3,'teacher',$4,$5,$6,$7,true)`, [t.schoolId, t.students[0], code, teacher.id,
    t.canonical ? null : classId, t.canonical ? classId : null, { restrictionId: "confidential-pair", reason: "Private encounter reason" }]);
}
describe("PassPilot Reports v2 HTTP, audit and retained confidentiality", { concurrency: false }, () => {
  it("steps aside while off or incomplete, and verifies current staff capabilities", async () => {
    for (const mode of ["off", "on", "V2"]) {
      process.env.PASSPILOT_REPORTS_MODE = mode;
      assert.equal((await fetch(`${f.url}/passpilot/reports/capabilities`)).status, 404);
    }
    process.env.PASSPILOT_REPORTS_MODE = "v2";
    const allowlist = process.env.RLS_ENABLED_TABLES;
    try { process.env.RLS_ENABLED_TABLES = "students,passes,passpilot_pass_denials,passpilot_appointments"; assert.equal((await request(legacy, legacy.admin, "capabilities", new URLSearchParams())).status, 404); }
    finally { process.env.RLS_ENABLED_TABLES = allowlist; }
    for (const [person, scope, evidence] of [[legacy.admin, "school", true], [legacy.office, "school", false], [legacy.teacher, "teacher_history", false]] as const) {
      const res = await request(legacy, person, "capabilities", new URLSearchParams()); assert.equal(res.status, 200);
      const body = await res.json() as Capabilities; assert.equal(body.scope, scope); assert.equal(body.administratorEvidence, evidence);
      assert.equal(body.version, 2); assert.equal(body.schoolTimezone, "UTC"); assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.equal((await request(legacy, legacy.parent, "capabilities", new URLSearchParams())).status, 403);
  });
  it("separates completed duration/overdue denominators from currently open overdue passes", async () => {
    const issued = base();
    for (const [index, seconds] of [300, 180, 420].entries()) await pass(legacy, index, { issuedAt: issued, returnedAt: new Date(+issued + seconds * 1000) });
    await pass(legacy, 3, { status: "active", issuedAt: issued, returnedAt: null });
    await pass(legacy, 4, { status: "active", expiresAt: new Date(Date.now() + 3_600_000), returnedAt: null });
    await pass(legacy, 5, { status: "canceled", returnedAt: null }); await pass(legacy, 6, { status: "expired", returnedAt: null });
    await pass(legacy, 7, { returnedAt: null }); await pass(legacy, 8, { returnedAt: new Date(+issued - 1000) });
    const result = await report(); assert.deepEqual(result.counts, { total: 9, active: 2, returned: 5, canceled: 1, historicalExpired: 1, other: 0 });
    assert.deepEqual(result.completedDuration, { count: 3, totalSeconds: 900, averageSeconds: 300, invalidCompletedCount: 2 });
    assert.deepEqual(result.completedOverdueRate, { numerator: 1, denominator: 3, ratio: 1 / 3 });
    assert.equal(result.openCount, 2); assert.equal(result.currentlyOverdueCount, 1); assert.ok(result.coverage.codes.includes("INVALID_COMPLETED_TIMESTAMPS"));
    assert.equal((await f.sql("SELECT status FROM passes WHERE school_id=$1 AND status='active'", [legacy.schoolId])).rowCount, 2);
  });
  it("reports null ratios/no-data and excludes invalid deadlines only from eligible rates", async () => {
    const empty = await report(); assert.equal(empty.coverage.state, "no_data"); assert.equal(empty.completedDuration.averageSeconds, null); assert.equal(empty.completedOverdueRate.ratio, null);
    assert.ok(empty.coverage.codes.includes("RETAINED_RECORDS_ONLY"));
    await pass(legacy, 0, { expiresAt: new Date(+base() - 1000) });
    const result = await report(); assert.equal(result.completedDuration.count, 1); assert.equal(result.completedOverdueRate.denominator, 0);
    assert.equal(result.completedOverdueRate.ratio, null); assert.ok(result.coverage.codes.includes("INVALID_PASS_DEADLINES"));
  });
  it("uses exact half-open boundaries and explicitly school-local hourly buckets across DST", async () => {
    await f.sql("UPDATE schools SET school_timezone='America/New_York' WHERE id=$1", [legacy.schoolId]);
    for (const [index, instant] of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-02T05:00:00Z"].entries()) await pass(legacy, index, { issuedAt: new Date(instant) });
    const result = await report(legacy, legacy.admin, query({ from: "2026-11-01T00:00:00-04:00", through: "2026-11-02T00:00:00-05:00" }));
    assert.equal(result.counts.total, 2); assert.equal(result.periods.kind, "school_local_hour");
    assert.deepEqual(result.periods.buckets, [{ hour: 1, count: 2, label: "01:00–01:59" }]);
    assert.ok(result.coverage.codes.includes("HISTORICAL_BELL_PERIODS_UNAVAILABLE"));
  });
  it("keeps retained encounter overrides private in teacher/office summary, pass pages and CSV with Rules on or off", async () => {
    await pass(legacy, 0, { override: "PASSPILOT_RULE_ENCOUNTER" }); await denial(legacy, "PASSPILOT_RULE_ENCOUNTER");
    await f.sql("UPDATE students SET first_name=' =HYPERLINK(\"https://invalid.example\")' WHERE id=$1", [legacy.students[0]]);
    for (const mode of ["on", "off"]) {
      process.env.PASSPILOT_RULES_MODE = mode;
      for (const person of [legacy.teacher, legacy.office]) {
        const result = await report(legacy, person); assert.equal(result.recordedDenials.count, 1); assert.equal(result.overrides, null);
        assert.equal(result.coverage.administratorEvidence, false); assert.equal(JSON.stringify(result).includes("PASSPILOT_RULE_ENCOUNTER"), false);
        const rowsResponse = await request(legacy, person, "passes"); const rows = await rowsResponse.json() as Page; assert.equal(rows.passes.length, 1);
        assert.equal("ruleOverrideCode" in rows.passes[0]!, false); assert.equal("notes" in rows.passes[0]!, false);
        for (const kind of ["passes", "summary"]) {
          const csv = await request(legacy, person, "export.csv", query({ kind })); assert.equal(csv.status, 200);
          const body = await csv.text(); assert.equal(body.includes("PASSPILOT_RULE_ENCOUNTER"), false); assert.equal(body.includes("confidential-pair"), false);
          assert.equal(body.includes("Private"), false);
          if (kind === "passes") assert.ok(body.includes('"\'=HYPERLINK(""https://invalid.example"") Fixture"'));
          else {
            assert.ok(body.includes("RETAINED_RECORDS_ONLY"));
            assert.ok(body.trim().split("\r\n").every(line => line.split(",").length === 5), "Summary metrics and coverage must share the five-column CSV contract");
          }
        }
      }
      const admin = await report(); assert.deepEqual(admin.overrides, { count: 1, byRule: [{ ruleCode: "PASSPILOT_RULE_ENCOUNTER", count: 1 }] });
      const adminCsv = await request(legacy, legacy.admin, "export.csv", query({ kind: "passes" })); assert.ok((await adminCsv.text()).includes("PASSPILOT_RULE_ENCOUNTER"));
    }
    const durable = await f.sql("SELECT rule_override_code FROM passes WHERE school_id=$1", [legacy.schoolId]);
    assert.equal(durable.rows[0].rule_override_code, "PASSPILOT_RULE_ENCOUNTER");
  });
  it("reuses teacher history attribution and scopes current appointments after reassignment, including cross-tenant filters", async () => {
    await pass(canonical, 0); await pass(canonical, 1, { teacherId: canonical.outsider.id }); await denial(canonical, "PASSPILOT_RULE_DAILY_LIMIT");
    await f.create(canonical, 2); await pass(other, 0);
    const before = await report(canonical, canonical.teacher); assert.equal(before.counts.total, 2); assert.equal(before.recordedDenials.count, 1); assert.equal(before.appointments?.total, 1);
    await f.assignTeacher(canonical, canonical.outsider);
    const after = await report(canonical, canonical.teacher); assert.equal(after.counts.total, 1); assert.equal(after.recordedDenials.count, 1); assert.equal(after.appointments?.total, 0);
    const ownStudentHistory = await report(canonical, canonical.teacher, query({ studentId: canonical.students[0]! }));
    assert.equal(ownStudentHistory.counts.total, 1); assert.equal(ownStudentHistory.appointments?.total, 0);
    assert.equal((await report(other)).counts.total, 1);
    for (const params of [query({ classId: other.classId }), query({ studentId: other.students[0]! }), query({ teacherId: other.teacher.id })]) assert.equal((await request(canonical, canonical.admin, "summary", params)).status, 403);
    assert.equal((await request(canonical, canonical.teacher, "summary", query({ teacherId: canonical.outsider.id }))).status, 403);
  });
  it("shares class/student/destination/channel filters and rejects invented encounter filters", async () => {
    await pass(legacy, 0, { destination: "office" }); await pass(legacy, 1, { destination: "nurse", issuedVia: "kiosk" });
    await pass(legacy, 2, { destination: "custom" });
    assert.equal((await report(legacy, legacy.admin, query({ destination: "custom" }))).counts.total, 1);
    assert.equal((await report(legacy, legacy.admin, query({ destination: "nurse", issuedVia: "kiosk" }))).counts.total, 1);
    assert.equal((await report(legacy, legacy.teacher, query({ gradeId: legacy.classId, studentId: legacy.students[0]! }))).counts.total, 1);
    const invalidFilters: Record<string, string>[] = [{ ruleCode: "PASSPILOT_RULE_ENCOUNTER" }, { relationshipId: "pair" }, { role: "admin" }, { classId: legacy.classId, gradeId: legacy.classId }];
    for (const extra of invalidFilters) assert.equal((await request(legacy, legacy.admin, "summary", query(extra))).status, 400);
    const unsupported = await report(legacy, legacy.admin, query({ issuedVia: "teacher" })); assert.equal(unsupported.appointments, null); assert.ok(unsupported.coverage.codes.includes("APPOINTMENT_FILTER_UNAVAILABLE"));
  });
  it("uses matured appointment denominators without future/still-open or cancelled windows", async () => {
    const now = Date.now();
    for (const [index, status] of ["scheduled", "activated", "completed", "cancelled", "scheduled", "scheduled"].entries()) {
      const start = index >= 4 ? now + (index === 4 ? 3_600_000 : -60_000) : now - 3_600_000;
      const end = index >= 4 ? now + 7_200_000 : now - 1_800_000;
      const created = await f.create(legacy, index, { startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString() });
      assert.equal(created.status, 201);
      await f.sql("UPDATE passpilot_appointments SET status=$2,starts_at=$3,ends_at=$4,staff_notes='Hidden manager context' WHERE id=$1", [created.body.appointment.id, status, new Date(start), new Date(end)]);
    }
    process.env.PASSPILOT_APPOINTMENTS_MODE = "off";
    const result = await report(); assert.deepEqual(result.appointments, { total: 6, scheduled: 2, activated: 1, completed: 1, cancelled: 1,
      missed: 1, futureWindowCount: 1, maturedWindowCount: 3, missedRate: { numerator: 1, denominator: 3, ratio: 1 / 3 }, attribution: "current_student_roster" });
    assert.equal(JSON.stringify(result).includes("Hidden manager context"), false);
  });
  it("paginates equal timestamps exactly once and refuses changed filters/cross-viewer cursors", async () => {
    const issued = base(); for (let i = 0; i < 5; i++) await pass(legacy, i, { issuedAt: issued });
    const params = query({ limit: "2" }); let cursor: string | null = null; const seen = new Set<string>();
    do {
      const res = await request(legacy, legacy.admin, "passes", new URLSearchParams([...params, ...(cursor ? [["cursor", cursor] as [string, string]] : [])]));
      assert.equal(res.status, 200); const body = await res.json() as Page;
      for (const row of body.passes) { assert.equal(seen.has(row.id), false); seen.add(row.id); }
      if (!cursor) {
        assert.ok(body.nextCursor); assert.equal((await request(legacy, legacy.admin, "passes", new URLSearchParams([...params, ["cursor", body.nextCursor!], ["destination", "nurse"]]))).status, 400);
        assert.equal((await request(legacy, legacy.office, "passes", new URLSearchParams([...params, ["cursor", body.nextCursor!]]))).status, 400);
      }
      cursor = body.nextCursor;
    } while (cursor);
    assert.equal(seen.size, 5);
  });
  it("strictly audits exports without content and fails closed when the same-transaction audit fails", async () => {
    await pass(legacy, 0);
    const csv = await request(legacy, legacy.office, "export.csv", query({ kind: "passes" })); assert.equal(csv.status, 200);
    const audits = await f.sql("SELECT user_role,metadata FROM audit_logs WHERE school_id=$1 AND action='passpilot.report.exported'", [legacy.schoolId]);
    assert.equal(audits.rowCount, 1); assert.equal(audits.rows[0].user_role, "office_staff"); assert.equal(audits.rows[0].metadata.rowCount, 1);
    assert.equal(JSON.stringify(audits.rows).includes("Private"), false); assert.equal(JSON.stringify(audits.rows).includes(legacy.students[0]!), false);
    const name = `report_audit_failure_${randomUUID().replaceAll("-", "")}`;
    await privileged.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='passpilot.report.exported' THEN RAISE EXCEPTION 'synthetic report audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${name}();`);
    try {
      const failure = await request(legacy, legacy.admin, "export.csv", query({ kind: "passes" })); assert.equal(failure.status, 500);
      assert.equal(failure.headers.get("content-type")?.includes("text/csv"), false);
      assert.equal((await f.sql("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='passpilot.report.exported'", [legacy.schoolId])).rows[0].count, 1);
    } finally { await privileged.query(`DROP TRIGGER ${name} ON audit_logs; DROP FUNCTION ${name}();`); }
  });
  it("rechecks committed membership/license changes after a real school-lock wait and returns no stale report or CSV", async () => {
    await pass(legacy, 0);
    for (const change of ["membership", "license"] as const) {
      await privileged.query("BEGIN");
      const blocker = await privileged.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await privileged.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [legacy.schoolId]);
      const pending = request(legacy, legacy.teacher, "export.csv", query({ kind: "passes" }));
      try {
        const deadline = Date.now() + 5000; let waiting = false;
        while (Date.now() < deadline) {
          // Activity snapshots are cached within a transaction, and wide school
          // selects may be truncated before their FROM/lock clause. Match the
          // exact connection holding the school lock instead of SQL fragments.
          await privileged.query("SELECT pg_stat_clear_snapshot()");
          const result = await privileged.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock'
              AND $1=ANY(pg_blocking_pids(pid))) AS waiting`, [blocker.rows[0]!.pid]);
          if (result.rows[0]!.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, "The report must wait on the canonical school lifecycle lock");
        if (change === "membership") {
          await privileged.query("DELETE FROM teacher_grades WHERE teacher_id=$1", [legacy.teacher.id]);
          await privileged.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [legacy.schoolId, legacy.teacher.id]);
        } else await privileged.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1 AND product='PASSPILOT'", [legacy.schoolId]);
        await privileged.query("COMMIT");
        const result = await pending; assert.ok([403, 409].includes(result.status), `Authority change must fail closed: ${result.status}`);
        assert.equal(result.headers.get("content-type")?.includes("text/csv"), false);
        assert.equal((await f.sql("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='passpilot.report.exported'", [legacy.schoolId])).rows[0].count, 0);
      } finally { await privileged.query("ROLLBACK"); await pending; await f.reset(); }
    }
  });
  it("refuses oversized CSV without truncation or audit and reflects student deletion", async () => {
    await f.sql(`INSERT INTO passes(school_id,student_id,teacher_id,grade_id,destination,status,issued_at,expires_at,returned_at)
      SELECT $1,$2,$3,$4,'office','returned',now()-interval '1 hour',now()-interval '55 minutes',now()-interval '59 minutes' FROM generate_series(1,10001)`,
    [legacy.schoolId, legacy.students[0], legacy.teacher.id, legacy.classId]);
    const oversized = await request(legacy, legacy.admin, "export.csv", query({ kind: "passes" })); assert.equal(oversized.status, 409);
    const oversizedBody = await oversized.json() as { code: string }; assert.equal(oversizedBody.code, "PASSPILOT_REPORT_EXPORT_LIMIT");
    assert.equal((await f.sql("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='passpilot.report.exported'", [legacy.schoolId])).rows[0].count, 0);
    await denial(legacy, "PASSPILOT_RULE_ENCOUNTER"); await f.create(legacy, 0);
    await f.sql("DELETE FROM passes WHERE school_id=$1", [legacy.schoolId]);
    const id = legacy.students[0]!; await f.sql("DELETE FROM students WHERE id=$1 AND school_id=$2", [id, legacy.schoolId]);
    try { const erased = await report(); assert.equal(erased.counts.total, 0); assert.equal(erased.recordedDenials.count, 0); assert.equal(erased.appointments?.total, 0); }
    finally {
      await f.sql("INSERT INTO students(id,school_id,first_name,last_name,status,grade_id) VALUES($1,$2,'Student0','Fixture','active',$3)", [id, legacy.schoolId, legacy.classId]);
      await f.sql("INSERT INTO passpilot_grade_students(school_id,grade_id,student_id) VALUES($1,$2,$3)", [legacy.schoolId, legacy.classId, id]);
    }
  });
});
