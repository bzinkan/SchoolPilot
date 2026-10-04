import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { assertOffering } from './contracts.mjs';

export function targetFor(index, config) {
  const population = config.schoolDevices.reduce((a, b) => a + b, 0);
  let position = index % population;
  for (let schoolIndex = 0; schoolIndex < config.schoolDevices.length; schoolIndex++) {
    if (position < config.schoolDevices[schoolIndex]) return { index, schoolIndex, deviceIndex: position,
      studentOrdinal: index % population, offsetMs: index * 1000 / config.requestsPerSecond };
    position -= config.schoolDevices[schoolIndex];
  }
  throw Error('Invalid fixture target');
}
export async function offerHeartbeats(send, { config, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), reconnect = false, mapOffer } = {}) {
  assertOffering(config);if(mapOffer)assert.equal(reconnect,true,'Only declared reconnect subsets may remap the ordinary population');
  const pending = new Set(), start = now();
  const fresh = configured => ({ configured: structuredClone(configured), expected: configured.expected, offered: 0, started: 0, succeeded: 0, failed: 0,
    refusedAtInFlightLimit: 0, lateOffers: 0, maxOfferLatenessMs: 0, peakInFlight: 0, outstandingAfterDrain: null,
    bySchool: {}, bindings: {}, targetHistogram: {}, timingsMs: [], buckets: [], statusHistogram: {} });
  const result=fresh(config);result.windows=config.durationMs>60_000?Array.from({length:config.durationMs/60_000},(_,index)=>({...fresh({...config,durationMs:60_000,expected:Math.round(config.requestsPerSecond*60)}),windowIndex:index})):[];
  for (let index = 0; index < config.expected; index++) {
    const selected=targetFor(index,config),offer=mapOffer?mapOffer(selected):selected;
    assert.equal(offer.index,selected.index);assert.equal(offer.offsetMs,selected.offsetMs);assert.equal(offer.schoolIndex,selected.schoolIndex);
    assert.ok(Number.isSafeInteger(offer.deviceIndex)&&offer.deviceIndex>=0&&offer.deviceIndex<500);
    const due = start + offer.offsetMs;
    const minute=result.windows[Math.floor(offer.offsetMs/60_000)], outputs=minute?[result,minute]:[result];
    if (now() < due) await sleep(due - now());
    const lateness = Math.max(0, now() - due), bucketIndex = Math.floor(offer.offsetMs / 5000);
    const bucket = result.buckets[bucketIndex] ??= { offsetMs: bucketIndex * 5000, offered: 0, started: 0, succeeded: 0, failed: 0, refused: 0, timingsMs: [] };
    const school = result.bySchool[offer.schoolIndex] ??= { offered: 0, started: 0, succeeded: 0, failed: 0, refused: 0 };
    result.offered++; school.offered++; bucket.offered++; result.maxOfferLatenessMs = Math.max(result.maxOfferLatenessMs, lateness);
    if(minute){minute.offered++;minute.maxOfferLatenessMs=Math.max(minute.maxOfferLatenessMs,lateness);}
    if (lateness > config.maxOfferLatenessMs) result.lateOffers++;
    if (lateness > config.maxOfferLatenessMs && minute) minute.lateOffers++;
    if (pending.size >= config.maxInFlight) { result.refusedAtInFlightLimit++; school.refused++; bucket.refused++;if(minute)minute.refusedAtInFlightLimit++; continue; }
    result.started++; school.started++; bucket.started++;
    if(minute)minute.started++;
    const started = now(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    let operation;
    operation = Promise.resolve().then(() => send(offer, controller.signal)).then(reply => {
      const status = reply?.status ?? 200; result.statusHistogram[status] = (result.statusHistogram[status] || 0) + 1;
      assert.ok(reconnect ? [200, 204].includes(status) : status === 200,
        'Ordinary offers require HTTP200; declared reconnect extras allow throttled HTTP204');
      for(const output of outputs){
        const binding = output.bindings[`${offer.schoolIndex}:${offer.deviceIndex}`] ??= { acknowledged200: 0, acknowledged204: 0 };
        binding['acknowledged' + status]++;
        if(Number.isSafeInteger(reply.targetIndex))output.targetHistogram[reply.targetIndex]=(output.targetHistogram[reply.targetIndex]??0)+1;
      }
      if(minute){minute.statusHistogram[status]=(minute.statusHistogram[status]??0)+1;minute.succeeded++;}
      result.succeeded++; school.succeeded++; bucket.succeeded++;
    }).catch(error => {
      if (error.httpStatus) result.statusHistogram[error.httpStatus] = (result.statusHistogram[error.httpStatus] || 0) + 1;
      result.failed++; school.failed++; bucket.failed++; const code = /^[A-Z_0-9]{1,64}$/.test(error.code ?? '') ? error.code : 'REQUEST_FAILED';
      if(minute)minute.failed++;
      result.failureCodes ??= {}; result.failureCodes[code] = (result.failureCodes[code] || 0) + 1;
    }).finally(() => { clearTimeout(timer); const elapsed = now() - started; result.timingsMs.push(elapsed);if(minute)minute.timingsMs.push(elapsed); bucket.timingsMs.push(elapsed); pending.delete(operation); });
    pending.add(operation); result.peakInFlight = Math.max(result.peakInFlight, pending.size);
  }
  if (now() < start + config.durationMs) await sleep(start + config.durationMs - now());
  result.offerWindowMs = now() - start; result.outstandingAtEndOfOffering = pending.size;
  await Promise.all([...pending]); result.totalIncludingDrainMs = now() - start; result.outstandingAfterDrain = pending.size;
  result.accepted = result.offered === config.expected && result.started === config.expected && result.succeeded === config.expected
    && !result.failed && !result.refusedAtInFlightLimit && !result.lateOffers && !pending.size;
  for(const minute of result.windows){minute.outstandingAfterDrain=0;minute.capabilityAcknowledgements200=minute.succeeded;
    minute.accepted=minute.offered===minute.expected&&minute.started===minute.expected&&minute.succeeded===minute.expected&&!minute.failed&&!minute.refusedAtInFlightLimit&&!minute.lateOffers;}
  return result;
}
export function summarize(values) {
  const rows = [...values].sort((a, b) => a - b); const at = fraction => rows.length ? rows[Math.min(rows.length - 1, Math.ceil(rows.length * fraction) - 1)] : null;
  return { count: rows.length, p50Ms: at(.5), p95Ms: at(.95), maxMs: rows.at(-1) ?? null };
}
export function sealTimings(result) {
  result.timings = summarize(result.timingsMs); delete result.timingsMs;
  for (const bucket of result.buckets) { bucket.timings = summarize(bucket.timingsMs); delete bucket.timingsMs; }
  for(const minute of result.windows??[])sealTimings(minute);
  return result;
}
