import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  default as singletonErrorMonitor,
  ErrorMonitor,
  getAlertingStatus,
  normalizeMonitorEvent,
  sendTelegramAlert,
  type DeliveryResult,
  type ErrorCategory,
  type MonitorAggregationAdapter,
  type MonitorAggregationStatus,
  type NormalizedMonitorEvent,
} from "../dist/services/errorMonitor.js";
import {
  browserTelemetrySchema,
  extensionRuntimeTelemetrySchema,
  trackBrowserTelemetry,
  trackExtensionRuntimeTelemetry,
} from "../dist/services/runtimeTelemetry.js";
import {
  buildMonitoringStatusSummary,
  listMonitoringFingerprints,
  sanitizeRecentErrorLogForMonitoring,
  type MonitoringHealthSnapshot,
} from "../dist/services/monitoringDashboard.js";
import { RedisMonitorAggregationAdapter } from "../dist/services/monitorAggregation.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let originalRedisUrl: string | undefined;
let importedPool: { end: () => Promise<void> } | null = null;

function delivered(channel: "email" | "telegram" = "email"): DeliveryResult {
  return { channel, attempted: true, delivered: true };
}

function failed(channel: "email" | "telegram" = "email"): DeliveryResult {
  return { channel, attempted: true, delivered: false, error: "failed" };
}

function makeMonitor(options: {
  now?: () => number;
  dispatch?: (subject: string, text: string) => Promise<DeliveryResult[]>;
  persisted?: NormalizedMonitorEvent[];
  persistResult?: "persisted" | "dropped" | "failed";
  maxFingerprints?: number;
  metricsSink?: (line: string) => void;
  aggregation?: MonitorAggregationAdapter;
} = {}) {
  const persisted = options.persisted ?? [];
  return new ErrorMonitor({
    now: options.now ?? (() => 0),
    persist: async (event) => {
      persisted.push(event);
      return options.persistResult ?? "persisted";
    },
    capture: () => undefined,
    flushExternal: async () => undefined,
    dispatchAlert: options.dispatch ?? (async () => [delivered()]),
    startHousekeeping: false,
    startMetrics: false,
    maxFingerprints: options.maxFingerprints,
    metricsSink: options.metricsSink,
    aggregation: options.aggregation,
  });
}

class FakeAggregation implements MonitorAggregationAdapter {
  counts = new Map<string, number>();
  cooldowns = new Map<string, number>();
  checkCalls = 0;

  constructor(private readonly now: () => number) {}

  async recordEvent(event: NormalizedMonitorEvent): Promise<number> {
    const next = (this.counts.get(event.fingerprint) ?? 0) + 1;
    this.counts.set(event.fingerprint, next);
    return next;
  }

  async tryAcquireAlert(fingerprint: string, ttlMs: number): Promise<boolean> {
    const cooldownUntil = this.cooldowns.get(fingerprint) ?? 0;
    if (cooldownUntil > this.now()) return false;
    this.cooldowns.set(fingerprint, this.now() + ttlMs);
    return true;
  }

  async setCooldown(fingerprint: string, ttlMs: number): Promise<void> {
    this.cooldowns.set(fingerprint, this.now() + ttlMs);
  }

  getStatus(): MonitorAggregationStatus {
    return { mode: "redis" as const, ok: true };
  }

  async checkStatus(): Promise<MonitorAggregationStatus> {
    this.checkCalls++;
    return this.getStatus();
  }

  resetForTests(): void {
    this.counts.clear();
    this.cooldowns.clear();
    this.checkCalls = 0;
  }
}

class ProbeAggregation extends FakeAggregation {
  lastTimeoutMs: number | undefined;

  getStatus(): MonitorAggregationStatus {
    return { mode: "local" as const, ok: false, degradedReason: "Redis aggregation is not connected" };
  }

  async checkStatus(timeoutMs?: number): Promise<MonitorAggregationStatus> {
    this.checkCalls++;
    this.lastTimeoutMs = timeoutMs;
    return { mode: "redis" as const, ok: true };
  }
}

