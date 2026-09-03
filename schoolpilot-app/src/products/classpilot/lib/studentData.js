const STUDENT_DATA_PERIODS = new Set(['today', 'week', 'month', 'year']);
const STUDENT_DATA_SCOPE_KINDS = new Set(['school', 'mine', 'class']);
const STUDENT_DATA_STATES = new Set(['final', 'live', 'finalizing']);
const STUDENT_DATA_MONITORING_COVERAGE = new Set(['monitored', 'unattended', 'no_session']);
// Mirrors CLASSPILOT_ACTIVITY_KINDS / CLASSPILOT_ACTIVITY_LABELS in
// src/services/classpilotActivityAttribution.ts. Parity is enforced by
// tests/classpilot-activity-attribution.test.ts -- update both together.
const STUDENT_DATA_ACTIVITY_KINDS = new Set([
  'domain',
  'google_docs',
  'google_slides',
  'google_forms',
  'google_sheets',
  'google_classroom',
  'google_drive',
  'google_search',
  'google_mail',
  'google_meet',
  'google_workspace_unspecified',
]);
const STUDENT_DATA_ACTIVITY_LABELS = Object.freeze({
  google_docs: 'Google Docs',
  google_slides: 'Google Slides',
  google_forms: 'Google Forms',
  google_sheets: 'Google Sheets',
  google_classroom: 'Google Classroom',
  google_drive: 'Google Drive',
  google_search: 'Google Search',
  google_mail: 'Gmail',
  google_meet: 'Google Meet',
  google_workspace_unspecified: 'Google Workspace (app unavailable)',
});

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function domainName(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  try {
    const candidate = raw.includes('://') ? raw : `https://${raw}`;
    return new URL(candidate).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function normalizeDomains(value, maximumSeconds = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const entry = record(item);
      const domain = domainName(
        entry.domain ?? entry.normalizedDomain ?? entry.hostname ?? entry.name,
      );
      if (!domain) return null;
      const seconds = Math.min(
        nonnegativeInteger(
          entry.seconds
            ?? entry.boundedSeconds
            ?? entry.monitoredSeconds
            ?? entry.durationSeconds
            ?? entry.value,
        ),
        maximumSeconds,
      );
      return { domain, seconds };
    })
    .filter(Boolean)
    .sort((left, right) => right.seconds - left.seconds || left.domain.localeCompare(right.domain));
}

function legacyActivityKind(domain) {
  if (domain === 'docs.google.com') return 'google_workspace_unspecified';
  if (domain === 'slides.google.com') return 'google_slides';
  if (domain === 'forms.google.com') return 'google_forms';
  if (domain === 'sheets.google.com' || domain === 'spreadsheets.google.com') {
    return 'google_sheets';
  }
  if (domain === 'classroom.google.com') return 'google_classroom';
  if (domain === 'drive.google.com') return 'google_drive';
  if (domain === 'mail.google.com') return 'google_mail';
  if (domain === 'meet.google.com') return 'google_meet';
  // google.com stays 'domain': legacy rows carry no path, so Search cannot be
  // distinguished from Maps. Matches fallbackActivityKind on the server.
  return 'domain';
}

function normalizeActivity(value, maximumSeconds = Number.POSITIVE_INFINITY) {
  const entry = typeof value === 'string' ? { domain: value } : record(value);
  const domain = domainName(entry.domain ?? entry.normalizedDomain ?? entry.hostname);
  if (!domain) return null;
  const kind = STUDENT_DATA_ACTIVITY_KINDS.has(entry.kind) && entry.kind !== 'domain'
    ? entry.kind
    : legacyActivityKind(domain);
  const seconds = Math.min(
    nonnegativeInteger(
      entry.seconds
        ?? entry.boundedSeconds
        ?? entry.monitoredSeconds
        ?? entry.durationSeconds
        ?? entry.value,
    ),
    maximumSeconds,
  );
  return { kind, domain, seconds };
}

