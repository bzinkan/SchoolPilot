export class PrivateNativeProcessingError extends Error {
  constructor(public readonly code: "busy" | "aborted" | "timeout") {
    super(`native_${code}`);
    this.name = "PrivateNativeProcessingError";
  }
}

type NativeOptions = { signal?: AbortSignal; deadline?: number };
type Waiter = { start: () => void };

/** One FIFO permit bounds both Poppler processes and complete Sharp transforms. */
export function createPrivateNativeProcessing(options: { maxQueued?: number; waitMs?: number } = {}) {
  const maxQueued = options.maxQueued ?? 4, waitMs = options.waitMs ?? 15_000;
  let active = false;
  const waiting: Waiter[] = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next) next.start(); else active = false;
  };
  const releaseOnce = () => {
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  };
  function acquire(settings: NativeOptions = {}): Promise<() => void> {
    const { signal } = settings;
    const remainingMs = settings.deadline === undefined ? waitMs : settings.deadline - Date.now();
    if (signal?.aborted) return Promise.reject(new PrivateNativeProcessingError("aborted"));
    if (remainingMs <= 0) return Promise.reject(new PrivateNativeProcessingError("timeout"));
    if (!active) { active = true; return Promise.resolve(releaseOnce()); }
    if (waiting.length >= maxQueued) return Promise.reject(new PrivateNativeProcessingError("busy"));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const remove = (code: "busy" | "aborted") => {
        const index = waiting.indexOf(waiter);
        if (index < 0) return;
        waiting.splice(index, 1); cleanup(); reject(new PrivateNativeProcessingError(code));
      };
      const abort = () => remove("aborted");
      const waiter: Waiter = { start: () => { cleanup(); resolve(releaseOnce()); } };
      const timer = setTimeout(() => remove("busy"), Math.min(waitMs, remainingMs));
      waiting.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async function run<T>(operation: () => Promise<T>, settings: NativeOptions = {}): Promise<T> {
    const release = await acquire(settings);
    try {
      if (settings.signal?.aborted) throw new PrivateNativeProcessingError("aborted");
      // Sharp's native timeout owns active work. Do not race or release this
      // permit on cancellation while libvips could still be decoding pixels.
      const result = await operation();
      if (settings.signal?.aborted) throw new PrivateNativeProcessingError("aborted");
      return result;
    } catch (error) {
      if (settings.signal?.aborted) throw new PrivateNativeProcessingError("aborted");
      // libvips emits this fixed marker when Sharp's .timeout terminates work.
      // Only classify it; never retain the native error or its private details.
      if (error instanceof Error && /^timeout: \d+% complete\r?$/m.test(error.message)) {
        throw new PrivateNativeProcessingError("timeout");
      }
      throw error;
    } finally { release(); }
  }
  return { acquire, run };
}

export type PrivateNativeProcessing = ReturnType<typeof createPrivateNativeProcessing>;
export const privateNativeProcessing = createPrivateNativeProcessing();
