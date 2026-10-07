import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {finished} from 'node:stream/promises';
import {attachAuthenticatedTransport} from './authenticated-transport.mjs';
import {encodeFrame} from './owned-ipc-core.mjs';
import {installChildBridge} from './role-child-bootstrap.mjs';
import {createCoordinatorRoles} from './role-coordinator-bridge.mjs';
import {createOwnedRole,startOwnedRole,collectExitReceipt,cleanupOwnedRoles} from './host-lifecycle.mjs';
import {createDockerHostAdapter} from './docker-host-adapter.mjs';
import {rolePlan} from './role-plan.mjs';
import {makeRoleEnvironment,inheritWorkloadContract} from './role-environment.mjs';
import {hash,patchCoordinator} from './patch-coordinator.mjs';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertDisjointControlAndEvidence} from './host-file-io.mjs';
import {readRoleResources,resourceDelta} from './role-resources.mjs';

const base={run:'a'.repeat(12),source:'b'.repeat(40),role:'api',containerId:'c'.repeat(64),nonce:'d'.repeat(64),imageId:'sha256:'+'e'.repeat(64),harnessSha256:'f'.repeat(64)};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Socket extends EventEmitter{
 constructor(){super();this.destroyed=false;this.writableLength=0;this.frames=[];}
 write(buffer,callback){this.frames.push(Buffer.from(buffer));this.writableLength+=buffer.length;queueMicrotask(()=>{this.writableLength-=buffer.length;if(!this.destroyed&&!this.peer.destroyed)this.peer.emit('data',buffer);callback?.(this.destroyed?new Error('closed'):undefined);});return true;}
 destroy(){if(this.destroyed)return;this.destroyed=true;queueMicrotask(()=>this.emit('close'));if(this.peer&&!this.peer.destroyed)this.peer.destroy();}
}
const pair=()=>{const a=new Socket(),b=new Socket();a.peer=b;b.peer=a;return[a,b];};
test('mutual authentication binds exact role before messages and never transmits nonce',async()=>{
 const [a,b]=pair(),received=[],failures=[];let client,server;
 attachAuthenticatedTransport(a,{side:'server',resolveBinding:()=>base,onAuthenticated:(_id,c)=>{server=c;},onPayload:(kind,payload)=>received.push([kind,payload]),onFailure:code=>failures.push(code)});
 attachAuthenticatedTransport(b,{side:'client',binding:base,onAuthenticated:(_id,c)=>{client=c;},onPayload:()=>{},onFailure:code=>failures.push(code)});
 await tick();assert.ok(client&&server);assert.equal(Buffer.concat([...a.frames,...b.frames]).includes(Buffer.from(base.nonce)),false);
 let flushed=false;client.send('request',{id:1,operation:'snapshot'},()=>{flushed=true;});await tick();assert.deepEqual(received,[['request',{id:1,operation:'snapshot'}]]);assert.equal(flushed,true);assert.deepEqual(failures,[]);a.destroy();await tick();
});
test('wrong nonce and large unauthenticated frames cannot reach any command handler',async()=>{
 for(const wrong of ['nonce','large']){const[a,b]=pair();let delivered=0,failures=0;
  attachAuthenticatedTransport(a,{side:'server',resolveBinding:()=>base,onAuthenticated:()=>{},onPayload:()=>delivered++,onFailure:()=>failures++});
  if(wrong==='nonce')attachAuthenticatedTransport(b,{side:'client',binding:{...base,nonce:'1'.repeat(64)},onAuthenticated:()=>{},onPayload:()=>delivered++,onFailure:()=>failures++});
  else b.write(encodeFrame({padding:'x'.repeat(5000)}));
  await tick();assert.equal(delivered,0);assert.ok(failures>0);assert.equal(a.destroyed,true);
 }
});
test('replayed authenticated frame terminates its channel',async()=>{
 const[a,b]=pair();let client,received=0,failed=0;
 attachAuthenticatedTransport(a,{side:'server',resolveBinding:()=>base,onAuthenticated:()=>{},onPayload:()=>received++,onFailure:()=>failed++});
 attachAuthenticatedTransport(b,{side:'client',binding:base,onAuthenticated:(_id,c)=>{client=c;},onPayload:()=>{}});
 await tick();client.send('request',{id:1,operation:'snapshot'});await tick();b.write(b.frames.at(-1));await tick();assert.equal(received,1);assert.equal(failed,1);assert.equal(a.destroyed,true);
});
test('original child shutdown send callback traverses real authenticated and sequenced wrappers',async()=>{
 const[a,b]=pair(),runtime=new EventEmitter();runtime.pid=7;let server,bridge,ready=false,response=false,exit=false;
 attachAuthenticatedTransport(a,{side:'server',resolveBinding:()=>base,onAuthenticated:(_id,c)=>{server=c;},onPayload:(kind,value)=>{if(kind==='event'&&value.event==='ready')ready=true;if(kind==='response')response=value.id===1;}});
 attachAuthenticatedTransport(b,{side:'client',binding:base,onAuthenticated:(_id,transport)=>{bridge=installChildBridge({runtime,binding:base,transport,hashRole:()=>base.harnessSha256,verifyRuntime(){},importRole:async()=>{runtime.send({kind:'ready',pid:7});runtime.on('message',request=>runtime.send({id:request.id,value:true},()=>{exit=true;}));}});},onPayload:(kind,value)=>{void bridge.receive(kind,value);}});
 await tick();server.send('event',{event:'launch',file:'release-enabled-process.mjs',sha256:base.harnessSha256});await tick();assert.equal(ready,true);server.send('request',{id:1,operation:'shutdown'});await tick();assert.equal(response,true);assert.equal(exit,true);assert.ok(server.snapshot().maximumSentFrameBytes>0);a.destroy();await tick();
});
test('child imports exact original module only after bound launch and preserves send callback',async()=>{
 const runtime=new EventEmitter();runtime.pid=7;const sent=[];let imports=0,checked=0,flush,closed=false;
 const bridge=installChildBridge({runtime,binding:base,transport:{send:(kind,payload,cb)=>{sent.push([kind,payload]);flush=cb;return true;},close:()=>{closed=true;}},hashRole:()=>base.harnessSha256,verifyRuntime:()=>checked++,importRole:async file=>{imports++;assert.equal(file,'release-enabled-process.mjs');runtime.send({kind:'ready',pid:7});runtime.on('message',request=>runtime.send({id:request.id,value:true},()=>{runtime.exitCode=0;}));}});
 assert.equal(imports,0);await bridge.receive('event',{event:'launch',file:'release-enabled-process.mjs',sha256:base.harnessSha256});assert.equal(imports,1);assert.equal(checked,1);
 await bridge.receive('request',{id:1,operation:'shutdown'});assert.equal(runtime.exitCode,undefined);flush();assert.equal(runtime.exitCode,0);assert.equal(bridge.snapshot().pending,0);
 await assert.rejects(()=>bridge.receive('request',{id:2,operation:'rollup'}),/BINDING/);assert.equal(closed,true);bridge.restoreForTest();
});
test('child rejects wrong source file/hash and requests before readiness',async()=>{
 for(const payload of [{event:'launch',file:'arbitrary.mjs',sha256:base.harnessSha256},{event:'launch',file:'release-enabled-process.mjs',sha256:'0'.repeat(64)}]){
  let imports=0;const bridge=installChildBridge({runtime:new EventEmitter(),binding:base,transport:{send(){},close(){}},hashRole:()=>base.harnessSha256,verifyRuntime(){},importRole(){imports++;}});await assert.rejects(()=>bridge.receive('event',payload));assert.equal(imports,0);
 }
});
const bindings=['api','worker','generator'].map((role,index)=>({...base,role,containerId:String(index+1).repeat(64)}));
test('coordinator maps original ready/rpc interface and closes only on bound host receipt',async()=>{
 const timers=[],sent=[],receipts=new Map();const owners=createCoordinatorRoles({bindings,requestTermination:async()=>{},readExitReceipt:async role=>receipts.get(role),setTimer:fn=>(timers.push(fn),timers.length),clearTimer:()=>{}});
 for(const binding of bindings){owners.resolveBinding(binding);owners.authenticated(binding,{send:(kind,value)=>{sent.push([binding.role,kind,value]);},close(){}});}
 await owners.allConnected();const child=await owners.child('api','release-enabled-process.mjs',{SCHEDULER_ENABLED:'false',USAGE_RELEASE_ROLE:'api'});
 owners.receive('api','event',{event:'ready',value:{kind:'ready',pid:7,pools:{api:16,session:2}}});assert.equal((await child.ready).containerId,bindings[0].containerId);
 const snapshot=child.rpc('snapshot');const request=sent.at(-1)[2];owners.receive('api','response',{id:request.id,value:{active:0}});assert.deepEqual(await snapshot,{active:0});
 const shutdown=child.rpc('shutdown',undefined,15000);owners.receive('api','response',{id:sent.at(-1)[2].id,value:true});await shutdown;owners.disconnected('api');assert.equal(child.process.exitCode,null);
 receipts.set('api',{...bindings[0],inspected:true,running:false,logsClosed:true,exitCode:0,forced:false,oomKilled:false});await timers[0]();assert.deepEqual(await child.closed,{code:0,signal:null});await finished(child.stdout);assert.equal(owners.snapshot().api.rpc.clean,true);owners.close();
});
function plan(role='api'){return {...rolePlan({role,run:base.run,source:base.source,imageId:base.imageId,pgContainerId:'8'.repeat(64),evidenceDirectory:'C:/owned/evidence',controlDirectory:'C:/owned/control',environmentKeys:['NODE_ENV']}),runtimeConfigDigest:'sha256:'+'9'.repeat(64)};}
function inspect(p,id=base.containerId){return {Id:id,Name:`/${p.name}`,Image:p.runtimeConfigDigest,Mounts:p.mounts,Config:{Image:p.imageId,Entrypoint:p.entrypoint,Cmd:p.command,WorkingDir:'/app',Healthcheck:{Test:['NONE']},User:'node',Labels:{'codex.usage-scale':p.run,'codex.usage-role':p.role,'codex.usage-source':p.source}},HostConfig:{NetworkMode:`container:${p.pgContainerId}`,NanoCpus:p.caps.nanoCpus,Memory:p.caps.memoryBytes,MemorySwap:p.caps.memorySwapBytes,ReadonlyRootfs:true,PortBindings:{},Init:true,CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],Privileged:false,PidMode:'',IpcMode:'private'},State:{Running:false,ExitCode:0,OOMKilled:false}};}
test('host exit receipt waits for daemon exit and log closure; OOM is never clean',async()=>{
 const p=plan(),state=inspect(p);let created=false,flush,published;
 const adapter={inspectName:async()=>created?state:null,create:async()=>{created=true;return state.Id;},inspectId:async()=>state,startAndCapture:()=>new Promise(resolve=>{flush=()=>resolve({code:0,closed:true});}),wait:async()=>0,publishExit:async(_role,receipt)=>{published=receipt;}};
 const owner=await createOwnedRole(adapter,p);await startOwnedRole(adapter,owner);state.State.OOMKilled=true;const pending=collectExitReceipt(adapter,owner);await tick();assert.equal(published,undefined);flush();assert.equal((await pending).clean,false);assert.equal(published.logsClosed,true);assert.equal(published.oomKilled,true);
});
test('host refuses wrong ownership and still cleans the other exact role',async()=>{
 const one={plan:plan('api'),id:'1'.repeat(64)},two={plan:plan('worker'),id:'2'.repeat(64)};const states=new Map([[one.id,inspect(one.plan,one.id)],[two.id,inspect(two.plan,two.id)]]);states.get(two.id).Config.Image='sha256:'+'0'.repeat(64);const removed=[];
 const result=await cleanupOwnedRoles({inspectId:async id=>states.get(id)||null,remove:async id=>{removed.push(id);states.delete(id);}},[one,two]);assert.deepEqual(removed,[one.id]);assert.equal(result.cleanupPassed,false);assert.equal(result.clean,false);
});
test('forced cleanup and log failure remain failures but do not prevent owned removal',async()=>{
 const owner={plan:plan(),id:base.containerId,logCompletion:Promise.reject(new Error('log'))};owner.logCompletion.catch(()=>{});let state=inspect(owner.plan),killed=0;state.State.Running=true;
 const result=await cleanupOwnedRoles({inspectId:async()=>state,kill:async()=>{killed++;state.State.Running=false;},wait:async()=>137,remove:async()=>{state=null;}},[owner]);assert.equal(killed,1);assert.equal(result.cleanupPassed,true);assert.equal(result.clean,false);assert.equal(result.roles[0].logFailure,true);assert.equal(result.roles[0].forced,true);
});
test('Docker adapter pins local endpoint and strips ambient remote overrides without daemon access',async()=>{
 const calls=[];const adapter=createDockerHostAdapter({docker:'docker',endpoint:'unix:///var/run/docker.sock',environment:{DOCKER_HOST:'tcp://remote',DOCKER_CONTEXT:'remote',NODE_ENV:'test'},evidenceDirectory:'unused',receiptDirectory:'unused',execute:async(file,args,options)=>{calls.push({file,args,env:options.env});return {stdout:''};}});
 assert.equal(await adapter.inspectId(base.containerId),null);assert.deepEqual(calls[0].args.slice(0,2),['--host','unix:///var/run/docker.sock']);assert.equal(calls[0].env.DOCKER_HOST,undefined);assert.equal(calls[0].env.DOCKER_CONTEXT,undefined);
 assert.throws(()=>createDockerHostAdapter({docker:'docker',endpoint:'tcp://remote',environment:{}}));
});
test('role environment rejects remote endpoints and discards every ambient credential or override',()=>{
 const url=`postgres://synthetic:synthetic@127.0.0.1:5437/schoolpilot_redesign_usage_scale_${base.run}`;
 const environment={DATABASE_URL:url,ADMIN_DATABASE_URL:url,DATABASE_URL_PRIVILEGED:url,REDIS_URL:'redis://127.0.0.1:6387',NODE_ENV:'test',USAGE_LOCAL_SCALE:'1',USAGE_SOURCE_REVISION:base.source,USAGE_SCALE_CONTAINER:`schoolpilot-usage-scale-${base.run}`,AWS_SECRET_ACCESS_KEY:'not-forwarded',NODE_OPTIONS:'not-forwarded',USAGE_RELEASE_CPU_PROFILE:'false',USAGE_RELEASE_PHASE:'combined',USAGE_RELEASE_DIAGNOSTIC:'true'};
 const enabledReleaseEnvironment=value=>({...value,DB_POOL_MAX:'16',SESSION_DB_POOL_MAX:'2',SCHEDULER_DB_POOL_MAX:'5',SCHEDULER_LOCK_POOL_MAX:'8'});
 const options={role:'api',run:base.run,source:base.source,environment,enabledReleaseEnvironment,pgApplicationNames:{api:'usage_release_api'}};
 const made=makeRoleEnvironment(options);assert.equal(made.AWS_SECRET_ACCESS_KEY,undefined);assert.equal(made.NODE_OPTIONS,undefined);assert.equal(made.SCHEDULER_ENABLED,'false');assert.equal(made.DB_POOL_MAX,'16');
 assert.throws(()=>makeRoleEnvironment({...options,environment:{...environment,DATABASE_URL:url.replace('127.0.0.1','remote')}}));
 assert.throws(()=>makeRoleEnvironment({...options,enabledReleaseEnvironment:()=>({ARBITRARY_OVERRIDE:'false'})}));
});
test('generated coordinator preserves canonical full workload constants and false per-run capacity',async()=>{
 const source=readFileSync(new URL('../release-enabled-scale.mjs',import.meta.url),'utf8');const patched=patchCoordinator(source);
 assert.equal(patched.receipt.workloadChanged,false);assert.equal(patched.receipt.applicationModulesChanged,0);
 assert.ok(patched.text.includes("generator.rpc('phase'"));assert.ok(patched.text.includes('metrics.capacityAccepted = false;'));
 const {RELEASE_ENABLED_PROFILE}=await import('../release-enabled-profile.mjs');const {OPEN_LOOP_HEARTBEATS}=await import('../open-loop-heartbeats.mjs');
 const contract=inheritWorkloadContract(RELEASE_ENABLED_PROFILE,OPEN_LOOP_HEARTBEATS);assert.equal(contract.httpOffering.maxInFlight,1000);assert.equal(contract.httpOffering.durationMs*contract.httpOffering.requestsPerSecond/1000,6000);assert.equal(contract.reportOffers.total,64);assert.equal(contract.fullWorkerAcceptanceMs,48000);
});