function normalizeActivities(value, maximumSeconds = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(value)) return [];
  const activities = value
    .map((item) => normalizeActivity(item, maximumSeconds))
    .filter(Boolean)
    .sort((left, right) => (
      right.seconds - left.seconds
        || left.kind.localeCompare(right.kind)
        || left.domain.localeCompare(right.domain)
    ));
  if (!Number.isFinite(maximumSeconds)) return activities;

  let remainingSeconds = maximumSeconds;
  return activities.flatMap((activity) => {
    if (remainingSeconds <= 0) return [];
    const seconds = Math.min(activity.seconds, remainingSeconds);
    remainingSeconds -= seconds;
    return seconds > 0 ? [{ ...activity, seconds }] : [];
  });
}

function activitiesFromDomains(domains, maximumSeconds = Number.POSITIVE_INFINITY) {
  return normalizeActivities(domains, maximumSeconds);
}

export function studentDataActivityLabel(value) {
  const activity = record(value);
  const domain = domainName(activity.domain);
  if (activity.kind === 'domain') return domain ?? 'Website';
  return STUDENT_DATA_ACTIVITY_LABELS[activity.kind] ?? domain ?? 'Website';
}

function studentIdentity(student) {
  const row = record(student);
  return {
    studentId: String(row.studentId ?? row.id ?? ''),
    name: String(
      row.studentName
        ?? row.name
        ?? [row.firstName, row.lastName].filter(Boolean).join(' ')
        ?? 'Unknown student',
    ).trim() || 'Unknown student',
  };
}

function normalizeStudentSummary(value, fallback = {}) {
  const row = { ...record(fallback), ...record(value) };
  const identity = studentIdentity(row);
  const monitoredSeconds = nonnegativeInteger(
    row.monitoredSeconds
      ?? row.totalSeconds
      ?? row.activeSeconds
      ?? row.durationSeconds
      ?? row.totalTime,
  );
  const domains = normalizeDomains(
    row.topDomains ?? row.domains ?? row.domainTotals,
    monitoredSeconds || Number.POSITIVE_INFINITY,
  );
  const maximumSeconds = monitoredSeconds || Number.POSITIVE_INFINITY;
  const fallbackActivities = activitiesFromDomains(domains, maximumSeconds);
  const activities = Array.isArray(row.activities)
    ? normalizeActivities(row.activities, maximumSeconds)
    : Array.isArray(row.topActivities)
      ? normalizeActivities(row.topActivities, maximumSeconds)
      : fallbackActivities;
  const topActivities = (Array.isArray(row.topActivities)
    ? normalizeActivities(row.topActivities, maximumSeconds)
    : Array.isArray(row.activities)
      ? normalizeActivities(row.activities, maximumSeconds)
      : fallbackActivities).slice(0, 10);
  const requestedTopActivity = normalizeActivity(row.topActivity, maximumSeconds);
  const topActivity = requestedTopActivity
    ? topActivities.find((activity) => (
        activity.kind === requestedTopActivity.kind
          && activity.domain === requestedTopActivity.domain
      )) ?? requestedTopActivity
    : topActivities[0] ?? null;
  const topDomain = domainName(
    record(row.topDomain).domain
      ?? record(row.topDomain).name
      ?? row.topDomain,
  ) ?? domains[0]?.domain ?? topActivity?.domain ?? null;
  const distinctActivityDomains = new Set(activities.map((activity) => activity.domain)).size;

  return {
    studentId: identity.studentId,
    name: identity.name,
    monitoredSeconds,
    siteCount: nonnegativeInteger(
      row.siteCount
        ?? row.totalSites
        ?? row.distinctDomains
        ?? (domains.length > 0 ? domains.length : distinctActivityDomains),
    ),
    topDomain,
    domains,
    topActivity,
    topActivities,
    activities,
  };
}

function sortedStudents(rows) {
  const lastName = (name) => String(name || '').trim().split(/\s+/).at(-1) || '';
  return rows.sort((left, right) => (
    lastName(left.name).localeCompare(lastName(right.name))
      || left.name.localeCompare(right.name)
      || left.studentId.localeCompare(right.studentId)
  ));
}

