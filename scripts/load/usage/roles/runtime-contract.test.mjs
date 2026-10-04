import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {patchProfile,patchCoordinator,patchProcess,patchGenerator} from './patch-coordinator.mjs';
import {proveActualPool} from './pool-readiness.mjs';
import {installRuntimeFacts} from './runtime-facts.mjs';
import {assertExecutionMode} from './profile.mjs';
import {validateRelease} from './measurement-gate.mjs';

test('exact current canonical harness produces parseable source-bound overlay without changing offered traffic',()=>{
  const directory=mkdtempSync(join(tmpdir(),'schoolpilot-role-patch-'));
  try{for(const[name,patch]of[['release-enabled-profile.mjs',patchProfile],['release-enabled-scale.mjs',x=>patchCoordinator(x).text],['release-enabled-process.mjs',patchProcess],['release-enabled-generator.mjs',patchGenerator]]){
    const source=readFileSync(new URL('../'+name,import.meta.url),'utf8'),out=patch(source),file=join(directory,name);
    writeFileSync(file,out);execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
    const anchor=name==='release-enabled-profile.mjs'?'export function releaseTrafficOptions(env) {':name==='release-enabled-generator.mjs'?"assert.ok([200, 204].includes(result.status), `Heartbeat HTTP ${result.status}`);":"import assert from 'node:assert/strict';";
    assert.throws(()=>patch(source.replace(anchor,'')));
  }}finally{rmSync(directory,{recursive:true});}
});
test('full role traffic bypasses only legacy diagnostic shortening, never thresholds or CPU profile',()=>{
  const source=readFileSync(new URL('../release-enabled-profile.mjs',import.meta.url),'utf8'),text=patchProfile(source);
  const start=text.indexOf('export function releaseTrafficOptions(env) {');
  const next=text.indexOf('\nexport ',start+7),body=text.slice(start,next<0?undefined:next);
  const run=Function('assert',body.replace('export function','return function'))(assert);
  for(const mode of['diagnostic','capacity-candidate']){
    const env={USAGE_RELEASE_ROLE_CONTAINERS:'true',USAGE_RELEASE_MODE:mode,USAGE_RELEASE_CPU_PROFILE:'false',USAGE_RELEASE_PHASE:'combined',USAGE_RELEASE_DIAGNOSTIC:mode==='diagnostic'?'true':'false'};
    assert.deepEqual(run(env),{});assert.throws(()=>run({...env,USAGE_RELEASE_CPU_PROFILE:'true'}));
    if(mode==='capacity-candidate')assert.throws(()=>run({...env,USAGE_RELEASE_PHASE:'ingest'}));
  }
  assert.deepEqual(run({USAGE_RELEASE_DIAGNOSTIC:'true'}),{durationMs:10000});
  assert.equal(text.slice(text.indexOf('export function capacityAcceptance'),text.indexOf('export function releaseTrafficOptions')),source.slice(source.indexOf('export function capacityAcceptance'),source.indexOf('export function releaseTrafficOptions')));
});
test('modern generator rejects all204 and counts only200 responses with every enabling capability',async()=>{
  const source=readFileSync(new URL('../release-enabled-generator.mjs',import.meta.url),'utf8'),text=patchGenerator(source);
  assert.ok(source.includes('assert.ok([200, 204].includes(result.status)'));
  const start=text.indexOf('async function heartbeat('),end=text.indexOf('\nexport function assertHistoricalReport',start);
  const declaration=text.match(/const REQUIRED_MODERN_HEARTBEAT_CAPABILITIES = Object.freeze\((\[[^;]+\])\);/)[1];
  const capabilities=JSON.parse(declaration.replaceAll("'",'"'));
  const factory=Function('assert','request','COLD_OPEN_LOOP_PROFILE',`let heartbeatStatuses={},heartbeatCapabilityResponses=0;const REQUIRED_MODERN_HEARTBEAT_CAPABILITIES=${JSON.stringify(capabilities)};${text.slice(start,end)};return{heartbeat,proof:()=>({heartbeatStatuses,heartbeatCapabilityResponses})};`);
  const make=result=>factory(assert,async()=>result,{classPilot:{capabilities}}),school={tokens:['synthetic']};
  const good=make({status:200,body:{acceptedCapabilities:[...capabilities]}});await good.heartbeat(school,0);assert.equal(good.proof().heartbeatCapabilityResponses,1);
  for(const status of[204,401,409,500]){const bad=make({status,body:{acceptedCapabilities:capabilities}});await assert.rejects(()=>bad.heartbeat(school,0,undefined,true));assert.equal(bad.proof().heartbeatCapabilityResponses,0);assert.equal(bad.proof().heartbeatStatuses[status],1);}
  for(const capability of capabilities){const bad=make({status:200,body:{acceptedCapabilities:capabilities.filter(x=>x!==capability)}});await assert.rejects(()=>bad.heartbeat(school,0));assert.equal(bad.proof().heartbeatCapabilityResponses,0);}
});
test('current-day expectation binds raw rows to exact same school persistence before rollup',()=>{
  const text=patchCoordinator(readFileSync(new URL('../release-enabled-scale.mjs',import.meta.url),'utf8')).text;
  const start=text.indexOf('const persistedRows=phase.persistedAfter.filter'),end=text.indexOf('\n      currentDayWorkers.push',start);
  const proof=Function('assert','phase','school','raw','fixtureViolations',text.slice(start,end)+';return verification;');
  const phase={persistedAfter:[{school_id:'first',count:3006},{school_id:'second',count:3005}]},raw=Array(3006).fill({});
  assert.equal(proof(assert,phase,{index:0,id:'first'},raw,{}).rawObservationCount,3006);
  assert.throws(()=>proof(assert,phase,{index:0,id:'second'},raw,{}));
  assert.throws(()=>proof(assert,{persistedAfter:[]},{index:0,id:'first'},raw,{}));
  assert.throws(()=>proof(assert,{persistedAfter:[...phase.persistedAfter,{school_id:'first',count:3006}]},{index:0,id:'first'},raw,{}));
});
function pool(name,override={}){let acquisitions=0,queries=0,releases=0;const worker=name==='worker';return{
  options:{max:{api:16,session:2,worker:5}[name],connectionTimeoutMillis:worker?10000:5000,statement_timeout:worker?60000:15000},
  async connect(){acquisitions++;return{async query(sql){queries++;assert.ok(sql.includes('current_user = session_user'));if(override.throw)throw override.throw;return{rows:[{same_role:true,rolsuper:false,rolbypassrls:false,application_name:'fixed',school:null,is_super:worker?'on':'off',...override}]};},release(){releases++;}};},
  counts:()=>({acquisitions,queries,releases}),
};}
for(const name of['api','session','worker'])test(`actual ${name} readiness uses exactly one public acquisition and release`,async()=>{
  const p=pool(name),proof=await proveActualPool(p,{name,max:p.options.max,applicationName:'fixed',worker:name==='worker'});
  assert.deepEqual(p.counts(),{acquisitions:1,queries:1,releases:1});assert.equal(proof.acquisitionCalls,1);assert.equal(proof.databaseBypassRls,false);
});
for(const override of[{same_role:false},{rolsuper:true},{rolbypassrls:true},{school:'other'},{is_super:'on'},{application_name:'other'},{throw:new Error('query')}])test('readiness rejects mismatched role/context and retains client cleanup '+Object.keys(override)[0],async()=>{
  const p=pool('api',override);await assert.rejects(()=>proveActualPool(p,{name:'api',max:16,applicationName:'fixed'}));assert.deepEqual(p.counts(),{acquisitions:1,queries:1,releases:1});
});
test('configured pool and statement deadlines cannot be silently enlarged',async()=>{
  for(const key of['max','connectionTimeoutMillis','statement_timeout']){const p=pool('api');p.options[key]++;await assert.rejects(()=>proveActualPool(p,{name:'api',max:16,applicationName:'fixed'}));assert.equal(p.counts().acquisitions,0);}
});
test('runtime facts record fixed numeric stages only and preserve actual candidate default flags',()=>{
  const runtime=new EventEmitter();Object.assign(runtime,{platform:'linux',versions:{node:'22.23.3',v8:'fixed'},env:{USAGE_SOURCE_REVISION:'a'.repeat(40),USAGE_RELEASE_ROLE:'api',USAGE_RELEASE_MODE:'diagnostic',USAGE_RELEASE_PHASE:'combined',USAGE_RELEASE_DIAGNOSTIC:'true',USAGE_RELEASE_CPU_PROFILE:'false'},execArgv:['--import','/prototype/runtime-facts.mjs'],memoryUsage:()=>({rss:123}),hrtime:{bigint:()=>1n}});
  const heap=()=>Object.fromEntries(['total_heap_size','total_heap_size_executable','total_physical_size','total_available_size','used_heap_size','heap_size_limit','malloced_memory','peak_malloced_memory','external_memory'].map(key=>[key,123]));
  const rows=[],restore=installRuntimeFacts(runtime,{expectedNode:'22.23.3',heap,spaces:()=>[],emit:x=>rows.push(x),sourceHash:'b'.repeat(64)});
  runtime.emit('message',{operation:'snapshot',value:{secret:'never'}});runtime.emit('message',{operation:'reset',value:{secret:'never'}});runtime.emit('message',{operation:'snapshot',value:{secret:'never'}});runtime.emit('exit',0);
  assert.deepEqual(rows.map(x=>x.stage),['startup','phase_reset','phase_snapshot','exit']);assert.equal(JSON.stringify(rows).includes('secret'),false);assert.equal(rows[0].oldSpaceOverrideMiB,null);restore();
  assert.throws(()=>installRuntimeFacts({...runtime,env:{...runtime.env,NODE_OPTIONS:'--max-old-space-size=512'}},{expectedNode:'22.23.3'}));
});
test('mode and release marker bind exact source/image/profile/harness before cold restart',()=>{
  assert.equal(assertExecutionMode({mode:'diagnostic',phase:'combined'}).capacityAccepted,false);
  assert.throws(()=>assertExecutionMode({mode:'capacity-candidate',phase:'ingest'}));
  const ready={schemaVersion:2,nonce:'nonce',run:'run',source:'source',imageId:'image',bindingSha256:'binding',profile:'profile',mode:'diagnostic',phase:'combined'};
  const release={...ready,action:'release-role-measurement',diagnosticOnly:true,capacityAccepted:false};validateRelease(ready,release);
  for(const key of['nonce','run','source','imageId','bindingSha256','profile','mode','phase'])assert.throws(()=>validateRelease(ready,{...release,[key]:'changed'}));
  assert.throws(()=>validateRelease(ready,{...release,capacityAccepted:true}));
  const candidate={...ready,mode:'capacity-candidate'};
  validateRelease(candidate,{...candidate,action:'release-role-measurement',diagnosticOnly:false,capacityAccepted:false});
  assert.throws(()=>validateRelease(candidate,{...candidate,action:'release-role-measurement',diagnosticOnly:true,capacityAccepted:false}));
});
