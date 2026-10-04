import assert from 'node:assert/strict';
import {stickyTarget,hash} from './contracts.mjs';

// Only actual successful pre-loss heartbeat bindings select the reconnect
// audience. The immutable profile predicts the set; it cannot invent ACKs.
export function lostReconnectBindings(samples,profile,startsAtMs){
  assert.equal(profile.broaderCapacityGate,true);assert.ok(Number.isFinite(startsAtMs));
  const loss=profile.stages.find(row=>row.reconnectLostOnly),prior=profile.stages.filter(row=>row.fromRound<loss.fromRound).at(-1);
  assert.equal(prior.distribution,'sticky80');const expected=profile.offering.schoolDevices.reduce((a,b)=>a+b,0);
  assert.equal(samples.length,expected);const keys=new Set(),schools=[[],[]];
  for(const sample of samples){
    assert.ok([0,1].includes(sample.schoolIndex));assert.ok(Number.isSafeInteger(sample.deviceIndex)&&sample.deviceIndex>=0&&sample.deviceIndex<profile.offering.schoolDevices[sample.schoolIndex]);
    const key=`${sample.schoolIndex}:${sample.deviceIndex}`;assert.equal(keys.has(key),false);keys.add(key);
    assert.ok(sample.observedAtMs>=startsAtMs+prior.fromRound*60_000&&sample.observedAtMs<startsAtMs+loss.fromRound*60_000);
    assert.equal(sample.targetIndex,stickyTarget(sample.schoolIndex*500+sample.deviceIndex,prior.active,prior.distribution));
    if(sample.targetIndex===loss.lost)schools[sample.schoolIndex].push(sample);
  }
  for(const school of schools)school.sort((a,b)=>a.deviceIndex-b.deviceIndex);
  assert.deepEqual(schools.map(row=>row.length),loss.reconnectSchoolDevices);assert.equal(schools.flat().length,loss.reconnectOffers);
  return{schools,observedSamples:samples,startsAtMs,observedBindings:expected,lostBindings:loss.reconnectOffers,lostTarget:loss.lost,
    reconnectTarget:loss.reconnectTarget??null,reconnectDistribution:loss.distribution,
    observedBindingSha256:hash(JSON.stringify([...samples].sort((a,b)=>a.schoolIndex-b.schoolIndex||a.deviceIndex-b.deviceIndex))),sameUnlostBindingsPreserved:true};
}
