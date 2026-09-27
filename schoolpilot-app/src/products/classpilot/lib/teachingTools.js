export const TEACHER_PREFERENCES_KEY = '/api/classpilot/teacher/preferences';
export const teacherPreferencesKey = (schoolId, viewerId) => [TEACHER_PREFERENCES_KEY, schoolId, viewerId];
export function teachingToolsSection(search) {
  const params = new URLSearchParams(search);
  const section = params.get('section') || params.get('tab');
  if (['classes', 'subgroups', 'co-teachers'].includes(section)) return 'classes';
  if (['defaults', 'classroom-controls'].includes(section)) return 'defaults';
  return 'websites';
}
export function teachingToolsShouldBlock({ kind, actionId, currentLocation, nextLocation }) {
  if (kind === 'action') return !actionId?.startsWith('teaching-close:') && !['teaching-class-switch', 'classroom-course-switch'].includes(actionId);
  if (!nextLocation || currentLocation.pathname !== nextLocation.pathname) return true;
  const current = new URLSearchParams(currentLocation.search), next = new URLSearchParams(nextLocation.search);
  for (const params of [current, next]) { params.delete('section'); params.delete('tab'); params.sort(); }
  return current.toString() !== next.toString();
}

// These families belong to Teaching tools and all end with school + viewer.
// Leave legacy unscoped Dashboard caches and unrelated product caches alone.
const teachingQueryLengths = new Map([[TEACHER_PREFERENCES_KEY, 3], ['/api/flight-paths', 3], ['/api/block-lists', 3], ['/api/teacher/groups', 3],
  ['/api/groups', 5], ['/api/subgroups', 5], ['/api/users/teachers', 4], ['/api/classroom/courses', 4], ['/api/classroom/resources', 4]]);
export function teachingToolsQuery(query) {
  const key = query.queryKey;
  return Array.isArray(key) && key.length === teachingQueryLengths.get(key[0]);
}

export function teacherTabLimitSeed(preferences, initialSchoolLimit) {
  const limit = preferences === undefined ? initialSchoolLimit : preferences?.effectiveMaxTabsPerStudent;
  return limit == null ? '' : String(limit);
}