export class StudentDataContractError extends Error {
  constructor(message, code = 'STUDENT_DATA_CONTRACT_INVALID') {
    super(message);
    this.name = 'StudentDataContractError';
    this.code = code;
  }
}

function normalizedScope(value) {
  const raw = record(value);
  const kind = STUDENT_DATA_SCOPE_KINDS.has(raw.kind) ? raw.kind : null;
  const groupId = kind === 'class' && typeof raw.groupId === 'string' && raw.groupId.trim()
    ? raw.groupId.trim()
    : null;
  const expectedKey = kind === 'class' && groupId ? `class:${groupId}` : kind;
  if (!kind || !expectedKey || raw.key !== expectedKey) return null;
  const label = typeof raw.label === 'string' && raw.label.trim()
    ? raw.label.trim()
    : kind === 'school'
      ? 'Entire school'
      : kind === 'mine'
        ? 'My Classes'
        : 'Class';
  const activeTeachingSessionId = typeof raw.activeTeachingSessionId === 'string'
    && raw.activeTeachingSessionId.trim()
    ? raw.activeTeachingSessionId.trim()
    : null;

  return {
    key: expectedKey,
    kind,
    label,
    groupId,
    activeTeachingSessionId,
    isActive: raw.isActive === true,
  };
}

export function studentDataScopesQueryUrl() {
  return '/classpilot/student-data/scopes';
}

export function normalizeStudentDataScopesResponse(payload) {
  const envelope = record(payload);
  const root = Object.keys(record(envelope.data)).length > 0 ? record(envelope.data) : envelope;
  if (!Array.isArray(root.scopes)) {
    throw new StudentDataContractError(
      'The server returned an invalid Student Data scopes contract.',
      'STUDENT_DATA_SCOPES_REQUIRED',
    );
  }

  const scopesByKey = new Map();
  for (const rawScope of root.scopes) {
    const scope = normalizedScope(rawScope);
    if (scope && !scopesByKey.has(scope.key)) scopesByKey.set(scope.key, scope);
  }
  const scopes = [...scopesByKey.values()];
  const requestedDefault = typeof root.defaultScopeKey === 'string' ? root.defaultScopeKey : '';
  const defaultScopeKey = scopesByKey.has(requestedDefault)
    ? requestedDefault
    : scopes[0]?.key ?? null;

  return {
    schemaVersion: nonnegativeInteger(root.schemaVersion) || 1,
    defaultScopeKey,
    scopes,
  };
}

export function studentDataQueryUrl({
  period = 'today',
  scope = null,
  studentId = null,
  sessionId = null,
} = {}) {
  const normalizedPeriod = STUDENT_DATA_PERIODS.has(period) ? period : 'today';
  const params = new URLSearchParams({ period: normalizedPeriod });
  if (sessionId) params.set('sessionId', String(sessionId));
  if (!sessionId) {
    const authorizedScope = normalizedScope(scope);
    if (authorizedScope) {
      params.set('scope', authorizedScope.kind);
      if (authorizedScope.groupId) params.set('groupId', authorizedScope.groupId);
    }
  }
  if (studentId) params.set('studentId', String(studentId));
  return `/classpilot/student-data?${params.toString()}`;
}