function baseMonitoringSnapshot(overrides: Partial<MonitoringHealthSnapshot> = {}): MonitoringHealthSnapshot {
  return {
    status: "healthy",
    generatedAt: "2026-06-25T12:00:00.000Z",
    coreOk: true,
    alerting: { ok: true, configuredChannels: ["email"] },
    aggregation: { ok: true, mode: "local" },
    runtime: {
      environment: "test",
      service: "api",
      instanceId: "instance-1",
      release: "test-release",
      startedAt: "2026-06-25T11:00:00.000Z",
    },
    stats: {
      generatedAt: "2026-06-25T12:00:00.000Z",
      windowMs: 300_000,
      activeFingerprints: 2,
      maxFingerprints: 250,
      totals: {
        captured: 5,
        persisted: 4,
        persistFailed: 0,
        dropped: 0,
        alertAttempted: 1,
        alertDelivered: 1,
        alertFailed: 0,
        cooldownSuppressed: 0,
      },
      byCategory: {},
      fingerprints: [],
    },
    checks: {
      recentErrors: {
        api_error: 2,
        browser_runtime_error: 3,
      },
    },
    ...overrides,
  };
}

before(() => {
  originalRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
});

after(async () => {
  if (originalRedisUrl) process.env.REDIS_URL = originalRedisUrl;
  if (importedPool) await importedPool.end();
});

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.REDIS_URL;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  singletonErrorMonitor.resetStatsForTests();
});

describe("error monitor redaction", () => {
  it("normalizes messages, stacks, paths, and safe context before any sink", () => {
    const err = new Error(
      "student@example.org from 192.168.1.20 hit https://school-pilot.net/api/mailpilot/pubsub/push?token=secret-token&x=1 with Bearer abc.def.ghi and sk-1234567890123456"
    );
    err.stack =
      "Error: teacher@example.org token=secret-token\n    at handler (/api/foo?access_token=abc123)";

    const event = normalizeMonitorEvent("api_error", err, {
      path: "/api/mailpilot/pubsub/push?token=secret-token",
      status: "500",
      requestId: "req-123",
      job: "mailpilot_pubsub",
      emailAddress: "student@example.org",
      eventId: "evt-123",
    });

    assert.equal(event.correlation.path, "/api/mailpilot/pubsub/push");
    assert.equal(event.correlation.statusCode, 500);
    assert.equal(event.context?.job, "mailpilot_pubsub");
    assert.equal(event.context?.eventId, "evt-123");
    assert.equal((event.context as any).emailAddress, undefined);

    const combined = `${event.message}\n${event.stack ?? ""}`;
    assert.doesNotMatch(combined, /student@example\.org|teacher@example\.org/);
    assert.doesNotMatch(combined, /192\.168\.1\.20/);
    assert.doesNotMatch(combined, /secret-token|access_token=abc123|sk-1234567890123456|Bearer abc/);
    assert.doesNotMatch(event.correlation.path ?? "", /\?/);
  });
});

