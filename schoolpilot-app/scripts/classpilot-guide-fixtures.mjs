import { schoolSettingsFixture } from './school-settings-fixture.mjs';

export const SCHOOL_ID = 'guide-school';
export function authResponse({ role = 'teacher', roles = [role], mailpilot = false, superAdmin = false } = {}) {
  return {
    user: { id: 'guide-user', email: 'guide@example.test', firstName: 'Guide', lastName: 'Tester', isSuperAdmin: superAdmin },
    token: 'guide-fixture-token', activeSchoolId: SCHOOL_ID, schoolSelectionRequired: false,
    licenses: { classPilot: true },
    memberships: [{ id: 'guide-membership', schoolId: SCHOOL_ID, schoolName: 'Flight Plan Academy',
      schoolTimezone: 'America/New_York', status: 'active', role, primaryRole: role, roles,
      mailpilotEntitled: mailpilot, classpilotEmailMonitoring: mailpilot }],
  };
}

const scheduling = () => ({ revision: 1, schoolTimezone: 'America/New_York', schoolLocalToday: '2026-11-18',
  config: { schemaVersion: 1, yearStart: '2026-08-24', yearEnd: '2027-06-11', cycleAnchorDate: null,
    cycleAnchorDay: 'A', periods: [], profiles: [], defaultProfileId: null, weekdayProfiles: {}, dateOverrides: {}, scheduleProfiles: [], profileApplications: [] } });

function usageReport(url) {
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  const requestedDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return { schemaVersion: 1, dataState: 'final', scope: { type: 'school', label: 'Entire school' },
    range: { from, to, today: to, timeZone: 'America/New_York', retainedFrom: from, requestedDays, computedDays: requestedDays,
      unavailableDates: [], partiallyComputed: false, partiallyExpired: false },
    totals: { monitoredBrowserSeconds: 0, instructionalSeconds: 0, offTaskSeconds: 0, unknownSeconds: 0, activeMonitoredStudents: 0 },
    byDay: [{ date: to, state: 'final', monitoredBrowserSeconds: 0, instructionalSeconds: 0, offTaskSeconds: 0, unknownSeconds: 0, activeMonitoredStudents: 0 }],
    topEducationalDomains: [], topNonEducationalDomains: [], computedAt: '2026-11-18T20:00:00Z', generatedAt: '2026-11-18T20:00:00Z' };
}

