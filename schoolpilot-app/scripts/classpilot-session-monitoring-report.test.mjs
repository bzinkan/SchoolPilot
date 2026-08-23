import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatReportDateTime,
  formatReportDuration,
  normalizeReportDomain,
  normalizeSessionMonitoringReport,
} from '../src/products/classpilot/lib/sessionMonitoringReport.js';

test('report v2 adapter presents bounded activity, off-task, domain, and safety details', () => {
  const report = normalizeSessionMonitoringReport({
    reportVersion: 2,
    timezone: 'America/New_York',
    totals: {
      roster: 1,
      eligible: 1,
      complete: 0,
      partial: 1,
      none: 0,
      unavailable: 0,
      eligibleSeconds: 120,
      monitoredSeconds: 90,
      gapSeconds: 30,
      unclassifiedSeconds: 20,
      offTaskSeconds: 150,
      offTaskEventCount: 4,
      safetyAlertCount: 4,
    },
    students: [{
      studentId: 'student-1',
      studentName: 'Ada Student',
      status: 'partial',
      eligibleSeconds: 120,
      monitoredSeconds: 90,
      gapSeconds: 30,
      unclassifiedSeconds: 20,
      offTaskSeconds: 150,
      offTaskEventCount: 4,
      topDomains: [
        { normalizedDomain: 'LMS.Example.EDU', seconds: 70 },
        { domain: 'https://video.example.edu/watch?v=private', seconds: 50 },
        { url: 'https://lms.example.edu/private/path?student=ada', seconds: 5 },
      ],
      safetyAlerts: [
        {
          id: 'alert-automated',
          category: 'self_harm',
          normalizedDomain: 'search.example.edu',
          occurredAt: '2026-08-22T14:30:00.000Z',
          evidenceAvailability: 'available',
          reviewStatus: null,
        },
        { id: 'alert-confirmed', category: 'violence', evidenceAvailable: false, reviewStatus: 'confirmed' },
        { id: 'alert-dismissed', category: 'bullying', reviewStatus: 'dismissed' },
        { id: 'alert-escalated', category: 'weapons', reviewStatus: 'escalated' },
      ],
    }],
  });

  assert.equal(report.reportVersion, 2);
  assert.equal(report.totals.monitoredSeconds, 90);
  assert.equal(report.totals.eligibleSeconds, 120);
  assert.equal(report.totals.gapSeconds, 30);
  assert.equal(report.totals.unclassifiedSeconds, 20);
  assert.equal(report.totals.offTaskSeconds, 90, 'off-task time must not exceed monitored time');
  assert.equal(report.totals.offTaskEventCount, 4);
  assert.equal(report.totals.safetyAlertCount, 4);

  const [student] = report.students;
  assert.equal(student.offTaskSeconds, 90);
  assert.deepEqual(student.topDomains, [
    { domain: 'lms.example.edu', seconds: 75, visits: 0 },
    { domain: 'video.example.edu', seconds: 15, visits: 0 },
  ], 'normalized domain totals must not exceed the monitored-time budget');
  assert.deepEqual(
    student.safetyAlerts.map((alert) => alert.reviewStatus),
    ['Automated', 'Confirmed', 'Dismissed', 'Escalated'],
  );
  assert.equal(student.safetyAlerts[0].evidenceAvailability, 'Available');
  assert.equal(student.safetyAlerts[1].evidenceAvailability, 'Unavailable');
  assert.equal(student.safetyAlerts[0].domain, 'search.example.edu');
  assert.doesNotMatch(JSON.stringify(student.topDomains), /private|student=|watch\?/i);
});

test('report v1 adapter preserves available heartbeat coverage without inventing v2 values', () => {
  const report = normalizeSessionMonitoringReport({
    coverageAlgorithmVersion: 1,
    totals: {
      roster: 1,
      eligible: 1,
      complete: 0,
      partial: 1,
      none: 0,
      eligibleSeconds: 120,
      observedSeconds: 90,
      gapSeconds: 30,
    },
    students: [{
      studentId: 'legacy-student',
      studentName: 'Legacy Student',
      status: 'partial',
      eligibleSeconds: 120,
      observedSeconds: 90,
      gapSeconds: 30,
      coveragePercent: 75,
      topDomains: [{ domain: 'https://docs.example.edu/assignment?token=secret', seconds: 45 }],
    }],
  });

  assert.equal(report.reportVersion, 1);
  assert.equal(report.hasV2Details, false);
  assert.equal(report.totals.monitoredSeconds, 90);
  assert.equal(report.totals.unclassifiedSeconds, null);
  assert.equal(report.totals.offTaskSeconds, null);
  assert.equal(report.totals.offTaskEventCount, null);
  assert.equal(report.totals.safetyAlertCount, null);
  assert.equal(report.students[0].coveragePercent, 75);
  assert.deepEqual(report.students[0].topDomains, [
    { domain: 'docs.example.edu', seconds: 45, visits: 0 },
  ]);
});

test('report formatting stays privacy-safe and handles absent or invalid values', () => {
  assert.equal(normalizeReportDomain('https://user:password@example.edu/private?q=secret'), 'example.edu');
  assert.equal(normalizeReportDomain('not a domain /private?q=secret'), null);
  assert.equal(formatReportDuration(null), 'Not included');
  assert.equal(formatReportDuration(0), '0s');
  assert.equal(formatReportDuration(3725), '1h 2m');
  assert.equal(formatReportDateTime('not-a-date', 'America/New_York'), 'Time unavailable');
  assert.match(
    formatReportDateTime('2026-08-22T14:30:00.000Z', 'America/New_York'),
    /Aug 22, 2026/,
  );
});
