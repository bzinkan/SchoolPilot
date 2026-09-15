import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

const parents = [
  ["session_settings", "session_id"], ["chat_messages", "session_id"],
  ["classpilot_chat_deliveries", "teaching_session_id"], ["classpilot_active_hands", "teaching_session_id"],
  ["polls", "session_id"], ["classpilot_classroom_states", "teaching_session_id"],
] as const;
const triggerNames: Record<string, string> = {
  session_settings: "classpilot_bind_session_setting_school", classpilot_active_hands: "classpilot_validate_active_hand_parents",
  classpilot_chat_deliveries: "classpilot_validate_chat_delivery_parents", polls: "classpilot_bind_poll_school",
};

export const CLASSPILOT_SCHEDULED_CLASSROOM_GUARDS_SQL = `
CREATE OR REPLACE FUNCTION classpilot_validate_activity_record(body JSONB, parent_column TEXT, relation_name TEXT,
  operation TEXT, old_body JSONB DEFAULT NULL) RETURNS VOID LANGUAGE plpgsql AS $activity$
DECLARE session_ref TEXT; context_ref TEXT; expected_school TEXT;
BEGIN
  session_ref := body->>parent_column; context_ref := body->>'supervision_context_id';
  IF num_nonnulls(session_ref,context_ref) <> 1 THEN
    RAISE EXCEPTION 'classroom activity requires exactly one parent' USING ERRCODE='23514';
  END IF;
  IF session_ref IS NOT NULL THEN SELECT school_id INTO expected_school FROM teaching_sessions WHERE id=session_ref;
  ELSE SELECT school_id INTO expected_school FROM classpilot_supervision_contexts WHERE id=context_ref; END IF;
  IF expected_school IS NULL OR body->>'school_id' IS DISTINCT FROM expected_school THEN
    RAISE EXCEPTION 'classroom activity parent belongs to another school' USING ERRCODE='23514';
  END IF;
  IF body->>'student_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM students WHERE id=body->>'student_id' AND school_id=expected_school) THEN
    RAISE EXCEPTION 'classroom activity student belongs to another school' USING ERRCODE='23514';
  END IF;
  IF body->>'device_id' IS NOT NULL AND EXISTS(SELECT 1 FROM devices WHERE device_id=body->>'device_id' AND school_id<>expected_school) THEN
    RAISE EXCEPTION 'classroom activity device belongs to another school' USING ERRCODE='23514';
  END IF;
  IF relation_name='classpilot_active_hands' AND (operation='INSERT' OR body->>'cleared_at' IS NULL
    OR body->>'device_id' IS DISTINCT FROM old_body->>'device_id')
    AND NOT EXISTS(SELECT 1 FROM devices WHERE device_id=body->>'device_id' AND school_id=expected_school) THEN
    RAISE EXCEPTION 'active hand requires a same-school device' USING ERRCODE='23514';
  END IF;
  IF relation_name='classpilot_chat_deliveries' AND NOT EXISTS(
    SELECT 1 FROM chat_messages message WHERE message.id=body->>'chat_message_id' AND message.school_id=expected_school
      AND message.session_id IS NOT DISTINCT FROM session_ref
      AND message.supervision_context_id IS NOT DISTINCT FROM context_ref
      AND message.student_id=body->>'student_id') THEN
    RAISE EXCEPTION 'chat delivery must match the exact message activity and student' USING ERRCODE='23514';
  END IF;
  IF relation_name='polls' THEN
    IF (body->>'is_active')::boolean AND body->>'start_command_id' IS NULL THEN
      RAISE EXCEPTION 'active poll requires start command authority' USING ERRCODE='23514';
    END IF;
    IF body->>'start_command_id' IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM classpilot_commands command WHERE command.id=body->>'start_command_id' AND command.school_id=expected_school
        AND command.teaching_session_id IS NOT DISTINCT FROM session_ref AND command.supervision_context_id IS NOT DISTINCT FROM context_ref
        AND command.teacher_id=body->>'teacher_id' AND command.command_type='poll' AND command.command_payload->>'action'='start') THEN
      RAISE EXCEPTION 'poll start command must match its activity' USING ERRCODE='23514';
    END IF;
    IF body->>'close_command_id' IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM classpilot_commands command WHERE command.id=body->>'close_command_id' AND command.school_id=expected_school
        AND command.teaching_session_id IS NOT DISTINCT FROM session_ref AND command.supervision_context_id IS NOT DISTINCT FROM context_ref
        AND command.command_type='poll' AND command.command_payload->>'action'='close') THEN
      RAISE EXCEPTION 'poll close command must match its activity' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN;
END $activity$;
CREATE OR REPLACE FUNCTION classpilot_validate_activity_parent() RETURNS trigger LANGUAGE plpgsql AS $activity$
BEGIN
  PERFORM classpilot_validate_activity_record(to_jsonb(NEW), TG_ARGV[0], TG_TABLE_NAME, TG_OP, to_jsonb(OLD));
  RETURN NEW;
END $activity$;
DROP TRIGGER IF EXISTS classpilot_validate_active_hand_parents ON classpilot_active_hands;
DROP TRIGGER IF EXISTS classpilot_bind_session_setting_school ON session_settings;
DROP TRIGGER IF EXISTS classpilot_validate_chat_delivery_parents ON classpilot_chat_deliveries;
DROP TRIGGER IF EXISTS classpilot_bind_poll_school ON polls;
${parents.map(([table, column]) => `
DROP TRIGGER IF EXISTS cp_activity_parent ON ${table};
CREATE TRIGGER ${triggerNames[table] ?? "cp_activity_parent"} BEFORE INSERT OR UPDATE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION classpilot_validate_activity_parent('${column}');`).join("\n")}
`;

