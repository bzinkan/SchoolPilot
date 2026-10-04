import assert from 'node:assert/strict';
import { pause } from './application.mjs';
import { stageForRound, profileHash } from './contracts.mjs';
import { cpuWindow, classifyLog, negativeProbes } from './measurements.mjs';
import { checkPersistence } from './persistence.mjs';
import { validateRound } from './validation.mjs';

// One continuous offering, with fixed-clock routing and actual process loss.
// Database observations are whole-run exact binding totals. They are never
// presented as minute-level rows inferred from client acknowledgement timing.
export async function runMixed({profile,active,startApi,stop,generator,observer,fixture,metrics,save,docker,readLog,pgContainerId,expiresAt}) {
  const since=new Date(Date.now()-86400_000).toISOString(), before=await observer.rpc('snapshot',{since});
  await Promise.all([...active.values()].map(owner=>owner.rpc('reset')));const startsAtMs=Date.now()+1500, windows=new Map(), terminal=new Map(), drains=[];
  const waitAt=async offset=>{await pause(Math.max(0,startsAtMs+offset-Date.now()));assert.ok(Date.now()<Date.parse(expiresAt),'Quiet window expired');};
  const scheduleWindows=(index,from,to)=>{
    const owner=active.get(index);
    for(let minute=from;minute<to;minute++) windows.set(`${index}:${minute}`,owner.rpc('measureWindow',{startsAtMs:startsAtMs+minute*60_000,durationMs:60_000},startsAtMs+(minute+1)*60_000-Date.now()+30_000)
      .catch(error=>({windowFailed:true,errorCode:error.code||'WINDOW_CAPTURE_FAILED'})));
  };
  const loss=profile.stages.find(stage=>stage.lost!==undefined);
  for(const index of active.keys())scheduleWindows(index,0,index===loss.lost?loss.fromRound:profile.rounds);
  const phase=generator.rpc('phase',{startsAtMs,offering:profile.continuousOffering,continuous:true,topology:stageForRound(0,profile),ingest:true,reports:false,lifecycle:true,reconnect:true},960_000);
  const topology=(async()=>{
    const initial=profile.stages[0];metrics.transitions.push({round:0,active:initial.active,distribution:initial.distribution,atOffsetMs:0});
    if(profile.warmNewApisAtMs!==undefined){
      await waitAt(profile.warmNewApisAtMs);
      const preparationStartedAt=new Date().toISOString();await startApi(1);await startApi(2);
      await Promise.all([active.get(1).rpc('reset'),active.get(2).rpc('reset')]);
      assert.ok(Date.now()<startsAtMs+300_000,'New serving targets were not ready before routing transition');
      metrics.backgroundApiPreparation={atOffsetMs:profile.warmNewApisAtMs,startedAt:preparationStartedAt,readyAt:new Date().toISOString(),offeredBeforeMinuteFive:0,
        resourceSnapshots:[active.get(1).resources.at(-1),active.get(2).resources.at(-1)]};
      scheduleWindows(1,5,profile.rounds);scheduleWindows(2,5,profile.rounds);
    }
    for(const stage of profile.stages.slice(1)){
      await waitAt(stage.fromRound*60_000);let removal={};
      if(stage.lost!==undefined){
        await windows.get(`${stage.lost}:${stage.fromRound-1}`);const owner=active.get(stage.lost);
        drains.push(await owner.rpc('drain'));terminal.set(stage.lost,await owner.rpc('snapshot'));
        const exit=await stop(owner);active.delete(stage.lost);assert.equal(exit.clean,true);
        removal={lostRole:'api'+stage.lost,cleanShutdown:exit.clean,exit};
      }
      metrics.transitions.push({round:stage.fromRound,active:stage.active,distribution:stage.distribution,atOffsetMs:stage.fromRound*60_000,...removal});
    }
  })();
  const settled=await Promise.allSettled([phase,topology]);
  if(settled.some(row=>row.status==='rejected'))throw Error('CONTINUOUS_MIXED_OPERATION_FAILED');
  const traffic=settled[0].value;assert.equal(traffic.heartbeats.windows.length,profile.rounds);
  for(const [index,owner] of active){drains.push(await owner.rpc('drain'));terminal.set(index,await owner.rpc('snapshot'));}
  const after=await observer.rpc('snapshot',{since}), persistence=checkPersistence(before,after,traffic,fixture);
  const actualCounts=[...terminal].map(([index,state])=>({index,count:state.http?.seenHeartbeatOffers}));
  const targetCounts=actualCounts.every(({index,count})=>count===(traffic.heartbeats.targetHistogram[index]??0)+(traffic.reconnect.targetHistogram[index]??0));
  const classroom=await observer.rpc('correctness',{classroom:true});
  const global={passed:traffic.heartbeats.accepted&&traffic.reconnect.accepted&&traffic.lifecycle.passed&&persistence.passed&&targetCounts&&classroom.passed,
    offered:traffic.heartbeats.offered,expected:profile.continuousOffering.expected,actualPersisted:persistence.total,
    acknowledged200:(traffic.heartbeats.statusHistogram[200]??0)+(traffic.reconnect.statusHistogram[200]??0),targetCounts,actualTargetCounts:actualCounts,
    persistence,drains,classroom,durationMs:traffic.heartbeats.offerWindowMs,reconnect:traffic.reconnect,traffic,windowsContinuous:true};
  assert.equal(global.offered,profile.continuousOffering.expected);assert.ok(Date.now()<Date.parse(expiresAt));metrics.continuous=global;
  const errorCoverage=[];
  // Every serving role has actual complete logs, even API0 lost at minute10.
  for(const [index] of terminal){const owner=index===0?null:active.get(index);const bytes=owner?await owner.logs():null;
    if(bytes!==null)errorCoverage.push({role:'api'+index,...classifyLog(bytes,'api',{complete:true,expectedNegativeProbes:negativeProbes(traffic)})});}
  const api0Exit=metrics.transitions.at(-1).exit;
  // The stopped owner's complete private log is returned by the run owner.
  errorCoverage.push({role:'api0',...classifyLog(readLog('api0'),'api',{complete:api0Exit.clean,expectedNegativeProbes:negativeProbes(traffic)})});
  errorCoverage.push(classifyLog(await docker(['logs',pgContainerId]),'postgres',{complete:true}));
  for(let minute=0;minute<profile.rounds;minute++){
    const stage=stageForRound(minute,profile), cpuByRole=[];
    for(const index of stage.active){const window=await windows.get(`${index}:${minute}`);cpuByRole.push({role:'api'+index,window,...cpuWindow(window)});}
    const perMinute=traffic.heartbeats.windows[minute],reconnect=minute===loss.fromRound?traffic.reconnect:null;
    const lifecycle=traffic.lifecycle.rounds[minute];
    const coverage=errorCoverage.filter(row=>row.kind==='postgres'||stage.active.some(index=>row.role==='api'+index));
    const round={index:minute,profile:profile.name,contractSha256:profileHash(profile),topology:stage,reconnect:minute===loss.fromRound,
      measuredWindowMs:60_000,cpuByRole,apiCpuMeanFraction:Math.max(...cpuByRole.map(row=>row.meanFraction)),
      traffic:{heartbeats:perMinute,reconnect,lifecycle},continuousGlobal:global,persistence, persisted:persistence.total,invalidBindings:after.invalid,
      drains,api:stage.active.map(index=>terminal.get(index)),errorCoverage:coverage,databaseFailures:coverage.reduce((sum,row)=>sum+row.errorCount,0)};
    round.acceptance=validateRound(round,profile);metrics.rounds.push(round);save(`round-${minute+1}.json`,round);
  }
  return global;
}