// These are successful, intentionally empty read contracts, not a catch-all {}.
// Adding a destination that reads another API requires adding its actual shape.
export function apiFixture(url, identity) {
  const now = new Date().toISOString();
  const schoolDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  switch (url.pathname) {
    case '/api/auth/me': return authResponse(identity);
    case '/api/auth/csrf': return { csrfToken: 'guide-fixture-csrf' };
    case '/api/settings': return { schoolName: 'Flight Plan Academy', schoolTimezone: 'America/New_York',
      retentionDays: 30, gradeLevels: ['6'], scheduledClassEnabled: false, enableTrackingHours: false };
    case '/api/classpilot/admin/settings': return schoolSettingsFixture(null, SCHOOL_ID);
    case '/api/classpilot/apps': return { apps: [], canManageSchoolApps: identity.role !== 'teacher' };
    case '/api/flight-paths': return { flightPaths: [], library: [], features: { sharedTeachingResources: false, preciseRestrictionResources: false, studentClassroomAccess: false } };
    case '/api/block-lists': return { blockLists: [], library: [], features: { sharedTeachingResources: false } };
    case '/api/teacher/groups':
    case '/api/sessions/all': return [];
    case '/api/sessions/active': return { sessions: [], scheduledClassEnabled: false, activeSession: null };
    case '/api/admin/attendance': return { records: [] };
    case '/api/classpilot/school-day-status': return { schoolLocalDate: schoolDate, schoolTimezone: 'America/New_York',
      evaluatedAt: now, validUntil: new Date(Date.now() + 3_600_000).toISOString(), calendarClosed: false, classpilotInstructionalOverride: null };
    case '/api/classpilot/dashboard-activity': return { enabled: false, schoolId: SCHOOL_ID, viewerId: 'guide-user',
      revision: 'guide-disabled-v1', serverTime: now, current: null, activities: [], next: null, nextBoundaryAt: null };
    case '/api/classpilot/groups/manual-today': return { schoolDate, timezone: 'America/New_York',
      resumesOn: schoolDate, resumesAt: new Date(Date.now() + 3_600_000).toISOString(), canManageManualToday: false, teacherManualTodayAllowed: false, classes: [] };
    case '/api/students-aggregated': return { students: [] };
    case '/api/classpilot/teacher/preferences': return { schoolId: SCHOOL_ID, revision: 1, maxTabsPerStudent: null,
      schoolMaxTabsPerStudent: null, effectiveMaxTabsPerStudent: null, dashboardTheme: null, effectiveDashboardTheme: null,
      dashboardThemeAssets: [], dashboardThemesEnabled: identity.themes !== false, dashboardThemeUploadsEnabled: false,
      dashboardThemeLocked: false, schoolCalendar: { autoCalendar: false, holidays: [], leadDays: 10, starts: {} } };
    case '/api/classpilot/today-schedule': return { enabled: false, schoolDate: '2026-11-18', timeZone: 'America/New_York', canRequest: false, classes: [], changes: [] };
    case '/api/classpilot/teaching-sessions/recent': return { sessions: [] };
    case '/api/classpilot/observable-activities': return { activities: [] };
    case '/api/coverage/capabilities': return { canManageSupervisionSetup: identity.role !== 'teacher', commandTypes: [] };
    case '/api/coverage/summary': return { schoolId: SCHOOL_ID, viewerId: 'guide-user', activeContextCount: 0,
      availableStudentCount: 0, claimedStudentCount: 0, ownTestingContexts: [] };
    case '/api/coverage/available-students':
    case '/api/coverage/claimed-students':
    case '/api/coverage/setup/students': return { students: [] };
    case '/api/coverage/contexts': return { contexts: [] };
    case '/api/coverage/scheduled': return { date: '2026-11-18', timeZone: 'America/New_York', items: [] };
    case '/api/coverage/setup/staff': return { staff: [] };
    case '/api/coverage/setup/classes': return { classes: [] };
    case '/api/coverage/assignments': return { assignments: [] };
    case '/api/coverage/supervision-groups': return { groups: [] };
    case '/api/coverage/supervision-groups/browse': return { groups: [], total: 0, page: 1, totalPages: 1, facets: { categories: [], grades: [], staff: [] } };
    case '/api/admin/users': return { users: [] };
    case '/api/users/staff': return { staff: [] };
    case '/api/admin/teachers': return { teachers: [] };
    case '/api/admin/teacher-students': return { students: [] };
    case '/api/admin/audit-logs': return { logs: [], total: 0, page: 1, totalPages: 1 };
    case '/api/classpilot/admin/classes': return { classes: [] };
    case '/api/classroom/courses': return { courses: [] };
    case '/api/classpilot/roster/students': return { students: [], pageInfo: { limit: 100, hasNextPage: false, nextCursor: null } };
    case '/api/devices': return { devices: [] };
    case '/api/classpilot/admin/scheduling': return scheduling();
    case '/api/classpilot/admin/schedule-profiles': return { revision: 1, schoolTimezone: 'America/New_York', schoolLocalToday: '2026-11-18',
      profiles: [], applications: [], classes: [], staff: [], supervisionGroups: [], testingStatuses: [] };
    case '/api/classpilot/admin/instructional-calendar': return { month: url.searchParams.get('month'), revision: 1,
      schoolTimezone: 'America/New_York', schoolLocalToday: '2026-11-18', nonInstructionalDates: [], updatedAt: null };
    case '/api/classpilot/schedule-changes/settings': return { settings: { revision: 1, teacherRequestsEnabled: false,
      adminApprovalRequired: true, sameDayCutoffEnforced: true, sameDayCutoff: '07:00', reasonRequired: true, schoolTimezone: 'America/New_York' } };
    case '/api/classpilot/schedule-changes/pairs': return { pairs: [] };
    case '/api/classpilot/schedule-changes':
    case '/api/classpilot/schedule-changes/today': return { changes: [] };
    case '/api/classpilot/admin/sso-policy': return { revision: 1, policyValid: true, operatorGateActive: false,
      requiredCapability: 'restrictionPortalFirstV1', conflicts: [], extensionReadiness: { capability: 'restrictionPortalFirstV1',
        observationWindowSeconds: 300, recentlyActiveBindings: 0, observedBindings: 0, readyBindings: 0 },
      policy: { schemaVersion: 1, enabled: false, defaultProfileId: null, attemptTtlSeconds: 300, profiles: [] } };
    case '/api/classpilot/it-readiness': return { summary: { pass: 1, warn: 0, fail: 0, students: 0, devices: 0, connectedDevices: 0 }, issues: [] };
    case '/api/classpilot/monitoring-interruptions': return { scanStatus: 'healthy', asOf: now, lastScannedAt: now, counts: { open: 0, last24Hours: 0 } };
    case '/api/classpilot/monitoring-interruptions/settings': return { digestEnabled: false, revision: 1 };
    case '/api/classpilot/enrollment-key': return { schoolId: SCHOOL_ID, schoolSlug: 'flight-plan-academy', key: 'synthetic-guide-setup-key' };
    case '/api/google/roster-connector/setup-info': return { serviceAccount: { configured: true }, connector: { status: 'verified' },
      schoolDomain: 'example.test', scopes: ['roster.readonly'], scopesCsv: 'roster.readonly', serviceAccountClientId: 'guide-client-id' };
    case '/api/google/roster-connector/classroom-access/setup-info': return { purpose: 'student_classroom_access', available: true, enabled: false,
      schoolDomain: 'example.test', serviceAccountClientId: 'guide-client-id', scopes: ['roster.readonly', 'classroom.readonly'],
      scopesCsv: 'roster.readonly,classroom.readonly', verificationStudents: [], setupCopy: { description: 'Read-only classroom content.', revocation: 'Disable separately.' } };
    case '/api/classpilot/safety-center/cases': return { items: [], nextCursor: null, timeZone: 'America/New_York' };
    case '/api/mailpilot/setup/info': return { enabled: false, configured: true };
    case '/api/classpilot/admin/usage': return usageReport(url);
    case '/api/admin/analytics/adoption-health/overview': return { basis: 'completed_sessions', dataState: 'empty',
      period: { timeZone: 'America/New_York', startLocalDate: '2026-11-12', todayLocalDate: '2026-11-18' }, range: { asOf: now, partiallyRetained: false },
      reportCounts: { completed: 0, ready: 0, preparing: 0, failed: 0, unavailable: 0 }, classes: [], summary: { totalClasses: 0,
        totalStudents: 0, teachersWithLiveSessions: 0, completedSessions: 0, readySummaries: 0, classesWithObservations: 0, studentsObserved: 0 } };
    case '/api/admin/analytics/adoption-health/failures': return { basis: 'completed_sessions',
      period: { timeZone: 'America/New_York', startLocalDate: '2026-11-12', todayLocalDate: '2026-11-18' }, range: { asOf: now },
      failures: [], total: 0, page: 1, pageSize: 20 };
    default: return undefined;
  }
}
