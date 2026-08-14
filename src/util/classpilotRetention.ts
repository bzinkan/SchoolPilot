export const DEFAULT_CLASSPILOT_RETENTION_DAYS = 30;
export const MIN_CLASSPILOT_RETENTION_DAYS = 1;
export const MAX_CLASSPILOT_RETENTION_DAYS = 365;

function strictRetentionHours(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
}

export function parseClasspilotRetentionDays(
  retentionHours: unknown,
  fallbackDays = DEFAULT_CLASSPILOT_RETENTION_DAYS
): number {
  const hours = strictRetentionHours(retentionHours);
  if (
    !Number.isInteger(hours)
    || hours < MIN_CLASSPILOT_RETENTION_DAYS * 24
    || hours > MAX_CLASSPILOT_RETENTION_DAYS * 24
    || hours % 24 !== 0
  ) {
    return fallbackDays;
  }
  return hours / 24;
}

export function assertClasspilotRetentionHours(value: unknown): number {
  const hours = strictRetentionHours(value);
  if (
    !Number.isInteger(hours)
    || hours < MIN_CLASSPILOT_RETENTION_DAYS * 24
    || hours > MAX_CLASSPILOT_RETENTION_DAYS * 24
    || hours % 24 !== 0
  ) {
    throw Object.assign(
      new Error("Retention must be a whole number of days from 1 through 365"),
      { status: 400, code: "INVALID_RETENTION" }
    );
  }
  return hours;
}

export function classpilotRetentionExpiresAt(
  base: Date,
  retentionHours: unknown
): Date {
  const days = parseClasspilotRetentionDays(retentionHours);
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}
