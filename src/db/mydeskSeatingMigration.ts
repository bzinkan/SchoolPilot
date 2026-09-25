import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const MYDESK_SEATING_SQL = `
CREATE TABLE IF NOT EXISTS mydesk_seating_charts (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(), school_id TEXT NOT NULL REFERENCES schools(id),
  author_id VARCHAR NOT NULL REFERENCES users(id), client_request_id UUID NOT NULL,
  request_fingerprint TEXT NOT NULL CONSTRAINT mydesk_seating_charts_fingerprint CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  group_id VARCHAR, filing_group_id VARCHAR NOT NULL, group_name TEXT NOT NULL, name TEXT NOT NULL,
  layout JSONB NOT NULL DEFAULT '{"version":1,"seats":[]}'::jsonb,
  roster_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb, roster_revision TEXT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT false,
  revision INTEGER NOT NULL DEFAULT 1 CONSTRAINT mydesk_seating_charts_revision CHECK(revision > 0),
  mutation_receipts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
  CONSTRAINT mydesk_seating_charts_layout CHECK(jsonb_typeof(layout)='object' AND (layout->'version'='1'::jsonb) IS TRUE AND CASE WHEN jsonb_typeof(layout->'seats')='array' THEN jsonb_array_length(layout->'seats')<=100 ELSE false END),
  CONSTRAINT mydesk_seating_charts_name CHECK(deleted_at IS NOT NULL OR char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT mydesk_seating_charts_group_name CHECK(char_length(group_name)<=500),
  CONSTRAINT mydesk_seating_charts_roster_revision CHECK(deleted_at IS NOT NULL OR roster_revision ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mydesk_seating_charts_roster CHECK(octet_length(roster_snapshot::text)<=1048576 AND CASE WHEN jsonb_typeof(roster_snapshot)='array' THEN jsonb_array_length(roster_snapshot)<=1000 ELSE false END),
  CONSTRAINT mydesk_seating_charts_receipts CHECK(CASE WHEN jsonb_typeof(mutation_receipts)='array' THEN jsonb_array_length(mutation_receipts)<=100 ELSE false END),
  CONSTRAINT mydesk_seating_charts_deleted CHECK(deleted_at IS NULL OR (NOT is_current AND group_id IS NULL AND name='' AND group_name='' AND roster_revision='' AND layout='{"version":1,"seats":[]}'::jsonb AND roster_snapshot='[]'::jsonb)),
  CONSTRAINT mydesk_seating_charts_group_fk FOREIGN KEY(school_id,group_id) REFERENCES groups(school_id,id) ON DELETE SET NULL (group_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_seating_charts_request ON mydesk_seating_charts(school_id,author_id,client_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS mydesk_seating_charts_current ON mydesk_seating_charts(school_id,author_id,filing_group_id) WHERE is_current AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS mydesk_seating_charts_owner_class ON mydesk_seating_charts(school_id,author_id,filing_group_id,updated_at DESC,id) WHERE deleted_at IS NULL;
-- Drizzle's bootstrap cannot express the column-specific SET NULL action.
ALTER TABLE mydesk_seating_charts DROP CONSTRAINT IF EXISTS mydesk_seating_charts_group_fk;
ALTER TABLE mydesk_seating_charts ADD CONSTRAINT mydesk_seating_charts_group_fk
  FOREIGN KEY(school_id,group_id) REFERENCES groups(school_id,id) ON DELETE SET NULL (group_id);
CREATE OR REPLACE FUNCTION check_mydesk_seating_author_school() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_memberships WHERE school_id=NEW.school_id AND user_id=NEW.author_id) THEN
    RAISE EXCEPTION 'My Desk seating author must belong to the same school' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mydesk_seating_charts_author_school ON mydesk_seating_charts;
CREATE TRIGGER mydesk_seating_charts_author_school BEFORE INSERT OR UPDATE OF school_id,author_id ON mydesk_seating_charts
  FOR EACH ROW EXECUTE FUNCTION check_mydesk_seating_author_school();
ALTER TABLE mydesk_seating_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mydesk_seating_charts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mydesk_seating_charts;
CREATE POLICY tenant_isolation ON mydesk_seating_charts
  USING(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')
  WITH CHECK(school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on');
`;

export const mydeskSeatingMigration: SchoolPilotMigration = {
  id: "mydesk-private-seating-20260925", checksum: createHash("sha256").update(MYDESK_SEATING_SQL).digest("hex"),
  mode: "transactional", apply: async connection => { await connection.query(MYDESK_SEATING_SQL); },
};
