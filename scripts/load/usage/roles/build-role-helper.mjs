import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyImageProbe,cleanupImageProbe} from './image-probe.mjs';
import {assertExecutionMode} from './profile.mjs';
const execute=promisify(execFile);
const [docker,endpoint,contextArg,outputArg,candidateTag,mode='diagnostic']=process.argv.slice(2),context=resolve(contextArg),output=resolve(outputArg);
assertExecutionMode({mode,phase:'combined',cpuProfile:false});
assert.match(endpoint,/^(?:npipe:\/{2,4}\.\/pipe\/[a-zA-Z0-9_.-]+|unix:\/\/\/[^\s?#]+)$/);
assert.match(candidateTag,/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9_.-]+$/);
assert.equal(existsSync(output),false);mkdirSync(output);
const env={...process.env};for(const key of['BUILDX_BUILDER','DOCKER_CONTEXT','DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_TLS'])delete env[key];
const sha=x=>createHash('sha256').update(x).digest('hex'),hash=f=>sha(readFileSync(f));
const save=(name,x)=>writeFileSync(join(output,name),JSON.stringify(x,null,2)+'\n',{flag:'wx'});
const invoke=async(args,timeout=30000)=>(await execute(docker,['--host',endpoint,...args],{env,timeout,windowsHide:true,maxBuffer:16*1024**2,encoding:'utf8'}));
const inspect=async id=>JSON.parse((await invoke(['image','inspect',id])).stdout)[0];
const plan=JSON.parse(readFileSync(join(context,'role-preparation.json'),'utf8'));
const candidate=await inspect(plan.candidateImageId),tagged=await inspect(candidateTag);
assert.deepEqual(tagged,candidate);assert.equal(candidate.Config.Labels['org.opencontainers.image.revision'],plan.applicationSource);
assert.ok([plan.candidateImageId,plan.candidateConfigDigest].includes(candidate.Id));
const verifyFiles=()=>{for(const[name,expected]of Object.entries(plan.roleHarnessSha256))assert.equal(hash(join(context,'prototype',name)),expected);};
verifyFiles();
const args=['build','--builder','default','--pull=false','--platform','linux/amd64','--build-arg',`CANDIDATE_IMAGE=${candidateTag}@${plan.candidateImageId}`,'--iidfile',join(output,'image-id.txt'),'--file',join(context,'Dockerfile.roles'),context];
save('build-request.json',{schemaVersion:2,predeclaredExecutionMode:mode,source:plan.applicationSource,candidateImageId:plan.candidateImageId,candidateConfigDigest:plan.candidateConfigDigest,candidateTag,endpoint,args,preparationSha256:hash(join(context,'role-preparation.json')),startedAt:new Date().toISOString(),capacityAccepted:false});
try{const result=await invoke(args,300000);writeFileSync(join(output,'build.log'),result.stdout+result.stderr,{flag:'wx'});}
catch(error){writeFileSync(join(output,'build.log'),String(error.stdout||'')+String(error.stderr||''),{flag:'wx'});throw Error('ROLE_HELPER_BUILD_FAILED');}
assert.deepEqual(await inspect(candidateTag),candidate);verifyFiles();
const imageId=readFileSync(join(output,'image-id.txt'),'utf8').trim(),image=await inspect(imageId);
assert.equal(image.Config.Labels['org.opencontainers.image.revision'],plan.applicationSource);
assert.equal(image.Config.Labels['codex.usage-role.prototype'],'unvalidated');save('image-inspect.json',image);
const probeName=`schoolpilot-role-probe-${randomBytes(6).toString('hex')}`;
const find=async()=>{const ids=(await invoke(['container','ls','--all','--filter',`name=^/${probeName}$`,'--no-trunc','--format','{{.ID}}'])).stdout.trim().split('\n').filter(Boolean);assert.ok(ids.length<=1);return ids.length?JSON.parse((await invoke(['container','inspect',ids[0]])).stdout)[0]:null;};
const owned=found=>verifyImageProbe(found,{name:probeName,imageId,image},inspect);
assert.equal(await find(),null);
let id,proof,clean=false,runtimeConfigDigest;
try{
  id=(await invoke(['create','--name',probeName,'--label',`codex.usage-role-build=${probeName}`,'--network','none','--read-only','--cpus','1','--memory','1g','--memory-swap','1g','--cap-drop','ALL','--security-opt','no-new-privileges','--user','node','--entrypoint','node',imageId,'--input-type=module','-e',"import{createHash}from'node:crypto';import{readFileSync}from'node:fs';import{assertRuntime}from'/prototype-tools/verify-runtime.mjs';assertRuntime('/prototype-tools/base-runtime.json');console.log(JSON.stringify({node:process.version,runtimeSha256:createHash('sha256').update(readFileSync('/prototype-tools/base-runtime.json')).digest('hex')}));"])).stdout.trim();
  assert.match(id,/^[a-f0-9]{64}$/);const created=await owned(await find());assert.equal(created.Id,id);runtimeConfigDigest=created.Image;
  const result=await invoke(['start','--attach',id],60000);writeFileSync(join(output,'runtime-proof.log'),result.stdout+result.stderr,{flag:'wx'});
  proof=JSON.parse(result.stdout.trim().split('\n').at(-1));const ended=await owned(await find());save('runtime-probe-inspect.json',ended);
  assert.equal(ended.State.Running,false);assert.equal(ended.State.ExitCode,0);
}finally{
  clean=await cleanupImageProbe({find,verify:owned,remove:id=>invoke(['rm','--force','--volumes',id]),save,id,name:probeName});
}
assert.ok(proof&&clean&&runtimeConfigDigest);save('runtime-proof.json',proof);
const binding={...plan,allowLocalRolePreflight:true,predeclaredExecutionMode:mode,allowedModes:mode==='capacity-candidate'?['diagnostic','capacity-candidate']:['diagnostic'],roleImageId:imageId,runtimeConfigDigest,runtimeSha256:proof.runtimeSha256,diagnosticImageId:imageId,diagnosticImageIdentities:[...new Set([imageId,image.Id,runtimeConfigDigest])],passed:true,cleanupPassed:true,applicationChanges:0,capacityAccepted:false};
save('role-image-binding.json',binding);console.log(JSON.stringify({output,imageId,source:plan.applicationSource,passed:true}));