test('LF and CRLF coordinator overlays preserve equivalent code and distinct exact-byte receipts',()=>{
 const canonical=readFileSync(new URL('../release-enabled-scale.mjs',import.meta.url),'utf8').replaceAll('\r\n','\n');
 const windows=canonical.replaceAll('\n','\r\n'),lf=patchCoordinator(canonical),crlf=patchCoordinator(windows);
 assert.equal(crlf.text.replaceAll('\r\n','\n'),lf.text);
 assert.equal(lf.receipt.inputSha256,hash(canonical));assert.equal(crlf.receipt.inputSha256,hash(windows));
 assert.notEqual(lf.receipt.inputSha256,crlf.receipt.inputSha256);
 assert.equal(lf.receipt.outputSha256,hash(lf.text));assert.equal(crlf.receipt.outputSha256,hash(crlf.text));
 assert.notEqual(lf.receipt.outputSha256,crlf.receipt.outputSha256);
 assert.equal(crlf.receipt.workloadChanged,false);assert.equal(crlf.receipt.applicationModulesChanged,0);
 // Line endings alone are tolerated; a changed structural anchor still fails.
 assert.throws(()=>patchCoordinator(windows.replace('  const snapshot =','  const changedSnapshot =')));
});

test('control credentials never overlap shared evidence on Windows paths or mixed separators',()=>{
 const root=join(tmpdir(),'release297-owned-path-proof'),evidence=join(root,'evidence'),control=join(root,'control');assert.ok(assertDisjointControlAndEvidence(control,evidence));
 for(const unsafe of [evidence,join(evidence,'control'),join(evidence,'child','..','control'),evidence.replaceAll('\\','/')+'/control'])assert.throws(()=>assertDisjointControlAndEvidence(unsafe,evidence));
 if(process.platform==='win32')assert.throws(()=>assertDisjointControlAndEvidence(evidence.toUpperCase()+'\\control',evidence.toLowerCase()));
 assert.throws(()=>assertDisjointControlAndEvidence(root,evidence));
});
test('resource receipts bind source and capture throttling plus memory counters before/after without reset',()=>{
 let value=10;const binding={...base,runtimeSha256:'9'.repeat(64)};const data={
  'cpu.max':'100000 100000','memory.max':'2147483648','memory.swap.max':'0','cpu.stat':'usage_usec 100\nuser_usec 80\nsystem_usec 20\nnr_periods 10\nnr_throttled 2\nthrottled_usec 40',
  'memory.events':'low 0\nhigh 0\nmax 1\noom 0\noom_kill 0','memory.current':'2000','memory.peak':'3000'};
 const read=path=>data[path.split('/').at(-1)],before=readRoleResources(binding,{read,now:()=>value,rss:()=>1500});value=20;data['cpu.stat']=data['cpu.stat'].replace('usage_usec 100','usage_usec 150').replace('throttled_usec 40','throttled_usec 60');
 const after=readRoleResources(binding,{read,now:()=>value,rss:()=>1600});const delta=resourceDelta(before,after);assert.equal(delta.cpu.usage_usec,50);assert.equal(delta.cpu.throttled_usec,20);assert.equal(delta.memoryPeakBytes,3000);assert.equal(delta.resourceAcceptance,false);assert.equal(after.runtimeSha256,binding.runtimeSha256);
 assert.throws(()=>readRoleResources(binding,{read:path=>path.endsWith('memory.events')?'oom 0':read(path)}));
});

