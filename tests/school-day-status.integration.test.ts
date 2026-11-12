import { after, afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { schoolDayStatusFixture, type DayStatusFixture, type DayStatusTenant } from "./helpers/schoolDayStatusFixture.js";
import registry from "../src/config/rlsRegistry.json" with { type: "json" };

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = registry.inventories.classpilotTodaySchedulePostExpand.tables.join(",");
const NOW = new Date("2026-11-12T14:00:00.000Z").getTime();
type Product = "classpilot" | "passpilot" | "gopilot";
type DayStatus = {
  schoolLocalDate: string; schoolTimezone: string; evaluatedAt: string; validUntil: string;
  calendarClosed: boolean; classpilotInstructionalOverride: boolean | null;
  code?: string; error?: string;
};
let f: DayStatusFixture, school: DayStatusTenant, other: DayStatusTenant;
before(async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  f = await schoolDayStatusFixture();
  school = await f.createTenant(); other = await f.createTenant();
  for (const tenant of [school, other]) {
    await f.sql("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active'),($1,'GOPILOT','active')", [tenant.schoolId]);
    await f.schedule(tenant, { dateOverrides: {} });
  }
});
afterEach(async () => {
  mock.timers.setTime(NOW);
  await f.reset();
  for (const tenant of [school, other]) await f.schedule(tenant, { dateOverrides: {} });
});
after(async () => { if (f) await f.close(); mock.timers.reset(); });
async function call(product: Product, person = school.teacher, tenant = school, suffix = "") {
  const response = await fetch(`${f.url}/${product}/school-day-status${suffix}`, { headers: f.headers(tenant, person) });
  const text = await response.text();
  return { status: response.status, body: (text.startsWith("{") ? JSON.parse(text) : {}) as DayStatus, headers: response.headers };
}
async function closeDate(tenant: DayStatusTenant, date = "2026-11-12") {
  await f.sql("UPDATE settings SET instructional_calendar=$2 WHERE school_id=$1", [tenant.schoolId, {
    [date.slice(0, 7)]: { revision: 1, updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: null, nonInstructionalDates: [date] },
  }]);
}
async function readAt(product: Product, instant: string) {
  const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
  const { getSchoolDayStatus } = await import("../src/services/schoolDayStatus.js");
  return runWithTenantContext({ schoolId: school.schoolId }, () => getSchoolDayStatus(school.schoolId, product, new Date(instant)));
}

