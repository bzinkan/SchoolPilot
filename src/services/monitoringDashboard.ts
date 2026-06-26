import { and, desc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import db, { pool } from "../db.js";
import { getIO } from "../realtime/socketio.js";
import { errorLogs, type ErrorLog } from "../schema/shared.js";
import errorMonitor, {
  getAlertingStatus,
  type AlertingStatus,
  type ErrorCategory,
  type MonitorAggregationStatus,
  type MonitorCounterSet,
  type MonitorFingerprintStats,
  type MonitorPriority,
  type MonitorRuntimeMetadata,
  type MonitorStats,
} from "./errorMonitor.js";

export type MonitoringPanelStatus = "healthy" | "degraded" | "unhealthy";

export type MonitoringStatusSummary = {
  status: MonitoringPanelStatus;
  generatedAt: string;
  coreOk: boolean;
  alertingOk: boolean;
  aggregationOk: boolean;
  activeFingerprints: number;
  recentErrors: number;
  alertFailed: number;
  persistFailed: number;
  configuredChannels: string[];
  aggregationMode: MonitorAggregationStatus["mode"];
  degradedReasons: string[];
};

export type MonitoringHealthSnapshot = {
  status: MonitoringPanelStatus;
  generatedAt: string;
  coreOk: boolean;
  alerting: AlertingStatus;
  aggregation: MonitorAggregationStatus;
  runtime: MonitorRuntimeMetadata;
  stats: MonitorStats;
  checks: Record<string, unknown>;
};

export type MonitoringOverview = {
  status: MonitoringStatusSummary;
  runtime: MonitorRuntimeMetadata;
  alerting: AlertingStatus;
  aggregation: MonitorAggregationStatus;
  stats: Omit<MonitorStats, "fingerprints">;
  topFingerprints: MonitoringFingerprintRow[];
  recentCategorySummary: Array<{
    category: ErrorCategory;
    count: number;
    alertDelivered: number;
    alertFailed: number;
  }>;
  health: {
    status: MonitoringPanelStatus;
    coreOk: boolean;
    generatedAt: string;
  };
};

export type MonitoringFingerprintRow = {
  fingerprint: string;
  category: ErrorCategory;
  priority: MonitorPriority;
  count: number;
  recentCount: number;
  firstSeen: string;
  lastSeen: string;
  fields: MonitorFingerprintStats["fields"];
  counters: MonitorCounterSet;
  samples: string[];
};

export type MonitoringRecentErrorRow = {
  id: string;
  category: string;
  message: string;
  stack?: string;
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  schoolId?: string;
  userId?: string;
  context?: Record<string, string>;
  createdAt: string;
};

export type MonitoringRecentErrorsResponse = {
  errors: MonitoringRecentErrorRow[];
  nextCursor?: string;
};

type ParsedRecentErrorQuery = {
  rangeMs: number;
  category?: ErrorCategory;
  schoolId?: string;
  q?: string;
  limit: number;
  cursor?: {
    createdAt: Date;
    id: string;
  };
};

type ParsedFingerprintQuery = {
  category?: ErrorCategory;
  priority?: MonitorPriority;
  q?: string;
  limit: number;
};

export class MonitoringQueryError extends Error {
  statusCode = 400;
}

const MONITORING_CATEGORIES = [
  "fatal_process_error",
  "api_error",
  "client_error",
  "scheduler_failure",
  "email_failure",
  "websocket_error",
  "security_event",
  "database_connectivity",
  "health_failure",
  "browser_runtime_error",
  "extension_runtime_error",
] as const satisfies readonly ErrorCategory[];

const MONITORING_PRIORITIES = ["low", "normal", "high", "critical"] as const satisfies readonly MonitorPriority[];

const RANGE_MS = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} as const;

const SAFE_CONTEXT_KEYS = [
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
] as const;

