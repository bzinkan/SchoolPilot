const admin = '/classpilot/admin';
const scheduling = `${admin}/scheduling`;

export const ADMIN_NAVIGATION = [
  { label: 'Overview', items: [{ id: 'overview', label: 'Overview', to: admin }] },
  { label: 'People & classes', items: [
    { id: 'staff', label: 'Staff accounts', to: `${admin}?tab=staff` },
    { id: 'students', label: 'Students', to: '/classpilot/students' },
    { id: 'classes', label: 'Classes', to: `${admin}/classes` },
  ] },
  { label: 'Calendar & schedules', items: [
    { id: 'school-year', label: 'School year', to: `${scheduling}?section=school-year` },
    { id: 'calendar', label: 'Calendar', to: `${scheduling}?section=calendar` },
    { id: 'bells', label: 'Bells & rotation', to: `${scheduling}?section=bells` },
    { id: 'profiles', label: 'Special schedules', to: `${scheduling}?section=profiles` },
    { id: 'schedule-changes', label: 'Schedule changes', to: `${admin}/classes/schedule-changes` },
  ] },
  { label: 'Discipline logs', items: [{ id: 'discipline', label: 'Discipline logs', to: '/classpilot/discipline-records?entry=admin' }] },
  { label: 'School operations', items: [
    { id: 'active-classes', label: 'Active classes', to: `${admin}?tab=active-classes` },
    { id: 'coverage', label: 'Coverage', to: '/classpilot/coverage?entry=admin' },
    { id: 'safety', label: 'Safety Center', to: `${admin}/safety` },
    { id: 'email', label: 'Email monitoring', to: `${admin}/email-monitoring`, emailOnly: true },
  ] },
  { label: 'Reports', items: [
    { id: 'analytics', label: 'Analytics', to: `${admin}/analytics` },
    { id: 'audit', label: 'Audit logs', to: `${admin}?tab=audit` },
  ] },
  { label: 'Settings', items: [
    { id: 'settings', label: 'School settings', to: '/classpilot/settings' },
    { id: 'student-portal', label: 'Student portal', to: `${admin}?tab=student-portal` },
    { id: 'it', label: 'Integrations & IT readiness', to: `${admin}/it-readiness` },
    { id: 'guide', label: 'Admin guide', to: '/classpilot/settings/guide' },
    { id: 'maintenance', label: 'Maintenance', to: `${admin}?tab=maintenance` },
  ] },
];

const tabs = new Set(['overview', 'staff', 'active-classes', 'audit', 'student-portal', 'maintenance']);
const sections = new Set(['school-year', 'calendar', 'bells', 'profiles']);
const isWithin = (path, root) => path === root || path.startsWith(`${root}/`);

export function adminRoute(location) {
  const { pathname, search } = location;
  const params = new URLSearchParams(search);
  let id;
  if (pathname === admin) id = tabs.has(params.get('tab')) ? params.get('tab') : 'overview';
  else if (pathname === scheduling || pathname === `${admin}/classes/scheduling`) id = sections.has(params.get('section')) ? params.get('section') : 'school-year';
  else if (pathname === `${admin}/classes/schedule-changes`) id = 'schedule-changes';
  else if (isWithin(pathname, `${admin}/classes`)) id = 'classes';
  else if (isWithin(pathname, '/classpilot/students')) id = 'students';
  else if (isWithin(pathname, '/classpilot/settings/guide')) id = 'guide';
  else if (pathname === '/classpilot/settings') id = 'settings';
  else if (isWithin(pathname, `${admin}/email-monitoring`)) id = 'email';
  else if (pathname === `${admin}/analytics`) id = 'analytics';
  else if (pathname === `${admin}/it-readiness`) id = 'it';
  else if (pathname === `${admin}/safety`) id = 'safety';
  else if (params.get('entry') === 'admin') {
    if (isWithin(pathname, '/classpilot/discipline-records')) id = 'discipline';
    else if (pathname === '/classpilot/coverage') id = 'coverage';
    else if (isWithin(pathname, '/classpilot/my-desk/student-information')) id = 'students';
    else if (isWithin(pathname, '/classpilot/my-desk/imports')) id = 'discipline';
  }
  const item = ADMIN_NAVIGATION.flatMap(group => group.items).find(row => row.id === id);
  if (!item) return null;
  const contacts = isWithin(pathname, '/classpilot/my-desk/student-information') || /^\/classpilot\/students\/[^/]+\/profile$/.test(pathname);
  const imports = isWithin(pathname, '/classpilot/my-desk/imports');
  return { ...item, title: contacts ? 'Student contacts' : imports ? 'Paperwork review' : item.label };
}

