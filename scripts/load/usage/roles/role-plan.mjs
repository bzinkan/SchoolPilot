import assert from 'node:assert/strict';
import {join} from 'node:path';
import {assertEnvironmentKeys} from './role-environment.mjs';
import {assertDisjointControlAndEvidence} from './host-file-io.mjs';
import {ROLE_LIMITS,POOL_LIMITS,PROFILE} from './profile.mjs';
export {ROLE_LIMITS,POOL_LIMITS};
export function rolePlan({role,run,source,imageId,pgContainerId,evidenceDirectory,controlDirectory,environmentKeys,environment,imageEnvironment=[],apiCpuProfile=false}){
 assert.ok(Object.hasOwn(ROLE_LIMITS,role));assert.match(run,/^[a-f0-9]{12}$/);assert.match(source,/^[a-f0-9]{40}$/);assert.match(imageId,/^sha256:[a-f0-9]{64}$/);assert.match(pgContainerId,/^[a-f0-9]{64}$/);
 for(const path of [evidenceDirectory,controlDirectory])assert.ok(typeof path==='string'&&path.length>0&&!/[\r\n,]/.test(path));
 assertDisjointControlAndEvidence(controlDirectory,evidenceDirectory);
 assert.ok(Array.isArray(environmentKeys)&&environmentKeys.every(key=>/^[A-Z_][A-Z_0-9]*$/.test(key)));
 assert.equal(new Set(environmentKeys).size,environmentKeys.length);
 assertEnvironmentKeys(environmentKeys);
 if(environment){assert.deepEqual(Object.keys(environment).sort(),[...environmentKeys].sort());assert.ok(Object.values(environment).every(value=>typeof value==='string'));}
 for(const key of environmentKeys)assert.ok(!/^(AWS_|DOCKER_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NODE_OPTIONS$)/.test(key));
 const limits=ROLE_LIMITS[role],name=`schoolpilot-role-${role}-${run}`;
 assert.equal(typeof apiCpuProfile,'boolean');
 assert.equal(apiCpuProfile,false,'This immutable default-runtime profile excludes CPU profiling');
 const profileArgs=[];
 const profilePath=join(evidenceDirectory,'api.cpuprofile');
 const entrypoint=['node'],command=['--import','/prototype/runtime-facts.mjs',...profileArgs,role==='coordinator'?'/prototype/role-coordinator.mjs':'/prototype/role-child-bootstrap.mjs'];
 const mounts=[{Type:'bind',Source:evidenceDirectory,Destination:'/evidence',RW:role==='coordinator'},
  {Type:'bind',Source:`${controlDirectory}/${role}-secrets`,Destination:'/role-secrets',RW:false},
  ...(profileArgs.length?[{Type:'bind',Source:profilePath,Destination:'/evidence/api.cpuprofile',RW:true}]:[]),
  ...(role==='coordinator'?[{Type:'bind',Source:`${controlDirectory}/host-receipts`,Destination:'/host-receipts',RW:false},{Type:'bind',Source:`${controlDirectory}/coordinator-requests`,Destination:'/coordinator-requests',RW:true}]:[])];
 const args=['create','--name',name,'--label',`codex.usage-scale=${run}`,'--label',`codex.usage-role=${role}`,'--label',`codex.usage-source=${source}`,'--label','codex.usage-prototype=unvalidated',
  '--network',`container:${pgContainerId}`,'--cpus',String(limits.cpu),'--memory',String(limits.memory),'--memory-swap',String(limits.memory),'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
  '--init','--no-healthcheck','--user','node','--workdir','/app','--mount',`type=bind,source=${evidenceDirectory},target=/evidence${role==='coordinator'?'':',readonly'}`,
  '--mount',`type=bind,source=${controlDirectory}/${role}-secrets,target=/role-secrets,readonly`, ...(role==='coordinator'?['--mount',`type=bind,source=${controlDirectory}/host-receipts,target=/host-receipts,readonly`,'--mount',`type=bind,source=${controlDirectory}/coordinator-requests,target=/coordinator-requests`]:[]),...(profileArgs.length?['--mount',`type=bind,source=${profilePath},target=/evidence/api.cpuprofile`]:[]),...environmentKeys.slice().sort().flatMap(key=>['--env',key]),
  '--entrypoint','node',imageId,...command];
 const plan={name,args,role,run,source,imageId,pgContainerId,entrypoint,command,mounts,caps:{nanoCpus:limits.cpu*1e9,memoryBytes:limits.memory,memorySwapBytes:limits.memory,heapMiB:null},profile:PROFILE,resourceAcceptance:false};
 if(environment){Object.defineProperty(plan,'environment',{value:Object.freeze({...environment}),enumerable:false});Object.defineProperty(plan,'imageEnvironment',{value:Object.freeze([...imageEnvironment]),enumerable:false});}return plan;
}
export function verifyRoleInspect(inspect,plan){
 assert.equal(inspect.Name,`/${plan.name}`);assert.match(inspect.Id,/^[a-f0-9]{64}$/);assert.equal(inspect.Config.Image,plan.imageId);assert.equal(inspect.Image,plan.runtimeConfigDigest);
 assert.equal(inspect.Config.Labels['codex.usage-scale'],plan.run);assert.equal(inspect.Config.Labels['codex.usage-role'],plan.role);assert.equal(inspect.Config.Labels['codex.usage-source'],plan.source);
 assert.equal(inspect.HostConfig.NetworkMode,`container:${plan.pgContainerId}`);assert.equal(inspect.HostConfig.NanoCpus,plan.caps.nanoCpus);assert.equal(inspect.HostConfig.Memory,plan.caps.memoryBytes);assert.equal(inspect.HostConfig.MemorySwap,plan.caps.memorySwapBytes);
 assert.equal(inspect.HostConfig.ReadonlyRootfs,true);assert.equal(inspect.Config.User,'node');assert.deepEqual(inspect.HostConfig.PortBindings,{});
 assert.equal(inspect.HostConfig.Privileged,false);assert.equal(inspect.HostConfig.PidMode,'');assert.equal(inspect.HostConfig.IpcMode,'private');
 assert.deepEqual(inspect.Config.Entrypoint,plan.entrypoint);assert.deepEqual(inspect.Config.Cmd,plan.command);assert.equal(inspect.Config.WorkingDir,'/app');
 assert.deepEqual(inspect.Config.Healthcheck?.Test,['NONE']);assert.equal(inspect.HostConfig.Init,true);assert.deepEqual(inspect.HostConfig.CapDrop,['ALL']);assert.deepEqual(inspect.HostConfig.CapAdd,null);
 assert.deepEqual(inspect.HostConfig.SecurityOpt,['no-new-privileges']);
 const mounts=inspect.Mounts.map(({Type,Source,Destination,RW})=>({Type,Source,Destination,RW})).sort((a,b)=>a.Destination.localeCompare(b.Destination));
 assert.deepEqual(mounts,[...plan.mounts].sort((a,b)=>a.Destination.localeCompare(b.Destination)));
 if(plan.environment){const parse=values=>Object.fromEntries(values.map(value=>{const index=value.indexOf('=');assert.ok(index>0);return[value.slice(0,index),value.slice(index+1)];}));const canonical=value=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));assert.ok(canonical(parse(inspect.Config.Env))===canonical({...parse(plan.imageEnvironment),...plan.environment}),'Exact role environment mismatch');}
 return {actual:true,role:plan.role,run:plan.run,source:plan.source,containerId:inspect.Id,imageId:inspect.Config.Image,runtimeConfigDigest:inspect.Image,pgContainerId:plan.pgContainerId,network:inspect.HostConfig.NetworkMode,
  caps:{nanoCpus:inspect.HostConfig.NanoCpus,memoryBytes:inspect.HostConfig.Memory,memorySwapBytes:inspect.HostConfig.MemorySwap,heapMiB:null},
  checks:{identity:true,command:true,mounts:true,environment:!!plan.environment,security:true,resources:true,network:true}};
}
export function verifyCgroupV2({cpuMax,memoryMax,memorySwapMax},role){
 const limits=ROLE_LIMITS[role];assert.ok(limits);const [quota,period]=cpuMax.trim().split(/\s+/).map(Number);assert.ok(Number.isFinite(quota)&&quota>0&&Number.isFinite(period)&&period>0);assert.equal(quota/period,limits.cpu);
 assert.equal(Number(memoryMax.trim()),limits.memory);assert.equal(Number(memorySwapMax.trim()),0);return true;
}
