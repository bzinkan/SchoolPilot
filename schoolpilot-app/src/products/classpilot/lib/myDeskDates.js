import { schoolDate } from './myDeskModel.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One date style across My Desk: "Sep 26" within the current year, "May 14, 2026" otherwise.
 * Entry dates are calendar days, so they are formatted in UTC; formatting "2026-09-01" in a
 * school timezone west of UTC would show the previous day. Timestamps use the school timezone.
 */
export function formatDeskDate(value, { timeZone = 'America/New_York', now = new Date(), withYear = false } = {}) {
  if (!value) return '';
  const dateOnly = typeof value === 'string' && DATE_ONLY.test(value);
  const date = dateOnly ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const year = dateOnly ? value.slice(0, 4) : schoolDate(timeZone, date).slice(0, 4);
  const showYear = withYear || year !== schoolDate(timeZone, now).slice(0, 4);
  return new Intl.DateTimeFormat('en-US', { timeZone: dateOnly ? 'UTC' : timeZone, month: 'short', day: 'numeric', ...(showYear ? { year: 'numeric' } : {}) }).format(date);
}