describe("error monitor fingerprints and stats", () => {
  it("groups equivalent fingerprints and separates path, job, message type, and error code", () => {
    const monitor = makeMonitor();
    const base = { path: "/api/same", job: "job-a", messageType: "type-a", errorCode: "E_A" };

    monitor.trackError("api_error", "boom", base, { persist: false, alert: false });
    monitor.trackError("api_error", "boom again", base, { persist: false, alert: false });
    monitor.trackError("api_error", "boom", { ...base, path: "/api/other" }, { persist: false, alert: false });
    monitor.trackError("api_error", "boom", { ...base, job: "job-b" }, { persist: false, alert: false });
    monitor.trackError("api_error", "boom", { ...base, messageType: "type-b" }, { persist: false, alert: false });
    monitor.trackError("api_error", "boom", { ...base, errorCode: "E_B" }, { persist: false, alert: false });

    const stats = monitor.getStats();
    assert.equal(stats.activeFingerprints, 5);
    assert.ok(stats.fingerprints.some((fp) => fp.recentCount === 2 && fp.count === 2));
    assert.equal(stats.totals.captured, 6);
    monitor.dispose();
  });

  it("evicts quiet low-priority fingerprints and increments dropped", () => {
    const monitor = makeMonitor({ maxFingerprints: 2 });

    monitor.trackError("client_error", "low a", { path: "/a" }, { persist: false, alert: false, priority: "low" });
    monitor.trackError("client_error", "low b", { path: "/b" }, { persist: false, alert: false, priority: "low" });
    monitor.trackError("fatal_process_error", "critical", { path: "/c" }, { persist: false, alert: false, priority: "critical" });
    monitor.trackError("client_error", "low c", { path: "/d" }, { persist: false, alert: false, priority: "low" });

    const stats = monitor.getStats();
    assert.equal(stats.activeFingerprints, 2);
    assert.equal(stats.totals.dropped, 2);
    assert.ok(stats.fingerprints.some((fp) => fp.category === "fatal_process_error"));
    monitor.dispose();
  });

  it("records persistence dropped and failed outcomes", async () => {
    const droppedMonitor = makeMonitor({ persistResult: "dropped" });
    droppedMonitor.trackError("api_error", "drop me", { path: "/drop" }, { alert: false });
    await droppedMonitor.flush();
    assert.equal(droppedMonitor.getStats().totals.dropped, 1);
    droppedMonitor.dispose();

    const failedMonitor = makeMonitor({ persistResult: "failed" });
    failedMonitor.trackError("api_error", "fail me", { path: "/fail" }, { alert: false });
    await failedMonitor.flush();
    assert.equal(failedMonitor.getStats().totals.persistFailed, 1);
    failedMonitor.dispose();
  });

  it("emits EMF metrics without PII-bearing event fields", () => {
    const emitted: string[] = [];
    const monitor = makeMonitor({
      now: () => 123456,
      metricsSink: (line) => emitted.push(line),
    });

    monitor.trackError(
      "api_error",
      "student@example.org hit /api/foo?token=secret-token from 10.0.0.1",
      { path: "/api/foo?token=secret-token", userId: "user-1", schoolId: "school-1" },
      { persist: false, alert: false }
    );
    monitor.emitMetrics();

    assert.equal(emitted.length, 1);
    assert.doesNotMatch(emitted[0] ?? "", /student@example\.org|secret-token|10\.0\.0\.1|\/api\/foo|user-1|school-1/);
    const parsed = JSON.parse(emitted[0] ?? "{}");
    assert.equal(parsed._aws.CloudWatchMetrics[0].Namespace, "SchoolPilot/Monitoring");
    assert.equal(typeof parsed.MonitorCaptured, "number");
    assert.equal(parsed.Environment, process.env.NODE_ENV || "development");
    monitor.dispose();
  });
});

describe("error monitor cooldowns and flush", () => {
  it("waits for persistence during trackErrorAndFlush", async () => {
    const persisted: NormalizedMonitorEvent[] = [];
    const monitor = makeMonitor({ persisted });

    await monitor.trackErrorAndFlush("fatal_process_error", new Error("fatal"), { eventType: "test" });

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.category, "fatal_process_error");
    monitor.dispose();
  });

  it("uses normal cooldown only after confirmed delivery", async () => {
    let now = 0;
    const dispatches: string[] = [];
    const monitor = makeMonitor({
      now: () => now,
      dispatch: async (subject) => {
        dispatches.push(subject);
        return [delivered()];
      },
    });

    monitor.trackError("security_event", new Error("security one"));
    await monitor.flush();
    now += 60_000;
    monitor.trackError("security_event", new Error("security two"));
    await monitor.flush();
    now += 31 * 60_000;
    monitor.trackError("security_event", new Error("security three"));
    await monitor.flush();

    assert.equal(dispatches.length, 2);
    const stats = monitor.getStats();
    assert.equal(stats.byCategory.security_event?.alertDelivered, 2);
    assert.equal(stats.byCategory.security_event?.cooldownSuppressed, 1);
    monitor.dispose();
  });

  it("retries on the short cooldown when delivery fails", async () => {
    let now = 0;
    let attempts = 0;
    const monitor = makeMonitor({
      now: () => now,
      dispatch: async () => {
        attempts++;
        return [failed()];
      },
    });

    monitor.trackError("security_event", new Error("security one"));
    await monitor.flush();
    now += 60_000;
    monitor.trackError("security_event", new Error("security two"));
    await monitor.flush();
    now += 61_000;
    monitor.trackError("security_event", new Error("security three"));
    await monitor.flush();

    assert.equal(attempts, 2);
    assert.equal(monitor.getStats().byCategory.security_event?.alertFailed, 2);
    monitor.dispose();
  });

  it("keeps security events separate from fatal crash alerting", async () => {
    const categories: ErrorCategory[] = [];
    const monitor = makeMonitor({
      dispatch: async (subject) => {
        categories.push(subject.includes("fatal_process_error") ? "fatal_process_error" : "security_event");
        return [delivered()];
      },
    });

    monitor.trackError("security_event", new Error("security"));
    await monitor.flush();
    monitor.trackError("fatal_process_error", new Error("fatal"));
    await monitor.flush();

    assert.deepEqual(categories, ["security_event", "fatal_process_error"]);
    monitor.dispose();
  });
});

