import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import { createMeasurementArtifactChannel, measurementChannelPreflightSignal, runMeasurementChannelPreflight } from '../scripts/load/run-classpilot-remote-generator.mjs';
import { CapturePulseController, measurementExpected, measurementPlan, publicBindingFromDevice, measurementSignal } from '../scripts/load/classpilot-reliability-profile.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
const expected=measurementExpected({campaign:'classpilot-staging-20261014-abcdefabcdef',runId:'40-abcdefabcdefabcd',
 primaryDevices:40,candidateApiImage:'135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:'+'1'.repeat(64),
 scriptBundleSha256:'2'.repeat(64),files:{devices:{sha256:'3'.repeat(64)}},
 measurementPlan:measurementPlan(40),measurementPlanSha256:sha(JSON.stringify(measurementPlan(40)))},'4'.repeat(64));
const pulse=()=>new CapturePulseController(expected,{now:()=>performance.now()}).issue();
const nonce='a'.repeat(48);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
class FakeS3 {
 constructor(handler){this.config={maxAttempts:1,region:'us-east-1'};this.middlewares=[];this.middlewareStack={add:f=>this.middlewares.push(f)};this.handler=handler;this.calls=0;this.transportCalls=0;this.destroyed=false;}
 async send(command,options){this.calls++;const input=command.input;const args={request:{method:command.constructor.name==='GetObjectCommand'?'GET':'PUT',protocol:'https:',hostname:input.Bucket+'.s3.us-east-1.amazonaws.com',path:'/'+input.Key,headers:{'x-amz-expected-bucket-owner':input.ExpectedBucketOwner}},command};
  let next=async()=>{this.transportCalls++;return this.handler(command,options);};for(const f of this.middlewares.slice().reverse())next=f(next);return next(args);}
 destroy(){this.destroyed=true;}
}
const stream=value=>Readable.from([Buffer.from(JSON.stringify(value))]);
const assertDeadline=elapsed=>assert.ok(elapsed>=220&&elapsed<800,'Actual250ms full-body caller deadline, allowing scheduling latency only');
const devices=Array.from({length:50},(_,i)=>{const value={deviceId:'synthetic-device-'+i,studentId:'synthetic-student-'+i,schoolId:'synthetic-school'};return{...value,studentToken:'x.'+Buffer.from(JSON.stringify({...value,sessionId:'synthetic-session-'+i})).toString('base64url')+'.x'};});

test('channel rejects wrong roles/keys/context/mode before SDK dispatch and freezes context',async()=>{
 const sdk=new FakeS3(()=>{throw Error('Unexpected dispatch');});
 for(const role of [undefined,'__proto__','api','Controller'])assert.throws(()=>createMeasurementArtifactChannel({role,expected,s3:sdk}));
 for(const patch of [{account:'000000000000'},{bucket:'other'},{origin:'https://school-pilot.net'},{campaign:'foreign'},{runId:'40-foreign'},{sourceArtifactSha256:'x'},{maximumPulses:999},{planSha256:'0'.repeat(64)},{extra:true}])
  assert.throws(()=>createMeasurementArtifactChannel({role:'controller',expected:{...expected,...patch},s3:sdk}));
 assert.throws(()=>createMeasurementArtifactChannel({role:'controller',expected,mode:'ordinary',s3:sdk}));
 const c=createMeasurementArtifactChannel({role:'controller',expected,s3:sdk});
 for(const name of ['measurement-control.json','../measurement-started.json','auth.json','measurement-started.json?x'])
  await assert.rejects(c.read(name,{nonce}));
 await assert.rejects(c.publish('measurement-started.json',{}));
 await assert.rejects(c.read('measurement-started.json',{nonce:'wrong'}));
 assert.equal(sdk.calls,0);c.close();await assert.rejects(c.publish('measurement-control.json',pulse()));
});