const SECURITY_CONTEXT_KEYS = ["eventId", "eventType", "errorCode"] as const;
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_SCHOOL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi;
const API_KEY_RE = /\b(?:sk|SG|xox[abprs]?)-[A-Za-z0-9_-]{12,}\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b(token|api[_-]?key|secret|password|passwd|pwd|authorization|auth|session|cookie)=([^&\s]+)/gi;
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const PATH_QUERY_RE = /(^|[\s(])((?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)+)\?[^)\s<>"']*/g;

export async function buildMonitoringHealthSnapshot(): Promise<MonitoringHealthSnapshot> {
  const checks: Record<string, unknown> = {};
  let coreOk = true;

  try {
    const start = Date.now();
    await pool.query("SELECT 1");
    checks.postgres = { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    checks.postgres = { ok: false, error: error.message };
    errorMonitor.trackError(
      "database_connectivity",
      error,
      { job: "health_endpoint", messageType: "postgres", errorCode: error.code },
      { persist: false, priority: "high" }
    );
    coreOk = false;
  }

  const waiting = pool.waitingCount;
  checks.dbPool = {
    ok: waiting === 0,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting,
  };
  if (waiting > 0) {
    errorMonitor.trackError(
      "database_connectivity",
      new Error(`${waiting} queries waiting in main DB pool`),
      { job: "health_endpoint", messageType: "db-pool", errorCode: "pool_waiting" },
      { persist: false, priority: "high" }
    );
    coreOk = false;
  }

  const io = getIO();
  checks.socketio = io
    ? { ok: true, clients: io.engine.clientsCount }
    : { ok: false, error: "not initialized" };
  if (!io) coreOk = false;

  const alerting = getAlertingStatus();
  checks.alerting = alerting.ok
    ? { ok: true, configuredChannels: alerting.configuredChannels }
    : {
        ok: false,
        configuredChannels: alerting.configuredChannels,
        error: alerting.degradedReason,
      };

  const stats = errorMonitor.getStats();
  const runtime = errorMonitor.getRuntimeMetadata();
  const aggregation = errorMonitor.getAggregationStatus();
  const generatedAt = new Date().toISOString();

  checks.uptime = Math.floor(process.uptime());
  checks.timestamp = generatedAt;
  checks.recentErrors = errorMonitor.getErrorSummary();
  checks.monitoring = {
    ok: true,
    runtime,
    stats,
    aggregation,
  };

  return {
    status: deriveMonitoringStatus(coreOk, alerting, aggregation, stats),
    generatedAt,
    coreOk,
    alerting,
    aggregation,
    runtime,
    stats,
    checks,
  };
}

export function buildMonitoringStatusSummary(snapshot: MonitoringHealthSnapshot): MonitoringStatusSummary {
  const recentErrors = Object.values((snapshot.checks.recentErrors ?? {}) as Record<string, number>)
    .reduce((sum, value) => sum + value, 0);

  return {
    status: snapshot.status,
    generatedAt: snapshot.generatedAt,
    coreOk: snapshot.coreOk,
    alertingOk: snapshot.alerting.ok,
    aggregationOk: snapshot.aggregation.ok,
    activeFingerprints: snapshot.stats.activeFingerprints,
    recentErrors,
    alertFailed: snapshot.stats.totals.alertFailed,
    persistFailed: snapshot.stats.totals.persistFailed,
    configuredChannels: snapshot.alerting.configuredChannels,
    aggregationMode: snapshot.aggregation.mode,
    degradedReasons: degradedReasons(snapshot),
  };
}

export async function getMonitoringOverview(): Promise<MonitoringOverview> {
  const snapshot = await buildMonitoringHealthSnapshot();
  const { fingerprints: _fingerprints, ...statsSummary } = snapshot.stats;
  const fingerprints = sortedFingerprintRows(snapshot.stats.fingerprints).slice(0, 10);
  const recentCategorySummary = Object.entries(snapshot.stats.byCategory)
    .map(([category, counters]) => ({
      category: category as ErrorCategory,
      count: counters.captured,
      alertDelivered: counters.alertDelivered,
      alertFailed: counters.alertFailed,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    status: buildMonitoringStatusSummary(snapshot),
    runtime: snapshot.runtime,
    alerting: snapshot.alerting,
    aggregation: snapshot.aggregation,
    stats: statsSummary,
    topFingerprints: fingerprints,
    recentCategorySummary,
    health: {
      status: snapshot.status,
      coreOk: snapshot.coreOk,
      generatedAt: snapshot.generatedAt,
    },
  };
}

export function listMonitoringFingerprints(query: Record<string, unknown>): MonitoringFingerprintRow[] {
  const parsed = parseFingerprintQuery(query);
  return sortedFingerprintRows(errorMonitor.getStats().fingerprints)
    .filter((row) => !parsed.category || row.category === parsed.category)
    .filter((row) => !parsed.priority || row.priority === parsed.priority)
    .filter((row) => !parsed.q || row.fingerprint.includes(parsed.q))
    .slice(0, parsed.limit);
}

export async function listMonitoringRecentErrors(query: Record<string, unknown>): Promise<MonitoringRecentErrorsResponse> {
  const parsed = parseRecentErrorQuery(query);
  const since = new Date(Date.now() - parsed.rangeMs);
  const conditions: SQL[] = [gte(errorLogs.createdAt, since)];

  if (parsed.category) conditions.push(eq(errorLogs.category, parsed.category));
  if (parsed.schoolId) conditions.push(eq(errorLogs.schoolId, parsed.schoolId));
  if (parsed.q) {
    const qCondition = or(
      eq(errorLogs.id, parsed.q),
      eq(errorLogs.requestId, parsed.q),
      sql`${errorLogs.context}->>'eventId' = ${parsed.q}`,
      sql`${errorLogs.context}->>'fingerprint' = ${parsed.q}`
    );
    if (qCondition) conditions.push(qCondition);
  }
  if (parsed.cursor) {
    const cursorCondition = or(
      lt(errorLogs.createdAt, parsed.cursor.createdAt),
      and(eq(errorLogs.createdAt, parsed.cursor.createdAt), lt(errorLogs.id, parsed.cursor.id))
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = await db
    .select()
    .from(errorLogs)
    .where(and(...conditions))
    .orderBy(desc(errorLogs.createdAt), desc(errorLogs.id))
    .limit(parsed.limit + 1);

  const page = rows.slice(0, parsed.limit);
  const extra = rows[parsed.limit];

  return {
    errors: page.map(sanitizeRecentErrorLogForMonitoring),
    nextCursor: extra ? encodeCursor(extra.createdAt, extra.id) : undefined,
  };
}

export function sanitizeRecentErrorLogForMonitoring(row: ErrorLog): MonitoringRecentErrorRow {
  const category = sanitizeUiString(row.category, 120);
  const securityEvent = category === "security_event";
  const context = sanitizeContext(row.context, securityEvent);
  const securityEventId = securityEvent ? context?.eventId : undefined;
  const message = securityEvent
    ? sanitizeUiString(
        securityEventId ? `Security event recorded (${securityEventId})` : "Security event recorded",
        500
      )
    : sanitizeUiString(row.message, 1000);

  return {
    id: row.id,
    category,
    message,
    stack: row.stack && !securityEvent ? sanitizeUiString(row.stack, 4000) : undefined,
    requestId: sanitizeOptionalIdentifier(row.requestId),
    method: sanitizeOptionalIdentifier(row.method),
    path: pathnameOnly(row.path),
    statusCode: typeof row.statusCode === "number" ? row.statusCode : undefined,
    schoolId: sanitizeOptionalIdentifier(row.schoolId),
    userId: sanitizeOptionalIdentifier(row.userId),
    context,
    createdAt: row.createdAt.toISOString(),
  };
}

function deriveMonitoringStatus(
  coreOk: boolean,
  alerting: AlertingStatus,
  aggregation: MonitorAggregationStatus,
  stats: MonitorStats
): MonitoringPanelStatus {
  if (!coreOk) return "unhealthy";
  if (!alerting.ok || !aggregation.ok || stats.totals.persistFailed > 0 || stats.totals.alertFailed > 0) {
    return "degraded";
  }
  return "healthy";
}

function degradedReasons(snapshot: MonitoringHealthSnapshot): string[] {
  const reasons: string[] = [];
  if (!snapshot.coreOk) reasons.push("core subsystem failure");
  if (!snapshot.alerting.ok) reasons.push(snapshot.alerting.degradedReason ?? "alerting degraded");
  if (!snapshot.aggregation.ok) reasons.push(snapshot.aggregation.degradedReason ?? "aggregation degraded");
  if (snapshot.stats.totals.persistFailed > 0) reasons.push("monitor persistence failures");
  if (snapshot.stats.totals.alertFailed > 0) reasons.push("monitor alert delivery failures");
  return reasons;
}

function sortedFingerprintRows(fingerprints: MonitorFingerprintStats[]): MonitoringFingerprintRow[] {
  return fingerprints
    .map((fp) => ({
      fingerprint: fp.fingerprint,
      category: fp.category,
      priority: fp.priority,
      count: fp.count,
      recentCount: fp.recentCount,
      firstSeen: fp.firstSeen,
      lastSeen: fp.lastSeen,
      fields: sanitizeFingerprintFields(fp.fields),
      counters: fp.counters,
      samples: fp.samples.map((sample) => sanitizeUiString(sample, 1000)),
    }))
    .sort((a, b) => {
      const recentDelta = b.recentCount - a.recentCount;
      if (recentDelta !== 0) return recentDelta;
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    });
}

function sanitizeFingerprintFields(fields: MonitorFingerprintStats["fields"]): MonitorFingerprintStats["fields"] {
  return {
    errorCode: sanitizeOptionalContextValue(fields.errorCode),
    topStackFrame: sanitizeOptionalContextValue(fields.topStackFrame),
    path: pathnameOnly(fields.path),
    job: sanitizeOptionalContextValue(fields.job),
    messageType: sanitizeOptionalContextValue(fields.messageType),
  };
}

function parseRecentErrorQuery(query: Record<string, unknown>): ParsedRecentErrorQuery {
  const rangeKey = typeof query.range === "string" && query.range in RANGE_MS
    ? query.range as keyof typeof RANGE_MS
    : "1h";
  const parsed: ParsedRecentErrorQuery = {
    rangeMs: RANGE_MS[rangeKey],
    limit: parseLimit(query.limit, 50, 100),
  };

  if (typeof query.category === "string" && isMonitorCategory(query.category)) {
    parsed.category = query.category;
  } else if (query.category !== undefined) {
    throw new MonitoringQueryError("Invalid monitoring category");
  }

  if (typeof query.schoolId === "string" && SAFE_SCHOOL_ID_RE.test(query.schoolId)) {
    parsed.schoolId = query.schoolId;
  } else if (query.schoolId !== undefined) {
    throw new MonitoringQueryError("Invalid schoolId filter");
  }

  if (typeof query.q === "string" && query.q.trim()) {
    const q = query.q.trim();
    if (!SAFE_IDENTIFIER_RE.test(q)) throw new MonitoringQueryError("Search must be a safe identifier");
    parsed.q = q;
  }

  if (typeof query.cursor === "string" && query.cursor.trim()) {
    parsed.cursor = decodeCursor(query.cursor.trim());
  }

  return parsed;
}

function parseFingerprintQuery(query: Record<string, unknown>): ParsedFingerprintQuery {
  const parsed: ParsedFingerprintQuery = {
    limit: parseLimit(query.limit, 100, 250),
  };

  if (typeof query.category === "string" && isMonitorCategory(query.category)) {
    parsed.category = query.category;
  } else if (query.category !== undefined) {
    throw new MonitoringQueryError("Invalid monitoring category");
  }

  if (typeof query.priority === "string" && isMonitorPriority(query.priority)) {
    parsed.priority = query.priority;
  } else if (query.priority !== undefined) {
    throw new MonitoringQueryError("Invalid monitoring priority");
  }

  if (typeof query.q === "string" && query.q.trim()) {
    const q = query.q.trim();
    if (!SAFE_IDENTIFIER_RE.test(q)) throw new MonitoringQueryError("Search must be a safe identifier");
    parsed.q = q;
  }

  return parsed;
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new MonitoringQueryError(`limit must be between 1 and ${max}`);
  }
  return parsed;
}

function isMonitorCategory(value: string): value is ErrorCategory {
  return (MONITORING_CATEGORIES as readonly string[]).includes(value);
}

function isMonitorPriority(value: string): value is MonitorPriority {
  return (MONITORING_PRIORITIES as readonly string[]).includes(value);
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): ParsedRecentErrorQuery["cursor"] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      throw new Error("cursor shape");
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !SAFE_IDENTIFIER_RE.test(parsed.id)) {
      throw new Error("cursor values");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new MonitoringQueryError("Invalid cursor");
  }
}

function sanitizeContext(value: unknown, securityEvent: boolean): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const keys = securityEvent ? SECURITY_CONTEXT_KEYS : SAFE_CONTEXT_KEYS;
  const result: Record<string, string> = {};
  for (const key of keys) {
    const raw = source[key];
    const sanitized = sanitizeOptionalContextValue(typeof raw === "string" ? raw : raw == null ? undefined : String(raw));
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeOptionalContextValue(value?: string | null): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeUiString(value, 500);
  return sanitized || undefined;
}

function sanitizeOptionalIdentifier(value?: string | null): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeUiString(value, 128);
  return sanitized && SAFE_IDENTIFIER_RE.test(sanitized) ? sanitized : undefined;
}

function pathnameOnly(value?: string | null): string | undefined {
  if (!value) return undefined;
  const withoutQuery = value.split("?")[0]?.split("#")[0] ?? "";
  try {
    const parsed = new URL(withoutQuery, "https://school-pilot.local");
    return parsed.pathname || "/";
  } catch {
    const trimmed = withoutQuery.trim();
    if (!trimmed.startsWith("/")) return undefined;
    return sanitizeUiString(trimmed, 500);
  }
}

function stripUrlQueries(value: string): string {
  return value
    .replace(URL_RE, (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return raw.split("?")[0] ?? raw;
      }
    })
    .replace(PATH_QUERY_RE, (_match, prefix: string, path: string) => `${prefix}${path}`);
}

function sanitizeUiString(value: string, maxLength: number): string {
  const sanitized = stripUrlQueries(String(value))
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(JWT_RE, "[token]")
    .replace(API_KEY_RE, "[token]")
    .replace(SECRET_ASSIGNMENT_RE, "$1=[redacted]")
    .replace(EMAIL_RE, "[email]")
    .replace(IPV4_RE, "[ip]")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > maxLength ? `${sanitized.slice(0, Math.max(0, maxLength - 12))}[truncated]` : sanitized;
}
