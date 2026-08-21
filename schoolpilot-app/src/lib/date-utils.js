import { formatDistanceToNow, startOfDay } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

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
export function startOfTodayInTimezone(timezone, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const schoolNow = toZonedTime(now, timezone);
  return fromZonedTime(startOfDay(schoolNow), timezone);
}
