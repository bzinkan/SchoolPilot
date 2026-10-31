import { apiRequest, queryClient } from '../../../lib/queryClient';

export const TODAY_SCHEDULE_QUERY = '/api/classpilot/today-schedule';
export const TODAY_CHANGE_QUERY = '/api/classpilot/today-schedule/change';
export const todayScheduleKey = (schoolId, viewerId, scope) => [TODAY_SCHEDULE_QUERY, schoolId, viewerId, scope];
export const todayChangeKey = (schoolId, viewerId, scope, id) => [TODAY_CHANGE_QUERY, schoolId, viewerId, scope, id];

export function todayScheduleRequest(schoolId, method, path = '', body, signal) {
  return apiRequest(method, `/classpilot/today-schedule${path}`, body, { signal, headers: { 'X-School-Id': schoolId } });
}

export function refreshTodaySchedule() {
  for (const key of [TODAY_SCHEDULE_QUERY, TODAY_CHANGE_QUERY, '/api/classpilot/groups/manual-today', '/api/sessions/active', '/api/groups', '/api/teacher/groups',
    '/api/classpilot/dashboard-activity', '/api/classpilot/observable-activities', '/api/students-aggregated', 'classpilot-schedule-changes']) {
    void queryClient.invalidateQueries({ queryKey: [key], exact: false });
  }
}

export function todayTime(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
}

export function todayWindow(window, timeZone) {
  return `${todayTime(window.startsAt, timeZone)}–${todayTime(window.endsAt, timeZone)}`;
}