describe("error monitor global aggregation", () => {
  it("keeps cached aggregation status synchronous and probes Redis only when requested", async () => {
    const aggregation = new ProbeAggregation(() => 0);
    const monitor = makeMonitor({ aggregation });

    const cached = monitor.getAggregationStatus();
    assert.equal(cached.mode, "local");
    assert.equal(cached.ok, false);
    assert.equal(aggregation.checkCalls, 0);

    const probed = await monitor.checkAggregationStatus(1234);
    assert.equal(probed.mode, "redis");
    assert.equal(probed.ok, true);
    assert.equal(aggregation.checkCalls, 1);
    assert.equal(aggregation.lastTimeoutMs, 1234);
    monitor.dispose();
  });

  it("treats missing Redis as local fallback outside production and degraded in production", () => {
    delete process.env.REDIS_URL;

    process.env.NODE_ENV = "test";
    const testMonitor = makeMonitor();
    assert.deepEqual(testMonitor.getAggregationStatus(), { mode: "local", ok: true });
    testMonitor.dispose();

    process.env.NODE_ENV = "production";
    const prodMonitor = makeMonitor();
    const status = prodMonitor.getAggregationStatus();
    assert.equal(status.mode, "local");
    assert.equal(status.ok, false);
    assert.equal(status.degradedReason, "REDIS_URL is not configured");
    prodMonitor.dispose();
  });

  it("sanitizes Redis aggregation connection failures", async () => {
    const adapter = new RedisMonitorAggregationAdapter("redis://:super-secret@127.0.0.1:1/0");
    const status = await adapter.checkStatus(100);

    assert.equal(status.mode, "local");
    assert.equal(status.ok, false);
    assert.ok((status.degradedReason ?? "").length <= 180);
    assert.doesNotMatch(status.degradedReason ?? "", /super-secret|redis:\/\//);
    await adapter.dispose();
  });

  it("uses shared aggregation counts and elects one alert sender", async () => {
    let now = 0;
    const aggregation = new FakeAggregation(() => now);
    let attempts = 0;
    const dispatch = async () => {
      attempts++;
      return [delivered()];
    };
    const monitorA = makeMonitor({ now: () => now, dispatch, aggregation });
    const monitorB = makeMonitor({ now: () => now, dispatch, aggregation });
    const context = { path: "/classpilot/dashboard", messageType: "window-error", errorCode: "TypeError" };

    for (let i = 0; i < 5; i++) {
      monitorA.trackError("browser_runtime_error", "render boom", context, { persist: false });
      monitorB.trackError("browser_runtime_error", "render boom", context, { persist: false });
    }
    await monitorA.flush();
    await monitorB.flush();

    monitorA.trackError("browser_runtime_error", "render boom", context, { persist: false });
    await monitorA.flush();

    assert.equal(attempts, 1);
    assert.equal(monitorA.getAggregationStatus().mode, "redis");
    assert.equal(monitorA.getStats().byCategory.browser_runtime_error?.cooldownSuppressed, 1);
    monitorA.dispose();
    monitorB.dispose();
  });
});

describe("runtime telemetry payloads", () => {
  it("maps browser telemetry to sanitized browser_runtime_error events", async () => {
    const persisted: NormalizedMonitorEvent[] = [];
    const monitor = makeMonitor({ persisted });
    const payload = browserTelemetrySchema.parse({
      source: "schoolpilot-web",
      eventType: "unhandledrejection",
      message: "student@example.org failed with token=secret-token",
      stack: "Error: token=secret-token\n    at route (/src/App.jsx:10:20)",
      path: "/classpilot/dashboard?token=secret-token",
      surface: "react",
      component: "Dashboard",
      errorCode: "TypeError",
      release: "1.2.3",
      browserName: "Chrome",
      browserVersion: "145.0.0.0",
    });

    trackBrowserTelemetry(payload, { requestId: "req-browser", userId: "user-1", schoolId: "school-1" }, monitor);
    await monitor.flush();

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.category, "browser_runtime_error");
    assert.equal(persisted[0]?.correlation.path, "/classpilot/dashboard");
    assert.equal(persisted[0]?.context?.source, "schoolpilot-web");
    assert.equal(persisted[0]?.context?.component, "Dashboard");
    assert.equal(persisted[0]?.context?.clientVersion, "Chrome/v145.0.0.0");
    assert.doesNotMatch(`${persisted[0]?.message}\n${persisted[0]?.stack}`, /student@example\.org|secret-token/);
    monitor.dispose();
  });

  it("rejects unknown telemetry fields and keeps extension identifiers out of monitor context", async () => {
    assert.equal(
      extensionRuntimeTelemetrySchema.safeParse({
        source: "classpilot-extension",
        eventType: "service_worker_error",
        message: "boom",
        deviceId: "device-123",
      }).success,
      false
    );

    const persisted: NormalizedMonitorEvent[] = [];
    const monitor = makeMonitor({ persisted });
    const payload = extensionRuntimeTelemetrySchema.parse({
      source: "classpilot-extension",
      eventType: "service_worker_error",
      message: "student@example.org failed with Bearer abc.def.ghi",
      stack: "Error: student@example.org\n    at service-worker.js:10:20",
      surface: "service-worker",
      component: "global.error",
      extensionVersion: "2.5.5",
      chromeVersion: "145.0.0.0",
    });

    trackExtensionRuntimeTelemetry(payload, { requestId: "req-extension", schoolId: "school-1" }, monitor);
    await monitor.flush();

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.category, "extension_runtime_error");
    assert.equal(persisted[0]?.correlation.schoolId, "school-1");
    assert.equal((persisted[0]?.context as any)?.deviceId, undefined);
    assert.equal(persisted[0]?.context?.extensionVersion, "2.5.5");
    assert.equal(persisted[0]?.context?.chromeVersion, "v145.0.0.0");
    assert.doesNotMatch(`${persisted[0]?.message}\n${persisted[0]?.stack}`, /student@example\.org|Bearer abc/);
    monitor.dispose();
  });
});

