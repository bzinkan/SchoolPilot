import "dotenv/config";
import http from "http";
import type { Server as SocketIOServer } from "socket.io";
import type { WebSocketServer } from "ws";
import { initSentry } from "./services/sentry.js";
import { createApp } from "./app.js";
import { setupSocketIO } from "./realtime/socketio.js";
import { setupWebSocket } from "./realtime/websocket.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";
import { startHealthMonitor, stopHealthMonitor } from "./services/healthMonitor.js";
import errorMonitor from "./services/errorMonitor.js";
import { pool, prewarmMainPool, sessionPool } from "./db.js";
import { schedulerLockPool, schedulerPool } from "./services/schedulerDb.js";
import { migrationsOnStartup, migrationsOnly, schedulerEnabled } from "./config/runtime.js";

// Initialize Sentry as early as possible. No-op unless SENTRY_DSN is set
// (gated off until the DPA is signed + subprocessors list updated).
initSentry();

let httpServer: http.Server | null = null;
let socketIoServer: SocketIOServer | null = null;
let webSocketServer: WebSocketServer | null = null;
let fatalShutdownStarted = false;

async function bounded(promise: Promise<unknown>, timeoutMs: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(`[FATAL] Timed out while waiting for ${label}`);
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    console.error(`[FATAL] ${label} failed:`, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = httpServer;
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close((err) => {
      if (err) console.error("[FATAL] HTTP server close failed:", err);
      resolve();
    });
  });
}

function closeSocketIo(): Promise<void> {
  return new Promise((resolve) => {
    const io = socketIoServer;
    if (!io) {
      resolve();
      return;
    }
    io.close(() => resolve());
  });
}

function closeWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    const wss = webSocketServer;
    if (!wss) {
      resolve();
      return;
    }
    for (const client of wss.clients) {
      try {
        client.close(1011, "Server shutting down");
      } catch {
        // Best-effort shutdown only.
      }
    }
    wss.close((err) => {
      if (err) console.error("[FATAL] WebSocket server close failed:", err);
      resolve();
    });
  });
}

async function fatalShutdown(reason: string, err: unknown): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  if (fatalShutdownStarted) {
    console.error(`[FATAL] Additional fatal event during shutdown (${reason}):`, error);
    return;
  }
  fatalShutdownStarted = true;
  process.exitCode = 1;

  const forceExit = setTimeout(() => {
    console.error("[FATAL] Force exiting after shutdown timeout");
    process.exit(1);
  }, 10_000);

  console.error(`[FATAL] ${reason}:`, error);
  stopScheduler();
  stopHealthMonitor();
  const closeServers = Promise.allSettled([
    closeHttpServer(),
    closeSocketIo(),
    closeWebSocketServer(),
  ]);

  await errorMonitor.trackErrorAndFlush(
    "fatal_process_error",
    error,
    { eventType: reason },
    5_000
  );
  await bounded(closeServers.then(() => undefined), 4_000, "server shutdown");
  await bounded(Promise.allSettled([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]).then(() => undefined), 4_000, "database pool shutdown");

  clearTimeout(forceExit);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Global error handlers — catch crashes and alert developers
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  void fatalShutdown("uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  void fatalShutdown("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)));
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

  // If MailPilot is configured (Pub/Sub topic set), the public push endpoint
  // must have its verify token — otherwise the route 503s every notification
  // and Gmail monitoring silently stops. Refuse to boot prod in that state.
  if (
    isProduction &&
    process.env.MAILPILOT_PUBSUB_TOPIC &&
    !process.env.MAILPILOT_PUBSUB_VERIFY_TOKEN
  ) {
    throw new Error(
      "FATAL: MAILPILOT_PUBSUB_TOPIC is set but MAILPILOT_PUBSUB_VERIFY_TOKEN is not. " +
        "The Pub/Sub push endpoint fails closed without it."
    );
  }
}

validateEnv();

const PORT = parseInt(process.env.PORT || "4000", 10);

