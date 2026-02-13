import { formatDistanceToNow } from 'date-fns';

/**
 * Format time as "9:30 AM"
 */
export function formatTime(date, timezone) {
  if (!date) return '';
  const d = new Date(date);
  const options = { hour: 'numeric', minute: '2-digit', hour12: true };
  if (timezone) options.timeZone = timezone;
  return d.toLocaleTimeString('en-US', options);
}

/**
 * Format time with seconds as "9:30:45 AM"
 */
export function formatTimeFull(date, timezone) {
  if (!date) return '';
  const d = new Date(date);
  const options = { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true };
  if (timezone) options.timeZone = timezone;
  return d.toLocaleTimeString('en-US', options);
}

/**
 * Format hour as "9 AM"
 */
export function formatHour(date, timezone) {
  if (!date) return '';
  const d = new Date(date);
  const options = { hour: 'numeric', hour12: true };
  if (timezone) options.timeZone = timezone;
  return d.toLocaleTimeString('en-US', options);
}

/**
 * Format date as "1/15/2025"
 */
export function formatDate(date, timezone) {
  if (!date) return '';
  const d = new Date(date);
  const options = { year: 'numeric', month: 'numeric', day: 'numeric' };
  if (timezone) options.timeZone = timezone;
  return d.toLocaleDateString('en-US', options);
}

/**
 * Format date and time as "1/15/2025, 9:30:45 AM"
 */
export function formatDateTime(date, timezone) {
  if (!date) return '';
  const d = new Date(date);
  const dateOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
  const timeOptions = { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true };
  if (timezone) {
    dateOptions.timeZone = timezone;
    timeOptions.timeZone = timezone;
  }
  const datePart = d.toLocaleDateString('en-US', dateOptions);
  const timePart = d.toLocaleTimeString('en-US', timeOptions);
  return `${datePart}, ${timePart}`;
}

/**
 * Format short date and time as "Jan 15, 9:30 AM"
 */
export function formatShortDateTime(date, timezone) {
  if (!date) return '';
  const d = new Date(date);
  const dateOptions = { month: 'short', day: 'numeric' };
  const timeOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
  if (timezone) {
    dateOptions.timeZone = timezone;
    timeOptions.timeZone = timezone;
  }
  const datePart = d.toLocaleDateString('en-US', dateOptions);
  const timePart = d.toLocaleTimeString('en-US', timeOptions);
  return `${datePart}, ${timePart}`;
}

/**
 * Format a date as relative time, e.g. "5 minutes ago"
 */
export function formatRelative(date) {
  if (!date) return '';
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

/**
 * Get midnight of today in the given timezone, returned as a UTC Date.
 */
export function startOfTodayInTimezone(timezone) {
  const now = new Date();
  // Get today's date components in the target timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  const day = parts.find((p) => p.type === 'day').value;

  // Build an ISO string for midnight in that timezone, then convert to UTC
  // We use a temporary date to find the UTC offset at midnight in the target timezone
  const midnightStr = `${year}-${month}-${day}T00:00:00`;

  // Create date assuming local, then adjust: find the offset for that timezone
  const tempDate = new Date(midnightStr);
  const utcStr = tempDate.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = tempDate.toLocaleString('en-US', { timeZone: timezone });
  const utcDate = new Date(utcStr);
  const tzDate = new Date(tzStr);
  const offsetMs = utcDate - tzDate;

  // Midnight in the target timezone expressed as a UTC Date
  return new Date(tempDate.getTime() + offsetMs);
}
