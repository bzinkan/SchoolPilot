import { deriveStudentMonitoringDisplay } from './studentMonitoringDisplay.js';
import { normalizeClasspilotPreviewTimestamp } from './classpilotRecovery.js';

const MAX_SAMPLES = 6_000;

export function createPreviewEligibilityV1() {
  return { version: 1, freshnessBuckets: [0, 0, 0, 0, 0, 0],
    excludedCounts: { readDenied: 0, notObserved: 0, backgroundCadence: 0, monitoringNotCurrent: 0 } };
}

// Add context to the unchanged all-row measurement. Eligibility is decided
// from observation/cadence/monitoring metadata, never from pixel presence or age.
// These fixed aggregate counts are logged only; they create no metric streams.
export function recordPreviewEligibilityV1(summary, snapshot, now) {
  if (!snapshot?.enabled || snapshot.visible === false) return;
  let samples = summary.freshnessBuckets.reduce((total, count) => total + count, 0)
    + Object.values(summary.excludedCounts).reduce((total, count) => total + count, 0);
  for (const student of snapshot.students) {
    if (samples >= MAX_SAMPLES) break;
    samples += 1;
    let excluded;
    if (snapshot.denied.has(student.studentId)) excluded = 'readDenied';
    else if (snapshot.observationStatus(student) !== 'observed') excluded = 'notObserved';
    else if (student.acceptedCapabilities?.screenshotActiveObservationCadenceV1 !== true) excluded = 'backgroundCadence';
    else if (!deriveStudentMonitoringDisplay(student, now).telemetryCurrent) excluded = 'monitoringNotCurrent';
    if (excluded) {
      summary.excludedCounts[excluded] += 1;
      continue;
    }
    const frame = snapshot.screenshots.get(student.studentId);
    const capturedAt = typeof frame?.screenshot === 'string' && frame.screenshot.length > 0
      ? normalizeClasspilotPreviewTimestamp(frame.timestamp, now) : null;
    const age = capturedAt === null ? NaN : now - capturedAt;
    const bucket = !Number.isFinite(age) || age < -60_000 ? 5
      : age <= 5_000 ? 0 : age <= 10_000 ? 1 : age <= 15_000 ? 2 : age <= 30_000 ? 3 : 4;
    summary.freshnessBuckets[bucket] += 1;
  }
}
