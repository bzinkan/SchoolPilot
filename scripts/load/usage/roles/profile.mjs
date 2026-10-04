import assert from 'node:assert/strict';

export const PROFILE = 'release-enabled-linux-role-default-100rps-v1';
export const ROLE_LIMITS = Object.freeze({
  api: Object.freeze({ cpu: 1, memory: 2147483648 }),
  worker: Object.freeze({ cpu: .5, memory: 1073741824 }),
  generator: Object.freeze({ cpu: 2, memory: 1073741824 }),
  coordinator: Object.freeze({ cpu: .5, memory: 1073741824 }),
});
export const POOL_LIMITS = Object.freeze({ api: 16, session: 2, worker: 5, observer: 2 });
export const FIXTURE_LIMITS = Object.freeze({ postgres: { cpu: 4, memory: 4294967296 }, redis: { cpu: 1, memory: 268435456 } });
export const LIFECYCLE_EVENTS = Object.freeze([
  'websocket_authenticated', 'precise_command_ack', 'focus_command_ack',
  'focus_classroom_ack_and_public_state', 'private_reply_ack', 'private_chat_closed',
  'stale_private_reply_rejected', 'expired_reply_ack_and_projection_verified',
  'expired_reply_absent_after_reconnect', 'stop_focus_ack',
  'stop_focus_classroom_ack_and_public_state', 'precise_cleanup_ack',
]);

export function assertExecutionMode({ mode, phase, cpuProfile = false }) {
  assert.ok(['diagnostic', 'capacity-candidate'].includes(mode));
  assert.ok(['ingest', 'combined'].includes(phase));
  assert.equal(cpuProfile, false, 'This source-bound runtime profile has no profiler');
  if (mode === 'capacity-candidate') assert.equal(phase, 'combined');
  return { profile: PROFILE, mode, phase, diagnosticOnly: mode === 'diagnostic', capacityAccepted: false };
}
