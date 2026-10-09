import assert from 'node:assert/strict';
import { PROFILES, profileHash, hash } from './contracts.mjs';

// This historical application rejects rollout-map names it cannot implement.
// Only the reviewed v3 fixed133 comparison may project these three newer names
// out of its environment. The original observed environment remains retained.
export const BASELINE_COMPATIBILITY_ID = 'release297-7af9-fixed133-capability-map-v1';
export const BASELINE_COMPATIBILITY_SUCCESSOR = 'release297-current-school-acceptance-2001e888-cp-protected-build-v3';
export const BASELINE_COMPATIBILITY_SOURCE = '7af9d0dd5bc2bd3e13b96d35a577725e07f8b678';
export const BASELINE_COMPATIBILITY_PROFILE_SHA256 = '59167a96d825a56ed6f951f5327200257a0cacde0f2bc65a02606603cb9998a1';
export const BASELINE_UNSUPPORTED_CAPABILITIES = Object.freeze({
  preciseRestrictionResourcesV1: 'CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1',
  focusTabV1: 'CLASSPILOT_CAP_FOCUS_TAB_V1',
  privateChatLifecycleV1: 'CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1',
});
// Exact 7af9 registry, excluding restrictionPortalFirstV1, whose shared flag is
// explicitly forbidden as an independent rollout-map entry by that source.
export const BASELINE_SUPPORTED_ROLLOUT_KEYS = Object.freeze([
  'scopedAuthorityChecksV1', 'authBoundTelemetryV1', 'exactBindingAckV2', 'exactTabCloseV2',
  'studentChatIdempotencyV1', 'screenshotObservationLeaseV1', 'screenshotTrackingWindowLeaseV1',
  'screenshotActiveObservationCadenceV1', 'screenshotReadOnlyObservationV1', 'safetyEvidenceCaptureV1',
  'liveViewIceServersV1', 'kioskLaunchTicketV1', 'kioskLaunchTicketV2', 'studentAuthGatePresenceV1',
  'lateSignInRestrictionSsoV1', 'restrictionAuthPassThroughV1', 'afterHoursSafetyOnlyV1',
  'schoolWebsiteBlockEnforcementV1', 'scheduledClassroomV1', 'helpRequestsV1', 'questionParkingV1',
  'timerControlsV1', 'lessonActivitiesV1', 'exitTicketsV1',
]);
const digest = value => hash(JSON.stringify(value));
export function baselineFixedEnvironment({ environment, source, arm, profile, successorId }) {
  if (successorId !== BASELINE_COMPATIBILITY_SUCCESSOR || arm !== 'A') return { environment, proof: null };
  assert.equal(source, BASELINE_COMPATIBILITY_SOURCE, 'BASELINE_COMPATIBILITY_SOURCE_CHANGED');
  assert.equal(profile.name, PROFILES.sole.name, 'BASELINE_COMPATIBILITY_PROFILE_CHANGED');
  assert.equal(profileHash(profile), BASELINE_COMPATIBILITY_PROFILE_SHA256, 'BASELINE_COMPATIBILITY_PROFILE_CHANGED');
  const prepared = { ...environment }, before = JSON.parse(environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON), after = { ...before };
  assert.ok(before && !Array.isArray(before) && typeof before === 'object', 'BASELINE_ROLLOUT_MAP_REQUIRED');
  const omitted = [];
  for (const [capability, flag] of Object.entries(BASELINE_UNSUPPORTED_CAPABILITIES)) {
    assert.equal(before[capability]?.mode, 'on', 'REVIEWED_BASELINE_CAPABILITY_MODE_CHANGED');
    assert.equal(environment[flag], 'true', 'REVIEWED_BASELINE_CAPABILITY_FLAG_CHANGED');
    omitted.push({ capability, flag, observedMode: 'on', observedFlag: 'true', effectiveMode: 'unsupported_off', originalEntrySha256: digest(before[capability]) });
    delete after[capability]; delete prepared[flag];
  }
  assert.ok(Object.keys(after).every(key => BASELINE_SUPPORTED_ROLLOUT_KEYS.includes(key)), 'BASELINE_UNKNOWN_ROLLOUT_KEY');
  prepared.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify(after);
  return { environment: prepared, proof: {
    schemaVersion: 1, id: BASELINE_COMPATIBILITY_ID, successorId, baselineSource: source,
    profile: profile.name, profileSha256: BASELINE_COMPATIBILITY_PROFILE_SHA256, omitted,
    originalEnvironmentSha256: digest(environment), effectiveEnvironmentSha256: digest(prepared),
    originalRolloutMapSha256: digest(before), effectiveRolloutMapSha256: digest(after),
    allOtherEnvironmentEntriesPreserved: true, productionEnvironmentChanged: false,
    candidateEnvironmentChanged: false, acceptanceCriteriaChanged: false,
  } };
}
