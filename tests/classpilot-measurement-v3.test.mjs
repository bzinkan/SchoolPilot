import test from 'node:test'; import assert from 'node:assert/strict'; import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { reliabilityProfile, measurementPlan, measurementPlanDigest, validateMeasurementPlan, measurementExpected,
  CapturePulseController, CapturePulseProducer, stampCausalCapture, readCausalCapture, publicBindingFromDevice,
  validateCapturePulse, validateRevisionBootstrap, navigationSnapshot, navigationMessageMatches, navigationGate,
  SerialHeartbeatWriter, BoundedControlReader, measurementSignal, validateMeasurementSignal, makeReliabilityJpegFixture,
  observeRenderedStudentState,createBoundedObserverPool } from '../scripts/load/classpilot-reliability-profile.mjs';
import{renderedPixelsMatchBlend,renderedCaptureFrameAuthorized}from'../scripts/load/run-classpilot-rendered-dashboards.mjs';
import { REMOTE_GENERATOR_SCRIPTS, scriptManifest } from '../scripts/load/remote-generator-manifest.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const device = i => { const value = { deviceId: `synthetic-device-${i}`, studentId: `synthetic-student-${i}`, schoolId: i < 10 ? 'synthetic-canary' : 'synthetic-primary' };
  return { ...value, studentToken: 'e30.' + Buffer.from(JSON.stringify({ ...value, sessionId: `synthetic-session-${i}` })).toString('base64url') + '.synthetic' }; };
const devices = Array.from({ length: 50 }, (_, i) => device(i));
const manifest = { version: 2, campaign: 'classpilot-staging-20261013-000000000000', runId: '40-1111111111111111', primaryDevices: 40,
  candidateApiImage: '135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:' + 'd'.repeat(64), scriptBundleSha256: 'a'.repeat(64),
  measurementPlan: measurementPlan(40), measurementPlanSha256: measurementPlanDigest(40), files: { devices: { sha256: sha(JSON.stringify(devices)) } } };
