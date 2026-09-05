import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ErrorMonitor } from "../src/services/errorMonitor.js";
import { getRuntimeMetadata } from "../src/services/runtimeMetadata.js";
import { RuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";
import { reportStudentWebSocketAuthenticationFailure } from "../src/services/classpilotWebSocketAuthDiagnostics.js";
import {
  markTenantPoolAcquisitionFailureReported,
  operationalErrorCauses,
  safeOperationalErrorCode,
  studentAuthenticationFailureCause,
  wasTenantPoolAcquisitionFailureReported,
} from "../src/util/operationalErrors.js";
import { WebSocketWorkTracker } from "../src/realtime/websocketWork.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("production diagnostic identities and safe causes", () => {
  it("prefers a verified release SHA and identifies the scheduler independently", () => {
    assert.equal(getRuntimeMetadata({ SCHEDULER_ENABLED: "true" }).service, "scheduler-worker");
    assert.equal(getRuntimeMetadata({ SERVICE_NAME: "schoolpilot-api", SCHEDULER_ENABLED: "true" }).service, "scheduler-worker");
    assert.equal(getRuntimeMetadata({ SERVICE_NAME: "api" }).service, "api");
    assert.equal(getRuntimeMetadata({ GIT_SHA: "a".repeat(40), APP_VERSION: "1.0.0" }).release, "a".repeat(40));
    assert.equal(getRuntimeMetadata({ GIT_SHA: "not-a-release", APP_VERSION: "test" }).release, "test");
    assert.equal(getRuntimeMetadata({ APP_ENV: "production", NODE_ENV: "test" }).environment, "production");
  });

  it("reads at most four error objects and handles cycles and throwing accessors", () => {
    const leaf = Object.assign(new Error("private SQL and student@example.edu"), { code: "57014" });
    const fourth = new Error("wrapper", { cause: new Error("wrapper", { cause: new Error("wrapper", { cause: leaf }) }) });
    assert.equal(safeOperationalErrorCode(fourth), "57014");
    assert.equal(studentAuthenticationFailureCause(fourth), "query_cancelled");
    assert.equal(safeOperationalErrorCode(new Error("fifth", { cause: fourth })), undefined);
    const cycle: { cause?: unknown; code: string } = { code: "ECONNRESET" };
    cycle.cause = cycle;
    assert.equal(operationalErrorCauses(cycle).length, 1);
    assert.equal(studentAuthenticationFailureCause(cycle), "connection_reset");
    const hostile = Object.defineProperties({}, {
      cause: { get() { throw new Error("private cause"); } },
      code: { get() { throw new Error("private code"); } },
    });
    assert.equal(safeOperationalErrorCode(hostile), undefined);
    assert.equal(studentAuthenticationFailureCause({ code: "school-secret", message: "secret" }), "unknown");
    assert.equal(studentAuthenticationFailureCause({ code: "ABCDE" }), "unknown");
  });

  it("reports a failed bootstrap once with stage/cause and never persists during an outage", () => {
    const alerts: Array<Parameters<ErrorMonitor["trackError"]>> = [];
    const lines: string[] = [];
    const options = {
      monitor: { trackError: (...args: Parameters<ErrorMonitor["trackError"]>) => { alerts.push(args); } },
      sink: (line: string) => { lines.push(line); },
    };
    const error = Object.assign(new Error("select * params school-secret device-secret student@example.edu token=secret"), {
      cause: Object.assign(new Error("private driver detail"), { code: "ECONNREFUSED" }),
    });
    reportStudentWebSocketAuthenticationFailure(error, "authority_lock", "studentWebSocketAuth", options);
    assert.equal(alerts[0]?.[0], "database_connectivity");
    assert.equal(alerts[0]?.[2]?.surface, "authority_lock");
    assert.deepEqual(alerts[0]?.[3], { persist: false, priority: "high" });
    assert.equal(JSON.parse(lines[0]!).cause, "connection_refused");
    assert.doesNotMatch(JSON.stringify({ alerts, lines }), /school-secret|device-secret|student@example|select \*|params|private driver|token=secret/);

    const poolError = new Error("checkout rejected with private details");
    markTenantPoolAcquisitionFailureReported(poolError);
    const wrapped = new Error("wrapper", { cause: poolError });
    assert.equal(wasTenantPoolAcquisitionFailureReported(wrapped), true);
    reportStudentWebSocketAuthenticationFailure(wrapped, "tenant_checkout", "studentWebSocketAuth", options);
    assert.equal(alerts.length, 1, "the caller must not alert again after the pool boundary reported");
    assert.equal(JSON.parse(lines[1]!).cause, "pool_acquisition_failed");

    reportStudentWebSocketAuthenticationFailure({ code: "WS_AUTH_SOCKET_CLOSED" }, "socket_delivery", "studentWebSocketAuth", options);
    assert.equal(alerts.length, 1, "peer closure is not a database outage");
    reportStudentWebSocketAuthenticationFailure({ code: "WS_AUTH_REGISTRATION_UNAVAILABLE" }, "socket_delivery", "studentWebSocketAuth", options);
    assert.equal(alerts[1]?.[0], "health_failure");
    reportStudentWebSocketAuthenticationFailure(new Error("private unknown cause"), "bootstrap_projection", "studentWebSocketAuth", options);
    assert.equal(alerts[2]?.[0], "health_failure");
    assert.equal(alerts[2]?.[2]?.errorCode, "WS_AUTH_UNKNOWN");
  });
});

