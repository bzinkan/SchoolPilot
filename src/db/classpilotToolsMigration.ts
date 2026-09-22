import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASS_TOOLS_TABLES = ["classpilot_timers", "classpilot_lesson_activities", "classpilot_lesson_progress", "classpilot_questions", "classpilot_picker_rounds", "classpilot_tool_templates", "classpilot_routine_runs", "classpilot_tool_history"] as const;
const identity = `id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id)`;
const parent = `teaching_session_id VARCHAR, supervision_context_id VARCHAR,
  CHECK(num_nonnulls(teaching_session_id,supervision_context_id)=1),
  FOREIGN KEY(school_id,teaching_session_id) REFERENCES teaching_sessions(school_id,id),
  FOREIGN KEY(school_id,supervision_context_id) REFERENCES classpilot_supervision_contexts(school_id,id)`;
const lifecycle = `revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now(), ended_at TIMESTAMP`;

export const CLASSPILOT_TOOLS_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_timers (${identity}, ${parent}, ${lifecycle},
  start_command_id VARCHAR NOT NULL REFERENCES classpilot_commands(id), message TEXT NOT NULL DEFAULT '' CHECK(length(message)<=500),
  deadline TIMESTAMP, paused_remaining_ms INTEGER CHECK(paused_remaining_ms BETWEEN 0 AND 3600000), expires_at TIMESTAMP NOT NULL,
  CHECK(ended_at IS NOT NULL OR num_nonnulls(deadline,paused_remaining_ms)=1));
CREATE TABLE IF NOT EXISTS classpilot_lesson_activities (${identity}, ${parent}, ${lifecycle},
  start_command_id VARCHAR NOT NULL REFERENCES classpilot_commands(id), title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  instructions TEXT NOT NULL DEFAULT '' CHECK(length(instructions)<=4000), resources JSONB NOT NULL DEFAULT '[]', checklist JSONB NOT NULL DEFAULT '[]', expires_at TIMESTAMP NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS cp_lesson_school_id ON classpilot_lesson_activities(school_id,id);
CREATE TABLE IF NOT EXISTS classpilot_lesson_progress (${identity}, ${parent},
  lesson_activity_id VARCHAR NOT NULL, student_id VARCHAR NOT NULL REFERENCES students(id),
  status TEXT NOT NULL DEFAULT 'not_reported' CHECK(status IN ('not_reported','working','stuck','ready_for_review','finished')),
  completed_item_ids JSONB NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), updated_at TIMESTAMP NOT NULL DEFAULT now(),
  FOREIGN KEY(school_id,lesson_activity_id) REFERENCES classpilot_lesson_activities(school_id,id) ON DELETE CASCADE,
  UNIQUE(school_id,lesson_activity_id,student_id));
CREATE TABLE IF NOT EXISTS classpilot_questions (${identity}, ${parent}, ${lifecycle},
  student_id VARCHAR NOT NULL REFERENCES students(id), client_request_id VARCHAR NOT NULL, question TEXT NOT NULL CHECK(length(question) BETWEEN 1 AND 500),
  group_label TEXT CHECK(length(group_label)<=100), answer TEXT CHECK(length(answer)<=500), UNIQUE(school_id,student_id,client_request_id));
CREATE TABLE IF NOT EXISTS classpilot_picker_rounds (${identity}, ${parent}, ${lifecycle},
  excluded_student_ids JSONB NOT NULL DEFAULT '[]', used_student_ids JSONB NOT NULL DEFAULT '[]', selected_student_id VARCHAR REFERENCES students(id));
CREATE TABLE IF NOT EXISTS classpilot_tool_templates (${identity}, teacher_id VARCHAR NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('attention','poll','exit_ticket','activity','routine')), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  content JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS classpilot_routine_runs (${identity}, ${parent}, ${lifecycle}, teacher_id VARCHAR NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), steps JSONB NOT NULL, current_step INTEGER NOT NULL DEFAULT 0 CHECK(current_step>=0),
  target_student_ids JSONB NOT NULL, outcomes JSONB NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS classpilot_tool_history (${identity}, ${parent}, actor_id VARCHAR NOT NULL, kind TEXT NOT NULL, resource_id VARCHAR NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMP NOT NULL DEFAULT now());
