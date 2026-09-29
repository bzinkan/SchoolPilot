import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { sql } from "drizzle-orm";

// RLS_SERIAL: meaningful only on the restricted, non-owner CI role with
// RLS_GUC_ENABLED=true and the passpilotRules bundle in RLS_ENABLED_TABLES.
// In the ordinary DB lane (database owner) every case is skipped.
const RLS = process.env.RLS_GUC_ENABLED === "true";
const RULE_TABLES = [
  "passpilot_destination_policies",
  "passpilot_pass_limits",
  "passpilot_encounter_restrictions",
  "passpilot_pass_denials",
] as const;
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
process.env.PASSPILOT_RULES_MODE = "on";

const TAG = `pp_rules_rls_${Date.now()}`;
let system: Client | undefined;
let db: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let sessionPool: typeof import("../src/db.js").sessionPool;
let runWithTenantContext: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let signUserToken: typeof import("../src/services/jwt.js").signUserToken;
let rules: typeof import("../src/services/passpilotRules.js");
let rulesAdmin: typeof import("../src/services/passpilotRulesAdmin.js");
let server: Server | undefined;
let baseUrl = "";

type Tenant = { schoolId: string; adminId: string; teacherId: string; gradeId: string; students: string[] };
const tenants: Tenant[] = [];
const userIds: string[] = [];

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function rejectedByPolicy(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const { message, cause } = current as { message?: unknown; cause?: unknown };
    if (/row-level security|policy/i.test(String(message ?? ""))) return true;
    current = cause;
  }
  return false;
}

async function createTenant(label: string): Promise<Tenant> {
  const schoolId = randomUUID(), adminId = randomUUID(), teacherId = randomUUID(), gradeId = randomUUID();
  const run = (text: string, values: unknown[]) => system!.query(text, values);
  await run(`INSERT INTO schools(id, name, status, is_active, plan_status, school_timezone) VALUES ($1, $2, 'active', true, 'active', 'UTC')`, [schoolId, `${TAG} ${label}`]);
  await run("INSERT INTO product_licenses(school_id, product, status) VALUES ($1, 'PASSPILOT', 'active')", [schoolId]);
  await run(`INSERT INTO settings(school_id, school_name, ws_shared_key, passpilot_class_source, enable_tracking_hours, instructional_calendar)
    VALUES ($1, $2, 'fixture', 'legacy_grades', false, '{}')`, [schoolId, `${TAG} ${label}`]);
  for (const [id, role] of [[adminId, "school_admin"], [teacherId, "teacher"]] as const) {
    userIds.push(id);
    await run("INSERT INTO users(id, email, first_name, last_name) VALUES ($1, $2, 'Rls', 'Rules')", [id, `${TAG}-${id.slice(0, 8)}@example.test`]);
    await run("INSERT INTO school_memberships(school_id, user_id, role, status) VALUES ($1, $2, $3, 'active')", [schoolId, id, role]);
  }
  await run("INSERT INTO grades(id, school_id, name) VALUES ($1, $2, 'Rules class')", [gradeId, schoolId]);
  await run("INSERT INTO teacher_grades(teacher_id, grade_id) VALUES ($1, $2)", [teacherId, gradeId]);
  const students: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const id = randomUUID();
    await run("INSERT INTO students(id, school_id, first_name, last_name, status, grade_id) VALUES ($1, $2, $3, 'Student', 'active', $4)", [id, schoolId, `${label}${index}`, gradeId]);
    await run("INSERT INTO passpilot_grade_students(school_id, grade_id, student_id) VALUES ($1, $2, $3)", [schoolId, gradeId, id]);
    students.push(id);
  }
  const tenant = { schoolId, adminId, teacherId, gradeId, students };
  tenants.push(tenant);
  return tenant;
}

async function seedRuleRows(tenant: Tenant) {
  const [first, second] = [tenant.students[0]!, tenant.students[1]!].sort();
  const run = (text: string, values: unknown[]) => system!.query(text, values);
  await run("INSERT INTO passpilot_destination_policies(school_id, destination, max_concurrent) VALUES ($1, 'nurse', 2)", [tenant.schoolId]);
  await run("INSERT INTO passpilot_pass_limits(school_id, student_id, daily_limit) VALUES ($1, NULL, 5)", [tenant.schoolId]);
  await run("INSERT INTO passpilot_encounter_restrictions(school_id, student_a_id, student_b_id) VALUES ($1, $2, $3)", [tenant.schoolId, first, second]);
  await run(`INSERT INTO passpilot_pass_denials(school_id, student_id, destination, rule_code, issued_via)
    VALUES ($1, $2, 'nurse', 'PASSPILOT_RULE_DAILY_LIMIT', 'teacher')`, [tenant.schoolId, first]);
}

