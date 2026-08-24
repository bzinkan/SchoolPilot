import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

const { Pool } = pg;
const ENABLED = process.env.RLS_GUC_ENABLED === "true";
const TABLES = [
  "classpilot_schedule_change_pairs",
  "classpilot_schedule_changes",
  "classpilot_schedule_change_legs",
] as const;
const TAG = `cp_swap_rls_${Date.now()}`;
const ids = {
  schoolA: `${TAG}_school_a`,
  schoolB: `${TAG}_school_b`,
  userA: `${TAG}_user_a`,
  userB: `${TAG}_user_b`,
  pairA: `${TAG}_pair_a`,
  pairB: `${TAG}_pair_b`,
  changeA: `${TAG}_change_a`,
  changeB: `${TAG}_change_b`,
  terminalA: `${TAG}_terminal_a`,
  terminalB: `${TAG}_terminal_b`,
};

const adminPool = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  max: 1,
});
const appPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});
let admin: pg.PoolClient;
let app: pg.PoolClient;

function groupId(school: "a" | "b", order: number): string {
  return `${TAG}_${school}_group_${order}`;
}

async function setSuper(client: typeof admin, enabled: boolean): Promise<void> {
  await client.query("SELECT set_config('app.is_super', $1, false)", [enabled ? "on" : ""]);
}

async function setTenant(client: typeof app, schoolId: string): Promise<void> {
  await client.query("SELECT set_config('app.school_id', $1, false)", [schoolId]);
  await client.query("SELECT set_config('app.is_super', '', false)");
}

