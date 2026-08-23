const REVIEW_STATUS_LABELS = new Map([
  ['automated', 'Automated'],
  ['unreviewed', 'Automated'],
  ['confirmed', 'Confirmed'],
  ['dismissed', 'Dismissed'],
  ['escalated', 'Escalated'],
]);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function firstDefined(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      if (hasOwn(source, key) && source[key] != null) return source[key];
    }
  }
  return undefined;
}

function nonnegativeInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function boundedSeconds(value, maximum) {
  const seconds = nonnegativeInteger(value);
  if (seconds == null) return null;
  return maximum == null ? seconds : Math.min(seconds, maximum);
}

function normalizeStatusCount(value, students, status) {
  const count = nonnegativeInteger(value);
  return count ?? students.filter((student) => student.status === status).length;
}

function titleCase(value, fallback) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return fallback;
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeReportDomain(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
    if (parsed.hostname) return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    // Fall through to a conservative hostname-only parser.
  }

  const hostnameOnly = candidate
    .split(/[/?#]/, 1)[0]
    .replace(/^.*@/, '')
    .replace(/:\d+$/, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return /^[a-z0-9.-]+$/.test(hostnameOnly) ? hostnameOnly : null;
}

function normalizeTopDomains(value, monitoredSeconds, eligibleSeconds) {
  if (!Array.isArray(value)) return [];

  const aggregated = new Map();
  for (const item of value) {
    const domainEntry = asRecord(item);
    const domain = normalizeReportDomain(
      firstDefined([domainEntry], ['normalizedDomain', 'domain', 'url']),
    );
    const seconds = nonnegativeInteger(
      firstDefined([domainEntry], ['seconds', 'durationSeconds']),
    );
    if (!domain || seconds == null || seconds === 0) continue;
    const current = aggregated.get(domain) || { domain, seconds: 0, visits: 0 };
    current.seconds += seconds;
    current.visits += nonnegativeInteger(domainEntry.visits) || 0;
    aggregated.set(domain, current);
  }

  const timeBudget = monitoredSeconds ?? eligibleSeconds;
  let remainingSeconds = timeBudget;
  const domains = [];
  for (const domain of aggregated.values()) {
    const seconds = remainingSeconds == null
      ? domain.seconds
      : Math.min(domain.seconds, remainingSeconds);
    if (seconds <= 0) continue;
    domains.push({ ...domain, seconds });
    if (remainingSeconds != null) remainingSeconds -= seconds;
  }
  return domains;
}

function normalizeEvidenceAvailability(alert) {
  const evidence = asRecord(alert.evidence);
  const value = firstDefined(
    [alert, evidence],
    ['evidenceAvailability', 'availability', 'evidenceAvailable', 'available'],
  );
  if (value === true || String(value || '').toLowerCase() === 'available') return 'Available';
  return 'Unavailable';
}

function normalizeReviewStatus(value) {
  return REVIEW_STATUS_LABELS.get(String(value || 'automated').toLowerCase()) || 'Automated';
}

function normalizeSafetyAlert(value, fallbackId) {
  const alert = asRecord(value);
  return {
    id: String(alert.id || fallbackId),
    studentId: alert.studentId == null ? null : String(alert.studentId),
    category: titleCase(
      firstDefined([alert], ['category', 'safetyAlert', 'alertCategory']),
      'Safety alert',
    ),
    domain: normalizeReportDomain(
      firstDefined([alert], ['normalizedDomain', 'domain', 'url']),
    ),
    occurredAt: firstDefined([alert], ['occurredAt', 'occurrenceTime', 'timestamp']) || null,
    evidenceAvailability: normalizeEvidenceAvailability(alert),
    reviewStatus: normalizeReviewStatus(alert.reviewStatus),
  };
}

function normalizeSafetyAlerts(value, idPrefix) {
  if (!Array.isArray(value)) return [];
  return value.map((alert, index) => normalizeSafetyAlert(alert, `${idPrefix}-${index}`));
}

function normalizeStudent(studentValue, reportVersion, reportAlerts) {
  const student = asRecord(studentValue);
  const activity = asRecord(student.activity);
  const offTask = asRecord(student.offTask);

  let eligibleSeconds = nonnegativeInteger(
    firstDefined([student, activity], ['eligibleSeconds']),
  );
  let monitoredSeconds = nonnegativeInteger(
    firstDefined([student, activity], ['monitoredSeconds', 'observedSeconds']),
  );
  let gapSeconds = nonnegativeInteger(firstDefined([student, activity], ['gapSeconds']));

  if (eligibleSeconds == null && monitoredSeconds != null && gapSeconds != null) {
    eligibleSeconds = monitoredSeconds + gapSeconds;
  }
  if (monitoredSeconds == null && eligibleSeconds != null && gapSeconds != null) {
    monitoredSeconds = Math.max(0, eligibleSeconds - Math.min(gapSeconds, eligibleSeconds));
  }
  if (eligibleSeconds != null) {
    monitoredSeconds = boundedSeconds(monitoredSeconds, eligibleSeconds);
    gapSeconds = boundedSeconds(gapSeconds, eligibleSeconds);
  }

  const unclassifiedSeconds = boundedSeconds(
    firstDefined([student, activity], ['unclassifiedSeconds']),
    monitoredSeconds,
  );
  const offTaskSeconds = boundedSeconds(
    firstDefined([student, offTask], ['offTaskSeconds', 'seconds']),
    monitoredSeconds,
  );
  const offTaskEventCount = nonnegativeInteger(
    firstDefined([student, offTask], ['offTaskEventCount', 'eventCount']),
  );
  const explicitCoverage = nonnegativeInteger(student.coveragePercent);
  const coveragePercent = explicitCoverage == null && eligibleSeconds
    ? Math.round(((monitoredSeconds || 0) / eligibleSeconds) * 100)
    : explicitCoverage == null
      ? null
      : Math.min(100, explicitCoverage);
  const studentId = String(student.studentId || student.id || 'unknown-student');
  const embeddedSafety = firstDefined(
    [student, asRecord(student.safety)],
    ['safetyAlerts', 'alerts'],
  );
  const safetyAlerts = [
    ...normalizeSafetyAlerts(embeddedSafety, `${studentId}-embedded-alert`),
    ...reportAlerts.filter((alert) => alert.studentId === studentId),
  ];

  return {
    studentId,
    studentName: String(student.studentName || student.name || 'Student'),
    status: String(student.status || 'unavailable').toLowerCase(),
    eligibleSeconds,
    monitoredSeconds,
    gapSeconds,
    unclassifiedSeconds,
    coveragePercent,
    topDomains: normalizeTopDomains(
      firstDefined([student, activity], ['topDomains']),
      monitoredSeconds,
      eligibleSeconds,
    ),
    offTaskSeconds,
    offTaskEventCount,
    safetyAlerts,
    hasV2Details: reportVersion >= 2
      || unclassifiedSeconds != null
      || offTaskSeconds != null
      || offTaskEventCount != null
      || safetyAlerts.length > 0,
  };
}

function sumPresent(students, key) {
  let found = false;
  let total = 0;
  for (const student of students) {
    if (student[key] == null) continue;
    found = true;
    total += student[key];
  }
  return found ? total : null;
}

export function normalizeSessionMonitoringReport(value) {
  const report = asRecord(value);
  const totals = asRecord(report.totals);
  const activity = asRecord(report.activity);
  const offTask = asRecord(report.offTask);
  const parsedVersion = nonnegativeInteger(report.reportVersion ?? report.version);
  const reportVersion = parsedVersion && parsedVersion >= 2 ? parsedVersion : 1;
  const reportAlerts = normalizeSafetyAlerts(
    firstDefined([report, asRecord(report.safety)], ['safetyAlerts', 'alerts']),
    'report-alert',
  );
  const students = Array.isArray(report.students)
    ? report.students.map((student) => normalizeStudent(student, reportVersion, reportAlerts))
    : [];
  const unassignedSafetyAlerts = reportAlerts.filter((alert) => (
    !alert.studentId || !students.some((student) => student.studentId === alert.studentId)
  ));

  const eligibleSeconds = nonnegativeInteger(
    firstDefined([totals, activity], ['eligibleSeconds']),
  ) ?? sumPresent(students, 'eligibleSeconds');
  const monitoredSeconds = boundedSeconds(
    firstDefined([totals, activity], ['monitoredSeconds', 'observedSeconds'])
      ?? sumPresent(students, 'monitoredSeconds'),
    eligibleSeconds,
  );
  const gapSeconds = boundedSeconds(
    firstDefined([totals, activity], ['gapSeconds']) ?? sumPresent(students, 'gapSeconds'),
    eligibleSeconds,
  );
  const unclassifiedSeconds = boundedSeconds(
    firstDefined([totals, activity], ['unclassifiedSeconds'])
      ?? sumPresent(students, 'unclassifiedSeconds'),
    monitoredSeconds,
  );
  const offTaskSeconds = boundedSeconds(
    firstDefined([totals, offTask], ['offTaskSeconds', 'seconds'])
      ?? sumPresent(students, 'offTaskSeconds'),
    monitoredSeconds,
  );
  const offTaskEventCount = nonnegativeInteger(
    firstDefined([totals, offTask], ['offTaskEventCount', 'eventCount'])
      ?? sumPresent(students, 'offTaskEventCount'),
  );
  const inferredSafetyAlertCount = students.reduce(
    (sum, student) => sum + student.safetyAlerts.length,
    unassignedSafetyAlerts.length,
  );
  const safetyAlertCount = nonnegativeInteger(
    firstDefined([totals, asRecord(report.safety)], ['safetyAlertCount', 'alertCount']),
  ) ?? (reportVersion >= 2 || reportAlerts.length > 0 ? inferredSafetyAlertCount : null);

  return {
    reportVersion,
    timezone: typeof report.timezone === 'string' ? report.timezone : undefined,
    coverageAlgorithmVersion: report.coverageAlgorithmVersion || null,
    totals: {
      roster: nonnegativeInteger(totals.roster) ?? students.length,
      eligible: nonnegativeInteger(totals.eligible),
      complete: normalizeStatusCount(totals.complete, students, 'complete'),
      partial: normalizeStatusCount(totals.partial, students, 'partial'),
      none: normalizeStatusCount(totals.none, students, 'none'),
      notExpected: normalizeStatusCount(totals.notExpected, students, 'not_expected'),
      unavailable: normalizeStatusCount(totals.unavailable, students, 'unavailable'),
      eligibleSeconds,
      monitoredSeconds,
      gapSeconds,
      unclassifiedSeconds,
      offTaskSeconds,
      offTaskEventCount,
      safetyAlertCount,
    },
    students,
    unassignedSafetyAlerts,
    hasV2Details: reportVersion >= 2 || students.some((student) => student.hasV2Details),
  };
}

export function formatReportDuration(value) {
  const seconds = nonnegativeInteger(value);
  if (seconds == null) return 'Not included';
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remainingSeconds > 0 && hours === 0) parts.push(`${remainingSeconds}s`);
  return parts.join(' ');
}

export function formatReportDateTime(value, timezone) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  const options = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat('en-US', timezone ? { ...options, timeZone: timezone } : options).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(date);
  }
}
