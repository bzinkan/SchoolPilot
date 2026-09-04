// Centralized error monitoring with developer alerts via email + Telegram.
// Every sink receives the same normalized, redacted event: durable error_logs,
// alert channels, optional Sentry capture, health stats, and CloudWatch EMF.

import { createHash } from "crypto";
import { sendEmail } from "./email.js";
import { captureError, flushSentry } from "./sentry.js";
import { safeErrorMetadata } from "../util/safeLogging.js";
import { schedulerDatabaseAllowed } from "../config/databasePools.js";
import {
  createDefaultMonitorAggregation,
  type MonitorAggregationAdapter,
  type MonitorAggregationStatus,
} from "./monitorAggregation.js";
import { resolveStaffLifecycleGuardCode } from "./staffLifecycleGuardSignal.js";
import { getRuntimeMetadata } from "./runtimeMetadata.js";
import { wasTenantPoolAcquisitionFailureReported } from "../util/operationalErrors.js";

export type { MonitorAggregationAdapter, MonitorAggregationStatus } from "./monitorAggregation.js";

const WINDOW_MS = 5 * 60 * 1000;
const BUCKET_MS = 30 * 1000;
const RETRY_COOLDOWN_MS = 2 * 60 * 1000;
const DEFAULT_ALERT_TIMEOUT_MS = 5_000;
const DEFAULT_METRICS_INTERVAL_MS = 60_000;
const MAX_TELEGRAM_CHARS = 4096;
const MAX_MESSAGE_CHARS = 4000;
const MAX_STACK_CHARS = 8000;
const MAX_SAFE_CONTEXT_CHARS = 500;
const MAX_SAMPLES_PER_FINGERPRINT = 5;
const DEFAULT_MAX_FINGERPRINTS = 250;

export type ErrorCategory =
  | "fatal_process_error"
  | "api_error"
  | "client_error"
  | "scheduler_failure"
  | "email_failure"
  | "websocket_error"
  | "security_event"
  | "database_connectivity"
  | "health_failure"
  | "browser_runtime_error"
  | "extension_runtime_error"
  | "staff_identity_integrity"
  | "staff_lifecycle_guard_violation";

export type MonitorPriority = "low" | "normal" | "high" | "critical";

export type MonitorEventOptions = {
  persist?: boolean;
  alert?: boolean;
  priority?: MonitorPriority;
};

export type DeliveryResult = {
  channel: "email" | "telegram";
  attempted: boolean;
  delivered: boolean;
  error?: string;
  skippedReason?: string;
};

export type AlertingStatus = {
  ok: boolean;
  configuredChannels: string[];
  degradedReason?: string;
};

export type MonitorRuntimeMetadata = {
  environment: string;
  service: string;
  instanceId: string;
  release: string;
  startedAt: string;
};

export type MonitorCounterSet = {
  captured: number;
  persisted: number;
  persistFailed: number;
  dropped: number;
  alertAttempted: number;
  alertDelivered: number;
  alertFailed: number;
  cooldownSuppressed: number;
};

export type MonitorFingerprintStats = {
  fingerprint: string;
  category: ErrorCategory;
  priority: MonitorPriority;
  count: number;
  recentCount: number;
  firstSeen: string;
  lastSeen: string;
  fields: {
    errorCode?: string;
    topStackFrame?: string;
    path?: string;
    job?: string;
    messageType?: string;
  };
  counters: MonitorCounterSet;
  samples: string[];
};

export type MonitorStats = {
  generatedAt: string;
  windowMs: number;
  activeFingerprints: number;
  maxFingerprints: number;
  lastPersistFailureAt?: string;
  lastAlertFailureAt?: string;
  totals: MonitorCounterSet;
  byCategory: Partial<Record<ErrorCategory, MonitorCounterSet>>;
  fingerprints: MonitorFingerprintStats[];
};

type SafeContextKey =
  | "job"
  | "eventId"
  | "eventType"
  | "messageType"
  | "errorCode"
  | "source"
  | "surface"
  | "component"
  | "release"
  | "clientVersion"
  | "extensionVersion"
  | "chromeVersion";
type SafeContext = Partial<Record<SafeContextKey, string>>;
type PersistResult = "persisted" | "dropped" | "failed" | void;

type MonitorCorrelation = {
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
};

type FingerprintFields = {
  errorCode?: string;
  topStackFrame?: string;
  path?: string;
  job?: string;
  messageType?: string;
};

export type NormalizedMonitorEvent = {
  timestamp: number;
  category: ErrorCategory;
  message: string;
  stack?: string;
  context?: SafeContext;
  correlation: MonitorCorrelation;
  priority: MonitorPriority;
  fingerprint: string;
  fingerprintFields: FingerprintFields;
  runtime: MonitorRuntimeMetadata;
  sentryError: Error;
};

type Sample = {
  timestamp: number;
  text: string;
};

type FingerprintState = {
  fingerprint: string;
  category: ErrorCategory;
  priority: MonitorPriority;
  count: number;
  firstSeen: number;
  lastSeen: number;
  fields: FingerprintFields;
  counters: MonitorCounterSet;
  samples: Sample[];
  buckets: Map<number, number>;
  cooldownUntil: number;
};

