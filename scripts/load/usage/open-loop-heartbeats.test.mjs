import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPEN_LOOP_HEARTBEATS, openLoopOffering, offerOpenLoopHeartbeats } from './open-loop-heartbeats.mjs';

test('100rps interleaves two schools and repeats each of 1000 devices every ten seconds', () => {
  const counts = new Map();
  for (let index = 0; index < 6_000; index++) {
    const offer = openLoopOffering(index), key = `${offer.schoolIndex}/${offer.deviceIndex}`;
    const previous = counts.get(key);
    if (previous) assert.equal(offer.offsetMs - previous.last, 10_000);
    counts.set(key, {count: (previous?.count ?? 0)+1, last: offer.offsetMs});
  }
  assert.equal(counts.size, 1_000); assert.ok([...counts.values()].every(row => row.count === 6));
  assert.deepEqual(openLoopOffering(0), {index:0,offsetMs:0,schoolIndex:0,deviceIndex:0});
  assert.deepEqual(openLoopOffering(999), {index:999,offsetMs:9990,schoolIndex:1,deviceIndex:499});
});

test('all independent offers proceed while every response is held', async () => {
  let clock = 0, calls = 0; const held = [];
  const result = await offerOpenLoopHeartbeats(() => new Promise(resolve => {
    calls++; held.push(resolve); if (calls === 10) held.forEach(done => done());
  }), {config:{...OPEN_LOOP_HEARTBEATS,durationMs:100,maxInFlight:20},now:()=>clock,sleep:async ms=>{clock+=ms;}});
  assert.equal(calls,10); assert.equal(result.succeeded,10); assert.equal(result.peakInFlight,10);
  assert.equal(result.offerWindowMs,90); assert.equal(result.accepted,true);
});

test('in-flight saturation is recorded without silently throttling offers', async () => {
  let clock = 0; const held = [];
  const result = await offerOpenLoopHeartbeats(() => new Promise(resolve=>held.push(resolve)), {
    config:{...OPEN_LOOP_HEARTBEATS,durationMs:50,maxInFlight:2}, now:()=>clock,
    sleep:async ms=>{clock+=ms; if(clock>=40) held.forEach(done=>done());},
  });
  assert.equal(result.offered,5); assert.equal(result.started,2); assert.equal(result.refusedAtInFlightLimit,3);
  assert.equal(result.accepted,false); assert.equal(result.outstandingAfterDrain,0);
});

test('delayed offers and request failures cannot become arrival-rate acceptance', async () => {
  let clock=0;
  const result=await offerOpenLoopHeartbeats(async offer=>{if(offer.index===2)throw new Error('fixture refusal');}, {
    config:{...OPEN_LOOP_HEARTBEATS,durationMs:50,maxOfferLatenessMs:1},now:()=>clock,sleep:async ms=>{clock+=ms+2;},
  });
  assert.equal(result.offered,5); assert.ok(result.lateOffers>0); assert.equal(result.failed,1); assert.equal(result.accepted,false);
});

test('bounded request cancellation drains held responses and retains failure evidence', async () => {
  const result=await offerOpenLoopHeartbeats((offer,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})), {
    config:{...OPEN_LOOP_HEARTBEATS,requestsPerSecond:1000,durationMs:1,requestTimeoutMs:5},
  });
  assert.equal(result.started,1); assert.equal(result.failed,1); assert.equal(result.accepted,false); assert.equal(result.outstandingAfterDrain,0);
});
