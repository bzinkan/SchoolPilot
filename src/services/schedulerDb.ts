import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../schema/index.js";

// Dedicated pool for scheduler/background jobs.
// Isolated from the main API pool so long-running rollup/purge queries can never
// starve incoming API requests (especially extension endpoints like /school/status
// and /extension/register that hit the DB on every Chromebook alarm wake-up).
const schedulerPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 60000,
  ...(process.env.DATABASE_URL?.includes("sslmode=require") && {
    ssl: { rejectUnauthorized: false },
  }),
});

schedulerPool.on("error", (err) => {
  console.error("[Scheduler Pool] Unexpected error on idle client", err);
});

export const schedulerDb = drizzle(schedulerPool, { schema });
export { schedulerPool };
