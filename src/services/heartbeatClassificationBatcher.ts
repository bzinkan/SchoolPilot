import db from "../db.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  updateHeartbeatClassification,
  updateHeartbeatClassifications,
  type HeartbeatClassificationUpdate,
} from "./storage.js";
import {
  invalidateHeartbeatTileCaches,
  patchHeartbeatTileCacheClassifications,
} from "./heartbeatTileCache.js";
import {
  recordHeartbeatHotPathCounter,
  recordHeartbeatHotPathTiming,
} from "./heartbeatHotPathMetrics.js";

export const HEARTBEAT_CLASSIFICATION_BATCH_MAX_ROWS = 100;
export const HEARTBEAT_CLASSIFICATION_BATCH_MAX_WAIT_MS = 250;
const inFlightClassificationProducers = new Set<Promise<unknown>>();

export function trackHeartbeatClassificationProducer<T>(
  producer: Promise<T>
): Promise<T> {
  let tracked!: Promise<T>;
  tracked = producer.finally(() => {
    inFlightClassificationProducers.delete(tracked);
  });
  inFlightClassificationProducers.add(tracked);
  return tracked;
}

export async function flushHeartbeatClassificationProducers(): Promise<void> {
  while (inFlightClassificationProducers.size > 0) {
    // Producer errors remain non-blocking exactly as they are during request
    // handling, but shutdown must still wait for every callback to settle.
    await Promise.allSettled([...inFlightClassificationProducers]);
  }
}

export type HeartbeatClassificationPersistence = HeartbeatClassificationUpdate & {
  schoolId: string;
  deviceId: string;
  cacheWrite?: Promise<boolean>;
};

type BatchState = {
  pending: Map<string, HeartbeatClassificationPersistence>;
  timer?: NodeJS.Timeout;
  flushing?: Promise<void>;
};

type ClassificationBatcherDependencies = {
  persistImmediate(entry: HeartbeatClassificationPersistence): Promise<void>;
  persistBatch(
    schoolId: string,
    entries: HeartbeatClassificationPersistence[]
  ): Promise<void>;
  patchCache(entries: HeartbeatClassificationPersistence[]): Promise<boolean>;
  invalidateCache?(
    entries: HeartbeatClassificationPersistence[]
  ): Promise<boolean>;
};

function isImmediate(entry: HeartbeatClassificationPersistence): boolean {
  return entry.aiCategory === "non-educational" || entry.safetyAlert !== null;
}

export class HeartbeatClassificationBatcher {
  private readonly batches = new Map<string, BatchState>();
  private readonly inFlightPersistence = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(private readonly dependencies: ClassificationBatcherDependencies) {}

