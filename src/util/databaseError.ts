export type DatabaseErrorDetails = {
  code?: string;
  constraint?: string;
};

/**
 * Drizzle wraps PostgreSQL driver errors on `cause` (and wrappers can be
 * nested). Walk the chain without copying messages/details, which may contain
 * statement values or other sensitive data.
 */
export function getDatabaseErrorDetails(error: unknown): DatabaseErrorDetails {
  const seen = new Set<object>();
  let current: unknown = error;
  let code: string | undefined;
  let constraint: string | undefined;

  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (!code && typeof candidate.code === "string") code = candidate.code;
    if (!constraint && typeof candidate.constraint === "string") {
      constraint = candidate.constraint;
    }
    current = candidate.cause;
  }

  return { code, constraint };
}

export function isDatabaseErrorCode(error: unknown, code: string): boolean {
  return getDatabaseErrorDetails(error).code === code;
}
