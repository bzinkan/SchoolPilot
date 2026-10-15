import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { measurementPlan, measurementExpected, measurementWaiting, measurementReadySignal,
  measurementPendingSignal, measurementSignal, validateMeasurementWaiting, validateMeasurementReadySignal,
  validateMeasurementPendingSignal, validateMeasurementSignal, MeasurementStartupGate,
  CapturePulseController } from '../scripts/load/classpilot-reliability-profile.mjs';

// Execute the exact exported runtime helpers without loading Playwright, Sharp
// or SDKs. The private draft dependency hashes are frozen by the integration
// owner after these actual helper bodies and their shared validators settle.
const driver = readFileSync(new URL('../scripts/load/run-classpilot-rendered-dashboards.mjs', import.meta.url), 'utf8');
const remoteSource=readFileSync(new URL('../scripts/load/run-classpilot-remote-generator.mjs',import.meta.url),'utf8');
const retryStart=remoteSource.indexOf('export function measurementOperationRetryable(');
const retryEnd=remoteSource.indexOf('export function measurementFailureDiagnostic(',retryStart);
assert(retryStart>0&&retryEnd>retryStart);
const measurementOperationRetryable=runInNewContext(remoteSource.slice(retryStart,retryEnd).replace('export function','function')+'\nmeasurementOperationRetryable');
const helperStart = driver.indexOf('export async function acceptActualRenderedMeasurementReady(');
const helperEnd = driver.indexOf('export async function runRenderedDashboards(', helperStart);
assert(helperStart > 0 && helperEnd > helperStart);
const helpers = runInNewContext(driver.slice(helperStart, helperEnd).replaceAll('export async function', 'async function').replaceAll('export function','function')
  + '\n({acceptActualRenderedMeasurementReady,awaitActualRenderedCausalSignal,renderedFailureDiagnostic})',
  { assert, performance, delay, validateMeasurementWaiting, validateMeasurementReadySignal,
    validateMeasurementPendingSignal, validateMeasurementSignal, measurementOperationRetryable });
const { acceptActualRenderedMeasurementReady, awaitActualRenderedCausalSignal, renderedFailureDiagnostic } = helpers;
const digest = value => createHash('sha256').update(value).digest('hex');
const base = Date.now(), startAt = new Date(base + 120_000).toISOString();
const expected = measurementExpected({ campaign: 'classpilot-staging-20261013-0d1060d261d5',
  runId: '40-' + 'a'.repeat(16), primaryDevices: 40,
  candidateApiImage: '135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:' + '1'.repeat(64),
  scriptBundleSha256: '2'.repeat(64), files: { devices: { sha256: '3'.repeat(64) } },
  measurementPlan: measurementPlan(40), measurementPlanSha256: digest(JSON.stringify(measurementPlan(40))) }, '4'.repeat(64));
const waiting = measurementWaiting(expected, { startAt, mode: 'workload', nonce: 'b'.repeat(48), createdAt: new Date(base).toISOString() });
const ready = () => measurementReadySignal(expected, waiting, new Date(base + 1).toISOString());
const nonce = 'c'.repeat(48), kind = 'measurement-started-v3';
const signal = () => measurementSignal(expected, kind, nonce);
const startupArguments = channel => ({ channel, waiting, expected, startAt, nowWall: () => base + 10 });
function causalArguments(channel, options = {}) {
  let clock = 0;
  return { channel, waiting, expected, name: 'measurement-started.json', kind, nonce, deadline: 200,
    now: () => clock, nowWall: () => base + 10, sleep: async milliseconds => { clock += milliseconds; }, ...options };
}

test('actual renderer accepts exactly one positive prepared startup lookup without traffic credit', async () => {
  const calls = [], channel = { read: async name => { calls.push(name); return ready(); } };
  const result = await acceptActualRenderedMeasurementReady(startupArguments(channel));
  assert.deepEqual(calls, ['measurement-ready.json']);
  assert.equal(result.trafficStarted, false); assert.equal(result.applicationRequests, 0);
  assert.equal(result.capacityAcceptance, false); assert.equal(result.startupOnly, true);
});
for (const status of [403, 404]) test('actual renderer startup storage ' + status + ' is fatal without a polling fallback', async () => {
  let calls = 0;
  const failure = Object.assign(Error('private context must not become a successful receipt'), { $metadata: { httpStatusCode: status } });
  const channel = { read: async () => { calls++; throw failure; } };
  await assert.rejects(acceptActualRenderedMeasurementReady(startupArguments(channel)), error => error === failure);
  assert.equal(calls, 1);
});
test('actual renderer rejects Ready with changed waiting body, nonce, mode or source', async () => {
  for (const change of [ { waitingSha256: 'e'.repeat(64) }, { waitingNonceSha256: 'e'.repeat(64) },
    { mode: 'channel-preflight' }, { sourceArtifactSha256: 'e'.repeat(64) }, { applicationRequests: 1 },
    { trafficStarted: true }, { capacityAcceptance: true } ]) {
    let calls = 0;
    await assert.rejects(acceptActualRenderedMeasurementReady(startupArguments({ read: async () => { calls++; return { ...ready(), ...change }; } })));
    assert.equal(calls, 1);
  }
  await assert.rejects(acceptActualRenderedMeasurementReady({ ...startupArguments({ read: async () => ready() }),
    waiting: { ...waiting, createdAt: new Date(base - 1).toISOString() } }));
});

