import crypto from "node:crypto";
import { z } from "zod";
import { redisCommand } from "../middleware/rateLimiter.js";

export const CLASSPILOT_TURN_TELEMETRY_TTL_MS = 15 * 60_000;
export const CLASSPILOT_TURN_TELEMETRY_MAX_LOCAL_KEYS = 8_192;
export const CLASSPILOT_TURN_MAX_CONNECTION_TIME_MS = 90_000;

export const classpilotTurnTelemetrySchema = z
  .object({
    negotiationId: z.string().min(32).max(2_048),
    attempt: z.number().int().min(0).max(2),
    outcome: z.enum(["connected", "failed"]),
    connectionTimeMs: z
      .number()
      .int()
      .min(0)
      .max(CLASSPILOT_TURN_MAX_CONNECTION_TIME_MS),
    selectedCandidateType: z.enum(["host", "server_reflexive", "relay", "unknown"]),
    relayTransport: z.enum(["udp", "tcp", "tls", "unknown"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "failed") {
      if (value.selectedCandidateType !== "unknown") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selectedCandidateType"],
          message: "failed attempts cannot assert a selected candidate",
        });
      }
      if (value.relayTransport !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["relayTransport"],
          message: "failed attempts cannot assert a relay transport",
        });
      }
      return;
    }

    if (value.selectedCandidateType === "relay" && value.relayTransport === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relayTransport"],
        message: "relay connections require a bounded transport",
      });
    }
    if (value.selectedCandidateType !== "relay" && value.relayTransport !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relayTransport"],
        message: "non-relay connections cannot assert a relay transport",
      });
    }
  });

export type ClasspilotTurnTelemetry = z.infer<typeof classpilotTurnTelemetrySchema>;

type ExactTelemetryAuthority = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};

const configuredSecret = process.env.JWT_SECRET;
const telemetryHmacKey = crypto
  .createHash("sha256")
  .update(`classpilot-turn-telemetry:${configuredSecret || "schoolpilot-development-turn-telemetry"}`)
  .digest();

export class BoundedClasspilotTurnTelemetryLimiter {
  private readonly entries = new Map<string, number>();

  constructor(
    readonly maxEntries = CLASSPILOT_TURN_TELEMETRY_MAX_LOCAL_KEYS,
    readonly ttlMs = CLASSPILOT_TURN_TELEMETRY_TTL_MS
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("turn telemetry maxEntries must be a positive safe integer");
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError("turn telemetry ttlMs must be a positive safe integer");
    }
  }

  accept(digest: string, nowMs = Date.now()): boolean {
    this.prune(nowMs);
    const expiresAt = this.entries.get(digest);
    if (expiresAt !== undefined && expiresAt > nowMs) return false;
    if (this.entries.has(digest)) this.entries.delete(digest);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.entries.set(digest, nowMs + this.ttlMs);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(nowMs: number): void {
    for (const [digest, expiresAt] of this.entries) {
      if (expiresAt <= nowMs) this.entries.delete(digest);
    }
  }
}

const localLimiter = new BoundedClasspilotTurnTelemetryLimiter();

export function classpilotTurnTelemetryDigest(options: {
  binding: ExactTelemetryAuthority;
  negotiationId: string;
  attempt: number;
}): string {
  return crypto
    .createHmac("sha256", telemetryHmacKey)
    .update(JSON.stringify([
      "classpilot-turn-telemetry-v1",
      options.binding.schoolId,
      options.binding.studentId,
      options.binding.studentSessionId,
      options.binding.deviceId,
      options.negotiationId,
      options.attempt,
    ]))
    .digest("base64url");
}

type MetricDefinition = {
  Name: string;
  Unit: "Count" | "Milliseconds";
};