test('actual role adapters round-trip strict controls/bootstrap/signals with one physical attempt and bounded bytes',async()=>{
 const values=new Map(), input=new FakeS3(command=>{if(command.constructor.name==='PutObjectCommand'){values.set(command.input.Key,Buffer.from(command.input.Body));return{};}return{Body:Readable.from([values.get(command.input.Key)])};});
 const output=new FakeS3(command=>{if(command.constructor.name==='PutObjectCommand'){values.set(command.input.Key,Buffer.from(command.input.Body));return{};}return{Body:Readable.from([values.get(command.input.Key)])};});
 const c=createMeasurementArtifactChannel({role:'controller',expected,devices,s3:input}),r=createMeasurementArtifactChannel({role:'producer',expected,devices,s3:output});
 const first=pulse();await c.publish('measurement-control.json',first);assert.deepEqual(await r.read('measurement-control.json'),first);
 const bootstrap={schemaVersion:1,runId:expected.runId,sourceArtifactSha256:expected.sourceArtifactSha256,cohortSha256:expected.cohortSha256,planSha256:expected.planSha256,
  revisionBaselines:devices.slice(10).map(device=>({publicBinding:publicBindingFromDevice(device),revisionBase:1}))};
 await c.publish('measurement-bootstrap.json',bootstrap);assert.deepEqual(await r.read('measurement-bootstrap.json'),bootstrap);
 for(const [name,kind]of[['measurement-started.json','measurement-started-v3'],['measurement-drained.json','measurement-drained-v3']]){
  const signal=measurementSignal(expected,kind,nonce);await r.publish(name,signal,{kind,nonce});assert.deepEqual(await c.read(name,{kind,nonce}),signal);}
 assert.equal(c.summary().actualNetworkAttempts,4);assert.equal(r.summary().actualNetworkAttempts,4);
 assert.equal(c.summary().reader.timeouts,0);assert.equal(r.summary().publisher.timeouts,0);
 c.close();r.close();assert.equal(input.destroyed,true);assert.equal(output.destroyed,true);
});

test('strict signal and bootstrap schemas cannot publish unknown content or foreign nonces',async()=>{
 const sdk=new FakeS3(()=>{throw Error('Unexpected dispatch');});const c=createMeasurementArtifactChannel({role:'controller',expected,devices,s3:sdk});
 for(const value of [{...pulse(),extra:true},{...pulse(),lifetimeMs:1},{...pulse(),sourceArtifactSha256:'0'.repeat(64)}])await assert.rejects(c.publish('measurement-control.json',value));
 await assert.rejects(c.publish('measurement-bootstrap.json',{schemaVersion:1}));
 const r=createMeasurementArtifactChannel({role:'producer',expected,s3:new FakeS3(()=>{throw Error('Unexpected dispatch');})});
 await assert.rejects(r.publish('measurement-started.json',{...measurementSignal(expected,'measurement-started-v3',nonce),extra:true},{nonce}));
 await assert.rejects(r.publish('measurement-started.json',measurementSignal(expected,'measurement-started-v3',nonce),{nonce:'b'.repeat(48)}));
 assert.equal(sdk.calls,0);c.close();r.close();
});

test('SDK header stall releases250ms caller but retains singleflight until actual late settlement',async()=>{
 const hold=deferred();let signal;const sdk=new FakeS3((_c,o)=>{signal=o.abortSignal;return hold.promise;});
 const c=createMeasurementArtifactChannel({role:'producer',expected,s3:sdk});
 const began=performance.now();await assert.rejects(c.read('measurement-control.json'),/deadline/);assertDeadline(performance.now()-began);
 assert.equal(signal.aborted,true);assert.equal(c.summary().readInFlight,true);
 await assert.rejects(c.read('measurement-control.json'),/settling/);assert.equal(sdk.calls,1);
 hold.resolve({Body:stream(pulse())});await delay(20);
 assert.equal(c.summary().readInFlight,false);assert.equal(c.summary().reader.lateSettlements,1);assert.equal(c.summary().bytesRead,0);c.close();
});

