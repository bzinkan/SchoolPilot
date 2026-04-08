import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 15,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 3000,
  statement_timeout: 15000,
  ...(process.env.DATABASE_URL?.includes("sslmode=require") && {
    ssl: { rejectUnauthorized: false },
  }),
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

export const db = drizzle(pool, {
  schema,
  logger: process.env.NODE_ENV === "development",
});

export { pool };
export default db;
