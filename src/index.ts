import "dotenv/config";
import http from "http";
import { createApp } from "./app.js";
import { setupSocketIO } from "./realtime/socketio.js";
import { setupWebSocket } from "./realtime/websocket.js";
import { startScheduler } from "./services/scheduler.js";
import { startHealthMonitor } from "./services/healthMonitor.js";
import errorMonitor from "./services/errorMonitor.js";

// ---------------------------------------------------------------------------
// Global error handlers — catch crashes and alert developers
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  errorMonitor.trackError("uncaught_exception", err);
  console.error("[FATAL] Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  errorMonitor.trackError("uncaught_exception", reason instanceof Error ? reason : new Error(String(reason)));
  console.error("[FATAL] Unhandled rejection:", reason);
});

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
async function runStartupMigrations(): Promise<void> {
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

  // Unified student columns used across GoPilot, PassPilot kiosk, and ClassPilot.
  try {
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS email_lc TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS google_user_id TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS photo_url TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS grade_level TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS student_id_number TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS grade_id TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS homeroom_id TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS dismissal_type TEXT DEFAULT 'car'`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS afterschool_reason TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS bus_route TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS student_code TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS external_id TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS device_id TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS student_status TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS students_school_email_idx ON students (school_id, email_lc)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS students_grade_id_idx ON students (grade_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS students_homeroom_id_idx ON students (homeroom_id)`);
    console.log("[migration] unified student columns ready");
  } catch (err) {
    console.warn("[migration] unified student columns migration skipped:", (err as Error).message);
  }

  // Google integration tables used by OAuth, Workspace Directory, and Classroom import.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS google_oauth_tokens (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL UNIQUE,
        refresh_token TEXT NOT NULL,
        scope TEXT,
        token_type TEXT,
        expiry_date TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS classroom_courses (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        google_course_id TEXT NOT NULL,
        name TEXT NOT NULL,
        section TEXT,
        room TEXT,
        description_heading TEXT,
        owner_id TEXT,
        grade_id TEXT,
        last_synced_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classroom_courses_school_id_idx ON classroom_courses (school_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS classroom_courses_school_google_unique ON classroom_courses (school_id, google_course_id)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS classroom_course_students (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        google_user_id TEXT,
        student_email_lc TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS classroom_course_students_enrollment_unique ON classroom_course_students (school_id, course_id, student_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classroom_course_students_school_course_idx ON classroom_course_students (school_id, course_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classroom_course_students_school_student_idx ON classroom_course_students (school_id, student_id)`);
    console.log("[migration] Google integration tables ready");
  } catch (err) {
    console.warn("[migration] Google integration tables migration skipped:", (err as Error).message);
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

  // Add class block scheduling columns to groups table
  try {
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS block_start_time TEXT`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS block_end_time TEXT`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS schedule_skipped_date TEXT`);
    console.log("[migration] class block scheduling columns ready");
  } catch (err) {
    console.warn("[migration] class block scheduling migration skipped:", (err as Error).message);
  }

  // Add tax exemption metadata columns used by billing/admin school queries
  try {
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS tax_exempt_status TEXT`);
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS tax_exempt_cert_url TEXT`);
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS tax_exempt_cert_requested_at TIMESTAMP`);
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS tax_exempt_cert_uploaded_at TIMESTAMP`);
    console.log("[migration] tax exemption columns ready");
  } catch (err) {
    console.warn("[migration] tax exemption columns migration skipped:", (err as Error).message);
  }

  // Add AI classification columns to heartbeats table
  try {
    await pool.query(`ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS ai_category TEXT`);
    await pool.query(`ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS safety_alert TEXT`);
    console.log("[migration] heartbeats AI classification columns ready");
  } catch (err) {
    console.warn("[migration] heartbeats AI classification migration skipped:", (err as Error).message);
  }

  // Allow audit_logs.school_id and user_id to be NULL for system-level events
  // (e.g., failed-login attempts for non-existent users).
  try {
    await pool.query(`ALTER TABLE audit_logs ALTER COLUMN school_id DROP NOT NULL`);
    await pool.query(`ALTER TABLE audit_logs ALTER COLUMN user_id DROP NOT NULL`);
    console.log("[migration] audit_logs school_id/user_id nullable");
  } catch (err) {
    console.warn("[migration] audit_logs nullable migration skipped:", (err as Error).message);
  }

  // Auth lockouts — persistent across ECS task restarts and multi-instance
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_lockouts (
        email_lc TEXT PRIMARY KEY,
        failed_attempts INT NOT NULL DEFAULT 0,
        first_fail_at TIMESTAMP NOT NULL DEFAULT now(),
        locked_until TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS auth_lockouts_locked_until_idx ON auth_lockouts (locked_until)`);
    console.log("[migration] auth_lockouts table ready");
  } catch (err) {
    console.warn("[migration] auth_lockouts migration skipped:", (err as Error).message);
  }

  // Security events table — breach detection monitor findings
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        detected_at TIMESTAMP NOT NULL DEFAULT now(),
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        school_id TEXT,
        user_id TEXT,
        user_email TEXT,
        ip_address TEXT,
        summary TEXT NOT NULL,
        details JSONB,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_at TIMESTAMP,
        resolved_by TEXT,
        resolution_notes TEXT,
        alert_sent BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS security_events_detected_at_idx ON security_events (detected_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS security_events_event_type_idx ON security_events (event_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS security_events_severity_idx ON security_events (severity)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS security_events_status_idx ON security_events (status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS security_events_school_id_idx ON security_events (school_id)`);
    console.log("[migration] security_events table ready");
  } catch (err) {
    console.warn("[migration] security_events migration skipped:", (err as Error).message);
  }

  // MailPilot — ClassPilot add-on: Gmail safety monitoring (watches, alerts, scan log)
  try {
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS classpilot_email_monitoring BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS mailpilot_org_units TEXT`);
    console.log("[migration] classpilot_email_monitoring column ready");
  } catch (err) {
    console.warn("[migration] classpilot_email_monitoring migration skipped:", (err as Error).message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mailpilot_watches (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        student_email TEXT NOT NULL,
        history_id TEXT,
        expires_at TIMESTAMP NOT NULL,
        started_at TIMESTAMP NOT NULL DEFAULT now(),
        last_renewed_at TIMESTAMP NOT NULL DEFAULT now(),
        last_poll_at TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'active',
        last_error TEXT
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS mailpilot_watches_email_unique ON mailpilot_watches (student_email)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS mailpilot_watches_school_idx ON mailpilot_watches (school_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS mailpilot_watches_expires_idx ON mailpilot_watches (expires_at)`);
    console.log("[migration] mailpilot_watches table ready");
  } catch (err) {
    console.warn("[migration] mailpilot_watches migration skipped:", (err as Error).message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_alerts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        student_email TEXT NOT NULL,
        gmail_message_id TEXT NOT NULL,
        gmail_thread_id TEXT,
        direction TEXT NOT NULL,
        sender TEXT,
        recipients JSONB,
        subject TEXT,
        snippet TEXT,
        category TEXT,
        safety_alert TEXT,
        bullying TEXT,
        confidence INTEGER,
        severity TEXT NOT NULL DEFAULT 'medium',
        reasoning TEXT,
        message_date TIMESTAMP,
        alerted_at TIMESTAMP NOT NULL DEFAULT now(),
        reviewed_at TIMESTAMP,
        reviewed_by TEXT,
        review_status TEXT,
        review_note TEXT
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS email_alerts_gmail_message_unique ON email_alerts (gmail_message_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS email_alerts_school_alerted_idx ON email_alerts (school_id, alerted_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS email_alerts_student_alerted_idx ON email_alerts (student_id, alerted_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS email_alerts_school_review_idx ON email_alerts (school_id, review_status)`);
    console.log("[migration] email_alerts table ready");
  } catch (err) {
    console.warn("[migration] email_alerts migration skipped:", (err as Error).message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_scan_log (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        date TEXT NOT NULL,
        messages_scanned INTEGER NOT NULL DEFAULT 0,
        alerts_raised INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS email_scan_log_school_date_unique ON email_scan_log (school_id, date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS email_scan_log_school_idx ON email_scan_log (school_id)`);
    console.log("[migration] email_scan_log table ready");
  } catch (err) {
    console.warn("[migration] email_scan_log migration skipped:", (err as Error).message);
  }

  // Note: the previous one-time email-alias migration (bzinkan@school-pilot.net
  // → support@school-pilot.net) was removed because the canonical super-admin
  // account is bzinkan@school-pilot.net, matching the Google Workspace owner's
  // primary address. Re-applying that rename broke Google OAuth sign-in by
  // creating a DB email that didn't match the Google profile.email.

  // Composite index for heartbeat queries (purge, rollup, analytics) — critical for scale
  try {
    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeats_school_timestamp_idx ON heartbeats (school_id, timestamp DESC)`);
    console.log("[migration] heartbeats (school_id, timestamp) index ready");
  } catch (err) {
    // CONCURRENTLY can't run inside a transaction, retry without it
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS heartbeats_school_timestamp_idx ON heartbeats (school_id, timestamp DESC)`);
      console.log("[migration] heartbeats (school_id, timestamp) index ready (non-concurrent)");
    } catch (err2) {
      console.warn("[migration] heartbeats index skipped:", (err2 as Error).message);
    }
  }

  // Backfill emailLc for students that have email but emailLc is NULL
  try {
    const { rowCount } = await pool.query(`UPDATE students SET email_lc = LOWER(email) WHERE email IS NOT NULL AND email_lc IS NULL`);
    if (rowCount && rowCount > 0) {
      console.log(`[migration] Backfilled emailLc for ${rowCount} students`);
    }
  } catch (err) {
    console.warn("[migration] emailLc backfill skipped:", (err as Error).message);
  }

  // Clean up duplicate students created by extension (keep the admin-imported one with gradeId)
  // First reassign heartbeats and student_devices so data isn't orphaned, then delete.
  try {
    // Reassign heartbeats from duplicate (no gradeId) to surviving (has gradeId) student
    await pool.query(`
      UPDATE heartbeats SET student_id = keeper.id
      FROM (
        SELECT s1.id, s2.id AS dup_id
        FROM students s1
        JOIN students s2 ON s1.email_lc = s2.email_lc AND s1.school_id = s2.school_id AND s1.id != s2.id
        WHERE s1.grade_id IS NOT NULL AND s2.grade_id IS NULL
      ) keeper
      WHERE heartbeats.student_id = keeper.dup_id
    `);
    // Reassign student_devices without tripping the unique(student_id, device_id) constraint
    await pool.query(`
      INSERT INTO student_devices (student_id, device_id, first_seen_at, last_seen_at)
      SELECT keeper.id, student_devices.device_id, MIN(student_devices.first_seen_at), MAX(student_devices.last_seen_at)
      FROM student_devices
      JOIN (
        SELECT s1.id, s2.id AS dup_id
        FROM students s1
        JOIN students s2 ON s1.email_lc = s2.email_lc AND s1.school_id = s2.school_id AND s1.id != s2.id
        WHERE s1.grade_id IS NOT NULL AND s2.grade_id IS NULL
      ) keeper ON student_devices.student_id = keeper.dup_id
      GROUP BY keeper.id, student_devices.device_id
      ON CONFLICT (student_id, device_id) DO NOTHING
    `);
    await pool.query(`
      DELETE FROM student_devices
      USING (
        SELECT s1.id, s2.id AS dup_id
        FROM students s1
        JOIN students s2 ON s1.email_lc = s2.email_lc AND s1.school_id = s2.school_id AND s1.id != s2.id
        WHERE s1.grade_id IS NOT NULL AND s2.grade_id IS NULL
      ) keeper
      WHERE student_devices.student_id = keeper.dup_id
    `);
    // Reassign student_sessions
    await pool.query(`
      UPDATE student_sessions SET student_id = keeper.id
      FROM (
        SELECT s1.id, s2.id AS dup_id
        FROM students s1
        JOIN students s2 ON s1.email_lc = s2.email_lc AND s1.school_id = s2.school_id AND s1.id != s2.id
        WHERE s1.grade_id IS NOT NULL AND s2.grade_id IS NULL
      ) keeper
      WHERE student_sessions.student_id = keeper.dup_id
    `);
    // Now delete the orphaned duplicates
    await pool.query(`
      DELETE FROM students WHERE id IN (
        SELECT s2.id FROM students s1
        JOIN students s2 ON s1.email_lc = s2.email_lc AND s1.school_id = s2.school_id AND s1.id != s2.id
        WHERE s1.grade_id IS NOT NULL AND s2.grade_id IS NULL
      )
    `);
    console.log("[migration] Cleaned up duplicate extension-created students (with data reassignment)");
  } catch (err) {
    console.warn("[migration] Duplicate student cleanup skipped:", (err as Error).message);
  }
}

async function startServer(): Promise<void> {
  await runStartupMigrations();

  const app = createApp();
  const server = http.createServer(app);

  // Attach Socket.io for real-time events (GoPilot dismissal, etc.)
  const io = setupSocketIO(server);
  console.log("Socket.io attached");

  // Attach WebSocket server for ClassPilot device monitoring
  const wss = setupWebSocket(server);
  console.log("WebSocket server attached at /ws");

  // Start dismissal auto-start scheduler after startup migrations complete.
  startScheduler(io);

  // Start health monitoring after startup migrations complete.
  startHealthMonitor(wss);

  server.listen(PORT, () => {
    console.log(`SchoolPilot API running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
}

startServer().catch((err) => {
  errorMonitor.trackError("uncaught_exception", err instanceof Error ? err : new Error(String(err)));
  console.error("[FATAL] Startup failed:", err);
  process.exit(1);
});