async function seedChange(options: {
  school: "a" | "b";
  pairId: string;
  changeId: string;
  date: string;
  status: "approved" | "cancelled";
}): Promise<void> {
  const schoolId = options.school === "a" ? ids.schoolA : ids.schoolB;
  const userId = options.school === "a" ? ids.userA : ids.userB;
  const active = options.status === "approved";
  await admin.query("BEGIN");
  try {
    await admin.query(
      `INSERT INTO classpilot_schedule_changes
         (id, school_id, pair_id, scheduled_date, timezone_snapshot, status,
          reason, requested_by_user_id, requested_by_role,
          requires_admin_approval, reservation_active)
       VALUES ($1, $2, $3, $4, 'America/New_York', $5,
               'RLS fixture', $6, 'admin', true, $7)`,
      [options.changeId, schoolId, options.pairId, options.date, options.status, userId, active]
    );
    await admin.query(
      `INSERT INTO classpilot_schedule_change_legs
         (id, school_id, schedule_change_id, scheduled_date, leg_order, group_id,
          primary_teacher_id_snapshot, class_name_snapshot,
          original_start_time, original_end_time, effective_start_time,
          effective_end_time, reservation_active)
       VALUES
         ($1, $2, $3, $4, 1, $5, $6, 'Class 1', '09:00', '10:00', '10:00', '11:00', $9),
         ($7, $2, $3, $4, 2, $8, $6, 'Class 2', '10:00', '11:00', '09:00', '10:00', $9)`,
      [
        `${options.changeId}_leg_1`, schoolId, options.changeId, options.date,
        groupId(options.school, 1), userId, `${options.changeId}_leg_2`,
        groupId(options.school, 2), active,
      ]
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

before(async () => {
  if (!ENABLED) return;
  admin = await adminPool.connect();
  app = await appPool.connect();
  await setSuper(admin, true);
  await admin.query(
    `INSERT INTO schools (id, name, domain, slug)
     VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
    [
      ids.schoolA, `${TAG} A`, `${TAG}-a.example.edu`, `${TAG}-a`,
      ids.schoolB, `${TAG} B`, `${TAG}-b.example.edu`, `${TAG}-b`,
    ]
  );
  await admin.query(
    `INSERT INTO users (id, email, first_name, last_name)
     VALUES ($1, $2, 'Teacher', 'A'), ($3, $4, 'Teacher', 'B')`,
    [ids.userA, `${TAG}-a@example.edu`, ids.userB, `${TAG}-b@example.edu`]
  );
  await admin.query(
    `INSERT INTO school_memberships (user_id, school_id, role, status)
     VALUES ($1, $2, 'teacher', 'active'), ($3, $4, 'teacher', 'active')`,
    [ids.userA, ids.schoolA, ids.userB, ids.schoolB]
  );
  await admin.query("BEGIN");
  try {
    for (const school of ["a", "b"] as const) {
      const schoolId = school === "a" ? ids.schoolA : ids.schoolB;
      const userId = school === "a" ? ids.userA : ids.userB;
      for (let order = 1; order <= 4; order += 1) {
        const currentGroupId = groupId(school, order);
        await admin.query(
          `INSERT INTO groups
             (id, school_id, teacher_id, name, group_type, status,
              schedule_enabled, block_start_time, block_end_time)
           VALUES ($1, $2, $3, $4, 'admin_class', 'active', true, $5, $6)`,
          [
            currentGroupId, schoolId, userId, `${TAG} ${school} ${order}`,
            order % 2 === 1 ? "09:00" : "10:00",
            order % 2 === 1 ? "10:00" : "11:00",
          ]
        );
        await admin.query(
          `INSERT INTO group_teachers (group_id, teacher_id, role)
           VALUES ($1, $2, 'primary')`,
          [currentGroupId, userId]
        );
      }
      const pairId = school === "a" ? ids.pairA : ids.pairB;
      await admin.query(
        `INSERT INTO classpilot_schedule_change_pairs
           (id, school_id, first_group_id, second_group_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [pairId, schoolId, groupId(school, 1), groupId(school, 2), userId]
      );
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  await seedChange({
    school: "a", pairId: ids.pairA, changeId: ids.changeA,
    date: "2099-01-12", status: "approved",
  });
  await seedChange({
    school: "b", pairId: ids.pairB, changeId: ids.changeB,
    date: "2099-01-12", status: "approved",
  });
  await seedChange({
    school: "a", pairId: ids.pairA, changeId: ids.terminalA,
    date: "2099-01-13", status: "cancelled",
  });
  await seedChange({
    school: "b", pairId: ids.pairB, changeId: ids.terminalB,
    date: "2099-01-13", status: "cancelled",
  });
  await setSuper(admin, false);
});

after(async () => {
  if (!ENABLED) {
    await Promise.all([adminPool.end(), appPool.end()]);
    return;
  }
  try {
    await setSuper(admin, true);
    await admin.query("BEGIN");
    for (const table of [...TABLES].reverse()) {
      await admin.query(`DELETE FROM ${table} WHERE school_id IN ($1, $2)`, [ids.schoolA, ids.schoolB]);
    }
    await admin.query(
      "DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id IN ($1, $2))",
      [ids.schoolA, ids.schoolB]
    );
    await admin.query("DELETE FROM groups WHERE school_id IN ($1, $2)", [ids.schoolA, ids.schoolB]);
    await admin.query("DELETE FROM school_memberships WHERE school_id IN ($1, $2)", [ids.schoolA, ids.schoolB]);
    await admin.query(
      "UPDATE schools SET status = 'suspended', is_active = false, deleted_at = now() WHERE id IN ($1, $2)",
      [ids.schoolA, ids.schoolB]
    );
    await admin.query("COMMIT");
  } catch {
    await admin.query("ROLLBACK").catch(() => undefined);
  } finally {
    app.release();
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  }
});

describe("ClassPilot schedule-change startup and forced-RLS bundle", {
  concurrency: false,
  skip: !ENABLED,
}, () => {
  it("converges validated tenant FKs, required indexes, and immutable/exact-two triggers", async () => {
    const relations = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              p.qual, p.with_check
       FROM pg_class c
       LEFT JOIN pg_policies p
         ON p.schemaname = 'public' AND p.tablename = c.relname
        AND p.policyname = 'tenant_isolation'
       WHERE c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [TABLES]
    );
    assert.equal(relations.rows.length, TABLES.length);
    for (const row of relations.rows) {
      assert.equal(row.relrowsecurity, true, row.relname);
      assert.equal(row.relforcerowsecurity, true, row.relname);
      assert.match(row.qual, /current_setting\('app\.school_id'/);
      assert.match(row.with_check, /current_setting\('app\.school_id'/);
    }

    const expectedConstraints = [
      "cp_schedule_change_pairs_first_group_school_fk",
      "cp_schedule_change_pairs_second_group_school_fk",
      "groups_school_id_id_fk_key",
      "cp_schedule_change_pairs_school_id_fk_key",
      "cp_schedule_changes_school_id_date_fk_key",
      "cp_schedule_changes_pair_school_fk",
      "cp_schedule_change_legs_change_school_fk",
      "cp_schedule_change_legs_group_school_fk",
      "cp_schedule_change_pairs_group_order_check",
      "cp_schedule_changes_reservation_check",
      "cp_schedule_change_legs_window_check",
    ];
    const constraints = await admin.query(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE conname = ANY($1::text[]) ORDER BY conname`,
      [expectedConstraints]
    );
    assert.deepEqual(
      constraints.rows.map((row) => row.conname).sort(),
      [...expectedConstraints].sort()
    );
    assert.ok(constraints.rows.every((row) => row.convalidated === true));

    const expectedIndexes = [
      "cp_schedule_change_pairs_school_groups_unique",
      "cp_schedule_changes_school_id_date_unique",
      "cp_schedule_change_legs_change_order_unique",
      "cp_schedule_change_legs_change_group_unique",
      "cp_schedule_change_legs_active_group_date_unique",
    ];
    const indexes = await admin.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [expectedIndexes]
    );
    assert.deepEqual(indexes.rows.map((row) => row.indexname).sort(), [...expectedIndexes].sort());

    const triggers = await admin.query(
      `SELECT tgname FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = ANY($1::text[])`,
      [[
        "cp_schedule_change_legs_immutable_snapshot",
        "cp_schedule_changes_exactly_two_legs",
        "cp_schedule_change_legs_exactly_two",
      ]]
    );
    assert.equal(triggers.rows.length, 3);
  });

  it("isolates reads and permits only same-tenant writes for all three tables", async () => {
    await setTenant(app, ids.schoolA);
    const expectedA = new Map([
      [TABLES[0], 1],
      [TABLES[1], 2],
      [TABLES[2], 4],
    ]);
    for (const table of TABLES) {
      const result = await app.query(`SELECT school_id FROM ${table}`);
      assert.equal(result.rowCount, expectedA.get(table), table);
      assert.ok(result.rows.every((row) => row.school_id === ids.schoolA), table);
    }

    await app.query("BEGIN");
    try {
      const pairId = `${TAG}_allowed_pair`;
      const changeId = `${TAG}_allowed_change`;
      await app.query(
        `INSERT INTO classpilot_schedule_change_pairs
           (id, school_id, first_group_id, second_group_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [pairId, ids.schoolA, groupId("a", 3), groupId("a", 4), ids.userA]
      );
      await app.query(
        `INSERT INTO classpilot_schedule_changes
           (id, school_id, pair_id, scheduled_date, timezone_snapshot, status,
            reason, requested_by_user_id, requested_by_role,
            requires_admin_approval, reservation_active)
         VALUES ($1, $2, $3, '2099-02-02', 'America/New_York',
                 'pending_counterpart', 'Allowed write', $4, 'teacher', true, true)`,
        [changeId, ids.schoolA, pairId, ids.userA]
      );
      await app.query(
        `INSERT INTO classpilot_schedule_change_legs
           (id, school_id, schedule_change_id, scheduled_date, leg_order, group_id,
            primary_teacher_id_snapshot, class_name_snapshot,
            original_start_time, original_end_time, effective_start_time,
            effective_end_time)
         VALUES
           ($1, $2, $3, '2099-02-02', 1, $4, $5, 'Class 3', '09:00', '10:00', '10:00', '11:00'),
           ($6, $2, $3, '2099-02-02', 2, $7, $5, 'Class 4', '10:00', '11:00', '09:00', '10:00')`,
        [
          `${changeId}_leg_1`, ids.schoolA, changeId, groupId("a", 3), ids.userA,
          `${changeId}_leg_2`, groupId("a", 4),
        ]
      );
    } finally {
      await app.query("ROLLBACK");
    }

    const denied = [
      () => app.query(
        `INSERT INTO classpilot_schedule_change_pairs
           (id, school_id, first_group_id, second_group_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [`${TAG}_denied_pair`, ids.schoolB, groupId("b", 3), groupId("b", 4), ids.userB]
      ),
      () => app.query(
        `INSERT INTO classpilot_schedule_changes
           (id, school_id, pair_id, scheduled_date, timezone_snapshot, status,
            reason, requested_by_user_id, requested_by_role,
            requires_admin_approval, reservation_active)
         VALUES ($1, $2, $3, '2099-02-03', 'America/New_York',
                 'cancelled', 'Denied write', $4, 'teacher', true, false)`,
        [`${TAG}_denied_change`, ids.schoolB, ids.pairB, ids.userB]
      ),
      () => app.query(
        `INSERT INTO classpilot_schedule_change_legs
           (id, school_id, schedule_change_id, scheduled_date, leg_order, group_id,
            primary_teacher_id_snapshot, class_name_snapshot,
            original_start_time, original_end_time, effective_start_time,
            effective_end_time, reservation_active)
         VALUES ($1, $2, $3, '2099-01-13', 1, $4, $5,
                 'Denied', '09:00', '10:00', '10:00', '11:00', false)`,
        [`${TAG}_denied_leg`, ids.schoolB, ids.terminalB, groupId("b", 1), ids.userB]
      ),
    ];
    for (const attempt of denied) {
      await assert.rejects(attempt(), /row-level security|policy/i);
    }

    await setTenant(app, "");
    for (const table of TABLES) {
      assert.equal((await app.query(`SELECT 1 FROM ${table}`)).rowCount, 0, table);
    }
    await assert.rejects(
      app.query(
        `INSERT INTO classpilot_schedule_change_pairs
           (id, school_id, first_group_id, second_group_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [`${TAG}_no_guc`, ids.schoolA, groupId("a", 3), groupId("a", 4), ids.userA]
      ),
      /row-level security|policy/i
    );
  });

  it("rejects incomplete changes and every immutable or false-to-true leg update", async () => {
    await setTenant(app, ids.schoolA);
    await app.query("BEGIN");
    try {
      await app.query(
        `INSERT INTO classpilot_schedule_changes
           (id, school_id, pair_id, scheduled_date, timezone_snapshot, status,
            reason, requested_by_user_id, requested_by_role,
            requires_admin_approval, reservation_active)
         VALUES ($1, $2, $3, '2099-03-01', 'America/New_York',
                 'cancelled', 'Incomplete', $4, 'admin', true, false)`,
        [`${TAG}_incomplete`, ids.schoolA, ids.pairA, ids.userA]
      );
      await assert.rejects(app.query("COMMIT"), /exactly two legs/i);
    } finally {
      await app.query("ROLLBACK").catch(() => undefined);
    }

    await assert.rejects(
      app.query(
        `UPDATE classpilot_schedule_change_legs
         SET original_start_time = '08:30'
         WHERE id = $1`,
        [`${ids.terminalA}_leg_1`]
      ),
      /immutable/i
    );
    await assert.rejects(
      app.query(
        `UPDATE classpilot_schedule_change_legs
         SET reservation_active = true
         WHERE id = $1`,
        [`${ids.terminalA}_leg_1`]
      ),
      /immutable/i
    );
  });
});