describe("monitor integrations", () => {
  it("tracks main DB pool idle errors as non-persisted database connectivity events", async () => {
    const db = await import("../dist/db.js");
    importedPool = db.pool;
    singletonErrorMonitor.resetStatsForTests();
    const err = Object.assign(new Error("main pool idle failure"), {
      code: "ECONNRESET",
    });

    (db.pool as any).emit("error", err);
    await singletonErrorMonitor.flush();

    const stats = singletonErrorMonitor.getStats();
    assert.equal(stats.byCategory.database_connectivity?.captured, 1);
    assert.equal(stats.byCategory.database_connectivity?.persisted ?? 0, 0);
  });

  it("provides monitor stats/runtime for detailed health and preserves alerting degraded status", () => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    singletonErrorMonitor.resetStatsForTests();
    singletonErrorMonitor.trackError(
      "health_failure",
      "websocket health check failed",
      { job: "healthMonitor", messageType: "websocket", errorCode: "health_check_failed" },
      { persist: false, alert: false }
    );

    const alerting = getAlertingStatus();
    const monitoring = {
      ok: true,
      runtime: singletonErrorMonitor.getRuntimeMetadata(),
      stats: singletonErrorMonitor.getStats(),
      aggregation: singletonErrorMonitor.getAggregationStatus(),
    };

    assert.equal(alerting.ok, false);
    assert.equal(monitoring.ok, true);
    assert.equal(typeof monitoring.runtime.instanceId, "string");
    assert.equal(monitoring.stats.byCategory.health_failure?.captured, 1);
    assert.equal(monitoring.aggregation.mode, "local");
  });
});