export function classpilotTurnTelemetryMetricPayload(
  telemetry: Omit<ClasspilotTurnTelemetry, "negotiationId">,
  options: { nowMs?: number; environment?: string } = {}
): Record<string, unknown> {
  const metrics: MetricDefinition[] = [
    { Name: "TelemetryAcceptedCount", Unit: "Count" },
    {
      Name: telemetry.outcome === "connected" ? "IceSuccessCount" : "IceFailureCount",
      Unit: "Count",
    },
  ];
  const values: Record<string, number> = {
    TelemetryAcceptedCount: 1,
    [telemetry.outcome === "connected" ? "IceSuccessCount" : "IceFailureCount"]: 1,
  };

  if (telemetry.outcome === "connected") {
    metrics.push({ Name: "IceConnectionTimeMs", Unit: "Milliseconds" });
    values.IceConnectionTimeMs = telemetry.connectionTimeMs;
    if (telemetry.selectedCandidateType === "relay") {
      metrics.push({ Name: "RelayFallbackCount", Unit: "Count" });
      values.RelayFallbackCount = 1;
      const transportMetric = telemetry.relayTransport === "udp"
        ? "RelayUdpCount"
        : telemetry.relayTransport === "tcp"
          ? "RelayTcpCount"
          : telemetry.relayTransport === "tls"
            ? "RelayTlsCount"
            : "RelayUnknownTransportCount";
      metrics.push({ Name: transportMetric, Unit: "Count" });
      values[transportMetric] = 1;
    }
  }
  if (telemetry.attempt > 0) {
    metrics.push({ Name: "IceRestartAttemptCount", Unit: "Count" });
    values.IceRestartAttemptCount = 1;
  }

  return {
    _aws: {
      Timestamp: options.nowMs ?? Date.now(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/ClassPilotTURN",
        Dimensions: [["Environment"]],
        Metrics: metrics,
      }],
    },
    Environment: options.environment
      || process.env.APP_ENV
      || process.env.NODE_ENV
      || "development",
    event: "classpilot_turn_client_telemetry",
    ...values,
  };
}

export async function recordClasspilotTurnTelemetry(options: {
  binding: ExactTelemetryAuthority;
  telemetry: ClasspilotTurnTelemetry;
  nowMs?: number;
  metricsSink?: (line: string) => void;
}): Promise<{ accepted: boolean }> {
  const nowMs = options.nowMs ?? Date.now();
  const digest = classpilotTurnTelemetryDigest({
    binding: options.binding,
    negotiationId: options.telemetry.negotiationId,
    attempt: options.telemetry.attempt,
  });
  let accepted: boolean | undefined;

  if (process.env.REDIS_URL) {
    const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
    try {
      const result = await redisCommand(
        [
          "SET",
          `${prefix}:classpilot:turn-telemetry:${digest}`,
          "1",
          "NX",
          "PX",
          String(CLASSPILOT_TURN_TELEMETRY_TTL_MS),
        ],
        { readyTimeoutMs: 200 }
      );
      if (result === "OK") accepted = true;
      else if (result === null) accepted = false;
    } catch {
      // Advisory metrics never block a Live View. Fall back to a bounded,
      // opaque process-local limiter during a telemetry-only Redis failure.
    }
  }

  if (accepted === true) {
    // Seed the fallback limiter so a Redis outage immediately after this write
    // does not amplify the same report on this task.
    localLimiter.accept(digest, nowMs);
  } else if (accepted === undefined) {
    accepted = localLimiter.accept(digest, nowMs);
  }

  if (accepted) {
    const { negotiationId: _negotiationId, ...metricTelemetry } = options.telemetry;
    const payload = classpilotTurnTelemetryMetricPayload(metricTelemetry, { nowMs });
    try {
      (options.metricsSink ?? console.log)(JSON.stringify(payload));
    } catch {
      // Metrics are advisory and must never fail or prolong Live View setup.
    }
  }
  return { accepted };
}

export function resetClasspilotTurnTelemetryForTests(): void {
  localLimiter.clear();
}

export function snapshotClasspilotTurnTelemetryForTests(): {
  size: number;
  maxEntries: number;
  ttlMs: number;
} {
  return {
    size: localLimiter.size,
    maxEntries: localLimiter.maxEntries,
    ttlMs: localLimiter.ttlMs,
  };
}
