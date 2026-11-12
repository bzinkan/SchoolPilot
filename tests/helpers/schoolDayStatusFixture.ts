import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { emptySchoolSchedulingConfig } from "../../src/services/classpilotSchedulingRules.js";

type Person = { id: string; email: string };
export type DayStatusTenant = { schoolId: string; teacher: Person; office: Person; parent: Person };

export async function schoolDayStatusFixture() {
  const fixtureUrl = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || "";
  for (const url of [fixtureUrl, process.env.DATABASE_URL || ""]) {
    assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname), "Only a local synthetic database is permitted");
  }
  const system = new Client({ connectionString: fixtureUrl });
  await system.connect(); await system.query("SELECT set_config('app.is_super','on',false)");
  const { pool, sessionPool } = await import("../../src/db.js");
  const { signUserToken } = await import("../../src/services/jwt.js");
  const server = createServer((await import("../../src/app.js")).createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const tenants: DayStatusTenant[] = [];
  const sql = (text: string, values: unknown[] = []) => system.query(text, values);
  async function createTenant() {
    const schoolId = randomUUID();
    await sql("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'Day status fixture','active',true,'active','UTC')", [schoolId]);
    await sql("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'PASSPILOT','active')", [schoolId]);
    await sql("INSERT INTO settings(school_id,school_name,ws_shared_key,instructional_calendar) VALUES($1,'Day status fixture','fixture','{}')", [schoolId]);
    async function person(role: string) {
      const id = randomUUID(), email = `day-status-${id}@example.test`;
      await sql("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Fixture')", [id, email]);
      await sql("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, id, role]);
      return { id, email };
    }
    const tenant = { schoolId, teacher: await person("teacher"), office: await person("office_staff"), parent: await person("parent") };
    await sql("UPDATE school_memberships SET gopilot_role='office_staff' WHERE user_id=$1", [tenant.parent.id]);
    tenants.push(tenant);
    return tenant;
  }
  async function schedule(tenant: DayStatusTenant, patch: Record<string, unknown> = {}) {
    const config = { ...emptySchoolSchedulingConfig(), ...patch };
    await sql("INSERT INTO classpilot_school_schedules(school_id,revision,config) VALUES($1,1,$2) ON CONFLICT(school_id) DO UPDATE SET config=excluded.config", [tenant.schoolId, config]);
  }
  function headers(tenant: DayStatusTenant, person: Person) {
    return { authorization: `Bearer ${signUserToken({ userId: person.id, email: person.email, isSuperAdmin: false })}`, "x-school-id": tenant.schoolId };
  }
  async function reset() {
    const ids = tenants.map(t => t.schoolId);
    await sql("UPDATE schools SET school_timezone='UTC',status='active',is_active=true WHERE id=ANY($1::text[])", [ids]);
    await sql("UPDATE school_memberships SET status='active' WHERE school_id=ANY($1::text[])", [ids]);
    await sql("UPDATE product_licenses SET status='active' WHERE school_id=ANY($1::text[])", [ids]);
    await sql("UPDATE settings SET instructional_calendar='{}' WHERE school_id=ANY($1::text[])", [ids]);
  }
  async function close() {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const { schedulerPool, schedulerLockPool } = await import("../../src/services/schedulerDb.js");
    try {
      const ids = tenants.map(t => t.schoolId);
      for (const table of ["error_logs", "audit_logs", "classpilot_school_schedules", "settings", "product_licenses"]) {
        await sql(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [ids]);
      }
      await sql("UPDATE school_memberships SET status='inactive' WHERE school_id=ANY($1::text[])", [ids]);
      await sql("UPDATE schools SET status='suspended',is_active=false,deleted_at=now() WHERE id=ANY($1::text[])", [ids]);
      // School/staff identity roots are intentionally retained by unconditional
      // lifecycle guards; do not disable those guards for a fixture teardown.
    } finally {
      await Promise.allSettled([system.end(), pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
    }
  }
  return { sql, createTenant, schedule, headers, reset, close, url };
}
export type DayStatusFixture = Awaited<ReturnType<typeof schoolDayStatusFixture>>;
