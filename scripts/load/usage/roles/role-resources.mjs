import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyCgroupV2} from './role-plan.mjs';
const parse=value=>Object.fromEntries(value.trim().split(/\n+/).map(line=>{const[key,raw]=line.trim().split(/\s+/);const n=Number(raw);assert.ok(Number.isSafeInteger(n)&&n>=0);return[key,n];}));
export function readRoleResources(binding,{read=path=>readFileSync(path,'utf8'),now=()=>Number(process.hrtime.bigint()/1000n),rss=()=>process.memoryUsage().rss}={}){
 const file=name=>read(`/sys/fs/cgroup/${name}`);const cpuMax=file('cpu.max'),memoryMax=file('memory.max'),memorySwapMax=file('memory.swap.max');verifyCgroupV2({cpuMax,memoryMax,memorySwapMax},binding.role);
 const cpu=parse(file('cpu.stat')),memoryEvents=parse(file('memory.events'));
 for(const key of ['usage_usec','user_usec','system_usec','nr_periods','nr_throttled','throttled_usec'])assert.ok(Number.isSafeInteger(cpu[key]),`Missing cgroup CPU counter ${key}`);
 for(const key of ['oom','oom_kill','high','max'])assert.ok(Number.isSafeInteger(memoryEvents[key]),`Missing cgroup memory counter ${key}`);
 const current=Number(file('memory.current').trim()),peak=Number(file('memory.peak').trim());assert.ok(Number.isSafeInteger(current)&&current>=0&&Number.isSafeInteger(peak)&&peak>=current);
 return {schemaVersion:1,role:binding.role,containerId:binding.containerId,source:binding.source,imageId:binding.imageId,runtimeSha256:binding.runtimeSha256,harnessSha256:binding.harnessSha256,
  hrtimeMicroseconds:now(),cpuMax:cpuMax.trim(),memoryMax:Number(memoryMax.trim()),memorySwapMax:Number(memorySwapMax.trim()),cpu,memory:{current,peak,events:memoryEvents},rssBytes:rss()};
}
export function verifyResourceSnapshot(value,binding){
 assert.equal(value.schemaVersion,1);for(const key of ['role','containerId','source','imageId','runtimeSha256','harnessSha256'])assert.equal(value[key],binding[key]);
 verifyCgroupV2({cpuMax:value.cpuMax,memoryMax:String(value.memoryMax),memorySwapMax:String(value.memorySwapMax)},binding.role);
 assert.ok(Number.isFinite(value.hrtimeMicroseconds));return value;
}
export function resourceDelta(before,after){
 for(const key of ['role','containerId','source','imageId','runtimeSha256','harnessSha256','cpuMax','memoryMax','memorySwapMax'])assert.equal(before[key],after[key]);
 assert.ok(after.hrtimeMicroseconds>=before.hrtimeMicroseconds);const delta={};for(const [key,value]of Object.entries(before.cpu)){assert.ok(after.cpu[key]>=value);delta[key]=after.cpu[key]-value;}
 const events={};for(const [key,value]of Object.entries(before.memory.events)){assert.ok(after.memory.events[key]>=value);events[key]=after.memory.events[key]-value;}
 return {durationMicroseconds:after.hrtimeMicroseconds-before.hrtimeMicroseconds,cpu:delta,memoryEvents:events,memoryPeakBytes:after.memory.peak,resourceAcceptance:false};
}
