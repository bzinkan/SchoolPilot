// PRIVATE successor source preparation. This module has no import-time SDK,
// credentials, dispatch, timers, application, or environment access.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {validateSourceContext,sourceLedgerKey,SOURCE_LIMITS,sourceOperationDenied} from './producer-source-ledger.mjs';
const ACCOUNT='135775632425',BUCKET='schoolpilot-staging-load-135775632425';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function createSourceLedgerSdkBridge({SDK,context,role,taskRoleProvider,s3:injected,now=()=>performance.now(),initialChargedBytes=0}){
 const c=Object.freeze(validateSourceContext(context)),key=sourceLedgerKey(c);
 assert.ok(role==='producer'||role==='controller');assert.equal(typeof taskRoleProvider,'function');
 assert.ok(Number.isSafeInteger(initialChargedBytes)&&initialChargedBytes>=0&&initialChargedBytes<=SOURCE_LIMITS.maximumBodyBytes);
 const s3=injected??new SDK.S3Client({region:'us-east-1',maxAttempts:1,credentials:taskRoleProvider,followRegionRedirects:false});
 assert.equal(typeof s3.send,'function');assert.equal(typeof s3.destroy,'function');assert.equal(typeof s3.middlewareStack?.add,'function');
 let closed=false,retired=false,rawActive=null,sends=0,responseReservedBytes=0,last=-Infinity;
 const counters={admittedWrites:0,admittedReads:0,chargedWriteBytes:initialChargedBytes,networkAttempts:0,acceptedWrites:0,unknownWrites:0,chargedResponseBytes:0,watchdogExpired:0};
 const clock=()=>{const t=now();assert.ok(Number.isFinite(t)&&t>=0&&t>=last);last=t;return t;};
 const retire=()=>{if(retired)return;retired=true;try{s3.destroy();}catch{}};
 s3.middlewareStack.add(next=>async args=>{
  const r=args.request;assert.ok(!closed&&!retired);
  assert.ok(r?.protocol==='https:'&&r.hostname===BUCKET+'.s3.us-east-1.amazonaws.com'&&(r.port===undefined||r.port===443));
  assert.equal(r.path,'/'+key);assert.equal(r.method,role==='producer'?'PUT':'GET');
  assert.equal(r.headers['x-amz-expected-bucket-owner'],ACCOUNT);
  if(r.method==='PUT'){assert.equal(r.headers['content-type'],'application/json');assert.equal(r.headers['x-amz-server-side-encryption'],'AES256');}
  counters.networkAttempts++;assert.ok(counters.networkAttempts<=sends);
  return next(args);
 },{step:'finalizeRequest',name:'classpilotExactSourceLedger',priority:'low'});
 const send=async(command,signal)=>{
  assert.ok(!closed&&!retired);
  assert.equal(typeof s3.config.maxAttempts==='function'?await s3.config.maxAttempts():s3.config.maxAttempts,1);
  assert.equal(typeof s3.config.region==='function'?await s3.config.region():s3.config.region,'us-east-1');
  assert.ok(!closed&&!retired);sends++;return s3.send(command,{abortSignal:signal});
 };
 const writeRaw=({key:requested,bytes,signal,ifNoneMatch})=>{
  assert.equal(role,'producer');assert.equal(requested,key);assert.ok(!closed&&!retired&&!rawActive);
  assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=SOURCE_LIMITS.maximumBodyBytes);
  assert.ok(counters.chargedWriteBytes+bytes.length+SOURCE_LIMITS.maximumBodyBytes<=SOURCE_LIMITS.maximumChargedBytes);
  assert.ok(counters.admittedWrites<c.durationMs/5000+2);assert.ok(ifNoneMatch===undefined||ifNoneMatch==='*');
  responseReservedBytes=SOURCE_LIMITS.maximumBodyBytes;counters.chargedWriteBytes+=bytes.length;counters.admittedWrites++;
  // Ownership is the exact borrowed Buffer through true SDK settlement. The
  // caller (retained publisher/startup) owns its zeroing, including late replies.
  let responseBody;const destroyBody=()=>{try{responseBody?.destroy?.();}catch{}};
  const drainBody=async body=>{responseBody=body;if(body===undefined||body===null)return;let received=0,failure=null;
   if(Buffer.isBuffer(body)||body instanceof Uint8Array||typeof body==='string'){const owned=typeof body==='string'?Buffer.from(body):body;responseBody={async*[Symbol.asyncIterator](){try{yield owned;}finally{owned.fill(0);}},destroy(){}};}
   destroyBody();
   if(typeof responseBody?.[Symbol.asyncIterator]!=='function'){retire();await new Promise(()=>{});}
   for await(const chunk of responseBody){if(!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array)){failure??=Error('Source PUT response chunk refused');retire();destroyBody();continue;}received+=chunk.length;counters.chargedWriteBytes+=chunk.length;counters.chargedResponseBytes+=chunk.length;responseReservedBytes=Math.max(0,SOURCE_LIMITS.maximumBodyBytes-received);if(received>SOURCE_LIMITS.maximumBodyBytes||counters.chargedWriteBytes>SOURCE_LIMITS.maximumChargedBytes){failure??=Error('Source PUT response envelope exceeded');retire();destroyBody();}}
   if(failure)throw failure;
  };
  const raw=Promise.resolve().then(async()=>{assert.ok(!closed&&!retired);let response;
   try{response=await send(new SDK.PutObjectCommand({Bucket:BUCKET,ExpectedBucketOwner:ACCOUNT,Key:key,Body:bytes,ContentType:'application/json',ServerSideEncryption:'AES256',...(ifNoneMatch?{IfNoneMatch:ifNoneMatch}:{})}),signal);}
   catch(error){const denied=sourceOperationDenied(error);if(denied)retire();try{await drainBody(error?.$response?.body);}catch(bodyError){if(!denied)throw bodyError;}throw error;}
   const denied=sourceOperationDenied(response);if(denied||response?.$metadata?.httpStatusCode!==200)retire();try{await drainBody(response?.Body??response?.$response?.body);}catch(bodyError){if(!denied)throw bodyError;}if(denied)throw response;assert.equal(response?.$metadata?.httpStatusCode,200);assert.ok(!closed&&!retired&&!signal?.aborted);return{accepted:true};
  });
  let watchdog=setTimeout(()=>{counters.watchdogExpired++;destroyBody();retire();},2000);
  const retained=raw.finally(()=>{clearTimeout(watchdog);responseReservedBytes=0;destroyBody();if(rawActive===retained)rawActive=null;});rawActive=retained;retained.catch(()=>{});return retained;
 };
 const publishOwnedCopy=({key:requested,bytes})=>{
  const deadlineAt=clock()+500,bodySha256=sha(bytes),abort=new AbortController();
  const settled=writeRaw({key:requested,bytes,signal:abort.signal,ifNoneMatch:'*'});
  let timer;
  const caller=Promise.race([settled,new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('Initial source PUT unknown'));},Math.max(0,deadlineAt-clock()));})])
   .then(()=>{assert.ok(!closed&&!retired&&clock()<deadlineAt);counters.acceptedWrites++;return{outcome:'accepted',key,bodySha256,producerTaskArn:c.producerTaskArn,producerBundleSha256:c.producerBundleSha256};})
   .catch(error=>{counters.unknownWrites++;throw error;}).finally(()=>clearTimeout(timer));
  caller.catch(()=>{});return{caller,settled};
 };
 return{
  writeRaw,publishOwnedCopy,
  async readRaw({key:requested,ifNoneMatch,signal}){
   assert.equal(role,'controller');assert.equal(requested,key);assert.ok(!closed&&!retired);
   assert.ok(counters.admittedReads++<c.durationMs/1000+8);
   if(ifNoneMatch!==null&&ifNoneMatch!==undefined)assert.match(ifNoneMatch,/^"[a-f0-9]{32}"$/);
   // The retained reader adopts Body BEFORE status/deadline checks and owns it
   // through true iterator settlement. Do not throw away late bodies here.
   let response;
   try{response=await send(new SDK.GetObjectCommand({Bucket:BUCKET,ExpectedBucketOwner:ACCOUNT,Key:key,...(ifNoneMatch?{IfNoneMatch:ifNoneMatch}:{})}),signal);}
   catch(error){
    // Smithy's locked protocol treats >=300 as errors. A conditional304 with
    // no response body is an unchanged object, never a successful new snapshot.
    // Unexpected body bytes are still handed to the retained reader to charge,
    // drain and reject; denial aliases/403/404 remain untouched.
    const denied=sourceOperationDenied(error),status=error?.$metadata?.httpStatusCode;
    let body=error?.$response?.body;
    // Denial aliases outrank a conflicting304, even after the caller aborts.
    // Any SDK-owned error response Body is transferred before the retained
    // reader considers status, liveness or its original250ms deadline.
    if(!denied&&!(status===304&&ifNoneMatch)&&!Number.isInteger(status)&&body===undefined)throw error;
    if(status===304&&!ifNoneMatch&&!denied&&body===undefined)throw error;
    if(Buffer.isBuffer(body)||body instanceof Uint8Array){
     const owned=body;
     body=owned.length?{async *[Symbol.asyncIterator](){try{yield owned;}finally{owned.fill(0);}},destroy(){/* Already materialized SDK bytes drain under the retained reader. */}}:undefined;
    }else if(body===''||body===null)body=undefined;
    const effectiveStatus=denied?(status===404||['NoSuchKey'].includes(error?.name)||['NoSuchKey'].includes(error?.Code)||['NoSuchKey'].includes(error?.code)?404:403):(Number.isInteger(status)?status:500);
    response={$metadata:{httpStatusCode:effectiveStatus},Body:body};
   }
   const denied=sourceOperationDenied(response),status=denied?(response?.$metadata?.httpStatusCode===404||[response?.name,response?.Code,response?.code].includes('NoSuchKey')?404:403):response?.$metadata?.httpStatusCode;
   return{...response,status};
  },
  retire,close(){closed=true;retire();},
  whenSettled:()=>Promise.allSettled(rawActive?[rawActive]:[]),
  summary:()=>({...counters,closed,retired,rawWriteActive:Boolean(rawActive),responseReservedBytes,sourceKeyScopeCount:1,role,capacityAccepted:false})
 };
}