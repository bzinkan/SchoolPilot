import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_TODAY_CONTRACT_MIGRATION_ID = "classpilot-today-conflict-identity-contract-20261031";

/** Additive identities; no legacy session or dated history is rewritten. */
export const CLASSPILOT_TODAY_SCHEDULE_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_today_changes (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES schools(id),
  scheduled_date TEXT NOT NULL,
  timezone_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  generation INTEGER,
  requested_by_user_id TEXT NOT NULL,
  counterpart_teacher_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  review_snapshot JSONB NOT NULL,
  plan_snapshot JSONB NOT NULL,
  affected_group_ids JSONB NOT NULL,
  cutoff_at TIMESTAMPTZ NOT NULL,
  accepted_by_user_id TEXT,
  accepted_at TIMESTAMPTZ,
  applied_by_user_id TEXT,
  applied_at TIMESTAMPTZ,
  terminal_by_user_id TEXT,
  terminal_reason TEXT,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cp_today_changes_school_generation_key UNIQUE(school_id,id,generation,scheduled_date),
  CONSTRAINT cp_today_changes_status_check CHECK(status IN ('pending','applied','declined','cancelled','expired','superseded')),
  CONSTRAINT cp_today_changes_date_check CHECK(scheduled_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT cp_today_changes_revision_check CHECK(revision >= 0 AND (generation IS NULL OR generation > 0)),
  CONSTRAINT cp_today_changes_applied_check CHECK(
    (status <> 'applied' OR (generation IS NOT NULL AND applied_at IS NOT NULL AND applied_by_user_id IS NOT NULL))
    AND (status <> 'pending' OR generation IS NULL)),
  CONSTRAINT cp_today_changes_request_check CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cp_today_changes_snapshots_check CHECK(jsonb_typeof(review_snapshot) = 'object'
    AND jsonb_typeof(plan_snapshot) = 'object' AND jsonb_typeof(affected_group_ids) = 'array'
    AND jsonb_array_length(affected_group_ids) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS cp_today_changes_idempotency_unique ON classpilot_today_changes(school_id,requested_by_user_id,idempotency_key);
CREATE INDEX IF NOT EXISTS cp_today_changes_school_date_status_idx ON classpilot_today_changes(school_id,scheduled_date,status);
CREATE INDEX IF NOT EXISTS cp_today_changes_pending_cutoff_idx ON classpilot_today_changes(cutoff_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS classpilot_today_occurrences (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL,
  change_id VARCHAR NOT NULL,
  scheduled_date TEXT NOT NULL,
  group_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  scheduled_start_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  source JSONB NOT NULL,
  primary_teacher_id_snapshot TEXT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  timezone_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cp_today_occurrences_session_parent_key UNIQUE(school_id,group_id,id),
  CONSTRAINT cp_today_occurrences_change_school_fk FOREIGN KEY(school_id,change_id,generation,scheduled_date)
    REFERENCES classpilot_today_changes(school_id,id,generation,scheduled_date) ON DELETE RESTRICT,
  CONSTRAINT cp_today_occurrences_group_school_fk FOREIGN KEY(school_id,group_id) REFERENCES groups(school_id,id) ON DELETE RESTRICT,
  CONSTRAINT cp_today_occurrences_kind_check CHECK(kind IN ('meeting','suppression')),
  CONSTRAINT cp_today_occurrences_generation_check CHECK(generation > 0),
  CONSTRAINT cp_today_occurrences_window_check CHECK(
    (kind = 'suppression' AND scheduled_start_at IS NULL AND scheduled_end_at IS NULL)
    OR (kind = 'meeting' AND scheduled_start_at IS NOT NULL AND scheduled_end_at IS NOT NULL AND scheduled_end_at > scheduled_start_at)),
  CONSTRAINT cp_today_occurrences_source_check CHECK(jsonb_typeof(source) = 'object')
);
CREATE INDEX IF NOT EXISTS cp_today_occurrences_school_group_date_generation_idx ON classpilot_today_occurrences(school_id,group_id,scheduled_date,generation);
CREATE INDEX IF NOT EXISTS cp_today_occurrences_change_idx ON classpilot_today_occurrences(school_id,change_id);

ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_occurrence_id VARCHAR;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='teaching_sessions_today_occurrence_school_fk' AND conrelid='teaching_sessions'::regclass) THEN
    ALTER TABLE teaching_sessions ADD CONSTRAINT teaching_sessions_today_occurrence_school_fk
      FOREIGN KEY(school_id,group_id,scheduled_occurrence_id) REFERENCES classpilot_today_occurrences(school_id,group_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
-- Rebuild the legacy-only identity in the same transaction, retaining its name.
-- Existing rows have NULL occurrence ids, so all original uniqueness survives.
DROP INDEX IF EXISTS teaching_sessions_scheduled_occurrence_unique;
CREATE UNIQUE INDEX teaching_sessions_scheduled_occurrence_unique
  ON teaching_sessions(school_id,group_id,scheduled_date) WHERE scheduled_date IS NOT NULL AND scheduled_occurrence_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS teaching_sessions_dated_occurrence_unique
  ON teaching_sessions(school_id,scheduled_occurrence_id) WHERE scheduled_occurrence_id IS NOT NULL;

ALTER TABLE classpilot_scheduled_conflicts ADD COLUMN IF NOT EXISTS scheduled_occurrence_id VARCHAR;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='cp_scheduled_conflicts_today_occurrence_school_fk' AND conrelid='classpilot_scheduled_conflicts'::regclass) THEN
    ALTER TABLE classpilot_scheduled_conflicts ADD CONSTRAINT cp_scheduled_conflicts_today_occurrence_school_fk
      FOREIGN KEY(school_id,group_id,scheduled_occurrence_id) REFERENCES classpilot_today_occurrences(school_id,group_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS classpilot_scheduled_conflicts_legacy_unique ON classpilot_scheduled_conflicts(school_id,group_id,scheduled_date,block_start_time)
  WHERE scheduled_occurrence_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cp_scheduled_conflicts_dated_occurrence_unique
  ON classpilot_scheduled_conflicts(school_id,scheduled_occurrence_id) WHERE scheduled_occurrence_id IS NOT NULL;
-- Old serving API/worker upserts still infer this full index. Keep it during
-- expansion; the separately invoked, ledgered contraction removes it only after
-- every old writer has drained. A non-production bootstrap after contraction
-- must never recreate it.
DO $$ BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS classpilot_scheduled_conflicts_unique ON classpilot_scheduled_conflicts(school_id,group_id,scheduled_date,block_start_time);
  ELSIF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE id='${CLASSPILOT_TODAY_CONTRACT_MIGRATION_ID}' AND status='complete') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS classpilot_scheduled_conflicts_unique ON classpilot_scheduled_conflicts(school_id,group_id,scheduled_date,block_start_time);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION cp_today_change_review_immutable() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','revision','generation','accepted_by_user_id','accepted_at','applied_by_user_id','applied_at','terminal_by_user_id','terminal_reason','terminal_at','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','revision','generation','accepted_by_user_id','accepted_at','applied_by_user_id','applied_at','terminal_by_user_id','terminal_reason','terminal_at','updated_at'])
    OR NEW.revision < OLD.revision OR (OLD.generation IS NOT NULL AND NEW.generation IS DISTINCT FROM OLD.generation) THEN
    RAISE EXCEPTION 'Today change reviewed identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cp_today_change_review_immutable ON classpilot_today_changes;
CREATE TRIGGER cp_today_change_review_immutable BEFORE UPDATE ON classpilot_today_changes
  FOR EACH ROW EXECUTE FUNCTION cp_today_change_review_immutable();

CREATE OR REPLACE FUNCTION cp_today_occurrence_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Today occurrence history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cp_today_occurrence_immutable ON classpilot_today_occurrences;
CREATE TRIGGER cp_today_occurrence_immutable BEFORE UPDATE ON classpilot_today_occurrences
  FOR EACH ROW EXECUTE FUNCTION cp_today_occurrence_immutable();

CREATE OR REPLACE FUNCTION cp_today_occurrence_parent_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM classpilot_today_changes c WHERE c.school_id=NEW.school_id AND c.id=NEW.change_id
    AND c.generation=NEW.generation AND c.scheduled_date=NEW.scheduled_date AND c.status='applied'
    AND c.timezone_snapshot=NEW.timezone_snapshot AND c.affected_group_ids ? NEW.group_id) THEN
    RAISE EXCEPTION 'Today occurrence requires its applied reviewed parent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cp_today_occurrence_parent_guard ON classpilot_today_occurrences;
CREATE TRIGGER cp_today_occurrence_parent_guard BEFORE INSERT ON classpilot_today_occurrences
  FOR EACH ROW EXECUTE FUNCTION cp_today_occurrence_parent_guard();

CREATE OR REPLACE FUNCTION cp_today_session_occurrence_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.scheduled_occurrence_id IS DISTINCT FROM NEW.scheduled_occurrence_id THEN
    RAISE EXCEPTION 'Teaching session occurrence identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.scheduled_occurrence_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM classpilot_today_occurrences o WHERE o.school_id=NEW.school_id AND o.group_id=NEW.group_id
      AND o.id=NEW.scheduled_occurrence_id AND o.kind='meeting' AND o.scheduled_date=NEW.scheduled_date
      AND o.timezone_snapshot=NEW.scheduled_timezone AND o.scheduled_start_at=NEW.scheduled_start_at
      AND o.scheduled_end_at=NEW.scheduled_end_at AND o.primary_teacher_id_snapshot=NEW.teacher_id) THEN
    RAISE EXCEPTION 'Teaching session requires its exact dated meeting' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cp_today_session_occurrence_guard ON teaching_sessions;
CREATE TRIGGER cp_today_session_occurrence_guard BEFORE INSERT OR UPDATE ON teaching_sessions
  FOR EACH ROW EXECUTE FUNCTION cp_today_session_occurrence_guard();

CREATE OR REPLACE FUNCTION cp_today_conflict_occurrence_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.scheduled_occurrence_id IS DISTINCT FROM NEW.scheduled_occurrence_id THEN
    RAISE EXCEPTION 'Scheduled conflict occurrence identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.scheduled_occurrence_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM classpilot_today_occurrences o WHERE o.school_id=NEW.school_id AND o.group_id=NEW.group_id
      AND o.id=NEW.scheduled_occurrence_id AND o.kind='meeting' AND o.scheduled_date=NEW.scheduled_date
      AND o.primary_teacher_id_snapshot=NEW.teacher_id
      AND to_char(o.scheduled_start_at AT TIME ZONE o.timezone_snapshot,'HH24:MI')=NEW.block_start_time
      AND to_char(o.scheduled_end_at AT TIME ZONE o.timezone_snapshot,'HH24:MI')=NEW.block_end_time) THEN
    RAISE EXCEPTION 'Scheduled conflict requires its exact dated meeting' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cp_today_conflict_occurrence_guard ON classpilot_scheduled_conflicts;
