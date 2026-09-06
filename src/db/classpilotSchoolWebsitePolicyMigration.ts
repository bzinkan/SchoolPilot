import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_SCHOOL_WEBSITE_POLICY_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_school_website_policies (
 school_id TEXT PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT
);
CREATE TABLE IF NOT EXISTS classpilot_school_website_deliveries (
 id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
 school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
 student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
 student_session_id TEXT NOT NULL REFERENCES student_sessions(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','failed')),
 closed_tab_count INTEGER NOT NULL DEFAULT 0 CHECK (closed_tab_count BETWEEN 0 AND 1000),
 error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), acknowledged_at TIMESTAMPTZ
);
-- Drizzle/stub-table bootstrap must converge to the same constraints as an upgrade.
${[
 ["classpilot_school_website_policies","classpilot_school_website_policies_school_id_fkey","FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE"],
 ["classpilot_school_website_policies","classpilot_school_website_policies_revision_check","CHECK (revision >= 0)"],
 ["classpilot_school_website_deliveries","classpilot_school_website_deliveries_school_id_fkey","FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE"],
 ["classpilot_school_website_deliveries","classpilot_school_website_deliveries_student_id_fkey","FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE"],
 ["classpilot_school_website_deliveries","classpilot_school_website_deliveries_student_session_id_fkey","FOREIGN KEY (student_session_id) REFERENCES student_sessions(id) ON DELETE CASCADE"],
 ["classpilot_school_website_deliveries","classpilot_school_website_deliveries_policy_revision_check","CHECK (policy_revision >= 0)"],
 ["classpilot_school_website_deliveries","classpilot_school_website_deliveries_status_check","CHECK (status IN ('pending','applied','failed'))"],
 ["classpilot_school_website_deliveries","classpilot_school_website_deliveries_closed_tab_count_check","CHECK (closed_tab_count BETWEEN 0 AND 1000)"],
].map(([table,name,definition])=>`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='${table}'::regclass AND conname='${name}') THEN ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition}; END IF; END $$;`).join("\n")}
CREATE UNIQUE INDEX IF NOT EXISTS cp_school_website_delivery_exact_idx
 ON classpilot_school_website_deliveries (school_id, policy_revision, student_session_id);
CREATE INDEX IF NOT EXISTS cp_school_website_delivery_status_idx
 ON classpilot_school_website_deliveries (school_id, policy_revision, status);
CREATE OR REPLACE FUNCTION validate_school_website_delivery_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM student_sessions s JOIN students p ON p.id=s.student_id
   WHERE s.id=NEW.student_session_id AND p.school_id=NEW.school_id
   AND s.student_id=NEW.student_id AND s.device_id=NEW.device_id)
 THEN RAISE EXCEPTION 'Invalid school website delivery binding' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS school_website_delivery_binding ON classpilot_school_website_deliveries;
CREATE TRIGGER school_website_delivery_binding BEFORE INSERT OR UPDATE ON classpilot_school_website_deliveries
 FOR EACH ROW EXECUTE FUNCTION validate_school_website_delivery_binding();
${["classpilot_school_website_policies", "classpilot_school_website_deliveries"].map((table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table}
 USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')
 WITH CHECK (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on');`).join("\n")}
`;
export const classpilotSchoolWebsitePolicyMigration: SchoolPilotMigration = {
  id: "classpilot-school-website-policy-20260905", mode: "transactional",
  checksum: createHash("sha256").update(CLASSPILOT_SCHOOL_WEBSITE_POLICY_SQL).digest("hex"),
  apply: async (connection) => { await connection.query(CLASSPILOT_SCHOOL_WEBSITE_POLICY_SQL); },
};
