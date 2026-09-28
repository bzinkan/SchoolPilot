import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * Microsoft Entra ID staff sign-in. Additive and off by default: no school
 * accepts Microsoft sign-in until a super admin records its tenant ID and
 * turns it on. `schools` and `users` are global tables (no RLS registry).
 */
export const MICROSOFT_SIGN_IN_EXPAND_SQL = `
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS microsoft_sign_in_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS microsoft_tenant_id TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS microsoft_id TEXT;

DO $microsoft_sign_in_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schools_microsoft_tenant_id_check'
      AND conrelid = 'schools'::regclass
  ) THEN
    ALTER TABLE schools
      ADD CONSTRAINT schools_microsoft_tenant_id_check
      CHECK (
        microsoft_tenant_id IS NULL
        OR microsoft_tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schools_microsoft_sign_in_tenant_check'
      AND conrelid = 'schools'::regclass
  ) THEN
    ALTER TABLE schools
      ADD CONSTRAINT schools_microsoft_sign_in_tenant_check
      CHECK (NOT microsoft_sign_in_enabled OR microsoft_tenant_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_microsoft_id_unique'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_microsoft_id_unique UNIQUE (microsoft_id);
  END IF;
END;
$microsoft_sign_in_constraints$;
`;

export const microsoftSignInMigration: SchoolPilotMigration = {
  id: "20260929_microsoft_sign_in_expand",
  checksum: createHash("sha256").update(MICROSOFT_SIGN_IN_EXPAND_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(MICROSOFT_SIGN_IN_EXPAND_SQL); },
};
