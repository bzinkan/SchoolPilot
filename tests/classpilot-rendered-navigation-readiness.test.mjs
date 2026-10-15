import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash}from'node:crypto';import {pathToFileURL,fileURLToPath}from'node:url';import {createRequire}from'node:module';import test from'node:test';
const loadRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../scripts/load');const require=createRequire(new URL('../package.json',import.meta.url)),ts=require('typescript');
const actualPath=path.join(loadRoot,'run-classpilot-rendered-dashboards.mjs'),actualText=fs.readFileSync(actualPath,'utf8');
const actual=await import(pathToFileURL(actualPath));const profile=await import(pathToFileURL(path.join(loadRoot,'classpilot-reliability-profile.mjs')));
function exactNode(text,name,variable=false){const parsed=ts.createSourceFile('source.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(parsed.parseDiagnostics.length,0);let match;function visit(node){if(variable?ts.isVariableDeclaration(node)&&node.name.getText(parsed)===name:ts.isFunctionDeclaration(node)&&node.name?.text===name){assert.equal(match,undefined);match=variable?node.initializer:node;}ts.forEachChild(node,visit);}visit(parsed);assert.ok(match,name);return match.getText(parsed).replace(/^export\s+/,'').replace(/\r\n/g,'\n');}
function compile(text,name,bindings,variable=false){const names=Object.keys(bindings);return Function(...names,'return ('+exactNode(text,name,variable)+')')(...Object.values(bindings));}
const auth={schoolId:'synthetic-school',expiresAt:'2099-01-01T00:00:00.000Z',deviceManifestExpiresAt:'2099-01-01T00:00:00.000Z'};
function buildRuntime(count=40){const ids=Array.from({length:count},(_,i)=>'synthetic-'+i);const publicBindings=new Map(ids.map(id=>[id,createHash('sha256').update(id).digest('base64url')]));const runtime={actor:{teacherId:'synthetic-teacher',role:'teacher',schoolId:auth.schoolId,teachingSessionId:'synthetic-session',studentIds:ids,expiresAt:auth.expiresAt},scopeEpoch:0,socketGeneration:1,subscribed:true,priorStripAbsent:true,allowed:new Set(ids),bindings:new Map(ids.map(id=>[id,'private-binding-'+id])),publicBindings,revisionSeeds:new Map(ids.map(id=>[id,0])),realtime:new Map()};return{runtime,publicBindings,ids};}
const makeExpected=(id,publicBindings,round=2)=>({...profile.navigationSnapshot({runId:'synthetic-run',round,nonce:'synthetic-nonce'},publicBindings.get(id),0),studentId:id,publicBinding:publicBindings.get(id)});
const makeMessage=(expected,runtime)=>({...expected,realtimeBinding:expected.publicBinding,socketGeneration:runtime.socketGeneration});
async function exerciseRound({readyAt={},mutateMessage,proofDelay=0}={}){const {runtime,publicBindings,ids}=buildRuntime();let clock=2300;const navigationSamples=[],navigationDevices=new Set(),navigationPixels=new Map(),calls=[],entry={t0:0,nonce:'synthetic-nonce'};const fence=actual.renderedRuntimeAuthoritySnapshot(runtime,auth,'synthetic-run');for(const id of ids)navigationPixels.set(id,{points:[{x:10,y:10}],pixels:[0,0,0,255],fence:structuredClone(fence),scopeEpoch:0});const refresh=()=>{for(const id of ids){if(clock>=(readyAt[id]??2300)){const expected=makeExpected(id,publicBindings),message={...makeMessage(expected,runtime),observedAt:clock};mutateMessage?.(message,id,runtime);runtime.realtime.set(id,message);}}};runtime.owner={observe:async task=>{refresh();return task({page:{},capture:{},decoder:{},isCurrent:()=>true});}};
const bindings={performance:{now:()=>clock},navigationRoundsAttempted:new Set(),pulseController:{navigationHistory:new Map([[2,entry]])},profile:{primaryDevices:40},controlStopped:false,actors:[runtime],priorProvenance:()=>actual.renderedRuntimeAuthoritySnapshot(runtime,auth,'synthetic-run'),manifest:{runId:'synthetic-run'},publicBindings,navigationSnapshot:profile.navigationSnapshot,navigationMessageMatches:profile.navigationMessageMatches,observeActualRenderedNavigationPaint:async(_scope,rows)=>{calls.push({at:clock,ids:rows.map(row=>row.studentId)});const nativeCapturedAt=clock;clock+=proofDelay;return{witness:rows.map(row=>({studentId:row.studentId,matched:true,points:[{x:10,y:10,rgba:[100,100,100,255]}]})),composed:rows.map(row=>({studentId:row.studentId,matched:true,pixels:[100,100,100,255]})),receivedAt:clock,proofCompletedAt:clock,diagnosticDomObservedAt:nativeCapturedAt,nativeCaptureStartedAt:nativeCapturedAt,nativeCapturedAt};},navigationDiagnostics:actual.createRenderedNavigationDiagnostics(),navigationPixels,actualRenderedNavigationPaintDecision:actual.actualRenderedNavigationPaintDecision,auth,nativeNavigationPaintEvidence:actual.nativeNavigationPaintEvidence,navigationDevices,navigationSamples,counters:{navigationObserved:0},priorPaint:{dispose(){throw Error('round2 must notdispose prior store');}},delay:async milliseconds=>{clock+=milliseconds;refresh();}};
await compile(actualText,'observeRound',bindings,true)(2);return{samples:navigationSamples,calls,observed:bindings.counters.navigationObserved,diagnostics:bindings.navigationDiagnostics.summary()};}
const point=(x,y)=>({x,y,rgba:[35,45,55,255]});const witness=(id,matched=true)=>({studentId:id,marker:'synthetic-marker-'+id,points:matched?[point(10,10),point(11,10),point(12,10),point(10,11),point(11,11)]:[],glyph:null,matched});
function nativeScope({before=[witness('fast'),witness('slow',false)],after=before,pixels=[35,45,55,255]}={}){const buffers=[],calls=[];const viewport=actual.RENDERED_VIEWPORT,origin={width:viewport.width,height:viewport.height,scrollX:0,scrollY:0,devicePixelRatio:1,visualViewport:{pageLeft:0,pageTop:0,offsetLeft:0,offsetTop:0,width:viewport.width,height:viewport.height,scale:1}};return{buffers,calls,page:{evaluate:async(fn,input)=>{if(fn.name==='nativeViewportOriginProof')return structuredClone(origin);assert.equal(fn.name,'collectRenderedNavigationPixelWitness');calls.push(input);return structuredClone(Array.isArray(input)?before:after);}},capture:{capture:async()=>{const bytes=Buffer.alloc(64,9);buffers.push(bytes);return bytes;}},decoder:{run:async(_png,_viewport,sample)=>sample(()=>pixels.slice())}};}
const expectedRows=[{studentId:'fast'},{studentId:'slow'}];
test('ready students are measured before one slower current-message row',async()=>{const result=await exerciseRound({readyAt:{'synthetic-39':4200}});assert.deepEqual(result.calls.map(c=>[c.at,c.ids.length]),[[2300,39],[4200,1]]);assert.equal(result.samples.filter(t=>t===2300).length,39);assert.equal(result.samples.filter(t=>t===4200).length,1);assert.equal(result.observed,40);assert.equal(result.diagnostics.provenPaintTargets,40);assert.equal(result.diagnostics.invalidCount,0);});
test('a never-current student remains Infinity without erasing genuinely earlier observations',async()=>{const result=await exerciseRound({readyAt:{'synthetic-39':Infinity}});assert.equal(result.observed,39);assert.equal(result.diagnostics.provenPaintTargets,39);assert.equal(result.diagnostics.invalidCount,0);assert.equal(result.samples.filter(x=>x===Infinity).length,1);assert.equal(result.samples.length,40);const gate=profile.navigationGate(result.samples,{planned:40,primaryDevices:40,observedDevices:39});assert.equal(gate.complete,false);assert.equal(gate.passed,false);});
test('old generation and foreign exact binding remain unobservedInfinity after selection',async()=>{const result=await exerciseRound({mutateMessage(message,id){if(id==='synthetic-38')message.socketGeneration=0;if(id==='synthetic-39')message.realtimeBinding='foreign';}});assert.equal(result.observed,38);assert.equal(result.samples.filter(x=>x===Infinity).length,2);assert.ok(result.calls.every(call=>!call.ids.includes('synthetic-38')&&!call.ids.includes('synthetic-39')));});
test('one unmatched DOM row does not block actual native verification of a ready row',async()=>{const scope=nativeScope();const result=await actual.observeActualRenderedNavigationPaint(scope,expectedRows);assert.deepEqual(result.witness.map(row=>row.studentId),['fast']);assert.equal(result.composed[0].matched,true);assert.equal(scope.buffers.length,1);assert.ok(scope.buffers.every(bytes=>bytes.every(value=>value===0)));});
test('actual native helper: all unmatched rows give no native read and no fabricated zero sample',async()=>{const scope=nativeScope({before:[witness('fast',false),witness('slow',false)]});assert.equal(await actual.observeActualRenderedNavigationPaint(scope,expectedRows),null);assert.equal(scope.buffers.length,0);});
test('actual native compositor mismatch is still refused althoughDOM matches',async()=>{const scope=nativeScope({pixels:[0,0,0,255]}),result=await actual.observeActualRenderedNavigationPaint(scope,expectedRows);assert.equal(result.composed[0].matched,false);assert.ok(scope.buffers.every(bytes=>bytes.every(value=>value===0)));});
test('DOM change during native capture is still refused perstudent',async()=>{const scope=nativeScope({after:[witness('fast',false),witness('slow',false)]}),result=await actual.observeActualRenderedNavigationPaint(scope,expectedRows);assert.equal(result.composed[0].matched,false);assert.ok(scope.buffers.every(bytes=>bytes.every(value=>value===0)));});
function decisionFixture(){const {runtime,publicBindings,ids}=buildRuntime(1),expected=makeExpected(ids[0],publicBindings);runtime.realtime.set(ids[0],makeMessage(expected,runtime));const fence=actual.renderedRuntimeAuthoritySnapshot(runtime,auth,'synthetic-run'),w=witness(ids[0]);const composed={studentId:ids[0],matched:true,pixels:w.points.flatMap(()=>[35,45,55,255])};const previous={points:w.points.map(({x,y})=>({x,y})),pixels:w.points.flatMap(()=>[0,0,0,255]),fence:structuredClone(fence),scopeEpoch:0};return{runtime,auth:structuredClone(auth),fence,scopeEpoch:0,isCurrent:()=>true,receivedAt:2500,proofCompletedAt:2500,diagnosticDomObservedAt:2300,nativeCaptureStartedAt:2350,nativeCapturedAt:2400,deadline:8000,expected,witness:w,composed,previous,round:2,priorPaint:{changed:()=>false},triggerAt:0};}
test('selected row final decision still requires changed real native pixels',()=>{const good=decisionFixture();assert.equal(actual.actualRenderedNavigationPaintDecision(good),true);good.previous.pixels=good.composed.pixels.slice();assert.equal(actual.actualRenderedNavigationPaintDecision(good),false);});
test('selected row still rejects changed school/session/private binding/socket/scope/current job and expiredauthority',()=>{const mutations=[x=>x.runtime.actor.schoolId='foreign',x=>x.runtime.actor.teachingSessionId='foreign',x=>x.runtime.bindings.set(x.expected.studentId,'foreign'),x=>x.runtime.socketGeneration++,x=>x.runtime.scopeEpoch++,x=>x.isCurrent=()=>false,x=>x.runtime.actor.expiresAt='2000-01-01T00:00:00.000Z',x=>x.auth.deviceManifestExpiresAt='2000-01-01T00:00:00.000Z',x=>x.receivedAt=8001,x=>x.runtime.realtime.get(x.expected.studentId).tabSnapshotRevision++];for(const mutate of mutations){const input=decisionFixture();mutate(input);assert.equal(actual.actualRenderedNavigationPaintDecision(input),false);}});
test('round1 never credits DOM-only or absent prior-paint evidence; exact existing prior decision retained',()=>{const input=decisionFixture();input.round=1;input.previous=undefined;assert.equal(actual.actualRenderedNavigationPaintDecision(input),false);let calls=0;input.priorPaint={changed:()=>{calls++;return true;}};assert.equal(actual.actualRenderedNavigationPaintDecision(input),true);assert.equal(calls,1);input.runtime.priorStripAbsent=false;assert.equal(actual.actualRenderedNavigationPaintDecision(input),false);});

async function timedNativeCase({ domAt = 2500, captureAt = 2900, afterAt = 2950,
  proofAt = 3400, pixels, duringDecode, onScope } = {}) {
  const input = decisionFixture(), scope = nativeScope({ before: [input.witness], pixels });
  onScope?.(scope);
  let clock = 0;
  const evaluate = scope.page.evaluate, capture = scope.capture.capture, decode = scope.decoder.run;
  scope.page.evaluate = async (fn, argument) => {
    if (fn.name === 'collectRenderedNavigationPixelWitness') clock = Array.isArray(argument) ? domAt : afterAt;
    return evaluate(fn, argument);
  };
  scope.capture.capture = async (...args) => { clock = captureAt; return capture(...args); };
  scope.decoder.run = async (...args) => { clock = proofAt; duringDecode?.(input); return decode(...args); };
  const painted = await actual.observeActualRenderedNavigationPaint(scope, [input.expected], { now: () => clock });
  return { scope, painted, input: { ...input, ...painted, witness: painted.witness[0], composed: painted.composed[0] } };
}

test('actual native bytes captured on time keep their capture bound after delayed decode and full proof', async () => {
  const { scope, painted, input } = await timedNativeCase();
  assert.equal(painted.diagnosticDomObservedAt, 2500);
  assert.equal(painted.nativeCaptureStartedAt, 2500);
  assert.equal(painted.nativeCapturedAt, 2900);
  assert.equal(painted.proofCompletedAt, 3400);
  assert.equal(painted.receivedAt, painted.proofCompletedAt);
  assert.equal(actual.actualRenderedNavigationPaintDecision(input), true);
  assert.equal(profile.navigationGate(Array(40).fill(painted.nativeCapturedAt), { planned: 40, primaryDevices: 40, observedDevices: 40 }).passed, true);
  assert.ok(scope.buffers.every(bytes => bytes.every(value => value === 0)));
});

test('actual round records capture completion rather than later proof completion', async () => {
  const result = await exerciseRound({ proofDelay: 1100 });
  assert.equal(result.observed, 40);
  assert.deepEqual(result.samples, Array(40).fill(2300));
  assert.equal(profile.navigationGate(result.samples, { planned: 40, primaryDevices: 40, observedDevices: 40 }).passed, true);
  const bucket = result.diagnostics.boundsMs.indexOf(4000);
  assert.equal(result.diagnostics.counts['trigger-to-native-proof'][bucket], 40);
  assert.equal(result.diagnostics.timingVersion, actual.RENDERED_NAVIGATION_TIMING_VERSION);
});

test('genuinely late native capture still fails the unchanged three-second p95 gate', async () => {
  const { scope, input } = await timedNativeCase({ captureAt: 3100, afterAt: 3150, proofAt: 3400 });
  assert.equal(actual.actualRenderedNavigationPaintDecision(input), true);
  const gate = profile.navigationGate(Array(40).fill(input.nativeCapturedAt), { planned: 40, primaryDevices: 40, observedDevices: 40 });
  assert.equal(gate.passed, false);
  assert.equal(gate.p95UpperMs, 5000);
  assert.ok(scope.buffers.every(bytes => bytes.every(value => value === 0)));
});

test('on-time captured bytes cannot rescue proof completed after the original round deadline', async () => {
  const { scope, input } = await timedNativeCase({ proofAt: 8100 });
  assert.equal(input.nativeCapturedAt, 2900);
  assert.equal(input.receivedAt, 8100);
  assert.equal(actual.actualRenderedNavigationPaintDecision(input), false);
  assert.ok(scope.buffers.every(bytes => bytes.every(value => value === 0)));
});

test('actual clip proof still enforces its whole eight-second completion budget and zeroes bytes', async () => {
  let retained, decoderRan = false;
  await assert.rejects(timedNativeCase({ proofAt: 10501, onScope: scope => { retained = scope; },
    duringDecode: () => { decoderRan = true; } }), /completion deadline exceeded/);
  assert.equal(decoderRan, true, 'The real decoder callback ran before deadline refusal');
  assert.equal(retained.buffers.length, 1);
  assert.ok(retained.buffers.every(bytes => bytes.every(value => value === 0)));
});

test('final navigation decision rejects missing, nonfinite, reversed and mixed completion clocks', () => {
  const mutations = [
    value => value.triggerAt = -1,
    value => value.triggerAt = NaN,
    value => value.diagnosticDomObservedAt = -1,
    value => value.diagnosticDomObservedAt = 2401,
    value => value.nativeCaptureStartedAt = 2299,
    value => value.nativeCapturedAt = 2349,
    value => value.nativeCapturedAt = Infinity,
    value => delete value.nativeCapturedAt,
    value => value.proofCompletedAt = 2399,
    value => value.receivedAt = 2499,
    value => value.deadline = 2499,
  ];
  for (const mutate of mutations) {
    const input = decisionFixture(); mutate(input);
    assert.equal(actual.actualRenderedNavigationPaintDecision(input), false);
  }
});

test('actual helper rejects reversed capture clock and zeroes its owned bytes', async () => {
  let retained;
  await assert.rejects(timedNativeCase({ domAt: 3000, captureAt: 2900, afterAt: 3100,
    onScope: scope => { retained = scope; } }), /proof clock order invalid/);
  assert.equal(retained.buffers.length, 1);
  assert.ok(retained.buffers.every(bytes => bytes.every(value => value === 0)));
});

test('earlier captured bytes still need final authority and a real native pixel change after decode', async () => {
  for (const duringDecode of [input => input.runtime.socketGeneration++, input => input.runtime.scopeEpoch++]) {
    const { scope, input } = await timedNativeCase({ duringDecode });
    assert.equal(actual.actualRenderedNavigationPaintDecision(input), false);
    assert.ok(scope.buffers.every(bytes => bytes.every(value => value === 0)));
  }
  const { scope, input } = await timedNativeCase({ pixels: [0, 0, 0, 255] });
  assert.equal(input.composed.matched, false);
  assert.equal(actual.actualRenderedNavigationPaintDecision(input), false);
  assert.ok(scope.buffers.every(bytes => bytes.every(value => value === 0)));
});
