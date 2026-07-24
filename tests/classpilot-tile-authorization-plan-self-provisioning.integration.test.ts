import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
const applicationDatabaseUrl = process.env.DATABASE_URL;
const rlsTestRole = process.env.RLS_TEST_ROLE;
const integrationEnabled = Boolean(
  adminDatabaseUrl && applicationDatabaseUrl && rlsTestRole
);

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type QueryClient = {
  query<T extends pg.QueryResultRow = any>(
    text: string,
    values?: readonly unknown[]
  ): Promise<pg.QueryResult<T>>;
};

const fixtureId = `gate-${randomUUID().slice(0, 8)}`;
const schoolId = randomUUID();
const primaryTeacherId = randomUUID();
const coTeacherId = randomUUID();
const officeStaffId = randomUUID();
const classGroupId = randomUUID();
const otherGroupId = randomUUID();
const expiredTeachingSessionId = randomUUID();
const rosterStudentIds = Array.from({ length: 40 }, () => randomUUID());
const officeStudentIds = Array.from({ length: 40 }, () => randomUUID());
const allStudentIds = [...rosterStudentIds, ...officeStudentIds];
const allDeviceIds = allStudentIds.map(
  (_studentId, index) => `${fixtureId}-device-${String(index + 1).padStart(2, "0")}`
);
const allStudentNumbers = allStudentIds.map(
  (_studentId, index) => `${fixtureId}-P-${String(index + 1).padStart(3, "0")}`
);

let adminClient: pg.Client | undefined;
let productionDbModule: typeof import("../dist/db.js") | undefined;
let planCheckModule:
  | typeof import("../dist/services/classpilotTileAuthorizationPlanCheck.js")
  | undefined;
let storageModule: typeof import("../dist/services/storage.js") | undefined;
let originalTrackIoTiming = "off";
let originalComputeQueryId = "auto";

async function setLocalSuper(client: pg.Client): Promise<void> {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY");
  await client.query("SELECT set_config('app.is_super', 'on', true)");
}

async function readTransientRowCount(client: pg.Client): Promise<number> {
  await setLocalSuper(client);
  try {
    const result = await client.query<{ transient_count: string }>(
      `
        SELECT (
          (SELECT count(*) FROM group_teachers WHERE group_id = $1)
          + (
            SELECT count(*)
            FROM teaching_sessions
            WHERE group_id = $1
              AND session_mode = 'live'
              AND end_time IS NULL
          )
          + (
            SELECT count(*)
            FROM classpilot_supervision_contexts
            WHERE school_id = $2
              AND name = 'synthetic authorization plan gate'
              AND status = 'active'
          )
          + (
            SELECT count(*)
            FROM classpilot_supervision_students
            WHERE school_id = $2
              AND source = 'authorization_plan_gate'
              AND released_at IS NULL
          )
        )::text AS transient_count
      `,
      [classGroupId, schoolId]
    );
    return Number(result.rows[0]?.transient_count);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function readExpiredSessionPosture(client: pg.Client): Promise<{
  expired_count: string;
  open_count: string;
}> {
  await setLocalSuper(client);
  try {
    const result = await client.query<{
      expired_count: string;
      open_count: string;
    }>(
      `
        SELECT
          count(*) FILTER (WHERE id = $1 AND end_time IS NOT NULL)::text
            AS expired_count,
          count(*) FILTER (
            WHERE group_id = $2
              AND session_mode = 'live'
              AND end_time IS NULL
          )::text AS open_count
        FROM teaching_sessions
      `,
      [expiredTeachingSessionId, classGroupId]
    );
    assert.ok(result.rows[0]);
    return result.rows[0];
  } finally {
    await client.query("ROLLBACK");
  }
}

async function waitForDatabaseSetting(
  client: pg.Client,
  setting: "track_io_timing" | "compute_query_id",
  expected: string
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ setting_value: string }>(
      `SELECT current_setting('${setting}') AS setting_value`
    );
    if (result.rows[0]?.setting_value === expected) return;
    await delay(50);
  }
  assert.fail(`${setting} did not become ${expected}`);
}

