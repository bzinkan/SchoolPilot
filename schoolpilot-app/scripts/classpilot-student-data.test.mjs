import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isProvisionalStudentDataState,
  normalizeStudentDataResponse,
  normalizeStudentDataScopesResponse,
  StudentDataContractError,
  studentDataActivityLabel,
  studentDataCsv,
  studentDataQueryUrl,
  studentDataScopesQueryUrl,
  studentDataStateLabel,
} from '../src/products/classpilot/lib/studentData.js';

const ACTIVE_CLASS_SCOPE = Object.freeze({
  key: 'class:group-1',
  kind: 'class',
  label: 'Grade 5 Math',
  groupId: 'group-1',
  activeTeachingSessionId: 'session-1',
  isActive: true,
});

test('authorized scopes normalize strictly and preserve the server default', () => {
  const result = normalizeStudentDataScopesResponse({
    schemaVersion: 1,
    defaultScopeKey: 'class:group-1',
    scopes: [
      { key: 'mine', kind: 'mine', label: 'My Classes', groupId: null, isActive: false },
      ACTIVE_CLASS_SCOPE,
      ACTIVE_CLASS_SCOPE,
      { key: 'class:foreign', kind: 'class', label: 'Malformed', groupId: null },
    ],
  });

  assert.equal(result.defaultScopeKey, 'class:group-1');
  assert.deepEqual(result.scopes, [
    {
      key: 'mine',
      kind: 'mine',
      label: 'My Classes',
      groupId: null,
      activeTeachingSessionId: null,
      isActive: false,
    },
    ACTIVE_CLASS_SCOPE,
  ]);
  assert.throws(
    () => normalizeStudentDataScopesResponse({ data: {} }),
    (error) => error instanceof StudentDataContractError
      && error.code === 'STUDENT_DATA_SCOPES_REQUIRED',
  );
});

test('aggregate Student Data adapter prefers v2 activities, bounds seconds, and strips private URL data', () => {
  const report = normalizeStudentDataResponse({
    schemaVersion: 2,
    reportVersion: 2,
    revision: 'aggregate-42',
    period: 'week',
    scope: ACTIVE_CLASS_SCOPE,
    dataState: 'live',
    asOf: '2026-08-28T12:00:00.000Z',
    provisionalAsOf: '2026-08-28T12:00:00.000Z',
    monitoredSeconds: 60,
    topDomains: [
      { domain: 'https://Example.com/private?q=student', seconds: 120 },
    ],
    topActivities: [
      {
        kind: 'google_docs',
        domain: 'https://docs.google.com/document/d/private-id?student=ada',
        seconds: 120,
        title: 'Private document title',
        visits: 12,
      },
      { kind: 'google_drive', domain: 'drive.google.com', seconds: 40 },
    ],
    students: [{
      studentId: 'student-1',
      name: 'Ada Student',
      monitoredSeconds: 100,
      topDomains: [{ normalizedDomain: 'docs.example.org/path', boundedSeconds: 200 }],
      activities: [{
        kind: 'google_slides',
        domain: 'https://docs.google.com/presentation/d/private-id',
        boundedSeconds: 200,
        path: '/presentation/d/private-id',
      }],
      topActivities: [{
        kind: 'google_slides',
        domain: 'docs.google.com',
        seconds: 100,
      }],
      topActivity: {
        kind: 'google_slides',
        domain: 'docs.google.com',
        seconds: 100,
      },
    }],
  }, { expectedScope: ACTIVE_CLASS_SCOPE, expectedPeriod: 'week' });

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.revision, 'aggregate-42');
  assert.equal(report.scope.label, 'Grade 5 Math');
  assert.equal(report.dataState, 'live');
  assert.equal(report.asOf, '2026-08-28T12:00:00.000Z');
  assert.deepEqual(report.topDomains, [{ domain: 'example.com', seconds: 60 }]);
  assert.deepEqual(report.topActivities, [{
    kind: 'google_docs',
    domain: 'docs.google.com',
    seconds: 60,
  }]);
  assert.deepEqual(report.students[0].domains, [{ domain: 'docs.example.org', seconds: 100 }]);
  assert.deepEqual(report.students[0].activities, [{
    kind: 'google_slides',
    domain: 'docs.google.com',
    seconds: 100,
  }]);
  assert.deepEqual(report.students[0].topActivity, {
    kind: 'google_slides',
    domain: 'docs.google.com',
    seconds: 100,
  });
  assert.deepEqual(report.students.map((student) => student.studentId), ['student-1']);
  assert.doesNotMatch(JSON.stringify(report), /private-id|Private document title|student=ada/);
});

