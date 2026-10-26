/** Closed aggregate names only; no runtime, Redis, database or timer dependency. */
export const FAB_SYNC_PENDING_REDIS_COUNTERS = {
  mark: {
    accepted: "fabSyncPendingRedisMarkAccepted",
    notAdmitted: "fabSyncPendingRedisMarkNotAdmitted",
    notAdmittedReasons: {
      not_ready: "fabSyncPendingRedisMarkNotAdmittedNotReady",
      queue_full: "fabSyncPendingRedisMarkNotAdmittedQueueFull",
      circuit_open: "fabSyncPendingRedisMarkNotAdmittedCircuitOpen",
      shutdown: "fabSyncPendingRedisMarkNotAdmittedShutdown",
      aborted: "fabSyncPendingRedisMarkNotAdmittedAborted",
      not_configured: "fabSyncPendingRedisMarkNotAdmittedNotConfigured",
    },
    unknown: "fabSyncPendingRedisMarkUnknown",
    unknownReasons: {
      timeout: "fabSyncPendingRedisMarkUnknownTimeout",
      transport_lost: "fabSyncPendingRedisMarkUnknownTransportLost",
      shutdown: "fabSyncPendingRedisMarkUnknownShutdown",
      aborted: "fabSyncPendingRedisMarkUnknownAborted",
    },
    exception: "fabSyncPendingRedisMarkException",
  },
  take: {
    accepted: "fabSyncPendingRedisTakeAccepted",
    notAdmitted: "fabSyncPendingRedisTakeNotAdmitted",
    notAdmittedReasons: {
      not_ready: "fabSyncPendingRedisTakeNotAdmittedNotReady",
      queue_full: "fabSyncPendingRedisTakeNotAdmittedQueueFull",
      circuit_open: "fabSyncPendingRedisTakeNotAdmittedCircuitOpen",
      shutdown: "fabSyncPendingRedisTakeNotAdmittedShutdown",
      aborted: "fabSyncPendingRedisTakeNotAdmittedAborted",
      not_configured: "fabSyncPendingRedisTakeNotAdmittedNotConfigured",
    },
    unknown: "fabSyncPendingRedisTakeUnknown",
    unknownReasons: {
      timeout: "fabSyncPendingRedisTakeUnknownTimeout",
      transport_lost: "fabSyncPendingRedisTakeUnknownTransportLost",
      shutdown: "fabSyncPendingRedisTakeUnknownShutdown",
      aborted: "fabSyncPendingRedisTakeUnknownAborted",
    },
    exception: "fabSyncPendingRedisTakeException",
  },
} as const;

export const FAB_SYNC_PENDING_REDIS_TAKE_REPLY_COUNTERS = {
  hit: "fabSyncPendingRedisTakeStringHit",
  empty: "fabSyncPendingRedisTakeNullEmpty",
  unexpected: "fabSyncPendingRedisTakeUnexpectedReply",
} as const;

export const FAB_SYNC_PENDING_LOCAL_TAKE_COUNTERS = {
  hit: "fabSyncPendingTakeLocalHit",
  miss: "fabSyncPendingTakeLocalMiss",
  expired: "fabSyncPendingTakeLocalExpired",
} as const;
export const FAB_SYNC_PENDING_UNAVAILABLE_LOCAL_TAKE_COUNTERS = {
  hit: "fabSyncPendingTakeUnavailableLocalHit",
  miss: "fabSyncPendingTakeUnavailableLocalMiss",
  expired: "fabSyncPendingTakeUnavailableLocalExpired",
} as const;

export const FAB_SYNC_PENDING_COUNTER_NAMES = [
  ...Object.values(FAB_SYNC_PENDING_REDIS_COUNTERS).flatMap((operation) => [
    operation.accepted, operation.notAdmitted, ...Object.values(operation.notAdmittedReasons),
    operation.unknown, ...Object.values(operation.unknownReasons), operation.exception,
  ]),
  ...Object.values(FAB_SYNC_PENDING_REDIS_TAKE_REPLY_COUNTERS),
  ...Object.values(FAB_SYNC_PENDING_LOCAL_TAKE_COUNTERS),
  ...Object.values(FAB_SYNC_PENDING_UNAVAILABLE_LOCAL_TAKE_COUNTERS),
] as const;

export type FabSyncPendingDiagnosticsCounter = typeof FAB_SYNC_PENDING_COUNTER_NAMES[number];
export type FabSyncPendingRedisOperation = keyof typeof FAB_SYNC_PENDING_REDIS_COUNTERS;
export type FabSyncPendingLocalTakeOutcome = keyof typeof FAB_SYNC_PENDING_LOCAL_TAKE_COUNTERS;
