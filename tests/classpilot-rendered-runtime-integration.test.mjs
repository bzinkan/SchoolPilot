import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createActualRenderedObserverRuntime, observeActualRenderedCapture, observeActualRenderedNavigationPaint, runActualRenderedCapturePhases,
  attachActualRenderedSocketObserver, retainActualRenderedCaptureEvidence, nativePixelsCausallyChanged, nativeNavigationPaintEvidence, nativeNavigationPaintChanged, actualRenderedNavigationPaintDecision, scoreRenderedCaptureAge, importRenderedControllerDependency, renderedRuntimeAuthoritySnapshot, renderedRuntimeAuthorityMatches, createNativeScreenshotDecoder, createNativeScreenshotCapture, RENDERED_VIEWPORT } from '../scripts/load/run-classpilot-rendered-dashboards.mjs';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const rgba=[60,100,130,255],frame={jpegSha256:'a'.repeat(64),ordinal:1,capturedAt:1,pulseSequence:1,pulseMarker:'b'.repeat(24)};
const card=id=>({studentId:id,frame:{...frame},previousFrame:null,displayed:true,decoded:true,points:[{x:20,y:20},{x:30,y:20},{x:40,y:20}],rgba:[...rgba],previousRgba:null,opacity:1,
  geometry:{left:10,top:10,width:50,height:50,naturalWidth:1,naturalHeight:1,objectFit:'contain'},opacityAnimated:false,contributors:[{...frame}]});
const origin={width:RENDERED_VIEWPORT.width,height:RENDERED_VIEWPORT.height,scrollX:0,scrollY:0,devicePixelRatio:1,
  visualViewport:{pageLeft:0,pageTop:0,offsetLeft:0,offsetTop:0,width:RENDERED_VIEWPORT.width,height:RENDERED_VIEWPORT.height,scale:1}};
let nextPid=800000;
function chromiumFixture({evaluate,contextFailure,launchGate,contextGate,closeIgnored=false,killFailure=false}={}){
  const records=[],order=[];
  const chromium={launchServer:async()=>{if(launchGate)await launchGate;const process=new EventEmitter();process.pid=nextPid++;process.exitCode=null;process.signalCode=null;
    const browser={connected:true,isConnected(){return this.connected;},version:()=> 'synthetic-native-contract',newContext:async()=>{if(contextGate)await contextGate;if(contextFailure)throw Error('setup failed');return context;}};
    const page={evaluate:evaluate|| (async fn=>fn.name==='nativeViewportOriginProof'?structuredClone(origin):{visible:true,cards:[card('student1')]}),context:()=>context};
    const context={newPage:async()=>page,newCDPSession:async original=>{assert.equal(original,page,'Native factories must bind the ORIGINAL Page');return{send:async(_method,{clip})=>{
      const png=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(png);Buffer.from('IHDR').copy(png,12);png.writeUInt32BE(clip.width,16);png.writeUInt32BE(clip.height,20);return{data:png.toString('base64')};},detach:async()=>{}};}};
    const server={process:()=>process,wsEndpoint:()=>String(process.pid),close:async()=>{order.push('close');if(closeIgnored)return new Promise(()=>{});process.exitCode=0;browser.connected=false;process.emit('exit',0);},kill:async()=>{order.push('kill');if(killFailure)throw Error('owned kill failed');process.signalCode='SIGTERM';browser.connected=false;process.emit('exit',null,'SIGTERM');}};
    const record={server,process,browser,page};records.push(record);return server;},connect:async endpoint=>records.find(record=>String(record.process.pid)===endpoint).browser};
  return{chromium,records,order};
}
function rawDecoder(afterDecode,decodeDelay=0){return createNativeScreenshotDecoder({maximumActive:1,decodeFactory:png=>{const width=png.readUInt32BE(16),height=png.readUInt32BE(20),data=Buffer.alloc(width*height*4);for(let n=0;n<data.length;n+=4)for(let c=0;c<4;c++)data[n+c]=rgba[c];return{promise:(async()=>{if(decodeDelay)await delay(decodeDelay);afterDecode?.();return{data,info:{width,height,channels:4}};})(),destroy:()=>{}};}});}
function binding(opened){const runtime={...opened,actor:{role:'teacher',teacherId:'teacher1',schoolId:'school1',teachingSessionId:'session1',studentIds:['student1'],expiresAt:'2030-01-01T00:00:00.000Z'},
  allowed:new Set(['student1']),bindings:new Map([['student1','v1:exact']]),frames:new Map([['student1',[{...frame,seenAt:Date.now()}]]]),lastPaints:new Map([['student1',{frame:null,rgba:[10,20,30,255],absent:false}]]),realtime:new Map(),commands:new Map(),revisionSeeds:new Map(),subscribed:true,socketGeneration:1};
  const auth={schoolId:'school1',expiresAt:'2030-01-01T00:00:00.000Z',deviceManifestExpiresAt:'2030-01-01T00:00:00.000Z'};
  return{runtime,auth,publicBindings:new Map([['student1','public-binding']]),pulseController:{ageUpper:()=>100}};}
