import assert from 'node:assert/strict';
import { stageForRound, stickyTarget } from './contracts.mjs';
import { targetFor } from './offering.mjs';

// Exact ordinary stages belong to the declared offer clock, not wall rounding.
export function topologyForOffer(profile, offsetMs) {
  assert.equal(profile.kind, 'mixed');
  assert.ok(Number.isFinite(offsetMs) && offsetMs >= 0 && offsetMs < profile.continuousOffering.durationMs);
  return stageForRound(Math.floor(offsetMs / 60_000), profile);
}
export function expectedTargetsBefore(profile, untilOffsetMs) {
  const config = profile.continuousOffering, counts = {};
  assert.ok(Number.isFinite(untilOffsetMs) && untilOffsetMs > 0 && untilOffsetMs <= config.durationMs);
  for (let index = 0; index < config.expected; index++) {
    const offer = targetFor(index, config); if (offer.offsetMs >= untilOffsetMs) break;
    const stage = topologyForOffer(profile, offer.offsetMs), target = stickyTarget(offer.schoolIndex * 500 + offer.deviceIndex, stage.active, stage.distribution);
    counts[target] = (counts[target] ?? 0) + 1;
  }
  return counts;
}
export async function waitForHeartbeatOwnership(owner, expected, { deadlineMs, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  assert.ok(Number.isSafeInteger(expected) && expected > 0);
  const startedAtMs = now(), observations = [];
  while (now() < deadlineMs) {
    const state = await owner.rpc('snapshot', {}, Math.max(1, deadlineMs - now())), count = state.http?.seenHeartbeatOffers;
    assert.ok(Number.isSafeInteger(count) && count >= 0, 'Missing actual heartbeat ownership counter');
    assert.ok(count <= expected, 'Unexpected heartbeat arrived on lost API');
    const observedAtMs=now();observations.push({ atMs: observedAtMs, count });
    if (count === expected) {
      assert.ok(now() <= deadlineMs);
      return { expected, observed: count, startedAtMs, completedAtMs: observedAtMs, observations, actualServerOwnership: true };
    }
    await pause(Math.min(10, Math.max(1, deadlineMs - now())));
  }
  throw Object.assign(new Error('Pre-loss heartbeat ownership did not settle'), { code: 'LOSS_INGRESS_HANDOFF_TIMEOUT' });
}