export type ErrorMonitorOptions = {
  now?: () => number;
  persist?: (event: NormalizedMonitorEvent) => Promise<PersistResult>;
  capture?: (
    error: unknown,
    context?: {
      category?: string;
      requestId?: string;
      schoolId?: string;
      userId?: string;
      fingerprint?: string;
      release?: string;
      instanceId?: string;
    }
  ) => void;
  flushExternal?: (timeoutMs: number) => Promise<unknown>;
  dispatchAlert?: (subject: string, text: string) => Promise<DeliveryResult[]>;
  startHousekeeping?: boolean;
  startMetrics?: boolean;
  metricsIntervalMs?: number;
  maxFingerprints?: number;
  metricsSink?: (line: string) => void;
  aggregation?: MonitorAggregationAdapter;
};

const THRESHOLDS: Record<ErrorCategory, number> = {
  fatal_process_error: 1,
  api_error: 5,
  client_error: 10,
  scheduler_failure: 2,
  email_failure: 3,
  websocket_error: 10,
  security_event: 1,
  database_connectivity: 1,
  health_failure: 1,
  browser_runtime_error: 10,
  extension_runtime_error: 25,
  staff_identity_integrity: 1,
  staff_lifecycle_guard_violation: 3,
};

const COOLDOWNS: Record<ErrorCategory, number> = {
  fatal_process_error: 15 * 60 * 1000,
  api_error: 15 * 60 * 1000,
  client_error: 30 * 60 * 1000,
  scheduler_failure: 15 * 60 * 1000,
  email_failure: 30 * 60 * 1000,
  websocket_error: 15 * 60 * 1000,
  security_event: 30 * 60 * 1000,
  database_connectivity: 15 * 60 * 1000,
  health_failure: 60 * 60 * 1000,
  browser_runtime_error: 30 * 60 * 1000,
  extension_runtime_error: 30 * 60 * 1000,
  staff_identity_integrity: 6 * 60 * 60 * 1000,
  staff_lifecycle_guard_violation: 15 * 60 * 1000,
};

const SAFE_CONTEXT_KEYS: SafeContextKey[] = [
  "job",
  "eventId",
  "eventType",
  "messageType",
  "errorCode",
  "source",
  "surface",
  "component",
  "release",
  "clientVersion",
  "extensionVersion",
  "chromeVersion",
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi;
const API_KEY_RE = /\b(?:sk|SG|xox[abprs]?)-[A-Za-z0-9_-]{12,}\b/g;
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b(token|secret|api[_-]?key|apikey|password|passcode|signature|sig|authorization|auth|access[_-]?token|refresh[_-]?token|id[_-]?token|code)=([^\s&"'<>)]{3,})/gi;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const RELATIVE_QUERY_RE = /((?:^|[\s"'(])\/[A-Za-z0-9._~!$&'()*+,;=:@/%-]+)\?[^\s"'<>)]*/g;
const LINE_COLUMN_RE = /:\d+:\d+/g;

function getAdminEmail(): string {
  return process.env.ADMIN_EMAIL || "bzinkan@school-pilot.net";
}

export function getMonitorRuntimeMetadata(): MonitorRuntimeMetadata {
  return getRuntimeMetadata();
}

function isSendGridConfigured(): boolean {
  return Boolean(process.env.SENDGRID_API_KEY);
}

function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function limit(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 12))}\n[truncated]` : s;
}

function stripUrlQuery(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split(/[?#]/, 1)[0] || raw;
  }
}

export function sanitizeMonitorString(input: string): string {
  return input
    .replace(URL_RE, stripUrlQuery)
    .replace(RELATIVE_QUERY_RE, "$1")
    .replace(SECRET_ASSIGNMENT_RE, (_match, key) => `${key}=[redacted]`)
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(JWT_RE, "[jwt]")
    .replace(API_KEY_RE, "[secret]")
    .replace(EMAIL_RE, "[email]")
    .replace(IPV4_RE, "[ip]");
}

function normalizeOptionalString(value: unknown, max = MAX_SAFE_CONTEXT_CHARS): string | undefined {
  if (value === undefined || value === null) return undefined;
  const sanitized = limit(sanitizeMonitorString(String(value)), max).trim();
  return sanitized || undefined;
}

function normalizeStatusCode(context: Record<string, unknown>): number | undefined {
  const raw = context.statusCode ?? context.status;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function normalizeMonitorPath(value: unknown): string | undefined {
  const raw = normalizeOptionalString(value, 1000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, "http://localhost");
    return sanitizeMonitorString(url.pathname || "/");
  } catch {
    return sanitizeMonitorString(raw.split(/[?#]/, 1)[0] || raw);
  }
}

function safeContextFrom(context: Record<string, unknown>): SafeContext | undefined {
  const safe: SafeContext = {};
  for (const key of SAFE_CONTEXT_KEYS) {
    const value = normalizeOptionalString(context[key]);
    if (value !== undefined) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function messageFrom(error: Error | string | unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function stackFrom(error: Error | string | unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function normalizeStackFrame(stack?: string): string | undefined {
  if (!stack) return undefined;
  const lines = sanitizeMonitorString(stack)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const frame = lines.find((line) => line.startsWith("at ")) ?? lines[1];
  return frame ? limit(frame.replace(LINE_COLUMN_RE, ":line:col"), 500) : undefined;
}

function priorityRank(priority: MonitorPriority): number {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    case "low":
      return 1;
  }
}

function defaultPriority(category: ErrorCategory): MonitorPriority {
  if (category === "fatal_process_error" || category === "security_event") return "critical";
  if (
    category === "database_connectivity" ||
    category === "health_failure" ||
    category === "staff_identity_integrity" ||
    category === "staff_lifecycle_guard_violation"
  ) return "high";
  if (category === "client_error") return "low";
  return "normal";
}

function createCounters(): MonitorCounterSet {
  return {
    captured: 0,
    persisted: 0,
    persistFailed: 0,
    dropped: 0,
    alertAttempted: 0,
    alertDelivered: 0,
    alertFailed: 0,
    cooldownSuppressed: 0,
  };
}

function copyCounters(counters: MonitorCounterSet): MonitorCounterSet {
  return { ...counters };
}

function counterKey(name: keyof MonitorCounterSet): string {
  return `Monitor${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
}