async function captureCase({mutate,decodeDelay=0,deadlineMs=5000,fixtureOptions={}}={}){
  let b;const fixture=chromiumFixture(fixtureOptions),controller=createActualRenderedObserverRuntime({decoderFactory:()=>rawDecoder(()=>mutate?.(b.runtime,b.auth),decodeDelay)});
  const opened=await controller.openTeacher({chromium:fixture.chromium,executablePath:'never-executed',index:0});b=binding(opened);
  try{const result=await opened.owner.observe(scope=>observeActualRenderedCapture(b.runtime,scope,{...b,runId:'run1',deadlineAt:performance.now()+deadlineMs}));await opened.owner.whenSettled();return{result,b,controller,fixture};}
  catch(error){await controller.close();throw error;}
}

test('actual orchestrator registers twenty distinct BrowserServers and binds each native factory to its original Page',async()=>{
  const fixture=chromiumFixture(),controller=createActualRenderedObserverRuntime();
  try{const opened=await Promise.all(Array.from({length:20},(_,index)=>controller.openTeacher({chromium:fixture.chromium,executablePath:'never-executed',index})));
    assert.equal(new Set(opened.map(row=>row.browser)).size,20);assert.equal(new Set(opened.map(row=>row.page)).size,20);assert.equal(controller.summary().registry.owners,20);
    assert.ok(controller.summary().captures.every(c=>c.maximumActive===1&&c.maximumPages===1));assert.ok(controller.summary().decoders.every(c=>c.maximumActive===1));
    assert.throws(() => controller.openTeacher({chromium:fixture.chromium,index:20}), /Owned browser launch bound/);
  }finally{assert.equal((await controller.close()).passed,true);}
});
test('setup failure still closes the exact server owned before asynchronous context setup',async()=>{
  const fixture=chromiumFixture({contextFailure:true}),controller=createActualRenderedObserverRuntime();
  await assert.rejects(controller.openTeacher({chromium:fixture.chromium,index:0}),/setup failed/);
  assert.equal(fixture.records.length,1);assert.equal(fixture.records[0].process.exitCode,0);assert.deepEqual(fixture.order,['close']);assert.equal((await controller.close()).passed,true);
});
test('actual capture path uses retained per-owner CDP plus ROI decode and records end-decode age without source mutation',async()=>{
  const r=await captureCase();try{assert.equal(r.result.results.length,1);assert.equal(r.result.results[0].age,100);assert.equal(r.result.wrongClass,false);
    assert.equal(r.controller.summary().captures[0].started,1);assert.equal(r.controller.summary().decoders[0].started,1);assert.equal(r.controller.summary().registry.memory.activeBytes,0);
    assert.deepEqual(r.b.runtime.lastPaints.get('student1'),{frame:null,rgba:[10,20,30,255],absent:false},'Pipeline result cannot mutate evidence before caller/generation acceptance');
  }finally{assert.equal((await r.controller.close()).passed,true);}
});
for(const[name,mutate]of [
 ['denied subscription',r=>{r.subscribed=false;}],['socket generation rebound',r=>{r.socketGeneration++;}],['exact binding rebound',r=>{r.bindings.set('student1','v2:other');}],
 ['school change',r=>{r.actor.schoolId='other-school';}],['session change',r=>{r.actor.teachingSessionId='other-session';}],['teacher change',r=>{r.actor.teacherId='other-teacher';}],
 ['role denial',r=>{r.actor.role='admin';}],['expired teacher token',r=>{r.actor.expiresAt='2000-01-01T00:00:00.000Z';}],
 ['expired overall authority',(_r,a)=>{a.expiresAt='2000-01-01T00:00:00.000Z';}],['expired device authority',(_r,a)=>{a.deviceManifestExpiresAt='2000-01-01T00:00:00.000Z';}],
 ['roster rebound',r=>{r.actor.studentIds=['other-student'];}],
])test('actual post-decode '+name+' yields UNKNOWN while preserving raw settlement',async()=>{const r=await captureCase({mutate});try{assert.equal(r.result,null);assert.equal(r.controller.summary().captures[0].completed,1);assert.equal(r.controller.summary().decoders[0].completed,1);assert.equal(r.controller.summary().registry.memory.activeBytes,0);}finally{await r.controller.close();}});
test('end-decode after an absolute phase deadline remains UNKNOWN without clock subtraction',async()=>{const r=await captureCase({decodeDelay:25,deadlineMs:10});try{assert.equal(r.result,null);assert.equal(r.controller.summary().decoders[0].completed,1);}finally{await r.controller.close();}});
test('missing actual DOM target stays in the exact actor denominator as Infinity',async()=>{
  const r=await captureCase();try{r.b.runtime.actor.studentIds.push('student2');r.b.runtime.allowed.add('student2');r.b.runtime.bindings.set('student2','v1:second');
    const result=await r.b.runtime.owner.observe(scope=>observeActualRenderedCapture(r.b.runtime,scope,{...r.b,runId:'run1',deadlineAt:performance.now()+5000}));
    assert.equal(result.results.length,2);assert.equal(result.results[0].age,100);assert.equal(result.results[1].age,Infinity);assert.equal(result.wrongClass,true);
  }finally{await r.controller.close();}
});
test('actual authority snapshot refuses absent or expired authority before any native attempt',()=>{
  const {runtime,auth}=binding({});const fence=renderedRuntimeAuthoritySnapshot(runtime,auth,'run1');assert.equal(renderedRuntimeAuthorityMatches(runtime,auth,fence),true);
  runtime.subscribed=false;assert.throws(()=>renderedRuntimeAuthoritySnapshot(runtime,auth,'run1'));assert.equal(renderedRuntimeAuthorityMatches(runtime,auth,fence),false);
});
test('actual absolute scheduler accounts every planned target, including phases missed before enqueue',async()=>{
  let clock=100,first=true,planned=0,known=0,unknown=0,enqueued=0;
  const actor={actor:{studentIds:['student1','student2']},owner:{observe:async fn=>{enqueued++;return fn({});}}};
  const phases=await runActualRenderedCapturePhases({actors:[actor],startAt:100,endAt:15100,now:()=>clock,
    pause:async ms=>{await turn();clock+=ms;if(first){clock+=11000;first=false;}await turn();},observe:async()=>({present:true}),
    account:(_runtime,value,metadata)=>{if(metadata.plannedOnly){planned+=metadata.count;assert.equal(enqueued,0);}else if(value)known+=2;else unknown+=2;}});
  await phases.whenSettled();assert.equal(planned,6);assert.equal(known+unknown,6);assert.equal(unknown,4);assert.equal(enqueued,1);assert.equal(phases.counters.missedPhases,2);
});
test('stopped scheduler immediately accounts future phases without waiting out the remaining campaign',async()=>{
  let planned=0,unknown=0,pauses=0;
  const actor={actor:{studentIds:['student1']},owner:{observe:()=>{throw Error('No native attempt after stop');}}};
  const phases=await runActualRenderedCapturePhases({actors:[actor],startAt:0,endAt:5400000,now:()=>0,stopped:()=>true,pause:async()=>{pauses++;},observe:async()=>true,
    account:(_runtime,_value,metadata)=>{if(metadata.plannedOnly)planned+=metadata.count;else unknown++;}});
  await phases.whenSettled();assert.equal(pauses,0);assert.equal(planned,1080);assert.equal(unknown,1080);assert.equal(phases.counters.enqueued,0);
});
test('actual shutdown starts owned server closure before an outstanding publisher/navigation drain',async()=>{
  const fixture=chromiumFixture(),controller=createActualRenderedObserverRuntime(),raw=deferred();
  await controller.openTeacher({chromium:fixture.chromium,index:0});const closing=controller.close({extraDrains:[raw.promise.then(()=>fixture.order.push('drain'))]});
  await turn();assert.deepEqual(fixture.order,['close']);assert.equal(fixture.records[0].process.exitCode,0);raw.resolve();assert.equal((await closing).passed,true);assert.deepEqual(fixture.order,['close','drain']);
});
test('ignored DOM and late result cannot release a retained owner or upgrade failed cleanup',async()=>{
  const keep=setInterval(()=>{},100),raw=deferred(),fixture=chromiumFixture({evaluate:()=>raw.promise}),controller=createActualRenderedObserverRuntime({ownerDeadlineMs:20,cleanupDeadlineMs:20,closeDeadlineMs:20});
  try{const opened=await controller.openTeacher({chromium:fixture.chromium,index:0});await assert.rejects(opened.owner.observe(({page})=>page.evaluate(()=>true)),/deadline/);
    assert.equal(controller.summary().registry.active,1);assert.ok(controller.summary().registry.memory.activeBytes>0);
    const cleanup=await controller.close();assert.equal(cleanup.ownedProcessesRemaining,0);assert.equal(cleanup.passed,false);assert.equal(cleanup.drainsSettled,false);
    raw.resolve('late');await controller.registry.whenSettled();assert.equal(controller.summary().registry.active,0);assert.equal(controller.summary().registry.memory.activeBytes,0);assert.equal((await controller.close()).passed,false);
  }finally{raw.resolve();await controller.registry.whenSettled();clearInterval(keep);}
});
test('owned close deadline requires kill and retains failed evidence despite eventual process closure',async()=>{
  const keep=setInterval(()=>{},100),fixture=chromiumFixture({closeIgnored:true}),controller=createActualRenderedObserverRuntime({cleanupDeadlineMs:50,closeDeadlineMs:10});
  try{await controller.openTeacher({chromium:fixture.chromium,index:0});const cleanup=await controller.close();assert.deepEqual(fixture.order,['close','kill']);assert.equal(cleanup.ownedProcessesRemaining,0);assert.equal(cleanup.closeFailed,1);assert.equal(cleanup.passed,false);}finally{clearInterval(keep);}
});
test('repeated actual capture jobs retain one original physical Page/session across new scoped facades',async()=>{
  const r=await captureCase();try{for(let index=0;index<2;index++){const attempt=await r.b.runtime.owner.observe(scope=>observeActualRenderedCapture(r.b.runtime,scope,{...r.b,runId:'run1',deadlineAt:performance.now()+5000}));assert.equal(attempt.results[0].age,100);await r.b.runtime.owner.whenSettled();}assert.equal(r.controller.summary().captures[0].pages,1);assert.equal(r.controller.summary().captures[0].started,3);assert.equal(r.controller.summary().captures[0].completed,3);assert.equal(r.controller.summary().registry.memory.activeBytes,0);}finally{await r.controller.close();}
});