test('startup recovers transient immutable Ready reads while retaining raw singleflight', async () => {
  let clock=0,calls=0;
  const channel={read:async()=>{
    calls++;
    if(calls===1){clock+=250;throw Object.assign(Error('private body'),{measurementReadCode:'deadline'});}
    if(calls<4)throw Object.assign(Error('private raw still active'),{measurementReadCode:'busy'});
    return ready();
  }};
  const result=await acceptActualRenderedMeasurementReady({...startupArguments(channel),now:()=>clock,sleep:async ms=>{clock+=ms;}});
  assert.equal(calls,4);assert.equal(clock,550);assert.equal(result.capacityAcceptance,false);
});

test('startup stops after four failed actual attempts and never retries ordinary transport or validation failures', async () => {
  let clock=0,calls=0;
  const channel={read:async()=>{calls++;clock+=250;throw Object.assign(Error('private'),{measurementReadCode:'deadline'});}};
  await assert.rejects(acceptActualRenderedMeasurementReady({...startupArguments(channel),now:()=>clock,sleep:async ms=>{clock+=ms;}}));
  assert.equal(calls,4);assert.equal(clock,1300);
  for(const failure of [Error('private body'),Object.assign(Error('private endpoint'),{code:'ECONNRESET'}),Object.assign(Error('private'),{$metadata:{httpStatusCode:503}})]){
    calls=0;
    await assert.rejects(acceptActualRenderedMeasurementReady(startupArguments({read:async()=>{calls++;throw failure;}})),error=>error===failure);
    assert.equal(calls,1);
  }
});

test('startup busy polls stay within eight seconds and the original prestart margin', async () => {
  for(const wallOffset of [10,118_800]){
    let clock=0,calls=0;
    const channel={read:async()=>{calls++;throw Object.assign(Error('private'),{measurementReadCode:'busy'});}};
    await assert.rejects(acceptActualRenderedMeasurementReady({...startupArguments(channel),now:()=>clock,nowWall:()=>base+wallOffset+clock,sleep:async ms=>{clock+=ms;}}));
    assert.equal(clock,wallOffset===10?8000:200);assert.equal(calls,wallOffset===10?80:2);
  }
});

test('startup cannot accept late Ready, cancellation or a backwards monotonic clock', async () => {
  for(const failureMode of ['late','cancelled','backwards']){
    let clock=0,stopped=false,calls=0;
    const channel={read:async()=>{calls++;clock=failureMode==='late'?8000:failureMode==='backwards'?-1:0;stopped=failureMode==='cancelled';return ready();}};
    await assert.rejects(acceptActualRenderedMeasurementReady({...startupArguments(channel),now:()=>clock,stopped:()=>stopped,sleep:async ms=>{clock+=ms;}}));
    assert.equal(calls,1);
  }
});

