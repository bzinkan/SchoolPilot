import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { mydeskMigration } from "./mydeskMigration.js";
import { mydeskSeatingMigration } from "./mydeskSeatingMigration.js";
import { mydeskImportsMigration } from "./mydeskImportsMigration.js";
import { RLS_REVIEWED_ENABLEMENT_REQUESTS } from "./rlsPolicies.js";
import { hasCanonicalTenantPolicy, readRlsCatalog, readRlsDatabaseRole } from "./rlsEnforcement.js";

const migrations = [mydeskMigration, mydeskSeatingMigration, mydeskImportsMigration];
const tables = RLS_REVIEWED_ENABLEMENT_REQUESTS.mydeskReconciliation!;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Inventory only: no schema changes, ledger repair, content, names or storage
 * keys. A dedicated READ ONLY snapshot prevents accidental writes and keeps
 * cross-school aggregate counts consistent. Catalog definitions are hashed so
 * even unexpected SQL literals cannot disclose private values in the report.
 */
export async function inspectMyDeskReadiness(connection: Pick<PoolClient, "query">) {
  await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await connection.query("SET LOCAL statement_timeout = '15s'");
    await connection.query("SET LOCAL lock_timeout = '2s'");
    await connection.query("SELECT set_config('app.is_super', 'on', true)");
    const role = await readRlsDatabaseRole(connection);
    const catalog = await readRlsCatalog(connection, tables);
    const ledgerExists = (await connection.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    )).rows[0]?.present === true;
    const ledger = ledgerExists ? (await connection.query<{
      id: string; checksum: string; status: string;
    }>("SELECT id, checksum, status FROM public.schema_migrations WHERE id = ANY($1::text[])",
      [migrations.map((migration) => migration.id)])).rows : [];
    const constraints = (await connection.query<{
      tableName: string; name: string; type: string; validated: boolean;
      definition: string; deleteAction: string; deleteColumns: string[] | null;
    }>(`
      SELECT relation.relname AS "tableName", constraint_row.conname AS name,
        constraint_row.contype AS type, constraint_row.convalidated AS validated,
        pg_get_constraintdef(constraint_row.oid, true) AS definition,
        constraint_row.confdeltype AS "deleteAction",
        ARRAY(SELECT attribute.attname FROM unnest(constraint_row.confdelsetcols) AS column_id
          JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
            AND attribute.attnum = column_id) AS "deleteColumns"
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname, constraint_row.conname
    `, [tables])).rows;
    const indexes = (await connection.query<{
      tableName: string; name: string; valid: boolean; ready: boolean; definition: string;
    }>(`
      SELECT relation.relname AS "tableName", index_relation.relname AS name,
        index_row.indisvalid AS valid, index_row.indisready AS ready,
        pg_get_indexdef(index_row.indexrelid) AS definition
      FROM pg_index index_row
      JOIN pg_class relation ON relation.oid = index_row.indrelid
      JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
      ORDER BY relation.relname, index_relation.relname
    `, [tables])).rows;
    const columns = (await connection.query<{
      tableName: string; name: string; type: string; nullable: boolean;
    }>(`
      SELECT table_name AS "tableName", column_name AS name, udt_name AS type,
        is_nullable = 'YES' AS nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `, [tables])).rows;
    const counts: Record<string, { total: string; byState: Record<string, string> }> = {};
    const states: Record<string, string[]> = {
      mydesk_notes: ["pending", "active", "deleted"],
      mydesk_attachments: ["pending", "uploading", "ready", "delete_pending", "deleted"],
      mydesk_imports: ["uploading", "queued", "processing", "review", "failed", "completed", "cancelled", "expired"],
      mydesk_import_items: ["pending", "ready", "failed"],
      mydesk_import_assets: ["pending", "uploading", "ready", "delete_pending", "deleted", "promoted"],
    };
    for (const table of tables) {
      if (!catalog.some((entry) => entry.tableName === table)) continue;
      // Identifiers come exclusively from the frozen reviewed registry. State
      // values come from this fixed list, never from teacher-authored content.
      const stateNames = states[table];
      const stateColumn = table === "mydesk_import_items" ? "extraction_status" : "status";
      const filters = stateNames
        ? stateNames.map((_, index) => `count(*) FILTER (WHERE ${stateColumn} = $${index + 1})::text AS state_${index}`)
        : ["count(*) FILTER (WHERE deleted_at IS NULL)::text AS state_0", "count(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS state_1"];
      const row = (await connection.query<Record<string, string>>(
        `SELECT count(*)::text AS total, ${filters.join(", ")} FROM public.${table}`,
        stateNames,
      )).rows[0]!;
      counts[table] = {
        total: row.total!,
        byState: Object.fromEntries((stateNames ?? ["active", "deleted"]).map((state, index) => [state, row[`state_${index}`]!])),
      };
    }
    const report = {
      version: 1,
      mode: "read_only_inventory" as const,
      // This is not a runtime/storage/provider readiness or deployment approval.
      requiresConstraintReview: true,
      role,
      ledger: migrations.map((migration) => {
        const row = ledger.find((entry) => entry.id === migration.id);
        return {
          id: migration.id,
          expectedChecksum: migration.checksum,
          checksumMatches: row?.checksum === migration.checksum,
          status: row && ["running", "complete", "failed"].includes(row.status) ? row.status : row ? "unknown" : "missing",
        };
      }),
      tables: tables.map((table) => {
        const entry = catalog.find((candidate) => candidate.tableName === table);
        return { name: table, present: Boolean(entry), enabled: entry?.enabled ?? false,
          forced: entry?.forced ?? false, canonicalPolicy: entry ? hasCanonicalTenantPolicy(entry) : false,
          policyCount: entry?.policies.length ?? 0, counts: counts[table] ?? null };
      }),
      columns,
      constraints: constraints.map(({ definition, ...constraint }) => ({ ...constraint, definitionSha256: hash(definition) })),
      indexes: indexes.map(({ definition, ...index }) => ({ ...index, definitionSha256: hash(definition) })),
    };
    await connection.query("COMMIT");
    return report;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