async function seedOwnedFixture(client: pg.Client): Promise<void> {
  const schoolName =
    `[SYNTHETIC LOAD TEST - NON-BILLABLE] ${fixtureId} plan gate integration`;
  await client.query(
    `
      INSERT INTO schools (
        id, name, domain, slug, status, is_active, plan_status,
        stripe_customer_id, stripe_subscription_id, total_paid
      )
      VALUES ($1, $2, $3, $4, 'active', true, 'active', NULL, NULL, 0)
    `,
    [
      schoolId,
      schoolName,
      `${fixtureId}.example.invalid`,
      `${fixtureId}-school`,
    ]
  );
  await client.query(
    `
      INSERT INTO users (id, email, first_name, last_name)
      VALUES
        ($1, $4, 'Synthetic', 'Primary Teacher'),
        ($2, $5, 'Synthetic', 'Co Teacher'),
        ($3, $6, 'Synthetic', 'Office Staff')
    `,
    [
      primaryTeacherId,
      coTeacherId,
      officeStaffId,
      `${fixtureId}-primary@example.invalid`,
      `${fixtureId}-co@example.invalid`,
      `${fixtureId}-office@example.invalid`,
    ]
  );
  await client.query(
    `
      INSERT INTO school_memberships (
        id, user_id, school_id, role, status
      )
      VALUES
        ($1, $4, $7, 'teacher', 'active'),
        ($2, $5, $7, 'teacher', 'active'),
        ($3, $6, $7, 'office_staff', 'active')
    `,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      primaryTeacherId,
      coTeacherId,
      officeStaffId,
      schoolId,
    ]
  );
  await client.query(
    `
      INSERT INTO product_licenses (
        id, school_id, product, status
      )
      VALUES ($1, $2, 'CLASSPILOT', 'active')
    `,
    [randomUUID(), schoolId]
  );
  await client.query(
    `
      INSERT INTO groups (
        id, school_id, teacher_id, name, description, group_type,
        status, schedule_enabled
      )
      VALUES
        (
          $1, $3, $4, 'Synthetic plan class 01',
          $6, 'admin_class', 'active', false
        ),
        (
          $2, $3, $5, 'Synthetic plan class 02',
          $7, 'admin_class', 'active', false
        )
    `,
    [
      classGroupId,
      otherGroupId,
      schoolId,
      primaryTeacherId,
      coTeacherId,
      `synthetic-load-fixture:${fixtureId}:class:01`,
      `synthetic-load-fixture:${fixtureId}:class:02`,
    ]
  );
  await client.query(
    `
      INSERT INTO students (
        id, school_id, first_name, last_name, student_id_number, status
      )
      SELECT
        fixture.id,
        $3,
        'Synthetic',
        'Plan Student ' || fixture.ordinality::text,
        fixture.student_number,
        'active'
      FROM unnest($1::text[], $2::text[])
        WITH ORDINALITY AS fixture(id, student_number, ordinality)
    `,
    [allStudentIds, allStudentNumbers, schoolId]
  );
  await client.query(
    `
      INSERT INTO group_students (id, group_id, student_id)
      SELECT
        gen_random_uuid()::text,
        $2,
        fixture.student_id
      FROM unnest($1::text[]) AS fixture(student_id)
    `,
    [rosterStudentIds, classGroupId]
  );
  await client.query(
    `
      INSERT INTO devices (
        device_id, device_name, school_id, class_id
      )
      SELECT
        fixture.device_id,
        'Synthetic plan device ' || fixture.ordinality::text,
        $2,
        $3
      FROM unnest($1::text[])
        WITH ORDINALITY AS fixture(device_id, ordinality)
    `,
    [allDeviceIds, schoolId, classGroupId]
  );
  await client.query(
    `
      INSERT INTO student_devices (
        id, student_id, device_id, first_seen_at, last_seen_at
      )
      SELECT
        gen_random_uuid()::text,
        fixture.student_id,
        fixture.device_id,
        now() - interval '1 hour',
        now()
      FROM unnest($1::text[], $2::text[])
        AS fixture(student_id, device_id)
    `,
    [allStudentIds, allDeviceIds]
  );
  await client.query(
    `
      INSERT INTO student_sessions (
        id, student_id, device_id, started_at, last_seen_at, is_active
      )
      SELECT
        gen_random_uuid()::text,
        fixture.student_id,
        fixture.device_id,
        now() - interval '1 hour',
        now(),
        true
      FROM unnest($1::text[], $2::text[])
        AS fixture(student_id, device_id)
    `,
    [allStudentIds, allDeviceIds]
  );
  await client.query(
    `
      INSERT INTO teaching_sessions (
        id, group_id, teacher_id, school_id, start_time,
        session_mode, end_time, created_at
      )
      VALUES (
        $1, $2, $3, $4, now() - interval '13 hours',
        'live', now() - interval '1 hour', now() - interval '13 hours'
      )
    `,
    [expiredTeachingSessionId, classGroupId, primaryTeacherId, schoolId]
  );

  const heartbeatIds: string[] = [];
  const heartbeatDeviceIds: string[] = [];
  const heartbeatStudentIds: string[] = [];
  const heartbeatOffsets: number[] = [];
  for (let studentIndex = 0; studentIndex < rosterStudentIds.length; studentIndex += 1) {
    for (let historyIndex = 0; historyIndex < 10; historyIndex += 1) {
      heartbeatIds.push(randomUUID());
      heartbeatDeviceIds.push(allDeviceIds[studentIndex]!);
      heartbeatStudentIds.push(rosterStudentIds[studentIndex]!);
      heartbeatOffsets.push(studentIndex * 10 + historyIndex);
    }
  }
  await client.query(
    `
      INSERT INTO heartbeats (
        id, device_id, student_id, school_id, active_tab_title, timestamp
      )
      SELECT
        fixture.id,
        fixture.device_id,
        fixture.student_id,
        $5,
        'Synthetic plan heartbeat',
        now() - (fixture.offset_seconds * interval '1 second')
      FROM unnest($1::text[], $2::text[], $3::text[], $4::integer[])
        AS fixture(id, device_id, student_id, offset_seconds)
    `,
    [
      heartbeatIds,
      heartbeatDeviceIds,
      heartbeatStudentIds,
      heartbeatOffsets,
      schoolId,
    ]
  );

  for (const table of [
    "groups",
    "group_students",
    "students",
    "devices",
    "student_devices",
    "student_sessions",
    "teaching_sessions",
    "heartbeats",
    "school_memberships",
    "product_licenses",
  ]) {
    await client.query(`ANALYZE ${table}`);
  }
}

