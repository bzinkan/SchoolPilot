import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { hash } from './contracts.mjs';
import { verifyImageProbe, cleanupImageProbe } from '../roles/image-probe.mjs';
const execute = promisify(execFile);
export async function withPinnedBuildBase(applicationImage, invoke, use, save) {
  if (!applicationImage.startsWith('sha256:')) return use(applicationImage);
  const original = JSON.parse((await invoke(['image','inspect',applicationImage])).stdout)[0];
  assert.equal(original.Id,applicationImage);
  const tag='schoolpilot-release297-v2-owned-base-'+randomBytes(6).toString('hex')+':pinned';
  let created=false,cleanupPassed=false;
  try {
    let existing=false;try { await invoke(['image','inspect',tag]);existing=true; } catch {}
    assert.equal(existing,false);
    await invoke(['image','tag',applicationImage,tag]);created=true;
    const tagged=JSON.parse((await invoke(['image','inspect',tag])).stdout)[0];assert.equal(tagged.Id,original.Id);
    return await use(tag);
  } finally {
    if(created){const tagged=JSON.parse((await invoke(['image','inspect',tag])).stdout)[0];assert.equal(tagged.Id,original.Id);await invoke(['image','rm',tag]);}
    let exists=false;try { await invoke(['image','inspect',tag]);exists=true; } catch {}
    assert.equal(exists,false);cleanupPassed=true;
    save('build-base-custody.json',{applicationImage,temporaryLocalTag:tag,imageId:original.Id,created,cleanupPassed,baseBytesChanged:false});
  }
}
export async function buildHelper(options) {
  assert.match(options.endpoint,/^(?:npipe:\/{2,4}\.\/pipe\/[a-zA-Z0-9_.-]+|unix:\/\/\/[^\s?#]+)$/);
  const context=resolve(options.contextDirectory), output=resolve(options.outputDirectory);
  assert.equal(existsSync(output),false); mkdirSync(output);
  const preparationBytes=readFileSync(join(context,'preparation.json')), preparation=JSON.parse(preparationBytes);
  assert.equal(hash(preparationBytes),options.preparationSha256);
  const save=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  const environment={...process.env}; for(const key of Object.keys(environment)) if(/^(?:DOCKER_|BUILDX_BUILDER$|NODE_OPTIONS$)/.test(key)) delete environment[key];
  const invoke=(args,timeout=60_000)=>execute(options.docker||'docker',['--host',options.endpoint,...args],{env:environment,encoding:'utf8',windowsHide:true,timeout,maxBuffer:16*1024**2});
  const inspect=async image=>JSON.parse((await invoke(['image','inspect',image])).stdout)[0];
  const before=await inspect(preparation.applicationImage);
  const verifyFiles=()=>{ for(const [name,expected] of Object.entries(preparation.executedFiles)) assert.equal(hash(readFileSync(join(context,'overlay',name))),expected); };
  verifyFiles();
  try { await withPinnedBuildBase(preparation.applicationImage,invoke,async buildBase=>{const result=await invoke(['build','--builder','default','--pull=false','--platform','linux/amd64','--build-arg','APPLICATION_IMAGE='+buildBase,
    '--iidfile',join(output,'image-id.txt'),'--file',join(context,'Dockerfile'),context],300_000);writeFileSync(join(output,'build.log'),result.stdout+result.stderr,{flag:'wx'});},save); }
  catch(error){writeFileSync(join(output,'build.log'),String(error.stdout||'')+String(error.stderr||''),{flag:'wx'});throw Error('V2_HELPER_BUILD_FAILED');}
  verifyFiles(); assert.deepEqual(await inspect(preparation.applicationImage),before);
  const helperImage=readFileSync(join(output,'image-id.txt'),'utf8').trim(); assert.match(helperImage,/^sha256:[a-f0-9]{64}$/);
  const image=await inspect(helperImage); save('helper-image-inspect.json',image);
  const name='schoolpilot-v2-helper-probe-'+randomBytes(6).toString('hex');
  const find=async()=>{const ids=(await invoke(['container','ls','-a','--filter',`name=^/${name}$`,'--no-trunc','--format','{{.ID}}'])).stdout.trim().split(/\r?\n/).filter(Boolean);assert.ok(ids.length<=1);return ids.length?JSON.parse((await invoke(['inspect',ids[0]])).stdout)[0]:null;};
  const owned=found=>verifyImageProbe(found,{name,imageId:helperImage,image},inspect);
  assert.equal(await find(),null); let id,proof,helperContainerImage,clean=false;
  try {
    id=(await invoke(['create','--name',name,'--label',`codex.usage-role-build=${name}`,'--network','none','--read-only','--cpus','1','--memory','1g','--memory-swap','1g',
      '--cap-drop','ALL','--security-opt','no-new-privileges','--user','node','--entrypoint','node',helperImage,'--input-type=module','-e',
      "import{createHash}from'node:crypto';import{readFileSync}from'node:fs';import{assertRuntime}from'/prototype-tools/verify-runtime.mjs';assertRuntime('/prototype-tools/base-runtime.json',{git:false});console.log(JSON.stringify({node:process.version,runtimeSha256:createHash('sha256').update(readFileSync('/prototype-tools/base-runtime.json')).digest('hex')}));"])).stdout.trim();
    const created=await owned(await find()); assert.equal(created.Id,id); helperContainerImage=created.Image;
    const result=await invoke(['start','--attach',id]); writeFileSync(join(output,'runtime-proof.log'),result.stdout+result.stderr,{flag:'wx'});
    proof=JSON.parse(result.stdout.trim().split('\n').at(-1));const ended=await owned(await find());save('runtime-probe-inspect.json',ended);
    assert.equal(ended.State.Running,false);assert.equal(ended.State.ExitCode,0);assert.equal(ended.State.OOMKilled,false);
  } finally {clean=await cleanupImageProbe({find,verify:owned,remove:id=>invoke(['rm','--volumes',id]),save,id,name});}
  assert.ok(clean&&proof&&helperContainerImage);
  const binding={schemaVersion:2,applicationSource:preparation.applicationSource,applicationImage:preparation.applicationImage,
    preparationSha256:hash(preparationBytes),helperImage,helperConfigDigest:helperContainerImage,helperContainerImage,
    runtimeSha256:proof.runtimeSha256,nodeVersion:proof.node,verified:true,cleanupPassed:true,applicationChanges:0,capacityAccepted:false};
  save('helper-binding.json',binding);return{output,helperImage,bindingSha256:hash(readFileSync(join(output,'helper-binding.json')))};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{process.stdout.write(JSON.stringify(await buildHelper(JSON.parse(readFileSync(process.argv[2],'utf8'))))+'\n');}catch{process.stderr.write('V2_HELPER_BUILD_FAILED\n');process.exitCode=1;}}
