import assert from "node:assert/strict";
import pg from "pg";
import { PASSPILOT_APPOINTMENTS_SQL } from "../dist/db/passpilotAppointmentsMigration.js";

// Drizzle pushes table definitions, but the column-specific SET NULL action and
// invoker pass-return trigger belong to the immutable reviewed SQL migration.
// Ordinary CI needs that contract before its pass-return integration tests.
const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
assert.ok(connectionString);
assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(connectionString).hostname), "Only a disposable local test database is permitted");
const connection = new pg.Client({ connectionString });
await connection.connect();
try {
  await connection.query("BEGIN");
  await connection.query(PASSPILOT_APPOINTMENTS_SQL);
  await connection.query("COMMIT");
  console.log("[appointments-ci] installed immutable appointment expand contract");
} catch (error) { await connection.query("ROLLBACK"); throw error; }
finally { await connection.end(); }
