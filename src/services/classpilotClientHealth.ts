import { z } from "zod";
import { getRuntimeMetadata } from "./runtimeMetadata.js";

const boundedCount = z.number().int().min(0).max(6_000);

/** Disjoint buckets: <=5s, (5,10]s, (10,15]s, (15,30]s, >30s, unavailable. */
export const classpilotClientHealthSchema = z.object({
  version: z.literal(1),
  intervalSeconds: z.literal(60),
  freshnessBuckets: z.tuple([
    boundedCount, boundedCount, boundedCount, boundedCount, boundedCount, boundedCount,
  ]).refine(values => values.reduce((total, value) => total + value, 0) <= 6_000),
  counters: z.object({
    readTimeouts: boundedCount,
    reconnects: boundedCount,
    recoveries: boundedCount,
    eventGapRecoveries: boundedCount,
  }).strict(),
}).strict();

export type ClasspilotClientHealth = z.infer<typeof classpilotClientHealthSchema>;

const FRESHNESS_METRICS = [
  "ClientPreviewAge0To5Seconds", "ClientPreviewAge5To10Seconds",
  "ClientPreviewAge10To15Seconds", "ClientPreviewAge15To30Seconds",
  "ClientPreviewAgeOver30Seconds", "ClientPreviewUnavailable",
] as const;
const COUNTER_METRICS = {
  readTimeouts: "ClientSnapshotReadTimeouts",
  reconnects: "ClientReconnects",
  recoveries: "ClientRecoveries",
  eventGapRecoveries: "ClientScreenshotEventGapRecoveries",
} as const;

/** Only fixed aggregate values leave this boundary; request identity is never logged. */
export function emitClasspilotClientHealth(
  summary: ClasspilotClientHealth,
  sink: (line: string) => void = console.log,
  now: () => number = Date.now,
): void {
  const runtime = getRuntimeMetadata();
  const values: Record<string, number> = {};
  FRESHNESS_METRICS.forEach((name, index) => { values[name] = summary.freshnessBuckets[index]!; });
  for (const key of Object.keys(COUNTER_METRICS) as (keyof typeof COUNTER_METRICS)[]) {
    values[COUNTER_METRICS[key]] = summary.counters[key];
  }
  const activeNames = Object.keys(values).filter(name => values[name]! > 0);
  sink(JSON.stringify({
    ...(activeNames.length ? {
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [{
          Namespace: "SchoolPilot/ClassPilot",
          Dimensions: [["Environment", "Service"]],
          Metrics: activeNames.map(Name => ({ Name, Unit: "Count" })),
        }],
      },
    } : {}),
    event: "classpilot_client_health_summary",
    Environment: runtime.environment,
    Service: runtime.service,
    version: 1,
    intervalSeconds: 60,
    ...values,
  }));
}
