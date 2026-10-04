import assert from 'node:assert/strict';
import { RELEASE_ENABLED_PROFILE, capacityAcceptance } from '../release-enabled-profile.mjs';
import { POOL_LIMITS, LIFECYCLE_EVENTS } from './profile.mjs';

// Original numerical/authority/ownership checks are evaluated unchanged. A
// passing run is not accepted capacity until its complete campaign is verified.
export function numericalRunChecks(metrics, mode) {
  assert.ok(['diagnostic', 'capacity-candidate'].includes(mode));
  const original = capacityAcceptance(metrics);
  const phase = metrics.phases?.find(row => row.name === 'combined');
  const traffic = phase?.traffic?.heartbeats;
  return {
    ...original,
    candidateMode: mode === 'capacity-candidate' && metrics.diagnosticOnly === false,
    fullOffering: traffic?.offered === 6000 && traffic.started === 6000 && traffic.succeeded === 6000
      && traffic.failed === 0 && traffic.refusedAtInFlightLimit === 0 && traffic.lateOffers === 0,
    exactPools: metrics.pools && Object.keys(metrics.pools).length === Object.keys(POOL_LIMITS).length
      && Object.entries(POOL_LIMITS).every(([name,max]) => metrics.pools[name] === max),
    prewarm: metrics.prewarmed === 16 && metrics.readiness === true && metrics.redisReady === true,
    currentFocusProtocol: phase?.traffic?.lifecycle?.passed === true
      && phase.traffic.lifecycle.simulatedClientAcknowledgements === true
      && phase.traffic.lifecycle.browserEnforcementClaimed === false
      && JSON.stringify(phase.traffic.lifecycle.events) === JSON.stringify([...LIFECYCLE_EVENTS, ...LIFECYCLE_EVENTS]),
    fullReportMatrix: phase?.traffic?.reports?.length === 64
      && phase.traffic.reports.every(row => row.status === 200 && row.correct === true && row.error === undefined && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs < 20_000)
      && RELEASE_ENABLED_PROFILE.reportOffers.rangesInDays.every((days,wave) => [0,1].every(schoolIndex => ['school','grade','class','student'].every(scope =>
        phase.traffic.reports.filter(row => row.wave === wave && row.days === days && row.schoolIndex === schoolIndex && row.scope === scope).length === 2))),
    exactAuditedExports: metrics.correctness?.csvAuditCount === 8 && metrics.correctness?.exports?.length === 8
      && [0,1].every(schoolIndex => ['school','grade','class','student'].every(scope => metrics.correctness.exports.filter(row =>
        row.schoolIndex === schoolIndex && row.scope === scope && /^[a-f0-9]{64}$/.test(row.csvSha256 ?? '') && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs < 20_000).length === 1)),
    distinctWholeWorkers: Array.isArray(phase?.workers) && phase.workers.length === 2
      && [0,1].every(index => phase.workers.filter(row => row.schoolIndex === index && row.correct === true && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs <= 48_000).length === 1),
    distinctCurrentDayWorkers: Array.isArray(metrics.correctness?.currentDayWorkers) && metrics.correctness.currentDayWorkers.length === 2
      && [0,1].every(index => metrics.correctness.currentDayWorkers.filter(row => row.schoolIndex === index && row.correct === true && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs <= 48_000).length === 1),
    actualRestrictedPools: Array.isArray(metrics.poolReadiness) && metrics.poolReadiness.length === 3
      && ['api','session','worker'].every(name => metrics.poolReadiness.filter(row => row.name === name && row.max === POOL_LIMITS[name]
        && row.acquisitionCalls === 1 && row.queryCalls === 1 && row.sameRole === true && row.databaseSuperuser === false
        && row.databaseBypassRls === false && row.neutralSchool === true && row.applicationSuperScope === (name === 'worker')
        && row.checkoutDeadlineMs === (name === 'worker' ? 10_000 : 5_000) && row.statementDeadlineMs === (name === 'worker' ? 60_000 : 15_000)).length === 1),
  };
}
