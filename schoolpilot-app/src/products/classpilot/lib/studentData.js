const STUDENT_DATA_PERIODS = new Set(['today', 'week', 'month', 'year']);

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
    return new URL(candidate).hostname.toLowerCase() || null;
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

function rosterIdentity(student) {
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
  const identity = rosterIdentity(row);
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
  const topDomain = domainName(
    record(row.topDomain).domain
      ?? record(row.topDomain).name
      ?? row.topDomain,
  ) ?? domains[0]?.domain ?? null;

  return {
    studentId: identity.studentId,
    name: identity.name,
    monitoredSeconds,
    siteCount: nonnegativeInteger(row.siteCount ?? row.totalSites ?? row.distinctDomains ?? domains.length),
    topDomain,
    domains,
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

export function studentDataQueryUrl({ period = 'today', studentId = null, sessionId = null } = {}) {
  const normalizedPeriod = STUDENT_DATA_PERIODS.has(period) ? period : 'today';
  const params = new URLSearchParams({ period: normalizedPeriod });
  if (sessionId) params.set('sessionId', String(sessionId));
  if (studentId) params.set('studentId', String(studentId));
  return `/student-data?${params.toString()}`;
}

export function normalizeStudentDataResponse(payload, { rosterStudents = [], studentId = null } = {}) {
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

  const rosterById = new Map(
    rosterStudents
      .map(rosterIdentity)
      .filter((student) => student.studentId)
      .map((student) => [student.studentId, student]),
  );
  const aggregateById = new Map();
  for (const rawStudent of rawStudents) {
    const identity = rosterIdentity(rawStudent);
    if (!identity.studentId) continue;
    aggregateById.set(
      identity.studentId,
      normalizeStudentSummary(rawStudent, rosterById.get(identity.studentId)),
    );
  }

  if (!studentId) {
    for (const [id, rosterStudent] of rosterById) {
      if (!aggregateById.has(id)) {
        aggregateById.set(id, normalizeStudentSummary(rosterStudent));
      }
    }
  }

  const selectedRaw = root.student
    ? {
        ...record(root),
        ...record(root.student),
        topDomains: record(root.student).topDomains
          ?? record(root.student).domains
          ?? root.topDomains
          ?? root.domains,
      }
    : aggregateById.get(String(studentId || ''));
  const selectedStudent = studentId && selectedRaw
    ? normalizeStudentSummary(selectedRaw, rosterById.get(String(studentId)))
    : null;
  const totals = record(root.totals);
  const monitoredSeconds = nonnegativeInteger(
    root.monitoredSeconds ?? root.totalSeconds ?? totals.monitoredSeconds ?? totals.totalSeconds,
  );

  return {
    reportVersion: nonnegativeInteger(root.reportVersion ?? root.version) || 1,
    revision: root.revision ?? root.aggregateRevision ?? root.dataRevision ?? null,
    period: STUDENT_DATA_PERIODS.has(root.period) ? root.period : null,
    generatedAt: root.generatedAt ?? root.frozenAt ?? null,
    monitoredSeconds,
    topDomains: normalizeDomains(
      root.topDomains ?? root.domains ?? record(root.class).topDomains,
      monitoredSeconds || Number.POSITIVE_INFINITY,
    ).slice(0, 10),
    students: sortedStudents([...aggregateById.values()]),
    student: selectedStudent,
  };
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
    ['Aggregate revision', normalized.revision ?? 'unversioned'],
    ['Period', period],
    [],
  ];

  if (selected) {
    rows.push(['Student', selected.name]);
    rows.push(['Monitored seconds', selected.monitoredSeconds]);
    rows.push(['Sites visited', selected.siteCount]);
    rows.push([]);
    rows.push(['Domain', 'Bounded seconds']);
    for (const domain of selected.domains) rows.push([domain.domain, domain.seconds]);
  } else {
    rows.push(['Student', 'Monitored seconds', 'Top domain', 'Sites visited']);
    for (const student of normalized.students ?? []) {
      rows.push([student.name, student.monitoredSeconds, student.topDomain ?? '', student.siteCount]);
    }
  }

  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
