const DAY = 86400000;
export function reportScope(user, school) {
  return [school?.id || '', user?.id || '', user?.authVersion ?? '', [...(user?.roles || [user?.role]).filter(Boolean)].sort().join(',')];
}
export function shiftReportDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(+value) || value.toISOString().slice(0, 10) !== date) throw new Error('Choose valid school dates.');
  value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}
export function reportSchoolDate(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}
function localParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(type => Number(parts.find(part => part.type === type)?.value));
}
export function reportDateBoundary(date, timeZone) {
  shiftReportDate(date, 0);
  const [year, month, day] = date.split('-').map(Number), midnight = Date.UTC(year, month - 1, day);
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = midnight + hours * 3600000, p = localParts(sample, timeZone);
    offsets.add(Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]) - sample);
  }
  // Choose the earliest real minute of the date, including midnight folds/gaps.
  for (let minute = 0; minute < 1440; minute++) {
    const candidates = [...offsets].map(offset => midnight + minute * 60000 - offset).filter(instant => {
      const p = localParts(instant, timeZone);
      return p[0] === year && p[1] === month && p[2] === day && p[3] * 60 + p[4] === minute;
    }).sort((a, b) => a - b);
    if (candidates.length) return new Date(candidates[0]).toISOString();
  }
  throw new Error('Choose a date that exists in the school timezone.');
}
export function reportFilters(values, timeZone) {
  const from = reportDateBoundary(values.fromDate, timeZone), through = reportDateBoundary(shiftReportDate(values.throughDate, 1), timeZone);
  const duration = Date.parse(through) - Date.parse(from);
  if (duration <= 0 || duration > 366 * DAY) throw new Error('Choose an ordered range of at most 366 elapsed days.');
  const params = { from, through };
  if (values.classFilter) {
    const separator = values.classFilter.indexOf(':'), kind = values.classFilter.slice(0, separator), id = values.classFilter.slice(separator + 1);
    if (!['classId', 'gradeId'].includes(kind) || !id) throw new Error('Choose a valid class.');
    params[kind] = id;
  }
  for (const key of ['studentId', 'teacherId', 'destination', 'issuedVia']) if (values[key]) params[key] = values[key];
  return params;
}
export function reportRatio(metric) {
  return metric?.denominator > 0 && Number.isFinite(metric.ratio) ? `${(metric.ratio * 100).toFixed(1)}% (${metric.numerator}/${metric.denominator})` : 'Unavailable — no eligible outcomes';
}
export function reportDuration(seconds) {
  return Number.isFinite(seconds) && seconds >= 0 ? `${(seconds / 60).toFixed(1)} min` : 'Unavailable';
}
export function validateReportPage(data) {
  if (data?.version !== 2 || !Array.isArray(data.passes) || typeof data.hasMore !== 'boolean'
    || (data.hasMore && (typeof data.nextCursor !== 'string' || !data.nextCursor))) throw new Error('Report pagination could not be verified. Refresh the report.');
  return data;
}
