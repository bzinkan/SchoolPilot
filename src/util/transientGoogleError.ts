const TRANSIENT_GOOGLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function numericStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function isTransientGoogleError(error: unknown): boolean {
  const err = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  } | null;
  const status =
    numericStatus(err?.response?.status) ??
    numericStatus(err?.status) ??
    numericStatus(err?.code);
  if (status && TRANSIENT_GOOGLE_STATUSES.has(status)) return true;

  const message = typeof err?.message === "string" ? err.message.toLowerCase() : "";
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("temporarily unavailable")
  );
}
