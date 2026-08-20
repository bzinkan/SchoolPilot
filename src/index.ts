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
import { ensureHeartbeatHistoryIndexOnline } from "./db/heartbeatHistoryIndex.js";
import { resolveEcsApiRuntimeIdentity } from "./services/ecsRuntimeIdentity.js";
import { bindHeartbeatHotPathApiRuntimeTaskDefinitionSha256 } from "./services/heartbeatHotPathMetrics.js";

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

async function flushHeartbeatClassificationWrites(): Promise<void> {
  const { flushHeartbeatClassificationBatches } = await import(
    "./services/heartbeatClassificationBatcher.js"
  );
  await flushHeartbeatClassificationBatches();
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
  }, 15_000);

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
  await bounded(
    flushHeartbeatClassificationWrites(),
    3_000,
    "heartbeat classification flush"
  );
  await bounded(Promise.allSettled([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]).then(() => undefined), 4_000, "database pool shutdown");

  clearTimeout(forceExit);
  process.exit(1);
}

async function gracefulShutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  if (fatalShutdownStarted) return;
  fatalShutdownStarted = true;
  process.exitCode = 0;
  const forceExit = setTimeout(() => {
    console.error(`[shutdown] Force exiting after ${signal} timeout`);
    process.exit(1);
  }, 15_000);

  console.log(`[shutdown] ${signal} received; draining service`);
  stopScheduler();
  stopHealthMonitor();
  await bounded(
    Promise.allSettled([
      closeHttpServer(),
      closeSocketIo(),
      closeWebSocketServer(),
    ]).then(() => undefined),
    4_000,
    "server shutdown"
  );
  await bounded(
    flushHeartbeatClassificationWrites(),
    3_000,
    "heartbeat classification flush"
  );
  errorMonitor.dispose();
  await bounded(
    Promise.allSettled([
      pool.end(),
      sessionPool.end(),
      schedulerPool.end(),
      schedulerLockPool.end(),
    ]).then(() => undefined),
    4_000,
    "database pool shutdown"
  );
  clearTimeout(forceExit);
  process.exit(0);
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

