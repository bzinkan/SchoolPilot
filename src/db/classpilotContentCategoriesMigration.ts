import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";
export const CLASSPILOT_CONTENT_CATEGORIES_SQL = `
ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS content_category TEXT;
ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS teacher_intent_source TEXT;
ALTER TABLE classpilot_ai_decisions ADD COLUMN IF NOT EXISTS content_category TEXT;
ALTER TABLE classpilot_session_student_reports ADD COLUMN IF NOT EXISTS off_task_categories JSONB NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='heartbeats_content_category_values') THEN
  ALTER TABLE heartbeats ADD CONSTRAINT heartbeats_content_category_values CHECK(content_category IS NULL OR content_category IN
  ('Gaming','Social media','Video','Music','Messaging','Forums','Shopping','Sports','News','Entertainment','AI tools','Finance','Travel','Lifestyle','Technology','Health','Education','Reference','Productivity','Gambling')) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_decisions_content_category_values') THEN
  ALTER TABLE classpilot_ai_decisions ADD CONSTRAINT ai_decisions_content_category_values CHECK(content_category IS NULL OR content_category IN
  ('Gaming','Social media','Video','Music','Messaging','Forums','Shopping','Sports','News','Entertainment','AI tools','Finance','Travel','Lifestyle','Technology','Health','Education','Reference','Productivity','Gambling')) NOT VALID;
 END IF;
END $$;
`;
export const classpilotContentCategoriesMigration: SchoolPilotMigration = {
  id: "classpilot-content-categories-20260905", mode: "transactional",
  checksum: createHash("sha256").update(CLASSPILOT_CONTENT_CATEGORIES_SQL).digest("hex"),
  apply: async (connection) => { await connection.query(CLASSPILOT_CONTENT_CATEGORIES_SQL); },
};
