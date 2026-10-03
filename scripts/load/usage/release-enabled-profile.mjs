import assert from 'node:assert/strict';
import { COLD_OPEN_LOOP_PROFILE } from './cold-open-loop-profile.mjs';
import { releaseServerIsIdle } from './release-enabled-drain.mjs';

// Separate from the historical cold/off profile. Never reinterpret its failures.
export const RELEASE_ENABLED_PROFILE = Object.freeze({
  ...COLD_OPEN_LOOP_PROFILE,
  name: 'release-enabled-isolated-100rps-v1',
  apiTasks: 1, apiMainPool: 16, apiSessionPool: 2, workerPool: 5, observerPool: 2,
  staffAuthentication: 'real-password-login-and-session-cookie',
  capabilityModes: Object.freeze({ preciseRestrictionResourcesV1: 'on', focusTabV1: 'on', privateChatLifecycleV1: 'on' }),
  reportOffers: Object.freeze({ waves: 4, maximumParallel: 16, total: 64, csvAfterConcurrent: 8, rangesInDays: Object.freeze([1, 7, 30, 365]) }),
  publicRequestDeadlineMs: 20_000,
  preflightDevicesPerSchool: 5,
  drainCoverage: 'Known Promise-returning API/heartbeat middleware, full heartbeat handlers, scoped operations, raw pool work, classification/WebSocket producers and tenant releases. HTTP response lifetime supplements callback middleware; an aborted pre-handler response is never certified as fully completed.',
  reporting: '100% offered heartbeats and reports; errors, overload rejections, aborted requests and late offers fail acceptance',
});

export function enabledReleaseEnvironment(env) {
  const capabilities = { scopedAuthorityChecksV1: 'SCOPED_AUTHORITY_CHECKS_V1', scheduledClassroomV1: 'SCHEDULED_CLASSROOM_V1',
    studentChatIdempotencyV1: 'STUDENT_CHAT_IDEMPOTENCY_V1', lateSignInRestrictionSsoV1: 'LATE_SIGNIN_RESTRICTION_SSO_V1',
    restrictionAuthPassThroughV1: 'RESTRICTION_AUTH_PASS_THROUGH_V1', screenshotTrackingWindowLeaseV1: 'SCREENSHOT_TRACKING_WINDOW_LEASE_V1',
    screenshotActiveObservationCadenceV1: 'SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1', screenshotObservationLeaseV1: 'SCREENSHOT_OBSERVATION_LEASE_V1',
    preciseRestrictionResourcesV1: 'PRECISE_RESTRICTION_RESOURCES_V1', focusTabV1: 'FOCUS_TAB_V1', privateChatLifecycleV1: 'PRIVATE_CHAT_LIFECYCLE_V1' };
  return { ...env,
    CLASSPILOT_PROTOCOL_V3_ENABLED: 'true', CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: 'true',
    CLASSPILOT_CAP_STUDENT_CHAT_IDEMPOTENCY_V1: 'true', CLASSPILOT_SCHEDULED_CLASSROOM_MODE: 'on',
    CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1: 'true', CLASSPILOT_CAP_FOCUS_TAB_V1: 'true',
    CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1: 'true',
    ...Object.fromEntries(Object.values(capabilities).map(flag => [`CLASSPILOT_CAP_${flag}`, 'true'])),
    CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify(Object.fromEntries(Object.keys(capabilities).map(key => [key, { mode: 'on' }]))),
    CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS: '', CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS: '',
    // Explicit reviewed role caps; no process may inherit an enlarged pool.
    DB_POOL_MAX: '16', SESSION_DB_POOL_MAX: '2', SCHEDULER_DB_POOL_MAX: '5', SCHEDULER_LOCK_POOL_MAX: '8',
  };
}

export function assertEnabledReleaseRuntime(protocol, env) {
  protocol.assertClasspilotCapabilityRolloutsEnv(env);
  for (const [capability, mode] of Object.entries(RELEASE_ENABLED_PROFILE.capabilityModes)) {
    assert.equal(protocol.classpilotCapabilityRolloutMode(capability, env), mode);
    assert.equal(protocol.isClasspilotCapabilityActive(capability, { schoolId: 'synthetic-fixture' }, env), true);
  }
  const redis = new URL(env.REDIS_URL);
  assert.equal(redis.hostname, '127.0.0.1'); assert.equal(redis.port, '6387');
  assert.equal(env.RLS_GUC_ENABLED, 'true');
}

