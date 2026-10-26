import type { RedisPublicationOutcome } from "../realtime/boundedRedisPublication.js";
import { recordRuntimePerformanceCounters } from "./runtimePerformanceMetrics.js";
import {
  FAB_SYNC_PENDING_REDIS_COUNTERS,
  FAB_SYNC_PENDING_REDIS_TAKE_REPLY_COUNTERS,
  FAB_SYNC_PENDING_LOCAL_TAKE_COUNTERS,
  FAB_SYNC_PENDING_UNAVAILABLE_LOCAL_TAKE_COUNTERS,
  type FabSyncPendingDiagnosticsCounter,
  type FabSyncPendingRedisOperation,
  type FabSyncPendingLocalTakeOutcome,
} from "./classpilotFabSyncDiagnosticsContract.js";

export type FabSyncPendingDiagnosticsSink = (increments: Partial<Record<FabSyncPendingDiagnosticsCounter, number>>) => void;

/** Transport disposition only, never a student/message count or delivery ACK. */
export function recordFabSyncPendingRedisOutcome(
  operation: FabSyncPendingRedisOperation,
  outcome: RedisPublicationOutcome<unknown> | { status: "exception" },
  sink: FabSyncPendingDiagnosticsSink = recordRuntimePerformanceCounters,
): void {
  try {
    if (operation !== "mark" && operation !== "take") return;
    if (!outcome || typeof outcome !== "object") return;
    const names = FAB_SYNC_PENDING_REDIS_COUNTERS[operation];
    const counts: Partial<Record<FabSyncPendingDiagnosticsCounter, number>> = {};
    const status = outcome.status;
    if (status === "accepted") {
      counts[names.accepted] = 1;
      if (operation === "take") {
        const value = outcome.value;
        const reply = typeof value === "string" ? "hit" : value === null ? "empty" : "unexpected";
        counts[FAB_SYNC_PENDING_REDIS_TAKE_REPLY_COUNTERS[reply]] = 1;
      }
    } else if (status === "exception") {
      counts[names.exception] = 1;
    } else if (status === "not_admitted") {
      const reason = outcome.reason;
      if (typeof reason !== "string" || !Object.hasOwn(names.notAdmittedReasons, reason)) return;
      counts[names.notAdmitted] = 1;
      counts[names.notAdmittedReasons[reason]] = 1;
    } else if (status === "unknown") {
      const reason = outcome.reason;
      if (typeof reason !== "string" || !Object.hasOwn(names.unknownReasons, reason)) return;
      counts[names.unknown] = 1;
      counts[names.unknownReasons[reason]] = 1;
    } else return;
    sink(counts);
  } catch {
    // Broken diagnostic inputs/sinks never affect the original command outcome.
    // No payload, identifiers, arbitrary error strings or recursive logs.
  }
}

/** Local fallback disposition, atomically paired with shared-unavailable context. */
export function recordFabSyncPendingLocalTake(
  outcome: FabSyncPendingLocalTakeOutcome,
  sharedUnavailable: boolean,
  sink: FabSyncPendingDiagnosticsSink = recordRuntimePerformanceCounters,
): void {
  try {
    if (outcome !== "hit" && outcome !== "miss" && outcome !== "expired") return;
    if (typeof sharedUnavailable !== "boolean") return;
    const counts: Partial<Record<FabSyncPendingDiagnosticsCounter, number>> = {
      [FAB_SYNC_PENDING_LOCAL_TAKE_COUNTERS[outcome]]: 1,
    };
    if (sharedUnavailable) counts[FAB_SYNC_PENDING_UNAVAILABLE_LOCAL_TAKE_COUNTERS[outcome]] = 1;
    sink(counts);
  } catch { /* Best effort; no fallback or delivery behavior changes. */ }
}
