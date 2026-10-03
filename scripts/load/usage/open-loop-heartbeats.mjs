import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export const OPEN_LOOP_HEARTBEATS = Object.freeze({
  requestsPerSecond: 100, durationMs: 60_000, schools: 2, devicesPerSchool: 500,
  deviceCadenceMs: 10_000, maxInFlight: 1_000, requestTimeoutMs: 20_000, maxOfferLatenessMs: 100,
});

export function openLoopOffering(index, config = OPEN_LOOP_HEARTBEATS) {
  assert.ok(Number.isInteger(index) && index >= 0);
  return { index, offsetMs: index * 1_000 / config.requestsPerSecond,
    schoolIndex: index % config.schools, deviceIndex: Math.floor(index / config.schools) % config.devicesPerSchool };
}

// Offers are scheduled independently of response completion. Saturation and
// event-loop delay remain failures in the evidence, never a lower offered rate.
export async function offerOpenLoopHeartbeats(send, { config = OPEN_LOOP_HEARTBEATS,
  now = () => performance.now(), sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  for (const key of ['requestsPerSecond','durationMs','schools','devicesPerSchool','maxInFlight','requestTimeoutMs']) {
    assert.ok(Number.isInteger(config[key]) && config[key] > 0, `Invalid ${key}`);
  }
  assert.ok(Number.isFinite(config.maxOfferLatenessMs) && config.maxOfferLatenessMs >= 0);
  const expected = config.durationMs * config.requestsPerSecond / 1_000;
  assert.ok(Number.isInteger(expected));
  const start = now(), pending = new Set();
  const result = { configured: {...config}, expected, offered: 0, started: 0, succeeded: 0, failed: 0,
    refusedAtInFlightLimit: 0, lateOffers: 0, maxOfferLatenessMs: 0, peakInFlight: 0, bySchool: {}, timingsMs: [] };
  for (let index = 0; index < expected; index++) {
    const offering = openLoopOffering(index, config), target = start + offering.offsetMs;
    if (now() < target) await sleep(target - now());
    const lateness = Math.max(0, now() - target);
    result.offered++;
    result.maxOfferLatenessMs = Math.max(result.maxOfferLatenessMs, lateness);
    if (lateness > config.maxOfferLatenessMs) result.lateOffers++;
    const school = result.bySchool[offering.schoolIndex] ??= { offered: 0, started: 0, succeeded: 0, failed: 0, refused: 0 };
    school.offered++;
    if (pending.size >= config.maxInFlight) { result.refusedAtInFlightLimit++; school.refused++; continue; }
    result.started++; school.started++;
    const controller = new AbortController(), requestStart = now();
    const timer = setTimeout(() => controller.abort(new Error('Synthetic request deadline exceeded')), config.requestTimeoutMs);
    let operation;
    operation = Promise.resolve().then(() => send(offering, controller.signal)).then(() => {
      result.succeeded++; school.succeeded++;
    }, error => {
      result.failed++; school.failed++;
      result.failureCodes ??= {};
      const code = /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : error.name === 'AbortError' ? 'ABORTED' : 'REQUEST_FAILED';
      result.failureCodes[code] = (result.failureCodes[code] || 0) + 1;
    }).finally(() => {
      clearTimeout(timer); result.timingsMs.push(now() - requestStart); pending.delete(operation);
    });
    pending.add(operation); result.peakInFlight = Math.max(result.peakInFlight, pending.size);
  }
  result.offerWindowMs = now() - start;
  result.outstandingAtEndOfOffering = pending.size;
  await Promise.all([...pending]);
  result.totalIncludingDrainMs = now() - start;
  result.outstandingAfterDrain = pending.size;
  result.accepted = result.offered === expected && result.started === expected && result.succeeded === expected &&
    result.failed === 0 && result.refusedAtInFlightLimit === 0 && result.lateOffers === 0 && result.outstandingAfterDrain === 0;
  return result;
}