describe("interval metrics and transport drain", () => {
  it("emits real interval counts including healthy zeros and one final partial interval", () => {
    let now = 0;
    const lines: string[] = [];
    const metrics = new RuntimePerformanceMetrics(() => now, (line) => { lines.push(line); });
    metrics.recordCounter("poolAcquisitionFailure", 3);
    now = 60_000;
    metrics.flush();
    now = 120_000;
    metrics.flush();
    metrics.recordCounter("poolAcquisitionFailure", 2);
    now = 121_000;
    metrics.flush({ final: true });
    metrics.flush({ final: true });
    const emitted = lines.map((line) => JSON.parse(line));
    assert.deepEqual(emitted.map((entry) => entry.counters.poolAcquisitionFailure), [3, 0, 2]);
    assert.deepEqual(emitted.map((entry) => entry.RuntimePoolAcquisitionFailure), [3, 0, 2]);
    assert.deepEqual(emitted.map((entry) => entry.intervalSeconds), [60, 60, 1]);
    assert.deepEqual(emitted[0]._aws.CloudWatchMetrics[0].Dimensions, [["Environment", "Service"]]);
    assert.equal(emitted[0].counters.auditWriteFailure, 0);
    assert.equal(typeof emitted[0].Release, "string");
  });

  it("keeps lifetime monitor counters while adding sum-safe deltas and final flush", async () => {
    const lines: string[] = [];
    const monitor = new ErrorMonitor({
      startMetrics: false,
      startHousekeeping: false,
      capture: () => {},
      metricsSink: (line) => { lines.push(line); },
      persist: async () => "persisted",
      dispatchAlert: async () => [],
    });
    const capture = () => monitor.trackError("database_connectivity", new Error("safe"), {}, { persist: false, alert: false });
    capture(); capture(); capture();
    monitor.emitMetrics();
    monitor.emitMetrics();
    capture(); capture();
    await monitor.disposeAndWait();
    await monitor.disposeAndWait();
    const emitted = lines.map((line) => JSON.parse(line));
    assert.deepEqual(emitted.map((entry) => entry.MonitorCaptured), [3, 3, 5]);
    assert.deepEqual(emitted.map((entry) => entry.MonitorCapturedInterval), [3, 0, 2]);
    assert.equal(monitor.getStats().totals.captured, 5);
    assert.equal(monitor.getDisposalSnapshot().complete, true);
    const intervalRule = emitted[0]._aws.CloudWatchMetrics.find((rule: { Dimensions: string[][] }) => rule.Dimensions[0]?.length === 2);
    assert.deepEqual(intervalRule.Dimensions, [["Environment", "Service"]]);
    assert.equal(emitted[1].MonitorAlertFailedInterval, 0);
    assert.ok(emitted.every((entry) => entry._aws.CloudWatchMetrics.every((rule: { Metrics: unknown[] }) => rule.Metrics.length <= 100)));
  });

  it("exposes monitor persistence and aggregation cleanup timeouts to the shutdown owner", async () => {
    const persist = deferred();
    const monitor = new ErrorMonitor({
      startMetrics: false,
      startHousekeeping: false,
      capture: () => {},
      metricsSink: () => {},
      persist: async () => { await persist.promise; return "persisted"; },
      dispatchAlert: async () => [],
    });
    monitor.trackError("health_failure", new Error("safe"), {}, { alert: false });
    await monitor.disposeAndWait(5);
    assert.equal(monitor.getDisposalSnapshot().complete, false);
    assert.equal(monitor.getDisposalSnapshot().timedOut, true);
    assert.equal(monitor.getDisposalSnapshot().pending, 1);
    persist.resolve();
    await monitor.flush();

    const dispose = deferred();
    const second = new ErrorMonitor({
      startMetrics: false,
      startHousekeeping: false,
      metricsSink: () => {},
      aggregation: {
        recordEvent: async () => null,
        tryAcquireAlert: async () => null,
        setCooldown: async () => {},
        getStatus: () => ({ mode: "local", ok: true }),
        checkStatus: async () => ({ mode: "local", ok: true }),
        dispose: () => dispose.promise,
      },
    });
    await second.disposeAndWait(5);
    assert.equal(second.getDisposalSnapshot().aggregationComplete, false);
    assert.equal(second.getDisposalSnapshot().timedOut, true);
    assert.equal(second.getDisposalSnapshot().complete, false);
    dispose.resolve();
    await Promise.resolve();
  });

  it("fences new frames while waiting for admitted work and its cleanup", async () => {
    const tracker = new WebSocketWorkTracker();
    const handler = deferred();
    const cleanup = deferred();
    tracker.track(handler.promise.then(() => { tracker.track(cleanup.promise); }));
    tracker.stop();
    assert.equal(tracker.canStart(), false);
    let drained = false;
    const drain = tracker.drain().then(() => { drained = true; });
    handler.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(drained, false);
    cleanup.resolve();
    await drain;
    assert.equal(drained, true);
  });
});