CREATE TRIGGER cp_today_conflict_occurrence_guard BEFORE INSERT OR UPDATE ON classpilot_scheduled_conflicts
  FOR EACH ROW EXECUTE FUNCTION cp_today_conflict_occurrence_guard();

ALTER TABLE classpilot_today_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_today_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_today_changes;
CREATE POLICY tenant_isolation ON classpilot_today_changes
  USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
  WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
ALTER TABLE classpilot_today_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_today_occurrences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_today_occurrences;
CREATE POLICY tenant_isolation ON classpilot_today_occurrences
  USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
  WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');

DROP TRIGGER IF EXISTS cp_today_changes_boundary_wake ON classpilot_today_changes;
CREATE TRIGGER cp_today_changes_boundary_wake AFTER INSERT OR UPDATE OR DELETE ON classpilot_today_changes
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
DROP TRIGGER IF EXISTS cp_today_occurrences_boundary_wake ON classpilot_today_occurrences;
CREATE TRIGGER cp_today_occurrences_boundary_wake AFTER INSERT OR DELETE ON classpilot_today_occurrences
  FOR EACH ROW EXECUTE FUNCTION cp_wake_schedule_boundary();
`;

export const classpilotTodayScheduleMigration: SchoolPilotMigration = {
  id: "classpilot-today-schedule-20261031",
  checksum: createHash("sha256").update(CLASSPILOT_TODAY_SCHEDULE_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(CLASSPILOT_TODAY_SCHEDULE_SQL); },
};