const expected = measurementExpected(manifest, sha(JSON.stringify(manifest))), binding = publicBindingFromDevice(devices[10]);
const baseline = { schemaVersion: 1, runId: expected.runId, sourceArtifactSha256: expected.sourceArtifactSha256, cohortSha256: expected.cohortSha256,
  planSha256: expected.planSha256, revisionBaselines: devices.slice(10).map(value => ({ publicBinding: publicBindingFromDevice(value), revisionBase: 1700000000000000 })) };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('V3 plans retain fixed profiles, rates, strict identity and 17-file closure', () => {
  for (const count of [40,500,800]) { const p = reliabilityProfile(count); assert.equal(p.version, 'classpilot-reliability-v3'); assert.equal(p.heartbeatIntervalMs, 10000); assert.equal(p.screenshotIntervalMs, 5000); assert.equal(p.deviceIngestLimit, 100000); assert.equal(p.screenshotBytes,40960); validateMeasurementPlan(p.measurementPlan,count,measurementPlanDigest(count)); }
  assert.equal(REMOTE_GENERATOR_SCRIPTS.length,17); assert.equal(Object.keys(scriptManifest(new URL('../scripts/load/', import.meta.url).pathname.replace(/^\/(C:)/,'$1'), manifest.candidateApiImage, REMOTE_GENERATOR_SCRIPTS).files).length,17);
  assert.throws(() => validateMeasurementPlan({ ...measurementPlan(40), navigationPeriodMs:30000 },40,measurementPlanDigest(40)));
});
test('causal pulse records t0 before nonce and ignores all remote wall/monotonic origins', () => {
  let local = 100; const c = new CapturePulseController(expected,{now:()=>local,nonce:()=>{local+=4;return '1'.repeat(48);}}); const p=c.issue();
  const producer=new CapturePulseProducer(expected,()=>900000000); producer.adopt(p); local=650;
  assert.equal(c.ageUpper(producer.markerForCapture(binding),binding),550); assert.equal(c.history.get(1).t0,100);
});
test('strict pulse controls reject unknown fields, run/image/closure/plan/cohort mismatch and malformed round', () => {
  const c=new CapturePulseController(expected,{now:()=>0}), pulse=c.issue(); validateCapturePulse(pulse,expected);
  for (const change of [{ unknown:true },{runId:'40-'+ '2'.repeat(16)},{candidateApiImage:manifest.candidateApiImage.replace('d'.repeat(64),'e'.repeat(64))},
    {scriptBundleSha256:'b'.repeat(64)},{cohortSha256:'b'.repeat(64)},{planSha256:'b'.repeat(64)},{navigationRound:1},{lifetimeMs:999999}]) assert.throws(()=>validateCapturePulse({...pulse,...change},expected));
});
test('unknown, expired, wrong binding and legacy frames never fall back to Date', () => {
  let now=0; const c=new CapturePulseController(expected,{now:()=>now}), producer=new CapturePulseProducer(expected,()=>0); producer.adopt(c.issue()); const marker=producer.markerForCapture(binding);
  assert.throws(()=>c.ageUpper({...marker,pulseMarker:'0'.repeat(24)},binding)); assert.throws(()=>c.ageUpper(marker,'B'.repeat(43))); assert.throws(()=>c.ageUpper({capturedAt:Date.now()},binding)); now=20001; assert.throws(()=>c.ageUpper(marker,binding));
});
test('a repeated nonce cannot masquerade as a fresh causal trigger',()=>{
  const controller=new CapturePulseController(expected,{now:()=>0,nonce:()=> '5'.repeat(48)});controller.issue();assert.throws(()=>controller.issue(),/Fresh unpredictable/);
});
test('native color matching uses one alpha across all channels and points, rather than unrelated channel bounds',()=>{
  const red=[216,48,37,255],green=[24,128,57,255],blue=[26,115,233,255];
  assert.equal(renderedPixelsMatchBlend([[120,88,47,255]],red,green,0,1),true);
  for(const pair of [[red,green],[red,blue],[green,blue]])assert.equal(renderedPixelsMatchBlend([[180,120,100,255]],...pair,0,1),false);
  assert.equal(renderedPixelsMatchBlend([[120,88,47,255],[216,48,37,255]],red,green,0,1),false,'Different pixels must share the same actual opacity');
  const frame={ordinal:1,capturedAt:1700000000000,pulseSequence:1,pulseMarker:'a'.repeat(24),jpegSha256:'a'.repeat(64)};
  assert.equal(renderedCaptureFrameAuthorized({...frame,jpegSha256:'b'.repeat(64)},[frame]),false);
});
test('observer permits are reserved in queue order and peak queue includes the initial admission wave',async()=>{
  const pool=createBoundedObserverPool({limit:2,maximumQueue:40}),releases=[];
  const jobs=Array.from({length:20},()=>pool.run(()=>new Promise(resolve=>releases.push(resolve))));
  assert.equal(pool.summary().peakActive,2);assert.equal(pool.summary().peakQueued,18);assert.equal(pool.summary().queued,18);
  while(pool.summary().completed<20){const release=releases.shift();if(release)release();await tick();}
  await Promise.all(jobs);assert.equal(pool.summary().active,0);assert.equal(pool.summary().queued,0);
});
test('V2 causal stamp changes only the 96 reserved bytes and keeps per-device entropy immutable', () => {
  const source=readFileSync(new URL('../scripts/load/classpilot-load-test.mjs',import.meta.url),'utf8'), base=Buffer.from(source.match(/const JPEG_1X1\s*=\s*"([^"]+)";/)[1],'base64');
  const fixture=makeReliabilityJpegFixture(base), original=sha(fixture), c=new CapturePulseController(expected,{now:()=>0}), producer=new CapturePulseProducer(expected,()=>0); producer.adopt(c.issue());
  const data=stampCausalCapture(fixture,1700000000000,1,producer.markerForCapture(binding)), stamped=Buffer.from(data.split(',')[1],'base64');
  assert.equal(stamped.length,40960); assert.equal(sha(fixture),original); assert.deepEqual(stamped.subarray(0,-98),fixture.subarray(0,-98)); assert.deepEqual(stamped.subarray(-2),fixture.subarray(-2)); assert.ok(readCausalCapture(data));
});
test('revision bootstrap requires every exact binding and a genuinely present safe surviving revision', () => {
  validateRevisionBootstrap(baseline,expected,devices);
  for (const bad of [null,0,-1,NaN,Number.MAX_SAFE_INTEGER]) assert.throws(()=>validateRevisionBootstrap({...baseline,revisionBaselines:baseline.revisionBaselines.map((row,i)=>i?row:{...row,revisionBase:bad})},expected,devices));
  assert.throws(()=>validateRevisionBootstrap({...baseline,revisionBaselines:baseline.revisionBaselines.slice(1)},expected,devices));
  assert.throws(()=>validateRevisionBootstrap({...baseline,revisionBaselines:baseline.revisionBaselines.map((row,i)=>i?row:{...row,publicBinding:'B'.repeat(43)})},expected,devices));
});
test('successor navigation increments a verified high prior revision rather than restarting at round one', () => {
  const s=navigationSnapshot({runId:expected.runId,round:1,nonce:'1'.repeat(48)},binding,1700000000000000); assert.equal(s.tabSnapshotRevision,1700000000000001);
  assert.throws(()=>navigationSnapshot({runId:expected.runId,round:1,nonce:'1'.repeat(48)},binding));
});
test('first-start and drained receipts are exact typed run/source/nonce signals',()=>{
  const nonce='2'.repeat(48), signal=measurementSignal(expected,'measurement-started-v3',nonce); validateMeasurementSignal(signal,expected,'measurement-started-v3',nonce);
  for(const value of [false,null,'true',1]) assert.throws(()=>validateMeasurementSignal({...signal,trafficStarted:value},expected,'measurement-started-v3',nonce));
  assert.throws(()=>validateMeasurementSignal(signal,expected,'measurement-drained-v3',nonce)); assert.throws(()=>validateMeasurementSignal(signal,expected,'measurement-started-v3','3'.repeat(48)));
});
for(const failure of['failed','rejected'])test('regular heartbeat '+failure+' does not replay; fresh events preserve hold/cooldown/deny',async()=>{
  let now=100,cooldown=0,body='initial',next=0;const timers=new Map(),sent=[];
  const writer=new SerialHeartbeatWriter({now:()=>now,cooldownUntil:()=>cooldown,schedule:(run,ms)=>{assert.ok(Number.isFinite(ms)&&ms>0);const id=++next;timers.set(id,{run,due:now+ms,ms});return id;},clear:id=>timers.delete(id),snapshot:()=>({body}),send:async value=>{
    sent.push(value);if(sent.length===1){if(failure==='rejected')throw Error('Synthetic failed regular');return{ok:false};}return{ok:true};}});
  writer.regular();await tick();await tick();assert.equal(sent.length,1);assert.equal(writer.eventDue,Infinity);assert.equal(timers.size,0);assert.equal(writer.pendingEvent,false);
  now=200;body='navigation-one';writer.navigation();now=250;body='navigation-latest';writer.navigation();assert.equal(writer.eventDue,2200);assert.equal(timers.size,1);assert.equal(sent.length,1);
  writer.hold();cooldown=5000;now=2200;const waiting=[...timers.entries()][0];timers.delete(waiting[0]);waiting[1].run();await tick();assert.equal(sent.length,1,'Hold fences new work without dropping the event');assert.equal(writer.pendingEvent,true);
  writer.release();assert.equal(timers.size,1);assert.equal([...timers.values()][0].due,5000,'Existing cooldown remains authoritative');now=5000;const ready=[...timers.entries()][0];timers.delete(ready[0]);ready[1].run();await tick();await tick();assert.equal(sent.length,2);assert.deepEqual(sent[1],{body:'navigation-latest'});assert.equal(writer.active,false);assert.equal(writer.pendingEvent,false);assert.equal(timers.size,0);
  writer.send=async()=>({denied:true});writer.regular();await tick();await tick();assert.equal(writer.denied,true);writer.navigation();writer.regular();assert.equal(timers.size,0);assert.equal(writer.counters.started,3,'A denial still latches further dispatch');
});
test('drain holds dispatch after complete old HTTP operation while absolute regular work remains queued',async()=>{
  let finish; const requests=[], scheduled=[], state={title:'old'};
  const w=new SerialHeartbeatWriter({now:()=>0,schedule:(fn,ms)=>{scheduled.push({fn,ms});return scheduled.length;},clear:()=>{},snapshot:()=>({...state}),send:body=>{requests.push(body); return new Promise(resolve=>finish=resolve);}});
  w.regular(); await tick(); w.hold(); w.regular(); w.navigation(); state.title='new'; assert.equal(requests.length,1);
  finish({ok:true}); await tick(); await tick(); assert.equal(w.active,false); assert.equal(requests.length,1); assert.equal(w.regularPending,true);
  w.release(); await tick(); assert.equal(requests.length,2); assert.equal(requests[1].title,'new'); finish({ok:true}); await tick();
});
test('complete-body control timeout retains singleflight and fences late settlement',async()=>{
  let finish; const r=new BoundedControlReader(()=>new Promise(resolve=>finish=resolve),{timeoutMs:10}); await assert.rejects(r.read('control')); await assert.rejects(r.read('control'));
  finish(Buffer.from('{"round":1}')); await tick(); assert.equal(r.active,null); assert.equal(r.counters.lateSettlements,1); assert.equal(r.counters.attempts,1);
});
test('exact native student update requires subscription, actor scope, generation and surviving binding',()=>{
  const s=navigationSnapshot({runId:expected.runId,round:1,nonce:'1'.repeat(48)},binding,100), studentId=devices[10].studentId;
  const r={actor:{schoolId:'synthetic-primary',teachingSessionId:'synthetic-session'},allowed:new Set([studentId]),publicBindings:new Map([[studentId,binding]]),subscribed:true,socketGeneration:2,realtime:new Map()};
  const msg={type:'student-update',schoolId:r.actor.schoolId,studentId,realtimeBinding:binding,realtimeRevision:10,tabSnapshotRevision:s.tabSnapshotRevision,status:'active',...s};
  assert.equal(observeRenderedStudentState(r,msg,1),false); assert.equal(navigationMessageMatches(r.realtime.get(studentId),{...s,publicBinding:binding},r),true);
  r.socketGeneration+=1; assert.equal(navigationMessageMatches(r.realtime.get(studentId),{...s,publicBinding:binding},r),false);
  assert.equal(observeRenderedStudentState(r,{...msg,realtimeBinding:'B'.repeat(43)},2),true); assert.equal(observeRenderedStudentState(r,{...msg,schoolId:'synthetic-canary'},2),true);
});
test('pooled raw navigation histogram cannot pass missing samples, bindings, late ages or scope failures',()=>{
  const options={planned:40,primaryDevices:40,observedDevices:40}; assert.equal(navigationGate(Array(40).fill(2000),options).passed,true);
  assert.equal(navigationGate(Array(39).fill(1000),options).passed,false); assert.equal(navigationGate(Array(40).fill(6000),options).passed,false);
  assert.equal(navigationGate(Array(40).fill(1000),{...options,scopeErrors:1}).passed,false); assert.equal(navigationGate(Array(40).fill(1000),{...options,observedDevices:39}).passed,false);
});
