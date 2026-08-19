import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import {
  policySqlFor,
  RLS_POLICY_NAME,
} from "../src/db/rlsPolicies.js";

const REQUIRED_TRIGGERS = [
  "classpilot_bind_poll_response_school",
  "classpilot_bind_poll_school",
  "classpilot_bind_session_setting_school",
  "classpilot_validate_active_hand_parents",
  "classpilot_validate_chat_delivery_parents",
] as const;

const POLICY_TABLES = [
  "session_settings",
  "classpilot_active_hands",
  "classpilot_chat_deliveries",
  "polls",
  "poll_responses",
  "teaching_sessions",
  "students",
  "devices",
  "chat_messages",
  "classpilot_commands",
] as const;

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

test(
  "ClassPilot FAB parent guards hold under FORCE RLS and preserve detached device history",
  async (t) => {
    const connectionString =
      process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
      return;
    }

    const client = new pg.Client({ connectionString });
    await client.connect();
    let transactionStarted = false;

    try {
      const identity = await client.query<{ rolsuper: boolean }>(`
        SELECT role.rolsuper
        FROM pg_roles role
        WHERE role.rolname = current_user
      `);
      if (!identity.rows[0]?.rolsuper) {
        t.skip("requires a PostgreSQL superuser connection for hermetic role and catalog setup");
        return;
      }

      const installedTriggers = await client.query<{ tgname: string }>(`
        SELECT trigger.tgname
        FROM pg_trigger trigger
        JOIN pg_class relation ON relation.oid = trigger.tgrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND NOT trigger.tgisinternal
          AND trigger.tgname = ANY($1::text[])
        ORDER BY trigger.tgname
      `, [[...REQUIRED_TRIGGERS]]);

      // Drizzle's schema-only test job intentionally does not run startup
      // convergence. The migration/RLS job does; partial convergence is a hard
      // failure, while a schema-only database skips this integration probe.
      if (installedTriggers.rowCount === 0) {
        t.skip("requires ClassPilot FAB startup schema convergence");
        return;
      }
      assert.deepEqual(
        installedTriggers.rows.map((row) => row.tgname),
        [...REQUIRED_TRIGGERS].sort(),
        "all release-critical FAB parent triggers must be installed",
      );

      await client.query("BEGIN");
      transactionStarted = true;

      const token = `fab_${process.pid}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const role = `${token}_role`;
      const roleIdentifier = quoteIdentifier(role);
      await client.query(`CREATE ROLE ${roleIdentifier} NOSUPERUSER NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${roleIdentifier}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${POLICY_TABLES.join(", ")} TO ${roleIdentifier}`,
      );

      for (const table of POLICY_TABLES) {
        for (const statement of policySqlFor(table)) {
          await client.query(statement);
        }
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      }

      const rlsCatalog = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        has_policy: boolean;
      }>(`
        SELECT
          relation.relname,
          relation.relrowsecurity,
          relation.relforcerowsecurity,
          EXISTS (
            SELECT 1
            FROM pg_policy policy
            WHERE policy.polrelid = relation.oid
              AND policy.polname = $2
          ) AS has_policy
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = ANY($1::text[])
        ORDER BY relation.relname
      `, [[...POLICY_TABLES], RLS_POLICY_NAME]);
      assert.equal(rlsCatalog.rowCount, POLICY_TABLES.length);
      for (const relation of rlsCatalog.rows) {
        assert.equal(relation.relrowsecurity, true, `${relation.relname} must have RLS enabled`);
        assert.equal(relation.relforcerowsecurity, true, `${relation.relname} must FORCE RLS`);
        assert.equal(relation.has_policy, true, `${relation.relname} must have tenant_isolation`);
      }

      const ids = {
        schoolA: `${token}_school_a`,
        schoolB: `${token}_school_b`,
        teacher: `${token}_teacher`,
        groupA: `${token}_group_a`,
        groupB: `${token}_group_b`,
        studentA: `${token}_student_a`,
        studentB: `${token}_student_b`,
        deviceA: `${token}_device_a`,
        deviceB: `${token}_device_b`,
        sessionA: `${token}_session_a`,
        sessionB: `${token}_session_b`,
        messageA: `${token}_message_a`,
        messageB: `${token}_message_b`,
        commandA: `${token}_command_a`,
        commandB: `${token}_command_b`,
        commandBPoll: `${token}_command_b_poll`,
        pollA: `${token}_poll_a`,
        pollB: `${token}_poll_b`,
      };

      await client.query(
        `INSERT INTO schools (id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          ids.schoolA,
          `${token} School A`,
          `${token}-school-a`,
          ids.schoolB,
          `${token} School B`,
          `${token}-school-b`,
        ],
      );
      await client.query(
        `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'FAB', 'Probe')`,
        [ids.teacher, `${token}@example.invalid`],
      );
      await client.query(
        `
          INSERT INTO groups (id, school_id, teacher_id, name)
          VALUES ($1, $2, $3, $4), ($5, $6, $3, $7)
        `,
        [
          ids.groupA,
          ids.schoolA,
          ids.teacher,
          `${token} Group A`,
          ids.groupB,
          ids.schoolB,
          `${token} Group B`,
        ],
      );
      await client.query(
        `
          INSERT INTO students (id, school_id, first_name, last_name)
          VALUES ($1, $2, 'Student', 'A'), ($3, $4, 'Student', 'B')
        `,
        [ids.studentA, ids.schoolA, ids.studentB, ids.schoolB],
      );
      await client.query(
        `
          INSERT INTO devices (device_id, school_id, class_id)
          VALUES ($1, $2, $3), ($4, $5, $6)
        `,
        [ids.deviceA, ids.schoolA, ids.groupA, ids.deviceB, ids.schoolB, ids.groupB],
      );
      await client.query(
        `
          INSERT INTO teaching_sessions (id, group_id, teacher_id, school_id)
          VALUES ($1, $2, $3, $4), ($5, $6, $3, $7)
        `,
        [
          ids.sessionA,
          ids.groupA,
          ids.teacher,
          ids.schoolA,
          ids.sessionB,
          ids.groupB,
          ids.schoolB,
        ],
      );
      await client.query(
        `
          INSERT INTO chat_messages (
            id, school_id, session_id, student_id, sender_id,
            sender_type, content, message_type
          ) VALUES
            ($1, $2, $3, $4, $5, 'teacher', 'A', 'message'),
            ($6, $7, $8, $9, $5, 'teacher', 'B', 'message')
        `,
        [
          ids.messageA,
          ids.schoolA,
          ids.sessionA,
          ids.studentA,
          ids.teacher,
          ids.messageB,
          ids.schoolB,
          ids.sessionB,
          ids.studentB,
        ],
      );

      const insertPollCommand = async (
        id: string,
        schoolId: string,
        sessionId: string,
      ) => {
        await client.query(
          `
            INSERT INTO classpilot_commands (
              id, school_id, teaching_session_id, teacher_id,
              target_scope, command_type, command_payload
            ) VALUES ($1, $2, $3, $4, 'students', 'poll', $5::jsonb)
          `,
          [id, schoolId, sessionId, ids.teacher, JSON.stringify({ action: "start" })],
        );
      };
      await insertPollCommand(ids.commandA, ids.schoolA, ids.sessionA);
      await insertPollCommand(ids.commandB, ids.schoolB, ids.sessionB);
      await insertPollCommand(ids.commandBPoll, ids.schoolB, ids.sessionB);
      await client.query(
        `
          INSERT INTO polls (
            id, school_id, session_id, teacher_id, start_command_id,
            question, options, is_active
          ) VALUES ($1, $2, $3, $4, $5, 'B poll', $6::text[], true)
        `,
        [
          ids.pollB,
          ids.schoolB,
          ids.sessionB,
          ids.teacher,
          ids.commandBPoll,
          ["Yes", "No"],
        ],
      );

      await client.query(`SET LOCAL ROLE ${roleIdentifier}`);
      await client.query("SELECT set_config('app.school_id', $1, true)", [ids.schoolA]);
      await client.query("SELECT set_config('app.is_super', 'off', true)");

      const probeDatabaseError = async (
        label: string,
        statement: string,
        parameters: unknown[],
        code: string,
        message: RegExp,
      ): Promise<boolean> => {
        await client.query("SAVEPOINT expected_failure");
        let rejected = false;
        try {
          await client.query(statement, parameters);
        } catch (error) {
          rejected = true;
          const databaseError = error as { code?: string; message?: string };
          assert.equal(databaseError.code, code, `${label}: unexpected PostgreSQL error code`);
          assert.match(databaseError.message ?? "", message, `${label}: unexpected error message`);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT expected_failure");
          await client.query("RELEASE SAVEPOINT expected_failure");
        }
        return rejected;
      };

      const expectDatabaseError = async (
        label: string,
        statement: string,
        parameters: unknown[],
        code: string,
        message: RegExp,
      ) => {
        assert.equal(
          await probeDatabaseError(label, statement, parameters, code, message),
          true,
          `Missing expected rejection: ${label}`,
        );
      };

      const visibleParents = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM teaching_sessions WHERE id = ANY($1::text[])`,
        [[ids.sessionA, ids.sessionB]],
      );
      assert.equal(visibleParents.rows[0]?.count, 1, "school B parents must be hidden by RLS");

      await expectDatabaseError(
        "RLS WITH CHECK blocks a school B parent row in school A context",
        `
          INSERT INTO students (id, school_id, first_name, last_name)
          VALUES ($1, $2, 'Blocked', 'By RLS')
        `,
        [`${token}_student_rls`, ids.schoolB],
        "42501",
        /row-level security|policy/i,
      );
      await expectDatabaseError(
        "session setting rejects a hidden cross-school teaching session",
        `INSERT INTO session_settings (id, school_id, session_id) VALUES ($1, $2, $3)`,
        [`${token}_setting_cross`, ids.schoolA, ids.sessionB],
        "23514",
        /session setting tenant/i,
      );
      await client.query(
        `INSERT INTO session_settings (id, school_id, session_id) VALUES ($1, $2, $3)`,
        [`${token}_setting_a`, ids.schoolA, ids.sessionA],
      );

      await expectDatabaseError(
        "active hand rejects a hidden cross-school session",
        `
          INSERT INTO classpilot_active_hands
            (id, school_id, teaching_session_id, student_id, device_id)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [`${token}_hand_session`, ids.schoolA, ids.sessionB, ids.studentA, ids.deviceA],
        "23514",
        /session and student/i,
      );
      await expectDatabaseError(
        "active hand rejects a hidden cross-school student",
        `
          INSERT INTO classpilot_active_hands
            (id, school_id, teaching_session_id, student_id, device_id)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [`${token}_hand_student`, ids.schoolA, ids.sessionA, ids.studentB, ids.deviceA],
        "23514",
        /session and student/i,
      );
      await expectDatabaseError(
        "active hand rejects a hidden cross-school device",
        `
          INSERT INTO classpilot_active_hands
            (id, school_id, teaching_session_id, student_id, device_id)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [`${token}_hand_device`, ids.schoolA, ids.sessionA, ids.studentA, ids.deviceB],
        "23514",
        /device must belong/i,
      );
      await expectDatabaseError(
        "new cleared hand rejects a hidden cross-school device",
        `
          INSERT INTO classpilot_active_hands
            (id, school_id, teaching_session_id, student_id, device_id, cleared_at)
          VALUES ($1, $2, $3, $4, $5, now())
        `,
        [`${token}_hand_cleared_cross`, ids.schoolA, ids.sessionA, ids.studentA, ids.deviceB],
        "23514",
        /device must belong/i,
      );
      const handId = `${token}_hand_a`;
      await client.query(
        `
          INSERT INTO classpilot_active_hands
            (id, school_id, teaching_session_id, student_id, device_id)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [handId, ids.schoolA, ids.sessionA, ids.studentA, ids.deviceA],
      );
      const clearedSwapRejected = await probeDatabaseError(
        "clearing an active hand cannot swap in a hidden cross-school device",
        `UPDATE classpilot_active_hands SET device_id = $1, cleared_at = now() WHERE id = $2`,
        [ids.deviceB, handId],
        "23514",
        /device/i,
      );
      await client.query(
        `UPDATE classpilot_active_hands SET cleared_at = now() WHERE id = $1`,
        [handId],
      );

      for (const [suffix, messageId, sessionId, studentId] of [
        ["message", ids.messageB, ids.sessionA, ids.studentA],
        ["session", ids.messageA, ids.sessionB, ids.studentA],
        ["student", ids.messageA, ids.sessionA, ids.studentB],
      ] as const) {
        await expectDatabaseError(
          `chat delivery rejects a cross-school ${suffix} parent`,
          `
            INSERT INTO classpilot_chat_deliveries (
              id, school_id, chat_message_id, teaching_session_id,
              student_id, expires_at
            ) VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')
          `,
          [`${token}_delivery_${suffix}`, ids.schoolA, messageId, sessionId, studentId],
          "23514",
          /chat delivery parents/i,
        );
      }
      await client.query(
        `
          INSERT INTO classpilot_chat_deliveries (
            id, school_id, chat_message_id, teaching_session_id,
            student_id, expires_at
          ) VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')
        `,
        [
          `${token}_delivery_a`,
          ids.schoolA,
          ids.messageA,
          ids.sessionA,
          ids.studentA,
        ],
      );

      await expectDatabaseError(
        "poll rejects a hidden cross-school teaching session",
        `
          INSERT INTO polls
            (id, school_id, session_id, teacher_id, question, options, is_active)
          VALUES ($1, $2, $3, $4, 'Cross session', $5::text[], false)
        `,
        [`${token}_poll_session`, ids.schoolA, ids.sessionB, ids.teacher, ["A", "B"]],
        "23514",
        /poll tenant/i,
      );
      await expectDatabaseError(
        "poll rejects hidden cross-school command authority",
        `
          INSERT INTO polls (
            id, school_id, session_id, teacher_id, start_command_id,
            question, options, is_active
          ) VALUES ($1, $2, $3, $4, $5, 'Cross command', $6::text[], true)
        `,
        [
          `${token}_poll_command`,
          ids.schoolA,
          ids.sessionA,
          ids.teacher,
          ids.commandB,
          ["A", "B"],
        ],
        "23514",
        /command authority/i,
      );
      await client.query(
        `
          INSERT INTO polls (
            id, school_id, session_id, teacher_id, start_command_id,
            question, options, is_active
          ) VALUES ($1, $2, $3, $4, $5, 'A poll', $6::text[], true)
        `,
        [
          ids.pollA,
          ids.schoolA,
          ids.sessionA,
          ids.teacher,
          ids.commandA,
          ["Yes", "No"],
        ],
      );

      await expectDatabaseError(
        "poll response rejects a hidden cross-school poll",
        `
          INSERT INTO poll_responses
            (id, school_id, poll_id, student_id, device_id, selected_option)
          VALUES ($1, $2, $3, $4, $5, 0)
        `,
        [`${token}_response_poll`, ids.schoolA, ids.pollB, ids.studentA, ids.deviceA],
        "23514",
        /poll response tenant/i,
      );
      await expectDatabaseError(
        "poll response rejects a hidden cross-school student",
        `
          INSERT INTO poll_responses
            (id, school_id, poll_id, student_id, device_id, selected_option)
          VALUES ($1, $2, $3, $4, $5, 0)
        `,
        [`${token}_response_student`, ids.schoolA, ids.pollA, ids.studentB, ids.deviceA],
        "23514",
        /student does not belong/i,
      );
      await expectDatabaseError(
        "poll response rejects a hidden cross-school device",
        `
          INSERT INTO poll_responses
            (id, school_id, poll_id, student_id, device_id, selected_option)
          VALUES ($1, $2, $3, $4, $5, 0)
        `,
        [`${token}_response_device`, ids.schoolA, ids.pollA, ids.studentA, ids.deviceB],
        "23514",
        /device does not belong/i,
      );
      const responseId = `${token}_response_a`;
      await client.query(
        `
          INSERT INTO poll_responses
            (id, school_id, poll_id, student_id, device_id, selected_option)
          VALUES ($1, $2, $3, $4, $5, 0)
        `,
        [responseId, ids.schoolA, ids.pollA, ids.studentA, ids.deviceA],
      );

      // Mirrors the device-deletion ordering: detach provenance, delete the
      // device, then prove cleared history remains valid but new rows cannot
      // claim the deleted device.
      await client.query(
        `UPDATE poll_responses SET device_id = NULL WHERE id = $1`,
        [responseId],
      );
      const deletedDevice = await client.query(
        `DELETE FROM devices WHERE device_id = $1`,
        [ids.deviceA],
      );
      assert.equal(deletedDevice.rowCount, 1);
      await client.query(
        `UPDATE classpilot_active_hands SET cleared_at = clock_timestamp() WHERE id = $1`,
        [handId],
      );
      await expectDatabaseError(
        "new cleared hand cannot claim a deleted device",
        `
          INSERT INTO classpilot_active_hands
            (id, school_id, teaching_session_id, student_id, device_id, cleared_at)
          VALUES ($1, $2, $3, $4, $5, now())
        `,
        [`${token}_hand_deleted`, ids.schoolA, ids.sessionA, ids.studentA, ids.deviceA],
        "23514",
        /device must belong/i,
      );

      const visibleState = await client.query<{
        settings: number;
        hands: number;
        deliveries: number;
        polls: number;
        responses: number;
        detached_responses: number;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM session_settings WHERE id = $1) AS settings,
          (SELECT count(*)::integer FROM classpilot_active_hands WHERE id = $2) AS hands,
          (SELECT count(*)::integer FROM classpilot_chat_deliveries WHERE id = $3) AS deliveries,
          (SELECT count(*)::integer FROM polls WHERE id = ANY($4::text[])) AS polls,
          (SELECT count(*)::integer FROM poll_responses WHERE id = $5) AS responses,
          (SELECT count(*)::integer FROM poll_responses WHERE id = $5 AND device_id IS NULL) AS detached_responses
      `, [
        `${token}_setting_a`,
        handId,
        `${token}_delivery_a`,
        [ids.pollA, ids.pollB],
        responseId,
      ]);
      assert.deepEqual(visibleState.rows[0], {
        settings: 1,
        hands: 1,
        deliveries: 1,
        polls: 1,
        responses: 1,
        detached_responses: 1,
      });
      assert.equal(
        clearedSwapRejected,
        true,
        "clearing an active hand must reject a hidden cross-school device swap",
      );
    } finally {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Closing the connection also discards any open transaction.
        }
      }
      await client.end();
    }
  },
);