test('header+body share one250ms deadline and an ignored body abort retains its guard',async()=>{
 const hold=deferred();let destroyed=false;const sdk=new FakeS3(async()=>{await delay(140);return{Body:{destroy(){destroyed=true;},async*[Symbol.asyncIterator](){yield Buffer.from('{"a":');await hold.promise;yield Buffer.from('1}');}}};});
 const c=createMeasurementArtifactChannel({role:'producer',expected,s3:sdk});
 const began=performance.now();await assert.rejects(c.read('measurement-control.json'),/deadline/);assertDeadline(performance.now()-began);
 assert.equal(destroyed,true);assert.equal(c.summary().readInFlight,true);
 await assert.rejects(c.read('measurement-control.json'),/settling/);assert.equal(sdk.calls,1);
 hold.resolve();await delay(20);assert.equal(c.summary().reader.lateSettlements,1);assert.equal(c.summary().bytesRead,0);c.close();
});

test('oversized or malformed complete body is rejected without an unbounded read',async()=>{
 for(const body of [Buffer.alloc(4097),Buffer.from('{"not":"a-control"}'),Buffer.from('{')]){
  let destroyed=false;const source=Readable.from([body]);const destroy=source.destroy.bind(source);source.destroy=(error)=>{destroyed=true;return destroy(error);};
  const c=createMeasurementArtifactChannel({role:'producer',expected,s3:new FakeS3(()=>({Body:source}))});
  await assert.rejects(c.read('measurement-control.json'));if(body.length>4096)assert.equal(destroyed,true);c.close();
 }
});

test('wedged publication is bounded500ms and late receipt cannot release a second caller before settlement',async()=>{
 const hold=deferred();let signal;const sdk=new FakeS3((_c,o)=>{signal=o.abortSignal;return hold.promise;});
 const c=createMeasurementArtifactChannel({role:'controller',expected,s3:sdk});
 const began=performance.now();await assert.rejects(c.publish('measurement-control.json',pulse()),/deadline/);
 assert.ok(performance.now()-began>=470&&performance.now()-began<1100);
 assert.equal(signal.aborted,true);assert.equal(c.summary().publicationInFlight,true);
 await assert.rejects(c.publish('measurement-control.json',pulse()),/settling/);assert.equal(sdk.calls,1);
 hold.resolve({});await delay(20);assert.equal(c.summary().publisher.lateSettlements,1);assert.equal(c.summary().bytesWritten,0);c.close();
});

test('multi-attempt or wrong-region clients cannot reach transport',async()=>{
 for(const patch of [{maxAttempts:2},{region:'us-west-2'}]){
  const sdk=new FakeS3(()=>({Body:stream(pulse())}));Object.assign(sdk.config,patch);
  const c=createMeasurementArtifactChannel({role:'producer',expected,s3:sdk});await assert.rejects(c.read('measurement-control.json'));
  assert.equal(sdk.calls,0);assert.equal(c.summary().actualNetworkAttempts,0);c.close();
 }
});

test('separate channel-only start/drain can never establish ordinary workload start',async()=>{
 const values=new Map(), make=()=>new FakeS3(command=>{if(command.constructor.name==='PutObjectCommand'){values.set(command.input.Key,Buffer.from(command.input.Body));return{};}return{Body:Readable.from([values.get(command.input.Key)])};});
 const c=createMeasurementArtifactChannel({role:'controller',expected,mode:'channel-preflight',s3:make()}),r=createMeasurementArtifactChannel({role:'producer',expected,mode:'channel-preflight',s3:make()});
 await assert.rejects(c.publish('measurement-bootstrap.json',{}));
 for(const [name,kind]of[['measurement-started.json','measurement-channel-started-v1'],['measurement-drained.json','measurement-channel-drained-v1']]){
  const value=measurementChannelPreflightSignal(expected,kind,nonce);
  assert.equal(value.trafficStarted,false);assert.equal(value.applicationRequests,0);assert.equal(value.preflightOnly,true);
  await r.publish(name,value,{kind,nonce});assert.deepEqual(await c.read(name,{kind,nonce}),value);
  const ordinary=createMeasurementArtifactChannel({role:'controller',expected,s3:make()});await assert.rejects(ordinary.read(name,{nonce}));ordinary.close();
 }
 c.close();r.close();
});