ALTER TABLE session_settings ADD COLUMN IF NOT EXISTS tools_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE classpilot_active_hands ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE classpilot_active_hands ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'assignment';
ALTER TABLE classpilot_active_hands ADD COLUMN IF NOT EXISTS explanation TEXT NOT NULL DEFAULT '';
ALTER TABLE classpilot_active_hands ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP;
ALTER TABLE classpilot_active_hands ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'poll';
ALTER TABLE polls ADD COLUMN IF NOT EXISTS response_type TEXT NOT NULL DEFAULT 'choice';
ALTER TABLE poll_responses ADD COLUMN IF NOT EXISTS text_response TEXT;
ALTER TABLE poll_responses ALTER COLUMN selected_option DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='classpilot_active_hands'::regclass AND conname='cp_help_content') THEN
    ALTER TABLE classpilot_active_hands ADD CONSTRAINT cp_help_content CHECK(status IN ('waiting','acknowledged','helped','withdrawn') AND category IN ('assignment','blocked_website','technical') AND length(explanation)<=500 AND revision>0);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='polls'::regclass AND conname='cp_prompt_type') THEN
    ALTER TABLE polls ADD CONSTRAINT cp_prompt_type CHECK(purpose IN ('poll','exit_ticket','volunteer') AND response_type IN ('choice','short_text'));
    ALTER TABLE poll_responses ADD CONSTRAINT cp_response_content CHECK(num_nonnulls(selected_option,text_response)=1 AND (text_response IS NULL OR length(text_response) BETWEEN 1 AND 500));
  END IF;
