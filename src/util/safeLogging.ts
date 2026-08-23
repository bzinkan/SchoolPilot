const SAFE_ERROR_CODE = /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/i;
const SAFE_ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "AggregateError",
]);

export type SafeErrorMetadata = {
  errorType: string;
  errorCode?: string;
};

/**
 * Produce identifier-free operational error metadata for stdout/stderr.
 *
 * Error messages, stacks, causes, request bodies, and URLs are intentionally
 * excluded because they can contain tenant, student, credential, or prompt
 * data. Detailed errors flow through the separately scrubbed error monitor.
 */
export function safeErrorMetadata(error: unknown): SafeErrorMetadata {
  const candidate = error as { name?: unknown; code?: unknown } | null | undefined;
  const name = typeof candidate?.name === "string" && SAFE_ERROR_TYPES.has(candidate.name)
    ? candidate.name
    : "Error";
  const code = typeof candidate?.code === "string" && SAFE_ERROR_CODE.test(candidate.code)
    ? candidate.code
    : undefined;
  return code ? { errorType: name, errorCode: code } : { errorType: name };
}
