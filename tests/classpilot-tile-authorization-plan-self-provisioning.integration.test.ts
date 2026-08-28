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
const classPrimaryRelationshipId = randomUUID();
const otherPrimaryRelationshipId = randomUUID();
const expiredTeachingSessionId = randomUUID();
const rosterStudentIds = Array.from({ length: 40 }, () => randomUUID());
const officeStudentIds = Array.from({ length: 40 }, () => randomUUID());
const allStudentIds = [...rosterStudentIds, ...officeStudentIds];
const allDeviceIds = allStudentIds.map(
  (_studentId, index) =>
    `${fixtureId}-primary-${String(index + 1).padStart(4, "0")}`
);
const allStudentNumbers = allStudentIds.map(
  (_studentId, index) =>
    `${fixtureId.toUpperCase()}-P-${String(index + 1).padStart(4, "0")}`
);
const ambiguousFixtureId = `gate-${randomUUID().slice(0, 8)}`;
const ambiguousSchoolId = randomUUID();
const ambiguousPrimaryTeacherId = randomUUID();
const ambiguousCoTeacherId = randomUUID();
const ambiguousOfficeStaffId = randomUUID();
const ambiguousClassGroupId = randomUUID();
const ambiguousOtherGroupId = randomUUID();
const ambiguousClassPrimaryRelationshipId = randomUUID();
const ambiguousOtherPrimaryRelationshipId = randomUUID();
const ambiguousStudentIds = Array.from({ length: 80 }, () => randomUUID());
const ambiguousDeviceIds = ambiguousStudentIds.map(
  (_studentId, index) =>
    `${ambiguousFixtureId}-primary-${String(index + 1).padStart(4, "0")}`
);
const ambiguousStudentNumbers = ambiguousStudentIds.map(
  (_studentId, index) =>
    `${ambiguousFixtureId.toUpperCase()}-P-${String(index + 1).padStart(4, "0")}`
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
          (
            SELECT count(*)
            FROM group_teachers
            WHERE group_id = $1
              AND role = 'co-teacher'
          )
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
          + (
            SELECT count(*)
            FROM student_sessions
            WHERE student_id = ANY($3::text[])
              AND is_active = true
          )
        )::text AS transient_count
      `,
      [classGroupId, schoolId, allStudentIds]
    );
    return Number(result.rows[0]?.transient_count);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function readAdvisoryLockStates(
  client: pg.Client,
  backendPids: readonly number[]
): Promise<Array<{ pid: number; granted: boolean }>> {
  const result = await client.query<{ pid: number; granted: boolean }>(
    `
      SELECT pid, granted
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND pid = ANY($1::int[])
      ORDER BY pid, granted DESC
    `,
    [backendPids]
  );
  return result.rows;
}

async function waitForAdvisoryLockSerialization(
  client: pg.Client,
  firstBackendPid: number,
  secondBackendPid: number
): Promise<Array<{ pid: number; granted: boolean }>> {
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  do {
    const states = await readAdvisoryLockStates(client, [
      firstBackendPid,
      secondBackendPid,
    ]);
    if (
      states.some(
        (state) => state.pid === firstBackendPid && state.granted === true
      ) &&
      states.some(
        (state) => state.pid === secondBackendPid && state.granted === false
      )
    ) {
      return states;
    }
    await delay(25);
  } while (process.hrtime.bigint() < deadline);

  throw new Error(
    "Timed out waiting for the second transactional plan gate to block on the advisory lock."
  );
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
  await client.query("BEGIN");
  try {
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
      INSERT INTO group_teachers (
        id, group_id, teacher_id, role, assigned_at
      )
      VALUES
        ($1, $3, $5, 'primary', now()),
        ($2, $4, $6, 'primary', now())
    `,
    [
      classPrimaryRelationshipId,
      otherPrimaryRelationshipId,
      classGroupId,
      otherGroupId,
      primaryTeacherId,
      coTeacherId,
    ]
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
    "group_teachers",
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedAmbiguousOwnedFixture(client: pg.Client): Promise<void> {
  await client.query("BEGIN");
  try {
  await client.query(
    `
      INSERT INTO schools (
        id, name, domain, slug, status, is_active, plan_status,
        stripe_customer_id, stripe_subscription_id, total_paid
      )
      VALUES ($1, $2, $3, $4, 'active', true, 'active', NULL, NULL, 0)
    `,
    [
      ambiguousSchoolId,
      `[SYNTHETIC LOAD TEST - NON-BILLABLE] ${ambiguousFixtureId} ambiguity`,
      `${ambiguousFixtureId}.example.invalid`,
      `${ambiguousFixtureId}-school`,
    ]
  );
  await client.query(
    `
      INSERT INTO users (id, email, first_name, last_name)
      VALUES
        ($1, $4, 'Synthetic', 'Ambiguous Primary'),
        ($2, $5, 'Synthetic', 'Ambiguous Alternate'),
        ($3, $6, 'Synthetic', 'Ambiguous Office')
    `,
    [
      ambiguousPrimaryTeacherId,
      ambiguousCoTeacherId,
      ambiguousOfficeStaffId,
      `${ambiguousFixtureId}-primary@example.invalid`,
      `${ambiguousFixtureId}-alternate@example.invalid`,
      `${ambiguousFixtureId}-office@example.invalid`,
    ]
  );
  await client.query(
    `
      INSERT INTO school_memberships (
        id, user_id, school_id, role, status
      )
      VALUES
        (gen_random_uuid()::text, $1, $4, 'teacher', 'active'),
        (gen_random_uuid()::text, $2, $4, 'teacher', 'active'),
        (gen_random_uuid()::text, $3, $4, 'office_staff', 'active')
    `,
    [
      ambiguousPrimaryTeacherId,
      ambiguousCoTeacherId,
      ambiguousOfficeStaffId,
      ambiguousSchoolId,
    ]
  );
  await client.query(
    `
      INSERT INTO product_licenses (id, school_id, product, status)
      VALUES (gen_random_uuid()::text, $1, 'CLASSPILOT', 'active')
    `,
    [ambiguousSchoolId]
  );
  await client.query(
    `
      INSERT INTO groups (
        id, school_id, teacher_id, name, description, group_type,
        status, schedule_enabled
      )
      VALUES
        (
          $1, $3, $4, 'Synthetic ambiguity class 01',
          $6, 'admin_class', 'active', false
        ),
        (
          $2, $3, $5, 'Synthetic ambiguity class 02',
          $7, 'admin_class', 'active', false
        )
    `,
    [
      ambiguousClassGroupId,
      ambiguousOtherGroupId,
      ambiguousSchoolId,
      ambiguousPrimaryTeacherId,
      ambiguousCoTeacherId,
      `synthetic-load-fixture:${ambiguousFixtureId}:class:01`,
      `synthetic-load-fixture:${ambiguousFixtureId}:class:02`,
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
        'Ambiguity Student ' || fixture.ordinality::text,
        fixture.student_number,
        'active'
      FROM unnest($1::text[], $2::text[])
        WITH ORDINALITY AS fixture(id, student_number, ordinality)
    `,
    [ambiguousStudentIds, ambiguousStudentNumbers, ambiguousSchoolId]
  );
  await client.query(
    `
      INSERT INTO group_teachers (
        id, group_id, teacher_id, role, assigned_at
      )
      VALUES
        ($1, $3, $5, 'primary', now()),
        ($2, $4, $6, 'primary', now())
    `,
    [
      ambiguousClassPrimaryRelationshipId,
      ambiguousOtherPrimaryRelationshipId,
      ambiguousClassGroupId,
      ambiguousOtherGroupId,
      ambiguousPrimaryTeacherId,
      ambiguousCoTeacherId,
    ]
  );
  await client.query(
    `
      INSERT INTO group_students (id, group_id, student_id)
      SELECT gen_random_uuid()::text, $2, fixture.student_id
      FROM unnest($1::text[]) AS fixture(student_id)
    `,
    [ambiguousStudentIds.slice(0, 40), ambiguousClassGroupId]
  );
  await client.query(
    `
      INSERT INTO devices (
        device_id, device_name, school_id, class_id
      )
      SELECT
        fixture.device_id,
        'Synthetic ambiguity device ' || fixture.ordinality::text,
        $2,
        $3
      FROM unnest($1::text[])
        WITH ORDINALITY AS fixture(device_id, ordinality)
    `,
    [ambiguousDeviceIds, ambiguousSchoolId, ambiguousClassGroupId]
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
    [ambiguousStudentIds, ambiguousDeviceIds]
  );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function cleanupAmbiguousOwnedFixture(client: pg.Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "DELETE FROM group_teachers WHERE group_id = ANY($1::text[])",
      [[ambiguousClassGroupId, ambiguousOtherGroupId]]
    );
    await client.query(
      "DELETE FROM group_students WHERE group_id = ANY($1::text[])",
      [[ambiguousClassGroupId, ambiguousOtherGroupId]]
    );
    await client.query("DELETE FROM groups WHERE school_id = $1", [
      ambiguousSchoolId,
    ]);
    await client.query(
      "DELETE FROM student_devices WHERE student_id = ANY($1::text[])",
      [ambiguousStudentIds]
    );
    await client.query("DELETE FROM devices WHERE school_id = $1", [
      ambiguousSchoolId,
    ]);
    await client.query("DELETE FROM students WHERE school_id = $1", [
      ambiguousSchoolId,
    ]);
    await client.query("DELETE FROM product_licenses WHERE school_id = $1", [
      ambiguousSchoolId,
    ]);
    await client.query("DELETE FROM school_memberships WHERE school_id = $1", [
      ambiguousSchoolId,
    ]);
    await client.query(
      "UPDATE schools SET status = 'suspended', is_active = false, deleted_at = now() WHERE id = $1",
      [ambiguousSchoolId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
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
    await client.query(
      "UPDATE schools SET status = 'suspended', is_active = false, deleted_at = now() WHERE id = $1",
      [schoolId]
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
          await cleanupAmbiguousOwnedFixture(adminClient);
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
      "reports real snapshot-consistent counts at every mutable eligibility boundary",
      { timeout: 120_000 },
      async () => {
        assert.ok(adminClient);
        assert.ok(applicationDatabaseUrl);
        assert.ok(planCheckModule);

        const applicationClient = new pg.Client({
          connectionString: applicationDatabaseUrl,
          statement_timeout: 15_000,
        });
        await applicationClient.connect();

        async function expectFailure(
          firstEmptyStage: string,
          expectedCounts: Readonly<Record<string, number>>
        ): Promise<void> {
          assert.ok(planCheckModule);
          await assert.rejects(
            planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
              client: applicationClient,
            }),
            (error) => {
              if (
                !(error instanceof
                  planCheckModule!.ClasspilotTileAuthorizationPlanCheckError) ||
                error.failureCode !== "representative_scenario_missing" ||
                error.labels.length !== 0 ||
                error.funnelEvidence?.failureStage !== "base_funnel" ||
                error.funnelEvidence.firstEmptyStage !== firstEmptyStage
              ) {
                return false;
              }
              for (const [key, value] of Object.entries(expectedCounts)) {
                assert.equal(
                  (
                    error.funnelEvidence.counts as unknown as Record<
                      string,
                      number
                    >
                  )[key],
                  value,
                  key
                );
              }
              return true;
            }
          );
        }

        async function runMutationCase(
          firstEmptyStage: string,
          expectedCounts: Readonly<Record<string, number>>,
          mutate: () => Promise<unknown>,
          restore: () => Promise<unknown>
        ): Promise<void> {
          try {
            await mutate();
            await expectFailure(firstEmptyStage, expectedCounts);
          } finally {
            await restore();
          }
          const restored =
            await planCheckModule!.runClasspilotTileAuthorizationPlanBasePreflight({
              client: applicationClient,
            });
          assert.equal(restored.status, "passed");
        }

        async function expectGuardedMutation(
          code: string,
          mutate: () => Promise<unknown>
        ): Promise<void> {
          await assert.rejects(
            mutate,
            (error) =>
              error instanceof Error &&
              (
                error.message.includes(code) ||
                (
                  error.cause instanceof Error &&
                  error.cause.message.includes(code)
                )
              )
          );
          const unchanged =
            await planCheckModule!.runClasspilotTileAuthorizationPlanBasePreflight({
              client: applicationClient,
            });
          assert.equal(unchanged.status, "passed");
        }

        const schoolName =
          `[SYNTHETIC LOAD TEST - NON-BILLABLE] ${fixtureId} plan gate integration`;
        const classDescription =
          `synthetic-load-fixture:${fixtureId}:class:01`;
        const otherDescription =
          `synthetic-load-fixture:${fixtureId}:class:02`;
        const rosterSupervisionContextId = randomUUID();
        const rosterSupervisionStudentIds = rosterStudentIds.map(() =>
          randomUUID()
        );
        const officeSupervisionContextId = randomUUID();
        const officeSupervisionStudentIds = officeStudentIds.map(() =>
          randomUUID()
        );
        const existingCoTeacherId = randomUUID();
        const secondOfficeStaffId = randomUUID();

        try {
          await runMutationCase(
            "syntheticDescribedGroups",
            { syntheticDescribedGroups: 0 },
            () =>
              adminClient!.query(
                "UPDATE groups SET description = 'ordinary class' WHERE id = ANY($1::text[])",
                [[classGroupId, otherGroupId]]
              ),
            async () => {
              await adminClient!.query(
                "UPDATE groups SET description = $2 WHERE id = $1",
                [classGroupId, classDescription]
              );
              await adminClient!.query(
                "UPDATE groups SET description = $2 WHERE id = $1",
                [otherGroupId, otherDescription]
              );
            }
          );

          await runMutationCase(
            "syntheticSchoolGroups",
            {
              syntheticDescribedGroups: 2,
              syntheticSchoolGroups: 0,
            },
            () =>
              adminClient!.query(
                "UPDATE schools SET name = 'Synthetic fixture without ownership marker' WHERE id = $1",
                [schoolId]
              ),
            () =>
              adminClient!.query("UPDATE schools SET name = $2 WHERE id = $1", [
                schoolId,
                schoolName,
              ])
          );

          await expectGuardedMutation(
            "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
            () =>
              adminClient!.query(
                "UPDATE school_memberships SET status = 'inactive' WHERE school_id = $1 AND role = 'teacher'",
                [schoolId]
              )
          );

          await runMutationCase(
            "licensedGroups",
            { primaryTeacherGroups: 2, licensedGroups: 0 },
            () =>
              adminClient!.query(
                "UPDATE product_licenses SET status = 'inactive' WHERE school_id = $1 AND product = 'CLASSPILOT'",
                [schoolId]
              ),
            () =>
              adminClient!.query(
                "UPDATE product_licenses SET status = 'active' WHERE school_id = $1 AND product = 'CLASSPILOT'",
                [schoolId]
              )
          );

          await runMutationCase(
            "activeRosterStudents",
            { licensedGroups: 2, activeRosterStudents: 0 },
            () =>
              adminClient!.query(
                "UPDATE students SET status = 'inactive' WHERE id = ANY($1::text[])",
                [rosterStudentIds]
              ),
            () =>
              adminClient!.query(
                "UPDATE students SET status = 'active' WHERE id = ANY($1::text[])",
                [rosterStudentIds]
              )
          );

          await runMutationCase(
            "canonicalMappedRosterStudents",
            {
              activeRosterStudents: 40,
              canonicalMappedRosterStudents: 0,
            },
            () =>
              adminClient!.query(
                "DELETE FROM student_devices WHERE student_id = ANY($1::text[])",
                [rosterStudentIds]
              ),
            () =>
              adminClient!.query(
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
                  ON CONFLICT DO NOTHING
                `,
                [rosterStudentIds, allDeviceIds.slice(0, 40)]
              )
          );

          await runMutationCase(
            "unsupervisedRosterStudents",
            {
              canonicalMappedRosterStudents: 40,
              unsupervisedRosterStudents: 0,
            },
            async () => {
              await adminClient!.query(
                `
                  INSERT INTO classpilot_supervision_contexts (
                    id, school_id, context_type, name, status,
                    assigned_staff_id, created_by, starts_at, ends_at,
                    created_at, updated_at
                  )
                  VALUES (
                    $1, $2, 'office', 'integration roster supervision',
                    'active', $3, $3, now() - interval '1 minute',
                    now() + interval '1 hour', now(), now()
                  )
                `,
                [rosterSupervisionContextId, schoolId, officeStaffId]
              );
              await adminClient!.query(
                `
                  INSERT INTO classpilot_supervision_students (
                    id, school_id, context_id, student_id, source,
                    assigned_by, assigned_at
                  )
                  SELECT
                    fixture.id, $3, $4, fixture.student_id,
                    'authorization_plan_gate', $5, now()
                  FROM unnest($1::text[], $2::text[])
                    AS fixture(id, student_id)
                `,
                [
                  rosterSupervisionStudentIds,
                  rosterStudentIds,
                  schoolId,
                  rosterSupervisionContextId,
                  officeStaffId,
                ]
              );
            },
            async () => {
              await adminClient!.query(
                "DELETE FROM classpilot_supervision_students WHERE context_id = $1",
                [rosterSupervisionContextId]
              );
              await adminClient!.query(
                "DELETE FROM classpilot_supervision_contexts WHERE id = $1",
                [rosterSupervisionContextId]
              );
            }
          );

          await expectGuardedMutation(
            "STAFF_CLASS_PRIMARY_MIRROR_MISMATCH",
            () =>
              adminClient!.query(
                "DELETE FROM group_teachers WHERE id = $1",
                [classPrimaryRelationshipId]
              )
          );

          await expectGuardedMutation(
            "STAFF_CLASS_PRIMARY_MIRROR_MISMATCH",
            () =>
              adminClient!.query(
                "UPDATE group_teachers SET teacher_id = $1 WHERE id = $2",
                [coTeacherId, classPrimaryRelationshipId]
              )
          );

          await expectGuardedMutation(
            "STAFF_CLASS_PRIMARY_MIRROR_MISMATCH",
            () =>
              adminClient!.query(
                "UPDATE group_teachers SET role = 'co-teacher' WHERE id = $1",
                [classPrimaryRelationshipId]
              )
          );

          await expectGuardedMutation(
            "STAFF_CLASS_PRIMARY_MIRROR_MISMATCH",
            () =>
              adminClient!.query(
                `
                  INSERT INTO group_teachers (
                    id, group_id, teacher_id, role, assigned_at
                  )
                  VALUES ($1, $2, $3, 'primary', now())
                `,
                [existingCoTeacherId, classGroupId, coTeacherId]
              )
          );

          await runMutationCase(
            "noCoTeacherGroups",
            { unsupervisedRosterStudents: 40, noCoTeacherGroups: 0 },
            () =>
              adminClient!.query(
                `
                  INSERT INTO group_teachers (
                    id, group_id, teacher_id, role, assigned_at
                  )
                  VALUES ($1, $2, $3, 'co-teacher', now())
                `,
                [existingCoTeacherId, classGroupId, coTeacherId]
              ),
            () =>
              adminClient!.query("DELETE FROM group_teachers WHERE id = $1", [
                existingCoTeacherId,
              ])
          );

          await runMutationCase(
            "exactCohortGroups",
            { noCoTeacherGroups: 1, exactCohortGroups: 0 },
            () =>
              adminClient!.query(
                "DELETE FROM group_students WHERE group_id = $1 AND student_id = $2",
                [classGroupId, rosterStudentIds[0]]
              ),
            () =>
              adminClient!.query(
                "INSERT INTO group_students (id, group_id, student_id) VALUES (gen_random_uuid()::text, $1, $2) ON CONFLICT DO NOTHING",
                [classGroupId, rosterStudentIds[0]]
              )
          );

          await runMutationCase(
            "activeOfficeMemberships",
            { eligibleGroupSchools: 1, activeOfficeMemberships: 0 },
            () =>
              adminClient!.query(
                "UPDATE school_memberships SET status = 'inactive' WHERE school_id = $1 AND role = 'office_staff'",
                [schoolId]
              ),
            () =>
              adminClient!.query(
                "UPDATE school_memberships SET status = 'active' WHERE school_id = $1 AND role = 'office_staff'",
                [schoolId]
              )
          );

          await runMutationCase(
            "uniqueOfficeMembershipSchools",
            {
              activeOfficeMemberships: 2,
              uniqueOfficeMembershipSchools: 0,
            },
            async () => {
              await adminClient!.query(
                `
                  INSERT INTO users (id, email, first_name, last_name)
                  VALUES ($1, $2, 'Synthetic', 'Second Office')
                `,
                [
                  secondOfficeStaffId,
                  `${fixtureId}-second-office@example.invalid`,
                ]
              );
              await adminClient!.query(
                `
                  INSERT INTO school_memberships (
                    id, user_id, school_id, role, status
                  )
                  VALUES (gen_random_uuid()::text, $1, $2, 'office_staff', 'active')
                `,
                [secondOfficeStaffId, schoolId]
              );
            },
            async () => {
              await adminClient!.query(
                "DELETE FROM school_memberships WHERE school_id = $1 AND user_id = $2",
                [schoolId, secondOfficeStaffId]
              );
            }
          );

          await runMutationCase(
            "unrosteredOfficeStudents",
            {
              canonicalMappedOfficeStudents: 80,
              unrosteredOfficeStudents: 0,
            },
            () =>
              adminClient!.query(
                `
                  INSERT INTO group_students (id, group_id, student_id)
                  SELECT gen_random_uuid()::text, $2, fixture.student_id
                  FROM unnest($1::text[]) AS fixture(student_id)
                `,
                [officeStudentIds, otherGroupId]
              ),
            () =>
              adminClient!.query(
                "DELETE FROM group_students WHERE group_id = $1",
                [otherGroupId]
              )
          );

          await runMutationCase(
            "unsupervisedOfficeStudents",
            {
              unrosteredOfficeStudents: 40,
              unsupervisedOfficeStudents: 0,
            },
            async () => {
              await adminClient!.query(
                `
                  INSERT INTO classpilot_supervision_contexts (
                    id, school_id, context_type, name, status,
                    assigned_staff_id, created_by, starts_at, ends_at,
                    created_at, updated_at
                  )
                  VALUES (
                    $1, $2, 'office', 'integration inactive office supervision',
                    'inactive', $3, $3, now() - interval '1 minute',
                    now() + interval '1 hour', now(), now()
                  )
                `,
                [officeSupervisionContextId, schoolId, officeStaffId]
              );
              await adminClient!.query(
                `
                  INSERT INTO classpilot_supervision_students (
                    id, school_id, context_id, student_id, source,
                    assigned_by, assigned_at
                  )
                  SELECT
                    fixture.id, $3, $4, fixture.student_id,
                    'authorization_plan_gate', $5, now()
                  FROM unnest($1::text[], $2::text[])
                    AS fixture(id, student_id)
                `,
                [
                  officeSupervisionStudentIds,
                  officeStudentIds,
                  schoolId,
                  officeSupervisionContextId,
                  officeStaffId,
                ]
              );
            },
            async () => {
              await adminClient!.query(
                "DELETE FROM classpilot_supervision_students WHERE context_id = $1",
                [officeSupervisionContextId]
              );
              await adminClient!.query(
                "DELETE FROM classpilot_supervision_contexts WHERE id = $1",
                [officeSupervisionContextId]
              );
            }
          );

          await runMutationCase(
            "alternateTeacherReadySchools",
            {
              officeCohortReadySchools: 1,
              alternateTeacherReadySchools: 0,
            },
            () =>
              adminClient!.query(
                "UPDATE groups SET status = 'inactive' WHERE id = $1",
                [otherGroupId]
              ),
            () =>
              adminClient!.query(
                "UPDATE groups SET status = 'active' WHERE id = $1",
                [otherGroupId]
              )
          );

          await seedAmbiguousOwnedFixture(adminClient);
          try {
            await expectFailure("selectedSchools", {
              eligibleSchools: 2,
              selectedSchools: 0,
            });
          } finally {
            await cleanupAmbiguousOwnedFixture(adminClient);
          }
          assert.equal(
            (
              await planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
                client: applicationClient,
              })
            ).status,
            "passed"
          );
        } finally {
          await applicationClient.end();
        }
      }
    );

    it(
      "proves the production-shaped 20-class primary-only selection yields 19 exact cohorts",
      { timeout: 60_000 },
      async () => {
        assert.ok(adminClient);
        assert.ok(applicationDatabaseUrl);
        assert.ok(planCheckModule);

        const applicationClient = new pg.Client({
          connectionString: applicationDatabaseUrl,
          statement_timeout: 15_000,
        });
        const extraGroupIds = Array.from({ length: 18 }, () => randomUUID());
        const extraPrimaryRelationshipIds = extraGroupIds.map(() =>
          randomUUID()
        );
        const classTwoRosterMembershipIds = rosterStudentIds.map(() =>
          randomUUID()
        );
        const classOneCoTeacherRelationshipId = randomUUID();
        await applicationClient.connect();
        try {
          await adminClient.query(
            `
              INSERT INTO group_students (id, group_id, student_id)
              SELECT
                fixture.membership_id,
                $3,
                fixture.student_id
              FROM unnest($1::text[], $2::text[])
                AS fixture(membership_id, student_id)
            `,
            [
              classTwoRosterMembershipIds,
              rosterStudentIds,
              otherGroupId,
            ]
          );
          await adminClient.query("BEGIN");
          try {
            await adminClient.query(
              `
                INSERT INTO groups (
                  id, school_id, teacher_id, name, description, group_type,
                  status, schedule_enabled
                )
                SELECT
                  fixture.group_id,
                  $2,
                  $3,
                  'Synthetic plan class ' || numbered.class_number,
                  'synthetic-load-fixture:' || $4 ||
                    ':class:' || numbered.class_number,
                  'admin_class',
                  'active',
                  false
                FROM unnest($1::text[])
                  WITH ORDINALITY AS fixture(group_id, ordinality)
                CROSS JOIN LATERAL (
                  SELECT lpad((fixture.ordinality + 2)::text, 2, '0')
                    AS class_number
                ) AS numbered
              `,
              [
                extraGroupIds,
                schoolId,
                primaryTeacherId,
                fixtureId,
              ]
            );
            await adminClient.query(
              `
                INSERT INTO group_teachers (
                  id, group_id, teacher_id, role, assigned_at
                )
                SELECT
                  fixture.relationship_id,
                  fixture.group_id,
                  $3,
                  'primary',
                  now()
                FROM unnest($1::text[], $2::text[])
                  AS fixture(relationship_id, group_id)
              `,
              [
                extraPrimaryRelationshipIds,
                extraGroupIds,
                primaryTeacherId,
              ]
            );
            await adminClient.query("COMMIT");
          } catch (error) {
            await adminClient.query("ROLLBACK");
            throw error;
          }
          await adminClient.query(
            `
              INSERT INTO group_students (id, group_id, student_id)
              SELECT
                gen_random_uuid()::text,
                fixture.group_id,
                roster.student_id
              FROM unnest($1::text[]) AS fixture(group_id)
              CROSS JOIN unnest($2::text[]) AS roster(student_id)
            `,
            [extraGroupIds, rosterStudentIds]
          );
          await adminClient.query(
            `
              INSERT INTO group_teachers (
                id, group_id, teacher_id, role, assigned_at
              )
              VALUES ($1, $2, $3, 'co-teacher', now())
            `,
            [
              classOneCoTeacherRelationshipId,
              classGroupId,
              coTeacherId,
            ]
          );

          const selectionEvents: unknown[] = [];
          const preflight =
            await planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
              client: applicationClient,
              onSelectionEvidence: (event) => selectionEvents.push(event),
            });
          assert.equal(preflight.status, "passed");
          assert.deepEqual(selectionEvents, [{
            version: "classpilot-tile-auth-plan-base-selection-v1",
            cohortSize: 40,
            canonicalPrimaryOnlyGroups: 19,
            exactCohortGroups: 19,
            eligibleSchools: 1,
            finalBases: 1,
          }]);
        } finally {
          await adminClient.query(
            "DELETE FROM group_students WHERE id = ANY($1::text[])",
            [classTwoRosterMembershipIds]
          );
          await adminClient.query(
            "DELETE FROM group_teachers WHERE id = $1",
            [classOneCoTeacherRelationshipId]
          );
          await adminClient.query("BEGIN");
          try {
            await adminClient.query(
              "DELETE FROM group_teachers WHERE group_id = ANY($1::text[])",
              [extraGroupIds]
            );
            await adminClient.query(
              "DELETE FROM group_students WHERE group_id = ANY($1::text[])",
              [extraGroupIds]
            );
            await adminClient.query(
              "DELETE FROM groups WHERE id = ANY($1::text[])",
              [extraGroupIds]
            );
            await adminClient.query("COMMIT");
          } catch (error) {
            await adminClient.query("ROLLBACK");
            throw error;
          }
          await applicationClient.end();
        }
      }
    );

    it(
      "provisions missing device sessions, hides all 123 rows, rolls back, and serializes two real gates",
      { timeout: 180_000 },
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
        const firstResidueClient = new pg.Client({
          connectionString: applicationDatabaseUrl,
          statement_timeout: 15_000,
        });
        const secondResidueClient = new pg.Client({
          connectionString: applicationDatabaseUrl,
          statement_timeout: 15_000,
        });
        await Promise.all([
          firstClient.connect(),
          secondClient.connect(),
          observerClient.connect(),
          firstResidueClient.connect(),
          secondResidueClient.connect(),
        ]);
        const releaseFirst = deferred();
        const gateRuns: Promise<unknown>[] = [];

        try {
          const [
            firstBackend,
            secondBackend,
            firstResidueBackend,
            secondResidueBackend,
          ] = await Promise.all([
            firstClient.query<{ pid: number }>(
              "SELECT pg_backend_pid()::int AS pid"
            ),
            secondClient.query<{ pid: number }>(
              "SELECT pg_backend_pid()::int AS pid"
            ),
            firstResidueClient.query<{ pid: number }>(
              "SELECT pg_backend_pid()::int AS pid"
            ),
            secondResidueClient.query<{ pid: number }>(
              "SELECT pg_backend_pid()::int AS pid"
            ),
          ]);
          const firstBackendPid = firstBackend.rows[0]?.pid;
          const secondBackendPid = secondBackend.rows[0]?.pid;
          const firstResidueBackendPid =
            firstResidueBackend.rows[0]?.pid;
          const secondResidueBackendPid =
            secondResidueBackend.rows[0]?.pid;
          assert.equal(typeof firstBackendPid, "number");
          assert.equal(typeof secondBackendPid, "number");
          assert.equal(typeof firstResidueBackendPid, "number");
          assert.equal(typeof secondResidueBackendPid, "number");
          assert.notEqual(firstBackendPid, secondBackendPid);
          assert.equal(
            new Set([
              firstBackendPid,
              secondBackendPid,
              firstResidueBackendPid,
              secondResidueBackendPid,
            ]).size,
            4
          );

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

          const persistentPrimary = await adminClient.query<{
            teacher_id: string;
            role: string;
          }>(
            `
              SELECT teacher_id, role
              FROM group_teachers
              WHERE group_id = $1
              ORDER BY teacher_id, role
            `,
            [classGroupId]
          );
          assert.deepEqual(persistentPrimary.rows, [{
            teacher_id: primaryTeacherId,
            role: "primary",
          }]);
          assert.equal(await readTransientRowCount(observerClient), 0);
          assert.deepEqual(await readExpiredSessionPosture(observerClient), {
            expired_count: "1",
            open_count: "0",
          });
          assert.deepEqual(
            await planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
              client: firstClient,
            }),
            {
              version: "classpilot-tile-auth-plan-base-preflight-v1",
              status: "passed",
              eligibleBases: 1,
              requiredSessionPairs: 80,
              reusedActiveSessionPairs: 0,
              missingSessionPairs: 80,
              conflictingSessionPairs: 0,
            }
          );
          const firstSeeded = deferred();
          const secondLockRequested = deferred();
          let secondLockAcquired = false;
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
                return result;
              }
              return secondClient.query(text, values as any[]);
            },
          };

          const firstRun =
            planCheckModule.runClasspilotTileAuthorizationPlanCheck({
              client: firstWrappedClient,
              residueClient: firstResidueClient,
              buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
              buildHistoryQuery:
                storageModule.buildHeartbeatTileHistoryBatchQuery,
              onLifecycleEvent: (event) => firstLifecycle.push(event),
            });
          void firstRun.catch(() => undefined);
          await firstSeeded.promise;
          assert.equal(await readTransientRowCount(observerClient), 0);

          const secondRun =
            planCheckModule.runClasspilotTileAuthorizationPlanCheck({
              client: secondWrappedClient,
              residueClient: secondResidueClient,
              buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
              buildHistoryQuery:
                storageModule.buildHeartbeatTileHistoryBatchQuery,
              onLifecycleEvent: (event) => secondLifecycle.push(event),
            });
          void secondRun.catch(() => undefined);
          gateRuns.push(firstRun, secondRun);
          await secondLockRequested.promise;
          const blockedLockStates = await waitForAdvisoryLockSerialization(
            observerClient,
            firstBackendPid,
            secondBackendPid
          );
          assert.deepEqual(
            blockedLockStates,
            [
              { pid: firstBackendPid, granted: true },
              { pid: secondBackendPid, granted: false },
            ].sort((left, right) => left.pid - right.pid)
          );
          assert.equal(secondLockAcquired, false);
          releaseFirst.resolve();

          const [firstReport, secondReport] = await Promise.all([
            firstRun,
            secondRun,
          ]);
          assert.equal(firstReport.status, "passed");
          assert.equal(secondReport.status, "passed");
          assert.equal(secondLockAcquired, true);
          assert.deepEqual(
            await readAdvisoryLockStates(observerClient, [
              firstBackendPid,
              secondBackendPid,
            ]),
            []
          );
          assert.equal(firstLifecycle.length, 1);
          assert.equal(secondLifecycle.length, 1);
          for (const lifecycle of [...firstLifecycle, ...secondLifecycle]) {
            assert.deepEqual(lifecycle, {
              version: "transactional-plan-scenarios-v2",
              requiredSessionPairs: 80,
              reusedActiveSessionPairs: 0,
              insertedSessionPairs: 80,
              seededRows: {
                groupTeachers: 1,
                teachingSessions: 1,
                supervisionContexts: 1,
                supervisionStudents: 40,
                studentSessions: 80,
                total: 123,
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

          assert.ok(adminClient);
          const uncertaintyPool = new pg.Pool({
            connectionString: applicationDatabaseUrl,
            max: 1,
          });
          const uncertaintyResidueClient = new pg.Client({
            connectionString: applicationDatabaseUrl,
            statement_timeout: 15_000,
          });
          await uncertaintyResidueClient.connect();
          const uncertainWriteClient = await uncertaintyPool.connect();
          const uncertainLifecycle: unknown[] = [];
          let uncertainWriteReleased = false;
          try {
            const uncertainWrappedClient: QueryClient = {
              async query(text, values) {
                if (text === "ROLLBACK") {
                  throw new Error("injected_rollback_transport_loss");
                }
                return uncertainWriteClient.query(text, values as any[]);
              },
            };
            await assert.rejects(
              planCheckModule.runClasspilotTileAuthorizationPlanCheck({
                client: uncertainWrappedClient,
                residueClient: uncertaintyResidueClient,
                buildQuery:
                  storageModule.buildClassPilotTileAuthorizationQuery,
                buildHistoryQuery:
                  storageModule.buildHeartbeatTileHistoryBatchQuery,
                onLifecycleEvent: (event) =>
                  uncertainLifecycle.push(event),
              }),
              (error) =>
                error instanceof
                planCheckModule.ClasspilotTileAuthorizationPlanCheckError &&
                error.failureCode ===
                  "transactional_scenario_lifecycle_failed"
            );
            assert.equal(uncertainLifecycle.length, 1);
            assert.deepEqual(
              (
                uncertainLifecycle[0] as {
                  rollback: unknown;
                  residue: unknown;
                }
              ).rollback,
              { attempted: true, completed: false }
            );
            assert.deepEqual(
              (
                uncertainLifecycle[0] as {
                  rollback: unknown;
                  residue: unknown;
                }
              ).residue,
              { checked: true, count: 0, passed: true }
            );
            uncertainWriteClient.release(
              new Error(
                "classpilot_tile_auth_plan_write_connection_discarded"
              )
            );
            uncertainWriteReleased = true;
          } finally {
            if (!uncertainWriteReleased) {
              uncertainWriteClient.release(
                new Error(
                  "classpilot_tile_auth_plan_write_connection_discarded"
                )
              );
            }
            await Promise.allSettled([
              uncertaintyResidueClient.end(),
              uncertaintyPool.end(),
            ]);
          }
          assert.equal(await readTransientRowCount(observerClient), 0);

          await adminClient.query(
            `
              DELETE FROM student_devices
              WHERE student_id = $1
                AND device_id = $2
            `,
            [allStudentIds[0], allDeviceIds[0]]
          );
          await assert.rejects(
            planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
              client: firstClient,
            }),
            (error) =>
              error instanceof
                planCheckModule.ClasspilotTileAuthorizationPlanCheckError &&
              error.failureCode === "representative_scenario_missing" &&
              error.funnelEvidence?.failureStage === "base_funnel" &&
              error.funnelEvidence.firstEmptyStage ===
                "exactCohortGroups" &&
              error.funnelEvidence.counts.canonicalMappedRosterStudents ===
                39
          );
          await adminClient.query(
            `
              INSERT INTO student_devices (
                id, student_id, device_id, first_seen_at, last_seen_at
              )
              VALUES (gen_random_uuid()::text, $1, $2, now(), now())
            `,
            [allStudentIds[0], allDeviceIds[0]]
          );

          await adminClient.query(
            `
              DELETE FROM student_devices
              WHERE student_id = $1
                AND device_id = $2
            `,
            [allStudentIds[1], allDeviceIds[1]]
          );
          await adminClient.query(
            `
              INSERT INTO student_devices (
                id, student_id, device_id, first_seen_at, last_seen_at
              )
              VALUES (gen_random_uuid()::text, $1, $2, now(), now())
            `,
            [allStudentIds[1], allDeviceIds[0]]
          );
          await assert.rejects(
            planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
              client: firstClient,
            }),
            (error) =>
              error instanceof
                planCheckModule.ClasspilotTileAuthorizationPlanCheckError &&
              error.failureCode === "representative_scenario_missing" &&
              error.funnelEvidence?.failureStage === "base_funnel" &&
              error.funnelEvidence.firstEmptyStage ===
                "exactCohortGroups" &&
              error.funnelEvidence.counts.canonicalMappedRosterStudents ===
                39
          );
          await adminClient.query(
            `
              DELETE FROM student_devices
              WHERE student_id = $1
                AND device_id = $2
            `,
            [allStudentIds[1], allDeviceIds[0]]
          );
          await adminClient.query(
            `
              INSERT INTO student_devices (
                id, student_id, device_id, first_seen_at, last_seen_at
              )
              VALUES (gen_random_uuid()::text, $1, $2, now(), now())
            `,
            [allStudentIds[1], allDeviceIds[1]]
          );

          await adminClient.query(
            `
              DELETE FROM group_students
              WHERE group_id = $1
                AND student_id = $2
            `,
            [classGroupId, rosterStudentIds[0]]
          );
          await assert.rejects(
            planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
              client: firstClient,
            }),
            (error) =>
              error instanceof
                planCheckModule.ClasspilotTileAuthorizationPlanCheckError &&
              error.failureCode === "representative_scenario_missing" &&
              error.funnelEvidence?.failureStage === "base_funnel" &&
              error.funnelEvidence.firstEmptyStage ===
                "exactCohortGroups" &&
              error.funnelEvidence.counts.activeRosterStudents === 39
          );
          await adminClient.query(
            `
              INSERT INTO group_students (id, group_id, student_id)
              VALUES (gen_random_uuid()::text, $1, $2)
            `,
            [classGroupId, rosterStudentIds[0]]
          );

          const crossSchoolId = randomUUID();
          await adminClient.query(
            `
              INSERT INTO schools (
                id, name, domain, slug, status, is_active, plan_status,
                stripe_customer_id, stripe_subscription_id, total_paid
              )
              VALUES (
                $1, 'Synthetic cross-school mapping target',
                $2, $3, 'active', true, 'active', NULL, NULL, 0
              )
            `,
            [
              crossSchoolId,
              `${fixtureId}-cross.example.invalid`,
              `${fixtureId}-cross-school`,
            ]
          );
          try {
            await adminClient.query(
              "UPDATE devices SET school_id = $1 WHERE device_id = $2",
              [crossSchoolId, allDeviceIds[0]]
            );
            await assert.rejects(
              planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
                client: firstClient,
              }),
              (error) =>
                error instanceof
                  planCheckModule.ClasspilotTileAuthorizationPlanCheckError &&
                error.failureCode === "representative_scenario_missing" &&
                error.funnelEvidence?.failureStage === "base_funnel" &&
                error.funnelEvidence.firstEmptyStage ===
                  "exactCohortGroups" &&
                error.funnelEvidence.counts.canonicalMappedRosterStudents ===
                  39
            );
          } finally {
            await adminClient.query(
              "UPDATE devices SET school_id = $1 WHERE device_id = $2",
              [schoolId, allDeviceIds[0]]
            );
            await adminClient.query(
              "UPDATE schools SET status = 'suspended', is_active = false, deleted_at = now() WHERE id = $1",
              [crossSchoolId]
            );
          }

          await adminClient.query(
            `
              INSERT INTO student_sessions (
                id, student_id, device_id, started_at, last_seen_at,
                auth_kind, is_active
              )
              SELECT
                gen_random_uuid()::text,
                fixture.student_id,
                fixture.device_id,
                now(),
                now(),
                'managed_profile',
                true
              FROM unnest($1::text[], $2::text[])
                AS fixture(student_id, device_id)
            `,
            [allStudentIds.slice(0, 40), allDeviceIds.slice(0, 40)]
          );
          assert.deepEqual(
            await planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
              client: firstClient,
            }),
            {
              version: "classpilot-tile-auth-plan-base-preflight-v1",
              status: "passed",
              eligibleBases: 1,
              requiredSessionPairs: 80,
              reusedActiveSessionPairs: 40,
              missingSessionPairs: 40,
              conflictingSessionPairs: 0,
            }
          );
          const mixedLifecycle: unknown[] = [];
          const mixedReport =
            await planCheckModule.runClasspilotTileAuthorizationPlanCheck({
              client: firstClient,
              residueClient: firstResidueClient,
              buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
              buildHistoryQuery:
                storageModule.buildHeartbeatTileHistoryBatchQuery,
              onLifecycleEvent: (event) => mixedLifecycle.push(event),
            });
          assert.equal(mixedReport.status, "passed");
          assert.deepEqual(mixedLifecycle, [
            {
              version: "transactional-plan-scenarios-v2",
              requiredSessionPairs: 80,
              reusedActiveSessionPairs: 40,
              insertedSessionPairs: 40,
              seededRows: {
                groupTeachers: 1,
                teachingSessions: 1,
                supervisionContexts: 1,
                supervisionStudents: 40,
                studentSessions: 40,
                total: 83,
              },
              rollback: { attempted: true, completed: true },
              residue: { checked: true, count: 0, passed: true },
            },
          ]);
          await adminClient.query(
            `
              INSERT INTO student_sessions (
                id, student_id, device_id, started_at, last_seen_at,
                auth_kind, is_active
              )
              SELECT
                gen_random_uuid()::text,
                fixture.student_id,
                fixture.device_id,
                now(),
                now(),
                'managed_profile',
                true
              FROM unnest($1::text[], $2::text[])
                AS fixture(student_id, device_id)
            `,
            [allStudentIds.slice(40), allDeviceIds.slice(40)]
          );
          assert.deepEqual(
            await planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
              client: firstClient,
            }),
            {
              version: "classpilot-tile-auth-plan-base-preflight-v1",
              status: "passed",
              eligibleBases: 1,
              requiredSessionPairs: 80,
              reusedActiveSessionPairs: 80,
              missingSessionPairs: 0,
              conflictingSessionPairs: 0,
            }
          );
          const fullyReusedLifecycle: unknown[] = [];
          const fullyReusedReport =
            await planCheckModule.runClasspilotTileAuthorizationPlanCheck({
              client: firstClient,
              residueClient: firstResidueClient,
              buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
              buildHistoryQuery:
                storageModule.buildHeartbeatTileHistoryBatchQuery,
              onLifecycleEvent: (event) =>
                fullyReusedLifecycle.push(event),
            });
          assert.equal(fullyReusedReport.status, "passed");
          assert.deepEqual(fullyReusedLifecycle, [
            {
              version: "transactional-plan-scenarios-v2",
              requiredSessionPairs: 80,
              reusedActiveSessionPairs: 80,
              insertedSessionPairs: 0,
              seededRows: {
                groupTeachers: 1,
                teachingSessions: 1,
                supervisionContexts: 1,
                supervisionStudents: 40,
                studentSessions: 0,
                total: 43,
              },
              rollback: { attempted: true, completed: true },
              residue: { checked: true, count: 0, passed: true },
            },
          ]);
          const conflictingDeviceId = `${fixtureId}-conflicting-0001`;
          await adminClient.query(
            "DELETE FROM student_sessions WHERE student_id = $1",
            [allStudentIds[0]]
          );
          await adminClient.query(
            `
              INSERT INTO devices (
                device_id, device_name, school_id, class_id
              )
              VALUES ($1, 'Synthetic conflicting plan device', $2, $3)
            `,
            [conflictingDeviceId, schoolId, classGroupId]
          );
          await adminClient.query(
            `
              INSERT INTO student_sessions (
                id, student_id, device_id, started_at, last_seen_at,
                auth_kind, is_active
              )
              VALUES (
                gen_random_uuid()::text,
                $1,
                $2,
                now(),
                now(),
                'managed_profile',
                true
              )
            `,
            [allStudentIds[0], conflictingDeviceId]
          );
          await assert.rejects(
            planCheckModule.runClasspilotTileAuthorizationPlanBasePreflight({
              client: firstClient,
            }),
            (error) =>
              error instanceof
                planCheckModule.ClasspilotTileAuthorizationPlanCheckError &&
              error.failureCode === "representative_scenario_missing" &&
              error.funnelEvidence?.failureStage === "session_posture" &&
              error.funnelEvidence.firstEmptyStage === "none" &&
              error.funnelEvidence.sessionPosture
                ?.conflictingSessionPairs === 1
          );

          await adminClient.query(
            "DELETE FROM student_sessions WHERE student_id = $1",
            [allStudentIds[0]]
          );
          await adminClient.query(
            `
              INSERT INTO student_sessions (
                id, student_id, device_id, started_at, last_seen_at,
                auth_kind, manual_lease_expires_at,
                session_recovery_token_hash, is_active
              )
              VALUES (
                gen_random_uuid()::text,
                $1,
                $2,
                now() - interval '10 minutes',
                now() - interval '10 minutes',
                'manual_shared',
                now() - interval '5 minutes',
                $3,
                true
              )
            `,
            [allStudentIds[0], allDeviceIds[0], "a".repeat(64)]
          );
          const expiredSessionPlanCheckModule = planCheckModule;
          assert.ok(expiredSessionPlanCheckModule);
          await assert.rejects(
            expiredSessionPlanCheckModule.runClasspilotTileAuthorizationPlanCheck({
              client: firstClient,
              residueClient: firstResidueClient,
              buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
              buildHistoryQuery:
                storageModule.buildHeartbeatTileHistoryBatchQuery,
            }),
            (error) =>
              error instanceof
                expiredSessionPlanCheckModule.ClasspilotTileAuthorizationPlanCheckError &&
              error.failureCode === "representative_scenario_missing" &&
              error.funnelEvidence?.failureStage === "session_posture" &&
              error.funnelEvidence?.sessionPosture
                ?.conflictingSessionPairs === 1,
            "an expired but physically active manual session must fail closed as a posture conflict, not reach the unique index"
          );
        } finally {
          releaseFirst.resolve();
          await Promise.allSettled(gateRuns);
          await Promise.allSettled([
            firstClient.end(),
            secondClient.end(),
            observerClient.end(),
            firstResidueClient.end(),
            secondResidueClient.end(),
          ]);
        }
      }
    );
  }
);
