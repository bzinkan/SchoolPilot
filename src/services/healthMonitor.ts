// Background health monitor — checks all subsystems every 5 minutes
// Sends shared monitor alerts on failure and recovery notifications when restored

import type { WebSocketServer } from "ws";
import { pool } from "../db.js";
import { getIO } from "../realtime/socketio.js";
import { isRedisEnabled } from "../realtime/ws-redis.js";
import errorMonitor, { type ErrorCategory } from "./errorMonitor.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS = 15_000; // 15s to let DB pool warm up

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
  error?: string;
}

// --- Alert state ---
const subsystemWasFailing = new Map<string, boolean>();
let startupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

// --- Checks ---

async function checkPostgres(): Promise<CheckResult> {
  const start = Date.now();
  await pool.query("SELECT 1");
  return { ok: true, latencyMs: Date.now() - start };
}

async function checkDbRoundTrip(): Promise<CheckResult> {
  const start = Date.now();
  await pool.query(`CREATE TABLE IF NOT EXISTS _health_sentinel (
    id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  const { rows } = await pool.query(
    "INSERT INTO _health_sentinel DEFAULT VALUES RETURNING id"
  );
  const id = rows[0].id;
  const read = await pool.query(
    "SELECT id FROM _health_sentinel WHERE id = $1",
    [id]
  );
  if (read.rows.length === 0) {
    throw new Error("Sentinel row not found on read-back");
  }
  await pool.query("DELETE FROM _health_sentinel WHERE id = $1", [id]);
  // Cleanup orphans older than 1 hour
  await pool.query(
    "DELETE FROM _health_sentinel WHERE created_at < NOW() - INTERVAL '1 hour'"
  );
  return { ok: true, latencyMs: Date.now() - start };
}

async function checkDbPool(): Promise<CheckResult> {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const waiting = pool.waitingCount;

  if (waiting > 0) {
    return {
      ok: false,
      error: `${waiting} queries waiting - pool likely exhausted (${total} connections)`,
    };
  }
  return { ok: true, detail: `${total} total, ${idle} idle, ${waiting} waiting` };
}

async function checkSocketIO(): Promise<CheckResult> {
  const io = getIO();
  if (!io) {
    return { ok: false, error: "Socket.IO instance not initialized" };
  }
  const clients = io.engine.clientsCount;
  return { ok: true, detail: `${clients} connected clients` };
}

async function checkWebSocket(wss: WebSocketServer): Promise<CheckResult> {
  if (!wss) {
    return { ok: false, error: "WebSocket server not initialized" };
  }
  const clients = wss.clients.size;
  return { ok: true, detail: `${clients} connected clients` };
}

async function checkRedis(): Promise<CheckResult> {
  if (!isRedisEnabled()) {
    return { ok: true, detail: "disabled (single-instance mode)" };
  }
  try {
    const { getRedisPublisher } = await import("../realtime/ws-redis.js");
    const pub = getRedisPublisher();
    if (!pub) {
      return { ok: false, error: "Redis enabled but publisher not connected" };
    }
    await pub.ping();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// --- Alerting ---

function categoryForSubsystem(subsystem: string): ErrorCategory {
  return subsystem === "postgres" || subsystem === "db-roundtrip" || subsystem === "db-pool"
    ? "database_connectivity"
    : "health_failure";
}

async function maybeSendAlert(subsystem: string, error: string): Promise<void> {
  const category = categoryForSubsystem(subsystem);
  errorMonitor.trackError(
    category,
    new Error(`${subsystem} health check failed: ${error}`),
    { job: "healthMonitor", messageType: subsystem, errorCode: "health_check_failed" },
    { persist: false, priority: category === "database_connectivity" ? "high" : "normal" }
  );
}

async function maybeSendRecovery(subsystem: string): Promise<void> {
  if (!subsystemWasFailing.get(subsystem)) return;
  subsystemWasFailing.set(subsystem, false);

  try {
    await errorMonitor.sendNotification(
      "health_failure",
      `[SchoolPilot RECOVERED] ${subsystem} is healthy again`,
      [
        `Subsystem: ${subsystem}`,
        "Status: RECOVERED",
        `Time: ${new Date().toISOString()}`,
      ].join("\n"),
      { job: "healthMonitor", messageType: subsystem, errorCode: "recovery" },
      { persist: false, priority: "low" }
    );
  } catch (recoveryErr) {
    console.error("[HealthMonitor] Failed to send recovery notification:", recoveryErr);
  }
}

// --- Main loop ---

async function runAllChecks(wss: WebSocketServer): Promise<void> {
  const checks: Array<{ name: string; fn: () => Promise<CheckResult> }> = [
    { name: "postgres", fn: checkPostgres },
    { name: "db-roundtrip", fn: checkDbRoundTrip },
    { name: "db-pool", fn: checkDbPool },
    { name: "socketio", fn: checkSocketIO },
    { name: "websocket", fn: () => checkWebSocket(wss) },
    { name: "redis", fn: checkRedis },
  ];

  let allPassed = true;

  for (const check of checks) {
    try {
      const result = await check.fn();
      if (result.ok) {
        await maybeSendRecovery(check.name);
      } else {
        allPassed = false;
        subsystemWasFailing.set(check.name, true);
        await maybeSendAlert(check.name, result.error ?? "unknown failure");
        console.error(
          `[HealthMonitor] FAIL: ${check.name} — ${result.error}`
        );
      }
    } catch (err: any) {
      allPassed = false;
      subsystemWasFailing.set(check.name, true);
      await maybeSendAlert(check.name, err.message ?? String(err));
      console.error(
        `[HealthMonitor] FAIL: ${check.name} — ${err.message}`
      );
    }
  }

  if (allPassed) {
    console.log("[HealthMonitor] All checks passed");
  }
}

// --- Startup ---

export function startHealthMonitor(wss: WebSocketServer): void {
  console.log("[HealthMonitor] Starting (interval: 5 minutes)");
  startupTimer = setTimeout(() => runAllChecks(wss), STARTUP_DELAY_MS);
  intervalTimer = setInterval(() => runAllChecks(wss), CHECK_INTERVAL_MS);
}

export function stopHealthMonitor(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
