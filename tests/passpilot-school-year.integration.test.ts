import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { appointmentFixture, type AppointmentFixture, type AppointmentTenant } from "./helpers/passpilotAppointmentFixture.js";
import registry from "../src/config/rlsRegistry.json" with { type: "json" };

process.env.NODE_ENV = "test"; process.env.REDIS_URL = "";
process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = registry.inventories.passpilotAppointmentsPostExpand.tables.join(",");
let f: AppointmentFixture, school: AppointmentTenant, other: AppointmentTenant;
before(async () => { f = await appointmentFixture(); school = await f.createTenant(true); other = await f.createTenant(); });
afterEach(async () => f.reset()); after(async () => f.close());
type Year = { yearStart: string | null; yearEnd: string | null; revision: number; schoolTimezone: string; schoolLocalToday: string;
  previewToken: string; blockers: { code: string; message: string }[]; error?: string; code?: string };
async function call(method: string, body?: unknown, person = school.admin, tenant = school, path = "/passpilot/school-year") {
  const response = await fetch(f.url + path, { method, headers: { "content-type": "application/json", ...f.headers(tenant, person) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as Year, headers: response.headers };
}
const year = () => ({ yearStart: `${new Date().getUTCFullYear()}-01-01`, yearEnd: `${new Date().getUTCFullYear() + 1}-06-29` });
async function preview(boundaries = year()) { const result = await call("POST", boundaries, school.admin, school, "/passpilot/school-year/preview"); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
const save = (draft: Year, boundaries = year()) => call("PUT", { ...boundaries, expectedRevision: draft.revision, previewToken: draft.previewToken });

describe("PassPilot-only canonical school-year setup", { concurrency: false }, () => {
  it("configures a PassPilot-only school while appointments are off without opening ClassPilot", async () => {
    process.env.PASSPILOT_APPOINTMENTS_MODE = "off";
    assert.deepEqual((await f.sql("SELECT product FROM product_licenses WHERE school_id=$1", [school.schoolId])).rows.map(row => row.product), ["PASSPILOT"]);
    await f.schedule(school, { yearStart: null, yearEnd: null });
    const before = await call("GET"); assert.equal(before.status, 200); assert.equal(before.body.yearStart, null); assert.equal(before.headers.get("cache-control"), "no-store");
    const draft = await preview(), result = await save(draft); assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.yearStart, year().yearStart); assert.equal(result.body.revision, draft.revision + 1); assert.equal(result.body.schoolTimezone, "UTC");
    assert.equal((await call("GET", undefined, school.admin, school, "/classpilot/admin/scheduling")).status, 403);
    assert.equal((await f.create(school)).status, 404);
    process.env.PASSPILOT_APPOINTMENTS_MODE = "on"; assert.equal((await f.create(school)).status, 201);
    assert.equal((await f.sql("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='passpilot.school_year.updated'", [school.schoolId])).rows[0].count, 1);
  });
  it("rejects teachers, office, GoPilot-only profiles, foreign administrators and inactive entitlement", async () => {
    for (const person of [school.teacher, school.office, school.parent, other.admin]) {
      assert.equal((await call("GET", undefined, person)).status, 403);
      assert.equal((await call("POST", year(), person, school, "/passpilot/school-year/preview")).status, 403);
      assert.equal((await call("PUT", { ...year(), expectedRevision: 1, previewToken: "0".repeat(64) }, person)).status, 403);
    }
    await f.sql("UPDATE product_licenses SET status='inactive' WHERE school_id=$1", [school.schoolId]); assert.equal((await call("GET")).status, 403);
  });
  it("accepts only valid bounded dates and rejects caller timezone, school, roles and other calendar fields", async () => {
    for (const body of [{ yearStart: year().yearStart }, { ...year(), schoolTimezone: "Europe/London" }, { ...year(), schoolId: other.schoolId },
      { ...year(), role: "super_admin" }, { ...year(), config: {} }, { ...year(), profiles: [] }, { ...year(), yearStart: "2026-02-30" },
      { yearStart: "2027-06-30", yearEnd: "2027-01-01" }, { yearStart: "2026-01-01", yearEnd: "2028-01-01" }]) {
      assert.equal((await call("POST", body, school.admin, school, "/passpilot/school-year/preview")).status, 400, JSON.stringify(body));
    }
    const draft = await preview(); assert.equal((await call("PUT", { ...year(), expectedRevision: draft.revision, previewToken: draft.previewToken, schoolTimezone: "UTC" })).status, 400);
  });
  it("preserves every non-year canonical field and another school's config", async () => {
    const before = (await f.sql("SELECT config FROM classpilot_school_schedules WHERE school_id=$1", [school.schoolId])).rows[0].config;
    const foreign = (await f.sql("SELECT config,revision FROM classpilot_school_schedules WHERE school_id=$1", [other.schoolId])).rows[0];
    const draft = await preview(); assert.equal((await save(draft)).status, 200);
    assert.deepEqual((await f.sql("SELECT config FROM classpilot_school_schedules WHERE school_id=$1", [school.schoolId])).rows[0].config, { ...before, ...year() });
    assert.deepEqual((await f.sql("SELECT config,revision FROM classpilot_school_schedules WHERE school_id=$1", [other.schoolId])).rows[0], foreign);
    assert.equal("profiles" in (await call("GET")).body, false);
  });
  it("requires a current matching preview and makes concurrent saves advance exactly one revision", async () => {
    const draft = await preview(), changed = { ...year(), yearEnd: `${new Date().getUTCFullYear() + 1}-06-28` };
    assert.equal((await save(draft, changed)).body.code, "SCHEDULE_PREVIEW_STALE");
    const results = await Promise.all([save(draft), save(draft)]); assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.find(result => result.status === 409)!.body.code, "SCHEDULE_PREVIEW_STALE");
    assert.equal((await call("GET")).body.revision, draft.revision + 1); assert.equal((await save(draft)).status, 409);
  });
  it("honors canonical A/B anchor blockers", async () => {
    await f.schedule(school, { cycleAnchorDate: `${new Date().getUTCFullYear()}-12-01` });
    const result = await call("POST", { yearStart: year().yearStart, yearEnd: `${new Date().getUTCFullYear()}-11-30` }, school.admin, school, "/passpilot/school-year/preview");
    assert.equal(result.status, 400); assert.match(result.body.error!, /anchor/);
  });
  it("rechecks administrator authority after waiting on the shared lifecycle lock", async () => {
    const draft = await preview(), blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT set_config('app.is_super','on',true)");
      await blocker.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [school.schoolId]);
      const request = save(draft); await new Promise(resolve => setTimeout(resolve, 100));
      await blocker.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [school.schoolId, school.admin.id]);
      await blocker.query("COMMIT"); const result = await request; assert.equal(result.status, 403); assert.equal(result.body.code, "PASSPILOT_SCHOOL_YEAR_ADMIN_REQUIRED");
      assert.equal((await f.sql("SELECT revision FROM classpilot_school_schedules WHERE school_id=$1", [school.schoolId])).rows[0].revision, draft.revision);
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
  });
  it("rolls back the canonical config/revision when strict audit persistence fails", async () => {
    const draft = await preview(), name = `year_audit_${randomUUID().replaceAll("-", "")}`;
    await f.sql(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='passpilot.school_year.updated' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try { assert.equal((await save(draft)).status, 500); assert.equal((await f.sql("SELECT revision FROM classpilot_school_schedules WHERE school_id=$1", [school.schoolId])).rows[0].revision, draft.revision); }
    finally { await f.sql(`DROP TRIGGER ${name} ON audit_logs; DROP FUNCTION ${name}()`); }
  });
});