const send = (socket, message) => socket.emit('framesent', { payload: JSON.stringify(message) });
const receive = (socket, message) => socket.emit('framereceived', { payload: JSON.stringify(message) });
const subscribe = (requestId, extra = {}) => ({ type: 'subscribe-session', requestId, teachingSessionId: 'session1', ...extra });
const subscribed = (requestId, extra = {}) => ({ type: 'session-subscription-success', requestId, teachingSessionId: 'session1', ...extra });
function socketCase() {
  const { runtime, auth } = binding({});
  const socket = new EventEmitter(); let priorInvalidations = 0;
  const observer = attachActualRenderedSocketObserver(runtime, socket, { invalidatePrior: () => { priorInvalidations++; } });
  return { runtime, auth, socket, observer, invalidations: () => priorInvalidations };
}

test('actual UI socket A-to-B-to-A attempts require only the current exact request ACK, on the same socket', () => {
  const b = socketCase();
  send(b.socket, subscribe('a1')); receive(b.socket, subscribed('a1'));
  assert.equal(b.runtime.subscribed, true);
  const epoch = b.runtime.scopeEpoch;
  b.runtime.frames.set('student1', [{ ...frame }]); b.runtime.lastPaints.set('student1', { rgba, frame });
  send(b.socket, subscribe('b1', { teachingSessionId: 'session2' }));
  assert.equal(b.runtime.subscribed, false); assert.equal(b.runtime.frames.size, 0); assert.equal(b.runtime.lastPaints.size, 0);
  receive(b.socket, subscribed('b1', { teachingSessionId: 'session2' }));
  receive(b.socket, subscribed('a1')); assert.equal(b.runtime.subscribed, false);
  send(b.socket, subscribe('a2')); receive(b.socket, subscribed('a1'));
  assert.equal(b.runtime.subscribed, false); assert.equal(b.observer.summary().pendingExpectedSubscription, true);
  receive(b.socket, subscribed('a2')); assert.equal(b.runtime.subscribed, true);
  assert.ok(b.runtime.scopeEpoch > epoch); assert.equal(b.invalidations(), 4);
});
for (const [name, message] of [
  ['unsubscribe', { type: 'unsubscribe-session', requestId: 'cleanup', teachingSessionId: 'session1' }],
  ['supervision context', subscribe('next', { supervisionContextId: 'context1' })],
  ['other school', subscribe('next', { schoolId: 'school2' })],
  ['missing correlation', { type: 'subscribe-session', teachingSessionId: 'session1' }],
]) test('actual UI '+name+' clears native evidence and never accepts the former subscription ACK', () => {
  const b = socketCase(); send(b.socket, subscribe('original')); receive(b.socket, subscribed('original'));
  b.runtime.frames.set('student1', [frame]); b.runtime.realtime.set('student1', {}); b.runtime.lastPaints.set('student1', { rgba, frame });
  send(b.socket, message); receive(b.socket, subscribed('original')); receive(b.socket, subscribed('next'));
  assert.equal(b.runtime.subscribed, false); assert.equal(b.runtime.frames.size, 0); assert.equal(b.runtime.realtime.size, 0); assert.equal(b.runtime.lastPaints.size, 0);
  assert.throws(() => renderedRuntimeAuthoritySnapshot(b.runtime, b.auth, 'run1'));
});
test('an ACK with the current request ID but wrong scope retires its pending subscription', () => {
  const b = socketCase(); send(b.socket, subscribe('a1')); receive(b.socket, subscribed('a1', { teachingSessionId: 'session2' }));
  receive(b.socket, subscribed('a1')); assert.equal(b.runtime.subscribed, false); assert.equal(b.observer.summary().pendingExpectedSubscription, false);
});
test('old socket close and frames cannot retire or authenticate its successor generation', () => {
  const b = socketCase(), old = b.socket, next = new EventEmitter();
  send(old, subscribe('old')); receive(old, subscribed('old'));
  attachActualRenderedSocketObserver(b.runtime, next); send(next, subscribe('new')); receive(next, subscribed('new'));
  const epoch = b.runtime.scopeEpoch; old.emit('close'); send(old, subscribe('other')); receive(old, { type: 'auth-error' });
  assert.equal(b.runtime.subscribed, true); assert.equal(b.runtime.scopeEpoch, epoch);
  next.emit('close'); assert.equal(b.runtime.subscribed, false);
});
test('actual A-to-B-to-A subscription switch during native decode cannot credit the old paint even after valid A returns', async () => {
  const r = await captureCase({ mutate: runtime => {
    const socket = new EventEmitter(); attachActualRenderedSocketObserver(runtime, socket);
    send(socket, subscribe('b', { teachingSessionId: 'session2' })); send(socket, subscribe('a')); receive(socket, subscribed('a'));
    runtime.frames.set('student1', [{ ...frame, seenAt: Date.now() }]);
  } });
  try { assert.equal(r.b.runtime.subscribed, true); assert.equal(r.result, null); } finally { await r.controller.close(); }
});
test('raw launch reservations exist before launch calls and a late BrowserServer closes before cleanup can pass', async () => {
  const gate = deferred(), failed = chromiumFixture({ contextFailure: true }), late = chromiumFixture({ launchGate: gate.promise });
  const controller = createActualRenderedObserverRuntime();
  const first = controller.setupTeacher({ chromium: failed.chromium, index: 0 }, async () => {});
  const second = controller.setupTeacher({ chromium: late.chromium, index: 1 }, async () => {});
  assert.equal(controller.summary().pendingSetups, 2);
  await assert.rejects(first, /setup failed/);
  assert.equal(controller.summary().pendingOpens, 1);
  const closing = controller.close(); await turn();
  assert.equal(failed.records[0].process.exitCode, 0); assert.equal(late.records.length, 0);
  gate.resolve(); await assert.rejects(second, /Late owned BrowserServer retired/);
  const proof = await closing;
  assert.equal(proof.ownedServers, 2); assert.equal(proof.pendingOpens, 0); assert.equal(proof.pendingSetups, 0);
  assert.equal(proof.ownedProcessesRemaining, 0); assert.equal(late.records[0].process.exitCode, 0); assert.equal(proof.passed, true);
});
test('an ignored context-creation promise prevents passed cleanup even after its exact process has closed', async () => {
  const keep = setInterval(() => {}, 100), gate = deferred(), fixture = chromiumFixture({ contextGate: gate.promise });
  const controller = createActualRenderedObserverRuntime({ cleanupDeadlineMs: 20, closeDeadlineMs: 10 });
  const opening = controller.setupTeacher({ chromium: fixture.chromium, index: 0 }, async () => {});
  try {
    await turn(); const proof = await controller.close();
    assert.equal(proof.ownedProcessesRemaining, 0); assert.equal(proof.pendingOpens, 1); assert.equal(proof.pendingSetups, 1); assert.equal(proof.passed, false);
    gate.resolve(); await assert.rejects(opening, /Late context creation retired/); await turn();
    assert.equal(controller.summary().pendingOpens, 0); assert.equal(controller.summary().pendingSetups, 0); assert.equal((await controller.close()).passed, false);
  } finally { gate.resolve(); await opening.catch(() => {}); clearInterval(keep); }
});
test('ignored authenticated UI setup is retained after opening and late completion cannot upgrade failed cleanup', async () => {
  const keep = setInterval(() => {}, 100), gate = deferred(), entered = deferred(), fixture = chromiumFixture();
  const controller = createActualRenderedObserverRuntime({ cleanupDeadlineMs: 20, closeDeadlineMs: 10 });
  const setup = controller.setupTeacher({ chromium: fixture.chromium, index: 0 }, async () => { entered.resolve(); await gate.promise; });
  try {
    await entered.promise; const proof = await controller.close();
    assert.equal(proof.pendingOpens, 0); assert.equal(proof.pendingSetups, 1); assert.equal(proof.ownedProcessesRemaining, 0); assert.equal(proof.passed, false);
    gate.resolve(); await assert.rejects(setup, /Late authenticated teacher setup retired/); await turn();
    assert.equal(controller.summary().pendingSetups, 0); assert.equal((await controller.close()).passed, false);
  } finally { gate.resolve(); await setup.catch(() => {}); clearInterval(keep); }
});
test('a never-returning launch remains an explicit unknown cleanup owner and cannot create a premature success receipt', async () => {
  const keep = setInterval(() => {}, 100), gate = deferred(), fixture = chromiumFixture({ launchGate: gate.promise });
  const controller = createActualRenderedObserverRuntime({ cleanupDeadlineMs: 20, closeDeadlineMs: 10 });
  const opening = controller.openTeacher({ chromium: fixture.chromium, index: 0 });
  try {
    await turn(); assert.equal(controller.summary().pendingOpens, 1); const proof = await controller.close(); assert.equal(proof.ownedServers, 0); assert.equal(proof.pendingOpens, 1); assert.equal(proof.passed, false);
    gate.resolve(); await opening.catch(() => {}); await turn(); assert.equal((await controller.close()).passed, false);
  } finally { gate.resolve(); await opening.catch(() => {}); clearInterval(keep); }
});
test('first actual native sample remains UNKNOWN, seeds only physical RGBA, and an aliased later DOM frame stays UNKNOWN', async () => {
  const fixture = chromiumFixture(), controller = createActualRenderedObserverRuntime({ decoderFactory: () => rawDecoder() });
  const opened = await controller.openTeacher({ chromium: fixture.chromium, index: 0 }); const b = binding(opened);
  b.runtime.lastPaints.set('student1', { frame: null, rgba: null, absent: false });
  try {
    const attempt = await opened.owner.observe(scope => observeActualRenderedCapture(b.runtime, scope, { ...b, runId: 'run1', deadlineAt: performance.now() + 5000 }));
    const result = attempt.results[0]; assert.equal(result.age, Infinity); assert.equal(result.composed.matched, true);
    retainActualRenderedCaptureEvidence(b.runtime, result, attempt.visible);
    assert.deepEqual(b.runtime.lastPaints.get('student1'), { frame: null, rgba, absent: false });
    const nextFrame = { ...frame, jpegSha256: 'c'.repeat(64), ordinal: 2 };
    const aliased = { ...result, card: { ...result.card, frame: nextFrame }, composed: { ...result.composed, contributors: [nextFrame] } };
    aliased.age = scoreRenderedCaptureAge({ frame: nextFrame, composed: aliased.composed, previous: b.runtime.lastPaints.get('student1'), pulseController: b.pulseController, publicBinding: 'public-binding', observedAt: performance.now() });
    assert.equal(aliased.age, Infinity); retainActualRenderedCaptureEvidence(b.runtime, aliased, true); assert.equal(b.runtime.lastPaints.get('student1').frame, null);
    const changed = { ...aliased, composed: { ...aliased.composed, rgba: [180, 30, 50, 255] } };
    changed.age = scoreRenderedCaptureAge({ frame: nextFrame, composed: changed.composed, previous: b.runtime.lastPaints.get('student1'), pulseController: b.pulseController, publicBinding: 'public-binding', observedAt: performance.now() });
    assert.equal(changed.age, 100); retainActualRenderedCaptureEvidence(b.runtime, changed, true); assert.equal(b.runtime.lastPaints.get('student1').frame.jpegSha256, nextFrame.jpegSha256);
  } finally { await controller.close(); }
});
for (const [name, change, visible] of [
  ['hidden page', {}, false], ['unauthorized source', { authorized: false }, true], ['unpainted source', { composed: { matched: false } }, true],
  ['transitioning source', { composed: { matched: true, transitioned: true } }, true], ['undecoded image', { card: { decoded: false } }, true],
]) test('unknown '+name+' cannot establish an initial paint baseline', () => {
  const { runtime } = binding({}); runtime.lastPaints.clear();
  retainActualRenderedCaptureEvidence(runtime, { studentId: 'student1', age: Infinity, authorized: true, card: card('student1'), after: card('student1'), composed: { matched: true, transitioned: false, rgba }, ...change }, visible);
  assert.equal(runtime.lastPaints.size, 0);
});
test('a changed roster cannot shrink the scheduler original planned-target denominator', async () => {
  let clock = 0, planned = 0, observed = 0;
  const actor = { actor: { studentIds: ['student1', 'student2'] }, owner: { observe: async fn => fn({}) } };
  const phases = await runActualRenderedCapturePhases({ actors: [actor], startAt: 0, endAt: 10000, now: () => clock,
    pause: async ms => { clock += ms; await turn(); }, observe: async () => { actor.actor.studentIds = ['other']; return {}; },
    account: (_actor, _value, metadata) => { assert.deepEqual(metadata.studentIds, ['student1', 'student2']); if (metadata.plannedOnly) planned += metadata.count; else observed += metadata.studentIds.length; } });
  await phases.whenSettled(); assert.equal(planned, 4); assert.equal(observed, 4); assert.equal(phases.counters.completedTargets, 4);
});