export function normalizeStudentDataResponse(payload, {
  studentId = null,
  expectedScope = null,
  expectedPeriod = null,
} = {}) {
  const envelope = record(payload);
  const root = Object.keys(record(envelope.data)).length > 0 ? record(envelope.data) : envelope;
  const rawStudents = Array.isArray(root.students)
    ? root.students
    : Array.isArray(root.studentSummaries)
      ? root.studentSummaries
      : Array.isArray(root.rows)
        ? root.rows
        : Array.isArray(record(root.class).students)
          ? record(root.class).students
          : [];

  if (
    rawStudents.length === 0
    && !root.student
    && Array.isArray(root.heartbeats)
  ) {
    throw new StudentDataContractError(
      'The server returned raw heartbeats instead of an immutable aggregate.',
      'STUDENT_DATA_AGGREGATE_REQUIRED',
    );
  }

  if (
    studentId
    && rawStudents.some((rawStudent) => studentIdentity(rawStudent).studentId !== String(studentId))
  ) {
    throw new StudentDataContractError(
      'The server returned students outside the requested Student Data selector.',
      'STUDENT_DATA_STUDENT_MISMATCH',
    );
  }

  const aggregateById = new Map();
  for (const rawStudent of rawStudents) {
    const identity = studentIdentity(rawStudent);
    if (!identity.studentId) continue;
    aggregateById.set(
      identity.studentId,
      normalizeStudentSummary(rawStudent),
    );
  }

  const selectedRaw = root.student
    ? {
        ...record(root),
        ...record(root.student),
        topDomains: record(root.student).topDomains
          ?? record(root.student).domains
          ?? root.topDomains
          ?? root.domains,
        activities: record(root.student).activities
          ?? record(root.student).topActivities
          ?? root.activities
          ?? root.topActivities,
        topActivities: record(root.student).topActivities
          ?? record(root.student).activities
          ?? root.topActivities
          ?? root.activities,
        topActivity: record(root.student).topActivity ?? root.topActivity,
      }
    : aggregateById.get(String(studentId || ''));
  const selectedStudent = studentId && selectedRaw
    ? normalizeStudentSummary(selectedRaw)
    : null;
  if (studentId && selectedStudent && selectedStudent.studentId !== String(studentId)) {
    throw new StudentDataContractError(
      'The server returned a different student than the requested Student Data selector.',
      'STUDENT_DATA_STUDENT_MISMATCH',
    );
  }
  const totals = record(root.totals);
  const monitoredSeconds = nonnegativeInteger(
    root.monitoredSeconds ?? root.totalSeconds ?? totals.monitoredSeconds ?? totals.totalSeconds,
  );

  const responsePeriod = STUDENT_DATA_PERIODS.has(root.period) ? root.period : null;
  if (expectedPeriod && responsePeriod !== expectedPeriod) {
    throw new StudentDataContractError(
      'The server returned a different Student Data period than requested.',
      'STUDENT_DATA_PERIOD_MISMATCH',
    );
  }

  const scope = normalizedScope(root.scope);
  const requestedScope = normalizedScope(expectedScope);
  if (
    requestedScope
    && (
      !scope
      || scope.key !== requestedScope.key
      || scope.kind !== requestedScope.kind
      || scope.groupId !== requestedScope.groupId
    )
  ) {
    throw new StudentDataContractError(
      'The server returned a different Student Data scope than requested.',
      'STUDENT_DATA_SCOPE_MISMATCH',
    );
  }
  if (!STUDENT_DATA_STATES.has(root.dataState)) {
    throw new StudentDataContractError(
      'The server returned an invalid Student Data finalization state.',
      'STUDENT_DATA_STATE_REQUIRED',
    );
  }
  const dataState = root.dataState;
  const generatedAt = root.generatedAt ?? root.frozenAt ?? null;
  const maximumSeconds = monitoredSeconds || Number.POSITIVE_INFINITY;
  const topDomains = normalizeDomains(
    root.topDomains ?? root.domains ?? record(root.class).topDomains,
    maximumSeconds,
  ).slice(0, 10);
  const topActivities = (Array.isArray(root.topActivities)
    ? normalizeActivities(root.topActivities, maximumSeconds)
    : Array.isArray(root.activities)
      ? normalizeActivities(root.activities, maximumSeconds)
      : activitiesFromDomains(topDomains, maximumSeconds)).slice(0, 10);

  return {
    schemaVersion: nonnegativeInteger(root.schemaVersion) || 1,
    reportVersion: nonnegativeInteger(root.reportVersion ?? root.version) || 1,
    revision: root.revision ?? root.aggregateRevision ?? root.dataRevision ?? null,
    period: responsePeriod,
    generatedAt,
    scope,
    dataState,
    // Older servers omit this. Treat a missing value as 'monitored' so the UI
    // degrades to its previous wording rather than claiming a class was never
    // monitored on the strength of a field that simply is not there.
    monitoringCoverage: STUDENT_DATA_MONITORING_COVERAGE.has(root.monitoringCoverage)
      ? root.monitoringCoverage
      : 'monitored',
    asOf: root.asOf ?? generatedAt,
    provisionalAsOf: root.provisionalAsOf ?? null,
    monitoredSeconds,
    topDomains,
    topActivities,
    students: sortedStudents([...aggregateById.values()]),
    student: selectedStudent,
  };
}

