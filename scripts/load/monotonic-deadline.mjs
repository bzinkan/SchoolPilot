const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export function millisecondsUntil(deadlineNs, nowNs) {
  if (nowNs >= deadlineNs) return 0;
  return Number(
    (deadlineNs - nowNs + NANOSECONDS_PER_MILLISECOND - 1n) /
      NANOSECONDS_PER_MILLISECOND
  );
}

export function createMonotonicDeadline({
  deadlineNs,
  nowNs = () => process.hrtime.bigint(),
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancel = (timer) => clearTimeout(timer),
  onReached,
}) {
  if (typeof deadlineNs !== "bigint") throw new TypeError("deadlineNs must be a bigint");
  if (typeof onReached !== "function") throw new TypeError("onReached must be a function");

  let timer = null;
  let closed = false;

  const check = () => {
    timer = null;
    if (closed) return;

    const delayMs = millisecondsUntil(deadlineNs, nowNs());
    if (delayMs > 0) {
      timer = schedule(check, delayMs);
      return;
    }

    closed = true;
    onReached();
  };

  return {
    start() {
      if (!closed && timer === null) check();
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (timer !== null) cancel(timer);
      timer = null;
    },
    get active() {
      return !closed;
    },
  };
}