export const CLASSPILOT_SCHEDULED_CLASSROOM_SQL = `
ALTER TABLE classpilot_supervision_contexts ADD COLUMN IF NOT EXISTS classroom_authority_revision INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='classpilot_supervision_contexts'::regclass AND conname='cp_context_classroom_authority_revision_check') THEN
    ALTER TABLE classpilot_supervision_contexts ADD CONSTRAINT cp_context_classroom_authority_revision_check CHECK(classroom_authority_revision>=0);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION classpilot_preserve_classroom_authority_revision() RETURNS trigger LANGUAGE plpgsql AS $authority$
BEGIN
  NEW.classroom_authority_revision := CASE WHEN NEW.assigned_staff_id IS DISTINCT FROM OLD.assigned_staff_id
    THEN OLD.classroom_authority_revision + 1 ELSE OLD.classroom_authority_revision END;
  RETURN NEW;
END $authority$;
DROP TRIGGER IF EXISTS cp_context_classroom_authority_revision ON classpilot_supervision_contexts;
CREATE TRIGGER cp_context_classroom_authority_revision BEFORE UPDATE OF assigned_staff_id,classroom_authority_revision
  ON classpilot_supervision_contexts FOR EACH ROW EXECUTE FUNCTION classpilot_preserve_classroom_authority_revision();
CREATE UNIQUE INDEX IF NOT EXISTS cp_activity_supervision_school_id_unique ON classpilot_supervision_contexts(school_id,id);
${parents.map(([table, column]) => `
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS supervision_context_id VARCHAR;
ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND conname='cp_activity_parent_check') THEN
    ALTER TABLE ${table} ADD CONSTRAINT cp_activity_parent_check CHECK(num_nonnulls(${column},supervision_context_id)=1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND conname='cp_activity_supervision_fk') THEN
    ALTER TABLE ${table} ADD CONSTRAINT cp_activity_supervision_fk FOREIGN KEY(school_id,supervision_context_id)
      REFERENCES classpilot_supervision_contexts(school_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND conname='cp_activity_session_fk') THEN
    ALTER TABLE ${table} ADD CONSTRAINT cp_activity_session_fk FOREIGN KEY(school_id,${column}) REFERENCES teaching_sessions(school_id,id);
  END IF;
  IF EXISTS (SELECT 1 FROM ${table} activity
    LEFT JOIN teaching_sessions session ON session.id=activity.${column} AND session.school_id=activity.school_id
    LEFT JOIN classpilot_supervision_contexts context ON context.id=activity.supervision_context_id AND context.school_id=activity.school_id
    WHERE (activity.${column} IS NOT NULL AND session.id IS NULL) OR (activity.supervision_context_id IS NOT NULL AND context.id IS NULL)) THEN
    RAISE EXCEPTION '${table} activity parent verification failed' USING ERRCODE='23514';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ${table}_supervision_idx ON ${table}(school_id,supervision_context_id);`).join("\n")}
CREATE UNIQUE INDEX IF NOT EXISTS session_settings_context_unique ON session_settings(school_id,supervision_context_id) WHERE supervision_context_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS classpilot_hands_context_active_unique ON classpilot_active_hands(school_id,supervision_context_id,student_id) WHERE supervision_context_id IS NOT NULL AND cleared_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS polls_active_context_unique ON polls(school_id,supervision_context_id) WHERE supervision_context_id IS NOT NULL AND is_active=true;
CREATE UNIQUE INDEX IF NOT EXISTS cp_classroom_states_context_active_unique ON classpilot_classroom_states(supervision_context_id,student_id,state_type,state_key) WHERE supervision_context_id IS NOT NULL AND cleared_at IS NULL;
${CLASSPILOT_SCHEDULED_CLASSROOM_GUARDS_SQL}
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM classpilot_chat_deliveries delivery LEFT JOIN chat_messages message
    ON message.id=delivery.chat_message_id AND message.school_id=delivery.school_id AND message.student_id=delivery.student_id
      AND message.session_id IS NOT DISTINCT FROM delivery.teaching_session_id
      AND message.supervision_context_id IS NOT DISTINCT FROM delivery.supervision_context_id
    WHERE message.id IS NULL) THEN RAISE EXCEPTION 'retained chat delivery activity verification failed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM polls poll LEFT JOIN classpilot_commands command ON command.id=poll.start_command_id
    AND command.school_id=poll.school_id AND command.teaching_session_id IS NOT DISTINCT FROM poll.session_id
    AND command.supervision_context_id IS NOT DISTINCT FROM poll.supervision_context_id AND command.teacher_id=poll.teacher_id
    AND command.command_type='poll' AND command.command_payload->>'action'='start'
    WHERE (poll.is_active AND poll.start_command_id IS NULL) OR (poll.start_command_id IS NOT NULL AND command.id IS NULL))
    THEN RAISE EXCEPTION 'retained poll start activity verification failed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM polls poll LEFT JOIN classpilot_commands command ON command.id=poll.close_command_id
    AND command.school_id=poll.school_id AND command.teaching_session_id IS NOT DISTINCT FROM poll.session_id
    AND command.supervision_context_id IS NOT DISTINCT FROM poll.supervision_context_id
    AND command.command_type='poll' AND command.command_payload->>'action'='close'
    WHERE poll.close_command_id IS NOT NULL AND command.id IS NULL)
    THEN RAISE EXCEPTION 'retained poll close activity verification failed' USING ERRCODE='23514'; END IF;
END $$;
`;

export async function ensureClasspilotScheduledClassroomGuards(connection: { query: (sql: string) => Promise<unknown> }) {
  await connection.query(CLASSPILOT_SCHEDULED_CLASSROOM_GUARDS_SQL);
}

export const classpilotScheduledClassroomMigration: SchoolPilotMigration = {
  id: "classpilot-scheduled-classroom-20260915",
  checksum: createHash("sha256").update(CLASSPILOT_SCHEDULED_CLASSROOM_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_SCHEDULED_CLASSROOM_SQL); },
};
