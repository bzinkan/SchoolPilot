import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_WINDOWS_HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS classpilot_windows_browser_events (
 id text PRIMARY KEY,school_id text NOT NULL REFERENCES schools(id),student_id text NOT NULL,browser_id text NOT NULL,
 source_ref text NOT NULL,binding_revision integer NOT NULL,observation_id text NOT NULL,sequence bigint NOT NULL,
 observed_at timestamptz NOT NULL,usage_ends_at timestamptz NOT NULL,browser_focused boolean NOT NULL,
 active_tab_url text NOT NULL,active_tab_title text NOT NULL,teaching_session_id text,supervision_context_id text,
 CONSTRAINT cp_windows_event_browser_fk FOREIGN KEY(school_id,browser_id,student_id) REFERENCES classpilot_windows_browsers(school_id,id,student_id),
 CONSTRAINT cp_windows_event_identity_unique UNIQUE(browser_id,observation_id),
 CONSTRAINT cp_windows_event_sequence_unique UNIQUE(browser_id,sequence),
 CONSTRAINT cp_windows_event_bounds_check CHECK(sequence>0 AND binding_revision>0 AND usage_ends_at>=observed_at AND usage_ends_at<=observed_at+interval '10 seconds'),
 CONSTRAINT cp_windows_event_context_check CHECK(num_nonnulls(teaching_session_id,supervision_context_id)<=1),
 CONSTRAINT cp_windows_event_text_check CHECK(length(active_tab_url)<=4096 AND length(active_tab_title)<=512)
);
ALTER TABLE classpilot_windows_browser_events ADD COLUMN IF NOT EXISTS classification jsonb;
ALTER TABLE classpilot_windows_browser_events DROP CONSTRAINT IF EXISTS cp_windows_event_context_check;
ALTER TABLE classpilot_windows_browser_events ADD CONSTRAINT cp_windows_event_context_check CHECK(num_nonnulls(teaching_session_id,supervision_context_id)<=1);
CREATE INDEX IF NOT EXISTS cp_windows_event_history_idx ON classpilot_windows_browser_events(school_id,student_id,source_ref,binding_revision,observed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS cp_windows_event_usage_idx ON classpilot_windows_browser_events(school_id,student_id,observed_at);
ALTER TABLE classpilot_windows_browser_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE classpilot_windows_browser_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classpilot_windows_browser_events;
CREATE POLICY tenant_isolation ON classpilot_windows_browser_events
 USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
 WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
`;
export const classpilotWindowsHistoryMigration:SchoolPilotMigration={id:"classpilot-windows-history-20261028",checksum:createHash("sha256").update(CLASSPILOT_WINDOWS_HISTORY_SQL).digest("hex"),mode:"transactional",apply:async connection=>{await connection.query(CLASSPILOT_WINDOWS_HISTORY_SQL);}};
