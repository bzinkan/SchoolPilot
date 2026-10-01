import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "true";
process.env.REDIS_URL = "";

const { default: db, pool, sessionPool } = await import("../dist/db.js");
const { schedulerPool } = await import("../dist/services/schedulerDb.js");
const { ensureClassPilotDeviceForSchool } = await import("../dist/services/classpilotStudentAuth.js");
const { getDatabaseErrorDetails } = await import("../dist/util/databaseError.js");
const { createSchool } = await import("../dist/services/storage.js");
const { devices, schools } = await import("../dist/schema/index.js");

const suffix = randomUUID().replace(/-/g, "");
const tag = `device-upsert-${suffix}`;
const barrierFunction = `device_upsert_barrier_${suffix}`;
const barrierKey = BigInt(`0x${suffix.slice(0, 14)}`).toString();
let schoolId = "";

before(async () => {
  schoolId = (await createSchool({ name: tag, domain: `${tag}.example.edu`, slug: tag, status: "active", planStatus: "active" })).id;
});

after(async () => {
  try {
    await db.delete(devices).where(eq(devices.schoolId, schoolId));
    await db.delete(schools).where(eq(schools.id, schoolId));
  } finally {
    await Promise.allSettled([pool.end(), sessionPool.end(), schedulerPool.end()]);
  }
});

describe("ClassPilot exact-school device creation", () => {
  it("converges concurrent native inserts across both device uniqueness constraints", async () => {
    const blocker = new Client({ connectionString: process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL });
    await blocker.connect();
    await blocker.query(`CREATE FUNCTION ${barrierFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.device_id LIKE '${tag}-race-%' THEN
          PERFORM pg_advisory_xact_lock_shared(${barrierKey}::bigint);
        END IF;
        RETURN NEW;
      END;
    $$`);
    await blocker.query(`CREATE TRIGGER ${barrierFunction} BEFORE INSERT ON devices FOR EACH ROW EXECUTE FUNCTION ${barrierFunction}()`);
    try {
      for (let round = 0; round < 48; round += 1) {
        const deviceId = `${tag}-race-${round}`;
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock($1::bigint)", [barrierKey]);
        // Hold actual INSERTs after each caller observed the missing row. The
        // release overlaps real PostgreSQL index insertion; no error is faked.
        const attempts = Array.from({ length: 2 }, async (_, writer) => {
          const options = { deviceId, schoolId, deviceName: `${tag}-${writer}`, classId: schoolId };
          if (round < 24) return ensureClassPilotDeviceForSchool(options);
          return db.transaction(async tx => {
            await tx.execute(sql`SELECT set_config('app.school_id', ${schoolId}, true), set_config('app.is_super', 'off', true)`);
            const device = await ensureClassPilotDeviceForSchool(options, tx);
            const context = await tx.execute<{ school: string; isSuper: string }>(sql`SELECT current_setting('app.school_id') AS school, current_setting('app.is_super') AS "isSuper"`);
            assert.deepEqual(context.rows[0], { school: schoolId, isSuper: "off" });
            return device;
          });
        });
        const settled = Promise.allSettled(attempts);
        const deadline = Date.now() + 5_000;
        let waiting = 0;
        try {
          while (Date.now() < deadline) {
            await blocker.query("SELECT pg_stat_clear_snapshot()");
            const result = await blocker.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'insert into "devices"%'`);
            waiting = result.rows[0]?.count || 0;
            if (waiting === attempts.length) break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        } finally {
          await blocker.query("COMMIT");
        }
        const results = await settled;
        assert.equal(waiting, attempts.length, "all native writers reached the missing-device insertion boundary");
        const failures = results.flatMap(result => result.status === "rejected" ? [getDatabaseErrorDetails(result.reason)] : []);
        assert.deepEqual(failures, [], `all exact-device creators must converge (round ${round})`);
        for (const result of results) {
          assert.equal(result.status, "fulfilled");
          if (result.status === "fulfilled") {
            assert.equal(result.value.deviceId, deviceId);
            assert.equal(result.value.schoolId, schoolId);
          }
        }
        assert.equal((await db.select().from(devices).where(eq(devices.deviceId, deviceId))).length, 1);
      }
    } finally {
      await blocker.query(`DROP TRIGGER IF EXISTS ${barrierFunction} ON devices`);
      await blocker.query(`DROP FUNCTION IF EXISTS ${barrierFunction}()`);
      await blocker.end();
    }
  });

  it("keeps an existing device's school, class and name immutable during creation", async () => {
    const deviceId = `${tag}-existing`;
    const original = await ensureClassPilotDeviceForSchool({ deviceId, schoolId, deviceName: "Original", classId: schoolId });
    assert.deepEqual(await ensureClassPilotDeviceForSchool({ deviceId, schoolId, deviceName: "Replacement", classId: "other-class" }), original);
    await assert.rejects(ensureClassPilotDeviceForSchool({ deviceId, schoolId: randomUUID() }),
      { code: "STUDENT_DEVICE_UNAVAILABLE", status: 403 });
    assert.deepEqual((await db.select().from(devices).where(eq(devices.deviceId, deviceId)))[0], original);
  });

  it("propagates an unrelated native unique conflict without aborting an outer transaction", async () => {
    const constraint = `device_upsert_other_${suffix}`;
    const name = `${tag}-unrelated`;
    const ownerId = `${tag}-unrelated-owner`;
    const rejectedId = `${tag}-unrelated-rejected`;
    await ensureClassPilotDeviceForSchool({ deviceId: ownerId, schoolId, deviceName: name });
    await db.execute(sql.raw(`CREATE UNIQUE INDEX ${constraint} ON devices(device_name) WHERE device_name='${name}'`));
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${schoolId}, true), set_config('app.is_super', 'off', true)`);
        await assert.rejects(ensureClassPilotDeviceForSchool({ deviceId: rejectedId, schoolId, deviceName: name }, tx), error => {
          assert.deepEqual(getDatabaseErrorDetails(error), { code: "23505", constraint });
          return true;
        });
        const context = await tx.execute<{ school: string; isSuper: string }>(sql`SELECT current_setting('app.school_id') AS school, current_setting('app.is_super') AS "isSuper"`);
        assert.deepEqual(context.rows[0], { school: schoolId, isSuper: "off" });
        assert.equal((await tx.select().from(devices).where(eq(devices.deviceId, rejectedId))).length, 0);
        assert.equal((await ensureClassPilotDeviceForSchool({ deviceId: `${tag}-outer-success`, schoolId }, tx)).schoolId, schoolId);
      });
    } finally {
      await db.execute(sql.raw(`DROP INDEX IF EXISTS ${constraint}`));
    }
  });

  it("keeps successful device creation inside its caller's rollback boundary", async () => {
    const deviceId = `${tag}-outer-rollback`;
    await assert.rejects(db.transaction(async tx => {
      await ensureClassPilotDeviceForSchool({ deviceId, schoolId }, tx);
      throw new Error("intentional caller rollback");
    }), /intentional caller rollback/);
    assert.equal((await db.select().from(devices).where(eq(devices.deviceId, deviceId))).length, 0);
  });
});
