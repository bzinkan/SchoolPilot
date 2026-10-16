export const REDIS_HEALTH_TIMEOUT_MS = 500;

/** Use the bounded coordination adapter, never a raw node-redis PING: after
 * a socket write its command timeout does not bound a withheld RESP reply. */
export async function checkHealthRedis(
  configured: boolean,
  execute: (args: string[], options: { timeoutMs: number }) => Promise<unknown>,
): Promise<{ ok: boolean; latencyMs?: number; detail?: string; error?: string }> {
  if (!configured) return { ok: true, detail: "disabled (single-instance mode)" };
  const started = performance.now();
  try {
    const result = await execute(["PING"], { timeoutMs: REDIS_HEALTH_TIMEOUT_MS });
    return result === "PONG"
      ? { ok: true, latencyMs: Math.max(0, performance.now() - started) }
      : { ok: false, error: "Configured Redis did not answer the bounded health probe" };
  } catch {
    return { ok: false, error: "Configured Redis health probe failed" };
  }
}
