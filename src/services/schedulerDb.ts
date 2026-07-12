import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../schema/index.js";
import { buildPgSslConfig } from "../db/ssl.js";
import errorMonitor from "./errorMonitor.js";
import { databasePoolLimits } from "../config/databasePools.js";

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
const poolLimits = databasePoolLimits();

// Mark scheduler query connections as RLS-exempt at connection startup. Harmless
// when RLS is off (app.is_super is just an unread custom GUC); once policies
// exist, this lets cross-school jobs (rollup/purge/digests) see every school.
const schedulerPool = new pg.Pool({
  connectionString: schedulerConnectionString,
  max: poolLimits.scheduler,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 60000,
  options: "-c app.is_super=on",
  ssl: buildPgSslConfig(schedulerConnectionString),
});

// Advisory locks must stay open for the duration of a scheduler job. Keep them
// on a separate pool so lock holders cannot starve the query pool the jobs use.
const schedulerLockPool = new pg.Pool({
  connectionString: schedulerConnectionString,
  max: poolLimits.schedulerLock,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 60000,
  ssl: buildPgSslConfig(schedulerConnectionString),
});

schedulerPool.on("error", (err) => {
  console.error("[Scheduler Pool] Unexpected error on idle client", err);
  errorMonitor.trackError(
    "database_connectivity",
    err,
    {
      job: "scheduler_pool",
      messageType: "idle_client_error",
      errorCode: (err as NodeJS.ErrnoException).code,
    },
    { persist: false, priority: "high" }
  );
});

schedulerLockPool.on("error", (err) => {
  console.error("[Scheduler Lock Pool] Unexpected error on idle client", err);
  errorMonitor.trackError(
    "database_connectivity",
    err,
    {
      job: "scheduler_lock_pool",
      messageType: "idle_client_error",
      errorCode: (err as NodeJS.ErrnoException).code,
    },
    { persist: false, priority: "high" }
  );
});

export const schedulerDb = drizzle(schedulerPool, { schema });
export { schedulerPool, schedulerLockPool };
