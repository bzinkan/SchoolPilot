const DAY_MS = 86_400_000;
const SCOPES = new Set(['school', 'grade', 'class', 'student']);

export function usageLocalDate(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function usageAddDays(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && usageAddDays(date, 0) === date;
}

export function usageDateRange(period, today, custom = {}) {
  if (period !== 'custom') return { from: usageAddDays(today, period === '7d' ? -6 : period === '30d' ? -29 : 0), to: today };
  if (!validDate(custom.from) || !validDate(custom.to)) return { error: 'Choose a valid start and end date.' };
  const days = (Date.parse(custom.to) - Date.parse(custom.from)) / DAY_MS + 1;
  if (days < 1 || days > 366) return { error: 'Choose an ordered range of at most 366 days.' };
  return { from: custom.from, to: custom.to };
}

export function usageQuery(scope, id, range, format = 'json') {
  if (!SCOPES.has(scope) || range.error || !range.from || !range.to || (scope !== 'school' && !id)) return null;
  const params = new URLSearchParams({ scope, from: range.from, to: range.to, format });
  if (scope !== 'school') params.set('id', id);
  return params.toString();
}

export function requireUsageReport(report) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report?.range?.unavailableDates)
    || !Number.isInteger(report.range.computedDays) || !Number.isInteger(report.range.requestedDays)) {
    throw new Error('Report coverage is unavailable. Refresh after the reporting service is updated.');
  }
  return report;
}

export function usagePresentationState(report) {
  if (report.dataState === 'unavailable') return 'Unavailable';
  if (report.range.partiallyComputed || report.range.partiallyExpired || report.range.to > report.range.today) return 'Partial';
  return report.dataState === 'live' ? 'Live' : 'Final';
}

// Keep absent days absent from all numeric series. Only a successful byDay row
// can supply zero; neither date interpolation nor retention supplies observations.
export function usageCalendar(report) {
  const { range } = report;
  const rows = new Map(report.byDay.map(day => [day.date, day]));
  const days = [];
  for (let date = range.from; date <= range.to; date = usageAddDays(date, 1)) {
    const row = rows.get(date);
    days.push(row || { date, state: date > range.today ? 'future' : date < range.retainedFrom ? 'expired' : 'unavailable', monitoredBrowserSeconds: null });
  }
  return days;
}

export function formatUsageTime(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${total % 60 ? ` ${total % 60}s` : ''}`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

export function usageGrades(students, configured = []) {
  return [...new Set([...configured, ...students.map(student => student.gradeLevel)].filter(value => typeof value === 'string' && value.trim()))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function usageError(error) {
  const status = error?.response?.status;
  if (status === 404 && !error?.response?.data?.code) return 'Monitored Browser Time is not available for this school yet.';
  if (status === 403) return 'Administrator access is required for this report.';
  return error?.response?.data?.error || error?.message || 'The report could not be loaded.';
}
