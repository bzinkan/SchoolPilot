import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {hash} from './patch-coordinator.mjs';
import {createDockerHostAdapter} from './docker-host-adapter.mjs';
import {createHostFileIo,assertDisjointControlAndEvidence} from './host-file-io.mjs';
import {runRoleContainers} from './host-orchestrator.mjs';
import {rolePlan} from './role-plan.mjs';
import {makeRoleEnvironment,inheritWorkloadContract} from './role-environment.mjs';
import {assertExecutionMode} from './profile.mjs';

export async function launch({docker,endpoint,bindingFile,run,pgContainerId,evidenceDirectory,controlDirectory,environment=process.env,mode='diagnostic'}){
  const raw=readFileSync(bindingFile),binding=JSON.parse(raw);
  assert.equal(binding.schemaVersion,2);assert.equal(binding.allowLocalRolePreflight,true);assert.equal(binding.passed,true);assert.equal(binding.cleanupPassed,true);
  const execution=assertExecutionMode({mode,phase:environment.USAGE_RELEASE_PHASE,cpuProfile:environment.USAGE_RELEASE_CPU_PROFILE!=='false'});
  assert.ok(binding.allowedModes.includes(mode),'Exact helper does not admit this execution mode');
  if(mode==='capacity-candidate')assert.equal(binding.predeclaredExecutionMode,'capacity-candidate');
  for(const[name,expected]of Object.entries(binding.roleHarnessSha256)){
    assert.match(name,/^[a-z0-9.-]+\.(mjs|ps1)$/);assert.equal(hash(readFileSync(new URL(name,import.meta.url))),expected);
  }
  assertDisjointControlAndEvidence(controlDirectory,evidenceDirectory);
  for(const path of[evidenceDirectory,controlDirectory]){const below=relative(resolve(tmpdir()),resolve(path));assert.ok(below&&below!=='..'&&!below.startsWith(`..${sep}`)&&!isAbsolute(below));}
  const modules={};for(const[name,entry]of Object.entries(binding.contractModules)){
    assert.ok(['profile','offering','postgres'].includes(name));assert.equal(hash(readFileSync(entry.path)),entry.sha256);modules[name]=await import(pathToFileURL(entry.path));
  }
  assert.deepEqual(Object.keys(modules).sort(),['offering','postgres','profile']);
  const adapter=createDockerHostAdapter({docker,endpoint,environment,evidenceDirectory,receiptDirectory:join(controlDirectory,'host-receipts')});
  const image=await adapter.inspectImage(binding.roleImageId);
  assert.ok(binding.diagnosticImageIdentities.includes(image.Id));assert.equal(image.Os,'linux');assert.equal(image.Architecture,'amd64');
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'],binding.applicationSource);assert.equal(image.Config.Labels['codex.usage-role.prototype'],'unvalidated');
  assert.equal((image.Config.Env??[]).some(value=>value.startsWith('NODE_OPTIONS=')),false);
  const plans=['coordinator','api','worker','generator'].map(role=>{
    const env=makeRoleEnvironment({role,run,source:binding.applicationSource,environment,enabledReleaseEnvironment:modules.profile.enabledReleaseEnvironment,pgApplicationNames:modules.postgres.RELEASE_PG_APPLICATION_NAMES,mode});
    const plan=rolePlan({role,run,source:binding.applicationSource,imageId:binding.roleImageId,pgContainerId,evidenceDirectory:resolve(evidenceDirectory),controlDirectory:resolve(controlDirectory),environmentKeys:Object.keys(env),environment:env,imageEnvironment:image.Config.Env});
    plan.runtimeConfigDigest=binding.runtimeConfigDigest;return plan;
  });
  const path=join(evidenceDirectory,'role-runtime-plan.json');assert.equal(existsSync(path),false);
  writeFileSync(path,JSON.stringify({schemaVersion:2,execution,roles:plans,applicationSource:binding.applicationSource,runtimeSha256:binding.runtimeSha256,bindingSha256:hash(raw),harnessIdentity:binding.harnessIdentity,workload:inheritWorkloadContract(modules.profile.RELEASE_ENABLED_PROFILE,modules.offering.OPEN_LOOP_HEARTBEATS),capacityAccepted:false},null,2)+'\n',{flag:'wx'});
  return runRoleContainers({adapter,io:createHostFileIo({controlDirectory,evidenceDirectory}),plans,runtimeSha256:binding.runtimeSha256,harnessHashes:binding.harnessHashes,mode:'combined'});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{const[docker,endpoint,bindingFile,run,pgContainerId,evidenceDirectory,controlDirectory,mode='diagnostic']=process.argv.slice(2);const result=await launch({docker,endpoint,bindingFile,run,pgContainerId,evidenceDirectory,controlDirectory,mode});if(!result.passed)process.exitCode=1;}
  catch{process.stderr.write('ROLE_SCALE_LAUNCH_FAILED\n');process.exitCode=1;}
}
