type Counters = Partial<Record<string, number>>;
type Snapshot = (options?: { reset?: boolean }) => { counters: Counters };

/** Test assertions span minute boundaries; production snapshots intentionally do not. */
export function observeRuntimeCounterWindow(snapshot: Snapshot, logger: Pick<Console, "log"> = console) {
  const emitted: Counters = {};
  const originalLog = logger.log;
  const capture: typeof logger.log = (...args) => {
    if (args.length === 1 && typeof args[0] === "string") {
      let row: { event?: string; counters?: Counters } | undefined;
      try { row = JSON.parse(args[0]); } catch { /* Ordinary log output is unchanged. */ }
      if (row?.event === "schoolpilot_runtime_performance_summary" && row.counters) {
        for (const [name, value] of Object.entries(row.counters)) {
          if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            emitted[name] = (emitted[name] ?? 0) + value;
          }
        }
      }
    }
    originalLog.apply(logger, args);
  };
  logger.log = capture;
  return {
    counters(): Counters {
      const result = { ...emitted };
      for (const [name, value] of Object.entries(snapshot().counters)) {
        if (value !== undefined) result[name] = (result[name] ?? 0) + value;
      }
      return result;
    },
    reset(): void {
      snapshot({ reset: true });
      for (const name of Object.keys(emitted)) delete emitted[name];
    },
    restore(): void { logger.log = originalLog; },
  };
}
