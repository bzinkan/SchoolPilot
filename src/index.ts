import "dotenv/config";
import http from "http";
import { createApp } from "./app.js";
import { setupSocketIO } from "./realtime/socketio.js";
import { setupWebSocket } from "./realtime/websocket.js";
import { startScheduler } from "./services/scheduler.js";
import { startHealthMonitor } from "./services/healthMonitor.js";

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

  // Drop legacy substitute_assignments table
  try {
    await pool.query(`DROP TABLE IF EXISTS substitute_assignments`);
    console.log("[migration] substitute_assignments table dropped");
  } catch (err) {
    console.warn("[migration] substitute_assignments drop skipped:", (err as Error).message);
  }

  // Co-teacher junction tables
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_teachers (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id TEXT NOT NULL,
        teacher_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary',
        assigned_at TIMESTAMP NOT NULL DEFAULT now(),
        UNIQUE(group_id, teacher_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS group_teachers_group_id_idx ON group_teachers (group_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS group_teachers_teacher_id_idx ON group_teachers (teacher_id)`);
    console.log("[migration] group_teachers table ready");
  } catch (err) {
    console.warn("[migration] group_teachers migration skipped:", (err as Error).message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS homeroom_teachers (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        homeroom_id TEXT NOT NULL,
        teacher_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary',
        assigned_at TIMESTAMP NOT NULL DEFAULT now(),
        UNIQUE(homeroom_id, teacher_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS homeroom_teachers_homeroom_id_idx ON homeroom_teachers (homeroom_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS homeroom_teachers_teacher_id_idx ON homeroom_teachers (teacher_id)`);
    console.log("[migration] homeroom_teachers table ready");
  } catch (err) {
    console.warn("[migration] homeroom_teachers migration skipped:", (err as Error).message);
  }

  // Seed co-teacher tables from existing teacherId columns
  try {
    await pool.query(`
      INSERT INTO group_teachers (group_id, teacher_id, role)
      SELECT id, teacher_id, 'primary' FROM groups
      WHERE teacher_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    await pool.query(`
      INSERT INTO homeroom_teachers (homeroom_id, teacher_id, role)
      SELECT id, teacher_id, 'primary' FROM homerooms
      WHERE teacher_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    console.log("[migration] co-teacher data seeded from existing teacherId columns");
  } catch (err) {
    console.warn("[migration] co-teacher data seed skipped:", (err as Error).message);
  }

  // Student attendance table for daily absence tracking
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_attendance (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        date TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        notes TEXT,
        marked_by TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS student_attendance_student_date_unique ON student_attendance (student_id, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_attendance_school_date_idx ON student_attendance (school_id, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_attendance_student_id_idx ON student_attendance (student_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_attendance_school_id_idx ON student_attendance (school_id)`);
    console.log("[migration] student_attendance table ready");
  } catch (err) {
    console.warn("[migration] student_attendance migration skipped:", (err as Error).message);
  }

  // Dismissal overrides table (session-scoped daily type changes)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dismissal_overrides (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        original_type TEXT NOT NULL,
        override_type TEXT NOT NULL,
        reason TEXT,
        changed_by TEXT NOT NULL,
        changed_by_role TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        UNIQUE(session_id, student_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS dismissal_overrides_session_id_idx ON dismissal_overrides (session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS dismissal_overrides_student_id_idx ON dismissal_overrides (student_id)`);
    console.log("[migration] dismissal_overrides table ready");
  } catch (err) {
    console.warn("[migration] dismissal_overrides migration skipped:", (err as Error).message);
  }

  // Add auto_block_unsafe_urls column to settings table
  try {
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_block_unsafe_urls BOOLEAN DEFAULT true`);
    console.log("[migration] auto_block_unsafe_urls column ready");
  } catch (err) {
    console.warn("[migration] auto_block_unsafe_urls migration skipped:", (err as Error).message);
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
const wss = setupWebSocket(server);
console.log("WebSocket server attached at /ws");

// Start dismissal auto-start scheduler
startScheduler(io);

// Start health monitoring (checks every 5 minutes, alerts via email)
startHealthMonitor(wss);

server.listen(PORT, () => {
  console.log(`SchoolPilot API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
