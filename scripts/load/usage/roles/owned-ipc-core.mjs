import {timingSafeEqual} from 'node:crypto';

export const MAX_FRAME_BYTES=16*1024*1024;
export const MAX_PENDING=32;
export class ProtocolError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new ProtocolError(code);};
export function encodeFrame(value,maxBytes=MAX_FRAME_BYTES){
 const payload=Buffer.from(JSON.stringify(value));if(payload.length<2||payload.length>maxBytes)fail('FRAME_SIZE');
 const frame=Buffer.allocUnsafe(4+payload.length);frame.writeUInt32BE(payload.length,0);payload.copy(frame,4);return frame;
}
export function createFrameDecoder(onFrame,{maxBytes=MAX_FRAME_BYTES}={}){
 let header=Buffer.alloc(4),headerUsed=0,payload,used=0,failed=false;
 return Object.freeze({
  push(chunk){if(failed)fail('FRAME_DECODER_CLOSED');let offset=0;
   try {while(offset<chunk.length){
    if(!payload){const n=Math.min(4-headerUsed,chunk.length-offset);chunk.copy(header,headerUsed,offset,offset+n);headerUsed+=n;offset+=n;
     if(headerUsed<4)continue;const size=header.readUInt32BE(0);if(size<2||size>maxBytes)fail('FRAME_SIZE');payload=Buffer.allocUnsafe(size);used=0;}
    const n=Math.min(payload.length-used,chunk.length-offset);chunk.copy(payload,used,offset,offset+n);used+=n;offset+=n;
    if(used===payload.length){let value;try{value=JSON.parse(payload.toString('utf8'));}catch{fail('FRAME_JSON');}
     payload=undefined;headerUsed=0;used=0;onFrame(value);}
   }}catch(error){failed=true;payload=undefined;throw error;}
  },
  finish(){if(payload||headerUsed)fail('FRAME_TRUNCATED');failed=true;},
  snapshot(){return {failed,bufferedBytes:headerUsed+used,allocatedPayloadBytes:payload?.length||0};},
 });
}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');}
export function verifyHello(hello,expected){
 if(!exactKeys(hello,['version','kind','run','source','role','containerId','nonce'])||hello.version!==1||hello.kind!=='hello')fail('HELLO_SHAPE');
 for(const key of ['run','source','role','containerId'])if(hello[key]!==expected[key])fail('HELLO_BINDING');
 if(typeof hello.nonce!=='string'||!/^[a-f0-9]{64}$/.test(hello.nonce)||!/^[a-f0-9]{64}$/.test(expected.nonce))fail('HELLO_AUTH');
 if(!timingSafeEqual(Buffer.from(hello.nonce,'hex'),Buffer.from(expected.nonce,'hex')))fail('HELLO_AUTH');
 return Object.freeze({run:expected.run,source:expected.source,role:expected.role,containerId:expected.containerId});
}
export function createSequencedChannel({send,onPayload,onViolation=()=>{}}){
 let outbound=0,inbound=0,closed=false;
 const stop=code=>{closed=true;onViolation(code);fail(code);};
 return Object.freeze({
  send(kind,payload,callback){if(closed)fail('CHANNEL_CLOSED');if(!['request','response','event','terminate'].includes(kind))stop('FRAME_KIND');return send(encodeFrame({version:1,sequence:++outbound,kind,payload}),callback);},
  receive(frame){if(closed)fail('CHANNEL_CLOSED');
   if(!exactKeys(frame,['version','sequence','kind','payload'])||frame.version!==1||frame.sequence!==inbound+1||!['request','response','event','terminate'].includes(frame.kind))stop('FRAME_SEQUENCE_OR_KIND');
   inbound++;onPayload(frame.kind,frame.payload);
  },
  close(){closed=true;},snapshot(){return {outbound,inbound,closed};},
 });
}
// A timeout rejects its caller but does not erase ownership of remote work.
// Only its matching response or an immutable host exit receipt settles it.
export function createRpcOwner({send,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,maxPending=MAX_PENDING}={}){
 const pending=new Map();let lastId=0,connected=true,violations=0,timeouts=0,lateResponses=0,unexpectedDisconnects=0,unsettledAtExit=0,shutdownAcknowledged=false,hostExit;
 function violation(code){violations++;throw new ProtocolError(code);}
 return Object.freeze({
  call(id,operation,value,timeoutMs=120000){
   if(!connected||hostExit)fail('RPC_DISCONNECTED');if(!Number.isSafeInteger(id)||id<=lastId)violation('RPC_REQUEST_ORDER');
   if(pending.size>=maxPending)violation('RPC_PENDING_BOUND');if(!['initialize','phase','correctness','snapshot','reset','quiesce','drain','rollup','shutdown'].includes(operation))violation('RPC_OPERATION');
   if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120000)violation('RPC_DEADLINE');lastId=id;
   return new Promise((resolve,reject)=>{
    const item={id,operation,started:now(),resolve,reject,expired:false,timer:undefined};pending.set(id,item);
    item.timer=setTimer(()=>{item.expired=true;timeouts++;reject(new ProtocolError('RPC_DEADLINE'));},timeoutMs);
    try{send({id,operation,...(value===undefined?{}:{value})});}catch(error){clearTimer(item.timer);item.expired=true;connected=false;reject(error);}
   });
  },
  response(message){
   if(!message||!Number.isSafeInteger(message.id)||!pending.has(message.id))violation('RPC_UNKNOWN_OR_DUPLICATE_RESPONSE');
   if(Object.keys(message).some(key=>!['id','value','error'].includes(key))||('value'in message)===('error'in message))violation('RPC_RESPONSE_SHAPE');
   const item=pending.get(message.id);pending.delete(message.id);clearTimer(item.timer);
   if(item.expired){lateResponses++;return;}
   if(Object.hasOwn(message,'error'))item.reject(new ProtocolError('REMOTE_OPERATION_FAILED'));else {if(item.operation==='shutdown')shutdownAcknowledged=true;item.resolve(message.value);}
  },
  disconnected(){if(!connected)return;if(!shutdownAcknowledged||pending.size)unexpectedDisconnects++;connected=false;for(const item of pending.values()){clearTimer(item.timer);if(!item.expired){item.expired=true;item.reject(new ProtocolError('RPC_DISCONNECTED'));}}},
  observeHostExit(receipt,expected){
   if(hostExit)violation('EXIT_RECEIPT_DUPLICATE');
   for(const key of ['containerId','imageId','run','role','source'])if(receipt[key]!==expected[key]||typeof expected[key]!=='string')violation('EXIT_RECEIPT_BINDING');
   if(receipt.inspected!==true||receipt.running!==false||receipt.logsClosed!==true||!Number.isInteger(receipt.exitCode)||typeof receipt.forced!=='boolean'||typeof receipt.oomKilled!=='boolean')violation('EXIT_RECEIPT_SHAPE');
   hostExit={exitCode:receipt.exitCode,forced:receipt.forced,oomKilled:receipt.oomKilled};unsettledAtExit=pending.size;connected=false;
   for(const item of pending.values()){clearTimer(item.timer);item.reject(new ProtocolError('RPC_PROCESS_EXIT'));}pending.clear();
  },
  snapshot(){return {connected,pending:pending.size,timedOutPending:[...pending.values()].filter(p=>p.expired).length,timeouts,lateResponses,violations,unexpectedDisconnects,unsettledAtExit,shutdownAcknowledged,hostExit,
   clean:!!hostExit&&hostExit.exitCode===0&&!hostExit.forced&&!hostExit.oomKilled&&pending.size===0&&unsettledAtExit===0&&timeouts===0&&lateResponses===0&&violations===0&&unexpectedDisconnects===0&&shutdownAcknowledged};},
 });
}
// Native net.Socket buffers are bounded explicitly; no unbounded user queue.
export function createBoundedSender(socket,{maxFrameBytes=MAX_FRAME_BYTES,maxBufferedBytes=2*MAX_FRAME_BYTES}={}){
 let failed=false;
 return (frame,callback)=>{if(failed||socket.destroyed)fail('TRANSPORT_CLOSED');if(!Buffer.isBuffer(frame)||frame.length>maxFrameBytes+4)fail('FRAME_SIZE');
  if(socket.writableLength+frame.length>maxBufferedBytes){failed=true;socket.destroy();fail('TRANSPORT_BACKPRESSURE_BOUND');}
  return socket.write(frame,callback);
 };
}