test('created container wait cannot publish a false zero before started exit1 log closure',async()=>{
 const p=plan('coordinator'),state=inspect(p);let started=false,finish,published,waitCalls=0;
 const adapter={inspectName:async()=>null,create:async()=>state.Id,inspectId:async()=>state,startAndCapture:()=>new Promise(resolve=>{finish=()=>{started=true;state.State.ExitCode=1;resolve({code:1,closed:true});};}),wait:async()=>{waitCalls++;return started?1:0;},publishExit:async(_role,receipt)=>{published=receipt;}};
 const owner=await createOwnedRole(adapter,p);await startOwnedRole(adapter,owner);const pending=collectExitReceipt(adapter,owner);pending.catch(()=>{});await tick();finish();const receipt=await pending;assert.equal(waitCalls,1);assert.equal(receipt.exitCode,1);assert.equal(receipt.attachExitCode,1);assert.equal(receipt.clean,false);assert.equal(published,receipt);assert.equal(owner.exitReceipt,receipt);
});

test('candidate-default role profile refuses CPU profiler and heap overrides',()=>{
 assert.throws(()=>rolePlan({role:'api',run:base.run,source:base.source,imageId:base.imageId,pgContainerId:'8'.repeat(64),evidenceDirectory:'C:/owned/evidence',controlDirectory:'C:/owned/control',environmentKeys:['NODE_ENV'],apiCpuProfile:true}));
});