async function cleanupOwnedFixture(client: pg.Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "DELETE FROM classpilot_supervision_students WHERE school_id = $1",
      [schoolId]
    );
    await client.query(
      "DELETE FROM classpilot_supervision_contexts WHERE school_id = $1",
      [schoolId]
    );
    await client.query("DELETE FROM heartbeats WHERE school_id = $1", [schoolId]);
    await client.query("DELETE FROM teaching_sessions WHERE school_id = $1", [
      schoolId,
    ]);
    await client.query(
      `
        DELETE FROM group_teachers
        WHERE group_id IN ($1, $2)
      `,
      [classGroupId, otherGroupId]
    );
    await client.query(
      `
        DELETE FROM group_students
        WHERE group_id IN ($1, $2)
      `,
      [classGroupId, otherGroupId]
    );
    await client.query("DELETE FROM groups WHERE school_id = $1", [schoolId]);
    await client.query(
      "DELETE FROM student_sessions WHERE student_id = ANY($1::text[])",
      [allStudentIds]
    );
    await client.query(
      "DELETE FROM student_devices WHERE student_id = ANY($1::text[])",
      [allStudentIds]
    );
    await client.query("DELETE FROM devices WHERE school_id = $1", [schoolId]);
    await client.query("DELETE FROM students WHERE school_id = $1", [schoolId]);
    await client.query("DELETE FROM product_licenses WHERE school_id = $1", [
      schoolId,
    ]);
    await client.query("DELETE FROM school_memberships WHERE school_id = $1", [
      schoolId,
    ]);
    await client.query("DELETE FROM schools WHERE id = $1", [schoolId]);
    await client.query(
      "DELETE FROM users WHERE id = ANY($1::text[])",
      [[primaryTeacherId, coTeacherId, officeStaffId]]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describe(
  "ClassPilot transactional plan scenarios against PostgreSQL/FORCE RLS",
  { skip: !integrationEnabled },
  () => {
    before(async () => {
      assert.ok(adminDatabaseUrl);
      assert.ok(applicationDatabaseUrl);
      assert.ok(rlsTestRole);

      adminClient = new pg.Client({ connectionString: adminDatabaseUrl });
      await adminClient.connect();
      originalTrackIoTiming = (
        await adminClient.query<{ track_io_timing: string }>(
          "SHOW track_io_timing"
        )
      ).rows[0]?.track_io_timing ?? "off";
      originalComputeQueryId = (
        await adminClient.query<{ compute_query_id: string }>(
          "SHOW compute_query_id"
        )
      ).rows[0]?.compute_query_id ?? "auto";
      await adminClient.query("ALTER SYSTEM SET track_io_timing = 'on'");
      await adminClient.query("ALTER SYSTEM SET compute_query_id = 'on'");
      await adminClient.query("SELECT pg_reload_conf()");
      await waitForDatabaseSetting(adminClient, "track_io_timing", "on");
      await waitForDatabaseSetting(adminClient, "compute_query_id", "on");
      await seedOwnedFixture(adminClient);

      productionDbModule = await import("../dist/db.js");
      planCheckModule = await import(
        "../dist/services/classpilotTileAuthorizationPlanCheck.js"
      );
      storageModule = await import("../dist/services/storage.js");
    });

    after(async () => {
      if (productionDbModule) {
        await Promise.allSettled([
          productionDbModule.pool.end(),
          productionDbModule.sessionPool.end(),
        ]);
      }
      if (adminClient) {
        try {
          await cleanupOwnedFixture(adminClient);
        } finally {
          await adminClient.query(
            `ALTER SYSTEM SET track_io_timing = '${originalTrackIoTiming === "on" ? "on" : "off"}'`
          );
          assert.match(originalComputeQueryId, /^(?:auto|on|off|regress)$/);
          await adminClient.query(
            `ALTER SYSTEM SET compute_query_id = '${originalComputeQueryId}'`
          );
          await adminClient.query("SELECT pg_reload_conf()");
          await adminClient.end();
        }
      }
    });

    it(
      "uses expired-session fixture state, hides all 43 rows, rolls back, and serializes two real gates",
      { timeout: 120_000 },
      async () => {
        assert.ok(applicationDatabaseUrl);
        assert.ok(rlsTestRole);
        assert.ok(planCheckModule);
        assert.ok(storageModule);

        const firstClient = new pg.Client({
          connectionString: applicationDatabaseUrl,
          statement_timeout: 15_000,
        });
        const secondClient = new pg.Client({
          connectionString: applicationDatabaseUrl,
          statement_timeout: 15_000,
        });
        const observerClient = new pg.Client({
          connectionString: applicationDatabaseUrl,
          statement_timeout: 15_000,
        });
        await Promise.all([
          firstClient.connect(),
          secondClient.connect(),
          observerClient.connect(),
        ]);

        try {
          const roleEvidence = await observerClient.query<{
            current_user: string;
            rolsuper: boolean;
          }>(
            `
              SELECT current_user, role.rolsuper
              FROM pg_roles AS role
              WHERE role.rolname = current_user
            `
          );
          assert.deepEqual(roleEvidence.rows, [
            { current_user: rlsTestRole, rolsuper: false },
          ]);
          const rlsEvidence = await observerClient.query<{
            relname: string;
            relrowsecurity: boolean;
            relforcerowsecurity: boolean;
          }>(
            `
              SELECT class.relname, class.relrowsecurity, class.relforcerowsecurity
              FROM pg_class AS class
              WHERE class.relname = ANY($1::text[])
              ORDER BY class.relname
            `,
            [[
              "classpilot_supervision_contexts",
              "classpilot_supervision_students",
              "teaching_sessions",
            ]]
          );
          assert.equal(rlsEvidence.rows.length, 3);
          assert.ok(
            rlsEvidence.rows.every(
              (row) => row.relrowsecurity && row.relforcerowsecurity
            )
          );

          assert.equal(await readTransientRowCount(observerClient), 0);
          assert.deepEqual(await readExpiredSessionPosture(observerClient), {
            expired_count: "1",
            open_count: "0",
          });

          const firstSeeded = deferred();
          const releaseFirst = deferred();
          const secondLockRequested = deferred();
          let firstWriteRolledBack = false;
          let secondLockAcquired = false;
          let secondAcquiredAfterFirstRollback = false;
          let firstSeedPauseUsed = false;
          const firstLifecycle: unknown[] = [];
          const secondLifecycle: unknown[] = [];

          const firstWrappedClient: QueryClient = {
            async query(text, values) {
              const result = await firstClient.query(text, values as any[]);
              if (
                !firstSeedPauseUsed &&
                text.includes(
                  "/* transactional_plan_seed_supervision_students_v1 */"
                )
              ) {
                firstSeedPauseUsed = true;
                firstSeeded.resolve();
                await releaseFirst.promise;
              }
              if (text === "ROLLBACK" && !firstWriteRolledBack) {
                firstWriteRolledBack = true;
              }
              return result;
            },
          };
          const secondWrappedClient: QueryClient = {
            async query(text, values) {
              if (
                text ===
                "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))"
              ) {
                secondLockRequested.resolve();
                const result = await secondClient.query(text, values as any[]);
                secondLockAcquired = true;
                secondAcquiredAfterFirstRollback = firstWriteRolledBack;
                return result;
              }
              return secondClient.query(text, values as any[]);
            },
          };

          const firstRun =
            planCheckModule.runClasspilotTileAuthorizationPlanCheck({
              client: firstWrappedClient,
              buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
              buildHistoryQuery:
                storageModule.buildHeartbeatTileHistoryBatchQuery,
              onLifecycleEvent: (event) => firstLifecycle.push(event),
            });
          await firstSeeded.promise;
          assert.equal(await readTransientRowCount(observerClient), 0);

          const secondRun =
            planCheckModule.runClasspilotTileAuthorizationPlanCheck({
              client: secondWrappedClient,
              buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
              buildHistoryQuery:
                storageModule.buildHeartbeatTileHistoryBatchQuery,
              onLifecycleEvent: (event) => secondLifecycle.push(event),
            });
          await secondLockRequested.promise;
          await delay(100);
          assert.equal(secondLockAcquired, false);
          releaseFirst.resolve();

          const [firstReport, secondReport] = await Promise.all([
            firstRun,
            secondRun,
          ]);
          assert.equal(firstReport.status, "passed");
          assert.equal(secondReport.status, "passed");
          assert.equal(secondLockAcquired, true);
          assert.equal(secondAcquiredAfterFirstRollback, true);
          assert.equal(firstLifecycle.length, 1);
          assert.equal(secondLifecycle.length, 1);
          for (const lifecycle of [...firstLifecycle, ...secondLifecycle]) {
            assert.deepEqual(lifecycle, {
              version: "transactional-plan-scenarios-v1",
              seededRows: {
                groupTeachers: 1,
                teachingSessions: 1,
                supervisionContexts: 1,
                supervisionStudents: 40,
                total: 43,
              },
              rollback: { attempted: true, completed: true },
              residue: { checked: true, count: 0, passed: true },
            });
          }
          assert.equal(await readTransientRowCount(observerClient), 0);
          assert.deepEqual(await readExpiredSessionPosture(observerClient), {
            expired_count: "1",
            open_count: "0",
          });
        } finally {
          await Promise.allSettled([
            firstClient.end(),
            secondClient.end(),
            observerClient.end(),
          ]);
        }
      }
    );
  }
);
