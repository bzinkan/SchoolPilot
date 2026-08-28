import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL,
  CLASSPILOT_STUDENT_SESSION_RECOVERY_VALIDATE_SQL,
} from "../src/db/migrations27.js";

const databaseUrl = process.env.DATABASE_URL;

describe(
  "ClassPilot student-session auth-kind Phase-A guard",
  { skip: !databaseUrl },
  () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    let client: pg.PoolClient;

    before(async () => {
      client = await pool.connect();
    });

    after(async () => {
      client?.release();
      await pool.end();
    });

    it("allows old-writer legacy inserts but makes the chosen auth kind immutable", async () => {
      const retainedId = randomUUID();
      const retainedStudentId = randomUUID();
      const retainedDeviceId = `auth-kind-guard-retained-${randomUUID()}`;

      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.is_super', 'on', true)");

        // Bootstrap the additive columns if this focused test is run against a
        // pre-migration local database. Reapplying Phase A also removes the
        // superseded pre-release INSERT guard if it was installed locally.
        await client.query(CLASSPILOT_STUDENT_SESSION_RECOVERY_SQL);
        const omitted = await client.query<{ auth_kind: string }>(
          `
            INSERT INTO student_sessions (
              id, student_id, device_id, is_active
            )
            VALUES ($1, $2, $3, false)
            RETURNING auth_kind
          `,
          [retainedId, retainedStudentId, retainedDeviceId]
        );
        assert.equal(omitted.rows[0]?.auth_kind, "legacy");

        const explicitLegacy = await client.query<{ auth_kind: string }>(
          `
            INSERT INTO student_sessions (
              id, student_id, device_id, auth_kind, is_active
            )
            VALUES ($1, $2, $3, 'legacy', false)
            RETURNING auth_kind
          `,
          [randomUUID(), randomUUID(), `auth-kind-guard-explicit-${randomUUID()}`]
        );
        assert.equal(explicitLegacy.rows[0]?.auth_kind, "legacy");

        const updated = await client.query<{ auth_kind: string }>(
          `
            UPDATE student_sessions
            SET last_seen_at = now()
            WHERE id = $1
            RETURNING auth_kind
          `,
          [retainedId]
        );
        assert.equal(updated.rowCount, 1);
        assert.equal(updated.rows[0]?.auth_kind, "legacy");

        const sameKindUpdate = await client.query<{ auth_kind: string }>(
          `
            UPDATE student_sessions
            SET auth_kind = 'legacy'
            WHERE id = $1
            RETURNING auth_kind
          `,
          [retainedId]
        );
        assert.equal(sameKindUpdate.rows[0]?.auth_kind, "legacy");

        const managedId = randomUUID();
        const managed = await client.query<{ auth_kind: string }>(
          `
            INSERT INTO student_sessions (
              id, student_id, device_id, auth_kind, is_active
            )
            VALUES ($1, $2, $3, 'managed_profile', false)
            RETURNING auth_kind
          `,
          [
            managedId,
            randomUUID(),
            `auth-kind-guard-managed-${randomUUID()}`,
          ]
        );
        assert.equal(managed.rows[0]?.auth_kind, "managed_profile");

        for (const fixture of [
          { id: retainedId, nextKind: "managed_profile", savepoint: "legacy_change" },
          {
            id: managedId,
            nextKind: "legacy",
            savepoint: "managed_change",
          },
        ]) {
          await client.query(`SAVEPOINT ${fixture.savepoint}`);
          try {
            await client.query(
              "UPDATE student_sessions SET auth_kind = $2 WHERE id = $1",
              [fixture.id, fixture.nextKind]
            );
            assert.fail("student-session auth kind unexpectedly changed");
          } catch (error) {
            assert.equal((error as { code?: string }).code, "CP002");
            assert.equal(
              (error as { message?: string }).message,
              "CLASSPILOT_SESSION_AUTH_KIND_IMMUTABLE"
            );
          } finally {
            await client.query(`ROLLBACK TO SAVEPOINT ${fixture.savepoint}`);
            await client.query(`RELEASE SAVEPOINT ${fixture.savepoint}`);
          }
        }

        await client.query(CLASSPILOT_STUDENT_SESSION_RECOVERY_VALIDATE_SQL);
        const constraints = await client.query<{ conname: string; convalidated: boolean }>(
          `
            SELECT conname, convalidated
            FROM pg_constraint
            WHERE conrelid = 'student_sessions'::regclass
              AND conname = ANY($1::text[])
          `,
          [[
            "student_sessions_auth_kind_check",
            "student_sessions_manual_lease_shape_check",
            "student_sessions_active_manual_recovery_check",
            "student_sessions_recovery_token_hash_check",
          ]]
        );
        assert.equal(constraints.rows.length, 4);
        assert.ok(constraints.rows.every((row) => row.convalidated));
      } finally {
        await client.query("ROLLBACK");
      }
    });
  }
);