function categoryMetricPrefix(category: ErrorCategory): string {
  return category
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function hashFingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

function fingerprintFieldsFrom(
  category: ErrorCategory,
  stack: string | undefined,
  correlation: MonitorCorrelation,
  context?: SafeContext
): { fingerprint: string; fields: FingerprintFields } {
  const fields: FingerprintFields = {
    errorCode: context?.errorCode,
    topStackFrame: normalizeStackFrame(stack),
    path: correlation.path,
    job: context?.job,
    messageType: context?.messageType,
  };
  const fingerprint = hashFingerprint([
    category,
    fields.errorCode ?? "",
    fields.topStackFrame ?? "",
    fields.path ?? "",
    fields.job ?? "",
    fields.messageType ?? "",
  ]);
  return { fingerprint, fields };
}

export function normalizeMonitorEvent(
  category: ErrorCategory,
  error: Error | string | unknown,
  context: Record<string, unknown> = {},
  timestamp = Date.now(),
  options: MonitorEventOptions = {}
): NormalizedMonitorEvent {
  const message = limit(sanitizeMonitorString(messageFrom(error)), MAX_MESSAGE_CHARS) || "[empty error]";
  const stack = stackFrom(error);
  const sanitizedStack = stack ? limit(sanitizeMonitorString(stack), MAX_STACK_CHARS) : undefined;
  const correlation: MonitorCorrelation = {
    requestId: normalizeOptionalString(context.requestId),
    method: normalizeOptionalString(context.method)?.toUpperCase(),
    path: normalizeMonitorPath(context.path),
    statusCode: normalizeStatusCode(context),
  };
  const safeContext = safeContextFrom(context);
  const { fingerprint, fields } = fingerprintFieldsFrom(category, sanitizedStack, correlation, safeContext);

  const sentryError = new Error(message);
  sentryError.name = error instanceof Error ? sanitizeMonitorString(error.name || "Error") : "Error";
  if (sanitizedStack) sentryError.stack = sanitizedStack;

  return {
    timestamp,
    category,
    message,
    stack: sanitizedStack,
    context: safeContext,
    correlation,
    priority: options.priority ?? defaultPriority(category),
    fingerprint,
    fingerprintFields: fields,
    runtime: getMonitorRuntimeMetadata(),
    sentryError,
  };
}

function contextPairs(event: NormalizedMonitorEvent): string[] {
  const pairs: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") pairs.push(`${key}: ${value}`);
  };
  add("requestId", event.correlation.requestId);
  add("method", event.correlation.method);
  add("path", event.correlation.path);
  add("status", event.correlation.statusCode);
  add("fingerprint", event.fingerprint);
  if (event.context) {
    for (const [key, value] of Object.entries(event.context)) add(key, value);
  }
  return pairs;
}

function formatSample(event: NormalizedMonitorEvent): string {
  const time = new Date(event.timestamp).toISOString().slice(11, 19);
  const pairs = contextPairs(event);
  const ctx = pairs.length > 0 ? ` (${pairs.join(", ")})` : "";
  return `  - [${time}] ${event.message}${ctx}`;
}

function truncateTelegramMessage(message: string): string {
  return limit(message, MAX_TELEGRAM_CHARS);
}

async function timeoutAfter<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let inFlightPersists = 0;
const MAX_INFLIGHT_PERSISTS = 50;

