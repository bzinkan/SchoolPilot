import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

// Append-only expansion. Activation is a one-way per-school writer fence;
// disabling issuance must never make an older queued message deliverable.
export const CLASSPILOT_PRIVATE_CHAT_LIFECYCLE_SQL = `
SET LOCAL lock_timeout = '10s';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS private_chat_epoch INTEGER NOT NULL DEFAULT 1 CHECK (private_chat_epoch > 0);
ALTER TABLE settings ADD COLUMN IF NOT EXISTS private_chat_lifecycle_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE session_settings ADD COLUMN IF NOT EXISTS private_chat_epoch INTEGER NOT NULL DEFAULT 1 CHECK (private_chat_epoch > 0);
CREATE TABLE IF NOT EXISTS classpilot_private_chat_threads (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  teaching_session_id VARCHAR,
  supervision_context_id VARCHAR,
  authority_assignment_id VARCHAR NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cp_private_chat_parent_check CHECK (num_nonnulls(teaching_session_id, supervision_context_id) = 1),
  CONSTRAINT cp_private_chat_student_fk FOREIGN KEY (school_id, student_id) REFERENCES students(school_id,id) ON DELETE CASCADE,
  CONSTRAINT cp_private_chat_session_fk FOREIGN KEY (school_id, teaching_session_id) REFERENCES teaching_sessions(school_id,id) ON DELETE CASCADE,
  CONSTRAINT cp_private_chat_context_fk FOREIGN KEY (school_id, supervision_context_id) REFERENCES classpilot_supervision_contexts(school_id,id) ON DELETE CASCADE,
  CONSTRAINT cp_private_chat_school_id_unique UNIQUE (school_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cp_private_chat_assignment_unique ON classpilot_private_chat_threads
  (school_id,student_id,authority_assignment_id);
CREATE INDEX IF NOT EXISTS cp_private_chat_session_idx ON classpilot_private_chat_threads(school_id,teaching_session_id,student_id);
CREATE INDEX IF NOT EXISTS cp_private_chat_context_idx ON classpilot_private_chat_threads(school_id,supervision_context_id,student_id);
ALTER TABLE classpilot_private_chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_private_chat_threads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_private_chat_threads;
CREATE POLICY tenant_isolation ON classpilot_private_chat_threads
 USING (school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on')
 WITH CHECK (school_id = current_setting('app.school_id',true) OR current_setting('app.is_super',true) = 'on');

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS private_chat_thread_id VARCHAR;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS private_chat_school_epoch INTEGER;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS private_chat_activity_epoch INTEGER;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS private_chat_generation INTEGER;
CREATE INDEX IF NOT EXISTS cp_chat_lifecycle_idx ON chat_messages(school_id,private_chat_thread_id,private_chat_generation);

CREATE OR REPLACE FUNCTION cp_private_chat_settings_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'settings' THEN
   IF OLD.private_chat_lifecycle_required AND NOT NEW.private_chat_lifecycle_required THEN
     RAISE EXCEPTION 'Private chat lifecycle enforcement cannot be rolled back' USING ERRCODE='23514';
   END IF;
   NEW.private_chat_epoch := OLD.private_chat_epoch + CASE WHEN OLD.student_messaging_enabled IS DISTINCT FROM false AND NEW.student_messaging_enabled = false THEN 1 ELSE 0 END;
 ELSE
   NEW.private_chat_epoch := OLD.private_chat_epoch + CASE WHEN OLD.chat_enabled IS DISTINCT FROM false AND NEW.chat_enabled = false THEN 1 ELSE 0 END;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cp_private_chat_settings_epoch ON settings;
CREATE TRIGGER cp_private_chat_settings_epoch BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION cp_private_chat_settings_epoch();
DROP TRIGGER IF EXISTS cp_private_chat_settings_epoch ON session_settings;
CREATE TRIGGER cp_private_chat_settings_epoch BEFORE UPDATE ON session_settings FOR EACH ROW EXECUTE FUNCTION cp_private_chat_settings_epoch();

CREATE OR REPLACE FUNCTION cp_private_chat_thread_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.school_id,NEW.student_id,NEW.teaching_session_id,NEW.supervision_context_id,NEW.authority_assignment_id)
   IS DISTINCT FROM (OLD.school_id,OLD.student_id,OLD.teaching_session_id,OLD.supervision_context_id,OLD.authority_assignment_id) THEN
   RAISE EXCEPTION 'Private chat thread authority is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW.generation < OLD.generation OR NEW.generation > OLD.generation + 1) THEN
   RAISE EXCEPTION 'Private chat generation must advance monotonically' USING ERRCODE='23514';
 END IF;
 IF NEW.teaching_session_id IS NOT NULL THEN
   IF NOT EXISTS (SELECT 1 FROM classpilot_session_students a WHERE a.school_id=NEW.school_id AND a.id=NEW.authority_assignment_id
     AND a.student_id=NEW.student_id AND a.teaching_session_id=NEW.teaching_session_id) THEN
     RAISE EXCEPTION 'Private chat assignment mismatch' USING ERRCODE='23514';
   END IF;
 ELSE
   IF NOT EXISTS (SELECT 1 FROM classpilot_supervision_students a WHERE a.school_id=NEW.school_id AND a.id=NEW.authority_assignment_id
     AND a.student_id=NEW.student_id AND a.context_id=NEW.supervision_context_id AND a.released_at IS NULL) THEN
     RAISE EXCEPTION 'Private chat assignment mismatch' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cp_private_chat_thread_parent ON classpilot_private_chat_threads;
CREATE TRIGGER cp_private_chat_thread_parent BEFORE INSERT OR UPDATE ON classpilot_private_chat_threads
 FOR EACH ROW EXECUTE FUNCTION cp_private_chat_thread_parent();

CREATE OR REPLACE FUNCTION cp_private_chat_message_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required BOOLEAN; valid BOOLEAN;
BEGIN
 IF TG_OP = 'UPDATE' THEN
   IF (NEW.private_chat_thread_id,NEW.private_chat_school_epoch,NEW.private_chat_activity_epoch,NEW.private_chat_generation)
     IS DISTINCT FROM (OLD.private_chat_thread_id,OLD.private_chat_school_epoch,OLD.private_chat_activity_epoch,OLD.private_chat_generation) THEN
     RAISE EXCEPTION 'Private chat message lifecycle is immutable' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 SELECT private_chat_lifecycle_required INTO required FROM settings WHERE school_id=NEW.school_id FOR SHARE;
 IF NEW.private_chat_thread_id IS NULL THEN
   IF COALESCE(required,false) AND NEW.student_id IS NOT NULL THEN
     RAISE EXCEPTION 'Private chat writer requires lifecycle metadata' USING ERRCODE='23514';
   END IF;
   IF num_nonnulls(NEW.private_chat_school_epoch,NEW.private_chat_activity_epoch,NEW.private_chat_generation) <> 0 THEN
     RAISE EXCEPTION 'Incomplete private chat lifecycle' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 PERFORM 1 FROM session_settings a WHERE a.school_id=NEW.school_id
   AND a.session_id IS NOT DISTINCT FROM NEW.session_id AND a.supervision_context_id IS NOT DISTINCT FROM NEW.supervision_context_id FOR SHARE;
 PERFORM 1 FROM classpilot_private_chat_threads t WHERE t.school_id=NEW.school_id AND t.id=NEW.private_chat_thread_id FOR SHARE;
 SELECT EXISTS (SELECT 1 FROM classpilot_private_chat_threads t JOIN settings s ON s.school_id=t.school_id
   JOIN session_settings a ON a.school_id=t.school_id AND a.session_id IS NOT DISTINCT FROM t.teaching_session_id
     AND a.supervision_context_id IS NOT DISTINCT FROM t.supervision_context_id
   WHERE t.id=NEW.private_chat_thread_id AND t.school_id=NEW.school_id AND t.student_id=NEW.student_id
     AND t.teaching_session_id IS NOT DISTINCT FROM NEW.session_id AND t.supervision_context_id IS NOT DISTINCT FROM NEW.supervision_context_id
     AND t.generation=NEW.private_chat_generation AND s.private_chat_epoch=NEW.private_chat_school_epoch
     AND a.private_chat_epoch=NEW.private_chat_activity_epoch AND s.student_messaging_enabled IS DISTINCT FROM false
     AND a.chat_enabled IS DISTINCT FROM false
     AND (t.teaching_session_id IS NOT NULL OR EXISTS (
       SELECT 1 FROM classpilot_supervision_students assignment WHERE assignment.school_id=t.school_id
         AND assignment.id=t.authority_assignment_id AND assignment.student_id=t.student_id
         AND assignment.context_id=t.supervision_context_id AND assignment.released_at IS NULL))) INTO valid;
 IF NOT valid THEN RAISE EXCEPTION 'Private chat lifecycle is stale' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cp_private_chat_message_lifecycle ON chat_messages;
CREATE TRIGGER cp_private_chat_message_lifecycle BEFORE INSERT OR UPDATE ON chat_messages
 FOR EACH ROW EXECUTE FUNCTION cp_private_chat_message_lifecycle();
`;

export const classpilotPrivateChatLifecycleMigration: SchoolPilotMigration = {
  id: "classpilot-private-chat-lifecycle-20261002",
  checksum: createHash("sha256").update(CLASSPILOT_PRIVATE_CHAT_LIFECYCLE_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_PRIVATE_CHAT_LIFECYCLE_SQL); },
};