test('v1 domain rows remain compatible and identify only unambiguous Google apps', () => {
  const report = normalizeStudentDataResponse({
    schemaVersion: 1,
    period: 'today',
    scope: ACTIVE_CLASS_SCOPE,
    dataState: 'final',
    monitoredSeconds: 90,
    topDomains: [
      { domain: 'docs.google.com', seconds: 50 },
      { domain: 'classroom.google.com', seconds: 30 },
      { domain: 'example.org', seconds: 10 },
    ],
    students: [{
      studentId: 'student-1',
      name: 'Ada Student',
      monitoredSeconds: 90,
      siteCount: 3,
      topDomains: [
        { domain: 'docs.google.com', seconds: 50 },
        { domain: 'drive.google.com', seconds: 30 },
        { domain: 'example.org', seconds: 10 },
      ],
    }],
  }, { expectedScope: ACTIVE_CLASS_SCOPE, expectedPeriod: 'today' });

  assert.deepEqual(report.topActivities.map(({ kind, domain }) => ({ kind, domain })), [
    { kind: 'google_workspace_unspecified', domain: 'docs.google.com' },
    { kind: 'google_classroom', domain: 'classroom.google.com' },
    { kind: 'domain', domain: 'example.org' },
  ]);
  assert.deepEqual(report.students[0].activities.map(({ kind, domain }) => ({ kind, domain })), [
    { kind: 'google_workspace_unspecified', domain: 'docs.google.com' },
    { kind: 'google_drive', domain: 'drive.google.com' },
    { kind: 'domain', domain: 'example.org' },
  ]);
  assert.equal(report.students[0].siteCount, 3);
});

test('activity labels are fixed for Google apps and use normalized hostnames for websites', () => {
  const expectedLabels = new Map([
    ['google_docs', 'Google Docs'],
    ['google_slides', 'Google Slides'],
    ['google_forms', 'Google Forms'],
    ['google_sheets', 'Google Sheets'],
    ['google_classroom', 'Google Classroom'],
    ['google_drive', 'Google Drive'],
    ['google_workspace_unspecified', 'Google Workspace (app unavailable)'],
  ]);
  for (const [kind, expected] of expectedLabels) {
    assert.equal(studentDataActivityLabel({ kind, domain: 'docs.google.com' }), expected);
  }
  assert.equal(
    studentDataActivityLabel({ kind: 'domain', domain: 'https://www.Example.org/private' }),
    'example.org',
  );
});

test('v1 Google host aliases normalize to their unambiguous app kinds', () => {
  const domains = [
    ['slides.google.com', 'google_slides'],
    ['forms.google.com', 'google_forms'],
    ['sheets.google.com', 'google_sheets'],
    ['spreadsheets.google.com', 'google_sheets'],
    ['classroom.google.com', 'google_classroom'],
    ['drive.google.com', 'google_drive'],
  ];
  const report = normalizeStudentDataResponse({
    period: 'today',
    scope: ACTIVE_CLASS_SCOPE,
    dataState: 'final',
    monitoredSeconds: domains.length * 10,
    topDomains: domains.map(([domain]) => ({ domain, seconds: 10 })),
    students: [],
  }, { expectedScope: ACTIVE_CLASS_SCOPE, expectedPeriod: 'today' });
  const kindsByDomain = new Map(
    report.topActivities.map((activity) => [activity.domain, activity.kind]),
  );

  for (const [domain, expectedKind] of domains) {
    assert.equal(kindsByDomain.get(domain), expectedKind);
  }
});

