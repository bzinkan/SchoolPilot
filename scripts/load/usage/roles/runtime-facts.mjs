import assert from 'node:assert/strict';
import {readFileSync,writeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {getHeapStatistics,getHeapSpaceStatistics} from 'node:v8';
import {assertExecutionMode,PROFILE} from './profile.mjs';

export function installRuntimeFacts(runtime=process,{expectedNode,heap=getHeapStatistics,spaces=getHeapSpaceStatistics,
  emit=value=>writeSync(2,'USAGE_ROLE_RUNTIME '+JSON.stringify(value)+'\n'),
  sourceHash=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')}={}) {
  assert.equal(runtime.platform,'linux'); assert.equal(runtime.versions.node,expectedNode);
  assert.equal(runtime.env.NODE_OPTIONS,undefined);
  assert.match(runtime.env.USAGE_SOURCE_REVISION,/^[a-f0-9]{40}$/);
  assert.ok(['api','worker','generator','coordinator'].includes(runtime.env.USAGE_RELEASE_ROLE));
  const execution=assertExecutionMode({mode:runtime.env.USAGE_RELEASE_MODE,phase:runtime.env.USAGE_RELEASE_PHASE,
    cpuProfile:runtime.env.USAGE_RELEASE_CPU_PROFILE!=='false'});
  assert.equal(runtime.env.USAGE_RELEASE_DIAGNOSTIC,execution.diagnosticOnly?'true':'false');
  assert.deepEqual(runtime.execArgv,['--import','/prototype/runtime-facts.mjs']);
  const seen=new Set();
  const record=(stage,exitCode)=>{
    if(seen.has(stage))return;seen.add(stage); const h=heap();
    const fields=['total_heap_size','total_heap_size_executable','total_physical_size','total_available_size','used_heap_size','heap_size_limit','malloced_memory','peak_malloced_memory','external_memory'];
    const snapshot=Object.fromEntries(fields.map(key=>{assert.ok(Number.isSafeInteger(h[key])&&h[key]>=0);return[key,h[key]];}));
    const rows=spaces().map(s=>{assert.match(s.space_name,/^[a-z_]{1,64}$/);const row={space_name:s.space_name};for(const key of['space_size','space_used_size','space_available_size','physical_space_size']){assert.ok(Number.isSafeInteger(s[key])&&s[key]>=0);row[key]=s[key];}return row;});
    assert.ok(rows.length<=32);
    emit({schemaVersion:1,profile:PROFILE,source:runtime.env.USAGE_SOURCE_REVISION,role:runtime.env.USAGE_RELEASE_ROLE,stage,
      node:runtime.versions.node,v8:runtime.versions.v8,preloaderSha256:sourceHash,execArgv:[...runtime.execArgv],
      nodeOptionsPresent:false,oldSpaceOverrideMiB:null,heap:snapshot,spaces:rows,rssBytes:runtime.memoryUsage().rss,
      hrtimeMicroseconds:Number(runtime.hrtime.bigint()/1000n),...(exitCode===undefined?{}:{exitCode}),
      diagnosticOnly:execution.diagnosticOnly,capacityAccepted:false});
  };
  // Never inspect or serialize message.value. These are fixed harness operations.
  const onMessage=message=>{
    if(message?.operation==='reset')record('phase_reset');
    else if(message?.operation==='snapshot'&&seen.has('phase_reset'))record('phase_snapshot');
    else if(message?.operation==='phase')record('phase_start');
    else if(message?.operation==='shutdown')record('shutdown');
  };
  const onExit=code=>record('exit',code);
  record('startup');runtime.on('message',onMessage);runtime.on('exit',onExit);
  return()=>{runtime.removeListener('message',onMessage);runtime.removeListener('exit',onExit);};
}
if(process.execArgv.includes('/prototype/runtime-facts.mjs')) {
  const expected=JSON.parse(readFileSync('/prototype-tools/base-runtime.json','utf8'));
  installRuntimeFacts(process,{expectedNode:expected.versions.node});
}