test('failure diagnostics retain only fixed codes and phases, never error text or identities',()=>{
  const secret='private student cookie URL response';
  const cases=[
    [{$metadata:{httpStatusCode:403}},'access-denied'],[{$metadata:{httpStatusCode:404}},'missing-required-object'],
    [{name:'NoSuchKey'},'missing-required-object'],[{$metadata:{httpStatusCode:429}},'rate-limited'],
    [{$metadata:{httpStatusCode:503}},'storage-unavailable'],[{measurementReadCode:'busy'},'read-unsettled'],
    [{measurementReadCode:'deadline'},'deadline'],[{name:'AbortError'},'deadline'],[{code:'ECONNRESET'},'transport-failure'],
    [{name:'constructor',code:'__proto__'},'refused'],[{},'refused']
  ];
  for(const [fields,code] of cases){
    const result=renderedFailureDiagnostic(Object.assign(Error(secret),fields),'measurement-ready');
    assert.equal(result.code,code);assert.equal(result.phase,'measurement-ready');
    assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(Object.keys(result).length,4);
  }
  assert.equal(renderedFailureDiagnostic(Error(secret),'__proto__').phase,'unknown');
  assert.match(driver,/failureDiagnostic=renderedFailureDiagnostic\(error,phase\)/);
  assert.match(driver,/measurementChannel:measurementChannel\.summary\(\)/);
});
test('actual renderer pending polls cannot complete a causal signal and preserve its original deadline', async () => {
  let calls = 0, observed = 0;
  const channel = { read: async () => { calls++; return measurementPendingSignal(expected, waiting, 'started'); }, summary: () => ({ readInFlight: false }) };
  await assert.rejects(awaitActualRenderedCausalSignal(causalArguments(channel, { onRead: () => { observed++; } })), /Causal signal deadline/);
  assert.equal(calls, 4); assert.equal(observed, 4);
});
test('actual renderer accepts only the exact live signal after pending and validation', async () => {
  const calls = []; let reads = 0, clock = 0;
  const channel = { read: async (name, options) => { calls.push({ name, ...options }); return ++reads < 3 ? measurementPendingSignal(expected, waiting, 'started') : signal(); }, summary: () => ({}) };
  const result = await awaitActualRenderedCausalSignal(causalArguments(channel, { now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; } }));
  assert.equal(result, 100); assert.equal(calls.length, 3);
  assert(calls.every(value => value.name === 'measurement-started.json' && value.kind === kind && value.nonce === nonce));
});
test('actual renderer rejects malformed or foreign pending even if a raw request is in flight', async () => {
  for (const change of [{ signal: 'drained' }, { waitingSha256: 'e'.repeat(64) }, { pending: false }, { unexpected: true }]) {
    let calls = 0;
    const channel = { read: async () => { calls++; return { ...measurementPendingSignal(expected, waiting, 'started'), ...change }; }, summary: () => ({ readInFlight: true }) };
    await assert.rejects(awaitActualRenderedCausalSignal(causalArguments(channel))); assert.equal(calls, 1);
  }
});
for (const status of [403, 404]) test('actual renderer causal storage ' + status + ' is fatal during pending/raw work', async () => {
  let calls = 0;
  const failure = Object.assign(Error('storage denied'), { $metadata: { httpStatusCode: status } });
  const channel = { read: async () => { calls++; throw failure; }, summary: () => ({ readInFlight: true }) };
  await assert.rejects(awaitActualRenderedCausalSignal(causalArguments(channel)), error => error === failure);
  assert.equal(calls, 1);
});
test('actual renderer only retries bounded timeout or an exact retained read guard', async () => {
  const failures = [Object.assign(Error('aborted'), { name: 'AbortError' }),
    Object.assign(Error('Navigation control full-body deadline'), { measurementReadCode: 'deadline' }),
    Object.assign(Error('Navigation control read still settling'), { measurementReadCode: 'busy' })];
  for (const failure of failures) {
    let calls = 0;
    const channel = { read: async () => { if (++calls === 1) throw failure; return signal(); }, summary: () => ({ readInFlight: true }) };
    assert.equal(await awaitActualRenderedCausalSignal(causalArguments(channel)), 50); assert.equal(calls, 2);
  }
  for (const failure of [Error('malformed private payload'), Error('Navigation control read still settling')]) {
    let calls = 0;
    const channel = { read: async () => { calls++; throw failure; }, summary: () => ({ readInFlight: false }) };
    await assert.rejects(awaitActualRenderedCausalSignal(causalArguments(channel)), error => error === failure); assert.equal(calls, 1);
  }
});
test('actual renderer cannot credit a valid receipt returned after deadline or cancellation', async () => {
  let clock = 0;
  const channel = { read: async () => { clock = 201; return signal(); }, summary: () => ({ readInFlight: false }) };
  await assert.rejects(awaitActualRenderedCausalSignal(causalArguments(channel, { now: () => clock })), /after its deadline/);
  let stopped = false;
  const cancelled = { read: async () => { stopped = true; return signal(); }, summary: () => ({ readInFlight: false }) };
  await assert.rejects(awaitActualRenderedCausalSignal(causalArguments(cancelled, { stopped: () => stopped })), /after its deadline/);
});
test('actual renderer ready lookup precedes the barrier and actual pulse dispatch uses the startup gate', () => {
  const readyCall = driver.indexOf('await acceptActualRenderedMeasurementReady(', helperEnd);
  const barrierCall = driver.indexOf('await waitForStagingStart(', helperEnd);
  assert(readyCall > helperEnd && barrierCall > readyCall);
  assert.match(driver, /startupGate\.markReady\(\)/);
  assert.match(driver, /if\(name==='measurement-control\.json'\)assert\.ok\(startupGate\.control\(value\)\)/);
  assert.match(driver, /startup:waiting/); assert.match(driver, /values\['measurement-waiting'\]/);
});
test('actual first timed pulse cannot reuse startup nonce or run before verified readiness and t0', () => {
  let clock = base;
  const gate = new MeasurementStartupGate(expected, { startAt, now: () => clock });
  gate.acceptWaiting(waiting);
  const first = new CapturePulseController(expected, { now: () => 0 }).issue();
  assert.throws(() => gate.control(first)); gate.markReady(); assert.throws(() => gate.control(first));
  clock = Date.parse(startAt);
  for (const field of ['nonce', 'navigationNonce', 'revisionDrainNonce']) assert.throws(() => gate.control({ ...first, [field]: waiting.nonce }));
  assert.equal(gate.firstPulse, false); assert.deepEqual(gate.control(first), first);
});
