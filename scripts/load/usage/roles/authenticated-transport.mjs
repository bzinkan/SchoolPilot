import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {createFrameDecoder,encodeFrame,createBoundedSender,createSequencedChannel,ProtocolError,MAX_FRAME_BYTES} from './owned-ipc-core.mjs';

const identityKeys=['run','source','role','containerId'];
const fixed=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const error=code=>{throw new ProtocolError(code);};
function validateIdentity(binding){
 if(!binding||!['api','worker','generator'].includes(binding.role)||!hex(binding.containerId)||!hex(binding.nonce)||!/^[a-f0-9]{12}$/.test(binding.run)||!/^[a-f0-9]{40}$/.test(binding.source))error('TRANSPORT_BINDING');
}
function identity(binding){return Object.fromEntries(identityKeys.map(key=>[key,binding[key]]));}
function proof(binding,purpose,client,server){return createHmac('sha256',Buffer.from(binding.nonce,'hex')).update(JSON.stringify([purpose,...identityKeys.map(key=>binding[key]),client,server])).digest('hex');}
function sameProof(actual,expected){return hex(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}

// No secret is transmitted. The fresh challenge transcript binds both ends to
// the exact role/run/source/container; a reused role connection is disallowed by
// the coordinator registry. Handshake frames have a separate 4KiB bound.
export function attachAuthenticatedTransport(socket,{side,binding,resolveBinding,onAuthenticated,onPayload,onClose=()=>{},onFailure=()=>{},random=()=>randomBytes(32).toString('hex'),setTimer=setTimeout,clearTimer=clearTimeout}){
 if(!['client','server'].includes(side))error('TRANSPORT_SIDE');
 if(side==='client')validateIdentity(binding);
 let state=side==='client'?'challenge':'hello',clientChallenge,serverChallenge,closed=false,authenticated=false,channel;
 let activeBinding=binding?Object.freeze({...binding}):undefined;
 const bufferedSender=createBoundedSender(socket),wire={sentFrames:0,sentBytes:0,maximumSentFrameBytes:0,receivedFrames:0,receivedBytes:0,maximumReceivedFrameBytes:0};
 const sender=(frame,callback)=>{wire.sentFrames++;wire.sentBytes+=frame.length;wire.maximumSentFrameBytes=Math.max(wire.maximumSentFrameBytes,frame.length-4);return bufferedSender(frame,callback);};
 const close=code=>{if(closed)return;closed=true;clearTimer(timer);channel?.close();try{onFailure(code);}finally{socket.destroy();}};
 let timer=setTimer(()=>close('HANDSHAKE_DEADLINE'),5000);
 let decoder;
 const installDataDecoder=()=>{
  channel=createSequencedChannel({send:sender,onPayload,onViolation:code=>close(code)});
  decoder=createFrameDecoder(frame=>channel.receive(frame),{maxBytes:MAX_FRAME_BYTES});
  authenticated=true;state='open';clearTimer(timer);
  onAuthenticated(Object.freeze(identity(activeBinding)),Object.freeze({send:(kind,payload,callback)=>channel.send(kind,payload,callback),close:()=>socket.destroy(),snapshot:()=>({...wire,sequence:channel.snapshot()})}));
 };
 const handshake=frame=>{
  if(side==='server'&&state==='hello'){
   if(!fixed(frame,['kind',...identityKeys,'challenge'])||frame.kind!=='hello'||!hex(frame.challenge))error('HANDSHAKE_SHAPE');
   activeBinding=Object.freeze({...resolveBinding(identity(frame))});validateIdentity(activeBinding);
   for(const key of identityKeys)if(frame[key]!==activeBinding[key])error('HANDSHAKE_BINDING');
   clientChallenge=frame.challenge;serverChallenge=random();if(!hex(serverChallenge))error('HANDSHAKE_RANDOM');state='proof';
   sender(encodeFrame({kind:'challenge',challenge:serverChallenge,proof:proof(activeBinding,'server',clientChallenge,serverChallenge)},4096));
  }else if(side==='client'&&state==='challenge'){
   if(!fixed(frame,['kind','challenge','proof'])||frame.kind!=='challenge'||!hex(frame.challenge)||!sameProof(frame.proof,proof(activeBinding,'server',clientChallenge,frame.challenge)))error('HANDSHAKE_SERVER_PROOF');
   serverChallenge=frame.challenge;state='ack';sender(encodeFrame({kind:'proof',proof:proof(activeBinding,'client',clientChallenge,serverChallenge)},4096));
  }else if(side==='server'&&state==='proof'){
   if(!fixed(frame,['kind','proof'])||frame.kind!=='proof'||!sameProof(frame.proof,proof(activeBinding,'client',clientChallenge,serverChallenge)))error('HANDSHAKE_CLIENT_PROOF');
   sender(encodeFrame({kind:'ack',proof:proof(activeBinding,'ack',clientChallenge,serverChallenge)},4096));installDataDecoder();
  }else if(side==='client'&&state==='ack'){
   if(!fixed(frame,['kind','proof'])||frame.kind!=='ack'||!sameProof(frame.proof,proof(activeBinding,'ack',clientChallenge,serverChallenge)))error('HANDSHAKE_ACK');
   installDataDecoder();
  }else error('HANDSHAKE_STATE');
 };
 decoder=createFrameDecoder(handshake,{maxBytes:4096});
 // The decoder consumes one frame at a time. This permits a handshake ACK and
 // first data frame in the same TCP chunk without applying the small bound to
 // authenticated traffic, or allowing unauthenticated large allocations.
 let header=Buffer.alloc(4),headerUsed=0,bodyLeft=0,bodyLength=0;
 socket.on('data',chunk=>{if(closed)return;try{let offset=0;while(offset<chunk.length){
  if(bodyLeft===0){const take=Math.min(4-headerUsed,chunk.length-offset);chunk.copy(header,headerUsed,offset,offset+take);headerUsed+=take;offset+=take;if(headerUsed!==4)continue;
   bodyLeft=header.readUInt32BE(0);bodyLength=bodyLeft;decoder.push(header);headerUsed=0;
  }
  const take=Math.min(bodyLeft,chunk.length-offset);decoder.push(chunk.subarray(offset,offset+take));bodyLeft-=take;offset+=take;if(bodyLeft===0){wire.receivedFrames++;wire.receivedBytes+=bodyLength+4;wire.maximumReceivedFrameBytes=Math.max(wire.maximumReceivedFrameBytes,bodyLength);}
 }}catch{close('TRANSPORT_FRAME_REJECTED');}});
 socket.on('error',()=>close('TRANSPORT_SOCKET_ERROR'));
 socket.on('close',()=>{if(!closed){closed=true;clearTimer(timer);channel?.close();if(headerUsed||bodyLeft){onFailure('TRANSPORT_TRUNCATED');}else if(!authenticated){onFailure('HANDSHAKE_INCOMPLETE');}}onClose();});
 if(side==='client'){clientChallenge=random();if(!hex(clientChallenge))error('HANDSHAKE_RANDOM');sender(encodeFrame({kind:'hello',...identity(activeBinding),challenge:clientChallenge},4096));}
 return Object.freeze({close:()=>socket.destroy(),snapshot:()=>({state,authenticated,closed,...wire,channel:channel?.snapshot()})});
}