// Only fixed internal aliases are recognized; query values never become a URL.
export function adminLegacyDestination(location) {
  const params = new URLSearchParams(location.search);
  let pathname;
  if (location.pathname === `${admin}/classes/scheduling`) pathname = scheduling;
  else if (location.pathname === `${admin}/attendance`) pathname = admin;
  else if (location.pathname === admin && params.get('tab') === 'calendar') {
    pathname = scheduling; params.delete('tab'); params.set('section', 'calendar');
  } else if (location.pathname === admin && params.get('tab') === 'students') {
    pathname = '/classpilot/students'; params.delete('tab');
  }
  return pathname ? { pathname, search: params.size ? `?${params}` : '', hash: location.hash, state: location.state } : null;
}

export function adminNavigationTarget(item, location) {
  const target = new URL(item.to, 'https://navigation.invalid');
  if (target.pathname === scheduling && [scheduling, `${admin}/classes/scheduling`].includes(location.pathname)) {
    const params = new URLSearchParams(location.search);
    params.set('section', target.searchParams.get('section'));
    return { pathname: scheduling, search: `?${params}`, hash: location.hash, state: location.state };
  }
  return { pathname: target.pathname, search: target.search, hash: target.hash, state: null };
}

// Legacy admin queries predate school/viewer keys. Cancel and remove precisely
// these families before mounting a new admin identity; Auth/my-desk caches are
// owned by their existing boundaries, never by this shell.
const LEGACY_ADMIN_KEYS = new Set([
  '/api/admin/teachers', '/api/admin/teacher-students', '/api/admin/users',
  '/api/users/staff', '/api/admin/audit-logs', '/api/sessions/all', '/api/teacher/groups',
  '/api/admin/analytics/summary', '/api/admin/analytics/by-teacher', '/api/admin/analytics/by-group',
  '/api/settings', '/api/flight-paths', '/api/classpilot/enrollment-key', '/api/classpilot/it-readiness',
  '/api/classpilot/admin/sso-policy', '/google/roster-connector',
  '/api/classroom/courses', '/api/classroom/resources', '/api/directory/users', '/api/directory/orgunits',
  '/api/mailpilot/setup/info', '/api/mailpilot/alerts', '/api/mailpilot/alerts/stats',
  'classpilot-admin-classes', 'admin-class-students', 'classpilot-admin-classes-classroom-preview',
  'classpilot-school-scheduling', 'classpilot-schedule-profiles', 'classpilot-school-calendar',
  'classpilot-safety-center',
  'roster-candidates', 'roster-run', 'roster-run-rows', 'roster-class-candidates', 'roster-run-history', 'roster-named-review',
]);
export function legacyAdminQuery(query) {
  return LEGACY_ADMIN_KEYS.has(query.queryKey?.[0])
    || (query.queryKey?.[0] === 'instructional-calendar' && query.queryKey[1] === '/classpilot/admin/instructional-calendar');
}

export function adminIdentityKey(user, membership, schoolId) {
  return JSON.stringify([schoolId || membership?.schoolId || null, user?.id || null,
    [...(membership?.roles || [membership?.primaryRole || membership?.role || ''])].sort(),
    membership?.status || '', user?.isSuperAdmin === true, user?.impersonating === true,
    membership?.mailpilotEntitled === true, membership?.classpilotEmailMonitoring === true]);
}