test('concurrent unresolved launches cannot exceed the exact twenty-owner admission limit', async () => {
  const gate = deferred(), fixture = chromiumFixture({ launchGate: gate.promise }), controller = createActualRenderedObserverRuntime();
  const opens = Array.from({ length: 20 }, (_, index) => controller.openTeacher({ chromium: fixture.chromium, index }));
  assert.equal(controller.summary().pendingOpens, 20);
  assert.throws(() => controller.openTeacher({ chromium: fixture.chromium, index: 20 }), /Owned browser launch bound/);
  gate.resolve(); await Promise.all(opens); assert.equal(fixture.records.length, 20); assert.equal((await controller.close()).passed, true);
});

for (const jitter of Array.from({ length: 13 }, (_, index) => index)) for (const known of [false, true])
  test('two consecutive same-color aliases with native jitter '+jitter+' preserve '+(known ? 'older causal age' : 'UNKNOWN baseline'), () => {
    const { runtime } = binding({}), oldFrame = { ...frame, ordinal: 1 }, nextFrame = { ...frame, ordinal: 2, jpegSha256: 'd'.repeat(64) };
    runtime.lastPaints.set('student1', { rgba: [60, 100, 130, 255], frame: known ? oldFrame : null, absent: false });
    const pulseController = { ageUpper: value => value.ordinal === 1 ? 19000 : 100 };
    for (let sample = 0; sample < 2; sample++) {
      const composed = { rgba: [60 + jitter, 100 + jitter, 130 + jitter, 255], matched: true, transitioned: false, contributors: [nextFrame] };
      const age = scoreRenderedCaptureAge({ frame: nextFrame, composed, previous: runtime.lastPaints.get('student1'), pulseController, observedAt: sample, publicBinding: 'binding' });
      assert.equal(age, known ? 19000 : Infinity);
      const paint = retainActualRenderedCaptureEvidence(runtime, { studentId: 'student1', age, authorized: true,
        card: { ...card('student1'), frame: nextFrame }, after: card('student1'), composed }, true);
      assert.deepEqual(paint.rgba, [60, 100, 130, 255]); assert.equal(paint.frame, known ? oldFrame : null);
    }
    const real = { rgba: [180, 30, 50, 255], matched: true, transitioned: false, contributors: [nextFrame] };
    const age = scoreRenderedCaptureAge({ frame: nextFrame, composed: real, previous: runtime.lastPaints.get('student1'), pulseController, observedAt: 2, publicBinding: 'binding' });
    assert.equal(age, 100); const paint = retainActualRenderedCaptureEvidence(runtime, { studentId: 'student1', age, authorized: true,
      card: { ...card('student1'), frame: nextFrame }, after: card('student1'), composed: real }, true);
    assert.equal(paint.frame, nextFrame);
  });