test('real SDK middleware signs exact S3 role paths/owner/encryption without network transport',async()=>{
 let requests=0;const first=pulse();
 const sdk=new S3Client({region:'us-east-1',maxAttempts:1,credentials:{accessKeyId:'synthetic-key',secretAccessKey:'synthetic-secret'},
  requestHandler:{async handle(request){requests++;assert.equal(request.protocol,'https:');assert.equal(request.hostname,expected.bucket+'.s3.us-east-1.amazonaws.com');
   assert.equal(request.headers['x-amz-expected-bucket-owner'],expected.account);assert.ok(request.headers.authorization);
   if(request.method==='PUT'){assert.equal(request.headers['x-amz-server-side-encryption'],'AES256');assert.equal(request.headers['content-type'],'application/json');}
   return{response:{statusCode:200,headers:{'content-type':'application/json'},body:request.method==='GET'?stream(first):Readable.from([])}};},destroy(){}}});
 const r=createMeasurementArtifactChannel({role:'producer',expected,s3:sdk});assert.deepEqual(await r.read('measurement-control.json'),first);r.close();assert.equal(requests,1);
 const putSdk=new S3Client({region:'us-east-1',maxAttempts:1,credentials:{accessKeyId:'synthetic-key',secretAccessKey:'synthetic-secret'},
 requestHandler:{async handle(request){requests++;assert.equal(request.headers['x-amz-expected-bucket-owner'],expected.account);assert.equal(request.headers['x-amz-server-side-encryption'],'AES256');return{response:{statusCode:200,headers:{},body:Readable.from([])}};},destroy(){}}});
 const c=createMeasurementArtifactChannel({role:'controller',expected,s3:putSdk});await c.publish('measurement-control.json',first);c.close();assert.equal(requests,2);
});

test('actual producer uses shared adapter;17-file closure and metadata-only activation remain distinct',()=>{
 const source=readFileSync(new URL('../scripts/load/run-classpilot-remote-generator.mjs',import.meta.url),'utf8');
 assert.match(source,/const measurementChannel = createMeasurementArtifactChannel/);
 assert.match(source,/measurementS3/);assert.doesNotMatch(source,/const controlReader = new BoundedControlReader/);
 const manifest=readFileSync(new URL('../scripts/load/remote-generator-manifest.mjs',import.meta.url),'utf8');
 const list=manifest.slice(manifest.indexOf('REMOTE_GENERATOR_SCRIPTS'),manifest.indexOf(']);',manifest.indexOf('REMOTE_GENERATOR_SCRIPTS')));
 assert.equal([...list.matchAll(/'[a-z0-9-]+\.mjs'/g)].length,17);
 assert.match(source,/phase: 'metadata-preflight'/);assert.match(source,/trafficStarted: false, inputsDownloaded: false/);
});


test('native channel CLI branch precedes every input/harness path and fails on nonnative host without SDK/app calls',async()=>{
 const source=readFileSync(new URL('../scripts/load/run-classpilot-remote-generator.mjs',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('export async function runMeasurementChannelPreflight'),source.indexOf('export async function runRemoteGenerator'));
 assert.doesNotMatch(body,/executeHarness|generatorChildEnvironment|INPUTS|assertAggregateEvidence|LOAD_DEVICE_MANIFEST/);
 assert.match(body,/mode: 'channel-preflight'/);assert.match(body,/applicationRequests: 0, inputsDownloaded: false, trafficStarted: false/);
 assert.match(body,/process\.getuid\?\.\(\) !== 1000/);assert.match(body,/scratchOwnerUid: owner.uid/);
 const main=source.slice(source.indexOf("if (process.argv[1]"));
 assert.ok(main.indexOf("'--preflight-measurement-channel'")<main.indexOf('else runRemoteGenerator()'));
 if(process.platform!=='linux'||process.getuid?.()!==1000){let calls=0;await assert.rejects(runMeasurementChannelPreflight({metadata:()=>{calls++;throw Error('Unexpected metadata');},measurementS3:new FakeS3(()=>{calls++;throw Error('Unexpected SDK');})}));assert.equal(calls,0);}
});

