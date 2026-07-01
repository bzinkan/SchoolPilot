import pg from "pg";
import {
  isSafeIdentifier,
  parseRlsEnabledTables,
  policySqlFor,
  RLS_GLOBAL_TABLES,
} from "../dist/db/rlsPolicies.js";

const ROLE = process.env.RLS_TEST_ROLE ?? "schoolpilot_rls_test_user";
const PASSWORD = process.env.RLS_TEST_PASSWORD ?? "test";

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function main() {
  if (!isSafeIdentifier(ROLE)) {
    throw new Error(`Unsafe RLS test role name: ${ROLE}`);
  }
  const client = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  await client.connect();
  try {
    const roleIdent = quoteIdentifier(ROLE);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${quoteLiteral(ROLE)}) THEN
          CREATE ROLE ${roleIdent} NOSUPERUSER LOGIN PASSWORD ${quoteLiteral(PASSWORD)};
        ELSE
          ALTER ROLE ${roleIdent} WITH NOSUPERUSER LOGIN PASSWORD ${quoteLiteral(PASSWORD)};
        END IF;
      END $$;
    `);

    const dbName = (await client.query<{ current_database: string }>("SELECT current_database()")).rows[0]!.current_database;
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(dbName)} TO ${roleIdent}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${roleIdent}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleIdent}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleIdent}`);

    await client.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS session_mode TEXT NOT NULL DEFAULT 'live'`);
    await client.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_conflict_id TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS teaching_sessions_session_mode_idx ON teaching_sessions (session_mode)`);
    await client.query(`CREATE INDEX IF NOT EXISTS teaching_sessions_scheduled_conflict_idx ON teaching_sessions (scheduled_conflict_id)`);

    const { rows: cols } = await client.query<{ table_name: string }>(`
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'school_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name
    `);

    const tenantTables = cols
      .map((r) => r.table_name)
      .filter((table) => !RLS_GLOBAL_TABLES.has(table) && isSafeIdentifier(table));
    const allowlist = parseRlsEnabledTables();

    for (const table of tenantTables) {
      for (const statement of policySqlFor(table)) {
        await client.query(statement);
      }
      if (allowlist.has(table)) {
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      } else {
        await client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      }
    }

    const unknown = [...allowlist].filter((table) => !tenantTables.includes(table));
    if (unknown.length > 0) {
      throw new Error(`Unknown RLS_ENABLED_TABLES entries: ${unknown.join(", ")}`);
    }

    console.log(`[rls-ci] enabled ${allowlist.size} tenant tables for ${ROLE}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