test('subsequent navigation pixel vectors reject channel jitter and malformed vectors without changing match tolerance', () => {
  const previous = [60, 100, 130, 255, 60, 100, 130, 255];
  for (let jitter = 0; jitter <= 12; jitter++) assert.equal(nativePixelsCausallyChanged(previous, previous.map((value, index) => index % 4 === 3 ? value : value + jitter)), false);
  assert.equal(nativePixelsCausallyChanged(previous, [73, 100, 130, 255, 60, 100, 130, 255]), true);
  for (const malformed of [[], [73], [NaN, 100, 130, 255], [256, 100, 130, 255]]) assert.equal(nativePixelsCausallyChanged(previous, malformed), false);
});

test('later navigation compares actual same-coordinate pixels across different SVG and placeholder witness lengths', () => {
  const { runtime, auth } = binding({}), fence = renderedRuntimeAuthoritySnapshot(runtime, auth, 'run1'), scopeEpoch = runtime.scopeEpoch ?? 0;
  const expected = { studentId: 'student1', publicBinding: 'binding', tabSnapshotRevision: 2, activeTabRef: 'next', activeTabTitle: 'next', activeTabUrl: 'https://example.invalid/', allOpenTabs: [{ tabRef: 'next', title: 'next', url: 'https://example.invalid/' }] };
  runtime.realtime.set('student1', { ...expected, realtimeBinding: expected.publicBinding, socketGeneration: runtime.socketGeneration });
  const glyph = { left: 20, top: 20, width: 3, height: 3, white: [255, 255, 255, 255], yellow: [255, 200, 0, 255] };
  const svg = { studentId: 'student1', points: [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }], glyph };
  const placeholder = { studentId: 'student1', points: Array.from({ length: 7 }, (_, n) => ({ x: 20 + n % 3, y: 20 + Math.floor(n / 3) })) };
  const svgPaint = { matched: true, pixels: Array(13).fill([25, 115, 230, 255]).flat() }, placeholderPaint = { matched: true, pixels: Array(7).fill([150, 150, 150, 255]).flat() };
  const decide = (previous, witness, composed) => actualRenderedNavigationPaintDecision({ runtime, auth, fence, scopeEpoch, isCurrent: () => true,
    receivedAt: 100, deadline: 1000, expected, witness, composed, previous, round: 2 });
  assert.equal(decide(nativeNavigationPaintEvidence(svg, svgPaint, fence, scopeEpoch), placeholder, placeholderPaint), true);
  assert.equal(decide(nativeNavigationPaintEvidence(placeholder, placeholderPaint, fence, scopeEpoch), svg, svgPaint), true);
  const shifted = { ...placeholder, points: placeholder.points.map(point => ({ x: point.x + 100, y: point.y + 100 })) };
  assert.equal(decide(nativeNavigationPaintEvidence(svg, svgPaint, fence, scopeEpoch), shifted, placeholderPaint), false, 'Different lengths and colors without same physical coordinates are not causal evidence');
  const jitter = { matched: true, pixels: Array(7).fill([37, 127, 242, 255]).flat() };
  assert.equal(decide(nativeNavigationPaintEvidence(svg, svgPaint, fence, scopeEpoch), placeholder, jitter), false);
  runtime.scopeEpoch = scopeEpoch + 1; assert.equal(decide(nativeNavigationPaintEvidence(svg, svgPaint, fence, scopeEpoch), placeholder, placeholderPaint), false);
});