  private async persistImmediateWithRetry(
    entry: HeartbeatClassificationPersistence
  ): Promise<void> {
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.dependencies.persistImmediate(entry);
        recordHeartbeatHotPathTiming(
          "classificationImmediateMs",
          Date.now() - startedAt
        );
        return;
      } catch (error) {
        if (attempt === 3) {
          recordHeartbeatHotPathCounter("classificationImmediateFailures");
          recordHeartbeatHotPathTiming(
            "classificationImmediateMs",
            Date.now() - startedAt
          );
          // PII-free and explicit: the detached route may continue its urgent
          // close-tab/alert actions, but persistence exhaustion is never silent.
          console.error(JSON.stringify({
            event: "classpilot_critical_classification_persist_failure",
            attempts: attempt,
          }));
          throw error;
        }
        recordHeartbeatHotPathCounter("classificationImmediateRetries");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100 * 2 ** (attempt - 1));
        });
      }
    }
  }

  private async persistEntry(
    entry: HeartbeatClassificationPersistence
  ): Promise<void> {
    if (isImmediate(entry) || this.shuttingDown) {
      recordHeartbeatHotPathCounter("classificationImmediate");
      await this.persistImmediateWithRetry(entry);
      if (entry.cacheWrite) await Promise.allSettled([entry.cacheWrite]);
      const patched = await this.dependencies.patchCache([entry]);
      if (!patched) await this.dependencies.invalidateCache?.([entry]);
      return;
    }

    const state = this.batches.get(entry.schoolId) ?? {
      pending: new Map<string, HeartbeatClassificationPersistence>(),
    };
    state.pending.set(entry.heartbeatId, entry);
    this.batches.set(entry.schoolId, state);
    recordHeartbeatHotPathCounter("classificationQueued");

    if (state.pending.size >= HEARTBEAT_CLASSIFICATION_BATCH_MAX_ROWS) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      void this.flushSchool(entry.schoolId).catch(() => {});
      return;
    }
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void this.flushSchool(entry.schoolId).catch(() => {});
      }, HEARTBEAT_CLASSIFICATION_BATCH_MAX_WAIT_MS);
      state.timer.unref?.();
    }
  }

  persist(entry: HeartbeatClassificationPersistence): Promise<void> {
    let tracked!: Promise<void>;
    tracked = this.persistEntry(entry).finally(() => {
      this.inFlightPersistence.delete(tracked);
    });
    this.inFlightPersistence.add(tracked);
    return tracked;
  }

  private async persistBatchWithRetry(
    schoolId: string,
    entries: HeartbeatClassificationPersistence[],
    maxAttempts: number
  ): Promise<void> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      const startedAt = Date.now();
      try {
        await this.dependencies.persistBatch(schoolId, entries);
        recordHeartbeatHotPathCounter("classificationBatchFlushes");
        recordHeartbeatHotPathCounter("classificationBatchRows", entries.length);
        recordHeartbeatHotPathTiming("classificationBatchMs", Date.now() - startedAt);
        await Promise.allSettled(
          entries
            .map((entry) => entry.cacheWrite)
            .filter((write): write is Promise<boolean> => Boolean(write))
        );
        const patched = await this.dependencies.patchCache(entries);
        if (!patched) await this.dependencies.invalidateCache?.(entries);
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          recordHeartbeatHotPathCounter("classificationBatchFailures");
          throw error;
        }
        recordHeartbeatHotPathCounter("classificationBatchRetries");
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(1_000, 100 * 2 ** (attempt - 1)));
        });
      }
    }
  }

  async flushSchool(
    schoolId: string,
    options: { maxAttempts?: number } = {}
  ): Promise<void> {
    const state = this.batches.get(schoolId);
    if (!state) return;
    if (state.flushing) return state.flushing;

    state.flushing = (async () => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      while (state.pending.size > 0) {
        const entries = [...state.pending.values()].slice(
          0,
          HEARTBEAT_CLASSIFICATION_BATCH_MAX_ROWS
        );
        for (const entry of entries) state.pending.delete(entry.heartbeatId);
        try {
          await this.persistBatchWithRetry(
            schoolId,
            entries,
            options.maxAttempts ?? 3
          );
        } catch (error) {
          // Never overwrite a newer classification that arrived while this
          // batch was in flight. Failed rows remain queued for a later retry.
          for (const entry of entries) {
            if (!state.pending.has(entry.heartbeatId)) {
              state.pending.set(entry.heartbeatId, entry);
            }
          }
          if (!this.shuttingDown && !state.timer) {
            state.timer = setTimeout(() => {
              state.timer = undefined;
              void this.flushSchool(schoolId).catch(() => {});
            }, 1_000);
            state.timer.unref?.();
          }
          throw error;
        }
      }
    })();

    try {
      await state.flushing;
    } finally {
      state.flushing = undefined;
      if (state.pending.size === 0 && !state.timer) {
        this.batches.delete(schoolId);
      }
    }
  }

  async flushAll(options: { maxAttempts?: number } = {}): Promise<void> {
    this.shuttingDown = true;
    for (const state of this.batches.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
    }
    const results = await Promise.allSettled(
      [...this.batches.keys()].map((schoolId) =>
        this.flushSchool(schoolId, { maxAttempts: options.maxAttempts ?? 3 })
      )
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failed) throw failed.reason;

    // Immediate safety/non-educational writes are detached by the HTTP route,
    // so they are not represented in the school batch maps. Drain the tracked
    // set to quiescence after the servers stop accepting new requests. Entries
    // that began during shutdown are forced through this immediate path too.
    while (this.inFlightPersistence.size > 0) {
      const persistenceResults = await Promise.allSettled([
        ...this.inFlightPersistence,
      ]);
      const persistenceFailure = persistenceResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      if (persistenceFailure) throw persistenceFailure.reason;
    }
  }
}

const defaultBatcher = new HeartbeatClassificationBatcher({
  async persistImmediate(entry) {
    await runWithTenantContext({ schoolId: entry.schoolId }, () =>
      updateHeartbeatClassification(
        entry.heartbeatId,
        entry.aiCategory,
        entry.safetyAlert
      )
    );
  },
  async persistBatch(schoolId, entries) {
    await runWithTenantContext({ schoolId }, () =>
      db.transaction(async (transaction) => {
        await updateHeartbeatClassifications(schoolId, entries, transaction);
      })
    );
  },
  patchCache: patchHeartbeatTileCacheClassifications,
  invalidateCache: invalidateHeartbeatTileCaches,
});

export async function persistHeartbeatClassification(
  entry: HeartbeatClassificationPersistence
): Promise<void> {
  return defaultBatcher.persist(entry);
}

export async function flushHeartbeatClassificationBatches(): Promise<void> {
  // Existing HTTP requests register classifyUrl() itself before detaching it.
  // Drain those producers first so none can enqueue a persistence write after
  // the batcher has declared itself quiescent and the database pools close.
  await flushHeartbeatClassificationProducers();
  return defaultBatcher.flushAll({ maxAttempts: 3 });
}