process.once("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void gracefulShutdown("SIGINT");
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

    const trialEndsAtColumn = await schedulerPool.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'schools'
          AND column_name = 'trial_ends_at'
      ) AS exists
    `);
    const normalized = trialEndsAtColumn.rows[0]?.exists
      ? await schedulerPool.query(`
          UPDATE schools
          SET
            status = CASE WHEN status = 'trial' THEN 'active' ELSE status END,
            plan_tier = CASE WHEN plan_tier = 'trial' THEN 'basic' ELSE plan_tier END,
            trial_ends_at = NULL,
            updated_at = now()
          WHERE status = 'trial' OR plan_tier = 'trial' OR trial_ends_at IS NOT NULL
        `)
      : await schedulerPool.query(`
          UPDATE schools
          SET
            status = CASE WHEN status = 'trial' THEN 'active' ELSE status END,
            plan_tier = CASE WHEN plan_tier = 'trial' THEN 'basic' ELSE plan_tier END,
            updated_at = now()
          WHERE status = 'trial' OR plan_tier = 'trial'
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

  // The ClassPilot automatic scheduler must have an authoritative school-day
  // calendar before API/worker rollout. This is required runtime infrastructure,
  // so a DDL failure aborts the one-off migration task instead of silently
  // treating configured closures as instructional days.
  await pool.query(`
    ALTER TABLE settings
    ADD COLUMN IF NOT EXISTS instructional_calendar JSONB NOT NULL DEFAULT '{}'::jsonb
  `);
  await schedulerPool.query(`
    UPDATE settings
    SET instructional_calendar = '{}'::jsonb
    WHERE instructional_calendar IS NULL
  `);
  await pool.query(`
    ALTER TABLE settings
      ALTER COLUMN instructional_calendar SET DEFAULT '{}'::jsonb,
      ALTER COLUMN instructional_calendar SET NOT NULL
  `);
  const missingInstructionalCalendarSettings = await schedulerPool.query(`
    SELECT count(*)::integer AS missing_count
    FROM schools AS school
    LEFT JOIN settings AS school_settings ON school_settings.school_id = school.id
    WHERE school_settings.school_id IS NULL
  `);
  const missingInstructionalCalendarSettingsCount = Number(
    missingInstructionalCalendarSettings.rows[0]?.missing_count ?? 0
  );
  if (missingInstructionalCalendarSettingsCount > 0) {
    throw new Error(
      `ClassPilot instructional calendar settings integrity check failed (${missingInstructionalCalendarSettingsCount} schools missing settings)`
    );
  }
  console.log("[migration] ClassPilot instructional calendar settings ready");

  // Schedule-change tenant foreign keys depend on the official ClassPilot
  // groups table. Older databases may predate the later compatibility safety
  // net, so create/converge the base before any schedule-change index or FK.
  // This block is deliberately fail-closed.
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
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT groups_school_id_id_fk_key UNIQUE (school_id, id)
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

  // One-day ClassPilot schedule changes are additive overlays on recurring
  // class windows. These settings and tables are required by both the API and
  // scheduler, so fail the migration task rather than serving a partial model.
  await pool.query(`
    ALTER TABLE settings
      ADD COLUMN IF NOT EXISTS classpilot_schedule_changes_teacher_requests_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS classpilot_schedule_changes_admin_approval_required BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS classpilot_schedule_changes_same_day_cutoff TEXT NOT NULL DEFAULT '07:00',
      ADD COLUMN IF NOT EXISTS classpilot_schedule_changes_same_day_cutoff_enforced BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS classpilot_schedule_changes_reason_required BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS classpilot_schedule_changes_revision INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE settings
      DROP CONSTRAINT IF EXISTS settings_cp_schedule_change_cutoff_check,
      DROP CONSTRAINT IF EXISTS settings_cp_schedule_change_revision_check
  `);
  await pool.query(`
    ALTER TABLE settings
      ADD CONSTRAINT settings_cp_schedule_change_cutoff_check
        CHECK (classpilot_schedule_changes_same_day_cutoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
      ADD CONSTRAINT settings_cp_schedule_change_revision_check
        CHECK (classpilot_schedule_changes_revision >= 0)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS groups_school_id_id_unique
    ON groups (school_id, id)
  `);
  await pool.query(`
    DO $groups_school_id_id_fk_key$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'groups_school_id_id_fk_key'
          AND conrelid = 'groups'::regclass
      ) THEN
        ALTER TABLE groups
          ADD CONSTRAINT groups_school_id_id_fk_key UNIQUE (school_id, id);
      END IF;
    END
    $groups_school_id_id_fk_key$;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_schedule_change_pairs (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      first_group_id TEXT NOT NULL,
      second_group_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      archived_by TEXT,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT cp_schedule_change_pairs_group_order_check
        CHECK (first_group_id < second_group_id),
      CONSTRAINT cp_schedule_change_pairs_status_check
        CHECK (status IN ('active', 'archived')),
      CONSTRAINT cp_schedule_change_pairs_revision_check CHECK (revision >= 0),
      CONSTRAINT cp_schedule_change_pairs_school_id_fk_key UNIQUE (school_id, id),
      CONSTRAINT cp_schedule_change_pairs_first_group_school_fk
        FOREIGN KEY (school_id, first_group_id)
        REFERENCES groups(school_id, id) ON DELETE RESTRICT,
      CONSTRAINT cp_schedule_change_pairs_second_group_school_fk
        FOREIGN KEY (school_id, second_group_id)
        REFERENCES groups(school_id, id) ON DELETE RESTRICT
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cp_schedule_change_pairs_school_groups_unique
    ON classpilot_schedule_change_pairs (school_id, first_group_id, second_group_id)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cp_schedule_change_pairs_school_id_unique
    ON classpilot_schedule_change_pairs (school_id, id)
  `);
  await pool.query(`
    DO $cp_schedule_change_pairs_school_id_fk_key$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cp_schedule_change_pairs_school_id_fk_key'
          AND conrelid = 'classpilot_schedule_change_pairs'::regclass
      ) THEN
        ALTER TABLE classpilot_schedule_change_pairs
          ADD CONSTRAINT cp_schedule_change_pairs_school_id_fk_key UNIQUE (school_id, id);
      END IF;
    END
    $cp_schedule_change_pairs_school_id_fk_key$;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS cp_schedule_change_pairs_school_status_idx
    ON classpilot_schedule_change_pairs (school_id, status)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_schedule_changes (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      pair_id VARCHAR NOT NULL,
      scheduled_date TEXT NOT NULL,
      timezone_snapshot TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL,
      requester_group_id TEXT,
      counterpart_teacher_id TEXT,
      requested_by_role TEXT NOT NULL,
      requires_admin_approval BOOLEAN NOT NULL,
      reservation_active BOOLEAN NOT NULL DEFAULT true,
      revision INTEGER NOT NULL DEFAULT 0,
      accepted_by_user_id TEXT,
      accepted_at TIMESTAMPTZ,
      approved_by_user_id TEXT,
      approved_at TIMESTAMPTZ,
      terminal_by_user_id TEXT,
      terminal_reason TEXT,
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT cp_schedule_changes_pair_school_fk
        FOREIGN KEY (school_id, pair_id)
        REFERENCES classpilot_schedule_change_pairs(school_id, id) ON DELETE RESTRICT,
      CONSTRAINT cp_schedule_changes_status_check
        CHECK (status IN ('pending_counterpart', 'pending_admin', 'approved', 'declined', 'denied', 'cancelled', 'expired', 'superseded')),
      CONSTRAINT cp_schedule_changes_reason_check
        CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
      CONSTRAINT cp_schedule_changes_date_check
        CHECK (scheduled_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      CONSTRAINT cp_schedule_changes_revision_check CHECK (revision >= 0),
      CONSTRAINT cp_schedule_changes_school_id_date_fk_key
        UNIQUE (school_id, id, scheduled_date),
      CONSTRAINT cp_schedule_changes_reservation_check
        CHECK ((status IN ('pending_counterpart', 'pending_admin', 'approved')) = reservation_active)
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cp_schedule_changes_school_id_unique
    ON classpilot_schedule_changes (school_id, id)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cp_schedule_changes_school_id_date_unique
    ON classpilot_schedule_changes (school_id, id, scheduled_date)
  `);
  await pool.query(`
    DO $cp_schedule_changes_school_id_date_fk_key$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cp_schedule_changes_school_id_date_fk_key'
          AND conrelid = 'classpilot_schedule_changes'::regclass
      ) THEN
        ALTER TABLE classpilot_schedule_changes
          ADD CONSTRAINT cp_schedule_changes_school_id_date_fk_key
          UNIQUE (school_id, id, scheduled_date);
      END IF;
    END
    $cp_schedule_changes_school_id_date_fk_key$;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS cp_schedule_changes_school_date_status_idx
    ON classpilot_schedule_changes (school_id, scheduled_date, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS cp_schedule_changes_school_requester_idx
    ON classpilot_schedule_changes (school_id, requested_by_user_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_schedule_change_legs (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      schedule_change_id VARCHAR NOT NULL,
      scheduled_date TEXT NOT NULL,
      leg_order INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      primary_teacher_id_snapshot TEXT NOT NULL,
      class_name_snapshot TEXT NOT NULL,
      original_start_time TEXT NOT NULL,
      original_end_time TEXT NOT NULL,
      effective_start_time TEXT NOT NULL,
      effective_end_time TEXT NOT NULL,
      reservation_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT cp_schedule_change_legs_change_school_fk
        FOREIGN KEY (school_id, schedule_change_id, scheduled_date)
        REFERENCES classpilot_schedule_changes(school_id, id, scheduled_date) ON DELETE RESTRICT,
      CONSTRAINT cp_schedule_change_legs_group_school_fk
        FOREIGN KEY (school_id, group_id)
        REFERENCES groups(school_id, id) ON DELETE RESTRICT,
      CONSTRAINT cp_schedule_change_legs_order_check CHECK (leg_order IN (1, 2)),
      CONSTRAINT cp_schedule_change_legs_date_check
        CHECK (scheduled_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      CONSTRAINT cp_schedule_change_legs_window_check CHECK (
        original_start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND original_end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND effective_start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND effective_end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND original_start_time < original_end_time
        AND effective_start_time < effective_end_time
      )
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cp_schedule_change_legs_change_order_unique
    ON classpilot_schedule_change_legs (schedule_change_id, leg_order)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cp_schedule_change_legs_change_group_unique
    ON classpilot_schedule_change_legs (schedule_change_id, group_id)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS cp_schedule_change_legs_active_group_date_unique
    ON classpilot_schedule_change_legs (school_id, scheduled_date, group_id)
    WHERE reservation_active = true
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS cp_schedule_change_legs_school_change_idx
    ON classpilot_schedule_change_legs (school_id, schedule_change_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS cp_schedule_change_legs_school_group_date_idx
    ON classpilot_schedule_change_legs (school_id, group_id, scheduled_date)
  `);
  // `db:push` may create these tables before startup runs. Add the tenant-aware
  // foreign keys separately from CREATE TABLE so both creation paths converge.
  await pool.query(`
    DO $cp_schedule_change_foreign_keys$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cp_schedule_change_pairs_first_group_school_fk'
          AND conrelid = 'classpilot_schedule_change_pairs'::regclass
      ) THEN
        ALTER TABLE classpilot_schedule_change_pairs
          ADD CONSTRAINT cp_schedule_change_pairs_first_group_school_fk
          FOREIGN KEY (school_id, first_group_id)
          REFERENCES groups(school_id, id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cp_schedule_change_pairs_second_group_school_fk'
          AND conrelid = 'classpilot_schedule_change_pairs'::regclass
      ) THEN
        ALTER TABLE classpilot_schedule_change_pairs
          ADD CONSTRAINT cp_schedule_change_pairs_second_group_school_fk
          FOREIGN KEY (school_id, second_group_id)
          REFERENCES groups(school_id, id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cp_schedule_changes_pair_school_fk'
          AND conrelid = 'classpilot_schedule_changes'::regclass
      ) THEN
        ALTER TABLE classpilot_schedule_changes
          ADD CONSTRAINT cp_schedule_changes_pair_school_fk
          FOREIGN KEY (school_id, pair_id)
          REFERENCES classpilot_schedule_change_pairs(school_id, id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cp_schedule_change_legs_change_school_fk'
          AND conrelid = 'classpilot_schedule_change_legs'::regclass
      ) THEN
        ALTER TABLE classpilot_schedule_change_legs
          ADD CONSTRAINT cp_schedule_change_legs_change_school_fk
          FOREIGN KEY (school_id, schedule_change_id, scheduled_date)
          REFERENCES classpilot_schedule_changes(school_id, id, scheduled_date) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cp_schedule_change_legs_group_school_fk'
          AND conrelid = 'classpilot_schedule_change_legs'::regclass
      ) THEN
        ALTER TABLE classpilot_schedule_change_legs
          ADD CONSTRAINT cp_schedule_change_legs_group_school_fk
          FOREIGN KEY (school_id, group_id)
          REFERENCES groups(school_id, id) ON DELETE RESTRICT;
      END IF;
    END
    $cp_schedule_change_foreign_keys$;
  `);
  // Converge db:push-created or partially provisioned tables to the reviewed
  // production contract. These additions validate existing rows immediately;
  // invalid tenant links or legacy values abort rollout rather than remaining
  // as NOT VALID constraints.
  await pool.query(`
    ALTER TABLE classpilot_schedule_change_legs
      DROP CONSTRAINT IF EXISTS cp_schedule_change_legs_change_school_fk,
      DROP CONSTRAINT IF EXISTS cp_schedule_change_legs_group_school_fk;
    ALTER TABLE classpilot_schedule_changes
      DROP CONSTRAINT IF EXISTS cp_schedule_changes_pair_school_fk;
    ALTER TABLE classpilot_schedule_change_pairs
      DROP CONSTRAINT IF EXISTS cp_schedule_change_pairs_first_group_school_fk,
      DROP CONSTRAINT IF EXISTS cp_schedule_change_pairs_second_group_school_fk;

    ALTER TABLE classpilot_schedule_change_pairs
      DROP CONSTRAINT IF EXISTS cp_schedule_change_pairs_group_order_check,
      DROP CONSTRAINT IF EXISTS cp_schedule_change_pairs_status_check,
      DROP CONSTRAINT IF EXISTS cp_schedule_change_pairs_revision_check,
      ADD CONSTRAINT cp_schedule_change_pairs_group_order_check
        CHECK (first_group_id < second_group_id),
      ADD CONSTRAINT cp_schedule_change_pairs_status_check
        CHECK (status IN ('active', 'archived')),
      ADD CONSTRAINT cp_schedule_change_pairs_revision_check CHECK (revision >= 0),
      ADD CONSTRAINT cp_schedule_change_pairs_first_group_school_fk
        FOREIGN KEY (school_id, first_group_id)
        REFERENCES groups(school_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT cp_schedule_change_pairs_second_group_school_fk
        FOREIGN KEY (school_id, second_group_id)
        REFERENCES groups(school_id, id) ON DELETE RESTRICT;

    ALTER TABLE classpilot_schedule_changes
      DROP CONSTRAINT IF EXISTS cp_schedule_changes_status_check,
      DROP CONSTRAINT IF EXISTS cp_schedule_changes_reason_check,
      DROP CONSTRAINT IF EXISTS cp_schedule_changes_date_check,
      DROP CONSTRAINT IF EXISTS cp_schedule_changes_revision_check,
      DROP CONSTRAINT IF EXISTS cp_schedule_changes_reservation_check,
      ADD CONSTRAINT cp_schedule_changes_pair_school_fk
        FOREIGN KEY (school_id, pair_id)
        REFERENCES classpilot_schedule_change_pairs(school_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT cp_schedule_changes_status_check
        CHECK (status IN ('pending_counterpart', 'pending_admin', 'approved', 'declined', 'denied', 'cancelled', 'expired', 'superseded')),
      ADD CONSTRAINT cp_schedule_changes_reason_check
        CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
      ADD CONSTRAINT cp_schedule_changes_date_check
        CHECK (scheduled_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      ADD CONSTRAINT cp_schedule_changes_revision_check CHECK (revision >= 0),
      ADD CONSTRAINT cp_schedule_changes_reservation_check
        CHECK ((status IN ('pending_counterpart', 'pending_admin', 'approved')) = reservation_active);

    ALTER TABLE classpilot_schedule_change_legs
      DROP CONSTRAINT IF EXISTS cp_schedule_change_legs_order_check,
      DROP CONSTRAINT IF EXISTS cp_schedule_change_legs_date_check,
      DROP CONSTRAINT IF EXISTS cp_schedule_change_legs_window_check,
      ADD CONSTRAINT cp_schedule_change_legs_change_school_fk
        FOREIGN KEY (school_id, schedule_change_id, scheduled_date)
        REFERENCES classpilot_schedule_changes(school_id, id, scheduled_date) ON DELETE RESTRICT,
      ADD CONSTRAINT cp_schedule_change_legs_group_school_fk
        FOREIGN KEY (school_id, group_id)
        REFERENCES groups(school_id, id) ON DELETE RESTRICT,
      ADD CONSTRAINT cp_schedule_change_legs_order_check CHECK (leg_order IN (1, 2)),
      ADD CONSTRAINT cp_schedule_change_legs_date_check
        CHECK (scheduled_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      ADD CONSTRAINT cp_schedule_change_legs_window_check CHECK (
        original_start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND original_end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND effective_start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND effective_end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND original_start_time < original_end_time
        AND effective_start_time < effective_end_time
      );
  `);
  // PassPilot per-device kiosk sessions: replaces the school-global kiosk slot
  // (schools.kiosk_grade_id / kiosk_classpilot_group_id) with one row per kiosk
  // device, bound to a specific teacher via a claim code. No FKs to
  // grades/groups/users on purpose — sessions are ephemeral device bindings and
  // class/teacher liveness is validated at claim/read time, mirroring the
  // school-row kiosk columns this table supersedes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS passpilot_kiosk_sessions (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      claim_code TEXT NOT NULL,
      teacher_id TEXT,
      class_source TEXT,
      grade_id TEXT,
      classpilot_group_id TEXT,
      status TEXT NOT NULL DEFAULT 'unclaimed',
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      released_at TIMESTAMPTZ,
      CONSTRAINT pp_kiosk_sessions_status_check
        CHECK (status IN ('unclaimed', 'active', 'released')),
      CONSTRAINT pp_kiosk_sessions_revision_check CHECK (revision >= 0),
      CONSTRAINT pp_kiosk_sessions_class_source_check
        CHECK (class_source IS NULL OR class_source IN ('legacy_grades', 'classpilot_groups')),
      CONSTRAINT pp_kiosk_sessions_single_class_check
        CHECK (NOT (grade_id IS NOT NULL AND classpilot_group_id IS NOT NULL)),
      CONSTRAINT pp_kiosk_sessions_unclaimed_shape_check
        CHECK (status <> 'unclaimed' OR (
          teacher_id IS NULL AND class_source IS NULL
          AND grade_id IS NULL AND classpilot_group_id IS NULL
        )),
      CONSTRAINT pp_kiosk_sessions_active_shape_check
        CHECK (status <> 'active' OR (teacher_id IS NOT NULL AND (
          (class_source IS NULL AND grade_id IS NULL AND classpilot_group_id IS NULL) OR
          (class_source = 'legacy_grades' AND grade_id IS NOT NULL AND classpilot_group_id IS NULL) OR
          (class_source = 'classpilot_groups' AND classpilot_group_id IS NOT NULL AND grade_id IS NULL)
        ))),
      CONSTRAINT pp_kiosk_sessions_school_id_fk_key UNIQUE (school_id, id)
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS pp_kiosk_sessions_school_claim_code_unique
    ON passpilot_kiosk_sessions (school_id, claim_code) WHERE status <> 'released'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS pp_kiosk_sessions_school_teacher_status_idx
    ON passpilot_kiosk_sessions (school_id, teacher_id, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS pp_kiosk_sessions_school_status_last_seen_idx
    ON passpilot_kiosk_sessions (school_id, status, last_seen_at)
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION classpilot_protect_schedule_change_leg_snapshot()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public
    AS $cp_schedule_change_leg_immutable$
    BEGIN
      IF NEW.school_id IS DISTINCT FROM OLD.school_id
        OR NEW.schedule_change_id IS DISTINCT FROM OLD.schedule_change_id
        OR NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date
        OR NEW.leg_order IS DISTINCT FROM OLD.leg_order
        OR NEW.group_id IS DISTINCT FROM OLD.group_id
        OR NEW.primary_teacher_id_snapshot IS DISTINCT FROM OLD.primary_teacher_id_snapshot
        OR NEW.class_name_snapshot IS DISTINCT FROM OLD.class_name_snapshot
        OR NEW.original_start_time IS DISTINCT FROM OLD.original_start_time
        OR NEW.original_end_time IS DISTINCT FROM OLD.original_end_time
        OR NEW.effective_start_time IS DISTINCT FROM OLD.effective_start_time
        OR NEW.effective_end_time IS DISTINCT FROM OLD.effective_end_time
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR (
          NEW.reservation_active IS DISTINCT FROM OLD.reservation_active
          AND NOT (OLD.reservation_active = true AND NEW.reservation_active = false)
        )
      THEN
        RAISE EXCEPTION 'ClassPilot schedule change legs are immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $cp_schedule_change_leg_immutable$;
    DROP TRIGGER IF EXISTS cp_schedule_change_legs_immutable_snapshot
      ON classpilot_schedule_change_legs;
    CREATE TRIGGER cp_schedule_change_legs_immutable_snapshot
      BEFORE UPDATE ON classpilot_schedule_change_legs
      FOR EACH ROW EXECUTE FUNCTION classpilot_protect_schedule_change_leg_snapshot();
  `);
  // PostgreSQL cannot express "exactly two child rows" as a normal CHECK.
  // A deferred constraint trigger validates the invariant at transaction commit,
  // after the service has inserted both legs atomically.
  await pool.query(`
    CREATE OR REPLACE FUNCTION classpilot_validate_schedule_change_leg_count()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public
    AS $cp_schedule_change_leg_count$
    DECLARE
      target_change_id TEXT;
      leg_count INTEGER;
    BEGIN
      IF TG_TABLE_NAME = 'classpilot_schedule_changes' THEN
        target_change_id := COALESCE(NEW.id, OLD.id);
      ELSE
        target_change_id := COALESCE(NEW.schedule_change_id, OLD.schedule_change_id);
      END IF;
      IF EXISTS (SELECT 1 FROM classpilot_schedule_changes WHERE id = target_change_id) THEN
        SELECT count(*)::integer INTO leg_count
        FROM classpilot_schedule_change_legs
        WHERE schedule_change_id = target_change_id;
        IF leg_count <> 2 THEN
          RAISE EXCEPTION 'ClassPilot schedule change must contain exactly two legs'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN COALESCE(NEW, OLD);
    END
    $cp_schedule_change_leg_count$;
    DROP TRIGGER IF EXISTS cp_schedule_changes_exactly_two_legs
      ON classpilot_schedule_changes;
    CREATE CONSTRAINT TRIGGER cp_schedule_changes_exactly_two_legs
      AFTER INSERT OR UPDATE ON classpilot_schedule_changes
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION classpilot_validate_schedule_change_leg_count();
    DROP TRIGGER IF EXISTS cp_schedule_change_legs_exactly_two
      ON classpilot_schedule_change_legs;
    CREATE CONSTRAINT TRIGGER cp_schedule_change_legs_exactly_two
      AFTER INSERT OR UPDATE OR DELETE ON classpilot_schedule_change_legs
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION classpilot_validate_schedule_change_leg_count();
  `);
  const scheduleChangeIndexResult = await pool.query<{
    indexname: string;
    indexdef: string;
  }>(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename IN (
        'classpilot_schedule_change_pairs',
        'classpilot_schedule_changes',
        'classpilot_schedule_change_legs'
      )
  `);
  const scheduleChangeIndexDefinitions = new Map(
    scheduleChangeIndexResult.rows.map((row) => [
      row.indexname,
      row.indexdef.toLowerCase().replace(/\s+/g, " "),
    ])
  );
  const requiredScheduleChangeIndexes: Record<string, string[]> = {
    cp_schedule_change_pairs_school_groups_unique: [
      "create unique index",
      "(school_id, first_group_id, second_group_id)",
    ],
    cp_schedule_change_pairs_school_id_unique: [
      "create unique index",
      "(school_id, id)",
    ],
    cp_schedule_changes_school_id_unique: [
      "create unique index",
      "(school_id, id)",
    ],
    cp_schedule_changes_school_id_date_unique: [
      "create unique index",
      "(school_id, id, scheduled_date)",
    ],
    cp_schedule_change_legs_change_order_unique: [
      "create unique index",
      "(schedule_change_id, leg_order)",
    ],
    cp_schedule_change_legs_change_group_unique: [
      "create unique index",
      "(schedule_change_id, group_id)",
    ],
    cp_schedule_change_legs_active_group_date_unique: [
      "create unique index",
      "(school_id, scheduled_date, group_id)",
      "where (reservation_active = true)",
    ],
  };
  for (const [indexName, requiredFragments] of Object.entries(requiredScheduleChangeIndexes)) {
    const definition = scheduleChangeIndexDefinitions.get(indexName);
    if (!definition || requiredFragments.some((fragment) => !definition.includes(fragment))) {
      throw new Error(
        `ClassPilot schedule-change index contract is invalid: ${indexName}`
      );
    }
  }
  const malformedScheduleChangeResult = await pool.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM classpilot_schedule_changes change
    LEFT JOIN classpilot_schedule_change_legs leg
      ON leg.school_id = change.school_id
     AND leg.schedule_change_id = change.id
     AND leg.scheduled_date = change.scheduled_date
    GROUP BY change.id
    HAVING count(leg.id) <> 2
    LIMIT 1
  `);
  if (malformedScheduleChangeResult.rows.length > 0) {
    throw new Error("ClassPilot schedule-change leg-count integrity check failed");
  }
  console.log("[migration] ClassPilot schedule-change settings and tables ready");

  // PassPilot canonical ClassPilot-class compatibility is required before a
  // dual-license school can switch writes away from the legacy grades model.
  // This block is intentionally fail-closed: partial DDL, invalid mappings, or
  // a missing index/constraint must abort the migration task before API/worker
  // rollout. Existing grade/pass rows remain intact and default to legacy mode.
  await pool.query(`
    ALTER TABLE settings
      ADD COLUMN IF NOT EXISTS passpilot_class_source TEXT NOT NULL DEFAULT 'legacy_grades',
      ADD COLUMN IF NOT EXISTS passpilot_class_cutover_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS passpilot_class_migration_revision INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS passpilot_canonical_writes_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE schools
      ADD COLUMN IF NOT EXISTS kiosk_classpilot_group_id VARCHAR,
      ADD COLUMN IF NOT EXISTS passpilot_settings_revision INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS kiosk_style TEXT NOT NULL DEFAULT 'simple'
  `);
  await pool.query(`
    ALTER TABLE grades
      ADD COLUMN IF NOT EXISTS classpilot_group_id TEXT,
      ADD COLUMN IF NOT EXISTS migration_state TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS mapping_revision INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS mapping_method TEXT,
      ADD COLUMN IF NOT EXISTS mapping_reviewer_id TEXT,
      ADD COLUMN IF NOT EXISTS mapped_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE passes
      ADD COLUMN IF NOT EXISTS classpilot_group_id TEXT,
      ADD COLUMN IF NOT EXISTS class_name_snapshot TEXT
  `);
  // Legacy PassPilot originally stored one class directly on students. Keep
  // that column as an old-client projection, but back it into a tenant-scoped
  // junction so standalone schools can place a student in multiple classes.
  // This table is created before generic RLS discovery below.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS grade_id TEXT`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS grades_school_id_id_unique
    ON grades (school_id, id)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS students_school_id_id_unique
    ON students (school_id, id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS passpilot_grade_students (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      grade_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT passpilot_grade_students_school_grade_student_unique
        UNIQUE (school_id, grade_id, student_id),
      CONSTRAINT passpilot_grade_students_grade_school_fk
        FOREIGN KEY (school_id, grade_id)
        REFERENCES grades(school_id, id) ON DELETE RESTRICT,
      CONSTRAINT passpilot_grade_students_student_school_fk
        FOREIGN KEY (school_id, student_id)
        REFERENCES students(school_id, id) ON DELETE CASCADE
    )
  `);
  await pool.query(`
    ALTER TABLE passpilot_grade_students
      DROP CONSTRAINT IF EXISTS passpilot_grade_students_grade_fk,
      DROP CONSTRAINT IF EXISTS passpilot_grade_students_student_fk
  `);
  await pool.query(`
    DO $passpilot_grade_student_constraints$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'passpilot_grade_students_grade_school_fk'
          AND conrelid = 'passpilot_grade_students'::regclass
      ) THEN
        ALTER TABLE passpilot_grade_students
          ADD CONSTRAINT passpilot_grade_students_grade_school_fk
          FOREIGN KEY (school_id, grade_id)
          REFERENCES grades(school_id, id) ON DELETE RESTRICT NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'passpilot_grade_students_student_school_fk'
          AND conrelid = 'passpilot_grade_students'::regclass
      ) THEN
        ALTER TABLE passpilot_grade_students
          ADD CONSTRAINT passpilot_grade_students_student_school_fk
          FOREIGN KEY (school_id, student_id)
          REFERENCES students(school_id, id) ON DELETE CASCADE NOT VALID;
      END IF;
    END
    $passpilot_grade_student_constraints$;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS passpilot_grade_students_school_grade_idx
    ON passpilot_grade_students (school_id, grade_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS passpilot_grade_students_school_student_idx
    ON passpilot_grade_students (school_id, student_id)
  `);
  await schedulerPool.query(`
    INSERT INTO passpilot_grade_students (school_id, grade_id, student_id)
    SELECT student.school_id, student.grade_id, student.id
    FROM students AS student
    INNER JOIN grades AS grade
      ON grade.id = student.grade_id
     AND grade.school_id = student.school_id
    WHERE student.grade_id IS NOT NULL
    ON CONFLICT (school_id, grade_id, student_id) DO NOTHING
  `);
  await pool.query(`
    ALTER TABLE passpilot_grade_students
      VALIDATE CONSTRAINT passpilot_grade_students_grade_school_fk
  `);
  await pool.query(`
    ALTER TABLE passpilot_grade_students
      VALIDATE CONSTRAINT passpilot_grade_students_student_school_fk
  `);

  // Recover only nullable values left by an interrupted earlier attempt. Do
  // not normalize contradictory values: the validated checks below must expose
  // them and fail the deployment instead of silently changing operator state.
  await schedulerPool.query(`
    UPDATE settings
    SET
      passpilot_class_source = COALESCE(passpilot_class_source, 'legacy_grades'),
      passpilot_class_migration_revision = COALESCE(passpilot_class_migration_revision, 0)
    WHERE passpilot_class_source IS NULL
       OR passpilot_class_migration_revision IS NULL
  `);
  await schedulerPool.query(`
    UPDATE schools
    SET passpilot_settings_revision = 0
    WHERE passpilot_settings_revision IS NULL
  `);
  await schedulerPool.query(`
    UPDATE schools
    SET kiosk_style = 'simple'
    WHERE kiosk_style IS NULL
  `);
  await schedulerPool.query(`
    UPDATE grades
    SET
      migration_state = COALESCE(migration_state, 'pending'),
      mapping_revision = COALESCE(mapping_revision, 0)
    WHERE migration_state IS NULL
       OR mapping_revision IS NULL
  `);
  await schedulerPool.query(`
    UPDATE passes AS pass
    SET class_name_snapshot = grade.name
    FROM grades AS grade
    WHERE pass.class_name_snapshot IS NULL
      AND pass.grade_id = grade.id
      AND pass.school_id = grade.school_id
  `);

  await pool.query(`
    ALTER TABLE settings
      ALTER COLUMN passpilot_class_source SET DEFAULT 'legacy_grades',
      ALTER COLUMN passpilot_class_source SET NOT NULL,
      ALTER COLUMN passpilot_class_migration_revision SET DEFAULT 0,
      ALTER COLUMN passpilot_class_migration_revision SET NOT NULL
  `);
  await pool.query(`
    ALTER TABLE grades
      ALTER COLUMN migration_state SET DEFAULT 'pending',
      ALTER COLUMN migration_state SET NOT NULL,
      ALTER COLUMN mapping_revision SET DEFAULT 0,
      ALTER COLUMN mapping_revision SET NOT NULL
  `);
  await pool.query(`
    ALTER TABLE schools
      ALTER COLUMN passpilot_settings_revision SET DEFAULT 0,
      ALTER COLUMN passpilot_settings_revision SET NOT NULL,
      ALTER COLUMN kiosk_style SET DEFAULT 'simple',
      ALTER COLUMN kiosk_style SET NOT NULL
  `);

  await pool.query(`
    DO $passpilot_constraints$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'settings_passpilot_class_source_check'
          AND conrelid = 'settings'::regclass
      ) THEN
        ALTER TABLE settings
          ADD CONSTRAINT settings_passpilot_class_source_check
          CHECK (passpilot_class_source IN ('legacy_grades', 'classpilot_groups')) NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'settings_passpilot_class_migration_revision_check'
          AND conrelid = 'settings'::regclass
      ) THEN
        ALTER TABLE settings
          ADD CONSTRAINT settings_passpilot_class_migration_revision_check
          CHECK (passpilot_class_migration_revision >= 0) NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'grades_migration_state_check'
          AND conrelid = 'grades'::regclass
      ) THEN
        ALTER TABLE grades
          ADD CONSTRAINT grades_migration_state_check
          CHECK (migration_state IN ('pending', 'auto_linked', 'confirmed', 'history_only')) NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'grades_mapping_revision_check'
          AND conrelid = 'grades'::regclass
      ) THEN
        ALTER TABLE grades
          ADD CONSTRAINT grades_mapping_revision_check
          CHECK (mapping_revision >= 0) NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'passes_single_class_source_check'
          AND conrelid = 'passes'::regclass
      ) THEN
        ALTER TABLE passes
          ADD CONSTRAINT passes_single_class_source_check
          CHECK (NOT (grade_id IS NOT NULL AND classpilot_group_id IS NOT NULL)) NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'schools_passpilot_settings_revision_check'
          AND conrelid = 'schools'::regclass
      ) THEN
        ALTER TABLE schools
          ADD CONSTRAINT schools_passpilot_settings_revision_check
          CHECK (passpilot_settings_revision >= 0) NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'schools_kiosk_style_check'
          AND conrelid = 'schools'::regclass
      ) THEN
        ALTER TABLE schools
          ADD CONSTRAINT schools_kiosk_style_check
          CHECK (kiosk_style IN ('simple', 'badge')) NOT VALID;
      END IF;
    END
    $passpilot_constraints$;
  `);
  await pool.query(`ALTER TABLE schools VALIDATE CONSTRAINT schools_kiosk_style_check`);
  await pool.query(`ALTER TABLE settings VALIDATE CONSTRAINT settings_passpilot_class_source_check`);
  await pool.query(`ALTER TABLE settings VALIDATE CONSTRAINT settings_passpilot_class_migration_revision_check`);
  await pool.query(`ALTER TABLE grades VALIDATE CONSTRAINT grades_migration_state_check`);
  await pool.query(`ALTER TABLE grades VALIDATE CONSTRAINT grades_mapping_revision_check`);
  await pool.query(`ALTER TABLE passes VALIDATE CONSTRAINT passes_single_class_source_check`);
  await pool.query(`ALTER TABLE schools VALIDATE CONSTRAINT schools_passpilot_settings_revision_check`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS grades_school_classpilot_group_idx
    ON grades (school_id, classpilot_group_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS grades_school_migration_state_idx
    ON grades (school_id, migration_state)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS passes_school_classpilot_group_status_idx
    ON passes (school_id, classpilot_group_id, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS passes_school_classpilot_group_issued_idx
    ON passes (school_id, classpilot_group_id, issued_at)
  `);

  const passpilotCanonicalDataIntegrity = await schedulerPool.query(`
    SELECT
      (SELECT count(*)::integer
       FROM settings
       WHERE passpilot_class_source NOT IN ('legacy_grades', 'classpilot_groups')
          OR passpilot_class_migration_revision < 0) AS invalid_settings,
      (SELECT count(*)::integer
       FROM grades
       WHERE migration_state NOT IN ('pending', 'auto_linked', 'confirmed', 'history_only')
          OR mapping_revision < 0) AS invalid_grades,
      (SELECT count(*)::integer
       FROM passes
       WHERE grade_id IS NOT NULL AND classpilot_group_id IS NOT NULL) AS conflicting_passes,
      (SELECT count(*)::integer
       FROM schools
       WHERE passpilot_settings_revision < 0) AS invalid_school_settings_revisions,
      (SELECT count(*)::integer
       FROM passpilot_grade_students AS membership
       LEFT JOIN grades AS grade
         ON grade.id = membership.grade_id
        AND grade.school_id = membership.school_id
       LEFT JOIN students AS student
         ON student.id = membership.student_id
        AND student.school_id = membership.school_id
       WHERE grade.id IS NULL OR student.id IS NULL) AS invalid_passpilot_grade_students
  `);
  const passpilotCanonicalDataFailures = Object.entries(
    passpilotCanonicalDataIntegrity.rows[0] ?? {}
  ).filter(([, value]) => Number(value) > 0);
  if (passpilotCanonicalDataFailures.length > 0) {
    throw new Error(
      `PassPilot canonical class data integrity check failed: ${passpilotCanonicalDataFailures
        .map(([name, value]) => `${name}=${value}`)
        .join(", ")}`
    );
  }

  const passpilotCanonicalCatalogIntegrity = await pool.query(`
    SELECT
      to_regclass('public.grades_school_classpilot_group_idx') IS NOT NULL AS grades_group_index,
      to_regclass('public.grades_school_migration_state_idx') IS NOT NULL AS grades_state_index,
      to_regclass('public.passes_school_classpilot_group_status_idx') IS NOT NULL AS passes_status_index,
      to_regclass('public.passes_school_classpilot_group_issued_idx') IS NOT NULL AS passes_issued_index,
      to_regclass('public.passpilot_grade_students_school_grade_idx') IS NOT NULL AS grade_students_grade_index,
      to_regclass('public.passpilot_grade_students_school_student_idx') IS NOT NULL AS grade_students_student_index,
      to_regclass('public.grades_school_id_id_unique') IS NOT NULL AS grades_tenant_identity_unique,
      to_regclass('public.students_school_id_id_unique') IS NOT NULL AS students_tenant_identity_unique,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'passpilot_grade_students_school_grade_student_unique'
          AND conrelid = 'passpilot_grade_students'::regclass
      ) AS grade_students_unique_constraint,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'passpilot_grade_students_grade_school_fk'
          AND conrelid = 'passpilot_grade_students'::regclass
          AND convalidated
      ) AS grade_students_grade_fk,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'passpilot_grade_students_student_school_fk'
          AND conrelid = 'passpilot_grade_students'::regclass
          AND convalidated
      ) AS grade_students_student_fk,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'settings_passpilot_class_source_check'
          AND conrelid = 'settings'::regclass
          AND convalidated
      ) AS settings_source_constraint,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'settings_passpilot_class_migration_revision_check'
          AND conrelid = 'settings'::regclass
          AND convalidated
      ) AS settings_revision_constraint,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'grades_migration_state_check'
          AND conrelid = 'grades'::regclass
          AND convalidated
      ) AS grades_state_constraint,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'grades_mapping_revision_check'
          AND conrelid = 'grades'::regclass
          AND convalidated
      ) AS grades_revision_constraint,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'passes_single_class_source_check'
          AND conrelid = 'passes'::regclass
          AND convalidated
      ) AS passes_source_constraint,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'schools_passpilot_settings_revision_check'
          AND conrelid = 'schools'::regclass
          AND convalidated
      ) AS school_settings_revision_constraint
  `);
  const passpilotCanonicalCatalogFailures = Object.entries(
    passpilotCanonicalCatalogIntegrity.rows[0] ?? {}
  ).filter(([, ready]) => ready !== true);
  if (passpilotCanonicalCatalogFailures.length > 0) {
    throw new Error(
      `PassPilot canonical class schema integrity check failed: ${passpilotCanonicalCatalogFailures
        .map(([name]) => name)
        .join(", ")}`
    );
  }
  console.log("[migration] PassPilot canonical class columns and constraints ready");

  // RLS Phase 1: add school_id to derived tables + backfill from parents.
  // Idempotent; nullable legacy/ambiguous rows stay NULL by design and are hidden
  // once table RLS is enabled. dashboard_tabs/messages can only infer teacher
  // ownership when the sender has exactly one active membership.
  try {
    await pool.query(`ALTER TABLE subgroups ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`UPDATE subgroups s SET school_id = g.school_id FROM groups g WHERE g.id = s.group_id AND s.school_id IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS subgroups_school_id_idx ON subgroups (school_id)`);

    await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS school_id TEXT`);
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

  // Scheduled occurrence metadata is required by both the API finalizer and
  // the scheduler reconciler. Keep it outside best-effort legacy migrations so
  // a missing column/index fails the one-off migration task before rollout.
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_date TEXT`);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_timezone TEXT`);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_teacher_email TEXT`);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_teacher_name TEXT`);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS class_name_snapshot TEXT`);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS roster_snapshot_completed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_state TEXT`);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_finalization_reason TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS teaching_sessions_scheduled_occurrence_unique ON teaching_sessions (school_id, group_id, scheduled_date) WHERE scheduled_date IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS teaching_sessions_scheduled_due_idx ON teaching_sessions (scheduled_state, scheduled_end_at)`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'teaching_sessions_scheduled_state_check'
          AND conrelid = 'teaching_sessions'::regclass
      ) THEN
        ALTER TABLE teaching_sessions
          ADD CONSTRAINT teaching_sessions_scheduled_state_check
          CHECK (scheduled_state IS NULL OR scheduled_state IN ('active', 'finalized', 'skipped'));
      END IF;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'teaching_sessions_scheduled_window_check'
          AND conrelid = 'teaching_sessions'::regclass
      ) THEN
        ALTER TABLE teaching_sessions
          ADD CONSTRAINT teaching_sessions_scheduled_window_check
          CHECK (scheduled_start_at IS NULL OR scheduled_end_at IS NULL OR scheduled_end_at > scheduled_start_at);
      END IF;
    END $$
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'teaching_sessions_scheduled_metadata_check'
          AND conrelid = 'teaching_sessions'::regclass
      ) THEN
        ALTER TABLE teaching_sessions
          ADD CONSTRAINT teaching_sessions_scheduled_metadata_check
          CHECK (
            (
              scheduled_date IS NULL
              AND scheduled_timezone IS NULL
              AND scheduled_start_at IS NULL
              AND scheduled_end_at IS NULL
              AND scheduled_state IS NULL
            ) OR (
              scheduled_date IS NOT NULL
              AND scheduled_timezone IS NOT NULL
              AND scheduled_start_at IS NOT NULL
              AND scheduled_end_at IS NOT NULL
              AND scheduled_state IS NOT NULL
            )
          );
      END IF;
    END $$
  `);
  await pool.query(`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS timezone_snapshot TEXT`);
  console.log("[migration] teaching session scheduled occurrence metadata ready");

  // The tile authorization plan relies on teaching_sessions.school_id as both
  // an indexed tenant predicate and an RLS boundary. Do not repair bad rows in
  // place here: a migration/deploy must fail before a new release can serve if
  // any session is missing its school, references a missing group, or differs
  // from its parent group's school. schedulerPool carries app.is_super='on',
  // so this audit remains complete after FORCE RLS has been enabled.
  const teachingSessionSchoolIntegrity = await schedulerPool.query(`
    SELECT count(*)::integer AS invalid_count
    FROM teaching_sessions AS session
    LEFT JOIN groups AS class_group ON class_group.id = session.group_id
    WHERE session.school_id IS NULL
       OR class_group.id IS NULL
       OR session.school_id IS DISTINCT FROM class_group.school_id
  `);
  const invalidTeachingSessionSchools = Number(
    teachingSessionSchoolIntegrity.rows[0]?.invalid_count ?? 0
  );
  if (invalidTeachingSessionSchools > 0) {
    throw new Error(
      `teaching_sessions.school_id integrity check failed (${invalidTeachingSessionSchools} invalid rows)`
    );
  }
  console.log("[migration] teaching_sessions.school_id integrity check passed");

  // Durable ClassPilot session-summary delivery outbox. Recipient identity is
  // snapshotted at finalization; report content remains derived from the
  // teaching session so student activity is not duplicated here. Two unique
  // indexes make both recipient role and normalized email idempotent. This is
  // required runtime infrastructure, so any DDL failure must fail the migration
  // task rather than starting the API/worker without durable delivery support.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_session_summary_deliveries (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      teaching_session_id VARCHAR NOT NULL,
      recipient_kind TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      recipient_name TEXT,
      state TEXT NOT NULL DEFAULT 'waiting_report',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      submission_started_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      provider_message_id TEXT,
      last_error TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT cp_summary_delivery_recipient_kind_check
        CHECK (recipient_kind IN ('teacher', 'central')),
      CONSTRAINT cp_summary_delivery_state_check
        CHECK (state IN ('waiting_report', 'queued', 'leased', 'retry', 'sent', 'failed', 'unknown')),
      CONSTRAINT cp_summary_delivery_attempt_count_check CHECK (attempt_count >= 0),
      CONSTRAINT cp_summary_delivery_email_check CHECK (btrim(recipient_email) <> '')
    )
  `);
  await pool.query(`ALTER TABLE classpilot_session_summary_deliveries ADD COLUMN IF NOT EXISTS submission_started_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE classpilot_session_summary_deliveries ALTER COLUMN state SET DEFAULT 'waiting_report'`);
  await pool.query(`ALTER TABLE classpilot_session_summary_deliveries DROP CONSTRAINT IF EXISTS cp_summary_delivery_state_check`);
  await pool.query(`ALTER TABLE classpilot_session_summary_deliveries ADD CONSTRAINT cp_summary_delivery_state_check CHECK (state IN ('waiting_report', 'queued', 'leased', 'retry', 'sent', 'failed', 'unknown'))`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cp_summary_delivery_session_kind_unique ON classpilot_session_summary_deliveries (teaching_session_id, recipient_kind)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cp_summary_delivery_session_email_unique ON classpilot_session_summary_deliveries (teaching_session_id, lower(btrim(recipient_email)))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_summary_delivery_school_session_idx ON classpilot_session_summary_deliveries (school_id, teaching_session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_summary_delivery_due_idx ON classpilot_session_summary_deliveries (state, next_attempt_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_summary_delivery_lease_idx ON classpilot_session_summary_deliveries (state, lease_expires_at)`);
  console.log("[migration] ClassPilot session summary delivery outbox ready");

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
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS command_id VARCHAR`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS teaching_session_id VARCHAR`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS supervision_context_id VARCHAR`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_command_student_unique
      ON messages (command_id, to_student_id)
      WHERE command_id IS NOT NULL AND to_student_id IS NOT NULL
    `);
    const invalidCommandMessageParents = await schedulerPool.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM messages message
      LEFT JOIN classpilot_commands command
        ON command.id = message.command_id
       AND command.school_id = message.school_id
       AND command.command_type = 'teacher-message'
       AND command.teaching_session_id IS NOT DISTINCT FROM message.teaching_session_id
       AND command.supervision_context_id IS NOT DISTINCT FROM message.supervision_context_id
      LEFT JOIN classpilot_command_targets target
        ON target.command_id = message.command_id
       AND target.school_id = message.school_id
       AND target.student_id = message.to_student_id
      WHERE message.command_id IS NOT NULL
        AND (command.id IS NULL OR target.id IS NULL)
    `);
    if (Number(invalidCommandMessageParents.rows[0]?.count || 0) !== 0) {
      throw new Error("ClassPilot teacher-message command parent verification failed");
    }
    await pool.query(`
      CREATE OR REPLACE FUNCTION classpilot_validate_command_message_parents()
      RETURNS trigger LANGUAGE plpgsql AS $classpilot_command_message_parents$
      BEGIN
        IF NEW.command_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
          FROM classpilot_commands command
          JOIN classpilot_command_targets target
            ON target.command_id = command.id
           AND target.school_id = command.school_id
           AND target.student_id = NEW.to_student_id
          WHERE command.id = NEW.command_id
            AND command.school_id = NEW.school_id
            AND command.command_type = 'teacher-message'
            AND command.teaching_session_id IS NOT DISTINCT FROM NEW.teaching_session_id
            AND command.supervision_context_id IS NOT DISTINCT FROM NEW.supervision_context_id
        ) THEN
          RAISE EXCEPTION 'teacher message must match its command target and authority'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $classpilot_command_message_parents$;
      DROP TRIGGER IF EXISTS classpilot_validate_command_message_parents ON messages;
      CREATE TRIGGER classpilot_validate_command_message_parents
        BEFORE INSERT OR UPDATE OF school_id, command_id, to_student_id, teaching_session_id, supervision_context_id
        ON messages
        FOR EACH ROW EXECUTE FUNCTION classpilot_validate_command_message_parents();
    `);
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
    await pool.query(`ALTER TABLE chat_messages ALTER COLUMN school_id SET NOT NULL`);
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
    const invalidActiveHandParents = await schedulerPool.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM classpilot_active_hands hand
      LEFT JOIN teaching_sessions session
        ON session.id = hand.teaching_session_id AND session.school_id = hand.school_id
      LEFT JOIN students student
        ON student.id = hand.student_id AND student.school_id = hand.school_id
      LEFT JOIN devices device
        ON device.device_id = hand.device_id AND device.school_id = hand.school_id
      WHERE session.id IS NULL
         OR student.id IS NULL
         OR (
           device.device_id IS NULL
           AND (
             hand.cleared_at IS NULL
             OR EXISTS (SELECT 1 FROM devices any_device WHERE any_device.device_id = hand.device_id)
           )
         )
    `);
    if (Number(invalidActiveHandParents.rows[0]?.count || 0) !== 0) {
      throw new Error("ClassPilot active-hand parent tenant verification failed");
    }
    await pool.query(`
      CREATE OR REPLACE FUNCTION classpilot_validate_active_hand_parents()
      RETURNS trigger LANGUAGE plpgsql AS $classpilot_active_hand_parents$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM teaching_sessions session
          JOIN students student
            ON student.id = NEW.student_id AND student.school_id = NEW.school_id
          WHERE session.id = NEW.teaching_session_id
            AND session.school_id = NEW.school_id
        ) THEN
          RAISE EXCEPTION 'active hand session and student must belong to the same school'
            USING ERRCODE = '23514';
        END IF;
        IF (
          TG_OP = 'INSERT'
          OR NEW.cleared_at IS NULL
          OR NEW.device_id IS DISTINCT FROM OLD.device_id
          OR NEW.school_id IS DISTINCT FROM OLD.school_id
        ) AND NOT EXISTS (
          SELECT 1 FROM devices device
          WHERE device.device_id = NEW.device_id AND device.school_id = NEW.school_id
        ) THEN
          RAISE EXCEPTION 'active hand device must belong to the same school'
            USING ERRCODE = '23514';
        END IF;
        IF NEW.cleared_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM devices any_device WHERE any_device.device_id = NEW.device_id)
           AND NOT EXISTS (
             SELECT 1 FROM devices device
             WHERE device.device_id = NEW.device_id AND device.school_id = NEW.school_id
           ) THEN
          RAISE EXCEPTION 'cleared hand device cannot belong to another school'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $classpilot_active_hand_parents$;
      DROP TRIGGER IF EXISTS classpilot_validate_active_hand_parents ON classpilot_active_hands;
      CREATE TRIGGER classpilot_validate_active_hand_parents
        BEFORE INSERT OR UPDATE OF school_id, teaching_session_id, student_id, device_id, cleared_at
        ON classpilot_active_hands
        FOR EACH ROW EXECUTE FUNCTION classpilot_validate_active_hand_parents();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_settings (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        session_id VARCHAR NOT NULL UNIQUE,
        chat_enabled BOOLEAN DEFAULT true,
        raise_hand_enabled BOOLEAN DEFAULT true,
        lifecycle_revision INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE session_settings ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`ALTER TABLE session_settings ADD COLUMN IF NOT EXISTS lifecycle_revision INTEGER NOT NULL DEFAULT 1`);
    await pool.query(`ALTER TABLE session_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
    await pool.query(`UPDATE session_settings SET lifecycle_revision = 1 WHERE lifecycle_revision < 1`);
    await schedulerPool.query(`
      UPDATE session_settings setting
      SET school_id = session.school_id
      FROM teaching_sessions session
      WHERE setting.session_id = session.id
        AND setting.school_id IS NULL
    `);
    const invalidSessionSettingParents = await schedulerPool.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM session_settings setting
      LEFT JOIN teaching_sessions session
        ON session.id = setting.session_id AND session.school_id = setting.school_id
      WHERE session.id IS NULL
    `);
    if (Number(invalidSessionSettingParents.rows[0]?.count || 0) !== 0) {
      throw new Error("ClassPilot session-setting parent tenant verification failed");
    }
    await pool.query(`ALTER TABLE session_settings ALTER COLUMN school_id SET NOT NULL`);
    await pool.query(`ALTER TABLE session_settings DROP CONSTRAINT IF EXISTS session_settings_revision_check`);
    await pool.query(`ALTER TABLE session_settings ADD CONSTRAINT session_settings_revision_check CHECK (lifecycle_revision > 0)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS session_settings_school_session_idx ON session_settings (school_id, session_id)`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION classpilot_bind_session_setting_school()
      RETURNS trigger LANGUAGE plpgsql AS $classpilot_session_setting$
      DECLARE expected_school TEXT;
      BEGIN
        SELECT school_id INTO expected_school FROM teaching_sessions WHERE id = NEW.session_id;
        IF expected_school IS NULL OR (NEW.school_id IS NOT NULL AND NEW.school_id <> expected_school) THEN
          RAISE EXCEPTION 'session setting tenant does not match teaching session' USING ERRCODE = '23514';
        END IF;
        NEW.school_id := expected_school;
        NEW.lifecycle_revision := GREATEST(COALESCE(NEW.lifecycle_revision, 1), 1);
        NEW.updated_at := COALESCE(NEW.updated_at, clock_timestamp());
        RETURN NEW;
      END
      $classpilot_session_setting$;
      DROP TRIGGER IF EXISTS classpilot_bind_session_setting_school ON session_settings;
      CREATE TRIGGER classpilot_bind_session_setting_school
        BEFORE INSERT OR UPDATE OF school_id, session_id ON session_settings
        FOR EACH ROW EXECUTE FUNCTION classpilot_bind_session_setting_school();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS classpilot_chat_deliveries (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        chat_message_id VARCHAR NOT NULL,
        teaching_session_id VARCHAR NOT NULL,
        student_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        last_attempt_student_session_id VARCHAR,
        last_attempt_device_id TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        delivered_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT classpilot_chat_deliveries_attempt_check CHECK (attempt_count >= 0),
        CONSTRAINT classpilot_chat_deliveries_state_check CHECK (state IN ('queued','leased','attempted','retry','delivered','failed','expired'))
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS classpilot_chat_deliveries_message_unique ON classpilot_chat_deliveries (chat_message_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_chat_deliveries_due_idx ON classpilot_chat_deliveries (state, next_attempt_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_chat_deliveries_school_student_idx ON classpilot_chat_deliveries (school_id, student_id, state)`);
    const invalidChatDeliveryParents = await schedulerPool.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM classpilot_chat_deliveries delivery
      LEFT JOIN chat_messages message
        ON message.id = delivery.chat_message_id
       AND message.school_id = delivery.school_id
       AND message.session_id = delivery.teaching_session_id
       AND message.student_id = delivery.student_id
      LEFT JOIN teaching_sessions session
        ON session.id = delivery.teaching_session_id AND session.school_id = delivery.school_id
      LEFT JOIN students student
        ON student.id = delivery.student_id AND student.school_id = delivery.school_id
      WHERE message.id IS NULL OR session.id IS NULL OR student.id IS NULL
    `);
    if (Number(invalidChatDeliveryParents.rows[0]?.count || 0) !== 0) {
      throw new Error("ClassPilot chat-delivery parent tenant verification failed");
    }
    await pool.query(`
      CREATE OR REPLACE FUNCTION classpilot_validate_chat_delivery_parents()
      RETURNS trigger LANGUAGE plpgsql AS $classpilot_chat_delivery_parents$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM chat_messages message
          JOIN teaching_sessions session
            ON session.id = NEW.teaching_session_id AND session.school_id = NEW.school_id
          JOIN students student
            ON student.id = NEW.student_id AND student.school_id = NEW.school_id
          WHERE message.id = NEW.chat_message_id
            AND message.school_id = NEW.school_id
            AND message.session_id = NEW.teaching_session_id
            AND message.student_id = NEW.student_id
        ) THEN
          RAISE EXCEPTION 'chat delivery parents must belong to the same school and binding'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $classpilot_chat_delivery_parents$;
      DROP TRIGGER IF EXISTS classpilot_validate_chat_delivery_parents ON classpilot_chat_deliveries;
      CREATE TRIGGER classpilot_validate_chat_delivery_parents
        BEFORE INSERT OR UPDATE OF school_id, chat_message_id, teaching_session_id, student_id
        ON classpilot_chat_deliveries
        FOR EACH ROW EXECUTE FUNCTION classpilot_validate_chat_delivery_parents();
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS polls (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        session_id VARCHAR NOT NULL,
        teacher_id TEXT NOT NULL,
        start_command_id VARCHAR,
        close_command_id VARCHAR,
        question TEXT NOT NULL,
        options TEXT[] NOT NULL,
        is_active BOOLEAN DEFAULT true,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        closed_at TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS start_command_id VARCHAR`);
    await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS close_command_id VARCHAR`);
    await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE polls ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
    await pool.query(`UPDATE polls SET is_active = false WHERE is_active IS NULL`);
    await pool.query(`ALTER TABLE polls ALTER COLUMN is_active SET DEFAULT true`);
    await pool.query(`ALTER TABLE polls ALTER COLUMN is_active SET NOT NULL`);
    await schedulerPool.query(`
      UPDATE polls poll SET school_id = session.school_id
      FROM teaching_sessions session
      WHERE poll.session_id = session.id AND poll.school_id IS NULL
    `);
    await pool.query(`
      CREATE OR REPLACE FUNCTION classpilot_bind_poll_school()
      RETURNS trigger LANGUAGE plpgsql AS $classpilot_poll_school$
      DECLARE
        expected_school TEXT;
        start_command_matches BOOLEAN;
        close_command_matches BOOLEAN;
      BEGIN
        SELECT school_id INTO expected_school FROM teaching_sessions WHERE id = NEW.session_id;
        IF expected_school IS NULL OR (NEW.school_id IS NOT NULL AND NEW.school_id <> expected_school) THEN
          RAISE EXCEPTION 'poll tenant does not match teaching session' USING ERRCODE = '23514';
        END IF;
        NEW.school_id := expected_school;
        IF NEW.is_active AND NEW.start_command_id IS NULL THEN
          RAISE EXCEPTION 'active poll requires start command authority' USING ERRCODE = '23514';
        END IF;
        IF NEW.start_command_id IS NOT NULL THEN
          SELECT EXISTS (
            SELECT 1 FROM classpilot_commands command
            WHERE command.id = NEW.start_command_id
              AND command.school_id = expected_school
              AND command.teaching_session_id = NEW.session_id
              AND command.supervision_context_id IS NULL
              AND command.teacher_id = NEW.teacher_id
              AND command.command_type = 'poll'
              AND command.command_payload->>'action' = 'start'
          ) INTO start_command_matches;
          IF NOT start_command_matches THEN
            RAISE EXCEPTION 'poll command authority does not match its session' USING ERRCODE = '23514';
          END IF;
        END IF;
        IF NEW.close_command_id IS NOT NULL THEN
          SELECT EXISTS (
            SELECT 1 FROM classpilot_commands command
            WHERE command.id = NEW.close_command_id
              AND command.school_id = expected_school
              AND command.teaching_session_id = NEW.session_id
              AND command.supervision_context_id IS NULL
              AND command.command_type = 'poll'
              AND command.command_payload->>'action' = 'close'
          ) INTO close_command_matches;
          IF NOT close_command_matches THEN
            RAISE EXCEPTION 'poll command authority does not match its session' USING ERRCODE = '23514';
          END IF;
        END IF;
        NEW.updated_at := COALESCE(NEW.updated_at, clock_timestamp());
        RETURN NEW;
      END
      $classpilot_poll_school$;
      DROP TRIGGER IF EXISTS classpilot_bind_poll_school ON polls;
      CREATE TRIGGER classpilot_bind_poll_school
        BEFORE INSERT OR UPDATE OF school_id, session_id, teacher_id, start_command_id, close_command_id, is_active ON polls
        FOR EACH ROW EXECUTE FUNCTION classpilot_bind_poll_school();
    `);
    await schedulerPool.query(`
      UPDATE polls
      SET is_active = false, closed_at = COALESCE(closed_at, now()), updated_at = now()
      WHERE is_active = true AND start_command_id IS NULL
    `);
    await schedulerPool.query(`
      WITH ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY school_id, session_id ORDER BY created_at DESC, id DESC
        ) AS ordinal
        FROM polls WHERE is_active = true
      )
      UPDATE polls poll SET is_active = false, closed_at = COALESCE(poll.closed_at, now()), updated_at = now()
      FROM ranked WHERE poll.id = ranked.id AND ranked.ordinal > 1
    `);
    await pool.query(`ALTER TABLE polls ALTER COLUMN school_id SET NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS polls_school_session_idx ON polls (school_id, session_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS polls_active_session_unique ON polls (school_id, session_id) WHERE is_active = true`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS polls_start_command_unique ON polls (start_command_id) WHERE start_command_id IS NOT NULL`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS polls_close_command_unique ON polls (close_command_id) WHERE close_command_id IS NOT NULL`);
    const invalidPollParents = await schedulerPool.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM polls poll
      LEFT JOIN teaching_sessions session
        ON session.id = poll.session_id AND session.school_id = poll.school_id
      LEFT JOIN classpilot_commands start_command
        ON start_command.id = poll.start_command_id
       AND start_command.school_id = poll.school_id
       AND start_command.teaching_session_id = poll.session_id
       AND start_command.supervision_context_id IS NULL
       AND start_command.teacher_id = poll.teacher_id
       AND start_command.command_type = 'poll'
       AND start_command.command_payload->>'action' = 'start'
      LEFT JOIN classpilot_commands close_command
        ON close_command.id = poll.close_command_id
       AND close_command.school_id = poll.school_id
       AND close_command.teaching_session_id = poll.session_id
       AND close_command.supervision_context_id IS NULL
       AND close_command.command_type = 'poll'
       AND close_command.command_payload->>'action' = 'close'
      WHERE session.id IS NULL
         OR (poll.is_active AND poll.start_command_id IS NULL)
         OR (poll.start_command_id IS NOT NULL AND start_command.id IS NULL)
         OR (poll.close_command_id IS NOT NULL AND close_command.id IS NULL)
    `);
    if (Number(invalidPollParents.rows[0]?.count || 0) !== 0) {
      throw new Error("ClassPilot poll parent authority verification failed");
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS poll_responses (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        poll_id VARCHAR NOT NULL,
        student_id TEXT NOT NULL,
        device_id TEXT,
        selected_option INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        superseded_at TIMESTAMPTZ,
        superseded_by_response_id VARCHAR
      )
    `);
    await pool.query(`ALTER TABLE poll_responses ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`ALTER TABLE poll_responses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
    await pool.query(`ALTER TABLE poll_responses ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE poll_responses ADD COLUMN IF NOT EXISTS superseded_by_response_id VARCHAR`);
    // Older releases could hard-delete a student while retaining their poll
    // response. With the identity parent gone, that answer can no longer be
    // attributed or repaired, so remove only this proven legacy orphan before
    // the parent trigger is (re)installed. Keep every row that exposes another
    // invariant violation: a response bound to a missing/mismatched poll, an
    // existing student in another school, or an existing cross-school device
    // remains for the fail-closed catalog audit below.
    const removedLegacyOrphanPollResponses = await schedulerPool.query(`
      DELETE FROM poll_responses response
      USING polls poll
      WHERE response.poll_id = poll.id
        AND (response.school_id IS NULL OR response.school_id = poll.school_id)
        AND NOT EXISTS (
          SELECT 1 FROM students any_student
          WHERE any_student.id = response.student_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM devices cross_school_device
          WHERE cross_school_device.device_id = response.device_id
            AND cross_school_device.school_id <> poll.school_id
        )
    `);
    if ((removedLegacyOrphanPollResponses.rowCount ?? 0) > 0) {
      console.log(
        `[migration] Removed ${removedLegacyOrphanPollResponses.rowCount} legacy poll responses whose student no longer exists`
      );
    }
    await schedulerPool.query(`
      UPDATE poll_responses response SET school_id = poll.school_id
      FROM polls poll WHERE response.poll_id = poll.id AND response.school_id IS NULL
    `);
    // device_id is optional provenance. Old releases hard-deleted devices
    // without detaching historical responses, so normalize only missing
    // provenance before installing the fail-closed validator. A device that
    // still exists in another school remains visible to the audit and fails.
    await schedulerPool.query(`
      UPDATE poll_responses response
      SET device_id = NULL, updated_at = now()
      WHERE response.device_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM devices device
          WHERE device.device_id = response.device_id
        )
    `);
    await pool.query(`
      CREATE OR REPLACE FUNCTION classpilot_bind_poll_response_school()
      RETURNS trigger LANGUAGE plpgsql AS $classpilot_poll_response_school$
      DECLARE expected_school TEXT;
      BEGIN
        SELECT school_id INTO expected_school FROM polls WHERE id = NEW.poll_id;
        IF expected_school IS NULL OR (NEW.school_id IS NOT NULL AND NEW.school_id <> expected_school) THEN
          RAISE EXCEPTION 'poll response tenant does not match poll' USING ERRCODE = '23514';
        END IF;
        NEW.school_id := expected_school;
        IF NOT EXISTS (
          SELECT 1 FROM students student
          WHERE student.id = NEW.student_id AND student.school_id = expected_school
        ) THEN
          RAISE EXCEPTION 'poll response student does not belong to the poll school' USING ERRCODE = '23514';
        END IF;
        IF NEW.device_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM devices device
          WHERE device.device_id = NEW.device_id AND device.school_id = expected_school
        ) THEN
          RAISE EXCEPTION 'poll response device does not belong to the poll school' USING ERRCODE = '23514';
        END IF;
        NEW.updated_at := COALESCE(NEW.updated_at, clock_timestamp());
        RETURN NEW;
      END
      $classpilot_poll_response_school$;
      DROP TRIGGER IF EXISTS classpilot_bind_poll_response_school ON poll_responses;
      CREATE TRIGGER classpilot_bind_poll_response_school
        BEFORE INSERT OR UPDATE OF school_id, poll_id, student_id, device_id ON poll_responses
        FOR EACH ROW EXECUTE FUNCTION classpilot_bind_poll_response_school();
    `);
    await schedulerPool.query(`
      WITH ranked AS (
        SELECT id, first_value(id) OVER (
          PARTITION BY poll_id, student_id ORDER BY created_at, id
        ) AS keeper_id,
        row_number() OVER (
          PARTITION BY poll_id, student_id ORDER BY created_at, id
        ) AS ordinal
        FROM poll_responses WHERE superseded_at IS NULL
      )
      UPDATE poll_responses response
      SET superseded_at = now(), superseded_by_response_id = ranked.keeper_id, updated_at = now()
      FROM ranked WHERE response.id = ranked.id AND ranked.ordinal > 1
    `);
    await pool.query(`ALTER TABLE poll_responses ALTER COLUMN school_id SET NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS poll_responses_school_poll_idx ON poll_responses (school_id, poll_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS poll_responses_school_student_idx ON poll_responses (school_id, student_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS poll_responses_poll_student_active_unique ON poll_responses (poll_id, student_id) WHERE superseded_at IS NULL`);
    const invalidPollResponseParents = await schedulerPool.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM poll_responses response
      LEFT JOIN polls poll
        ON poll.id = response.poll_id AND poll.school_id = response.school_id
      LEFT JOIN students student
        ON student.id = response.student_id AND student.school_id = response.school_id
      LEFT JOIN devices device
        ON device.device_id = response.device_id AND device.school_id = response.school_id
      WHERE poll.id IS NULL
         OR student.id IS NULL
         OR (response.device_id IS NOT NULL AND device.device_id IS NULL)
    `);
    if (Number(invalidPollResponseParents.rows[0]?.count || 0) !== 0) {
      throw new Error("ClassPilot poll-response parent tenant verification failed");
    }
    // Child validation prevents bad response writes; the composite FK also
    // prevents a future raw student hard-delete from recreating the legacy
    // orphan class. Supported roster removal is a soft deactivation, and the
    // duplicate-student migration reparents responses before deleting a row.
    await schedulerPool.query(`
      DO $classpilot_poll_response_student_fk$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'poll_responses_school_student_fk'
            AND conrelid = 'poll_responses'::regclass
        ) THEN
          ALTER TABLE poll_responses
            ADD CONSTRAINT poll_responses_school_student_fk
            FOREIGN KEY (school_id, student_id)
            REFERENCES students (school_id, id)
            ON DELETE RESTRICT
            NOT VALID;
        END IF;
      END
      $classpilot_poll_response_student_fk$;
      ALTER TABLE poll_responses
        VALIDATE CONSTRAINT poll_responses_school_student_fk;
    `);
    const requiredFabColumns = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('chat_messages','school_id'),
          ('messages','command_id'),
          ('messages','teaching_session_id'),
          ('messages','supervision_context_id'),
          ('session_settings','school_id'),
          ('session_settings','lifecycle_revision'),
          ('classpilot_chat_deliveries','chat_message_id'),
          ('classpilot_chat_deliveries','last_attempt_student_session_id'),
          ('polls','school_id'),
          ('polls','start_command_id'),
          ('polls','close_command_id'),
          ('poll_responses','school_id'),
          ('poll_responses','superseded_at')
        )
    `);
    if (requiredFabColumns.rowCount !== 13) {
      throw new Error("ClassPilot FAB release-critical column verification failed");
    }
    const requiredFabIndexes = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])
    `, [[
      "classpilot_chat_deliveries_message_unique",
      "classpilot_chat_deliveries_due_idx",
      "classpilot_chat_deliveries_school_student_idx",
      "polls_school_session_idx",
      "polls_active_session_unique",
      "polls_start_command_unique",
      "polls_close_command_unique",
      "poll_responses_school_poll_idx",
      "poll_responses_school_student_idx",
      "poll_responses_poll_student_active_unique",
      "session_settings_school_session_idx",
      "messages_command_student_unique",
    ]]);
    if (requiredFabIndexes.rowCount !== 12) {
      throw new Error("ClassPilot FAB release-critical index verification failed");
    }
    const requiredFabConstraints = await pool.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'poll_responses'::regclass
        AND conname = 'poll_responses_school_student_fk'
        AND contype = 'f'
        AND convalidated = true
    `);
    if (requiredFabConstraints.rowCount !== 1) {
      throw new Error("ClassPilot FAB release-critical constraint verification failed");
    }
    const requiredFabTriggers = await pool.query<{ tgname: string }>(`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY($1::text[])
    `, [[
      "classpilot_bind_session_setting_school",
      "classpilot_validate_active_hand_parents",
      "classpilot_validate_chat_delivery_parents",
      "classpilot_bind_poll_school",
      "classpilot_bind_poll_response_school",
      "classpilot_validate_command_message_parents",
    ]]);
    if (requiredFabTriggers.rowCount !== 6) {
      throw new Error("ClassPilot FAB release-critical trigger verification failed");
    }
    console.log("[migration] ClassPilot FAB, chat outbox, and poll tables ready");
  } catch (err) {
    console.error("[migration] FATAL: ClassPilot FAB release-critical migration failed:", (err as Error).message);
    throw err;
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

  // Session roster snapshots are now required runtime infrastructure for every
  // ClassPilot summary. Fail startup migration if this table or its indexes
  // cannot be created; otherwise class starts would fail later at runtime.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_session_students (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      teaching_session_id VARCHAR NOT NULL,
      group_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      student_name_snapshot TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT classpilot_session_students_session_student_unique UNIQUE (teaching_session_id, student_id)
    )
  `);
  await pool.query(`ALTER TABLE classpilot_session_students ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_students_school_session_idx ON classpilot_session_students (school_id, teaching_session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_students_school_group_idx ON classpilot_session_students (school_id, group_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_students_school_student_idx ON classpilot_session_students (school_id, student_id)`);
  console.log("[migration] ClassPilot session roster snapshot table ready");

  // ClassPilot admin analytics: forward-only session-attributed class usage.
  try {
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
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_usage_school_date_idx ON classpilot_session_usage (school_id, local_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_usage_school_group_date_idx ON classpilot_session_usage (school_id, group_id, local_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS classpilot_session_usage_school_session_idx ON classpilot_session_usage (school_id, teaching_session_id)`);
    console.log("[migration] ClassPilot session-attributed usage table ready");
  } catch (err) {
    console.warn("[migration] ClassPilot session analytics migration skipped:", (err as Error).message);
  }

  // Immutable ClassPilot monitoring reports, authorization snapshots, and
  // privacy-bounded session/context events. These are required runtime
  // infrastructure: fail the migration task if any table or invariant cannot
  // be installed, rather than serving partially materialized summaries.
  // The report authorization trigger and marker backfill both read the frozen
  // staff snapshot, so this table must exist before either report operation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_session_staff (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      teaching_session_id VARCHAR NOT NULL,
      staff_id TEXT NOT NULL,
      role TEXT NOT NULL,
      staff_name_snapshot TEXT,
      staff_email_snapshot TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT cp_session_staff_role_check CHECK (role IN ('primary', 'co_teacher'))
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cp_session_staff_session_staff_unique ON classpilot_session_staff (teaching_session_id, staff_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_session_staff_school_session_idx ON classpilot_session_staff (school_id, teaching_session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_session_staff_school_staff_idx ON classpilot_session_staff (school_id, staff_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_session_reports (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      teaching_session_id VARCHAR NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      window_start TIMESTAMPTZ NOT NULL,
      window_end TIMESTAMPTZ NOT NULL,
      timezone TEXT NOT NULL,
      coverage_algorithm_version TEXT NOT NULL DEFAULT 'heartbeat-coverage-v1',
      event_schema_version INTEGER NOT NULL DEFAULT 1,
      authorization_marker JSONB,
      tracking_policy JSONB,
      roster_count INTEGER NOT NULL DEFAULT 0,
      eligible_student_count INTEGER NOT NULL DEFAULT 0,
      complete_count INTEGER NOT NULL DEFAULT 0,
      partial_count INTEGER NOT NULL DEFAULT 0,
      none_count INTEGER NOT NULL DEFAULT 0,
      not_expected_count INTEGER NOT NULL DEFAULT 0,
      unavailable_count INTEGER NOT NULL DEFAULT 0,
      total_eligible_seconds INTEGER NOT NULL DEFAULT 0,
      total_observed_seconds INTEGER NOT NULL DEFAULT 0,
      total_gap_seconds INTEGER NOT NULL DEFAULT 0,
      settle_at TIMESTAMPTZ NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ NOT NULL,
      last_error TEXT,
      materialized_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      detail_expired_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT cp_session_reports_state_check
        CHECK (state IN ('pending', 'materializing', 'ready', 'failed', 'expired')),
      CONSTRAINT cp_session_reports_window_check CHECK (window_end >= window_start),
      CONSTRAINT cp_session_reports_attempt_count_check CHECK (attempt_count >= 0)
    )
  `);
  await pool.query(`ALTER TABLE classpilot_session_reports ADD COLUMN IF NOT EXISTS authorization_marker JSONB`);
  await pool.query(`ALTER TABLE classpilot_session_reports ADD COLUMN IF NOT EXISTS tracking_policy JSONB`);
  // A trigger protects the backend-first mixed-version window: an older API
  // may finalize a class while the migration task is running, but every new
  // report still receives the same salted SHA-256 staff marker as the new
  // application code. Raw staff identifiers can therefore be removed at
  // retention without weakening authorized 410 responses.
  await pool.query(`
    CREATE OR REPLACE FUNCTION classpilot_set_report_authorization_marker()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public
    AS $classpilot_report_auth$
    DECLARE
      marker_salt TEXT;
      marker_digests JSONB;
    BEGIN
      IF NEW.authorization_marker IS NULL THEN
        marker_salt := gen_random_uuid()::text;
        SELECT COALESCE(
          jsonb_agg(
            to_jsonb(rtrim(translate(encode(sha256(convert_to(concat_ws('|',
              'classpilot-report-staff-v1', marker_salt, NEW.school_id,
              NEW.teaching_session_id, staff.staff_id
            ), 'UTF8')), 'base64'), '+/', '-_'), '='))
            ORDER BY staff.staff_id
          ),
          '[]'::jsonb
        )
        INTO marker_digests
        FROM classpilot_session_staff AS staff
        WHERE staff.school_id = NEW.school_id
          AND staff.teaching_session_id = NEW.teaching_session_id;
        NEW.authorization_marker := jsonb_build_object(
          'version', 1,
          'salt', marker_salt,
          'digests', marker_digests
        );
      END IF;
      RETURN NEW;
    END
    $classpilot_report_auth$;
    DROP TRIGGER IF EXISTS classpilot_report_authorization_marker ON classpilot_session_reports;
    CREATE TRIGGER classpilot_report_authorization_marker
      BEFORE INSERT ON classpilot_session_reports
      FOR EACH ROW EXECUTE FUNCTION classpilot_set_report_authorization_marker();
  `);
  const reportAuthorizationClient = await pool.connect();
  try {
    await reportAuthorizationClient.query("BEGIN");
    await reportAuthorizationClient.query(`SELECT set_config('app.is_super', 'on', true)`);
    await reportAuthorizationClient.query(`
      WITH missing AS MATERIALIZED (
        SELECT report.id, report.school_id, report.teaching_session_id,
               gen_random_uuid()::text AS marker_salt
        FROM classpilot_session_reports AS report
        WHERE report.authorization_marker IS NULL
        FOR UPDATE
      ), markers AS (
        SELECT missing.id, missing.marker_salt,
               COALESCE(
                 jsonb_agg(
                   to_jsonb(rtrim(translate(encode(sha256(convert_to(concat_ws('|',
                     'classpilot-report-staff-v1', missing.marker_salt,
                     missing.school_id, missing.teaching_session_id, staff.staff_id
                   ), 'UTF8')), 'base64'), '+/', '-_'), '='))
                   ORDER BY staff.staff_id
                 ) FILTER (WHERE staff.staff_id IS NOT NULL),
                 '[]'::jsonb
               ) AS digests
        FROM missing
        LEFT JOIN classpilot_session_staff AS staff
          ON staff.school_id = missing.school_id
         AND staff.teaching_session_id = missing.teaching_session_id
        GROUP BY missing.id, missing.marker_salt
      )
      UPDATE classpilot_session_reports AS report
      SET authorization_marker = jsonb_build_object(
        'version', 1,
        'salt', markers.marker_salt,
        'digests', markers.digests
      )
      FROM markers
      WHERE report.id = markers.id
    `);
    await reportAuthorizationClient.query("COMMIT");
  } catch (error) {
    await reportAuthorizationClient.query("ROLLBACK");
    throw error;
  } finally {
    reportAuthorizationClient.release();
  }
  await pool.query(`ALTER TABLE classpilot_session_reports ALTER COLUMN authorization_marker SET NOT NULL`);
  await pool.query(`ALTER TABLE classpilot_session_reports DROP CONSTRAINT IF EXISTS cp_session_reports_authorization_marker_check`);
  await pool.query(`
    ALTER TABLE classpilot_session_reports
    ADD CONSTRAINT cp_session_reports_authorization_marker_check CHECK (
      jsonb_typeof(authorization_marker) = 'object'
      AND authorization_marker->>'version' = '1'
      AND jsonb_typeof(authorization_marker->'salt') = 'string'
      AND length(authorization_marker->>'salt') BETWEEN 16 AND 128
      AND jsonb_typeof(authorization_marker->'digests') = 'array'
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cp_session_reports_session_unique ON classpilot_session_reports (teaching_session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_session_reports_school_session_idx ON classpilot_session_reports (school_id, teaching_session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_session_reports_due_idx ON classpilot_session_reports (state, next_attempt_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_session_reports_expiry_idx ON classpilot_session_reports (state, expires_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_session_student_reports (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      report_id VARCHAR NOT NULL,
      teaching_session_id VARCHAR NOT NULL,
      student_id TEXT NOT NULL,
      student_name_snapshot TEXT NOT NULL,
      status TEXT NOT NULL,
      eligible_seconds INTEGER NOT NULL DEFAULT 0,
      observed_seconds INTEGER NOT NULL DEFAULT 0,
      gap_seconds INTEGER NOT NULL DEFAULT 0,
      coverage_percent INTEGER,
      heartbeat_count INTEGER NOT NULL DEFAULT 0,
      first_observed_at TIMESTAMPTZ,
      last_observed_at TIMESTAMPTZ,
      gap_intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
      event_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      top_domains JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT cp_student_reports_status_check
        CHECK (status IN ('complete', 'partial', 'none', 'not_expected', 'unavailable')),
      CONSTRAINT cp_student_reports_coverage_check
        CHECK (coverage_percent IS NULL OR (coverage_percent >= 0 AND coverage_percent <= 100))
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cp_student_reports_report_student_unique ON classpilot_session_student_reports (report_id, student_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_student_reports_school_session_idx ON classpilot_session_student_reports (school_id, teaching_session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_student_reports_school_student_idx ON classpilot_session_student_reports (school_id, student_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_student_control_states (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      teaching_session_id VARCHAR,
      supervision_context_id VARCHAR,
      revision INTEGER NOT NULL DEFAULT 0,
      desired_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_command_id VARCHAR,
      scheduled_end_at TIMESTAMPTZ,
      hard_expires_at TIMESTAMPTZ,
      enforcement_health TEXT NOT NULL DEFAULT 'pending',
      applied_revision INTEGER,
      last_outcome TEXT,
      last_error TEXT,
      last_acknowledged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT cp_student_control_states_revision_check CHECK (revision >= 0),
      CONSTRAINT cp_student_control_states_applied_revision_check
        CHECK (applied_revision IS NULL OR (applied_revision >= 0 AND applied_revision <= revision)),
      CONSTRAINT cp_student_control_states_health_check
        CHECK (enforcement_health IN ('synced', 'pending', 'failed', 'unsupported', 'expired')),
      CONSTRAINT cp_student_control_states_session_expiry_check CHECK (
        (num_nonnulls(teaching_session_id, supervision_context_id) = 0
          AND scheduled_end_at IS NULL AND hard_expires_at IS NULL)
        OR
        (num_nonnulls(teaching_session_id, supervision_context_id) = 1 AND hard_expires_at IS NOT NULL
          AND (scheduled_end_at IS NULL OR scheduled_end_at <= hard_expires_at))
      )
    )
  `);
  await pool.query(`ALTER TABLE classpilot_student_control_states ADD COLUMN IF NOT EXISTS supervision_context_id VARCHAR`);
  await pool.query(`ALTER TABLE classpilot_student_control_states DROP CONSTRAINT IF EXISTS cp_student_control_states_session_expiry_check`);
  await pool.query(`
    ALTER TABLE classpilot_student_control_states
    ADD CONSTRAINT cp_student_control_states_session_expiry_check CHECK (
      (num_nonnulls(teaching_session_id, supervision_context_id) = 0
        AND scheduled_end_at IS NULL AND hard_expires_at IS NULL)
      OR
      (num_nonnulls(teaching_session_id, supervision_context_id) = 1
        AND hard_expires_at IS NOT NULL
        AND (scheduled_end_at IS NULL OR scheduled_end_at <= hard_expires_at))
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cp_student_control_states_school_student_unique ON classpilot_student_control_states (school_id, student_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_student_control_states_session_idx ON classpilot_student_control_states (school_id, teaching_session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_student_control_states_context_idx ON classpilot_student_control_states (school_id, supervision_context_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_student_control_states_expiry_idx ON classpilot_student_control_states (hard_expires_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS classpilot_monitoring_events (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      device_id TEXT,
      student_session_id VARCHAR NOT NULL,
      teaching_session_id VARCHAR,
      supervision_context_id VARCHAR,
      source_event_id VARCHAR(128) NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      normalized_domain TEXT,
      sanitized_path TEXT,
      title TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      retention_expires_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT cp_monitoring_events_scope_xor_check
        CHECK (num_nonnulls(teaching_session_id, supervision_context_id) = 1),
      CONSTRAINT cp_monitoring_events_schema_check CHECK (schema_version = 1),
      CONSTRAINT cp_monitoring_events_origin_check CHECK (origin IN ('extension', 'server')),
      CONSTRAINT cp_monitoring_events_type_check CHECK (event_type IN (
        'tab_changed', 'navigation_changed', 'navigation_blocked',
        'monitoring_state_changed', 'restriction_state_applied',
        'restriction_state_failed', 'restriction_state_cleared',
        'student_session_started', 'student_session_ended', 'monitoring_gap'
      ))
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS cp_monitoring_events_source_unique ON classpilot_monitoring_events (school_id, student_session_id, source_event_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_monitoring_events_session_time_idx ON classpilot_monitoring_events (school_id, teaching_session_id, occurred_at DESC, id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_monitoring_events_context_time_idx ON classpilot_monitoring_events (school_id, supervision_context_id, occurred_at DESC, id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_monitoring_events_student_time_idx ON classpilot_monitoring_events (school_id, student_id, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cp_monitoring_events_retention_idx ON classpilot_monitoring_events (retention_expires_at)`);
  console.log("[migration] ClassPilot immutable reports and monitoring events ready");

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

  // GoPilot staff-dismissal hardening. Child rows get a direct school_id so
  // same-tenant foreign keys and RLS do not depend on application joins. This
  // migration is additive and preserves historical records; unsafe ambiguity
  // (duplicates/orphans) fails the migration instead of silently rewriting it.
  // Preserve legacy settings exactly once, when the canonical columns are
  // introduced. Later canonical saves must never be overwritten on restart.
  await schedulerPool.query(`
    CREATE OR REPLACE FUNCTION public.gopilot_valid_pickup_zones(candidate JSONB)
    RETURNS BOOLEAN
    LANGUAGE plpgsql
    IMMUTABLE
    AS $gopilot_zone_validator$
    DECLARE
      zone JSONB;
      normalized_id TEXT;
      seen_ids TEXT[] := ARRAY[]::TEXT[];
    BEGIN
      IF candidate IS NULL OR jsonb_typeof(candidate) <> 'array'
         OR jsonb_array_length(candidate) < 1 OR jsonb_array_length(candidate) > 12 THEN
        RETURN false;
      END IF;
      FOR zone IN SELECT value FROM jsonb_array_elements(candidate)
      LOOP
        IF jsonb_typeof(zone) <> 'object'
           OR NOT (zone ? 'id') OR NOT (zone ? 'name')
           OR jsonb_typeof(zone->'id') <> 'string'
           OR jsonb_typeof(zone->'name') <> 'string' THEN
          RETURN false;
        END IF;
        normalized_id := btrim(zone->>'id');
        IF length(normalized_id) < 1 OR length(normalized_id) > 16
           OR normalized_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
           OR length(btrim(zone->>'name')) < 1 OR length(btrim(zone->>'name')) > 80
           OR lower(normalized_id) = ANY(seen_ids) THEN
          RETURN false;
        END IF;
        seen_ids := array_append(seen_ids, lower(normalized_id));
      END LOOP;
      RETURN true;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END
    $gopilot_zone_validator$;

    DO $gopilot_settings_backfill$
    DECLARE
      school_row RECORD;
      legacy JSONB;
      auto_start_column_existed BOOLEAN;
      pickup_zones_column_existed BOOLEAN;
      preserved_auto_start INTEGER := 0;
      preserved_zones INTEGER := 0;
    BEGIN
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'schools'
          AND column_name = 'gopilot_auto_start_enabled'
      ) INTO auto_start_column_existed;
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'schools'
          AND column_name = 'gopilot_pickup_zones'
      ) INTO pickup_zones_column_existed;

      ALTER TABLE schools
        ADD COLUMN IF NOT EXISTS gopilot_auto_start_enabled BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS gopilot_pickup_zones JSONB NOT NULL DEFAULT '[{"id":"A","name":"Zone A"},{"id":"B","name":"Zone B"},{"id":"C","name":"Zone C"}]'::jsonb,
        ADD COLUMN IF NOT EXISTS gopilot_settings_revision INTEGER NOT NULL DEFAULT 0;

      IF NOT auto_start_column_existed OR NOT pickup_zones_column_existed THEN
        FOR school_row IN
          SELECT id, settings FROM schools WHERE settings IS NOT NULL
        LOOP
          BEGIN
            legacy := school_row.settings::jsonb;
            IF NOT auto_start_column_existed
               AND legacy->'autoDismissalEnabled' = 'true'::jsonb THEN
              UPDATE schools SET gopilot_auto_start_enabled = true
              WHERE id = school_row.id;
              preserved_auto_start := preserved_auto_start + 1;
            END IF;
            IF NOT pickup_zones_column_existed THEN
              IF public.gopilot_valid_pickup_zones(legacy->'pickupZones') THEN
                UPDATE schools SET gopilot_pickup_zones = legacy->'pickupZones'
                WHERE id = school_row.id;
                preserved_zones := preserved_zones + 1;
              END IF;
            END IF;
          EXCEPTION WHEN OTHERS THEN
            -- Fail closed to the column defaults for this malformed legacy row.
            NULL;
          END;
        END LOOP;
      END IF;
      UPDATE schools
      SET gopilot_pickup_zones = '[{"id":"A","name":"Zone A"},{"id":"B","name":"Zone B"},{"id":"C","name":"Zone C"}]'::jsonb
      WHERE NOT public.gopilot_valid_pickup_zones(gopilot_pickup_zones);
      ALTER TABLE schools ALTER COLUMN dismissal_mode SET DEFAULT 'no_app';
      UPDATE schools SET dismissal_mode = 'no_app' WHERE dismissal_mode IS DISTINCT FROM 'no_app';
      RAISE NOTICE 'GoPilot settings backfill: explicit_auto_start=%, valid_zone_sets=%',
        preserved_auto_start, preserved_zones;
    END
    $gopilot_settings_backfill$;

    DO $gopilot_settings_constraints$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'schools_gopilot_settings_revision_check'
      ) THEN
        ALTER TABLE schools ADD CONSTRAINT schools_gopilot_settings_revision_check
          CHECK (gopilot_settings_revision >= 0);
      END IF;
      ALTER TABLE schools DROP CONSTRAINT IF EXISTS schools_gopilot_pickup_zones_check;
      ALTER TABLE schools ADD CONSTRAINT schools_gopilot_pickup_zones_check
        CHECK (public.gopilot_valid_pickup_zones(gopilot_pickup_zones));
    END
    $gopilot_settings_constraints$;
  `);

  // Very old restores can predate product-specific role overrides. Add the
  // column before any containment inventory, trigger, or backfill references
  // gopilot_role.
  await pool.query(`ALTER TABLE school_memberships ADD COLUMN IF NOT EXISTS gopilot_role TEXT`);
  console.log("[migration] gopilot_role column ready");

  // Two GoPilot child tables were introduced by earlier application releases
  // as best-effort startup fallbacks.  Create them before the tenant-hardening
  // pass below: a legacy database may legitimately have neither table yet,
  // and ALTER/UPDATE must not run before the fallback exists.
  await schedulerPool.query(`
    CREATE TABLE IF NOT EXISTS homeroom_teachers (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT,
      homeroom_id TEXT NOT NULL,
      teacher_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'primary',
      assigned_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(homeroom_id, teacher_id)
    );
    CREATE TABLE IF NOT EXISTS dismissal_overrides (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT,
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
    );
  `);

  await schedulerPool.query(`
    ALTER TABLE authorized_pickups ADD COLUMN IF NOT EXISTS school_id TEXT;
    ALTER TABLE custody_alerts ADD COLUMN IF NOT EXISTS school_id TEXT;
    ALTER TABLE dismissal_queue ADD COLUMN IF NOT EXISTS school_id TEXT;
    ALTER TABLE dismissal_changes ADD COLUMN IF NOT EXISTS school_id TEXT;
    ALTER TABLE family_group_students ADD COLUMN IF NOT EXISTS school_id TEXT;
    ALTER TABLE homeroom_teachers ADD COLUMN IF NOT EXISTS school_id TEXT;
    ALTER TABLE dismissal_overrides ADD COLUMN IF NOT EXISTS school_id TEXT;

    UPDATE authorized_pickups AS child
    SET school_id = student.school_id
    FROM students AS student
    WHERE child.school_id IS NULL AND student.id = child.student_id;
    UPDATE custody_alerts AS child
    SET school_id = student.school_id
    FROM students AS student
    WHERE child.school_id IS NULL AND student.id = child.student_id;
    UPDATE dismissal_queue AS child
    SET school_id = session.school_id
    FROM dismissal_sessions AS session
    WHERE child.school_id IS NULL AND session.id = child.session_id;
    UPDATE dismissal_changes AS child
    SET school_id = session.school_id
    FROM dismissal_sessions AS session
    WHERE child.school_id IS NULL AND session.id = child.session_id;
    UPDATE family_group_students AS child
    SET school_id = family.school_id
    FROM family_groups AS family
    WHERE child.school_id IS NULL AND family.id = child.family_group_id;
    UPDATE homeroom_teachers AS child
    SET school_id = homeroom.school_id
    FROM homerooms AS homeroom
    WHERE child.school_id IS NULL AND homeroom.id = child.homeroom_id;
    UPDATE dismissal_overrides AS child
    SET school_id = session.school_id
    FROM dismissal_sessions AS session
    WHERE child.school_id IS NULL AND session.id = child.session_id;
    UPDATE parent_student AS child
    SET school_id = student.school_id
    FROM students AS student
    WHERE child.school_id IS NULL AND student.id = child.student_id;
  `);

  await schedulerPool.query(`
    DO $gopilot_integrity_inventory$
    DECLARE
      orphan_count BIGINT;
      tenant_mismatch_count BIGINT;
      duplicate_queue_count BIGINT;
      duplicate_family_student_count BIGINT;
    BEGIN
      SELECT
        (SELECT count(*) FROM authorized_pickups WHERE school_id IS NULL) +
        (SELECT count(*) FROM custody_alerts WHERE school_id IS NULL) +
        (SELECT count(*) FROM dismissal_queue WHERE school_id IS NULL) +
        (SELECT count(*) FROM dismissal_changes WHERE school_id IS NULL) +
        (SELECT count(*) FROM family_group_students WHERE school_id IS NULL) +
        (SELECT count(*) FROM homeroom_teachers WHERE school_id IS NULL) +
        (SELECT count(*) FROM dismissal_overrides WHERE school_id IS NULL) +
        (SELECT count(*) FROM parent_student WHERE school_id IS NULL)
      INTO orphan_count;

      SELECT
        (SELECT count(*) FROM authorized_pickups c JOIN students s ON s.id = c.student_id WHERE s.school_id <> c.school_id) +
        (SELECT count(*) FROM custody_alerts c JOIN students s ON s.id = c.student_id WHERE s.school_id <> c.school_id) +
        (SELECT count(*) FROM dismissal_queue c JOIN dismissal_sessions p ON p.id = c.session_id WHERE p.school_id <> c.school_id) +
        (SELECT count(*) FROM dismissal_queue c JOIN students s ON s.id = c.student_id WHERE s.school_id <> c.school_id) +
        (SELECT count(*) FROM dismissal_changes c JOIN dismissal_sessions p ON p.id = c.session_id WHERE p.school_id <> c.school_id) +
        (SELECT count(*) FROM dismissal_changes c JOIN students s ON s.id = c.student_id WHERE s.school_id <> c.school_id) +
        (SELECT count(*) FROM family_group_students c JOIN family_groups p ON p.id = c.family_group_id WHERE p.school_id <> c.school_id) +
        (SELECT count(*) FROM family_group_students c JOIN students s ON s.id = c.student_id WHERE s.school_id <> c.school_id) +
        (SELECT count(*) FROM homeroom_teachers c JOIN homerooms p ON p.id = c.homeroom_id WHERE p.school_id <> c.school_id) +
        (SELECT count(*) FROM dismissal_overrides c JOIN dismissal_sessions p ON p.id = c.session_id WHERE p.school_id <> c.school_id) +
        (SELECT count(*) FROM dismissal_overrides c JOIN students s ON s.id = c.student_id WHERE s.school_id <> c.school_id) +
        (SELECT count(*) FROM parent_student c JOIN students s ON s.id = c.student_id WHERE s.school_id <> c.school_id)
      INTO tenant_mismatch_count;

      SELECT count(*) INTO duplicate_queue_count FROM (
        SELECT session_id, student_id FROM dismissal_queue
        GROUP BY session_id, student_id HAVING count(*) > 1
      ) duplicates;
      SELECT count(*) INTO duplicate_family_student_count FROM (
        SELECT school_id, student_id FROM family_group_students
        GROUP BY school_id, student_id HAVING count(*) > 1
      ) duplicates;

      RAISE NOTICE 'GoPilot integrity inventory: orphan_child_rows=%, tenant_mismatches=%, duplicate_queue_pairs=%, duplicate_family_memberships=%',
        orphan_count, tenant_mismatch_count, duplicate_queue_count, duplicate_family_student_count;
      IF orphan_count > 0 OR tenant_mismatch_count > 0
         OR duplicate_queue_count > 0 OR duplicate_family_student_count > 0 THEN
        RAISE EXCEPTION 'GoPilot integrity migration blocked; review ID/count-only inventory before rollout';
      END IF;
    END
    $gopilot_integrity_inventory$;

    ALTER TABLE authorized_pickups ALTER COLUMN school_id SET NOT NULL;
    ALTER TABLE custody_alerts ALTER COLUMN school_id SET NOT NULL;
    ALTER TABLE dismissal_queue ALTER COLUMN school_id SET NOT NULL;
    ALTER TABLE dismissal_changes ALTER COLUMN school_id SET NOT NULL;
    ALTER TABLE family_group_students ALTER COLUMN school_id SET NOT NULL;
    ALTER TABLE homeroom_teachers ALTER COLUMN school_id SET NOT NULL;
    ALTER TABLE dismissal_overrides ALTER COLUMN school_id SET NOT NULL;
    ALTER TABLE parent_student ALTER COLUMN school_id SET NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS students_school_id_id_unique ON students (school_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS dismissal_sessions_school_id_id_unique ON dismissal_sessions (school_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS family_groups_school_id_id_unique ON family_groups (school_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS homerooms_school_id_id_unique ON homerooms (school_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS dismissal_queue_session_student_unique ON dismissal_queue (session_id, student_id);
    CREATE UNIQUE INDEX IF NOT EXISTS family_group_students_school_student_unique ON family_group_students (school_id, student_id);

    CREATE INDEX IF NOT EXISTS authorized_pickups_school_id_idx ON authorized_pickups (school_id);
    CREATE INDEX IF NOT EXISTS custody_alerts_school_id_idx ON custody_alerts (school_id);
    CREATE INDEX IF NOT EXISTS dismissal_queue_school_id_idx ON dismissal_queue (school_id);
    CREATE INDEX IF NOT EXISTS dismissal_changes_school_id_idx ON dismissal_changes (school_id);
    CREATE INDEX IF NOT EXISTS family_group_students_school_id_idx ON family_group_students (school_id);
    CREATE INDEX IF NOT EXISTS family_group_students_group_id_idx ON family_group_students (family_group_id);
    CREATE INDEX IF NOT EXISTS family_group_students_student_id_idx ON family_group_students (student_id);
    CREATE INDEX IF NOT EXISTS homeroom_teachers_school_id_idx ON homeroom_teachers (school_id);
    CREATE INDEX IF NOT EXISTS dismissal_overrides_school_id_idx ON dismissal_overrides (school_id);
  `);

  await schedulerPool.query(`
    DO $gopilot_tenant_foreign_keys$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorized_pickups_school_student_fk') THEN
        ALTER TABLE authorized_pickups ADD CONSTRAINT authorized_pickups_school_student_fk
          FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custody_alerts_school_student_fk') THEN
        ALTER TABLE custody_alerts ADD CONSTRAINT custody_alerts_school_student_fk
          FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_queue_school_session_fk') THEN
        ALTER TABLE dismissal_queue ADD CONSTRAINT dismissal_queue_school_session_fk
          FOREIGN KEY (school_id, session_id) REFERENCES dismissal_sessions (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_queue_school_student_fk') THEN
        ALTER TABLE dismissal_queue ADD CONSTRAINT dismissal_queue_school_student_fk
          FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_changes_school_session_fk') THEN
        ALTER TABLE dismissal_changes ADD CONSTRAINT dismissal_changes_school_session_fk
          FOREIGN KEY (school_id, session_id) REFERENCES dismissal_sessions (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_changes_school_student_fk') THEN
        ALTER TABLE dismissal_changes ADD CONSTRAINT dismissal_changes_school_student_fk
          FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_students_school_group_fk') THEN
        ALTER TABLE family_group_students ADD CONSTRAINT family_group_students_school_group_fk
          FOREIGN KEY (school_id, family_group_id) REFERENCES family_groups (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_students_school_student_fk') THEN
        ALTER TABLE family_group_students ADD CONSTRAINT family_group_students_school_student_fk
          FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'homeroom_teachers_school_homeroom_fk') THEN
        ALTER TABLE homeroom_teachers ADD CONSTRAINT homeroom_teachers_school_homeroom_fk
          FOREIGN KEY (school_id, homeroom_id) REFERENCES homerooms (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_overrides_school_session_fk') THEN
        ALTER TABLE dismissal_overrides ADD CONSTRAINT dismissal_overrides_school_session_fk
          FOREIGN KEY (school_id, session_id) REFERENCES dismissal_sessions (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_overrides_school_student_fk') THEN
        ALTER TABLE dismissal_overrides ADD CONSTRAINT dismissal_overrides_school_student_fk
          FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parent_student_school_student_fk') THEN
        ALTER TABLE parent_student ADD CONSTRAINT parent_student_school_student_fk
          FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id) NOT VALID;
      END IF;
    END
    $gopilot_tenant_foreign_keys$;

    ALTER TABLE authorized_pickups VALIDATE CONSTRAINT authorized_pickups_school_student_fk;
    ALTER TABLE custody_alerts VALIDATE CONSTRAINT custody_alerts_school_student_fk;
    ALTER TABLE dismissal_queue VALIDATE CONSTRAINT dismissal_queue_school_session_fk;
    ALTER TABLE dismissal_queue VALIDATE CONSTRAINT dismissal_queue_school_student_fk;
    ALTER TABLE dismissal_changes VALIDATE CONSTRAINT dismissal_changes_school_session_fk;
    ALTER TABLE dismissal_changes VALIDATE CONSTRAINT dismissal_changes_school_student_fk;
    ALTER TABLE family_group_students VALIDATE CONSTRAINT family_group_students_school_group_fk;
    ALTER TABLE family_group_students VALIDATE CONSTRAINT family_group_students_school_student_fk;
    ALTER TABLE homeroom_teachers VALIDATE CONSTRAINT homeroom_teachers_school_homeroom_fk;
    ALTER TABLE dismissal_overrides VALIDATE CONSTRAINT dismissal_overrides_school_session_fk;
    ALTER TABLE dismissal_overrides VALIDATE CONSTRAINT dismissal_overrides_school_student_fk;
    ALTER TABLE parent_student VALIDATE CONSTRAINT parent_student_school_student_fk;
  `);

  await schedulerPool.query(`
    ALTER TABLE authorized_pickups ALTER COLUMN status SET DEFAULT 'pending';
    DO $gopilot_pickup_status$
    DECLARE demoted_count BIGINT;
    BEGIN
      UPDATE authorized_pickups AS pickup
      SET status = 'pending'
      WHERE pickup.status = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM school_memberships AS membership
          WHERE membership.school_id = pickup.school_id
            AND membership.user_id = pickup.added_by
            AND membership.status = 'active'
            AND COALESCE(NULLIF(membership.gopilot_role, ''), membership.role)
              IN ('admin', 'school_admin', 'office_staff')
        );
      GET DIAGNOSTICS demoted_count = ROW_COUNT;
      RAISE NOTICE 'GoPilot pickup approvals moved to staff review: count=%', demoted_count;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorized_pickups_status_check') THEN
        ALTER TABLE authorized_pickups ADD CONSTRAINT authorized_pickups_status_check
          CHECK (status IN ('pending', 'approved', 'revoked')) NOT VALID;
      END IF;
    END
    $gopilot_pickup_status$;
    ALTER TABLE authorized_pickups VALIDATE CONSTRAINT authorized_pickups_status_check;

    DO $gopilot_invitation_revoke$
    DECLARE revoked_count BIGINT;
    BEGIN
      UPDATE family_groups SET invite_token = NULL
      WHERE claimed_by_user_id IS NULL AND invite_token IS NOT NULL;
      GET DIAGNOSTICS revoked_count = ROW_COUNT;
      RAISE NOTICE 'GoPilot unused family invitation tokens revoked: count=%', revoked_count;
    END
    $gopilot_invitation_revoke$;

    DO $gopilot_state_constraints$
    DECLARE invalid_session_statuses BIGINT;
    DECLARE invalid_queue_statuses BIGINT;
    DECLARE invalid_change_statuses BIGINT;
    DECLARE invalid_override_types BIGINT;
    BEGIN
      SELECT count(*) INTO invalid_session_statuses FROM dismissal_sessions
        WHERE status NOT IN ('pending', 'active', 'paused', 'completed');
      SELECT count(*) INTO invalid_queue_statuses FROM dismissal_queue
        WHERE status NOT IN ('waiting', 'called', 'released', 'dismissed', 'held', 'delayed');
      SELECT count(*) INTO invalid_change_statuses FROM dismissal_changes
        WHERE status NOT IN ('pending', 'approved', 'rejected');
      SELECT count(*) INTO invalid_override_types FROM dismissal_overrides
        WHERE original_type NOT IN ('car', 'bus', 'walker', 'afterschool')
           OR override_type NOT IN ('car', 'bus', 'walker', 'afterschool');
      RAISE NOTICE 'GoPilot state inventory: sessions=%, queue=%, changes=%, overrides=%',
        invalid_session_statuses, invalid_queue_statuses, invalid_change_statuses, invalid_override_types;
      IF invalid_session_statuses > 0 OR invalid_queue_statuses > 0
         OR invalid_change_statuses > 0 OR invalid_override_types > 0 THEN
        RAISE EXCEPTION 'GoPilot state integrity migration blocked; review ID/count-only inventory';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_sessions_status_check') THEN
        ALTER TABLE dismissal_sessions ADD CONSTRAINT dismissal_sessions_status_check
          CHECK (status IN ('pending', 'active', 'paused', 'completed')) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_queue_status_check') THEN
        ALTER TABLE dismissal_queue ADD CONSTRAINT dismissal_queue_status_check
          CHECK (status IN ('waiting', 'called', 'released', 'dismissed', 'held', 'delayed')) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_changes_status_check') THEN
        ALTER TABLE dismissal_changes ADD CONSTRAINT dismissal_changes_status_check
          CHECK (status IN ('pending', 'approved', 'rejected')) NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dismissal_overrides_type_check') THEN
        ALTER TABLE dismissal_overrides ADD CONSTRAINT dismissal_overrides_type_check
          CHECK (original_type IN ('car', 'bus', 'walker', 'afterschool') AND override_type IN ('car', 'bus', 'walker', 'afterschool')) NOT VALID;
      END IF;
    END
    $gopilot_state_constraints$;
    ALTER TABLE dismissal_sessions VALIDATE CONSTRAINT dismissal_sessions_status_check;
    ALTER TABLE dismissal_queue VALIDATE CONSTRAINT dismissal_queue_status_check;
    ALTER TABLE dismissal_changes VALIDATE CONSTRAINT dismissal_changes_status_check;
    ALTER TABLE dismissal_overrides VALIDATE CONSTRAINT dismissal_overrides_type_check;
  `);

  // Database-level guard for active same-school homeroom staff. It applies to
  // both the legacy primary pointer and the co-teacher junction table.
  await schedulerPool.query(`
    DO $gopilot_homeroom_staff_inventory$
    DECLARE invalid_primary_count BIGINT;
    DECLARE invalid_junction_count BIGINT;
    BEGIN
      SELECT count(*) INTO invalid_primary_count
      FROM homerooms AS homeroom
      WHERE homeroom.teacher_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM school_memberships AS membership
          WHERE membership.school_id = homeroom.school_id
            AND membership.user_id = homeroom.teacher_id
            AND membership.status = 'active'
            AND COALESCE(NULLIF(membership.gopilot_role, ''), membership.role)
              IN ('admin', 'school_admin', 'office_staff', 'teacher')
        );
      SELECT count(*) INTO invalid_junction_count
      FROM homeroom_teachers AS assignment
      WHERE NOT EXISTS (
        SELECT 1 FROM school_memberships AS membership
        WHERE membership.school_id = assignment.school_id
          AND membership.user_id = assignment.teacher_id
          AND membership.status = 'active'
          AND COALESCE(NULLIF(membership.gopilot_role, ''), membership.role)
            IN ('admin', 'school_admin', 'office_staff', 'teacher')
      );
      RAISE NOTICE 'GoPilot homeroom assignment inventory: invalid_primary=%, invalid_junction=%',
        invalid_primary_count, invalid_junction_count;
      IF invalid_primary_count > 0 OR invalid_junction_count > 0 THEN
        RAISE EXCEPTION 'GoPilot homeroom staff integrity migration blocked; review ID/count-only inventory';
      END IF;
    END
    $gopilot_homeroom_staff_inventory$;

    CREATE OR REPLACE FUNCTION gopilot_validate_homeroom_teacher()
    RETURNS trigger LANGUAGE plpgsql AS $gopilot_homeroom_staff$
    DECLARE resolved_school_id TEXT;
    BEGIN
      IF TG_TABLE_NAME = 'homerooms' THEN
        IF NEW.teacher_id IS NULL THEN RETURN NEW; END IF;
        resolved_school_id := NEW.school_id;
      ELSE
        resolved_school_id := NEW.school_id;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM school_memberships AS membership
        WHERE membership.school_id = resolved_school_id
          AND membership.user_id = NEW.teacher_id
          AND membership.status = 'active'
          AND COALESCE(NULLIF(membership.gopilot_role, ''), membership.role)
            IN ('admin', 'school_admin', 'office_staff', 'teacher')
      ) THEN
        RAISE EXCEPTION 'GoPilot homeroom teacher must be active staff at the same school'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $gopilot_homeroom_staff$;
    DROP TRIGGER IF EXISTS gopilot_validate_homeroom_primary_teacher ON homerooms;
    CREATE TRIGGER gopilot_validate_homeroom_primary_teacher
      BEFORE INSERT OR UPDATE OF school_id, teacher_id ON homerooms
      FOR EACH ROW EXECUTE FUNCTION gopilot_validate_homeroom_teacher();
    DROP TRIGGER IF EXISTS gopilot_validate_homeroom_co_teacher ON homeroom_teachers;
    CREATE TRIGGER gopilot_validate_homeroom_co_teacher
      BEFORE INSERT OR UPDATE OF school_id, homeroom_id, teacher_id ON homeroom_teachers
      FOR EACH ROW EXECUTE FUNCTION gopilot_validate_homeroom_teacher();
  `);

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

  // A reviewed deploy can request fail-closed catalog assertions for one new
  // tenant table or the exact GoPilot child-table bundle. This runs outside
  // the best-effort policy block above so swallowed DDL errors cannot let the
  // migration task report success. The deploy flag is intentionally one-shot;
  // normal startup never sets it.
  const requiredRlsTables = (process.env.REQUIRE_RLS_TABLE_ENFORCEMENT ?? "")
    .split(",")
    .map((table) => table.trim())
    .filter(Boolean);
  if (requiredRlsTables.length > 0) {
    const reviewedRlsTables = new Set([
      "classpilot_session_summary_deliveries",
      "classpilot_monitoring_events",
      "classpilot_session_reports",
      "classpilot_session_staff",
      "classpilot_session_student_reports",
      "classpilot_student_control_states",
      "classpilot_active_hands",
      "classpilot_chat_deliveries",
      "poll_responses",
      "polls",
      "session_settings",
      "passpilot_grade_students",
      "authorized_pickups",
      "custody_alerts",
      "dismissal_changes",
      "dismissal_overrides",
      "dismissal_queue",
      "family_group_students",
      "homeroom_teachers",
      "classpilot_schedule_change_pairs",
      "classpilot_schedule_changes",
      "classpilot_schedule_change_legs",
      "passpilot_kiosk_sessions",
    ]);
    if (
      new Set(requiredRlsTables).size !== requiredRlsTables.length ||
      requiredRlsTables.some((table) => !reviewedRlsTables.has(table))
    ) {
      throw new Error(`Unsupported required RLS enforcement table list: ${requiredRlsTables.join(",")}`);
    }
    if (process.env.RLS_GUC_ENABLED !== "true") {
      throw new Error(`Required RLS enforcement failed for ${requiredRlsTables.join(",")}`);
    }
    const enabledRlsTables = parseRlsEnabledTables();
    if (requiredRlsTables.some((table) => !enabledRlsTables.has(table))) {
      throw new Error(`Required RLS enforcement failed for ${requiredRlsTables.join(",")}`);
    }
    const { rows: rlsCatalogRows } = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      has_tenant_isolation_policy: boolean;
    }>(
      `
        SELECT
          relation.relname,
          relation.relrowsecurity,
          relation.relforcerowsecurity,
          EXISTS (
            SELECT 1
            FROM pg_policy policy
            WHERE policy.polrelid = relation.oid
              AND policy.polname = 'tenant_isolation'
          ) AS has_tenant_isolation_policy
        FROM pg_class relation
        INNER JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind = 'r'
          AND relation.relname = ANY($1::text[])
      `,
      [requiredRlsTables],
    );
    if (
      rlsCatalogRows.length !== requiredRlsTables.length ||
      requiredRlsTables.some((table) => {
        const catalog = rlsCatalogRows.find((row) => row.relname === table);
        return !catalog?.relrowsecurity || !catalog.relforcerowsecurity || !catalog.has_tenant_isolation_policy;
      })
    ) {
      throw new Error(`Required RLS enforcement failed for ${requiredRlsTables.join(",")}`);
    }
    console.log(`[migration] Required RLS enforcement verified for ${requiredRlsTables.join(", ")}`);
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

  // Canonical PassPilot mappings depend on the ClassPilot groups base table.
  // Keep this fail-closed integrity gate after groups, group_students, and
  // group_teachers startup DDL so a partial legacy schema cannot bypass it.
  const passpilotCanonicalGroupIntegrity = await schedulerPool.query(`
    SELECT
      (SELECT count(*)::integer
       FROM grades AS grade
       LEFT JOIN groups AS class_group ON class_group.id = grade.classpilot_group_id
       WHERE grade.classpilot_group_id IS NOT NULL
         AND (
           class_group.id IS NULL
           OR class_group.school_id <> grade.school_id
           OR class_group.group_type <> 'admin_class'
         )) AS invalid_grade_groups,
      (SELECT count(*)::integer
       FROM passes AS pass
       LEFT JOIN groups AS class_group ON class_group.id = pass.classpilot_group_id
       WHERE pass.classpilot_group_id IS NOT NULL
         AND (
           class_group.id IS NULL
           OR class_group.school_id <> pass.school_id
           OR class_group.group_type <> 'admin_class'
         )) AS invalid_pass_groups,
      (SELECT count(*)::integer
       FROM schools AS school
       LEFT JOIN groups AS class_group ON class_group.id = school.kiosk_classpilot_group_id
       WHERE school.kiosk_classpilot_group_id IS NOT NULL
         AND (
           class_group.id IS NULL
           OR class_group.school_id <> school.id
           OR class_group.group_type <> 'admin_class'
         )) AS invalid_kiosk_groups
  `);
  const passpilotCanonicalGroupFailures = Object.entries(
    passpilotCanonicalGroupIntegrity.rows[0] ?? {}
  ).filter(([, value]) => Number(value) > 0);
  if (passpilotCanonicalGroupFailures.length > 0) {
    throw new Error(
      `PassPilot canonical group integrity check failed: ${passpilotCanonicalGroupFailures
        .map(([name, value]) => `${name}=${value}`)
        .join(", ")}`
    );
  }
  console.log("[migration] PassPilot canonical ClassPilot-class compatibility ready");

  // GoPilot homeroom co-teacher junction table.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS homeroom_teachers (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        school_id TEXT NOT NULL,
        homeroom_id TEXT NOT NULL,
        teacher_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary',
        assigned_at TIMESTAMP NOT NULL DEFAULT now(),
        UNIQUE(homeroom_id, teacher_id)
      )
    `);
    await pool.query(`ALTER TABLE homeroom_teachers ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`UPDATE homeroom_teachers child SET school_id = homeroom.school_id FROM homerooms homeroom WHERE child.school_id IS NULL AND child.homeroom_id = homeroom.id`);
    await pool.query(`ALTER TABLE homeroom_teachers ALTER COLUMN school_id SET NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS homeroom_teachers_school_id_idx ON homeroom_teachers (school_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS homeroom_teachers_homeroom_id_idx ON homeroom_teachers (homeroom_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS homeroom_teachers_teacher_id_idx ON homeroom_teachers (teacher_id)`);
    console.log("[migration] homeroom_teachers table ready");
  } catch (err) {
    console.warn("[migration] homeroom_teachers migration skipped:", (err as Error).message);
  }

  // Seed co-teacher tables from existing teacherId columns
  try {
    await schedulerPool.query(`
      INSERT INTO group_teachers (group_id, teacher_id, role)
      SELECT id, teacher_id, 'primary' FROM groups
      WHERE teacher_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    await schedulerPool.query(`
      INSERT INTO homeroom_teachers (school_id, homeroom_id, teacher_id, role)
      SELECT school_id, id, teacher_id, 'primary' FROM homerooms
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
        school_id TEXT NOT NULL,
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
    await pool.query(`ALTER TABLE IF EXISTS dismissal_overrides ADD COLUMN IF NOT EXISTS school_id TEXT`);
    await pool.query(`UPDATE dismissal_overrides child SET school_id = session.school_id FROM dismissal_sessions session WHERE child.school_id IS NULL AND child.session_id = session.id`);
    await pool.query(`ALTER TABLE dismissal_overrides ALTER COLUMN school_id SET NOT NULL`);
    await pool.query(`ALTER TABLE IF EXISTS dismissal_overrides ADD COLUMN IF NOT EXISTS bus_route TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS dismissal_overrides_school_id_idx ON dismissal_overrides (school_id)`);
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

  // Teacher tile history requires exact mixed-order indexes for both the
  // general device path and the student-authorized path. Keep the expensive
  // online work exclusive to the one-off migration task: web and worker
  // startup must never race or initiate production index DDL.
  if (migrationsOnly()) {
    const heartbeatIndexClient = await pool.connect();
    let heartbeatIndexClientError: Error | undefined;
    try {
      await ensureHeartbeatHistoryIndexOnline(heartbeatIndexClient);
      console.log(
        "[migration] heartbeat device and student-authorized history indexes ready"
      );
    } catch (err) {
      console.error(
        "[migration] heartbeat history index failed:",
        (err as Error).message
      );
      heartbeatIndexClientError =
        err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      heartbeatIndexClient.release(heartbeatIndexClientError);
    }
  } else {
    console.log(
      "[migration] heartbeat history online index skipped outside migrations-only mode"
    );
  }

  // Teacher tiles authorize by device id before loading history or screenshots.
  // The existing unique index begins with student_id and cannot serve that lookup.
  // Keep this migration online and fail closed: a failed concurrent build can
  // leave an invalid index with the same name, and IF NOT EXISTS alone would
  // otherwise mistake that unusable artifact for a completed safety fix.
  const studentDeviceIndexLock = "schoolpilot:student_devices_device_student_idx";
  const indexClient = await pool.connect();
  type StudentDeviceIndexState = {
    access_method: string;
    indisready: boolean;
    indisunique: boolean;
    indisvalid: boolean;
    is_plain: boolean;
    key_columns: string[];
    table_name: string;
  };
  const inspectStudentDeviceIndex = () =>
    indexClient.query<StudentDeviceIndexState>(`
      SELECT
        access_method.amname AS access_method,
        i.indisready,
        i.indisunique,
        i.indisvalid,
        i.indpred IS NULL AND i.indexprs IS NULL AS is_plain,
        table_class.relname AS table_name,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = i.indrelid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.position <= i.indnkeyatts
          ORDER BY key_column.position
        ) AS key_columns
      FROM pg_class AS idx
      INNER JOIN pg_index AS i ON i.indexrelid = idx.oid
      INNER JOIN pg_class AS table_class ON table_class.oid = i.indrelid
      INNER JOIN pg_am AS access_method ON access_method.oid = idx.relam
      INNER JOIN pg_namespace AS n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema()
        AND idx.relname = 'student_devices_device_student_idx'
    `);
  const isExpectedStudentDeviceIndex = (
    state: StudentDeviceIndexState | undefined
  ): boolean =>
    state?.indisready === true &&
    state.indisvalid === true &&
    state.indisunique === false &&
    state.is_plain === true &&
    state.access_method === "btree" &&
    state.table_name === "student_devices" &&
    state.key_columns.length === 2 &&
    state.key_columns[0] === "device_id" &&
    state.key_columns[1] === "student_id";
  try {
    await indexClient.query("SELECT pg_advisory_lock(hashtext($1))", [studentDeviceIndexLock]);
    const existing = await inspectStudentDeviceIndex();
    if (existing.rows[0] && !isExpectedStudentDeviceIndex(existing.rows[0])) {
      await indexClient.query(
        "DROP INDEX CONCURRENTLY IF EXISTS student_devices_device_student_idx"
      );
    }
    await indexClient.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS student_devices_device_student_idx ON student_devices (device_id, student_id)`);
    const verified = await inspectStudentDeviceIndex();
    if (!isExpectedStudentDeviceIndex(verified.rows[0])) {
      throw new Error("student_devices device index is missing or invalid after concurrent creation");
    }
    console.log("[migration] student_devices (device_id, student_id) index ready");
  } catch (err) {
    console.error("[migration] student_devices device index failed:", (err as Error).message);
    throw err;
  } finally {
    await indexClient
      .query("SELECT pg_advisory_unlock(hashtext($1))", [studentDeviceIndexLock])
      .catch(() => {});
    indexClient.release();
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

  // Clean up duplicate students created by extension (keep the admin-imported
  // one with gradeId). This is one transaction because a partially reassigned
  // identity is worse than retaining the duplicate. FAB/chat/poll children
  // are merged before deletion so this late migration cannot create orphans
  // after the earlier fail-closed parent audits have already passed.
  const duplicateStudentCleanupClient = await schedulerPool.connect();
  try {
    await duplicateStudentCleanupClient.query("BEGIN");
    await duplicateStudentCleanupClient.query(`
      CREATE TEMP TABLE classpilot_duplicate_student_cleanup
      ON COMMIT DROP AS
      SELECT DISTINCT ON (duplicate.id)
        keeper.id AS keeper_id,
        duplicate.id AS dup_id
      FROM students keeper
      JOIN students duplicate
        ON keeper.email_lc = duplicate.email_lc
       AND keeper.school_id = duplicate.school_id
       AND keeper.id <> duplicate.id
      WHERE keeper.grade_id IS NOT NULL
        AND duplicate.grade_id IS NULL
        -- Existing immutable ClassPilot history has more involved uniqueness
        -- contracts. Retain those rare duplicates for an explicit repair
        -- instead of deleting a referenced parent during startup.
        AND NOT EXISTS (SELECT 1 FROM classpilot_session_students row WHERE row.student_id = duplicate.id)
        AND NOT EXISTS (SELECT 1 FROM classpilot_student_control_states row WHERE row.student_id = duplicate.id)
        AND NOT EXISTS (SELECT 1 FROM classpilot_supervision_students row WHERE row.student_id = duplicate.id)
        AND NOT EXISTS (SELECT 1 FROM classpilot_command_targets row WHERE row.student_id = duplicate.id)
        AND NOT EXISTS (SELECT 1 FROM classpilot_classroom_states row WHERE row.student_id = duplicate.id)
        AND NOT EXISTS (SELECT 1 FROM classpilot_monitoring_events row WHERE row.student_id = duplicate.id)
        AND NOT EXISTS (SELECT 1 FROM classpilot_session_student_reports row WHERE row.student_id = duplicate.id)
      ORDER BY duplicate.id, keeper.created_at, keeper.id
    `);
    await duplicateStudentCleanupClient.query(`
      SELECT student.id
      FROM students student
      JOIN (
        SELECT keeper_id AS id FROM classpilot_duplicate_student_cleanup
        UNION
        SELECT dup_id AS id FROM classpilot_duplicate_student_cleanup
      ) affected ON affected.id = student.id
      ORDER BY student.id
      FOR UPDATE OF student
    `);
    // Reassign heartbeats from duplicate (no gradeId) to surviving (has gradeId) student
    // RLS-exempt pool: cross-school cleanup DML with no request GUC.
    await duplicateStudentCleanupClient.query(`
      UPDATE heartbeats SET student_id = mapping.keeper_id
      FROM classpilot_duplicate_student_cleanup mapping
      WHERE heartbeats.student_id = mapping.dup_id
    `);
    // Reassign student_devices without tripping the unique(student_id, device_id) constraint
    await duplicateStudentCleanupClient.query(`
      INSERT INTO student_devices (student_id, device_id, first_seen_at, last_seen_at)
      SELECT mapping.keeper_id, student_devices.device_id, MIN(student_devices.first_seen_at), MAX(student_devices.last_seen_at)
      FROM student_devices
      JOIN classpilot_duplicate_student_cleanup mapping
        ON student_devices.student_id = mapping.dup_id
      GROUP BY mapping.keeper_id, student_devices.device_id
      ON CONFLICT (student_id, device_id) DO NOTHING
    `);
    await duplicateStudentCleanupClient.query(`
      DELETE FROM student_devices
      USING classpilot_duplicate_student_cleanup mapping
      WHERE student_devices.student_id = mapping.dup_id
    `);
    // One active session is allowed per canonical student. Rank the keeper and
    // duplicate identities together before re-parenting so a normal historic
    // duplicate cannot abort startup on the partial unique index. The freshest
    // binding remains authoritative; older bindings are ended atomically.
    await duplicateStudentCleanupClient.query(`
      WITH ranked AS (
        SELECT session.id,
               row_number() OVER (
                 PARTITION BY COALESCE(mapping.keeper_id, session.student_id)
                 ORDER BY session.last_seen_at DESC, session.started_at DESC, session.id DESC
               ) AS ordinal
        FROM student_sessions session
        LEFT JOIN classpilot_duplicate_student_cleanup mapping
          ON mapping.dup_id = session.student_id
        WHERE session.is_active = true
          AND (
            mapping.dup_id IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM classpilot_duplicate_student_cleanup keeper
              WHERE keeper.keeper_id = session.student_id
            )
          )
      )
      UPDATE student_sessions session
      SET is_active = false,
          ended_at = COALESCE(session.ended_at, now())
      FROM ranked
      WHERE session.id = ranked.id AND ranked.ordinal > 1
    `);
    // Reassign student_sessions after active collisions are terminal.
    await duplicateStudentCleanupClient.query(`
      UPDATE student_sessions SET student_id = mapping.keeper_id
      FROM classpilot_duplicate_student_cleanup mapping
      WHERE student_sessions.student_id = mapping.dup_id
    `);
    // Resolve partial-unique active-hand collisions before re-parenting every
    // retained active and cleared hand row.
    await duplicateStudentCleanupClient.query(`
      WITH ranked AS (
        SELECT hand.id,
               first_value(hand.id) OVER (
                 PARTITION BY COALESCE(mapping.keeper_id, hand.student_id), hand.teaching_session_id
                 ORDER BY hand.raised_at, hand.id
               ) AS keeper_hand_id,
               row_number() OVER (
                 PARTITION BY COALESCE(mapping.keeper_id, hand.student_id), hand.teaching_session_id
                 ORDER BY hand.raised_at, hand.id
               ) AS ordinal
        FROM classpilot_active_hands hand
        LEFT JOIN classpilot_duplicate_student_cleanup mapping ON mapping.dup_id = hand.student_id
        WHERE hand.cleared_at IS NULL
          AND (
            mapping.dup_id IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM classpilot_duplicate_student_cleanup keeper
              WHERE keeper.keeper_id = hand.student_id
            )
          )
      )
      UPDATE classpilot_active_hands hand
      SET cleared_at = now(), updated_at = now()
      FROM ranked
      WHERE hand.id = ranked.id AND ranked.ordinal > 1
    `);
    await duplicateStudentCleanupClient.query(`
      UPDATE classpilot_active_hands hand SET student_id = mapping.keeper_id, updated_at = now()
      FROM classpilot_duplicate_student_cleanup mapping
      WHERE hand.student_id = mapping.dup_id
    `);
    // Poll answers are first-write-wins. Rank both identities together, mark
    // later active answers superseded, then re-parent without violating the
    // partial unique index.
    await duplicateStudentCleanupClient.query(`
      WITH ranked AS (
        SELECT response.id,
               first_value(response.id) OVER (
                 PARTITION BY response.poll_id, COALESCE(mapping.keeper_id, response.student_id)
                 ORDER BY response.created_at, response.id
               ) AS keeper_response_id,
               row_number() OVER (
                 PARTITION BY response.poll_id, COALESCE(mapping.keeper_id, response.student_id)
                 ORDER BY response.created_at, response.id
               ) AS ordinal
        FROM poll_responses response
        LEFT JOIN classpilot_duplicate_student_cleanup mapping ON mapping.dup_id = response.student_id
        WHERE response.superseded_at IS NULL
          AND (
            mapping.dup_id IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM classpilot_duplicate_student_cleanup keeper
              WHERE keeper.keeper_id = response.student_id
            )
          )
      )
      UPDATE poll_responses response
      SET superseded_at = now(),
          superseded_by_response_id = ranked.keeper_response_id,
          updated_at = now()
      FROM ranked
      WHERE response.id = ranked.id AND ranked.ordinal > 1
    `);
    await duplicateStudentCleanupClient.query(`
      UPDATE poll_responses response SET student_id = mapping.keeper_id, updated_at = now()
      FROM classpilot_duplicate_student_cleanup mapping
      WHERE response.student_id = mapping.dup_id
    `);
    // The delivery trigger requires exact message/session/student identity, so
    // re-parent the message immediately before its outbox row in this txn.
    await duplicateStudentCleanupClient.query(`
      UPDATE chat_messages message SET student_id = mapping.keeper_id
      FROM classpilot_duplicate_student_cleanup mapping
      WHERE message.student_id = mapping.dup_id
    `);
    await duplicateStudentCleanupClient.query(`
      UPDATE classpilot_chat_deliveries delivery
      SET student_id = mapping.keeper_id, updated_at = now()
      FROM classpilot_duplicate_student_cleanup mapping
      WHERE delivery.student_id = mapping.dup_id
    `);
    // Now delete the orphaned duplicates
    await duplicateStudentCleanupClient.query(`
      DELETE FROM students student
      USING classpilot_duplicate_student_cleanup mapping
      WHERE student.id = mapping.dup_id
    `);
    await duplicateStudentCleanupClient.query("COMMIT");
    console.log("[migration] Cleaned up duplicate extension-created students (with data reassignment)");
  } catch (err) {
    await duplicateStudentCleanupClient.query("ROLLBACK").catch(() => {});
    // This is legacy hygiene, not a release schema dependency. Atomic rollback
    // preserves every original identity/child row when an unenumerated legacy
    // FK or uniqueness collision is encountered; retain it for explicit repair
    // without leaving the partial child rewrites that caused the old orphan bug.
    console.warn("[migration] Duplicate student cleanup rolled back; retained original rows:", (err as Error).message);
  } finally {
    duplicateStudentCleanupClient.release();
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
  // Bind the revision that will emit hot-path evidence before this process can
  // accept traffic. The raw task-definition ARN remains process-local; only
  // its SHA-256 is emitted in sanitized aggregate summaries.
  const ecsRuntimeIdentity = await resolveEcsApiRuntimeIdentity();
  if (ecsRuntimeIdentity) {
    bindHeartbeatHotPathApiRuntimeTaskDefinitionSha256(
      ecsRuntimeIdentity.taskDefinitionSha256
    );
  }

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