test('aggregate adapter rejects stale scope, period, and student responses', () => {
  assert.throws(
    () => normalizeStudentDataResponse({
      period: 'week',
      scope: ACTIVE_CLASS_SCOPE,
      dataState: 'almost-final',
      students: [],
    }, { expectedScope: ACTIVE_CLASS_SCOPE, expectedPeriod: 'week' }),
    (error) => error instanceof StudentDataContractError
      && error.code === 'STUDENT_DATA_STATE_REQUIRED',
  );
  assert.throws(
    () => normalizeStudentDataResponse({
      period: 'month',
      scope: ACTIVE_CLASS_SCOPE,
      students: [],
    }, { expectedScope: ACTIVE_CLASS_SCOPE, expectedPeriod: 'week' }),
    (error) => error instanceof StudentDataContractError
      && error.code === 'STUDENT_DATA_PERIOD_MISMATCH',
  );
  assert.throws(
    () => normalizeStudentDataResponse({
      scope: { key: 'mine', kind: 'mine', label: 'My Classes', groupId: null },
      students: [],
    }, { expectedScope: ACTIVE_CLASS_SCOPE }),
    (error) => error instanceof StudentDataContractError
      && error.code === 'STUDENT_DATA_SCOPE_MISMATCH',
  );
  assert.throws(
    () => normalizeStudentDataResponse({
      scope: ACTIVE_CLASS_SCOPE,
      students: [{ studentId: 'student-2', name: 'Wrong Student' }],
      student: { studentId: 'student-2', name: 'Wrong Student' },
    }, { expectedScope: ACTIVE_CLASS_SCOPE, studentId: 'student-1' }),
    (error) => error instanceof StudentDataContractError
      && error.code === 'STUDENT_DATA_STUDENT_MISMATCH',
  );
});

test('raw heartbeat responses fail closed instead of rebuilding inaccurate client aggregates', () => {
  assert.throws(
    () => normalizeStudentDataResponse({ heartbeats: [{ activeTabUrl: 'https://example.com' }] }),
    (error) => error instanceof StudentDataContractError
      && error.code === 'STUDENT_DATA_AGGREGATE_REQUIRED',
  );
});

test('canonical query carries one authorized scope and session scope still takes precedence', () => {
  assert.equal(studentDataScopesQueryUrl(), '/classpilot/student-data/scopes');
  assert.equal(
    studentDataQueryUrl({ period: 'month', scope: ACTIVE_CLASS_SCOPE, studentId: 'student 1' }),
    '/classpilot/student-data?period=month&scope=class&groupId=group-1&studentId=student+1',
  );
  assert.equal(
    studentDataQueryUrl({
      period: 'month',
      scope: ACTIVE_CLASS_SCOPE,
      studentId: 'student 1',
      sessionId: 'session/1',
    }),
    '/classpilot/student-data?period=month&sessionId=session%2F1&studentId=student+1',
  );
});

test('CSV exports scope, freshness, period, revision, and formula-safe rows', () => {
  const csv = studentDataCsv({
    revision: 'revision-7',
    scope: ACTIVE_CLASS_SCOPE,
    dataState: 'finalizing',
    asOf: '2026-08-28T12:00:00.000Z',
    provisionalAsOf: '2026-08-28T11:59:50.000Z',
    students: [{
      studentId: 'student-1',
      name: '=Formula Student',
      monitoredSeconds: 30,
      topDomain: 'example.org',
      topActivity: { kind: 'google_forms', domain: 'docs.google.com', seconds: 30 },
      siteCount: 1,
    }],
  }, { period: 'today' });

  assert.match(csv, /"Scope","Grade 5 Math"/);
  assert.match(csv, /"Scope key","class:group-1"/);
  assert.match(csv, /"Aggregate revision","revision-7"/);
  assert.match(csv, /"Period","today"/);
  assert.match(csv, /"Data state","Finalizing"/);
  assert.match(csv, /"As of","2026-08-28T12:00:00.000Z"/);
  assert.match(csv, /"Provisional as of","2026-08-28T11:59:50.000Z"/);
  assert.match(csv, /"'=Formula Student"/);
  assert.match(csv, /"Top site or app","Domain","Sites visited"/);
  assert.match(csv, /"Google Forms","docs.google.com","1"/);
});