async function persistErrorLog(event: NormalizedMonitorEvent): Promise<PersistResult> {
  if (inFlightPersists >= MAX_INFLIGHT_PERSISTS) return "dropped";
  inFlightPersists++;
  try {
    const { errorLogs } = await import("../schema/shared.js");
    const values = {
      category: event.category,
      message: event.message,
      stack: event.stack ?? null,
      requestId: event.correlation.requestId ?? null,
      method: event.correlation.method ?? null,
      path: event.correlation.path ?? null,
      statusCode: event.correlation.statusCode ?? null,
      // Identifier-bearing legacy columns remain nullable for schema
      // compatibility, but operational telemetry never populates them.
      schoolId: null,
      userId: null,
      context: event.context ?? null,
    };

    if (schedulerDatabaseAllowed()) {
      const { schedulerDb } = await import("./schedulerDb.js");
      await schedulerDb.insert(errorLogs).values(values);
    } else {
      const [{ db }, { runWithTenantContext }] = await Promise.all([
        import("../db.js"),
        import("../middleware/tenantContext.js"),
      ]);
      await runWithTenantContext({ isSuper: true }, () =>
        db.insert(errorLogs).values(values)
      );
    }
    return "persisted";
  } catch (err) {
    console.error("[ErrorMonitor] Failed to persist error_log:", safeErrorMetadata(err));
    return "failed";
  } finally {
    inFlightPersists--;
  }
}

