import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import net from 'node:net';
import {attachAuthenticatedTransport} from './authenticated-transport.mjs';
import {ProtocolError} from './owned-ipc-core.mjs';
import {readRoleResources} from './role-resources.mjs';

export const ROLE_FILES=Object.freeze({api:'release-enabled-process.mjs',worker:'release-enabled-process.mjs',generator:'release-enabled-generator.mjs'});
export const ROLE_OPERATIONS=Object.freeze({api:['reset','snapshot','drain','quiesce','shutdown'],worker:['reset','snapshot','drain','quiesce','rollup','shutdown'],generator:['initialize','phase','correctness','shutdown']});

// The original harness modules keep their own message handlers, promise work,
// shutdown logic and process.send callback. This shim substitutes only IPC.
export function installChildBridge({runtime=process,binding,transport,importRole,verifyRuntime,hashRole,collectResources}){
 let launched=false,readySent=false,closed=false,lastId=0;
 const pending=new Map();
 const fail=code=>{closed=true;runtime.exitCode=1;transport.close();throw new ProtocolError(code);};
 const originalSend=runtime.send,originalConnected=runtime.connected;
 const resource=phase=>{if(collectResources)transport.send('event',{event:'resource',phase,value:collectResources()});};
 runtime.connected=true;
 runtime.send=(message,sendHandle,options,callback)=>{
  const cb=[sendHandle,options,callback].find(value=>typeof value==='function');
  if(closed||!launched)fail('CHILD_SEND_STATE');
  if(message?.kind==='ready'){
   if(readySent||!Number.isSafeInteger(message.pid)||message.pid<=0)fail('CHILD_READY_STATE');readySent=true;
   resource('startup');return transport.send('event',{event:'ready',value:message},cb);
  }
  if(!message||!Number.isSafeInteger(message.id)||!pending.has(message.id))fail('CHILD_UNKNOWN_RESPONSE');
  if(Object.keys(message).some(key=>!['id','value','error'].includes(key))||('value'in message)===('error'in message))fail('CHILD_RESPONSE_SHAPE');
  const operation=pending.get(message.id);
  if(!Object.hasOwn(message,'error')){if(operation==='reset')resource('before');else if(operation==='snapshot'||(binding.role==='generator'&&operation==='phase'))resource('after');else if(operation==='shutdown')resource('shutdown');}
  pending.delete(message.id);return transport.send('response',message,cb);
 };
 return Object.freeze({
  async receive(kind,payload){
   if(closed)fail('CHILD_CLOSED');
   if(kind==='event'&&payload?.event==='launch'){
    if(launched||Object.keys(payload).sort().join(',')!=='event,file,sha256'||payload.file!==ROLE_FILES[binding.role]||payload.sha256!==binding.harnessSha256)fail('CHILD_LAUNCH_BINDING');
    assert.equal(await hashRole(payload.file),payload.sha256);await verifyRuntime();launched=true;await importRole(payload.file);return;
   }
   if(kind!=='request'||!launched||!readySent||!payload||!Number.isSafeInteger(payload.id)||payload.id<=lastId||!ROLE_OPERATIONS[binding.role].includes(payload.operation)||Object.keys(payload).some(key=>!['id','operation','value'].includes(key))||pending.size>=32)fail('CHILD_REQUEST_BINDING');
   lastId=payload.id;pending.set(payload.id,payload.operation);if(binding.role==='generator'&&payload.operation==='phase')resource('before');runtime.emit('message',payload);
  },
  disconnected(){if(closed)return;closed=true;runtime.connected=false;runtime.emit('disconnect');},
  snapshot(){return {launched,readySent,closed,pending:pending.size,lastId};},
  restoreForTest(){runtime.send=originalSend;runtime.connected=originalConnected;},
 });
}

export async function startChild({binding,connect=options=>net.connect(options),runtime=process,read=readFileSync,importer=url=>import(url),verifyRuntime}){
 assert.equal(runtime.platform,'linux');assert.ok(Number.isInteger(binding.port)&&binding.port>0&&binding.port<65536);
 assert.ok(ROLE_FILES[binding.role]);assert.match(binding.harnessSha256,/^[a-f0-9]{64}$/);
 assert.equal(createHash('sha256').update(read('/prototype-tools/base-runtime.json')).digest('hex'),binding.runtimeSha256,'Exact candidate runtime receipt required');
 const socket=connect({host:'127.0.0.1',port:binding.port});let bridge;
 const ready=new Promise((resolve,reject)=>{
  attachAuthenticatedTransport(socket,{side:'client',binding,onAuthenticated(_identity,transport){
   bridge=installChildBridge({runtime,binding,transport,verifyRuntime,collectResources:()=>readRoleResources(binding),
    hashRole:file=>createHash('sha256').update(read(`/diagnostic/scripts/load/usage/${file}`)).digest('hex'),
    importRole:file=>importer(pathToFileURL(`/diagnostic/scripts/load/usage/${file}`).href)});resolve(bridge);
  },onPayload(kind,payload){Promise.resolve(bridge?.receive(kind,payload)).catch(()=>{runtime.exitCode=1;socket.destroy();});},
  onFailure(){runtime.exitCode=1;reject(new ProtocolError('CHILD_TRANSPORT_FAILED'));},onClose(){if(bridge)bridge.disconnected();else runtime.exit(1);}});
 });
 return ready;
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const binding=JSON.parse(readFileSync('/role-secrets/binding.json','utf8'));
 const verify=await import('/prototype-tools/verify-runtime.mjs');
 await startChild({binding,verifyRuntime:()=>verify.assertRuntime('/prototype-tools/base-runtime.json')});
}
