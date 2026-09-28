import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const IMPORT_PROCESSING_STAGES_SQL = `
ALTER TABLE mydesk_imports ADD COLUMN IF NOT EXISTS processing_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mydesk_imports ADD COLUMN IF NOT EXISTS progress_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE student_information_imports ADD COLUMN IF NOT EXISTS processing_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE student_information_imports ADD COLUMN IF NOT EXISTS progress_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mydesk_import_items ADD COLUMN IF NOT EXISTS document_order INTEGER;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='mydesk_import_items_document_order' AND conrelid='mydesk_import_items'::regclass) THEN
    ALTER TABLE mydesk_import_items ADD CONSTRAINT mydesk_import_items_document_order CHECK(document_order IS NULL OR document_order BETWEEN 0 AND 999);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='mydesk_imports_processing_protocol' AND conrelid='mydesk_imports'::regclass) THEN
    ALTER TABLE mydesk_imports ADD CONSTRAINT mydesk_imports_processing_protocol CHECK(processing_version IN (1,2) AND progress_revision>0);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='student_information_imports_processing_protocol' AND conrelid='student_information_imports'::regclass) THEN
    ALTER TABLE student_information_imports ADD CONSTRAINT student_information_imports_processing_protocol CHECK(processing_version IN (1,2) AND progress_revision>0);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS import_processing_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES schools(id), author_id VARCHAR NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, import_id VARCHAR NOT NULL, paperwork_import_id VARCHAR, information_import_id VARCHAR,
  stage_key TEXT NOT NULL, generation INTEGER NOT NULL, provider BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ, lease_id UUID, parent_lease_id UUID, lease_until TIMESTAMPTZ, request_deadline TIMESTAMPTZ,
  last_error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT import_processing_stages_paperwork_fk FOREIGN KEY(school_id,author_id,paperwork_import_id) REFERENCES mydesk_imports(school_id,author_id,id),
  CONSTRAINT import_processing_stages_information_fk FOREIGN KEY(school_id,author_id,information_import_id) REFERENCES student_information_imports(school_id,author_id,id),
  CONSTRAINT import_processing_stages_parent CHECK (
    (kind='paperwork' AND paperwork_import_id IS NOT NULL AND paperwork_import_id=import_id AND information_import_id IS NULL)
    OR (kind='student-information' AND information_import_id IS NOT NULL AND information_import_id=import_id AND paperwork_import_id IS NULL)
  ),
  CONSTRAINT import_processing_stages_bounds CHECK (
    generation>0 AND attempts BETWEEN 0 AND 3 AND char_length(stage_key) BETWEEN 1 AND 200 AND stage_key ~ '^[A-Za-z0-9:_-]+$'
    AND status IN ('queued','running','completed','retry','failed','cancelled')
    AND (last_error_code IS NULL OR last_error_code ~ '^[A-Za-z0-9_]{1,64}$')
    AND ((lease_id IS NULL)=(lease_until IS NULL))
    AND (status<>'running' OR (lease_id IS NOT NULL AND parent_lease_id IS NOT NULL AND request_deadline IS NOT NULL))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS import_processing_stages_identity ON import_processing_stages(school_id,author_id,kind,import_id,stage_key,generation);
CREATE INDEX IF NOT EXISTS import_processing_stages_provider ON import_processing_stages(provider,lease_until);
CREATE INDEX IF NOT EXISTS import_processing_stages_run ON import_processing_stages(school_id,author_id,kind,import_id,status);
ALTER TABLE import_processing_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_processing_stages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON import_processing_stages;
CREATE POLICY tenant_isolation ON import_processing_stages
  USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
  WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
`;

export const importProcessingStagesMigration: SchoolPilotMigration = {
  id: "20260928_import_processing_stages",
  checksum: createHash("sha256").update(IMPORT_PROCESSING_STAGES_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(IMPORT_PROCESSING_STAGES_SQL); },
};