const navigationWitness = () => ({ studentId: 'student1', marker: 'marker', matched: true,
  points: [{ x: 20, y: 20, rgba }, { x: 30, y: 20, rgba }, { x: 40, y: 20, rgba }, { x: 25, y: 30, rgba }],
  glyph: { left: 25, top: 25, width: 3, height: 3, white: [255, 255, 255, 255], yellow: [250, 200, 0, 255] } });
function navigationFailureFixture(failure) {
  let reads = 0, origins = 0; const late = deferred(), retained = [];
  const fixture = chromiumFixture({ evaluate: async fn => {
    if (fn.name === 'nativeViewportOriginProof') { origins++; if (failure === 'origin' && origins === 2) throw Error('after origin failed'); return structuredClone(origin); }
    if (fn.name === 'collectRenderedNavigationPixelWitness') { reads++; if (reads === 2) { if (failure === 'late') return late.promise; throw Error('after DOM failed'); } return [navigationWitness()]; }
    throw Error('Unplanned actual navigation read');
  } });
  const controller = createActualRenderedObserverRuntime({ cleanupDeadlineMs: 20, closeDeadlineMs: 10,
    captureFactory: page => {
      const native = createNativeScreenshotCapture({ maximumActive: 1, maximumPages: 1, sessionFactory: () => page.context().newCDPSession(page) });
      return { capture: async (...args) => { const png = await native.capture(...args); retained.push(png); return png; }, whenSettled: () => native.whenSettled(), summary: () => native.summary() };
    }, decoderFactory: () => rawDecoder() });
  return { fixture, controller, retained, late };
}
for (const failure of ['DOM', 'origin']) test('actual navigation '+failure+' failure zeroes owned PNG before owner/memory release', async () => {
  const b = navigationFailureFixture(failure);
  try {
    const opened = await b.controller.openTeacher({ chromium: b.fixture.chromium, index: 0 });
    await assert.rejects(opened.owner.observe(scope => observeActualRenderedNavigationPaint(scope, [{}])), /after (DOM|origin) failed/);
    await opened.owner.whenSettled(); assert.equal(b.retained.length, 1); assert.ok(b.retained[0].every(value => value === 0));
    assert.equal(b.controller.summary().registry.memory.activeBytes, 0); assert.equal(b.controller.summary().registry.rawDom, 0);
  } finally { assert.equal((await b.controller.close()).passed, true); }
});
test('ignored after-DOM navigation preserves its raw owner after caller timeout while zeroing the allocated PNG', async () => {
  const keep = setInterval(() => {}, 100), b = navigationFailureFixture('late');
  try {
    const opened = await b.controller.openTeacher({ chromium: b.fixture.chromium, index: 0 });
    await assert.rejects(opened.owner.observe(scope => observeActualRenderedNavigationPaint(scope, [{}], { afterReadMs: 10 })), /deadline exceeded/);
    assert.equal(b.retained.length, 1); assert.ok(b.retained[0].every(value => value === 0));
    assert.equal(b.controller.summary().registry.active, 1); assert.equal(b.controller.summary().registry.rawDom, 1); assert.ok(b.controller.summary().registry.memory.activeBytes > 0);
    const proof = await b.controller.close(); assert.equal(proof.ownedProcessesRemaining, 0); assert.equal(proof.passed, false);
    b.late.resolve([navigationWitness()]); await b.controller.registry.whenSettled(); assert.equal(b.controller.summary().registry.active, 0);
    assert.equal(b.controller.summary().registry.memory.activeBytes, 0); assert.equal((await b.controller.close()).passed, false);
  } finally { b.late.resolve([navigationWitness()]); await b.controller.registry.whenSettled(); clearInterval(keep); }
});
