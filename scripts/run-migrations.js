// Lightweight SQL migration runner. Bypasses drizzle-kit (which requires a TTY)
// and applies the generated SQL files from migrations/ in order. Idempotent —
// tracks applied filenames in __drizzle_migrations_simple to allow re-runs.
import { Client } from "pg";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = "/app/migrations";
const TRACKING_TABLE = "__drizzle_migrations_simple";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log("Connected to RDS");

  await client.query(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (filename text PRIMARY KEY, applied_at timestamp DEFAULT now())`
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  console.log(`Found ${files.length} migration files`);

  for (const file of files) {
    const already = await client.query(
      `SELECT 1 FROM ${TRACKING_TABLE} WHERE filename = $1`,
      [file]
    );
    if (already.rowCount > 0) {
      console.log(`SKIP ${file} (already applied)`);
      continue;
    }
    console.log(`APPLY ${file}`);
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (err) {
        // Tolerate "already exists" so re-runs are safe
        const msg = String(err.message || err);
        if (
          msg.includes("already exists") ||
          msg.includes("duplicate object") ||
          msg.includes("constraint") && msg.includes("already")
        ) {
          console.log(`  (skipped already-existing: ${msg.split("\n")[0].slice(0, 100)})`);
          continue;
        }
        throw err;
      }
    }
    await client.query(
      `INSERT INTO ${TRACKING_TABLE} (filename) VALUES ($1)`,
      [file]
    );
    console.log(`DONE ${file}`);
  }

  console.log("All migrations applied");
} catch (err) {
  console.error("MIGRATION FAILED:", err);
  process.exit(1);
} finally {
  await client.end();
}
