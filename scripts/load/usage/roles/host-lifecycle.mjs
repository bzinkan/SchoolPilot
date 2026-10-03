import assert from 'node:assert/strict';
import {verifyRoleInspect} from './role-plan.mjs';

const bindingOf=owner=>({containerId:owner.id,imageId:owner.plan.imageId,run:owner.plan.run,source:owner.plan.source,role:owner.plan.role});
export async function createOwnedRole(adapter,plan,register=()=>{}){
 assert.equal(await adapter.inspectName(plan.name),null,'Fresh owned role name required');
 let created;
 try{created=await adapter.create(plan.args,plan.environment);}catch{
  const found=await adapter.inspectName(plan.name);
  if(found){verifyRoleInspect(found,plan);const owner={plan,id:found.Id,creationConfirmed:false,launchFailed:true};register(owner);return owner;}
  throw new Error('OWNED_ROLE_CREATION_UNCONFIRMED');
 }
 assert.match(created,/^[a-f0-9]{64}$/);const owner={plan,id:created,creationConfirmed:true,launchFailed:false};register(owner);const found=await adapter.inspectId(created);owner.inspection=verifyRoleInspect(found,plan);assert.equal(found.Id,created);
 return owner;
}

export async function startOwnedRole(adapter,owner){
 owner.inspection=verifyRoleInspect(await adapter.inspectId(owner.id),owner.plan);assert.equal(owner.creationConfirmed,true);
 owner.logCompletion=adapter.startAndCapture(owner.id,owner.plan.role);owner.started=true;
 // Attach errors cannot become unhandled while wait/other roles are pending.
 owner.logCompletion.catch(()=>{});
 return owner;
}

// Receipt is published only after both daemon exit and actual log closure.
export async function collectExitReceipt(adapter,owner,{forced=false}={}){
 // Docker wait on a created-but-not-yet-started container can return zero.
 // Attach/log completion must settle before reading the daemon exit status.
 const logs=await owner.logCompletion;const code=await adapter.wait(owner.id);assert.ok(Number.isInteger(code));
 const ended=await adapter.inspectId(owner.id);verifyRoleInspect(ended,owner.plan);assert.equal(ended.Id,owner.id);assert.equal(ended.State.Running,false);assert.equal(ended.State.ExitCode,code);forced=forced||owner.forced===true;
 assert.equal(logs.closed,true);
 const receipt={...bindingOf(owner),inspected:true,running:false,logsClosed:true,exitCode:code,forced,oomKilled:ended.State.OOMKilled===true,
  attachExitCode:logs.code,clean:code===0&&logs.code===0&&!forced&&ended.State.OOMKilled!==true};
 await adapter.publishExit(owner.plan.role,receipt);owner.exitReceipt=receipt;return receipt;
}

export async function requestOwnedTermination(adapter,owner,signal){
 assert.ok(['TERM','KILL'].includes(signal));const current=await adapter.inspectId(owner.id);verifyRoleInspect(current,owner.plan);assert.equal(current.Id,owner.id);
 owner.forced=true;if(current.State.Running)await adapter.kill(owner.id,signal);
}

// This is containment evidence, not successful workload evidence. Every owned
// role is attempted even when another inspect/kill/remove fails.
export async function cleanupOwnedRoles(adapter,owners){
 const results=[];
 for(const owner of [...owners].reverse()){
  const result={...bindingOf(owner),cleanupPassed:false,forced:owner.forced===true};
  try{
   const current=await adapter.inspectId(owner.id);
   if(current===null){result.confirmedAbsent=true;result.cleanupPassed=true;result.cleanExit=owner.exitReceipt?.clean===true;results.push(result);continue;}
   verifyRoleInspect(current,owner.plan);assert.equal(current.Id,owner.id);
   if(current.State.Running){result.forced=true;await requestOwnedTermination(adapter,owner,'KILL');await adapter.wait(owner.id);}
   const stopped=await adapter.inspectId(owner.id);verifyRoleInspect(stopped,owner.plan);assert.equal(stopped.State.Running,false);
   if(owner.logCompletion){try{await (owner.logCompletion.closed||owner.logCompletion);result.logsClosed=true;}catch{result.logFailure=true;}}
   await adapter.remove(owner.id);assert.equal(await adapter.inspectId(owner.id),null);result.cleanupPassed=true;result.cleanExit=owner.exitReceipt?.clean===true&&!result.forced&&!result.logFailure;
  }catch{result.failure='OWNED_ROLE_CLEANUP_UNCONFIRMED';}
  results.push(result);
 }
 return {roles:results,cleanupPassed:results.every(row=>row.cleanupPassed),clean:results.every(row=>row.cleanExit===true&&!row.forced)};
}

