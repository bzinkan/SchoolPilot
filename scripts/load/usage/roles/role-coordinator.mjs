import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createCoordinatorRoles,listenCoordinator} from './role-coordinator-bridge.mjs';
import {installOwnedRoleCoordinator} from './coordinator-owner.mjs';
import {readRoleResources} from './role-resources.mjs';
import {createHash} from 'node:crypto';
import {runStartup} from './coordinator-startup.mjs';
function atomicNew(path,value){assert.equal(existsSync(path),false);writeFileSync(`${path}.tmp`,JSON.stringify(value)+'\n',{flag:'wx'});renameSync(`${path}.tmp`,path);}
export async function runCoordinator({registry,importCoordinator=()=>import('/diagnostic/scripts/load/usage/release-enabled-scale.mjs'),read=readFileSync,writeNew=atomicNew,listen=listenCoordinator}){
 let requestNumber=0,uninstall;
 const owners=createCoordinatorRoles({bindings:registry.roles,coordinatorBinding:registry.coordinator,readCoordinatorResources:()=>readRoleResources(registry.coordinator),
  requestTermination:async(role,signal)=>{const binding=registry.roles.find(row=>row.role===role);writeNew(`/coordinator-requests/termination-${++requestNumber}.json`,{run:binding.run,source:binding.source,role,containerId:binding.containerId,imageId:binding.imageId,signal});},
  readExitReceipt:async role=>{try{return JSON.parse(read(`/host-receipts/${role}.json`,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}});
 const server=await listen({owners,writeReady:async address=>writeNew('/coordinator-requests/bridge-ready.json',{...address,run:registry.run,source:registry.source})});
 let bootstrapTimer;try{
  await Promise.race([owners.allConnected(),new Promise((_,reject)=>{bootstrapTimer=setTimeout(()=>reject(new Error('OWNED_ROLE_BOOTSTRAP_30S')),30000);})]);clearTimeout(bootstrapTimer);
  uninstall=installOwnedRoleCoordinator(owners);if(registry.mode==='startup')await runStartup(owners);else{assert.equal(registry.mode,'combined');await importCoordinator();}
  const result=JSON.parse(read('/evidence/usage-scale.json','utf8'));result.roleOwnership=owners.snapshot();
  result.roleOwnershipClean=Object.values(result.roleOwnership).every(row=>row.rpc?.clean===true&&!row.failed&&!row.forcedRequested);
  result.roleResources=owners.resourceReceipt();result.roleResourceEvidenceComplete=Object.entries(result.roleResources).every(([role,value])=>registry.mode==='startup'&&role!=='coordinator'?value.startup&&value.shutdown&&value.lifetimeDelta:value.before&&value.after&&value.delta);
  result.resourceAcceptance=false;result.capacityAccepted=false;
  if(!result.roleOwnershipClean||!result.roleResourceEvidenceComplete){result.prototypeStartupPassed=false;result.diagnosticChecksPassed=false;process.exitCode=1;}
  writeFileSync('/evidence/usage-scale.json',JSON.stringify(result,null,2)+'\n');return result;
 }finally{clearTimeout(bootstrapTimer);uninstall?.();await server.close();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const verify=await import('/prototype-tools/verify-runtime.mjs');verify.assertRuntime('/prototype-tools/base-runtime.json');
 const registry=JSON.parse(readFileSync('/role-secrets/registry.json','utf8'));assert.equal(createHash('sha256').update(readFileSync('/prototype-tools/base-runtime.json')).digest('hex'),registry.coordinator.runtimeSha256);
 await runCoordinator({registry});
}