async function readSchools(table: string, schoolIds: string[]): Promise<string[]> {
  const ids = sql.join(schoolIds.map((id) => sql`${id}`), sql`, `);
  const result: any = await db.execute(sql`SELECT school_id FROM ${sql.raw(table)} WHERE school_id IN (${ids}) ORDER BY school_id`);
  return result.rows.map((row: { school_id: string }) => row.school_id);
}

before(async () => {
  if (!RLS) return;
  system = new Client({ connectionString: process.env.DATABASE_URL });
  await system.connect();
  await system.query("SELECT set_config('app.is_super', 'on', false)");
  const dbModule = await import("../src/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  ({ runWithTenantContext } = await import("../src/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../src/services/jwt.js"));
  rules = await import("../src/services/passpilotRules.js");
  rulesAdmin = await import("../src/services/passpilotRulesAdmin.js");
  const { createApp } = await import("../src/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  if (!RLS) return;
  try {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    const schoolIds = tenants.map((tenant) => tenant.schoolId);
    // Best effort: once the staff-identity contract is installed, users and
    // schools are retained records that cannot be hard-deleted.
    const bestEffort = (text: string, values: unknown[]) => system!.query(text, values).catch(() => undefined);
    if (system && schoolIds.length) {
      for (const table of [...RULE_TABLES, "student_timeline_events", "passes", "audit_logs"]) {
        await bestEffort(`DELETE FROM ${table} WHERE school_id = ANY($1::text[])`, [schoolIds]);
      }
      await bestEffort("DELETE FROM teacher_grades WHERE teacher_id = ANY($1::text[])", [userIds]);
      for (const table of ["passpilot_grade_students", "students", "grades", "settings", "school_memberships", "product_licenses"]) {
        await bestEffort(`DELETE FROM ${table} WHERE school_id = ANY($1::text[])`, [schoolIds]);
      }
      await bestEffort("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
      await bestEffort("DELETE FROM schools WHERE id = ANY($1::text[])", [schoolIds]);
    }
  } finally {
    await system?.end().catch(() => undefined);
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.allSettled([pool?.end(), sessionPool?.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});

describe("PassPilot rule tables under forced RLS", { skip: RLS ? false : "requires the RLS lane (RLS_GUC_ENABLED=true)" }, () => {
  it("runs as a role that cannot bypass the policies, with the bundle admitted", async () => {
    const role = await system!.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
    const enabled = new Set((process.env.RLS_ENABLED_TABLES ?? "").split(","));
    for (const table of RULE_TABLES) assert.ok(enabled.has(table), `${table} must be admitted in RLS_ENABLED_TABLES`);
    const forced = await system!.query("SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity", [[...RULE_TABLES]]);
    assert.equal(forced.rowCount, RULE_TABLES.length);
  });

  it("scopes every rule table to the tenant context and denies reads without one", async () => {
    const [a, b] = [await createTenant("A"), await createTenant("B")];
    await seedRuleRows(a);
    await seedRuleRows(b);
    const ids = [a.schoolId, b.schoolId];
    for (const table of RULE_TABLES) {
      assert.deepEqual(await inSchool(a.schoolId, () => readSchools(table, ids)), [a.schoolId], table);
      assert.deepEqual(await inSchool(b.schoolId, () => readSchools(table, ids)), [b.schoolId], table);
      const unscoped = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE school_id = ANY($1::text[])`, [ids]);
      assert.equal(unscoped.rows[0].count, 0, `${table} is deny-by-default without a tenant GUC`);
    }
  });

  it("rejects cross-school inserts WITH CHECK and never touches another school's rows", async () => {
    const [a, b] = [await createTenant("C"), await createTenant("D")];
    await seedRuleRows(b);
    const [first, second] = [b.students[0]!, b.students[1]!].sort();
    const inserts = [
      sql`INSERT INTO passpilot_destination_policies(school_id, destination, max_concurrent) VALUES (${b.schoolId}, 'office', 3)`,
      sql`INSERT INTO passpilot_pass_limits(school_id, student_id, daily_limit) VALUES (${b.schoolId}, ${first}, 1)`,
      sql`INSERT INTO passpilot_encounter_restrictions(school_id, student_a_id, student_b_id) VALUES (${b.schoolId}, ${first}, ${b.students[2]!})`,
      sql`INSERT INTO passpilot_pass_denials(school_id, student_id, destination, rule_code, issued_via) VALUES (${b.schoolId}, ${second}, 'office', 'PASSPILOT_RULE_ENCOUNTER', 'kiosk')`,
    ];
    for (const statement of inserts) {
      await assert.rejects(inSchool(a.schoolId, () => db.execute(statement)), rejectedByPolicy);
    }
    for (const table of RULE_TABLES) {
      const updated: any = await inSchool(a.schoolId, () => db.execute(sql`UPDATE ${sql.raw(table)} SET school_id = school_id WHERE school_id = ${b.schoolId}`));
      assert.equal(updated.rowCount, 0, `${table} update`);
      const deleted: any = await inSchool(a.schoolId, () => db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE school_id = ${b.schoolId}`));
      assert.equal(deleted.rowCount, 0, `${table} delete`);
    }
    const survived = await system!.query("SELECT count(*)::int AS count FROM passpilot_encounter_restrictions WHERE school_id = $1", [b.schoolId]);
    assert.equal(survived.rows[0].count, 1);
  });

  it("rejects a denial written under school B with school A's data and hides A's rules from B", async () => {
    const [a, b] = [await createTenant("E"), await createTenant("F")];
    await seedRuleRows(a);
    const snapshot = {
      schoolId: a.schoolId, studentId: a.students[2]!, destination: "bathroom", ruleCode: "PASSPILOT_RULE_DAILY_LIMIT" as const,
      issuedVia: "teacher" as const, actorUserId: a.teacherId, teacherId: a.teacherId, classSource: "legacy_grades" as const,
      gradeId: a.gradeId, classpilotGroupId: null, supervisionContextId: null, issuingKioskSessionId: null,
      windowKind: "day" as const, details: { count: 1, limit: 1 }, overridden: false,
    };
    assert.equal(await inSchool(b.schoolId, () => rules.recordPasspilotRuleDenial(snapshot)), false, "the best-effort writer reports failure");
    const leaked = await system!.query("SELECT count(*)::int AS count FROM passpilot_pass_denials WHERE school_id = $1 AND student_id = $2", [a.schoolId, a.students[2]]);
    assert.equal(leaked.rows[0].count, 0);
    assert.equal(await inSchool(a.schoolId, () => rules.recordPasspilotRuleDenial(snapshot)), true);

    const seenByB = await inSchool(b.schoolId, () => rulesAdmin.getPasspilotRules(a.schoolId));
    assert.deepEqual([seenByB.destinationPolicies, seenByB.defaultLimits, seenByB.studentLimits, seenByB.encounterRestrictions], [[], null, [], []]);
    const seenByA = await inSchool(a.schoolId, () => rulesAdmin.getPasspilotRules(a.schoolId));
    assert.equal(seenByA.destinationPolicies.length, 1);
    assert.equal(seenByA.encounterRestrictions.length, 1);
    assert.equal(await inSchool(b.schoolId, () => rulesAdmin.getPasspilotStudentRuleRecords(a.schoolId, a.students[0]!)), null);
  });

  it("evaluates rules and records denials on the request path under forced RLS", async () => {
    const tenant = await createTenant("G");
    const [out, next] = [tenant.students[0]!, tenant.students[1]!];
    const headers = (userId: string) => ({
      "content-type": "application/json",
      authorization: `Bearer ${signUserToken({ userId, email: `${TAG}-${userId.slice(0, 8)}@example.test`, isSuperAdmin: false })}`,
      "x-school-id": tenant.schoolId,
    });
    const saved = await fetch(`${baseUrl}/passpilot/admin/rules/destinations/bathroom`, {
      method: "PUT", headers: headers(tenant.adminId), body: JSON.stringify({ maxConcurrent: 1, enabled: true }),
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const issue = (studentId: string) => fetch(`${baseUrl}/passpilot/passes`, {
      method: "POST", headers: headers(tenant.teacherId), body: JSON.stringify({ studentId, gradeId: tenant.gradeId, destination: "bathroom" }),
    });
    assert.equal((await issue(out)).status, 201);
    const denied = await issue(next);
    assert.equal(denied.status, 409);
    assert.equal(((await denied.json()) as { code: string }).code, "PASSPILOT_RULE_DESTINATION_CAPACITY");
    const rows = await system!.query("SELECT rule_code, issued_via, actor_user_id FROM passpilot_pass_denials WHERE school_id = $1 AND student_id = $2", [tenant.schoolId, next]);
    assert.deepEqual(rows.rows, [{ rule_code: "PASSPILOT_RULE_DESTINATION_CAPACITY", issued_via: "teacher", actor_user_id: tenant.teacherId }]);
  });
});
