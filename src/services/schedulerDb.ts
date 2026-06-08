import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../schema/index.js";

// Dedicated pool for scheduler/background jobs.
// Isolated from the main API pool so long-running rollup/purge queries can never
// starve incoming API requests (especially extension endpoints like /school/status
// and /extension/register that hit the DB on every Chromebook alarm wake-up).
// Scheduler/background jobs operate across ALL schools with no per-request school
// context, so they must BYPASS Row-Level Security. We do that by marking every
// scheduler connection with the app.is_super GUC (policies OR-in this flag).
// DATABASE_URL_PRIVILEGED lets ops optionally point the scheduler at a dedicated
// BYPASSRLS DB role; it falls back to DATABASE_URL (same behaviour via the flag).
const schedulerConnectionString =
  process.env.DATABASE_URL_PRIVILEGED || process.env.DATABASE_URL;

const schedulerPool = new pg.Pool({
  connectionString: schedulerConnectionString,
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 60000,
  ...(schedulerConnectionString?.includes("sslmode=require") && {
    ssl: { rejectUnauthorized: false },
  }),
});

// Mark each new scheduler connection as RLS-exempt. Harmless when RLS is off
// (app.is_super is just an unread custom GUC); once policies exist, this lets
// cross-school jobs (rollup/purge/digests) see every school.
schedulerPool.on("connect", (client) => {
  client.query("SET app.is_super = 'on'").catch((err) => {
    console.error("[Scheduler Pool] failed to set RLS bypass flag", err);
  });
});

schedulerPool.on("error", (err) => {
  console.error("[Scheduler Pool] Unexpected error on idle client", err);
});

export const schedulerDb = drizzle(schedulerPool, { schema });
export { schedulerPool };
