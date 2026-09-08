import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_COVERAGE_CATEGORIES_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_coverage_group_categories (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id TEXT NOT NULL REFERENCES schools(id),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS classpilot_coverage_categories_school_id_unique ON classpilot_coverage_group_categories(school_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS classpilot_coverage_categories_name_unique ON classpilot_coverage_group_categories(school_id,lower(btrim(name)));
ALTER TABLE classpilot_coverage_scope_groups ADD COLUMN IF NOT EXISTS category_id VARCHAR;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='classpilot_coverage_groups_category_school_fk' AND conrelid='classpilot_coverage_scope_groups'::regclass) THEN
    ALTER TABLE classpilot_coverage_scope_groups ADD CONSTRAINT classpilot_coverage_groups_category_school_fk
      FOREIGN KEY(school_id,category_id) REFERENCES classpilot_coverage_group_categories(school_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS classpilot_coverage_groups_category_idx ON classpilot_coverage_scope_groups(school_id,category_id);
ALTER TABLE classpilot_coverage_group_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_coverage_group_categories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_coverage_group_categories;
CREATE POLICY tenant_isolation ON classpilot_coverage_group_categories
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');
`;
export const classpilotCoverageCategoriesMigration: SchoolPilotMigration = {
  id: "classpilot-coverage-categories-20260908",
  checksum: createHash("sha256").update(CLASSPILOT_COVERAGE_CATEGORIES_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_COVERAGE_CATEGORIES_SQL); },
};
