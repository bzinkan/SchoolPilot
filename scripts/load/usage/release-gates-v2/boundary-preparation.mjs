import assert from 'node:assert/strict';
import {pause} from './application.mjs';
import {checkPersistence} from './persistence.mjs';
import {expectedTargetsBefore,waitForHeartbeatOwnership} from './routing.mjs';

export function retainBoundarySettled(settled,save) {
  const traffic=settled[0].status==='fulfilled'?settled[0].value:null;
  if(traffic)save('boundary-traffic.json',traffic);
  if(settled[1].status==='fulfilled')save('boundary-physical.json',settled[1].value);
  else save('boundary-physical-failure.json',{passed:false,code:'BOUNDARY_PHYSICAL_HANDOFF_FAILED',preparationOnly:true});
  return traffic;
}

// A declared20-second slice is a physical wiring proof, never a900-second run.
export async function runBoundaryPreparation({profile,active,stop,generator,observer,fixture,docker,save}) {
  assert.equal(profile.preparationOnly,true);
  const window=profile.boundaryWindow,loss=profile.stages.find(row=>row.lost!==undefined),since=new Date(Date.now()-86400_000).toISOString();
  assert.deepEqual([...active.keys()],[0,1,2]);
  const before=await observer.rpc('snapshot',{since});await Promise.all([...active.values()].map(owner=>owner.rpc('reset')));
  const startsAtMs=Date.now()+1500,lossAtMs=startsAtMs+loss.fromRound*60_000-window.fromOffsetMs,reconnectAtMs=startsAtMs+window.reconnectOffsetMs-window.fromOffsetMs;
  const beforeStart=expectedTargetsBefore(profile,window.fromOffsetMs),beforeLoss=expectedTargetsBefore(profile,loss.fromRound*60_000),expectedPreLoss=beforeLoss[0]-beforeStart[0];
  const trafficOperation=generator.rpc('boundaryProof',{startsAtMs,preparationOnly:true},120_000);
  const lossOperation=(async()=>{
    while(Date.now()<lossAtMs)await pause(Math.max(1,lossAtMs-Date.now()));
    const owner=active.get(0),handoff=await waitForHeartbeatOwnership(owner,expectedPreLoss,{deadlineMs:lossAtMs+profile.offering.requestTimeoutMs});
    const drain=await owner.rpc('drain');assert.equal(drain.complete,true);
    const terminal=await owner.rpc('snapshot'),exit=await stop(owner);active.delete(0);assert.equal(exit.clean,true);
    assert.equal((await docker(['container','ls','--all','--no-trunc','--filter','id='+owner.id,'--format','{{.ID}}'])).trim(),'');
    const absentAtMs=Date.now();assert.ok(absentAtMs<reconnectAtMs,'Lost API was not absent before reconnect offerings');
    return{lossAtMs,reconnectAtMs,handoff,drain,exit,terminalHeartbeatCount:terminal.http?.seenHeartbeatOffers,absentAtMs,confirmedAbsent:true};
  })();
  const settled=await Promise.allSettled([trafficOperation,lossOperation]);
  const partialTraffic=retainBoundarySettled(settled,save);
  if(settled.some(row=>row.status==='rejected'))throw Object.assign(new Error('Boundary preparation failed'),{code:'BOUNDARY_PREPARATION_FAILED',boundaryTraffic:partialTraffic});
  const traffic=settled[0].value,physical=settled[1].value,drains=await Promise.all([...active.values()].map(owner=>owner.rpc('drain')));
  const snapshots=await Promise.all([...active.values()].map(async owner=>({role:owner.role,state:await owner.rpc('snapshot')}))),after=await observer.rpc('snapshot',{since}),persistence=checkPersistence(before,after,traffic,fixture);
  assert.equal(traffic.heartbeats.expected,266);assert.equal(traffic.heartbeats.offered,266);assert.equal(traffic.heartbeats.succeeded,266);assert.equal(traffic.heartbeats.accepted,true);
  assert.equal(traffic.reconnect.expected,133);assert.equal(traffic.reconnect.offered,133);assert.equal(traffic.reconnect.succeeded,133);assert.equal(traffic.reconnect.accepted,true);
  assert.deepEqual(traffic.heartbeats.targetHistogram,{0:107,1:80,2:79});assert.deepEqual(traffic.reconnect.targetHistogram,{1:67,2:66});
  assert.equal(physical.terminalHeartbeatCount,107);assert.deepEqual(snapshots.map(row=>row.state.http?.seenHeartbeatOffers),[147,145]);
  assert.ok(traffic.reconnect.actualStartedAtMs>=reconnectAtMs&&physical.absentAtMs<traffic.reconnect.actualStartedAtMs);
  assert.equal(persistence.passed,true);assert.equal(persistence.total,(traffic.heartbeats.statusHistogram[200]??0)+(traffic.reconnect.statusHistogram[200]??0));
  assert.ok(drains.every(row=>row.complete));
  return{passed:true,preparationOnly:true,capacityAcceptance:false,logicalOffsetFromMs:window.fromOffsetMs,actualDurationMs:window.durationMs,
    traffic,physical,persistence,drains,actualTargetCounts:{0:107,1:147,2:145},observedBindingViolations:after.invalid};
}
