import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createOwnedRole,startOwnedRole,collectExitReceipt,requestOwnedTermination,cleanupOwnedRoles} from './host-lifecycle.mjs';
const CHILDREN=['api','worker','generator'];
const keys=value=>Object.keys(value).sort().join(',');
export async function runRoleContainers({adapter,io,plans,runtimeSha256,harnessHashes,mode='startup',now=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),nonce=()=>randomBytes(32).toString('hex')}){
 assert.ok(['startup','combined'].includes(mode));
 assert.deepEqual(plans.map(row=>row.role).sort(),[...CHILDREN,'coordinator'].sort());
 const first=plans[0];for(const plan of plans){assert.ok(plan.environment,'Exact private role environment is required');for(const key of ['run','source','imageId','pgContainerId'])assert.equal(plan[key],first[key]);}assert.match(runtimeSha256,/^[a-f0-9]{64}$/);
 const owners=[],monitors=[],states=new Map();let failure,registry,cleanup;const startedAt=now();
 try{
  await io.initialize();await adapter.assertOwnedPostgres(first);
  for(const plan of plans){const owner=await createOwnedRole(adapter,plan,value=>owners.push(value));assert.equal(owner.creationConfirmed,true);}
  const bindings=owners.map(owner=>{const harnessSha256=harnessHashes[owner.plan.role];assert.match(harnessSha256,/^[a-f0-9]{64}$/);return {run:first.run,source:first.source,role:owner.plan.role,containerId:owner.id,imageId:first.imageId,runtimeSha256,harnessSha256,nonce:nonce()};});
  registry={run:first.run,source:first.source,mode,coordinator:bindings.find(row=>row.role==='coordinator'),roles:bindings.filter(row=>row.role!=='coordinator')};
  await io.writeRegistry(registry);
  const launch=async owner=>{await startOwnedRole(adapter,owner);const state={done:false};states.set(owner.plan.role,state);const monitor=collectExitReceipt(adapter,owner).then(receipt=>{state.done=true;state.receipt=receipt;},()=>{state.done=true;state.failed=true;});monitors.push(monitor);};
  await launch(owners.find(owner=>owner.plan.role==='coordinator'));
  let bridge;const bridgeStart=now();
  while(!(bridge=await io.readBridgeReady())){if(states.get('coordinator').done)throw new Error('COORDINATOR_BOOTSTRAP_EXIT');assert.ok(now()-bridgeStart<30000,'COORDINATOR_BRIDGE_30S');await sleep(25);}
  assert.equal(keys(bridge),'host,port,run,source');assert.equal(bridge.run,first.run);assert.equal(bridge.source,first.source);assert.equal(bridge.host,'127.0.0.1');assert.ok(Number.isInteger(bridge.port)&&bridge.port>0&&bridge.port<65536);
  for(const role of CHILDREN){await io.writeChildBinding(role,{...registry.roles.find(row=>row.role===role),port:bridge.port});await launch(owners.find(owner=>owner.plan.role===role));}
  let lastRequest=0;const signals=new Map();
  while([...states.values()].some(state=>!state.done)){
   if([...states.values()].some(state=>state.failed))throw new Error('OWNED_ROLE_MONITOR_FAILED');
   assert.ok(now()-startedAt<900000,'HOST_ORPHAN_DEADLINE');
   for(const item of await io.readTerminationRequests(lastRequest)){
    assert.equal(item.sequence,lastRequest+1);assert.ok(item.sequence<=6);const request=item.request;assert.equal(keys(request),'containerId,imageId,role,run,signal,source');assert.ok(CHILDREN.includes(request.role));
    const owner=owners.find(row=>row.plan.role===request.role);for(const key of ['run','source','imageId'])assert.equal(request[key],owner.plan[key]);assert.equal(request.containerId,owner.id);assert.ok(['TERM','KILL'].includes(request.signal));
    const used=signals.get(request.role)||new Set();assert.ok(!used.has(request.signal)&&!(used.has('KILL')&&request.signal==='TERM'));used.add(request.signal);signals.set(request.role,used);
    await requestOwnedTermination(adapter,owner,request.signal);lastRequest=item.sequence;
   }
   await sleep(25);
  }
  await Promise.all(monitors);assert.ok([...states.values()].every(state=>state.receipt?.clean===true));
 }catch{failure='ROLE_CONTAINER_DIAGNOSTIC_FAILED';}
 finally{cleanup=await cleanupOwnedRoles(adapter,owners);await Promise.allSettled(monitors);}
 const receipt={schemaVersion:1,mode,source:first.source,imageId:first.imageId,run:first.run,pgContainerId:first.pgContainerId,
  roles:owners.map(owner=>({role:owner.plan.role,containerId:owner.id,caps:owner.plan.caps,inspection:owner.inspection||null,exit:owner.exitReceipt||null})),
  failure,cleanup,passed:!failure&&cleanup.cleanupPassed&&cleanup.clean,resourceAcceptance:false,capacityAccepted:false};
 await io.writeResult(receipt);return receipt;
}
