import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeStudentDataResponse,
  StudentDataContractError,
  studentDataCsv,
  studentDataQueryUrl,
} from '../src/products/classpilot/lib/studentData.js';

test('aggregate Student Data adapter bounds seconds and strips full URL details', () => {
  const report = normalizeStudentDataResponse({
    reportVersion: 2,
    revision: 'aggregate-42',
    period: 'week',
    monitoredSeconds: 60,
    topDomains: [
      { domain: 'https://Example.com/private?q=student', seconds: 120 },
    ],
    students: [{
      studentId: 'student-1',
      name: 'Ada Student',
      monitoredSeconds: 100,
      topDomains: [{ normalizedDomain: 'docs.example.org/path', boundedSeconds: 200 }],
    }],
  }, {
    rosterStudents: [
      { studentId: 'student-1', studentName: 'Ada Student' },
      { studentId: 'student-2', studentName: 'Grace Student' },
    ],
  });

  assert.equal(report.revision, 'aggregate-42');
  assert.deepEqual(report.topDomains, [{ domain: 'example.com', seconds: 60 }]);
  assert.deepEqual(report.students[0].domains, [{ domain: 'docs.example.org', seconds: 100 }]);
  assert.equal(report.students[1].monitoredSeconds, 0, 'roster-only students remain visible without invented activity');
});

test('raw heartbeat responses fail closed instead of rebuilding inaccurate client aggregates', () => {
  assert.throws(
    () => normalizeStudentDataResponse({ heartbeats: [{ activeTabUrl: 'https://example.com' }] }),
    (error) => error instanceof StudentDataContractError
      && error.code === 'STUDENT_DATA_AGGREGATE_REQUIRED',
  );
});

test('query and CSV use one aggregate scope and the same immutable revision', () => {
  assert.equal(
    studentDataQueryUrl({ period: 'month', studentId: 'student 1', sessionId: 'session/1' }),
    '/student-data?period=month&sessionId=session%2F1&studentId=student+1',
  );
  const csv = studentDataCsv({
    revision: 'revision-7',
    students: [{
      studentId: 'student-1',
      name: '=Formula Student',
      monitoredSeconds: 30,
      topDomain: 'example.org',
      siteCount: 1,
    }],
  }, { period: 'today' });
  assert.match(csv, /"Aggregate revision","revision-7"/);
  assert.match(csv, /"'=Formula Student"/);
});

test('Student Data UI is lazy and contains no per-student request fanout', async () => {
  const toolbar = await readFile(
    new URL('../src/products/classpilot/components/RemoteControlToolbar.jsx', import.meta.url),
    'utf8',
  );
  const dialog = await readFile(
    new URL('../src/products/classpilot/components/StudentDataDialog.jsx', import.meta.url),
    'utf8',
  );

  assert.match(toolbar, /lazy\(\(\) => import\("\.\/StudentDataDialog"\)\)/);
  assert.doesNotMatch(toolbar, /student-analytics|recharts|Promise\.all/);
  assert.equal((dialog.match(/useQuery\(\{/g) || []).length, 1);
  assert.match(dialog, /studentDataQueryUrl/);
  assert.match(dialog, /retry: false/);
  assert.doesNotMatch(dialog, /student-analytics|Promise\.all/);
});
