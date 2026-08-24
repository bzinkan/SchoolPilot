import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

const { Pool } = pg;
const RLS_TEST_ENABLED = process.env.RLS_GUC_ENABLED === "true";
const pool = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5_000,
});

const TAG = `gopilot_rls_${Date.now()}`;
const ROLE = "gopilot_rls_probe";
const TABLES = [
  "authorized_pickups",
  "custody_alerts",
  "dismissal_changes",
  "dismissal_overrides",
  "dismissal_queue",
  "family_group_students",
  "homeroom_teachers",
] as const;

const ids = {
  schoolA: `${TAG}_school_a`,
  schoolB: `${TAG}_school_b`,
  userA: `${TAG}_user_a`,
  userB: `${TAG}_user_b`,
  studentA: `${TAG}_student_a`,
  studentB: `${TAG}_student_b`,
  sessionA: `${TAG}_session_a`,
  sessionB: `${TAG}_session_b`,
  familyA: `${TAG}_family_a`,
  familyB: `${TAG}_family_b`,
  homeroomA: `${TAG}_homeroom_a`,
  homeroomB: `${TAG}_homeroom_b`,
};

let client: pg.PoolClient;

async function setSystemBypass(enabled: boolean) {
  await client.query("SELECT set_config('app.is_super', $1, false)", [enabled ? "on" : ""]);
}

async function resetProbeRole() {
  await client.query("RESET ROLE");
  await client.query("SELECT set_config('app.school_id', '', false)");
  await client.query("SELECT set_config('app.is_super', '', false)");
}

