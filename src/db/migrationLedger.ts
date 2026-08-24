import type { Pool, PoolClient } from "pg";

export type SchoolPilotMigrationMode = "transactional" | "nontransactional";

export type SchoolPilotMigration = {
  id: string;
  checksum: string;
  mode: SchoolPilotMigrationMode;
  apply: (connection: Pick<Pool, "query"> | Pick<PoolClient, "query">) => Promise<void>;
};

export type SchoolPilotMigrationResult = {
  id: string;
  status: "applied" | "skipped";
  durationMs: number;
};

const MIGRATION_LOCK_KEY = 2_070_082_200;

function safeApplicationSha(value: string | undefined): string {
  const candidate = String(value || "unknown").trim();
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(candidate) ? candidate : "unknown";
}
function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code || "");
    if (/^[A-Z0-9_]{1,32}$/i.test(code)) return code;
  }
  return "MIGRATION_FAILED";
}

async function ensureMigrationLedger(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      application_sha TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      duration_ms BIGINT,
      error_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT schema_migrations_mode_check
        CHECK (mode IN ('transactional', 'nontransactional')),
      CONSTRAINT schema_migrations_status_check
        CHECK (status IN ('running', 'complete', 'failed')),
      CONSTRAINT schema_migrations_checksum_check
        CHECK (checksum ~ '^[0-9a-f]{64}$')
    )
  `);
}

/**
 * Read a durable phase marker before choosing a staged migration manifest.
 * Once a contract migration is complete, later one-off tasks must retain it
 * so its checksum and every later dependency remain monotonic.
 */
export async function hasCompletedSchoolPilotMigration(
  pool: Pool,
  migrationIds: readonly string[]
): Promise<boolean> {
  if (migrationIds.length === 0) return false;
  await ensureMigrationLedger(pool);
  const result = await pool.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM schema_migrations
      WHERE id = ANY($1::text[])
        AND status = 'complete'
    ) AS present
  `, [migrationIds]);
  return result.rows[0]?.present === true;
}

async function runOneMigration(
  pool: Pool,
  migration: SchoolPilotMigration,
  applicationSha: string
): Promise<SchoolPilotMigrationResult> {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(migration.id)) {
    throw new Error(`Invalid migration id: ${migration.id}`);
  }
  if (!/^[0-9a-f]{64}$/.test(migration.checksum)) {
    throw new Error(`Invalid migration checksum: ${migration.id}`);
  }
  const existing = await pool.query<{
    checksum: string;
    status: string;
  }>(`SELECT checksum, status FROM schema_migrations WHERE id = $1`, [migration.id]);
  const row = existing.rows[0];
  if (row && row.checksum !== migration.checksum) {
    throw new Error(`Migration checksum mismatch: ${migration.id}`);
  }
  if (row?.status === "complete") {
    return { id: migration.id, status: "skipped", durationMs: 0 };
  }

  const startedAt = Date.now();
  await pool.query(`
    INSERT INTO schema_migrations (
      id, checksum, mode, status, application_sha, started_at,
      completed_at, duration_ms, error_code, updated_at
    ) VALUES ($1, $2, $3, 'running', $4, now(), NULL, NULL, NULL, now())
    ON CONFLICT (id) DO UPDATE SET
      status = 'running',
      application_sha = EXCLUDED.application_sha,
      started_at = now(),
      completed_at = NULL,
      duration_ms = NULL,
      error_code = NULL,
      updated_at = now()
  `, [migration.id, migration.checksum, migration.mode, applicationSha]);

  try {
    if (migration.mode === "transactional") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await migration.apply(client);
        const durationMs = Date.now() - startedAt;
        await client.query(`
          UPDATE schema_migrations
          SET status = 'complete', completed_at = now(), duration_ms = $2,
              error_code = NULL, updated_at = now()
          WHERE id = $1 AND checksum = $3 AND status = 'running'
        `, [migration.id, durationMs, migration.checksum]);
        await client.query("COMMIT");
        return { id: migration.id, status: "applied", durationMs };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    await migration.apply(pool);
    const durationMs = Date.now() - startedAt;
    await pool.query(`
      UPDATE schema_migrations
      SET status = 'complete', completed_at = now(), duration_ms = $2,
          error_code = NULL, updated_at = now()
      WHERE id = $1 AND checksum = $3 AND status = 'running'
    `, [migration.id, durationMs, migration.checksum]);
    return { id: migration.id, status: "applied", durationMs };
  } catch (error) {
    await pool.query(`
      UPDATE schema_migrations
      SET status = 'failed', completed_at = now(), duration_ms = $2,
          error_code = $3, updated_at = now()
      WHERE id = $1 AND checksum = $4
    `, [migration.id, Date.now() - startedAt, safeErrorCode(error), migration.checksum]).catch(() => {});
    throw error;
  }
}

export async function runSchoolPilotMigrationLedger(options: {
  pool: Pool;
  migrations: readonly SchoolPilotMigration[];
  applicationSha?: string;
}): Promise<SchoolPilotMigrationResult[]> {
  await ensureMigrationLedger(options.pool);
  const lockClient = await options.pool.connect();
  try {
    await lockClient.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
    const results: SchoolPilotMigrationResult[] = [];
    const applicationSha = safeApplicationSha(
      options.applicationSha
      || process.env.IMAGE_SHA
      || process.env.GIT_SHA
      || process.env.COMMIT_SHA
    );
    const seen = new Set<string>();
    for (const migration of options.migrations) {
      if (seen.has(migration.id)) throw new Error(`Duplicate migration id: ${migration.id}`);
      seen.add(migration.id);
      results.push(await runOneMigration(options.pool, migration, applicationSha));
    }
    return results;
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}