async function sendAlertEmail(subject: string, text: string): Promise<DeliveryResult> {
  if (!isSendGridConfigured()) {
    return {
      channel: "email",
      attempted: false,
      delivered: false,
      skippedReason: "SENDGRID_API_KEY is not configured",
    };
  }

  try {
    const safeSubject = limit(sanitizeMonitorString(subject), 500);
    const safeText = limit(sanitizeMonitorString(text), MAX_STACK_CHARS);
    const delivered = await timeoutAfter(
      sendEmail({ to: getAdminEmail(), subject: safeSubject, text: safeText }),
      DEFAULT_ALERT_TIMEOUT_MS,
      false
    );
    return delivered
      ? { channel: "email", attempted: true, delivered: true }
      : { channel: "email", attempted: true, delivered: false, error: "SendGrid delivery failed or timed out" };
  } catch (err) {
    return {
      channel: "email",
      attempted: true,
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendTelegramAlert(
  subject: string,
  text: string,
  timeoutMs = DEFAULT_ALERT_TIMEOUT_MS
): Promise<DeliveryResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return {
      channel: "telegram",
      attempted: false,
      delivered: false,
      skippedReason: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const safeSubject = limit(sanitizeMonitorString(subject), 500);
    const safeText = limit(sanitizeMonitorString(text), MAX_STACK_CHARS);
    const message = truncateTelegramMessage(`${safeSubject}\n\n${safeText}`);
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: controller.signal,
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const telegramOk =
      typeof body === "object" &&
      body !== null &&
      "ok" in body &&
      (body as { ok?: unknown }).ok === true;

    if (!response.ok || !telegramOk) {
      return {
        channel: "telegram",
        attempted: true,
        delivered: false,
        error: `Telegram send failed (${response.status})`,
      };
    }

    return { channel: "telegram", attempted: true, delivered: true };
  } catch (err) {
    return {
      channel: "telegram",
      attempted: true,
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchAlert(subject: string, text: string): Promise<DeliveryResult[]> {
  const [email, telegram] = await Promise.all([
    sendAlertEmail(subject, text),
    sendTelegramAlert(subject, text),
  ]);
  return [email, telegram];
}

export function getAlertingStatus(): AlertingStatus {
  const configuredChannels: string[] = [];
  if (isSendGridConfigured()) configuredChannels.push("email");
  if (isTelegramConfigured()) configuredChannels.push("telegram");
  if (configuredChannels.length > 0) return { ok: true, configuredChannels };
  return {
    ok: false,
    configuredChannels,
    degradedReason: "No approved alert channel is configured",
  };
}

export class ErrorMonitor {
  private readonly fingerprints = new Map<string, FingerprintState>();
  private readonly totals = createCounters();
  private readonly byCategory = new Map<ErrorCategory, MonitorCounterSet>();
  private readonly emittedTotals = createCounters();
  private readonly emittedCategoryCaptured = new Map<ErrorCategory, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly persist: (event: NormalizedMonitorEvent) => Promise<PersistResult>;
  private readonly capture: NonNullable<ErrorMonitorOptions["capture"]>;
  private readonly flushExternal: (timeoutMs: number) => Promise<unknown>;
  private readonly dispatch: (subject: string, text: string) => Promise<DeliveryResult[]>;
  private readonly maxFingerprints: number;
  private readonly metricsSink: (line: string) => void;
  private readonly aggregation?: MonitorAggregationAdapter;
  private lastPersistFailureAt?: number;
  private lastAlertFailureAt?: number;
  private housekeepingTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;
  private disposed = false;
  private disposePromise?: Promise<void>;
  private aggregationDisposalComplete = false;
  private aggregationDisposalFailed = false;
  private disposalTimedOut = false;

  constructor(options: ErrorMonitorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persist = options.persist ?? persistErrorLog;
    this.capture = options.capture ?? captureError;
    this.flushExternal = options.flushExternal ?? flushSentry;
    this.dispatch = options.dispatchAlert ?? dispatchAlert;
    this.maxFingerprints = Math.max(1, options.maxFingerprints ?? DEFAULT_MAX_FINGERPRINTS);
    this.metricsSink = options.metricsSink ?? ((line) => console.log(line));
    this.aggregation = options.aggregation ?? createDefaultMonitorAggregation();

    if (options.startHousekeeping !== false) {
      this.housekeepingTimer = setInterval(() => this.purgeOldFingerprints(), 60 * 1000);
      this.housekeepingTimer.unref?.();
    }
    if (options.startMetrics !== false) {
      this.metricsTimer = setInterval(
        () => this.emitMetrics(),
        options.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS
      );
      this.metricsTimer.unref?.();
    }
  }

  dispose(): void {
    void this.disposeAndWait();
  }

  getDisposalSnapshot() {
    const pending = this.pending.size;
    return {
      started: this.disposed,
      pending,
      aggregationComplete: this.aggregationDisposalComplete,
      timedOut: this.disposalTimedOut,
      failed: this.aggregationDisposalFailed,
      complete: this.disposed && pending === 0 && this.aggregationDisposalComplete
        && !this.disposalTimedOut && !this.aggregationDisposalFailed,
    };
  }

  disposeAndWait(timeoutMs = DEFAULT_ALERT_TIMEOUT_MS): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    if (this.housekeepingTimer) {
      clearInterval(this.housekeepingTimer);
      this.housekeepingTimer = undefined;
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }
    const startedAt = Date.now();
    this.disposePromise = (async () => {
      // Fence new work first, then give already tracked persistence/alert work
      // one bounded opportunity to finish before closing its aggregation
      // transport. Post-await checks in `checkThreshold` prevent a timed-out
      // callback from using Redis after this point.
      await timeoutAfter(
        Promise.allSettled([...this.pending]).then(() => undefined),
        timeoutMs,
        undefined
      );
      if (this.pending.size > 0) this.disposalTimedOut = true;
      // Lifetime health counters remain cumulative. Flush only the final
      // unreported deltas before shutdown loses this process's interval.
      this.emitMetrics();
      const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
      const aggregationCleanup = Promise.resolve()
        .then(() => this.aggregation?.dispose?.())
        .then(
          () => { this.aggregationDisposalComplete = true; },
          () => { this.aggregationDisposalFailed = true; },
        );
      await timeoutAfter(aggregationCleanup, remainingMs, undefined);
      if (!this.aggregationDisposalComplete && !this.aggregationDisposalFailed) {
        this.disposalTimedOut = true;
      }
    })();
    return this.disposePromise;
  }

  trackError(
    category: ErrorCategory,
    error: Error | string | unknown,
    context?: Record<string, unknown>,
    options: MonitorEventOptions = {}
  ): void {
    if (this.disposed) return;
    // The checkout boundary already captured a sanitized, non-persisted event.
    // Do not turn that same failure into more alerts or recursive DB writes as
    // it propagates through scheduler/HTTP/realtime handlers. A process crash
    // remains a separate critical event even when its cause was reported.
    if (category !== "fatal_process_error" && wasTenantPoolAcquisitionFailureReported(error)) return;
    if (category === "client_error") {
      const guardCode = resolveStaffLifecycleGuardCode(error);
      if (guardCode) {
        // This secondary signal is deliberately detached from request, school,
        // user, membership, and resource context. Redis-backed monitor
        // aggregation alerts only after three matching guard outcomes in the
        // five-minute window.
        this.trackError(
          "staff_lifecycle_guard_violation",
          new Error("Staff lifecycle guard rejected an invalid ownership mutation"),
          {
            job: "staffLifecycleGuard",
            eventType: "staff_lifecycle_guard_violation",
            errorCode: guardCode,
            source: "api_error_monitor",
          },
          {
            persist: false,
            alert: options.alert,
            priority: "high",
          }
        );
      }
    }

    const event = normalizeMonitorEvent(category, error, context, this.now(), options);

    const fingerprint = this.recordEvent(event);
    if (!fingerprint) return;

    if (options.persist !== false) {
      this.trackTask(
        this.persist(event)
          .then((result) => this.recordPersistResult(event, result ?? "persisted"))
          .catch((err) => {
            console.error("[ErrorMonitor] Persist task failed:", safeErrorMetadata(err));
            this.recordPersistResult(event, "failed");
          })
      );
    }

    this.capture(event.sentryError, {
      category: event.category,
      requestId: event.correlation.requestId,
      fingerprint: event.fingerprint,
      release: event.runtime.release,
      instanceId: event.runtime.instanceId,
    });

    if (options.alert !== false) {
      this.trackTask(this.checkThreshold(event));
    }
  }

  async trackErrorAndFlush(
    category: ErrorCategory,
    error: Error | string | unknown,
    context?: Record<string, unknown>,
    timeoutMs = DEFAULT_ALERT_TIMEOUT_MS,
    options: MonitorEventOptions = {}
  ): Promise<void> {
    this.trackError(category, error, context, options);
    await this.flush(timeoutMs);
  }

  async sendNotification(
    category: ErrorCategory,
    subject: string,
    text: string,
    context?: Record<string, unknown>,
    options: MonitorEventOptions = {}
  ): Promise<DeliveryResult[]> {
    if (this.disposed) return [];
    const event = normalizeMonitorEvent(category, new Error(subject), context, this.now(), {
      ...options,
      persist: false,
    });
    const safeText = [
      text,
      "",
      `Environment: ${event.runtime.environment}`,
      `Release: ${event.runtime.release}`,
      `Instance: ${event.runtime.instanceId}`,
    ].join("\n");
    this.incrementCounters(category, undefined, "alertAttempted");
    const results = await this.dispatch(subject, safeText);
    this.recordAlertResults(category, event.fingerprint, results);
    return results;
  }

  async flush(timeoutMs = DEFAULT_ALERT_TIMEOUT_MS): Promise<void> {
    await timeoutAfter(
      (async () => {
        while (this.pending.size > 0) {
          await Promise.allSettled([...this.pending]);
        }
        await this.flushExternal(timeoutMs);
      })(),
      timeoutMs,
      undefined
    );
  }

  getRuntimeMetadata(): MonitorRuntimeMetadata {
    return getMonitorRuntimeMetadata();
  }

  getAggregationStatus(): MonitorAggregationStatus {
    return this.aggregation?.getStatus() ?? localAggregationStatus();
  }

  async checkAggregationStatus(timeoutMs = 1000): Promise<MonitorAggregationStatus> {
    if (this.disposed) return this.getAggregationStatus();
    return this.aggregation ? await this.aggregation.checkStatus(timeoutMs) : localAggregationStatus();
  }

  getStats(): MonitorStats {
    this.purgeOldFingerprints();
    const byCategory: Partial<Record<ErrorCategory, MonitorCounterSet>> = {};
    for (const [category, counters] of this.byCategory.entries()) {
      byCategory[category] = copyCounters(counters);
    }

    const fingerprints = [...this.fingerprints.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((state) => this.fingerprintStats(state));

    return {
      generatedAt: new Date(this.now()).toISOString(),
      windowMs: WINDOW_MS,
      activeFingerprints: this.fingerprints.size,
      maxFingerprints: this.maxFingerprints,
      lastPersistFailureAt: this.lastPersistFailureAt
        ? new Date(this.lastPersistFailureAt).toISOString()
        : undefined,
      lastAlertFailureAt: this.lastAlertFailureAt
        ? new Date(this.lastAlertFailureAt).toISOString()
        : undefined,
      totals: copyCounters(this.totals),
      byCategory,
      fingerprints,
    };
  }

  getErrorSummary(): Record<ErrorCategory, number> {
    this.purgeOldFingerprints();
    const summary: Partial<Record<ErrorCategory, number>> = {};
    for (const category of Object.keys(THRESHOLDS) as ErrorCategory[]) {
      summary[category] = 0;
    }
    for (const state of this.fingerprints.values()) {
      summary[state.category] = (summary[state.category] ?? 0) + this.recentCount(state);
    }
    return summary as Record<ErrorCategory, number>;
  }

  emitMetrics(): void {
    const stats = this.getStats();
    const runtime = this.getRuntimeMetadata();
    const metricValues: Record<string, number> = {};
    const metricDefinitions: Array<{ Name: string; Unit: "Count" }> = [];
    const intervalDefinitions: Array<{ Name: string; Unit: "Count" }> = [];

    const addMetric = (name: string, value: number) => {
      metricValues[name] = value;
      metricDefinitions.push({ Name: name, Unit: "Count" });
    };

    for (const [name, value] of Object.entries(stats.totals) as Array<[keyof MonitorCounterSet, number]>) {
      addMetric(counterKey(name), value);
      const intervalName = `${counterKey(name)}Interval`;
      metricValues[intervalName] = Math.max(0, value - this.emittedTotals[name]);
      intervalDefinitions.push({ Name: intervalName, Unit: "Count" });
    }
    for (const [category, counters] of Object.entries(stats.byCategory)) {
      const prefix = categoryMetricPrefix(category as ErrorCategory);
      for (const [name, value] of Object.entries(counters) as Array<[keyof MonitorCounterSet, number]>) {
        addMetric(`${prefix}${counterKey(name)}`, value);
      }
    }
    // Stable zero series for every category, including categories that have
    // never failed in this process. These fleet sums are interval counts, not
    // sums of the repeatedly emitted lifetime counters above.
    for (const category of Object.keys(THRESHOLDS) as ErrorCategory[]) {
      const name = `${categoryMetricPrefix(category)}${counterKey("captured")}Interval`;
      const captured = stats.byCategory[category]?.captured ?? 0;
      metricValues[name] = Math.max(0, captured - (this.emittedCategoryCaptured.get(category) ?? 0));
      intervalDefinitions.push({ Name: name, Unit: "Count" });
    }
    addMetric("ActiveFingerprints", stats.activeFingerprints);

    const legacyDirectives = [];
    // A metric directive is bounded even if every category becomes active.
    for (let offset = 0; offset < metricDefinitions.length; offset += 100) {
      legacyDirectives.push({
        Namespace: "SchoolPilot/Monitoring",
        Dimensions: [["Environment", "Service", "InstanceId"]],
        Metrics: metricDefinitions.slice(offset, offset + 100),
      });
    }

    const payload = {
      _aws: {
        Timestamp: this.now(),
        CloudWatchMetrics: [
          ...legacyDirectives,
          {
            Namespace: "SchoolPilot/Monitoring",
            Dimensions: [["Environment", "Service"]],
            Metrics: intervalDefinitions,
          },
        ],
      },
      Environment: runtime.environment,
      Service: runtime.service,
      InstanceId: runtime.instanceId,
      Release: runtime.release,
      ...metricValues,
    };

    this.metricsSink(JSON.stringify(payload));
    Object.assign(this.emittedTotals, stats.totals);
    for (const category of Object.keys(THRESHOLDS) as ErrorCategory[]) {
      this.emittedCategoryCaptured.set(category, stats.byCategory[category]?.captured ?? 0);
    }
  }

  resetStatsForTests(): void {
    this.fingerprints.clear();
    this.byCategory.clear();
    Object.assign(this.totals, createCounters());
    Object.assign(this.emittedTotals, createCounters());
    this.emittedCategoryCaptured.clear();
    this.lastPersistFailureAt = undefined;
    this.lastAlertFailureAt = undefined;
    this.cooldownUntil.clear();
    this.aggregation?.resetForTests?.();
  }

  private trackTask(task: Promise<unknown>): void {
    const tracked = task
      .catch((err) => {
        console.error("[ErrorMonitor] Background monitor task failed:", safeErrorMetadata(err));
      })
      .then(() => undefined)
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private categoryCounters(category: ErrorCategory): MonitorCounterSet {
    let counters = this.byCategory.get(category);
    if (!counters) {
      counters = createCounters();
      this.byCategory.set(category, counters);
    }
    return counters;
  }

  private incrementCounters(
    category: ErrorCategory,
    fingerprint: string | undefined,
    key: keyof MonitorCounterSet,
    by = 1
  ): void {
    this.totals[key] += by;
    this.categoryCounters(category)[key] += by;
    if (fingerprint) {
      const state = this.fingerprints.get(fingerprint);
      if (state) state.counters[key] += by;
    }
  }

  private recordEvent(event: NormalizedMonitorEvent): FingerprintState | null {
    let state = this.fingerprints.get(event.fingerprint);
    if (!state && this.fingerprints.size >= this.maxFingerprints) {
      const evicted = this.evictFingerprint(event.priority);
      if (!evicted) {
        this.incrementCounters(event.category, undefined, "captured");
        this.incrementCounters(event.category, undefined, "dropped");
        return null;
      }
    }

    state = this.fingerprints.get(event.fingerprint);
    if (!state) {
      state = {
        fingerprint: event.fingerprint,
        category: event.category,
        priority: event.priority,
        count: 0,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        fields: event.fingerprintFields,
        counters: createCounters(),
        samples: [],
        buckets: new Map<number, number>(),
        cooldownUntil: 0,
      };
      this.fingerprints.set(event.fingerprint, state);
    }

    state.priority = priorityRank(event.priority) > priorityRank(state.priority) ? event.priority : state.priority;
    state.count++;
    state.lastSeen = event.timestamp;
    state.samples.push({ timestamp: event.timestamp, text: formatSample(event) });
    if (state.samples.length > MAX_SAMPLES_PER_FINGERPRINT) state.samples.shift();
    this.incrementBucket(state, event.timestamp);
    this.incrementCounters(event.category, event.fingerprint, "captured");
    return state;
  }

  private evictFingerprint(newPriority: MonitorPriority): boolean {
    const candidates = [...this.fingerprints.values()].sort((a, b) => {
      const priorityDelta = priorityRank(a.priority) - priorityRank(b.priority);
      if (priorityDelta !== 0) return priorityDelta;
      const recentDelta = this.recentCount(a) - this.recentCount(b);
      if (recentDelta !== 0) return recentDelta;
      return a.lastSeen - b.lastSeen;
    });
    const candidate = candidates[0];
    if (!candidate) return false;
    if (priorityRank(candidate.priority) > priorityRank(newPriority)) return false;
    this.fingerprints.delete(candidate.fingerprint);
    this.incrementCounters(candidate.category, undefined, "dropped");
    return true;
  }

  private incrementBucket(state: FingerprintState, timestamp: number): void {
    const bucket = Math.floor(timestamp / BUCKET_MS) * BUCKET_MS;
    state.buckets.set(bucket, (state.buckets.get(bucket) ?? 0) + 1);
    this.pruneBuckets(state);
  }

  private pruneBuckets(state: FingerprintState): void {
    const cutoff = this.now() - WINDOW_MS;
    for (const bucket of state.buckets.keys()) {
      if (bucket + BUCKET_MS < cutoff) state.buckets.delete(bucket);
    }
  }

  private recentCount(state: FingerprintState): number {
    this.pruneBuckets(state);
    let count = 0;
    for (const value of state.buckets.values()) count += value;
    return count;
  }

  private purgeOldFingerprints(): void {
    const cutoff = this.now() - WINDOW_MS;
    for (const [fingerprint, state] of this.fingerprints.entries()) {
      this.pruneBuckets(state);
      if (state.lastSeen < cutoff && this.recentCount(state) === 0) {
        this.fingerprints.delete(fingerprint);
      }
    }
  }

  private recordPersistResult(event: NormalizedMonitorEvent, result: PersistResult): void {
    if (result === "dropped") {
      this.incrementCounters(event.category, event.fingerprint, "dropped");
      return;
    }
    if (result === "failed") {
      this.lastPersistFailureAt = this.now();
      this.incrementCounters(event.category, event.fingerprint, "persistFailed");
      return;
    }
    this.incrementCounters(event.category, event.fingerprint, "persisted");
  }

  private async checkThreshold(event: NormalizedMonitorEvent): Promise<void> {
    if (this.disposed) return;
    const state = this.fingerprints.get(event.fingerprint);
    if (!state) return;

    let count = this.recentCount(state);
    let globalAggregation = false;
    if (this.aggregation) {
      const aggregatedCount = await this.aggregation.recordEvent(event, BUCKET_MS, WINDOW_MS);
      if (this.disposed) return;
      if (typeof aggregatedCount === "number") {
        count = aggregatedCount;
        globalAggregation = true;
      }
    }

    if (count < THRESHOLDS[event.category]) return;

    if (globalAggregation && this.aggregation) {
      const acquired = await this.aggregation.tryAcquireAlert(event.fingerprint, RETRY_COOLDOWN_MS);
      if (this.disposed) return;
      if (acquired === false) {
        this.incrementCounters(event.category, event.fingerprint, "cooldownSuppressed");
        return;
      }
      if (acquired === true) {
        const delivered = await this.sendAlert(state, count);
        if (this.disposed) return;
        await this.aggregation.setCooldown(
          event.fingerprint,
          delivered ? COOLDOWNS[event.category] : RETRY_COOLDOWN_MS
        );
        return;
      }
      // Redis became unhealthy between count and election; fall back to local cooldown below.
    }

    const now = this.now();
    if (now < (this.cooldownUntil.get(event.fingerprint) ?? 0)) {
      this.incrementCounters(event.category, event.fingerprint, "cooldownSuppressed");
      return;
    }

    this.cooldownUntil.set(event.fingerprint, now + RETRY_COOLDOWN_MS);
    await this.sendAlert(state, count);
  }

  private recordAlertResults(
    category: ErrorCategory,
    fingerprint: string | undefined,
    results: DeliveryResult[]
  ): void {
    if (results.some((r) => r.delivered)) {
      this.incrementCounters(category, fingerprint, "alertDelivered");
    } else {
      this.lastAlertFailureAt = this.now();
      this.incrementCounters(category, fingerprint, "alertFailed");
    }
  }

  private async sendAlert(state: FingerprintState, count = this.recentCount(state)): Promise<boolean> {
    const samples = state.samples.slice(-MAX_SAMPLES_PER_FINGERPRINT).map((s) => s.text).join("\n");
    const runtime = this.getRuntimeMetadata();
    const subject = `[SchoolPilot ALERT] ${state.category} - ${count} matching errors in 5 min`;
    const text = [
      `Category: ${state.category}`,
      `Fingerprint: ${state.fingerprint}`,
      `Error Count: ${count} in last 5 minutes`,
      `Environment: ${runtime.environment}`,
      `Release: ${runtime.release}`,
      `Instance: ${runtime.instanceId}`,
      `Timestamp: ${new Date(this.now()).toISOString()}`,
      "",
      "Sample Errors:",
      samples,
      "",
      "This is an automated alert from SchoolPilot Error Monitor.",
    ].join("\n");

    console.error(`[ErrorMonitor] ALERT: ${state.category} - ${count} matching errors in 5 min`);
    this.incrementCounters(state.category, state.fingerprint, "alertAttempted");
    const results = await this.dispatch(subject, text);
    this.recordAlertResults(state.category, state.fingerprint, results);
    if (results.some((r) => r.delivered)) {
      this.cooldownUntil.set(state.fingerprint, this.now() + COOLDOWNS[state.category]);
      return true;
    }

    const failures = results
      .map((r) => r.error || r.skippedReason || `${r.channel} did not deliver`)
      .join("; ");
    this.cooldownUntil.set(state.fingerprint, this.now() + RETRY_COOLDOWN_MS);
    console.error(`[ErrorMonitor] ALERT delivery failed; retry cooldown active: ${failures}`);
    return false;
  }

  private fingerprintStats(state: FingerprintState): MonitorFingerprintStats {
    return {
      fingerprint: state.fingerprint,
      category: state.category,
      priority: state.priority,
      count: state.count,
      recentCount: this.recentCount(state),
      firstSeen: new Date(state.firstSeen).toISOString(),
      lastSeen: new Date(state.lastSeen).toISOString(),
      fields: { ...state.fields },
      counters: copyCounters(state.counters),
      samples: state.samples.map((s) => s.text),
    };
  }
}

function localAggregationStatus(): MonitorAggregationStatus {
  if (!process.env.REDIS_URL && process.env.NODE_ENV === "production") {
    return {
      mode: "local",
      ok: false,
      degradedReason: "REDIS_URL is not configured",
    };
  }
  return { mode: "local", ok: true };
}

const errorMonitor = new ErrorMonitor();
export default errorMonitor;
