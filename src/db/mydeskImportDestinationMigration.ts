import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const MYDESK_IMPORT_DESTINATION_SQL = `
ALTER TABLE mydesk_imports ADD COLUMN IF NOT EXISTS destination TEXT NOT NULL DEFAULT 'notes';
ALTER TABLE mydesk_import_items ADD COLUMN IF NOT EXISTS discipline_fields JSONB;
ALTER TABLE mydesk_import_items ADD COLUMN IF NOT EXISTS duplicate_decision JSONB;
ALTER TABLE mydesk_import_items ADD COLUMN IF NOT EXISTS discipline_record_id VARCHAR;
ALTER TABLE mydesk_imports DROP CONSTRAINT IF EXISTS mydesk_import_destination;
ALTER TABLE mydesk_imports ADD CONSTRAINT mydesk_import_destination CHECK(destination IN ('notes','discipline'));
ALTER TABLE mydesk_import_items DROP CONSTRAINT IF EXISTS mydesk_import_discipline_bounds;
ALTER TABLE mydesk_import_items ADD CONSTRAINT mydesk_import_discipline_bounds CHECK(
  (discipline_fields IS NULL OR (jsonb_typeof(discipline_fields)='object' AND octet_length(discipline_fields::text)<=8192))
  AND (duplicate_decision IS NULL OR (jsonb_typeof(duplicate_decision)='object' AND octet_length(duplicate_decision::text)<=4096))
  AND (discipline_record_id IS NULL OR char_length(discipline_record_id) BETWEEN 1 AND 128));
CREATE OR REPLACE FUNCTION preserve_mydesk_import_destination() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.destination IS DISTINCT FROM OLD.destination THEN
    RAISE EXCEPTION 'An import destination cannot change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mydesk_import_destination_immutable ON mydesk_imports;
CREATE TRIGGER mydesk_import_destination_immutable BEFORE UPDATE OF destination ON mydesk_imports
  FOR EACH ROW EXECUTE FUNCTION preserve_mydesk_import_destination();
`;

export const mydeskImportDestinationMigration: SchoolPilotMigration = {
  id: "mydesk-import-destination-20260928",
  checksum: createHash("sha256").update(MYDESK_IMPORT_DESTINATION_SQL).digest("hex"),
  mode: "transactional", apply: async connection => { await connection.query(MYDESK_IMPORT_DESTINATION_SQL); },
};