END $$;
${["classpilot_timers", "classpilot_lesson_activities", "classpilot_picker_rounds", "classpilot_routine_runs"].map(table => `
CREATE UNIQUE INDEX IF NOT EXISTS ${table}_session_current ON ${table}(school_id,teaching_session_id) WHERE teaching_session_id IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ${table}_context_current ON ${table}(school_id,supervision_context_id) WHERE supervision_context_id IS NOT NULL AND ended_at IS NULL;`).join("\n")}
${CLASS_TOOLS_TABLES.map(table => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table} USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on') WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
${table === "classpilot_tool_templates" ? "" : `DROP TRIGGER IF EXISTS cp_tools_parent ON ${table};
CREATE TRIGGER cp_tools_parent BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION classpilot_validate_activity_parent('teaching_session_id');
CREATE INDEX IF NOT EXISTS ${table}_activity ON ${table}(school_id,teaching_session_id,supervision_context_id);`}`).join("\n")}
CREATE INDEX IF NOT EXISTS cp_tools_history_retention ON classpilot_tool_history(school_id,created_at);
CREATE OR REPLACE FUNCTION classpilot_validate_lesson_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM classpilot_lesson_activities WHERE id=NEW.lesson_activity_id AND school_id=NEW.school_id
    AND teaching_session_id IS NOT DISTINCT FROM NEW.teaching_session_id AND supervision_context_id IS NOT DISTINCT FROM NEW.supervision_context_id) THEN
    RAISE EXCEPTION 'lesson progress parent mismatch' USING ERRCODE='23514';
  END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS cp_lesson_progress_parent ON classpilot_lesson_progress;
CREATE TRIGGER cp_lesson_progress_parent BEFORE INSERT OR UPDATE ON classpilot_lesson_progress FOR EACH ROW EXECUTE FUNCTION classpilot_validate_lesson_progress();
CREATE OR REPLACE FUNCTION classpilot_validate_tool_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE body JSONB:=to_jsonb(NEW); prior JSONB; target_id TEXT; targets JSONB;
BEGIN
  IF TG_OP='UPDATE' THEN
    prior:=to_jsonb(OLD);
    IF body->>'school_id' IS DISTINCT FROM prior->>'school_id'
      OR body->>'teaching_session_id' IS DISTINCT FROM prior->>'teaching_session_id'
      OR body->>'supervision_context_id' IS DISTINCT FROM prior->>'supervision_context_id'
      OR body->>'teacher_id' IS DISTINCT FROM prior->>'teacher_id'
      OR body->>'student_id' IS DISTINCT FROM prior->>'student_id'
      OR body->>'start_command_id' IS DISTINCT FROM prior->>'start_command_id' THEN
      RAISE EXCEPTION 'Class tools ownership is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF body->>'start_command_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM classpilot_commands c
    WHERE c.id=body->>'start_command_id' AND c.school_id=NEW.school_id
      AND c.teaching_session_id IS NOT DISTINCT FROM body->>'teaching_session_id'
      AND c.supervision_context_id IS NOT DISTINCT FROM body->>'supervision_context_id'
      AND c.command_type=CASE WHEN TG_TABLE_NAME='classpilot_timers' THEN 'timer' ELSE 'lesson-activity' END
      AND c.command_payload->>'action'='start') THEN
    RAISE EXCEPTION 'Class tools start command parent mismatch' USING ERRCODE='23514';
  END IF;
  IF body->>'teacher_id' IS NOT NULL AND TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM school_memberships m
    WHERE m.school_id=NEW.school_id AND m.user_id=body->>'teacher_id' AND m.status='active' AND m.role IN ('teacher','admin','school_admin','office_staff')) THEN
    RAISE EXCEPTION 'Class tools teacher must belong to the school' USING ERRCODE='23514';
  END IF;
  targets:=COALESCE(body->'excluded_student_ids','[]') || COALESCE(body->'used_student_ids','[]') || COALESCE(body->'target_student_ids','[]');
  IF body->>'selected_student_id' IS NOT NULL THEN targets:=targets || jsonb_build_array(body->>'selected_student_id'); END IF;
  IF jsonb_typeof(targets)<>'array' OR jsonb_array_length(targets)>2000 THEN RAISE EXCEPTION 'Invalid tool recipients' USING ERRCODE='23514'; END IF;
  FOR target_id IN SELECT jsonb_array_elements_text(targets) LOOP
    IF NOT EXISTS(SELECT 1 FROM students WHERE id=target_id AND school_id=NEW.school_id) THEN
      RAISE EXCEPTION 'Class tools recipient school mismatch' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
${CLASS_TOOLS_TABLES.map(table => `DROP TRIGGER IF EXISTS cp_tools_links ON ${table};
CREATE TRIGGER cp_tools_links BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION classpilot_validate_tool_links();`).join("\n")}
CREATE OR REPLACE FUNCTION classpilot_bump_help_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO session_settings(school_id,session_id,supervision_context_id) VALUES(NEW.school_id,NEW.teaching_session_id,NEW.supervision_context_id) ON CONFLICT DO NOTHING;
  UPDATE session_settings SET tools_revision=tools_revision+1 WHERE school_id=NEW.school_id
    AND session_id IS NOT DISTINCT FROM NEW.teaching_session_id AND supervision_context_id IS NOT DISTINCT FROM NEW.supervision_context_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cp_help_snapshot_revision ON classpilot_active_hands;
CREATE TRIGGER cp_help_snapshot_revision AFTER INSERT OR UPDATE ON classpilot_active_hands FOR EACH ROW EXECUTE FUNCTION classpilot_bump_help_snapshot();
CREATE INDEX IF NOT EXISTS cp_tool_templates_teacher ON classpilot_tool_templates(school_id,teacher_id);
CREATE OR REPLACE FUNCTION classpilot_end_reassigned_routines() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  UPDATE classpilot_routine_runs SET ended_at=now(),updated_at=now(),revision=revision+1
    WHERE school_id=NEW.school_id AND supervision_context_id=NEW.id AND ended_at IS NULL;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cp_tools_reassigned_routines ON classpilot_supervision_contexts;
CREATE TRIGGER cp_tools_reassigned_routines AFTER UPDATE OF assigned_staff_id ON classpilot_supervision_contexts
  FOR EACH ROW WHEN (NEW.assigned_staff_id IS DISTINCT FROM OLD.assigned_staff_id)
  EXECUTE FUNCTION classpilot_end_reassigned_routines();
`;
export const classpilotToolsMigration: SchoolPilotMigration = {
  id: "classpilot-class-tools-expand-20260922", checksum: createHash("sha256").update(CLASSPILOT_TOOLS_SQL).digest("hex"), mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_TOOLS_SQL); },
};
