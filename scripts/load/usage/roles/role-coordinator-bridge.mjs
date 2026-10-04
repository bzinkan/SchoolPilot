import assert from 'node:assert/strict';
import net from 'node:net';
import {PassThrough} from 'node:stream';
import {attachAuthenticatedTransport} from './authenticated-transport.mjs';
import {createRpcOwner,ProtocolError} from './owned-ipc-core.mjs';
import {ROLE_FILES,ROLE_OPERATIONS} from './role-child-bootstrap.mjs';
import {verifyResourceSnapshot,resourceDelta} from './role-resources.mjs';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject};}
export function createCoordinatorRoles({bindings,requestTermination,readExitReceipt,coordinatorBinding,readCoordinatorResources,setTimer=setTimeout,clearTimer=clearTimeout,pollMs=50}){
 const roles=new Map(),coordinatorResources={};let nextId=0;
 assert.equal(bindings.length,3);
 for(const binding of bindings){assert.ok(ROLE_FILES[binding.role]);assert.ok(!roles.has(binding.role));const stdout=new PassThrough();stdout.resume();roles.set(binding.role,{binding:Object.freeze({...binding}),connected:deferred(),ready:deferred(),closed:deferred(),stdout,launched:false,claimed:false,failed:false});}
 const roleFor=role=>{const owner=roles.get(role);if(!owner)throw new ProtocolError('COORDINATOR_ROLE');return owner;};
 const fail=(owner,code)=>{owner.failed=true;owner.ready.reject(new ProtocolError(code));owner.connected.reject(new ProtocolError(code));owner.rpcOwner?.disconnected();};
 function watchExit(owner){
  if(owner.watching)return;owner.watching=true;
  const check=async()=>{
   try{
    const receipt=await readExitReceipt(owner.binding.role);
    if(receipt){owner.rpcOwner?.observeHostExit(receipt,owner.binding);owner.exit=receipt;owner.stdout.end();owner.closed.resolve({code:receipt.exitCode,signal:receipt.forced?'FORCED':null});return;}
   }catch{fail(owner,'HOST_EXIT_RECEIPT_FAILED');}
   owner.exitTimer=setTimer(check,pollMs);
  };owner.exitTimer=setTimer(check,pollMs);
 }
 return Object.freeze({
  resolveBinding(identity){const owner=roleFor(identity.role);if(owner.claimed)throw new ProtocolError('ROLE_CONNECTION_REPLAY');for(const key of ['run','source','role','containerId'])assert.equal(identity[key],owner.binding[key]);owner.claimed=true;return owner.binding;},
  authenticated(identity,channel){const owner=roleFor(identity.role);assert.equal(owner.claimed,true);assert.equal(owner.channel,undefined);owner.channel=channel;
   owner.rpcOwner=createRpcOwner({send:message=>channel.send('request',message),setTimer,clearTimer});owner.connected.resolve(owner);watchExit(owner);
  },
  receive(role,kind,payload){const owner=roleFor(role);
   if(kind==='response'){owner.rpcOwner.response(payload);return;}
   if(kind==='event'&&payload?.event==='resource'){
    assert.equal(Object.keys(payload).sort().join(','),'event,phase,value');assert.ok(['startup','before','after','shutdown'].includes(payload.phase));assert.ok(owner.launched);owner.resources??={};assert.equal(owner.resources[payload.phase],undefined);if(payload.phase==='after')assert.ok(owner.resources.before);if(payload.phase==='shutdown')assert.ok(owner.resources.startup);
    owner.resources[payload.phase]=verifyResourceSnapshot(payload.value,owner.binding);if(payload.phase==='after')owner.resources.delta=resourceDelta(owner.resources.before,owner.resources.after);if(payload.phase==='shutdown')owner.resources.lifetimeDelta=resourceDelta(owner.resources.startup,owner.resources.shutdown);return;
   }
   if(kind!=='event'||payload?.event!=='ready'||Object.keys(payload).sort().join(',')!=='event,value'||!owner.launched||owner.readyReceived||payload.value?.kind!=='ready'||!Number.isSafeInteger(payload.value.pid))throw new ProtocolError('COORDINATOR_EVENT');
   owner.readyReceived=true;clearTimer(owner.readyTimer);owner.ready.resolve({...payload.value,containerId:owner.binding.containerId});
  },
  failure(role,code){fail(roleFor(role),code);},
  disconnected(role){const owner=roleFor(role);owner.rpcOwner?.disconnected();if(!owner.readyReceived)owner.ready.reject(new ProtocolError('ROLE_DISCONNECTED_BEFORE_READY'));},
  async child(role,file,extraEnv){
   const owner=roleFor(role);assert.equal(owner.launched,false);assert.equal(file,ROLE_FILES[role]);assert.deepEqual(extraEnv,{SCHEDULER_ENABLED:role==='worker'?'true':'false',USAGE_RELEASE_ROLE:role});
   // All containers are connected before coordinator import, so this wait is a
   // bootstrap gate, not an extension of the original30-second app deadline.
   await owner.connected.promise;owner.launched=true;
   owner.readyTimer=setTimer(()=>fail(owner,'ROLE_STARTUP_30S'),30000);
   owner.channel.send('event',{event:'launch',file,sha256:owner.binding.harnessSha256});
   return {process:{get connected(){return owner.rpcOwner.snapshot().connected;},get exitCode(){return owner.exit?.exitCode??null;},kill(signal='SIGTERM'){
    const normalized=signal==='SIGKILL'?'KILL':signal==='SIGTERM'?'TERM':null;if(!normalized)throw new ProtocolError('ROLE_SIGNAL');
    owner.forcedRequested=true;Promise.resolve(requestTermination(role,normalized)).catch(()=>fail(owner,'ROLE_TERMINATION_REQUEST_FAILED'));return true;
   }},rpc:(operation,value,timeoutMs)=>{if(!ROLE_OPERATIONS[role].includes(operation))throw new ProtocolError('ROLE_RPC_OPERATION');return owner.rpcOwner.call(++nextId,operation,value,timeoutMs);},
   ready:owner.ready.promise,closed:owner.closed.promise,stdout:owner.stdout};
  },
  allConnected:()=>Promise.all([...roles.values()].map(owner=>owner.connected.promise)),
  captureCoordinatorResources(phase){assert.ok(['before','after'].includes(phase));assert.equal(coordinatorResources[phase],undefined);assert.ok(coordinatorBinding&&readCoordinatorResources);coordinatorResources[phase]=verifyResourceSnapshot(readCoordinatorResources(),coordinatorBinding);if(phase==='after')coordinatorResources.delta=resourceDelta(coordinatorResources.before,coordinatorResources.after);return coordinatorResources[phase];},
  resourceReceipt(){return {coordinator:coordinatorResources,...Object.fromEntries([...roles].map(([name,owner])=>[name,owner.resources||{}]))};},
  snapshot:()=>Object.fromEntries([...roles].map(([name,owner])=>[name,{containerId:owner.binding.containerId,launched:owner.launched,failed:owner.failed,forcedRequested:owner.forcedRequested===true,rpc:owner.rpcOwner?.snapshot(),transport:owner.channel?.snapshot?.()}])),
  close(){for(const owner of roles.values()){clearTimer(owner.readyTimer);clearTimer(owner.exitTimer);owner.channel?.close();}},
 });
}

export async function listenCoordinator({owners,createServer=handler=>net.createServer(handler),writeReady,setTimer=setTimeout,clearTimer=clearTimeout}){
 let connections=0;const sockets=new Set();
 const server=createServer(socket=>{
  if(++connections>3){socket.destroy();return;}sockets.add(socket);let role;
  attachAuthenticatedTransport(socket,{side:'server',setTimer,clearTimer,resolveBinding:identity=>{const binding=owners.resolveBinding(identity);role=binding.role;return binding;},
   onAuthenticated:(identity,channel)=>owners.authenticated(identity,channel),onPayload:(kind,value)=>owners.receive(role,kind,value),
   onFailure:code=>{if(role)owners.failure(role,code);},onClose:()=>{sockets.delete(socket);if(role)owners.disconnected(role);}});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port:0},resolve);});
 const address=server.address();assert.equal(address.address,'127.0.0.1');await writeReady({port:address.port,host:'127.0.0.1'});
 return {port:address.port,async close(){owners.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