export function capacityAcceptance(result) {
  const combined = result.phases?.find(phase => phase.name === 'combined');
  return {
    sourceFrozen: result.sourceClean === true && result.sourceUnchangedAtFinish === true,
    acceptanceRun: result.diagnosticOnly !== true && result.cpuProfile?.enabled !== true,
    isolatedProcesses: new Set(Object.values(result.processes ?? {})).size === 3,
    enabledCapabilities: result.enabledCapabilitiesVerified === true,
    realSessionCookies: result.staffAuthenticationVerified === true,
    poolLimits: result.pools?.api === 16 && result.pools?.session === 2 && result.pools?.worker === 5,
    allHeartbeats: combined?.traffic?.heartbeats?.accepted === true && combined.traffic.heartbeats.expected === 6000,
    heartbeatCompletionDeadline: combined?.traffic?.heartbeats?.timings?.count === 6000
      && combined.traffic.heartbeats.timings.maxMs < RELEASE_ENABLED_PROFILE.publicRequestDeadlineMs,
    // Initialization warms exactly five devices in each of two schools. Only
    // their first offered heartbeat can fall within the existing5s throttle.
    // WS/command/chat probes emit no additional HTTP heartbeat requests.
    observationsRecorded: combined?.insertedObservations >= 6000 - RELEASE_ENABLED_PROFILE.preflightDevicesPerSchool * RELEASE_ENABLED_PROFILE.httpOffering.schools
      && combined.traffic?.heartbeatStatuses?.['200'] >= 6000 - RELEASE_ENABLED_PROFILE.preflightDevicesPerSchool * RELEASE_ENABLED_PROFILE.httpOffering.schools
      && combined.insertedObservations === combined.traffic?.heartbeatStatuses?.['200'],
    allReports: combined?.traffic?.reports?.length === 64 && combined.traffic.reports.every(row => row.status === 200 && row.correct === true && row.durationMs < 20_000),
    allReportScopesAndRanges: RELEASE_ENABLED_PROFILE.reportOffers.rangesInDays.every(days => [0, 1].every(schoolIndex => ['school', 'grade', 'class', 'student'].every(scope =>
      combined?.traffic?.reports?.filter(row => row.days === days && row.schoolIndex === schoolIndex && row.scope === scope).length === 2))),
    workerHeadroom: combined?.workers?.length === 2 && combined.workers.every(row => row.durationMs <= 48_000 && row.correct === true),
    currentDayWorkerHeadroom: result.correctness?.currentDayWorkers?.length === 2
      && result.correctness.currentDayWorkers.every(row => row.correct === true && row.durationMs <= 48_000),
    lifecycle: combined?.traffic?.lifecycle?.passed === true,
    serverDrained: ['api', 'worker'].every(role => combined?.serverDrain?.[role]?.complete === true
      && releaseServerIsIdle(combined?.[role]) && combined[role].http?.abortedResponses === 0),
    noLateHandlerFailures: combined?.api?.operations?.operations?.heartbeat_handler?.counters?.heartbeatHandlerFailures === 0,
    // This is reset only at phase start, unlike the minute-summary hotpath
    // counters. The API snapshot is taken after all offers and producer drain.
    noOptionalTelemetryFailures: combined?.api?.operations?.operations?.heartbeat_background?.counters?.heartbeatOptionalTelemetryFailures === 0,
    noPoolFailures: combined?.api?.database?.acquisitions?.failures === 0 && combined?.worker?.database?.acquisitions?.failures === 0
      && combined.worker.database.acquisitions.count >= 2,
    acquisitionDeadlines: combined?.api?.database?.acquisitions?.maxMs <= 5000 && combined?.worker?.database?.acquisitions?.maxMs <= 10000,
    statementDeadlines: ['api', 'worker'].every(role => {
      const rows = Object.values(combined?.[role]?.database?.statements ?? {});
      return rows.length > 0 && rows.every(row => row.failures === 0 && row.maxMs <= (role === 'api' ? 15000 : 60000));
    }),
    correctness: result.correctness?.passed === true,
  };
}

export function releaseTrafficOptions(env) {
  if (env.USAGE_RELEASE_CPU_PROFILE === 'true') {
    assert.equal(env.USAGE_RELEASE_PHASE, 'ingest', 'CPU collection is restricted to diagnostic ingestion');
    assert.equal(env.USAGE_RELEASE_DIAGNOSTIC, 'true', 'Profiler runs cannot establish capacity acceptance');
    return {}; // Preserve60seconds,100offers/sec,6000offers; never shorten a CPU diagnostic.
  }
  return env.USAGE_RELEASE_DIAGNOSTIC === 'true' ? { durationMs: 10_000 } : {};
}

export function releaseRangeFixture(fixture, days = 365) {
  assert.ok([1, 7, 30, 365].includes(days));
  const dates = Array.from({ length: days }, (_, index) => new Date(Date.parse(`${fixture.today}T12:00:00Z`) - (days - index - 1) * 86400000).toISOString().slice(0, 10));
  const excluded = new Set([fixture.today, fixture.gapDate, fixture.emptyDate, fixture.heavyDate]);
  return { from: dates[0], to: fixture.today, days, dates, historyDates: dates.filter(date => !excluded.has(date)),
    includesHeavy: dates.includes(fixture.heavyDate), includesEmpty: dates.includes(fixture.emptyDate), includesGap: dates.includes(fixture.gapDate) };
}