describe("super-admin monitoring dashboard helpers", () => {
  it("searches active fingerprints by safe operational fields", () => {
    singletonErrorMonitor.resetStatsForTests();
    singletonErrorMonitor.trackError(
      "api_error",
      "browser telemetry failed",
      { path: "/api/monitoring/browser-error", job: "telemetry_ingest", messageType: "browser-error" },
      { persist: false, alert: false }
    );

    assert.equal(listMonitoringFingerprints({ q: "/api/monitoring" }).length, 1);
    assert.equal(listMonitoringFingerprints({ q: "telemetry_ingest" }).length, 1);
    assert.equal(listMonitoringFingerprints({ q: "browser-error" }).length, 1);
    assert.equal(listMonitoringFingerprints({ q: "not-present" }).length, 0);
  });

  it("summarizes monitor health for the compact dashboard chip", () => {
    const summary = buildMonitoringStatusSummary(baseMonitoringSnapshot({
      status: "degraded",
      alerting: { ok: false, configuredChannels: [], degradedReason: "no approved alert channel configured" },
    }));

    assert.equal(summary.status, "degraded");
    assert.equal(summary.activeFingerprints, 2);
    assert.equal(summary.recentErrors, 5);
    assert.equal(summary.alertingOk, false);
    assert.match(summary.degradedReasons.join(" "), /no approved alert channel/);
  });

  it("sanitizes recent error rows before the monitoring UI displays them", () => {
    const row = sanitizeRecentErrorLogForMonitoring({
      id: "err_123",
      category: "browser_runtime_error",
      message: "Failed https://school-pilot.net/classpilot?token=abc123 for jane.student@example.edu Bearer secret-token 203.0.113.10",
      stack: "Error: sk-test_12345678901234567890 at https://school-pilot.net/app.js?api_key=secret",
      requestId: "req_123",
      method: "GET",
      path: "/api/monitoring/browser-error?token=abc123",
      statusCode: 500,
      schoolId: "school_123",
      userId: "user_123",
      context: {
        eventId: "event_123",
        component: "Roster?token=abc123",
        requestBody: "student=jane.student@example.edu",
        token: "abc123",
      },
      createdAt: new Date("2026-06-25T12:00:00.000Z"),
    } as any);

    const serialized = JSON.stringify(row);
    assert.equal(row.path, "/api/monitoring/browser-error");
    assert.equal(row.context?.eventId, "event_123");
    assert.equal(row.context?.requestBody, undefined);
    assert.equal(row.context?.token, undefined);
    assert.doesNotMatch(serialized, /jane\.student@example\.edu/);
    assert.doesNotMatch(serialized, /abc123/);
    assert.doesNotMatch(serialized, /203\.0\.113\.10/);
    assert.doesNotMatch(serialized, /api_key=secret/);
  });

  it("keeps security event display rows minimal", () => {
    const row = sanitizeRecentErrorLogForMonitoring({
      id: "err_sec",
      category: "security_event",
      message: "Security event critical: bulk_student_write (sec_123) jane.student@example.edu",
      stack: "sensitive stack",
      requestId: null,
      method: null,
      path: null,
      statusCode: null,
      schoolId: null,
      userId: null,
      context: {
        eventId: "sec_123",
        eventType: "bulk_student_write",
        errorCode: "critical",
        component: "should_not_display",
      },
      createdAt: new Date("2026-06-25T12:00:00.000Z"),
    } as any);

    assert.equal(row.message, "Security event recorded (sec_123)");
    assert.equal(row.stack, undefined);
    assert.deepEqual(row.context, {
      eventId: "sec_123",
      eventType: "bulk_student_write",
      errorCode: "critical",
    });
  });
});

describe("telegram delivery", () => {
  it("reports skipped delivery when Telegram is not configured", async () => {
    const result = await sendTelegramAlert("subject", "body", 5);

    assert.equal(result.delivered, false);
    assert.equal(result.attempted, false);
    assert.match(result.skippedReason ?? "", /TELEGRAM_BOT_TOKEN/);
  });

  it("requires both HTTP success and Telegram ok=true", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_CHAT_ID = "chat-id";
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false }),
    })) as any;

    const result = await sendTelegramAlert("subject", "body", 5);

    assert.equal(result.attempted, true);
    assert.equal(result.delivered, false);
  });

  it("truncates and sanitizes Telegram payloads", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_CHAT_ID = "chat-id";
    let sentText = "";
    globalThis.fetch = (async (_url: string, init: any) => {
      sentText = JSON.parse(init.body).text;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    }) as any;

    const result = await sendTelegramAlert(
      "student@example.org token=secret-token",
      `x`.repeat(5000),
      5
    );

    assert.equal(result.delivered, true);
    assert.ok(sentText.length <= 4096);
    assert.doesNotMatch(sentText, /student@example\.org|secret-token/);
  });

  it("returns a failed result on timeout", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_CHAT_ID = "chat-id";
    globalThis.fetch = ((_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as any;

    const result = await sendTelegramAlert("subject", "body", 5);

    assert.equal(result.attempted, true);
    assert.equal(result.delivered, false);
    assert.match(result.error ?? "", /aborted/);
  });
});
