import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_SCHEDULING_TENANT_TABLES = ["classpilot_school_schedules"] as const;
export const CLASSPILOT_SCHEDULING_SQL = `
ALTER TABLE groups ADD COLUMN IF NOT EXISTS schedule_rule JSONB;
CREATE TABLE IF NOT EXISTS classpilot_school_schedules (
  school_id TEXT PRIMARY KEY REFERENCES schools(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
ALTER TABLE classpilot_school_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_school_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_school_schedules;
CREATE POLICY tenant_isolation ON classpilot_school_schedules
  USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
  WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');
`;
export const classpilotSchedulingMigration: SchoolPilotMigration = {
  id: "classpilot-scheduling-20260905",
  checksum: createHash("sha256").update(CLASSPILOT_SCHEDULING_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_SCHEDULING_SQL); },
};