export function isProvisionalStudentDataState(value) {
  return value === 'live' || value === 'finalizing';
}

export function studentDataStateLabel(value) {
  if (value === 'live') return 'Live';
  if (value === 'finalizing') return 'Finalizing';
  if (value === 'final') return 'Final';
  return 'Unknown';
}

/**
 * Badge text when monitoring coverage, not report settlement, is the thing the
 * reader needs to know. Returns null when the ordinary data-state label should
 * stand.
 *
 * 'Final' on an unattended class asserted that a zero was authoritative when
 * the code had never measured anything -- that is the wording this replaces.
 */
export function studentDataCoverageLabel(value) {
  if (value === 'unattended') return 'Unattended';
  if (value === 'no_session') return 'Not monitored';
  return null;
}

/**
 * Why the figures look the way they do, in the same words the session summary
 * email uses so the two surfaces agree.
 */
export function studentDataCoverageMessage(value) {
  if (value === 'unattended') {
    return 'No live ClassPilot session was opened for this class. Scheduled reporting '
      + 'remained active, so the times below are measured from student devices.';
  }
  if (value === 'no_session') {
    return 'This class was not monitored for this period — no session covered it.';
  }
  return 'No monitored activity was recorded for this scope and period.';
}

export function formatStudentDataSeconds(value) {
  const seconds = nonnegativeInteger(value);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function studentDataCsv(report, { period = 'today', studentId = null } = {}) {
  const normalized = record(report);
  const selected = studentId ? normalized.student : null;
  const rows = [
    ['Scope', record(normalized.scope).label ?? 'Unknown scope'],
    ['Scope key', record(normalized.scope).key ?? 'unknown'],
    ['Aggregate revision', normalized.revision ?? 'unversioned'],
    ['Period', period],
    ['Data state', studentDataStateLabel(normalized.dataState)],
    ['Monitoring coverage', normalized.monitoringCoverage],
    ['As of', normalized.asOf ?? 'unknown'],
    ['Provisional as of', normalized.provisionalAsOf ?? ''],
    [],
  ];

  if (selected) {
    rows.push(['Student', selected.name]);
    rows.push(['Monitored seconds', selected.monitoredSeconds]);
    rows.push(['Sites visited', selected.siteCount]);
    rows.push([]);
    rows.push(['Site or app', 'Domain', 'Bounded seconds']);
    const selectedActivities = Array.isArray(selected.activities)
      ? normalizeActivities(selected.activities, selected.monitoredSeconds || Number.POSITIVE_INFINITY)
      : Array.isArray(selected.topActivities)
        ? normalizeActivities(selected.topActivities, selected.monitoredSeconds || Number.POSITIVE_INFINITY)
        : activitiesFromDomains(selected.domains, selected.monitoredSeconds || Number.POSITIVE_INFINITY);
    for (const activity of selectedActivities) {
      rows.push([
        studentDataActivityLabel(activity),
        activity.domain,
        activity.seconds,
      ]);
    }
  } else {
    rows.push([
      'Student',
      'Monitored seconds',
      'Top site or app',
      'Domain',
      'Sites visited',
    ]);
    for (const student of normalized.students ?? []) {
      const topActivity = normalizeActivity(student.topActivity)
        ?? normalizeActivities(student.topActivities)[0]
        ?? normalizeActivity(student.topDomain);
      rows.push([
        student.name,
        student.monitoredSeconds,
        topActivity ? studentDataActivityLabel(topActivity) : '',
        topActivity?.domain ?? '',
        student.siteCount,
      ]);
    }
  }

  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
