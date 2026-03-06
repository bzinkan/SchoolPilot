// Background health monitor — checks all subsystems every 5 minutes
// Sends email alerts on failure, recovery notifications when restored

import type { Server } from "socket.io";
import type { WebSocketServer } from "ws";
import { pool } from "../db.js";
import { getIO } from "../realtime/socketio.js";
import { isRedisEnabled } from "../realtime/ws-redis.js";
import { sendEmail } from "./email.js";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "bzinkan@school-pilot.net";
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per subsystem
const STARTUP_DELAY_MS = 15_000; // 15s to let DB pool warm up

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
  error?: string;
}

// --- Alert state ---
const lastAlertSent = new Map<string, number>();
const subsystemWasFailing = new Map<string, boolean>();

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
      error: `${waiting} queries waiting — pool likely exhausted (${total}/20 connections)`,
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

async function maybeSendAlert(subsystem: string, error: string): Promise<void> {
  const now = Date.now();
  const last = lastAlertSent.get(subsystem) ?? 0;
  if (now - last < ALERT_COOLDOWN_MS) return;

  lastAlertSent.set(subsystem, now);

  const timestamp = new Date().toISOString();
  const env = process.env.NODE_ENV || "development";

  try {
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: `[SchoolPilot ALERT] ${subsystem} failure — ${timestamp}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px;">
          <h2 style="color: #dc2626;">SchoolPilot Health Monitor Alert</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Subsystem</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${subsystem}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Status</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; color: #dc2626; font-weight: bold;">FAILING</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Error</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${error}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #e5e7eb;">Server</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${env}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold;">Time</td><td style="padding: 8px;">${timestamp}</td></tr>
          </table>
          <p style="color: #6b7280; font-size: 14px; margin-top: 16px;">This alert will not repeat for 1 hour.</p>
        </div>
      `,
    });
  } catch (emailErr) {
    console.error("[HealthMonitor] Failed to send alert email:", emailErr);
  }
}

async function maybeSendRecovery(subsystem: string): Promise<void> {
  if (!subsystemWasFailing.get(subsystem)) return;
  subsystemWasFailing.set(subsystem, false);
  lastAlertSent.delete(subsystem);

  try {
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: `[SchoolPilot RECOVERED] ${subsystem} is healthy again`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px;">
          <h2 style="color: #16a34a;">SchoolPilot Health Monitor — Recovery</h2>
          <p><strong>Subsystem:</strong> ${subsystem}</p>
          <p><strong>Status:</strong> <span style="color: #16a34a;">RECOVERED</span></p>
          <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        </div>
      `,
    });
  } catch (emailErr) {
    console.error("[HealthMonitor] Failed to send recovery email:", emailErr);
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
  setTimeout(() => runAllChecks(wss), STARTUP_DELAY_MS);
  setInterval(() => runAllChecks(wss), CHECK_INTERVAL_MS);
}