// Run lightweight auto-migrations for new tables
import {
  RLS_GLOBAL_TABLES,
  isSafeIdentifier,
  parseRlsEnabledTables,
  policySqlFor,
} from "./db/rlsPolicies.js";
export async function runStartupMigrations(): Promise<void> {
  // Schools can share a district Google Workspace domain. Older deployments had
  // a single-column unique constraint on domain; remove it and keep uniqueness
  // on (domain, name), matching the Drizzle schema.
  try {
    await pool.query(`ALTER TABLE schools DROP CONSTRAINT IF EXISTS schools_domain_unique`);
    await pool.query(`DROP INDEX IF EXISTS schools_domain_unique`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS schools_domain_name_unique ON schools (domain, name)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS schools_domain_idx ON schools (domain)`);
    console.log("[migration] schools shared-domain indexes ready");
  } catch (err) {
    console.warn("[migration] schools shared-domain migration skipped:", (err as Error).message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS school_inquiries (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_name TEXT NOT NULL,
        domain TEXT,
        contact_name TEXT NOT NULL,
        contact_email TEXT NOT NULL,
        contact_phone TEXT,
        preferred_contact_method TEXT,
        admin_it_email TEXT,
        billing_email TEXT,
        estimated_students TEXT,
        interested_products TEXT,
        questions TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        notes TEXT,
        school_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        processed_at TIMESTAMP,
        processed_by TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS school_inquiries_status_idx ON school_inquiries (status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS school_inquiries_email_idx ON school_inquiries (contact_email)`);

    const legacy = await pool.query<{ exists: string | null }>(`SELECT to_regclass('public.trial_requests') AS exists`);
    if (legacy.rows[0]?.exists) {
      const migrated = await pool.query(`
        INSERT INTO school_inquiries (
          id, school_name, domain, contact_name, contact_email, contact_phone,
          estimated_students, interested_products, questions, status, notes,
          school_id, created_at, processed_at, processed_by
        )
        SELECT
          id,
          school_name,
          domain,
          contact_name,
          contact_email,
          admin_phone,
          estimated_students,
          product,
          message,
          CASE
            WHEN status = 'declined' THEN 'closed'
            WHEN status IN ('pending', 'contacted', 'converted', 'closed') THEN status
            ELSE 'pending'
          END,
          notes,
          school_id,
          created_at,
          processed_at,
          processed_by
        FROM trial_requests tr
        WHERE NOT EXISTS (
          SELECT 1 FROM school_inquiries si WHERE si.id = tr.id
        )
      `);
      if ((migrated.rowCount || 0) > 0) {
        console.log(`[migration] migrated ${migrated.rowCount} legacy school inquiry rows`);
      }
    }

    const normalized = await schedulerPool.query(`
      UPDATE schools
      SET
        status = CASE WHEN status = 'trial' THEN 'active' ELSE status END,
        plan_tier = CASE WHEN plan_tier = 'trial' THEN 'basic' ELSE plan_tier END,
        trial_ends_at = NULL,
        updated_at = now()
      WHERE status = 'trial' OR plan_tier = 'trial' OR trial_ends_at IS NOT NULL
    `);
    if ((normalized.rowCount || 0) > 0) {
      console.log(`[migration] normalized ${normalized.rowCount} schools to active/suspended lifecycle`);
    }
    await pool.query(`ALTER TABLE schools ALTER COLUMN status SET DEFAULT 'active'`);
    await pool.query(`ALTER TABLE schools ALTER COLUMN plan_tier SET DEFAULT 'basic'`);
    console.log("[migration] school inquiry table and active/suspended defaults ready");
  } catch (err) {
    console.warn("[migration] school inquiry migration skipped:", (err as Error).message);
  }

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

  // Device enrollment secret columns (backward compatible — required defaults false)
  try {
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS enrollment_key TEXT`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS enrollment_key_required BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS shared_chromebook_login_method TEXT NOT NULL DEFAULT 'name_pin'`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS shared_chromebook_pin_login_enabled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`
      UPDATE settings
      SET shared_chromebook_login_method = 'name_pin'
      WHERE shared_chromebook_login_method IS NULL
         OR shared_chromebook_login_method NOT IN ('email_id', 'name_pin')
    `);
    console.log("[migration] settings enrollment_key columns ready");
  } catch (err) {
    console.warn("[migration] enrollment_key migration skipped:", (err as Error).message);
  }

  // Auto-enroll policy: default OFF (students must be pre-imported by IT).
  try {
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_enroll_students BOOLEAN NOT NULL DEFAULT false`);
    // RLS-exempt pool: this backfill WRITEs settings rows for every school and
    // runs with no request GUC, so under per-school RLS WITH CHECK it would be
    // rejected — route it through schedulerPool (app.is_super='on').
    await schedulerPool.query(`
      INSERT INTO settings (school_id, school_name, ws_shared_key)
      SELECT s.id, COALESCE(s.name, ''), ''
      FROM schools s
      WHERE NOT EXISTS (
        SELECT 1 FROM settings st WHERE st.school_id = s.id
      )
    `);
    console.log("[migration] settings auto_enroll_students column ready");
  } catch (err) {
    console.warn("[migration] auto_enroll_students migration skipped:", (err as Error).message);
  }

  // RLS Phase 1: add school_id to derived tables + backfill from parents.
  // Idempotent; nullable legacy/ambiguous rows stay NULL by design and are hidden
  // once table RLS is enabled. dashboard_tabs/messages can only infer teacher
  // ownership when the sender has exactly one active membership.
  try {
    await pool.query(`ALTER TABLE subgroups ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`UPDATE subgroups s SET school_id = g.school_id FROM groups g WHERE g.id = s.group_id AND s.school_id IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS subgroups_school_id_idx ON subgroups (school_id)`);

    await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`UPDATE teaching_sessions ts SET school_id = g.school_id FROM groups g WHERE g.id = ts.group_id AND ts.school_id IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS teaching_sessions_school_id_idx ON teaching_sessions (school_id)`);
    await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS control_updated_at TIMESTAMP`);
    await pool.query(`CREATE INDEX IF NOT EXISTS teaching_sessions_control_updated_at_idx ON teaching_sessions (control_updated_at)`);
    await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS session_mode TEXT NOT NULL DEFAULT 'live'`);
    await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_conflict_id TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS teaching_sessions_session_mode_idx ON teaching_sessions (session_mode)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS teaching_sessions_scheduled_conflict_idx ON teaching_sessions (scheduled_conflict_id)`);

    await pool.query(`ALTER TABLE parent_student ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`UPDATE parent_student ps SET school_id = st.school_id FROM students st WHERE st.id = ps.student_id AND ps.school_id IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS parent_student_school_id_idx ON parent_student (school_id)`);

    await pool.query(`ALTER TABLE teacher_students ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`UPDATE teacher_students tx SET school_id = st.school_id FROM students st WHERE st.id = tx.student_id AND tx.school_id IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS teacher_students_school_id_idx ON teacher_students (school_id)`);

    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`UPDATE messages m SET school_id = st.school_id FROM students st WHERE st.id = m.to_student_id AND m.school_id IS NULL`);
    await pool.query(`
      WITH sender_school AS (
        SELECT m.from_user_id, MIN(sm.school_id) AS school_id, COUNT(DISTINCT sm.school_id) AS school_count
        FROM messages m
        JOIN school_memberships sm ON sm.user_id = m.from_user_id
        WHERE m.school_id IS NULL
          AND m.to_student_id IS NULL
          AND m.from_user_id IS NOT NULL
          AND sm.status = 'active'
        GROUP BY m.from_user_id
      )
      UPDATE messages m
      SET school_id = ss.school_id
      FROM sender_school ss
      WHERE m.school_id IS NULL
        AND m.to_student_id IS NULL
        AND m.from_user_id = ss.from_user_id
        AND ss.school_count = 1
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS messages_school_id_idx ON messages (school_id)`);

    await pool.query(`ALTER TABLE dashboard_tabs ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`
      UPDATE dashboard_tabs dt SET school_id = m.school_id
      FROM (
        SELECT user_id, MIN(school_id) AS school_id
        FROM school_memberships WHERE status = 'active'
        GROUP BY user_id HAVING COUNT(*) = 1
      ) m
      WHERE m.user_id = dt.teacher_id AND dt.school_id IS NULL
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS dashboard_tabs_school_id_idx ON dashboard_tabs (school_id)`);

    // Audit: log any rows left without a school_id so staging/prod can review.
    const nullCounts = await pool.query(`
      SELECT 'subgroups' t, count(*) n FROM subgroups WHERE school_id IS NULL
      UNION ALL SELECT 'teaching_sessions', count(*) FROM teaching_sessions WHERE school_id IS NULL
      UNION ALL SELECT 'parent_student', count(*) FROM parent_student WHERE school_id IS NULL
      UNION ALL SELECT 'teacher_students', count(*) FROM teacher_students WHERE school_id IS NULL
      UNION ALL SELECT 'messages', count(*) FROM messages WHERE school_id IS NULL
      UNION ALL SELECT 'dashboard_tabs', count(*) FROM dashboard_tabs WHERE school_id IS NULL
    `);
    const residual = nullCounts.rows.filter((r: any) => Number(r.n) > 0).map((r: any) => `${r.t}=${r.n}`);
    console.log(`[migration] derived-table school_id columns ready${residual.length ? ` (NULL remaining: ${residual.join(", ")})` : ""}`);
  } catch (err) {
    console.warn("[migration] derived-table school_id migration skipped:", (err as Error).message);
  }

  // ClassPilot teacher command tracking. These tables are school-scoped and
  // participate in the generic RLS policy authoring block below.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_commands (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        teaching_session_id VARCHAR,
        supervision_context_id VARCHAR,
        teacher_id TEXT NOT NULL,
        target_scope TEXT NOT NULL,
        subgroup_id VARCHAR,
        command_type TEXT NOT NULL,
        command_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'requested',
        requested_count INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        received_count INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        unavailable_count INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE classpilot_commands ADD COLUMN IF NOT EXISTS supervision_context_id VARCHAR`);
    await pool.query(`ALTER TABLE classpilot_commands ALTER COLUMN teaching_session_id DROP NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_commands_school_session_idx ON classpilot_commands (school_id, teaching_session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_commands_school_context_idx ON classpilot_commands (school_id, supervision_context_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_commands_teacher_created_idx ON classpilot_commands (teacher_id, created_at)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_command_targets (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        command_id VARCHAR NOT NULL,
        school_id TEXT NOT NULL,
        teaching_session_id VARCHAR,
        supervision_context_id VARCHAR,
        student_id TEXT NOT NULL,
        student_session_id VARCHAR,
        device_id TEXT,
        status TEXT NOT NULL DEFAULT 'requested',
        ack_state TEXT,
        error_message TEXT,
        result JSONB,
        sent_at TIMESTAMP,
        received_at TIMESTAMP,
        completed_at TIMESTAMP,
        failed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE classpilot_command_targets ADD COLUMN IF NOT EXISTS supervision_context_id VARCHAR`);
    await pool.query(`ALTER TABLE classpilot_command_targets ALTER COLUMN teaching_session_id DROP NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_command_targets_command_idx ON classpilot_command_targets (command_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_command_targets_school_student_idx ON classpilot_command_targets (school_id, student_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_command_targets_school_context_idx ON classpilot_command_targets (school_id, supervision_context_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_command_targets_device_idx ON classpilot_command_targets (device_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_classroom_states (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        teaching_session_id VARCHAR NOT NULL,
        student_id TEXT,
        state_type TEXT NOT NULL,
        state_key TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        command_id VARCHAR,
        applied_by TEXT NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT now(),
        expires_at TIMESTAMP,
        cleared_at TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_classroom_states_session_idx ON classpilot_classroom_states (school_id, teaching_session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_classroom_states_student_idx ON classpilot_classroom_states (school_id, student_id)`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS classpilot_classroom_states_active_unique
      ON classpilot_classroom_states (teaching_session_id, student_id, state_type, state_key)
      WHERE cleared_at IS NULL
    `);
    console.log("[migration] ClassPilot teacher command tables ready");
  } catch (err) {
    console.warn("[migration] ClassPilot teacher command migration skipped:", (err as Error).message);
  }

  // ClassPilot FAB production state: session-scoped chat + recoverable raised hands.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        session_id VARCHAR NOT NULL,
        student_id TEXT,
        device_id TEXT,
        sender_id TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        recipient_id TEXT,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'sent',
        delivered_at TIMESTAMP,
        failed_at TIMESTAMP,
        error_message TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS student_id TEXT`);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS device_id TEXT`);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'sent'`);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP`);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS failed_at TIMESTAMP`);
    await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS error_message TEXT`);
    await schedulerPool.query(`
      UPDATE chat_messages cm
      SET school_id = COALESCE(ts.school_id, g.school_id)
      FROM teaching_sessions ts
      JOIN groups g ON g.id = ts.group_id
      WHERE cm.session_id = ts.id
        AND cm.school_id IS NULL
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx ON chat_messages (session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS chat_messages_school_session_idx ON chat_messages (school_id, session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS chat_messages_school_student_idx ON chat_messages (school_id, student_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_active_hands (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        teaching_session_id VARCHAR NOT NULL,
        student_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        raised_at TIMESTAMP NOT NULL DEFAULT now(),
        expires_at TIMESTAMP,
        cleared_at TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_active_hands_session_idx ON classpilot_active_hands (school_id, teaching_session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_active_hands_student_idx ON classpilot_active_hands (school_id, student_id)`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS classpilot_active_hands_active_unique
      ON classpilot_active_hands (teaching_session_id, student_id)
      WHERE cleared_at IS NULL
    `);
    console.log("[migration] ClassPilot FAB chat and active hand tables ready");
  } catch (err) {
    console.warn("[migration] ClassPilot FAB migration skipped:", (err as Error).message);
  }

  // ClassPilot supervision coverage. These school-scoped tables support the
  // Online Unassigned queue and temporary coverage contexts.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_coverage_assignments (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_value TEXT,
        permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_coverage_assignments_school_staff_idx ON classpilot_coverage_assignments (school_id, staff_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_coverage_assignments_scope_idx ON classpilot_coverage_assignments (school_id, scope_type, scope_value)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_coverage_scope_groups (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_coverage_scope_groups_school_idx ON classpilot_coverage_scope_groups (school_id, active)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_coverage_scope_group_members (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        coverage_group_id VARCHAR NOT NULL,
        student_id TEXT NOT NULL,
        assigned_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_coverage_scope_group_members_group_idx ON classpilot_coverage_scope_group_members (school_id, coverage_group_id)`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS classpilot_coverage_scope_group_members_unique
      ON classpilot_coverage_scope_group_members (school_id, coverage_group_id, student_id)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_supervision_contexts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        context_type TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        assigned_staff_id TEXT NOT NULL,
        coverage_group_id TEXT,
        scheduled_conflict_id TEXT,
        created_by TEXT NOT NULL,
        note TEXT,
        starts_at TIMESTAMP NOT NULL DEFAULT now(),
        ends_at TIMESTAMP NOT NULL,
        ended_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE classpilot_supervision_contexts ADD COLUMN IF NOT EXISTS coverage_group_id TEXT`);
    await pool.query(`ALTER TABLE classpilot_supervision_contexts ADD COLUMN IF NOT EXISTS scheduled_conflict_id TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_school_status_idx ON classpilot_supervision_contexts (school_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_staff_idx ON classpilot_supervision_contexts (school_id, assigned_staff_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_coverage_group_idx ON classpilot_supervision_contexts (school_id, coverage_group_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_scheduled_conflict_idx ON classpilot_supervision_contexts (school_id, scheduled_conflict_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_supervision_students (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        context_id VARCHAR NOT NULL,
        student_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        assigned_by TEXT NOT NULL,
        assigned_at TIMESTAMP NOT NULL DEFAULT now(),
        released_at TIMESTAMP,
        release_reason TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_supervision_students_context_idx ON classpilot_supervision_students (school_id, context_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_supervision_students_student_idx ON classpilot_supervision_students (school_id, student_id)`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS classpilot_supervision_students_active_unique
      ON classpilot_supervision_students (school_id, student_id)
      WHERE released_at IS NULL
    `);
    console.log("[migration] ClassPilot supervision coverage tables ready");
  } catch (err) {
    console.warn("[migration] ClassPilot supervision coverage migration skipped:", (err as Error).message);
  }

  // ClassPilot scheduled-start coverage requests. These school-scoped rows record
  // scheduled classes that need temporary staff pickup while the scheduled
  // teacher is not logged in.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_scheduled_conflicts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        teacher_id TEXT NOT NULL,
        scheduled_date TEXT NOT NULL,
        block_start_time TEXT NOT NULL,
        block_end_time TEXT,
        status TEXT NOT NULL DEFAULT 'coverage_needed',
        conflict_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        scheduled_teacher_connected BOOLEAN NOT NULL DEFAULT false,
        last_checked_at TIMESTAMP NOT NULL DEFAULT now(),
        resolved_at TIMESTAMP,
        resolved_by TEXT,
        resolution TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE classpilot_scheduled_conflicts ADD COLUMN IF NOT EXISTS block_end_time TEXT`);
    await pool.query(`ALTER TABLE classpilot_scheduled_conflicts ADD COLUMN IF NOT EXISTS scheduled_teacher_connected BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE classpilot_scheduled_conflicts ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP NOT NULL DEFAULT now()`);
    await pool.query(`ALTER TABLE classpilot_scheduled_conflicts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP`);
    await pool.query(`ALTER TABLE classpilot_scheduled_conflicts ADD COLUMN IF NOT EXISTS resolved_by TEXT`);
    await pool.query(`ALTER TABLE classpilot_scheduled_conflicts ADD COLUMN IF NOT EXISTS resolution TEXT`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS classpilot_scheduled_conflicts_unique
      ON classpilot_scheduled_conflicts (school_id, group_id, scheduled_date, block_start_time)
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_scheduled_conflicts_school_status_idx ON classpilot_scheduled_conflicts (school_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_scheduled_conflicts_teacher_idx ON classpilot_scheduled_conflicts (school_id, teacher_id)`);
    console.log("[migration] ClassPilot scheduled conflict table ready");
  } catch (err) {
    console.warn("[migration] ClassPilot scheduled conflict migration skipped:", (err as Error).message);
  }

  // ClassPilot admin analytics: forward-only session-attributed class usage.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_session_students (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        teaching_session_id VARCHAR NOT NULL,
        group_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT classpilot_session_students_session_student_unique UNIQUE (teaching_session_id, student_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_session_usage (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        teaching_session_id VARCHAR NOT NULL,
        group_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        total_seconds INTEGER NOT NULL DEFAULT 0,
        heartbeat_count INTEGER NOT NULL DEFAULT 0,
        top_domains JSONB,
        first_seen TIMESTAMPTZ,
        last_seen TIMESTAMPTZ,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT classpilot_session_usage_session_student_date_unique UNIQUE (teaching_session_id, student_id, local_date)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_students_school_session_idx ON classpilot_session_students (school_id, teaching_session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_students_school_group_idx ON classpilot_session_students (school_id, group_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_students_school_student_idx ON classpilot_session_students (school_id, student_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_usage_school_date_idx ON classpilot_session_usage (school_id, local_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_usage_school_group_date_idx ON classpilot_session_usage (school_id, group_id, local_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_usage_school_session_idx ON classpilot_session_usage (school_id, teaching_session_id)`);
    console.log("[migration] ClassPilot session-attributed analytics tables ready");
  } catch (err) {
    console.warn("[migration] ClassPilot session analytics migration skipped:", (err as Error).message);
  }

  // Google roster connector: IT-approved Domain-Wide Delegation for read-only
  // Workspace/Classroom roster imports. Created before the generic RLS policy
  // pass below so it receives tenant-isolation policy on the same startup.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS google_roster_connectors (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL UNIQUE,
        domain TEXT NOT NULL,
        delegated_admin_email TEXT,
        service_account_client_id TEXT,
        approved_scopes TEXT[] NOT NULL DEFAULT '{}'::text[],
        auth_mode TEXT NOT NULL DEFAULT 'service_account_key',
        status TEXT NOT NULL DEFAULT 'unverified',
        verified_at TIMESTAMP,
        last_sync_at TIMESTAMP,
        disabled_at TIMESTAMP,
        last_error TEXT,
        connected_by_user_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS google_roster_connectors_school_idx ON google_roster_connectors (school_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS google_roster_connectors_status_idx ON google_roster_connectors (school_id, status)`);
    console.log("[migration] Google roster connector table ready");
  } catch (err) {
    console.warn("[migration] Google roster connector migration skipped:", (err as Error).message);
  }

  // RLS Phase 4: author per-school tenant-isolation policies (idempotent) for
  // every table that has a school_id column, EXCEPT global/bootstrap tables. The
  // policies + FORCE ROW LEVEL SECURITY are INERT until a table is named in the
  // RLS_ENABLED_TABLES allowlist (then ENABLE ROW LEVEL SECURITY); dropping a
  // table from the allowlist disables it again on the next boot. This block is
  // DDL only (CREATE POLICY / ALTER TABLE), which is owner-privileged and NOT
  // subject to RLS, so it is safe to re-run even on already-enabled tables.
  //
  // NOTE before enabling a table in Phase 5+: any migration above that DMLs that
  // table runs on the main pool with no GUC, so under RLS it is denied (0 rows).
  // The derived-table backfills are self-limiting (WHERE school_id IS NULL → a
  // no-op once backfilled, and RLS+WITH CHECK prevents new NULL rows), but the
  // settings INSERT backfill DOES write — settings must run its backfill under
  // app.is_super (or be enabled only after that is addressed).
  try {
    const { rows: cols } = await pool.query<{ table_name: string }>(`
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'school_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name
    `);
    const tenantTables = cols
      .map((r) => r.table_name)
      .filter((t) => !RLS_GLOBAL_TABLES.has(t) && isSafeIdentifier(t));

    for (const table of tenantTables) {
      for (const stmt of policySqlFor(table)) await pool.query(stmt);
    }

    const allowlist = parseRlsEnabledTables();
    const { rows: enabledRows } = await pool.query<{ relname: string }>(`
      SELECT relname FROM pg_class WHERE relkind = 'r' AND relrowsecurity = true
    `);
    const currentlyEnabled = new Set(enabledRows.map((r) => r.relname));

    const desired = tenantTables.filter((t) => allowlist.has(t));
    for (const table of desired) {
      if (!currentlyEnabled.has(table)) {
        await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      }
    }
    for (const table of tenantTables) {
      if (currentlyEnabled.has(table) && !allowlist.has(table)) {
        await pool.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      }
    }

    const unknown = [...allowlist].filter((t) => !tenantTables.includes(t));
    console.log(
      `[migration] RLS policies ready on ${tenantTables.length} tenant tables; ` +
        `enforced: ${desired.length ? desired.join(", ") : "none"}` +
        (unknown.length ? ` (ignored unknown RLS_ENABLED_TABLES: ${unknown.join(", ")})` : ""),
    );
  } catch (err) {
    console.warn("[migration] RLS policy migration skipped:", (err as Error).message);
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

  // ClassPilot groups base table. Some deployments had dependent DDL for
  // group_teachers without the startup safety net for the base groups table.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        teacher_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        period_label TEXT,
        grade_level TEXT,
        group_type TEXT NOT NULL DEFAULT 'teacher_created',
        parent_group_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        archived_at TIMESTAMP,
        school_year TEXT,
        term TEXT,
        google_classroom_course_id TEXT,
        schedule_enabled BOOLEAN NOT NULL DEFAULT false,
        block_start_time TEXT,
        block_end_time TEXT,
        schedule_skipped_date TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS school_year TEXT`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS term TEXT`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS google_classroom_course_id TEXT`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS block_start_time TEXT`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS block_end_time TEXT`);
    await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS schedule_skipped_date TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS groups_school_id_idx ON groups (school_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS groups_teacher_id_idx ON groups (teacher_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS groups_status_idx ON groups (status)`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS groups_school_google_course_unique
      ON groups (school_id, google_classroom_course_id)
      WHERE google_classroom_course_id IS NOT NULL
    `);
    console.log("[migration] groups table ready");
  } catch (err) {
    console.warn("[migration] groups migration skipped:", (err as Error).message);
  }

  // Group membership junction table. Keep this before any group-dependent startup work.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_students (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        assigned_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS group_students_unique ON group_students (group_id, student_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS group_students_group_id_idx ON group_students (group_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS group_students_student_id_idx ON group_students (student_id)`);
    console.log("[migration] group_students table ready");
  } catch (err) {
    console.warn("[migration] group_students migration skipped:", (err as Error).message);
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
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS classpilot_pin_hash TEXT`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS classpilot_pin_encrypted TEXT`);
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
        connected_email TEXT,
        connected_domain TEXT,
        expiry_date TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE google_oauth_tokens ADD COLUMN IF NOT EXISTS connected_email TEXT`);
    await pool.query(`ALTER TABLE google_oauth_tokens ADD COLUMN IF NOT EXISTS connected_domain TEXT`);
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
        bus_route TEXT,
        reason TEXT,
        changed_by TEXT NOT NULL,
        changed_by_role TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        UNIQUE(session_id, student_id)
      )
    `);
    await pool.query(`ALTER TABLE IF EXISTS dismissal_overrides ADD COLUMN IF NOT EXISTS bus_route TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS dismissal_overrides_session_id_idx ON dismissal_overrides (session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS dismissal_overrides_student_id_idx ON dismissal_overrides (student_id)`);
    console.log("[migration] dismissal_overrides table ready");
  } catch (err) {
    console.warn("[migration] dismissal_overrides migration skipped:", (err as Error).message);
  }

  // Dismissal queue stable pickup grouping. Friendly guardian/family labels are
  // still displayed in the UI, but batch actions use these stable keys.
  try {
    await pool.query(`ALTER TABLE IF EXISTS dismissal_queue ADD COLUMN IF NOT EXISTS pickup_group_id TEXT`);
    await pool.query(`ALTER TABLE IF EXISTS dismissal_queue ADD COLUMN IF NOT EXISTS pickup_group_label TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS dismissal_queue_pickup_group_idx ON dismissal_queue (session_id, pickup_group_id)`);
    console.log("[migration] dismissal_queue pickup grouping columns ready");
  } catch (err) {
    console.warn("[migration] dismissal_queue pickup grouping migration skipped:", (err as Error).message);
  }

  // Dismissal change acknowledgment fields (read/ack is separate from review).
  try {
    await pool.query(`ALTER TABLE IF EXISTS dismissal_changes ADD COLUMN IF NOT EXISTS acknowledged_by TEXT`);
    await pool.query(`ALTER TABLE IF EXISTS dismissal_changes ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP`);
    console.log("[migration] dismissal_changes acknowledgment columns ready");
  } catch (err) {
    console.warn("[migration] dismissal_changes acknowledgment migration skipped:", (err as Error).message);
  }

  // Add auto_block_unsafe_urls column to settings table
  try {
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_block_unsafe_urls BOOLEAN DEFAULT true`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS parent_transparency_enabled BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS parent_digest_cadence TEXT NOT NULL DEFAULT 'weekly'`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS parent_digest_includes_safety BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS parent_digest_includes_pass_dismissal BOOLEAN DEFAULT true`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS parent_digest_last_sent_at TIMESTAMP`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS shared_chromebook_sign_in_enabled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS central_email_recipient_user_id TEXT`);
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
    await pool.query(`ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS extension_version TEXT`);
    await pool.query(`ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS chrome_version TEXT`);
    await pool.query(`ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS screenshot_health JSONB`);
    await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS extension_version TEXT`);
    await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS chrome_version TEXT`);
    await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_screenshot_health JSONB`);
    await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP`);
    await pool.query(`ALTER TABLE flight_paths ADD COLUMN IF NOT EXISTS source_type TEXT`);
    await pool.query(`ALTER TABLE flight_paths ADD COLUMN IF NOT EXISTS source_course_id TEXT`);
    await pool.query(`ALTER TABLE flight_paths ADD COLUMN IF NOT EXISTS source_resource_ids TEXT[] DEFAULT '{}'::text[]`);
    await pool.query(`ALTER TABLE flight_paths ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMP`);
    console.log("[migration] ClassPilot competitive metadata columns ready");
  } catch (err) {
    console.warn("[migration] heartbeats AI classification migration skipped:", (err as Error).message);
  }

  // ClassPilot competitive safety spine tables
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_safety_cases (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'open',
        opened_by TEXT,
        closed_by TEXT,
        opened_at TIMESTAMP NOT NULL DEFAULT now(),
        closed_at TIMESTAMP,
        summary TEXT,
        metadata JSONB
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_safety_cases_school_status_idx ON student_safety_cases (school_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_safety_cases_student_idx ON student_safety_cases (student_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_safety_cases_opened_idx ON student_safety_cases (opened_at DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_timeline_events (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        case_id TEXT,
        event_type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        severity TEXT,
        actor_user_id TEXT,
        metadata JSONB,
        occurred_at TIMESTAMP NOT NULL DEFAULT now(),
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_timeline_events_school_occurred_idx ON student_timeline_events (school_id, occurred_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_timeline_events_student_occurred_idx ON student_timeline_events (student_id, occurred_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_timeline_events_case_idx ON student_timeline_events (case_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS student_timeline_events_type_idx ON student_timeline_events (event_type)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_ai_decisions (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        student_id TEXT,
        device_id TEXT,
        heartbeat_id TEXT,
        url TEXT,
        title TEXT,
        domain TEXT,
        category TEXT,
        safety_alert TEXT,
        confidence INTEGER,
        reasoning TEXT,
        matched_rule TEXT,
        action_taken TEXT,
        teacher_intent_source TEXT,
        review_status TEXT,
        review_note TEXT,
        reviewed_by TEXT,
        reviewed_at TIMESTAMP,
        metadata JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_ai_decisions_school_created_idx ON classpilot_ai_decisions (school_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_ai_decisions_student_created_idx ON classpilot_ai_decisions (student_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_ai_decisions_heartbeat_idx ON classpilot_ai_decisions (heartbeat_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_ai_decisions_review_idx ON classpilot_ai_decisions (review_status)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS evidence_artifacts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        case_id TEXT,
        source_type TEXT NOT NULL,
        source_id TEXT,
        artifact_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available',
        label TEXT,
        content_type TEXT,
        content TEXT,
        metadata JSONB,
        captured_at TIMESTAMP NOT NULL DEFAULT now(),
        created_by TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS evidence_artifacts_school_student_idx ON evidence_artifacts (school_id, student_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS evidence_artifacts_case_idx ON evidence_artifacts (case_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS evidence_artifacts_source_idx ON evidence_artifacts (source_type, source_id)`);
    await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS evidence_artifacts_artifact_captured_idx`);
    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS evidence_artifacts_purge_idx ON evidence_artifacts (captured_at) WHERE artifact_type = 'screenshot' AND content IS NOT NULL`);
    console.log("[migration] ClassPilot competitive safety spine tables ready");
  } catch (err) {
    console.warn("[migration] ClassPilot competitive safety spine migration skipped:", (err as Error).message);
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
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS mailpilot_entitled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS classpilot_email_monitoring BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS mailpilot_org_units TEXT`);
    await pool.query(`UPDATE schools SET mailpilot_entitled = true WHERE classpilot_email_monitoring = true AND mailpilot_entitled = false`);
    console.log("[migration] MailPilot entitlement columns ready");
  } catch (err) {
    console.warn("[migration] classpilot_email_monitoring migration skipped:", (err as Error).message);
  }

  // PassPilot kiosk PIN (bcrypt hash; required by the public kiosk endpoints)
  try {
    await pool.query(`ALTER TABLE schools ADD COLUMN IF NOT EXISTS kiosk_pin_hash TEXT`);
    console.log("[migration] kiosk_pin_hash column ready");
  } catch (err) {
    console.warn("[migration] kiosk_pin_hash migration skipped:", (err as Error).message);
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
    const { rowCount } = await schedulerPool.query(`UPDATE students SET email_lc = LOWER(email) WHERE email IS NOT NULL AND email_lc IS NULL`);
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
    // RLS-exempt pool: cross-school cleanup DML with no request GUC.
    await schedulerPool.query(`
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
    await schedulerPool.query(`
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
    await schedulerPool.query(`
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
    await schedulerPool.query(`
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
    await schedulerPool.query(`
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

  // Error logs — durable copy of every tracked error (the ErrorMonitor only
  // keeps a 5-minute in-memory window). Lets a developer pinpoint the exact
  // request/user/school/line that failed long after the fact.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT,
        request_id TEXT,
        method TEXT,
        path TEXT,
        status_code INTEGER,
        school_id TEXT,
        user_id TEXT,
        context JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS error_logs_created_at_idx ON error_logs (created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS error_logs_category_idx ON error_logs (category)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS error_logs_request_id_idx ON error_logs (request_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS error_logs_school_id_idx ON error_logs (school_id)`);
    console.log("[migration] error_logs table ready");
  } catch (err) {
    console.warn("[migration] error_logs migration skipped:", (err as Error).message);
  }

  // Import runs — durable outcome of every roster import (counts + per-row
  // failures + zero-result warnings) so a botched import can be pinpointed.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS import_runs (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        user_id TEXT,
        request_id TEXT,
        source TEXT NOT NULL,
        scope TEXT,
        total_found INTEGER NOT NULL DEFAULT 0,
        imported INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        failures JSONB,
        warnings JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS import_runs_school_created_idx ON import_runs (school_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS import_runs_created_at_idx ON import_runs (created_at)`);
    console.log("[migration] import_runs table ready");
  } catch (err) {
    console.warn("[migration] import_runs migration skipped:", (err as Error).message);
  }

  // PassPilot: guarantee at most ONE active pass per student per school.
  // First collapse any pre-existing duplicates (race could have created them):
  // keep the newest active pass, mark the rest expired. Then enforce with a
  // partial unique index so the DB rejects a concurrent double-issue.
  try {
    // RLS-exempt pool: cross-school dedup DML with no request GUC.
    const dedup = await schedulerPool.query(`
      UPDATE passes SET status = 'expired'
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY student_id, school_id ORDER BY issued_at DESC
          ) AS rn
          FROM passes WHERE status = 'active'
        ) ranked WHERE rn > 1
      )
    `);
    if ((dedup.rowCount || 0) > 0) {
      console.log(`[migration] collapsed ${dedup.rowCount} duplicate active passes before constraint`);
    }
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS passes_one_active_per_student
      ON passes (student_id, school_id) WHERE status = 'active'
    `);
    // Verify the constraint actually exists — the route's 23505 handling
    // depends on it. If it's missing, surface a loud warning (the route's
    // getActivePassForStudent pre-check still prevents the common case).
    const idx = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'passes_one_active_per_student'`
    );
    if (idx.rowCount && idx.rowCount > 0) {
      console.log("[migration] passes one-active-per-student constraint ready");
    } else {
      console.warn("[migration] WARNING: passes one-active-per-student index NOT present after creation");
    }
  } catch (err) {
    console.warn("[migration] passes active-unique migration skipped:", (err as Error).message);
  }
}

async function startServer(): Promise<void> {
  if (migrationsOnStartup()) {
    await runStartupMigrations();
  } else {
    console.log("[startup] RUN_MIGRATIONS_ON_STARTUP=false; skipping startup migrations");
  }

  // node-postgres does not proactively create its configured minimum. Verify
  // the full API main-pool cohort before accepting traffic; worker-role and
  // migration-only processes retain their existing non-prewarmed behavior.
  const prewarmedMainClients = await prewarmMainPool();
  if (prewarmedMainClients > 0) {
    console.log(`[startup] prewarmed ${prewarmedMainClients} main database connections`);
  }

  const app = createApp();
  const server = http.createServer(app);
  httpServer = server;

  // Attach Socket.io for real-time events (GoPilot dismissal, etc.)
  const io = setupSocketIO(server);
  socketIoServer = io;
  console.log("Socket.io attached");

  // Attach WebSocket server for ClassPilot device monitoring
  const wss = setupWebSocket(server);
  webSocketServer = wss;
  console.log("WebSocket server attached at /ws");

  // Production API tasks set SCHEDULER_ENABLED=false; a singleton worker runs it.
  if (schedulerEnabled()) {
    startScheduler(io);
  } else {
    console.log("[startup] SCHEDULER_ENABLED=false; scheduler disabled in this task");
  }

  // Start health monitoring after startup migrations complete.
  startHealthMonitor(wss);

  server.listen(PORT, () => {
    console.log(`SchoolPilot API running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
}

async function runMigrationsAndExit(): Promise<void> {
  await runStartupMigrations();
  errorMonitor.dispose();
  await Promise.allSettled([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  console.log("[migration] startup migrations complete");
  process.exit(0);
}

if (migrationsOnly()) {
  runMigrationsAndExit().catch((err) => {
    console.error("[migration] startup migrations failed:", err);
    process.exit(1);
  });
} else {
  startServer().catch((err) => {
    void fatalShutdown("startupFailure", err instanceof Error ? err : new Error(String(err)));
  });
}