describe("School-day dashboard notice", { concurrency: false }, () => {
  it("lets licensed staff read only today's bounded shared-calendar notice in all three products", async () => {
    await closeDate(school);
    for (const product of ["classpilot", "passpilot", "gopilot"] as const) {
      const result = await call(product);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get("cache-control"), "no-store");
      assert.deepEqual(result.body, {
        schoolLocalDate: "2026-11-12", schoolTimezone: "UTC", evaluatedAt: "2026-11-12T14:00:00.000Z",
        validUntil: "2026-11-13T00:00:00.000Z", calendarClosed: true, classpilotInstructionalOverride: null,
      });
    }
  });
  it("keeps a ClassPilot instructional override separate from the shared school closure", async () => {
    await closeDate(school);
    await f.schedule(school, { dateOverrides: { "2026-11-12": { instructional: true } } });
    assert.equal((await call("classpilot")).body.classpilotInstructionalOverride, true);
    for (const product of ["passpilot", "gopilot"] as const) {
      assert.equal((await call(product)).body.calendarClosed, true);
      assert.equal((await call(product)).body.classpilotInstructionalOverride, null);
    }
    await f.sql("UPDATE settings SET instructional_calendar='{}' WHERE school_id=$1", [school.schoolId]);
    await f.schedule(school, { dateOverrides: { "2026-11-12": { instructional: false } } });
    assert.equal((await call("classpilot")).body.calendarClosed, false);
    assert.equal((await call("classpilot")).body.classpilotInstructionalOverride, false);
    assert.equal((await call("passpilot")).body.calendarClosed, false);
  });
  it("uses the school's current date across midnight and DST rather than the browser or UTC date", async () => {
    await f.sql("UPDATE schools SET school_timezone='America/New_York' WHERE id=$1", [school.schoolId]);
    await closeDate(school);
    let result = await readAt("passpilot", "2026-11-13T04:59:59.000Z");
    assert.equal(result.schoolLocalDate, "2026-11-12");
    assert.equal(result.calendarClosed, true);
    assert.equal(result.validUntil, "2026-11-13T05:00:00.000Z");
    result = await readAt("passpilot", "2026-11-13T05:00:00.000Z");
    assert.equal(result.schoolLocalDate, "2026-11-13");
    assert.equal(result.calendarClosed, false);
    for (const [instant, date, until] of [
      ["2026-03-08T05:00:00.000Z", "2026-03-08", "2026-03-09T04:00:00.000Z"],
      ["2026-11-01T04:00:00.000Z", "2026-11-01", "2026-11-02T05:00:00.000Z"],
    ]) {
      result = await readAt("gopilot", instant!);
      assert.equal(result.schoolLocalDate, date); assert.equal(result.validUntil, until);
    }
  });
  it("does not invent shared closures from weekends, school-year bounds, or absent schedules", async () => {
    await f.schedule(school, { yearStart: "2026-08-01", yearEnd: "2026-11-01", dateOverrides: {} });
    for (const product of ["classpilot", "passpilot", "gopilot"] as const) assert.equal((await readAt(product, "2026-11-14T14:00:00.000Z")).calendarClosed, false);
    await f.sql("DELETE FROM classpilot_school_schedules WHERE school_id=$1", [school.schoolId]);
    assert.equal((await call("classpilot")).body.classpilotInstructionalOverride, null);
  });
  it("scopes to the selected authorized school and preserves effective product roles", async () => {
    await closeDate(school);
    assert.equal((await call("passpilot", other.teacher, other)).body.calendarClosed, false);
    assert.equal((await call("passpilot", school.teacher, other)).status, 403);
    assert.equal((await call("classpilot", school.parent)).status, 403);
    assert.equal((await call("passpilot", school.parent)).status, 403);
    assert.equal((await call("gopilot", school.parent)).status, 200); // GoPilot office override on parent base role.
    assert.equal((await call("passpilot", school.office)).status, 200);
    assert.equal((await call("classpilot", school.office)).status, 200);
    const anonymous = await fetch(`${f.url}/passpilot/school-day-status`);
    assert.equal(anonymous.status, 401);
    await f.sql("UPDATE product_licenses SET status='inactive' WHERE school_id=$1 AND product='CLASSPILOT'", [school.schoolId]);
    assert.equal((await call("classpilot")).status, 403);
    assert.equal((await call("passpilot")).status, 200);
  });
  it("ignores caller dates and performs no writes or lazy schedule restoration", async () => {
    await closeDate(school);
    await f.sql("DELETE FROM classpilot_school_schedules WHERE school_id=$1", [school.schoolId]);
    const snapshot = () => f.sql("SELECT to_jsonb(s) AS snapshot FROM settings s WHERE school_id=$1", [school.schoolId]);
    const beforeRead = (await snapshot()).rows;
    const result = await call("classpilot", school.teacher, school, "?date=2026-11-13&month=2027-01");
    assert.equal(result.body.schoolLocalDate, "2026-11-12"); assert.equal(result.body.calendarClosed, true);
    assert.deepEqual((await snapshot()).rows, beforeRead);
    assert.equal((await f.sql("SELECT count(*) AS count FROM classpilot_school_schedules WHERE school_id=$1", [school.schoolId])).rows[0].count, "0");
  });
  it("returns failure for corrupt/missing calendar data instead of reporting an open day", async () => {
    await f.sql("UPDATE settings SET instructional_calendar=$2 WHERE school_id=$1", [school.schoolId, { "2026-11": { nonInstructionalDates: [] } }]);
    for (const product of ["classpilot", "passpilot", "gopilot"] as const) {
      const result = await call(product); assert.equal(result.status, 500); assert.equal(result.body.calendarClosed, undefined);
    }
    await f.sql("DELETE FROM settings WHERE school_id=$1", [school.schoolId]);
    const missing = await call("passpilot"); assert.equal(missing.status, 500); assert.equal(missing.body.calendarClosed, undefined);
    await f.sql("INSERT INTO settings(school_id,school_name,ws_shared_key) VALUES($1,'Fixture','fixture')", [school.schoolId]);
  });
});
