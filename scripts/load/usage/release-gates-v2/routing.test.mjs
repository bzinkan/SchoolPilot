import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {patchGeneratorV2} from './patch.mjs';
import {PROFILES,stageForRound,stickyTarget} from './contracts.mjs';
import {topologyForOffer,expectedTargetsBefore,waitForHeartbeatOwnership} from './routing.mjs';
import {targetFor} from './offering.mjs';
import {validatePhysicalLoss} from './validation.mjs';
import {retainBoundarySettled} from './boundary-preparation.mjs';
const generated=patchGeneratorV2(readFileSync(new URL('../release-enabled-generator.mjs',import.meta.url),'utf8'));
export function generatedEndpoint(generatedSource,wallOffsetMs){
 const body=generatedSource.match(/const endpointFor = [\s\S]+?\n};/)[0];
 return Function('assert','v2Profile','stageForRound','stickyTarget','topologyForOffer','apiBases','continuousStartsAtMs','topology','Date',body+'\nreturn endpointFor;')
  (assert,PROFILES.mixedNative,stageForRound,stickyTarget,topologyForOffer,['api0','api1','api2'],1_000_000,{active:[0],distribution:'uniform'},{now:()=>1_000_000+wallOffsetMs});
}
export function generatedHeartbeat(generatedSource,wallOffsetMs,calls){
 const endpointFor=generatedEndpoint(generatedSource,wallOffsetMs),body=generatedSource.slice(generatedSource.indexOf('async function heartbeat('),generatedSource.indexOf('export function assertHistoricalReport'));
 return Function('assert','endpointFor','request','COLD_OPEN_LOOP_PROFILE','heartbeatStatuses','apiBases','continuousStartsAtMs','v2Profile','observedStickyBindings','topologyForOffer','Date',body+'\nreturn heartbeat;')
  (assert,endpointFor,async(path,value)=>{calls.push({path,...value});return{status:200,body:{acceptedCapabilities:['preciseRestrictionResourcesV1','focusTabV1','privateChatLifecycleV1']}};},
   {classPilot:{capabilities:['preciseRestrictionResourcesV1','focusTabV1','privateChatLifecycleV1']}},{},['api0','api1','api2'],1_000_000,PROFILES.mixedNative,new Map(),topologyForOffer,{now:()=>1_000_000+wallOffsetMs});
}
test('actual generated heartbeat wrapper retains signal token body and nominal boundary',async()=>{
 const calls=[],school={index:0,tokens:Array.from({length:133},(_,i)=>'token-'+i)},signal=new AbortController().signal;
 await generatedHeartbeat(generated,599999,calls)(school,0,signal,false,600000);
 await generatedHeartbeat(generated,600024,calls)(school,132,signal,false,600000-1000/13.3);
 await generatedHeartbeat(generated,600024,calls)(school,0,signal);
 assert.deepEqual(calls.map(row=>row.endpoint),['api1','api0','api1']);
 assert.deepEqual(calls.map(row=>row.token),['token-0','token-132','token-0']);
 assert.ok(calls.every(row=>row.signal===signal&&row.path==='/api/classpilot/device/heartbeat'&&row.body.extensionVersion==='2.9.7'&&row.body.clientProtocolVersion===3));
});
test('actual generated ordinary wrapper owns exact boundary despite wall rounding',()=>{
 const route=generatedEndpoint(generated,599999),school={index:0};
 assert.equal(route(school,0,600000),'api1');
 assert.match(generated,/false, offer\.offsetMs, offer\.actualDispatchOffsetMs\), \{ config, startsAtMs:rpc\.value\.startsAtMs \}/);
 assert.match(generated,/actualEndpoint=endpointFor\(school,index,offeringOffsetMs\)/);
});
test('late prior-boundary dispatch retains nominal old target and live lifecycle omits offset',()=>{
 const route=generatedEndpoint(generated,600024),school={index:0};
 assert.equal(route(school,132,600000-1000/13.3),'api0');
 assert.equal(route(school,0),'api1');
 assert.equal(generatedEndpoint(generated,599999)(school,0),'api0');
});
test('exact loss minute generated wrappers keep798ordinary and133reconnect targets separate',async()=>{
 const ordinary={},extra={},calls=[],heartbeat=generatedHeartbeat(generated,599999,calls),school={index:0,tokens:Array.from({length:133},(_,i)=>'token-'+i)};
 for(let index=0;index<798;index++){const offer=targetFor(index,PROFILES.mixedNative.offering),reply=await heartbeat(school,offer.deviceIndex,undefined,false,600000+offer.offsetMs);ordinary[reply.targetIndex]=(ordinary[reply.targetIndex]??0)+1;}
 for(let index=0;index<133;index++){const reply=await heartbeat(school,index,undefined,true,601000+index*10000/133);extra[reply.targetIndex]=(extra[reply.targetIndex]??0)+1;}
 assert.deepEqual(ordinary,{1:402,2:396});assert.deepEqual(extra,{1:67,2:66});assert.equal(calls.length,931);
 assert.match(generated,/signal,true,rpc\.value\.continuous\?stage\.fromRound\*60_000\+stage\.reconnectStartDelayMs\+offer\.offsetMs:undefined/);
});
test('nominal topology rejects missing invalid and out-of-run offsets',()=>{
 for(const offset of [undefined,NaN,-1,900000])assert.throws(()=>topologyForOffer(PROFILES.mixedNative,offset));
 assert.equal(Object.values(expectedTargetsBefore(PROFILES.mixedNative,600000)).reduce((a,b)=>a+b,0),7980);
});
test('physical ownership waits for late arrival and retains actual timestamps',async()=>{
 let clock=600000,count=106;const owner={rpc:async()=>({http:{seenHeartbeatOffers:count++}})};
 const proof=await waitForHeartbeatOwnership(owner,107,{deadlineMs:620000,now:()=>clock,pause:async ms=>{clock+=ms;}});
 assert.equal(proof.observed,107);assert.equal(proof.actualServerOwnership,true);assert.equal(proof.observations.length,2);assert.equal(proof.completedAtMs,600010);
});
test('missing over-count expired and unresolved physical ownership reject',async()=>{
 for(const state of [{},{http:{seenHeartbeatOffers:108}}])await assert.rejects(waitForHeartbeatOwnership({rpc:async()=>state},107,{deadlineMs:10,now:()=>0,pause:async()=>{}}));
 let clock=0;await assert.rejects(waitForHeartbeatOwnership({rpc:async()=>({http:{seenHeartbeatOffers:106}})},107,{deadlineMs:20,now:()=>clock,pause:async ms=>{clock+=ms;}}),{code:'LOSS_INGRESS_HANDOFF_TIMEOUT'});
 await assert.rejects(waitForHeartbeatOwnership({rpc:async()=>{throw Error('capture failed');}},107,{deadlineMs:20,now:()=>0,pause:async()=>{}}));
});
test('independent mixed closure rejects missing extra and late physical handoff',()=>{
 const profile=PROFILES.mixedNative,epoch=1_000_000,expected=expectedTargetsBefore(profile,600000)[0];
 const valid={continuous:{traffic:{heartbeats:{declaredStartedAtMs:epoch}}},transitions:[{round:10,lostRole:'api0',cleanShutdown:true,
  ingressHandoff:{expected,observed:expected,actualServerOwnership:true,startedAtMs:epoch+600000,completedAtMs:epoch+600050,
   observations:[{atMs:epoch+600050,count:expected}]},shutdownCompletedAtMs:epoch+600100}]};
 assert.equal(validatePhysicalLoss(valid,profile),true);
 for(const change of [row=>delete row.transitions[0].ingressHandoff,row=>row.transitions[0].ingressHandoff.observed++,
  row=>row.transitions[0].ingressHandoff.expected--,row=>row.transitions[0].ingressHandoff.startedAtMs--,
  row=>row.transitions[0].ingressHandoff.observations[0].count++,row=>row.transitions[0].ingressHandoff.completedAtMs=epoch+601000,
  row=>row.transitions[0].shutdownCompletedAtMs=epoch+601000]){const invalid=structuredClone(valid);change(invalid);assert.throws(()=>validatePhysicalLoss(invalid,profile));}
});
test('short boundary RPC is admitted only as a guarded preparation operation',()=>{
 const entry=readFileSync(new URL('./role-entry.mjs',import.meta.url),'utf8');
 assert.match(entry,/queryPlans', 'boundaryProof'\]\.includes\(request\.operation\)/);
 const handler=generated.slice(generated.indexOf("rpc.operation === 'boundaryProof'"),generated.indexOf("rpc.operation === 'phase'",generated.indexOf("rpc.operation === 'boundaryProof'")));
 assert.match(handler,/assert\.equal\(v2Profile\.preparationOnly,true\)/);assert.match(handler,/assert\.equal\(rpc\.value\.preparationOnly,true\)/);
 assert.match(handler,/durationMs:window\.durationMs,expected:266/);
 const run=readFileSync(new URL('./run.mjs',import.meta.url),'utf8');assert.match(run,/if\(profile\.preparationOnly\)assert\.equal\(options\.preparationSmoke,true/);
});
test('generated short boundary guard refuses measured profiles before issuing requests',async()=>{
 const body=generated.slice(generated.indexOf("rpc.operation === 'boundaryProof') {")+"rpc.operation === 'boundaryProof') {".length,
  generated.indexOf("    } else if (rpc.operation === 'phase')",generated.indexOf("rpc.operation === 'boundaryProof'")));
 const invoke=Function('assert','v2Profile','rpc','return(async()=>{'+body+'})();');
 await assert.rejects(invoke(assert,PROFILES.mixedNative,{value:{preparationOnly:true}}));
 await assert.rejects(invoke(assert,PROFILES.boundaryPreparation,{value:{preparationOnly:false}}));
});
test('short failed topology preserves fulfilled traffic before rejecting and sanitizes failure',()=>{
 const traffic={heartbeats:{offered:266},reconnect:{offered:133}},saved=[];
 const actual=retainBoundarySettled([{status:'fulfilled',value:traffic},{status:'rejected',reason:{code:'private arbitrary failure'}}],(name,value)=>saved.push({name,value}));
 assert.equal(actual,traffic);assert.equal(saved[0].name,'boundary-traffic.json');assert.equal(saved[0].value,traffic);
 assert.deepEqual(saved[1],{name:'boundary-physical-failure.json',value:{passed:false,code:'BOUNDARY_PHYSICAL_HANDOFF_FAILED',preparationOnly:true}});
});
