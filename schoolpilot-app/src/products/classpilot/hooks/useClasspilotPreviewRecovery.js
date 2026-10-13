import { useEffect, useLayoutEffect, useRef } from 'react';
import { apiRequest } from '../../../lib/queryClient';
import { withClasspilotReadDeadline, stepClasspilotPreviewRecovery } from '../lib/classpilotRecovery';

export function useClasspilotPreviewRecovery({ fastScreenshotStudents, screenshotsByStudent, screenshotTileReadsEnabled,
  deniedScreenshotReadIds, studentView, claimedStudentObservationStatus, observationLeaseStatus,
  targetedScreenshotFenceKey, queueTargetedScreenshotRefresh, screenshotRecoveryRef, clientHealthRef,
  activeSchoolId, viewerId, token }) {
  const previewRecoverySnapshotRef = useRef(null);
  const previousFastTargets = useRef(new Set());
  useLayoutEffect(() => {
    previewRecoverySnapshotRef.current = { students: fastScreenshotStudents, screenshots: screenshotsByStudent,
      enabled: screenshotTileReadsEnabled, denied: deniedScreenshotReadIds,
      observationStatus: studentView === 'claimed' ? claimedStudentObservationStatus : () => observationLeaseStatus };
  }, [fastScreenshotStudents, screenshotsByStudent, screenshotTileReadsEnabled, deniedScreenshotReadIds, studentView, claimedStudentObservationStatus, observationLeaseStatus]);
  useEffect(() => {
    const next = new Set(fastScreenshotStudents.map(student => student.studentId));
    const entering = [...next].filter(id => !previousFastTargets.current.has(id));
    previousFastTargets.current = next;
    if (screenshotTileReadsEnabled && document.visibilityState === 'visible' && entering.length) {
      queueTargetedScreenshotRefresh(entering, { immediate: true });
    }
  }, [fastScreenshotStudents, screenshotTileReadsEnabled, queueTargetedScreenshotRefresh]);
  useEffect(() => {
    let stopped = false;
    let timer;
    const tick = () => {
      if (stopped) return;
      const current = previewRecoverySnapshotRef.current;
      const now = Date.now();
      let next = now + 5_000;
      if (document.visibilityState === 'visible' && current?.enabled) {
        const { due, nextAt, gapRecoveries } = stepClasspilotPreviewRecovery(screenshotRecoveryRef.current, { ...current, now });
        next = nextAt;
        clientHealthRef.current.counters.eventGapRecoveries += gapRecoveries;
        if (due.length) queueTargetedScreenshotRefresh(due, { immediate: true });
      }
      timer = setTimeout(tick, Math.max(50, next - Date.now()));
    };
    const visibility = () => { clearTimeout(timer); tick(); };
    document.addEventListener('visibilitychange', visibility);
    tick();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [targetedScreenshotFenceKey, queueTargetedScreenshotRefresh]);
  useEffect(() => {
    clientHealthRef.current = { freshnessBuckets: [0, 0, 0, 0, 0, 0], counters: { readTimeouts: 0, reconnects: 0, recoveries: 0, eventGapRecoveries: 0 } };
    if (!activeSchoolId || !viewerId || !token) return undefined;
    const reporter = new AbortController();
    let ticks = 0;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const current = previewRecoverySnapshotRef.current;
      const buffer = clientHealthRef.current;
      if (current?.enabled) for (const student of current.students) {
        if (current.denied.has(student.studentId)) continue;
        const capturedAt = Date.parse(current.screenshots.get(student.studentId)?.timestamp || '');
        const age = Date.now() - capturedAt;
        const bucket = !Number.isFinite(age) || age < -60_000 ? 5 : age <= 5_000 ? 0 : age <= 10_000 ? 1 : age <= 15_000 ? 2 : age <= 30_000 ? 3 : 4;
        buffer.freshnessBuckets[bucket] += 1;
      }
      ticks += 1;
      if (ticks < 12) return;
      ticks = 0;
      const body = { version: 1, intervalSeconds: 60, freshnessBuckets: buffer.freshnessBuckets,
        counters: Object.fromEntries(Object.entries(buffer.counters).map(([key, value]) => [key, Math.min(6000, value)])) };
      clientHealthRef.current = { freshnessBuckets: [0, 0, 0, 0, 0, 0], counters: { readTimeouts: 0, reconnects: 0, recoveries: 0, eventGapRecoveries: 0 } };
      void withClasspilotReadDeadline(signal => apiRequest('POST', '/classpilot/monitoring/client-health', body,
        { signal, headers: { 'X-School-Id': activeSchoolId } }), reporter.signal).catch(() => {});
    }, 5_000);
    return () => { clearInterval(timer); reporter.abort(); };
  }, [activeSchoolId, viewerId, token]);
}