test('selected-student CSV separates safe app labels from hostnames', () => {
  const csv = studentDataCsv({
    revision: 'revision-8',
    scope: ACTIVE_CLASS_SCOPE,
    dataState: 'final',
    asOf: '2026-08-28T12:00:00.000Z',
    student: {
      studentId: 'student-1',
      name: 'Ada Student',
      monitoredSeconds: 40,
      siteCount: 1,
      activities: [{
        kind: 'google_forms',
        domain: 'https://docs.google.com/forms/d/private-form-id',
        seconds: 40,
        title: 'Private form title',
      }],
    },
  }, { period: 'today', studentId: 'student-1' });

  assert.match(csv, /"Site or app","Domain","Bounded seconds"/);
  assert.match(csv, /"Google Forms","docs.google.com","40"/);
  assert.doesNotMatch(csv, /private-form-id|Private form title/);
});

test('freshness helpers distinguish provisional polling states from final data', () => {
  assert.equal(isProvisionalStudentDataState('live'), true);
  assert.equal(isProvisionalStudentDataState('finalizing'), true);
  assert.equal(isProvisionalStudentDataState('final'), false);
  assert.equal(studentDataStateLabel('live'), 'Live');
  assert.equal(studentDataStateLabel('finalizing'), 'Finalizing');
  assert.equal(studentDataStateLabel('final'), 'Final');
  assert.equal(studentDataStateLabel('invalid'), 'Unknown');
});

test('Student Data UI is lazy, teacher-visible, authority-keyed, and contains no roster or per-student fanout', async () => {
  const toolbar = await readFile(
    new URL('../src/products/classpilot/components/RemoteControlToolbar.jsx', import.meta.url),
    'utf8',
  );
  const dialog = await readFile(
    new URL('../src/products/classpilot/components/StudentDataDialog.jsx', import.meta.url),
    'utf8',
  );
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );

  assert.match(toolbar, /lazy\(\(\) => import\("\.\/StudentDataDialog"\)\)/);
  assert.match(toolbar, /schoolId=\{schoolId\}/);
  assert.match(toolbar, /viewerId=\{viewerId\}/);
  assert.match(dashboard, /canViewHistoricalTelemetry=\{isAdmin \|\| isTeacher\}/);
  assert.match(dashboard, /userRole=\{isAdmin \? 'admin' : 'teacher'\}/);
  assert.equal((dialog.match(/useQuery\(\{/g) || []).length, 2);
  assert.match(dialog, /studentDataScopesQueryUrl/);
  assert.match(dialog, /studentDataQueryUrl/);
  assert.match(dialog, /schoolKey,[\s\S]*viewerKey,[\s\S]*roleKey,[\s\S]*'report',[\s\S]*selectedScope\?\.key[\s\S]*period,[\s\S]*studentId/);
  assert.match(dialog, /PROVISIONAL_REFRESH_MS = 30_000/);
  assert.match(dialog, /FINAL_REFRESH_MS = 60_000/);
  assert.match(dialog, /function VirtualStudentRows/);
  assert.match(dialog, /STUDENT_ROW_OVERSCAN/);
  assert.match(dialog, /Top Sites &amp; Apps/);
  assert.match(dialog, /studentDataActivityLabel/);
  assert.equal((dialog.match(/refetchOnMount: 'always'/g) || []).length, 2);
  assert.equal((dialog.match(/refetchOnWindowFocus: 'always'/g) || []).length, 2);
  assert.equal((dialog.match(/refetchOnReconnect: 'always'/g) || []).length, 2);
  assert.match(dialog, /removeQueries\(\{[\s\S]*?'classpilot', 'student-data', schoolKey, viewerKey, roleKey/);
  assert.doesNotMatch(dialog, /rosterStudents|student-analytics|Promise\.all/);
  assert.doesNotMatch(toolbar, /students=\{students\}/);
});
