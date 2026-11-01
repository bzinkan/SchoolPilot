export const ADOPTION_HEALTH_API = '/admin/analytics/adoption-health';

const count = value => Number.isSafeInteger(value) && value >= 0;
const nullableCount = value => value === null || count(value);
const percentage = value => value === null || (Number.isFinite(value) && value >= 0 && value <= 100);
const states = value => value && ['completed', 'ready', 'preparing', 'failed', 'unavailable'].every(key => count(value[key]));

// An older/unavailable API must fail visibly, never become a healthy empty page.
export function requireAdoptionSection(value, section) {
  let valid = value?.basis === 'completed_sessions' && typeof value.period?.timeZone === 'string'
    && typeof value.period?.startLocalDate === 'string' && typeof value.period?.todayLocalDate === 'string'
    && value.range && typeof value.range.asOf === 'string';
  if (section === 'overview') valid &&= states(value.reportCounts) && Array.isArray(value.classes)
    && ['available', 'partial', 'unavailable', 'empty'].includes(value.dataState) && value.summary
    && ['totalClasses', 'totalStudents', 'teachersWithLiveSessions', 'completedSessions', 'readySummaries'].every(key => count(value.summary[key]))
    && ['classesWithObservations', 'studentsObserved'].every(key => nullableCount(value.summary[key]))
    && value.classes.every(row => typeof row.groupId === 'string' && count(row.sessionCount) && count(row.readySummaryCount) && nullableCount(row.daysWithObservations));
  else if (section === 'failures') valid &&= count(value.total) && count(value.page) && value.page > 0 && value.pageSize === 20 && Array.isArray(value.failures)
    && value.failures.every(row => typeof row.teachingSessionId === 'string' && typeof row.className === 'string' && count(row.attemptCount));
  else if (section === 'availability') valid &&= states(value.reportCounts) && percentage(value.coveragePercent)
    && ['summariesWithMissingObservations', 'notExpectedStudentRecords', 'unavailableStudentRecords'].every(key => count(value[key]))
    && Array.isArray(value.classes) && value.classes.every(row => typeof row.groupId === 'string' && percentage(row.coveragePercent) && count(row.summariesWithMissingObservations));
  else if (section === 'tools') valid &&= count(value.totalActions) && Array.isArray(value.tools)
    && value.tools.every(row => typeof row.commandType === 'string' && count(row.count));
  else if (section === 'clients') valid &&= count(value.totalClients) && Array.isArray(value.versions)
    && value.versions.every(row => (row.version === null || typeof row.version === 'string') && count(row.count));
  else valid = false;
  if (!valid) throw new Error('The reporting response is unavailable or incomplete.');
  return value;
}

export function displayCount(value) { return value === null || value === undefined ? '—' : value.toLocaleString(); }

export function formatAdoptionDate(value, timeZone = 'America/New_York') {
  if (!value) return '—';
  const localDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(localDate ? `${value}T12:00:00Z` : value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: localDate ? 'UTC' : timeZone }).format(date) : '—';
}

const TOOL_NAMES = {
  'open-tab': 'Open tabs', 'close-tabs': 'Close tabs', 'lock-screen': 'Lock screens', 'unlock-screen': 'Unlock screens',
  'teacher-message': 'Teacher messages', 'apply-flight-path': 'Apply Flight Paths', 'remove-flight-path': 'Remove Flight Paths',
  'apply-block-list': 'Apply block lists', 'remove-block-list': 'Remove block lists', 'attention-mode': 'Attention mode',
  timer: 'Timers', poll: 'Polls', 'student-sign-out': 'Student sign-outs', 'temp-unblock': 'Temporary website access', 'limit-tabs': 'Tab limits',
};
export function classroomToolName(type) { return TOOL_NAMES[type] || type.replaceAll('-', ' '); }
