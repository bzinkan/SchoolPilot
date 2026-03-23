// Centralized error monitoring with developer alerts via email + Telegram
// Tracks errors in a sliding window and sends alerts when thresholds are exceeded

import { sendEmail } from "./email.js";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "bzinkan@school-pilot.net";
const NODE_ENV = process.env.NODE_ENV || "development";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const WINDOW_MS = 5 * 60 * 1000; // 5-minute sliding window

export type ErrorCategory =
  | "uncaught_exception"
  | "api_error"
  | "client_error"
  | "scheduler_failure"
  | "email_failure"
  | "websocket_error"
  | "database_error"
  | "auth_failure_spike";

interface TrackedError {
  timestamp: number;
  category: ErrorCategory;
  message: string;
  context?: Record<string, any>;
}

// Alert thresholds per category (errors in 5-min window to trigger alert)
const THRESHOLDS: Record<ErrorCategory, number> = {
  uncaught_exception: 1,
  api_error: 5,
  client_error: 10,
  scheduler_failure: 2,
  email_failure: 3,
  websocket_error: 10,
  database_error: 3,
  auth_failure_spike: 20,
};

// Cooldown per category in ms
const COOLDOWNS: Record<ErrorCategory, number> = {
  uncaught_exception: 15 * 60 * 1000,
  api_error: 15 * 60 * 1000,
  client_error: 30 * 60 * 1000,
  scheduler_failure: 15 * 60 * 1000,
  email_failure: 30 * 60 * 1000,
  websocket_error: 15 * 60 * 1000,
  database_error: 15 * 60 * 1000,
  auth_failure_spike: 30 * 60 * 1000,
};

class ErrorMonitor {
  private errors: TrackedError[] = [];
  private lastAlertTime = new Map<ErrorCategory, number>();

  constructor() {
    // Purge old errors every minute
    setInterval(() => this.purgeOldErrors(), 60 * 1000);
  }

  trackError(
    category: ErrorCategory,
    error: Error | string | unknown,
    context?: Record<string, any>
  ): void {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : String(error);

    const entry: TrackedError = {
      timestamp: Date.now(),
      category,
      message,
      context,
    };

    this.errors.push(entry);
    this.checkThreshold(category);
  }

  getErrorSummary(): Record<ErrorCategory, number> {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const recent = this.errors.filter((e) => e.timestamp >= cutoff);

    const summary: Record<string, number> = {};
    for (const cat of Object.keys(THRESHOLDS)) {
      summary[cat] = recent.filter((e) => e.category === cat).length;
    }
    return summary as Record<ErrorCategory, number>;
  }

  private purgeOldErrors(): void {
    const cutoff = Date.now() - WINDOW_MS;
    this.errors = this.errors.filter((e) => e.timestamp >= cutoff);
  }

  private checkThreshold(category: ErrorCategory): void {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const recentForCategory = this.errors.filter(
      (e) => e.category === category && e.timestamp >= cutoff
    );

    const threshold = THRESHOLDS[category];
    if (recentForCategory.length < threshold) return;

    // Check cooldown
    const lastAlert = this.lastAlertTime.get(category) || 0;
    const cooldown = COOLDOWNS[category];
    if (now - lastAlert < cooldown) return;

    // Send alert
    this.lastAlertTime.set(category, now);
    this.sendAlert(category, recentForCategory).catch((err) => {
      console.error("[ErrorMonitor] Failed to send alert email:", err);
    });
  }

  private async sendAlert(
    category: ErrorCategory,
    errors: TrackedError[]
  ): Promise<void> {
    const count = errors.length;
    const samples = errors
      .slice(-5)
      .map((e) => {
        const time = new Date(e.timestamp).toISOString().slice(11, 19);
        const ctx = e.context
          ? ` (${Object.entries(e.context)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")})`
          : "";
        return `  • [${time}] ${e.message}${ctx}`;
      })
      .join("\n");

    const subject = `[SchoolPilot ALERT] ${category} — ${count} errors in 5 min`;
    const text = [
      `Category: ${category}`,
      `Error Count: ${count} in last 5 minutes`,
      `Environment: ${NODE_ENV}`,
      `Timestamp: ${new Date().toISOString()}`,
      "",
      "Sample Errors:",
      samples,
      "",
      "---",
      "This is an automated alert from SchoolPilot Error Monitor.",
    ].join("\n");

    console.error(
      `[ErrorMonitor] ALERT: ${category} — ${count} errors in 5 min`
    );

    // Send email alert
    await sendEmail({
      to: ADMIN_EMAIL,
      subject,
      text,
    });

    // Send Telegram alert (picked up by Claude Code Channels)
    await sendTelegramAlert(subject, text);
  }
}

// Telegram alert — sends to bot which Claude Code Channels picks up
export async function sendTelegramAlert(subject: string, text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const message = `🚨 *${subject}*\n\n\`\`\`\n${text}\n\`\`\``;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("[ErrorMonitor] Telegram alert failed:", err);
  }
}

// Singleton instance
const errorMonitor = new ErrorMonitor();
export default errorMonitor;