before(async () => {
  if (!RLS_TEST_ENABLED) return;
  client = await pool.connect();
  await setSystemBypass(true);
  await client.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE 'DROP OWNED BY ${ROLE}';
        EXECUTE 'DROP ROLE ${ROLE}';
      END IF;
      CREATE ROLE ${ROLE} NOSUPERUSER NOLOGIN;
    END $$
  `);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  for (const table of TABLES) {
    await client.query(`GRANT SELECT, INSERT ON ${table} TO ${ROLE}`);
  }

  await client.query(
    `INSERT INTO schools (id, name, domain, slug)
     VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
    [
      ids.schoolA, `${TAG} A`, `${TAG}-a.example.edu`, `${TAG}-a`,
      ids.schoolB, `${TAG} B`, `${TAG}-b.example.edu`, `${TAG}-b`,
    ]
  );
  await client.query(
    `INSERT INTO users (id, email, first_name, last_name)
     VALUES ($1, $2, 'Teacher', 'A'), ($3, $4, 'Teacher', 'B')`,
    [ids.userA, `${TAG}-a@example.edu`, ids.userB, `${TAG}-b@example.edu`]
  );
  await client.query(
    `INSERT INTO school_memberships (user_id, school_id, role, gopilot_role, status)
     VALUES ($1, $2, 'teacher', 'teacher', 'active'),
            ($3, $4, 'teacher', 'teacher', 'active')`,
    [ids.userA, ids.schoolA, ids.userB, ids.schoolB]
  );
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO homerooms (id, school_id, teacher_id, name, grade)
       VALUES ($1, $2, $3, 'A', '5'), ($4, $5, $6, 'B', '5')`,
      [ids.homeroomA, ids.schoolA, ids.userA, ids.homeroomB, ids.schoolB, ids.userB]
    );
    await client.query(
      `INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
       VALUES ($1, $2, $3, $4, 'primary'), ($5, $6, $7, $8, 'primary')`,
      [
        `${TAG}_homeroom_teacher_a`, ids.schoolA, ids.homeroomA, ids.userA,
        `${TAG}_homeroom_teacher_b`, ids.schoolB, ids.homeroomB, ids.userB,
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  await client.query(
    `INSERT INTO students (id, school_id, first_name, last_name, homeroom_id, status)
     VALUES ($1, $2, 'Student', 'A', $3, 'active'),
            ($4, $5, 'Student', 'B', $6, 'active')`,
    [ids.studentA, ids.schoolA, ids.homeroomA, ids.studentB, ids.schoolB, ids.homeroomB]
  );
  await client.query(
    `INSERT INTO dismissal_sessions (id, school_id, date, status)
     VALUES ($1, $2, '2099-05-01', 'active'), ($3, $4, '2099-05-01', 'active')`,
    [ids.sessionA, ids.schoolA, ids.sessionB, ids.schoolB]
  );
  await client.query(
    `INSERT INTO family_groups (id, school_id, car_number, family_name)
     VALUES ($1, $2, 'A1', 'Family A'), ($3, $4, 'B1', 'Family B')`,
    [ids.familyA, ids.schoolA, ids.familyB, ids.schoolB]
  );

  for (const suffix of ["a", "b"] as const) {
    const school = suffix === "a" ? ids.schoolA : ids.schoolB;
    const user = suffix === "a" ? ids.userA : ids.userB;
    const student = suffix === "a" ? ids.studentA : ids.studentB;
    const session = suffix === "a" ? ids.sessionA : ids.sessionB;
    const family = suffix === "a" ? ids.familyA : ids.familyB;
    await client.query(
      `INSERT INTO authorized_pickups (id, school_id, student_id, added_by, name, relationship, status)
       VALUES ($1, $2, $3, $4, 'Pickup', 'Guardian', 'pending')`,
      [`${TAG}_pickup_${suffix}`, school, student, user]
    );
    await client.query(
      `INSERT INTO custody_alerts (id, school_id, student_id, person_name, alert_type, created_by)
       VALUES ($1, $2, $3, 'Restricted', 'custody_restriction', $4)`,
      [`${TAG}_custody_${suffix}`, school, student, user]
    );
    await client.query(
      `INSERT INTO dismissal_changes
         (id, school_id, session_id, student_id, requested_by, from_type, to_type, status)
       VALUES ($1, $2, $3, $4, $5, 'car', 'walker', 'pending')`,
      [`${TAG}_change_${suffix}`, school, session, student, user]
    );
    await client.query(
      `INSERT INTO dismissal_overrides
         (id, school_id, session_id, student_id, original_type, override_type, changed_by, changed_by_role)
       VALUES ($1, $2, $3, $4, 'car', 'walker', $5, 'teacher')`,
      [`${TAG}_override_${suffix}`, school, session, student, user]
    );
    await client.query(
      `INSERT INTO dismissal_queue (id, school_id, session_id, student_id, status)
       VALUES ($1, $2, $3, $4, 'waiting')`,
      [`${TAG}_queue_${suffix}`, school, session, student]
    );
    await client.query(
      `INSERT INTO family_group_students (id, school_id, family_group_id, student_id)
       VALUES ($1, $2, $3, $4)`,
      [`${TAG}_family_student_${suffix}`, school, family, student]
    );
  }
  await setSystemBypass(false);
});

after(async () => {
  if (!RLS_TEST_ENABLED) {
    await pool.end();
    return;
  }
  try {
    await client.query("RESET ROLE");
    await setSystemBypass(true);
    await client.query("BEGIN");
    try {
      for (const table of TABLES) {
        await client.query(`DELETE FROM ${table} WHERE school_id IN ($1, $2)`, [ids.schoolA, ids.schoolB]);
      }
      await client.query("DELETE FROM family_groups WHERE school_id IN ($1, $2)", [ids.schoolA, ids.schoolB]);
      await client.query("DELETE FROM dismissal_sessions WHERE school_id IN ($1, $2)", [ids.schoolA, ids.schoolB]);
      await client.query("DELETE FROM students WHERE school_id IN ($1, $2)", [ids.schoolA, ids.schoolB]);
      await client.query("DELETE FROM homerooms WHERE school_id IN ($1, $2)", [ids.schoolA, ids.schoolB]);
      await client.query("DELETE FROM school_memberships WHERE school_id IN ($1, $2)", [ids.schoolA, ids.schoolB]);
      await client.query(
        "UPDATE schools SET status = 'suspended', is_active = false, deleted_at = now() WHERE id IN ($1, $2)",
        [ids.schoolA, ids.schoolB]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    await client.query(`DROP OWNED BY ${ROLE}`);
    await client.query(`DROP ROLE ${ROLE}`);
  } finally {
    client.release();
    await pool.end();
  }
});

describe("GoPilot child-table RLS", { concurrency: false, skip: !RLS_TEST_ENABLED }, () => {
  it("enables and forces the tenant policy on the reviewed bundle", async () => {
    const result = await client.query(
      `SELECT relation.relname, relation.relrowsecurity, relation.relforcerowsecurity,
              EXISTS (
                SELECT 1 FROM pg_policies policy
                WHERE policy.schemaname = 'public'
                  AND policy.tablename = relation.relname
                  AND policy.policyname = 'tenant_isolation'
              ) AS has_policy
       FROM pg_class relation
       WHERE relation.relname = ANY($1::text[])
       ORDER BY relation.relname`,
      [TABLES]
    );
    assert.equal(result.rows.length, TABLES.length);
    for (const row of result.rows) {
      assert.equal(row.relrowsecurity, true, row.relname);
      assert.equal(row.relforcerowsecurity, true, row.relname);
      assert.equal(row.has_policy, true, row.relname);
    }
  });

  it("shows only the active school's child rows to a non-superuser", async () => {
    await client.query(`SET ROLE ${ROLE}`);
    try {
      await client.query("SELECT set_config('app.school_id', $1, false)", [ids.schoolA]);
      for (const table of TABLES) {
        const result = await client.query(
          `SELECT school_id FROM ${table} WHERE school_id IN ($1, $2)`,
          [ids.schoolA, ids.schoolB]
        );
        assert.deepEqual(result.rows, [{ school_id: ids.schoolA }], table);
      }
    } finally {
      await resetProbeRole();
    }
  });

  it("denies by default and rejects a cross-tenant child insert", async () => {
    await client.query(`SET ROLE ${ROLE}`);
    try {
      for (const table of TABLES) {
        const result = await client.query(`SELECT school_id FROM ${table}`);
        assert.equal(result.rowCount, 0, table);
      }
      await client.query("SELECT set_config('app.school_id', $1, false)", [ids.schoolA]);
      await assert.rejects(
        client.query(
          `INSERT INTO custody_alerts
             (id, school_id, student_id, person_name, alert_type, created_by)
           VALUES ($1, $2, $3, 'Blocked', 'custody_restriction', $4)`,
          [`${TAG}_cross_tenant`, ids.schoolB, ids.studentB, ids.userB]
        ),
        /row-level security|policy/i
      );
    } finally {
      await resetProbeRole();
    }
  });
});
