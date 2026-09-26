import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/** Additive compatibility expansion only. Existing v1 documents and deletion tombstones are unchanged. */
export const MYDESK_SEATING_MEASURED_SQL = `
ALTER TABLE mydesk_seating_charts DROP CONSTRAINT IF EXISTS mydesk_seating_charts_layout;
ALTER TABLE mydesk_seating_charts ADD CONSTRAINT mydesk_seating_charts_layout CHECK (
  jsonb_typeof(layout) = 'object' AND octet_length(layout::text) <= 262144
  AND (layout->'version' IN ('1'::jsonb, '2'::jsonb)) IS TRUE
  AND CASE WHEN jsonb_typeof(layout->'seats') = 'array' THEN jsonb_array_length(layout->'seats') <= 100 ELSE false END
  AND (layout->'version' = '1'::jsonb OR (
    layout->>'units' = 'mm' AND layout->>'displayUnit' IN ('imperial','metric')
    AND CASE WHEN jsonb_typeof(layout->'room'->'vertices') = 'array' THEN jsonb_array_length(layout->'room'->'vertices') BETWEEN 3 AND 24 ELSE false END
    AND CASE WHEN jsonb_typeof(layout->'features') = 'array' THEN jsonb_array_length(layout->'features') <= 100 ELSE false END
  )) IS TRUE
);
`;

export const mydeskSeatingMeasuredMigration: SchoolPilotMigration = {
  id: "mydesk-measured-seating-20260926",
  checksum: createHash("sha256").update(MYDESK_SEATING_MEASURED_SQL).digest("hex"),
  mode: "transactional",
  apply: async connection => { await connection.query(MYDESK_SEATING_MEASURED_SQL); },
};
