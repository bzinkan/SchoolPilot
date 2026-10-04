import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createWriteStream,writeFileSync,existsSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {finished} from 'node:stream/promises';

// Construction has no side effects. Every daemon call is pinned to a validated
// local endpoint; no ambient Docker context/remote transport can take priority.
export function createDockerHostAdapter({docker,endpoint,environment,evidenceDirectory,receiptDirectory,execute=promisify(execFile),spawnProcess=spawn,createLog=createWriteStream}){
 assert.match(endpoint,/^(?:npipe:\/{2,4}\.\/pipe\/[a-zA-Z0-9_.-]+|unix:\/\/\/[^\s?#]+)$/);
 const env={...environment};for(const key of ['DOCKER_CONTEXT','DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_TLS'])delete env[key];
 const invoke=async(args,timeout=30000,roleEnvironment={})=>{try{return (await execute(docker,['--host',endpoint,...args],{env:{...env,...roleEnvironment},encoding:'utf8',timeout,windowsHide:true,maxBuffer:8*1024*1024})).stdout;}catch{throw new Error('OWNED_DOCKER_COMMAND_FAILED');}};
 const assertId=id=>assert.match(id,/^[a-f0-9]{64}$/);
 const inspectId=async id=>{assertId(id);const ids=(await invoke(['container','ls','--all','--filter',`id=${id}`,'--no-trunc','--format','{{.ID}}'])).trim().split('\n').filter(Boolean);assert.ok(ids.length<=1);if(!ids.length)return null;assert.equal(ids[0],id);return JSON.parse(await invoke(['container','inspect',id]))[0];};
 return {
  inspectId,
  async inspectImage(id){assert.match(id,/^sha256:[a-f0-9]{64}$/);return JSON.parse(await invoke(['image','inspect',id]))[0];},
  async assertOwnedPostgres(plan){const value=await inspectId(plan.pgContainerId);assert.equal(value?.Id,plan.pgContainerId);assert.equal(value?.Name,`/schoolpilot-usage-scale-${plan.run}`);assert.equal(value?.Config?.Labels?.['codex.usage-scale'],plan.run);assert.equal(value?.State?.Running,true);assert.equal(value?.HostConfig?.NanoCpus,4000000000);assert.equal(value?.HostConfig?.Memory,4294967296);},
  async inspectName(name){assert.match(name,/^schoolpilot-role-(?:api|worker|generator|coordinator)-[a-f0-9]{12}$/);const ids=(await invoke(['container','ls','--all','--filter',`name=^/${name}$`,'--no-trunc','--format','{{.ID}}'])).trim().split('\n').filter(Boolean);assert.ok(ids.length<=1);return ids.length?inspectId(ids[0]):null;},
  async create(args,roleEnvironment){assert.equal(args[0],'create');return (await invoke(args,30000,roleEnvironment)).trim();},
  startAndCapture(id,role){assertId(id);assert.ok(['api','worker','generator','coordinator'].includes(role));
   const log=createLog(resolve(evidenceDirectory,`${role}.log`),{flags:'wx'});
   const logFinished=finished(log);let captureFailure,child;
   logFinished.catch(error=>{captureFailure=error;child?.stdout.unpipe(log);child?.stderr.unpipe(log);child?.stdout.resume();child?.stderr.resume();});
   child=spawnProcess(docker,['--host',endpoint,'start','--attach',id],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
   child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
   const closed=new Promise((accept,reject)=>{let spawnError;child.once('error',error=>{spawnError=error;});child.once('close',async code=>{log.end();try{await logFinished;if(spawnError||captureFailure)throw new Error();accept({code,closed:true});}catch{reject(new Error('OWNED_ROLE_LOG_CAPTURE_FAILED'));}});});closed.catch(()=>{});
   const result=Promise.race([closed,logFinished.then(()=>new Promise(()=>{}),()=>{throw new Error('OWNED_ROLE_LOG_CAPTURE_FAILED');})]);
   result.closed=closed;result.catch(()=>{});return result;
  },
  async wait(id){assertId(id);const code=Number((await invoke(['container','wait',id],900000)).trim());assert.ok(Number.isInteger(code));return code;},
  async kill(id,signal){assertId(id);assert.ok(['TERM','KILL'].includes(signal));await invoke(['container','kill','--signal',signal,id]);},
  async remove(id){assertId(id);await invoke(['container','rm','--volumes',id]);},
  async publishExit(role,receipt){assert.ok(['api','worker','generator','coordinator'].includes(role));const path=resolve(receiptDirectory,`${role}.json`);assert.equal(existsSync(path),false);const temporary=resolve(receiptDirectory,`${role}.json.tmp`);writeFileSync(temporary,JSON.stringify(receipt)+'\n',{flag:'wx'});renameSync(temporary,path);},
 };
}
