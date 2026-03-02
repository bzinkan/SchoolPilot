import "dotenv/config";
import http from "http";
import { createApp } from "./app.js";
import { setupSocketIO } from "./realtime/socketio.js";
import { setupWebSocket } from "./realtime/websocket.js";
import { startScheduler } from "./services/scheduler.js";

// ---------------------------------------------------------------------------
// Environment validation — runs before anything else touches env vars
// ---------------------------------------------------------------------------
function validateEnv(): void {
  const isProduction = process.env.NODE_ENV === "production";
  const required = ["DATABASE_URL", "SESSION_SECRET", "JWT_SECRET"] as const;

  for (const key of required) {
    if (!process.env[key]) {
      const message = `Environment variable ${key} is not set.`;
      if (isProduction) {
        throw new Error(
          `FATAL: ${message} Cannot start in production without it.`
        );
      } else {
        console.warn(`[env] WARNING: ${message} Using development fallback.`);
      }
    }
  }
}

validateEnv();

const PORT = parseInt(process.env.PORT || "4000", 10);

// Run lightweight auto-migrations for new tables
import { pool } from "./db.js";
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_usage (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        date TEXT NOT NULL,
        total_seconds INTEGER NOT NULL DEFAULT 0,
        heartbeat_count INTEGER NOT NULL DEFAULT 0,
        top_domains JSONB,
        first_seen TIMESTAMP,
        last_seen TIMESTAMP,
        computed_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS daily_usage_school_date_idx ON daily_usage (school_id, date)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS daily_usage_student_date_unique ON daily_usage (student_id, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS daily_usage_school_student_date_idx ON daily_usage (school_id, student_id, date)`);
    console.log("[migration] daily_usage table ready");
  } catch (err) {
    console.warn("[migration] daily_usage auto-migration skipped:", (err as Error).message);
  }

  // Add gopilot_role column for per-product role overrides
  try {
    await pool.query(`ALTER TABLE school_memberships ADD COLUMN IF NOT EXISTS gopilot_role TEXT`);
    console.log("[migration] gopilot_role column ready");
  } catch (err) {
    console.warn("[migration] gopilot_role migration skipped:", (err as Error).message);
  }

  // One-time: update super-admin email alias in users + audit_logs
  try {
    const OLD_EMAIL = "bzinkan@school-pilot.net";
    const NEW_EMAIL = "support@school-pilot.net";
    const { rowCount } = await pool.query(`UPDATE users SET email = $1 WHERE email = $2`, [NEW_EMAIL, OLD_EMAIL]);
    if (rowCount && rowCount > 0) {
      await pool.query(`UPDATE audit_logs SET user_email = $1 WHERE user_email = $2`, [NEW_EMAIL, OLD_EMAIL]);
      console.log("[migration] email alias updated");
    }
  } catch (err) {
    console.warn("[migration] email alias update skipped:", (err as Error).message);
  }
})();

const app = createApp();
const server = http.createServer(app);

// Attach Socket.io for real-time events (GoPilot dismissal, etc.)
const io = setupSocketIO(server);
console.log("Socket.io attached");

// Attach WebSocket server for ClassPilot device monitoring
setupWebSocket(server);
console.log("WebSocket server attached at /ws");

// Start dismissal auto-start scheduler
startScheduler(io);

server.listen(PORT, () => {
  console.log(`SchoolPilot API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
