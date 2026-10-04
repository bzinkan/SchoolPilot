import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// New contracts only. The failed single-API 100/s contract is immutable.
export const OLD_CONTRACT_SHA256 = '10772ca928db810eda736c260f450cbe97ab76d1f130e7124c8e7e5e72815e92';
export const OLD_CLOSED_JOURNAL_SHA256 = '0fa077d62df01d2423c629738e0e76695532ed44ba4ab02ed413aa18327c6604';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const frozen = value => Object.freeze(value);
const offering = (rate, schoolDevices, durationMs = 60_000) => frozen({ requestsPerSecond: rate,
  schoolDevices: frozen(schoolDevices), durationMs, deviceCadenceMs: 10_000,
  expected: rate * durationMs / 1000, maxInFlight: schoolDevices.reduce((a, b) => a + b, 0),
  requestTimeoutMs: 20_000, maxOfferLatenessMs: 100 });
const broader = (variant, distribution) => frozen({name:`release297-usage-800-3-2-${variant}-v2`,kind:'mixed',offering:offering(80,[400,400]),usage:true,
  apiTasks:3,initialApiTasks:3,rounds:15,repetitions:3,continuousOffering:offering(80,[400,400],900_000),broaderCapacityGate:true,
  broaderVariant:variant,reports:64,rawPerSchool:1_000_000,workerAcceptanceMs:48_000,workerStartAtMs:600_000,
  reportWaveOffsetsMs:frozen([0,300_000,600_000,720_000]),capacityDeadlinesOnly:true,stages:frozen([
    frozen({fromRound:0,active:frozen([0,1,2]),distribution:'uniform'}),
    frozen({fromRound:5,active:frozen([0,1,2]),distribution:'sticky80'}),
    frozen({fromRound:10,active:frozen([1,2]),distribution,lost:0,reconnectOffers:640,reconnectSchoolDevices:frozen([320,320]),
      reconnectWindowMs:8000,reconnectStartDelayMs:1000,reconnectLostOnly:true,...(distribution==='lostToOneSurvivor'?{reconnectTarget:1}:{})}),
  ])});
export const PROFILES = frozen({
  sole: frozen({ name: 'release297-blackbox-sole-133-v2', kind: 'blackbox', offering: offering(13.3, [133, 0]), usage: false, apiTasks: 1 }),
  normal: frozen({ name: 'release297-blackbox-normal-34-v2', kind: 'blackbox', offering: offering(34, [170, 170]), usage: false, apiTasks: 1 }),
  overload: frozen({ name: 'release297-blackbox-overload-100-diagnostic-v2', kind: 'diagnostic', offering: offering(100, [500, 500]), usage: false, apiTasks: 1 }),
  classroom: frozen({ name: 'release297-classroom-normal-34-v2', kind: 'classroom', offering: offering(34, [170, 170]), usage: false, apiTasks: 1 }),
  classroomNative:frozen({name:'release297-classroom-normal-34-native-v3',kind:'classroom',offering:offering(34,[170,170]),usage:false,apiTasks:1,
    classroomBindingOracle:'durable-delivery-relational-lifecycle-v1'}),
  mixed: frozen({ name: 'release297-classroom-133-1-3-2-v2', kind: 'mixed', offering: offering(13.3, [133, 0]), usage: false, apiTasks: 3,
    rounds: 15, repetitions: 3, continuousOffering: offering(13.3,[133,0],900_000), warmNewApisAtMs:270_000, stages: frozen([
      frozen({ fromRound: 0, active: frozen([0]), distribution: 'uniform' }),
      frozen({ fromRound: 5, active: frozen([0, 1, 2]), distribution: 'uniform' }),
      frozen({ fromRound: 7, active: frozen([0, 1, 2]), distribution: 'sticky80' }),
      frozen({ fromRound: 10, active: frozen([1, 2]), distribution: 'survivors', lost: 0, reconnectOffers: 133, reconnectWindowMs: 10_000, reconnectStartDelayMs: 1000 }),
    ]) }),
  mixedNative:frozen({name:'release297-classroom-133-1-3-2-native-v3',kind:'mixed',offering:offering(13.3,[133,0]),usage:false,apiTasks:3,
    classroomBindingOracle:'durable-delivery-relational-lifecycle-v1',rounds:15,repetitions:3,continuousOffering:offering(13.3,[133,0],900_000),warmNewApisAtMs:270_000,stages:frozen([
      frozen({fromRound:0,active:frozen([0]),distribution:'uniform'}),frozen({fromRound:5,active:frozen([0,1,2]),distribution:'uniform'}),
      frozen({fromRound:7,active:frozen([0,1,2]),distribution:'sticky80'}),
      frozen({fromRound:10,active:frozen([1,2]),distribution:'survivors',lost:0,reconnectOffers:133,reconnectWindowMs:10_000,reconnectStartDelayMs:1000}),
    ])}),
  boundaryPreparation:frozen({name:'release297-classroom-133-loss-boundary-preparation-v1',kind:'mixed',offering:offering(13.3,[133,0]),usage:false,
    apiTasks:3,initialApiTasks:3,rounds:15,continuousOffering:offering(13.3,[133,0],900_000),preparationOnly:true,
    boundaryWindow:frozen({fromOffsetMs:590_000,durationMs:20_000,reconnectOffsetMs:601_000,reconnectDurationMs:10_000,reconnectOffers:133}),stages:frozen([
      frozen({fromRound:0,active:frozen([0]),distribution:'uniform'}),frozen({fromRound:5,active:frozen([0,1,2]),distribution:'uniform'}),
      frozen({fromRound:7,active:frozen([0,1,2]),distribution:'sticky80'}),
      frozen({fromRound:10,active:frozen([1,2]),distribution:'survivors',lost:0,reconnectOffers:133,reconnectWindowMs:10_000,reconnectStartDelayMs:1000}),
    ])}),
  usage: frozen({ name: 'release297-usage-shared-db-three-api-100-v2', kind: 'usage', offering: offering(100, [500, 500]), usage: true,
    apiTasks: 3, repetitions: 3, reports: 64, rawPerSchool: 1_000_000, workerAcceptanceMs: 48_000, pairedReleaseComparisonRequired: true }),
  broader: broader('ordinary-survivors','survivors'),
  broaderConcentrated: broader('concentrated-lost-reconnect','lostToOneSurvivor'),
});
export const NONREGRESSION = frozen({ controlRuns: 2, pairs: 3, medianCpuRatio: 1.05, medianP95Ratio: 1.10,
  medianP95IncreaseMs: 50, individualCpuRatio: 1.10, individualP95IncreaseMs: 100,
  p95Ms: 500, meanCpuFraction: .60 });
export function profileFor(name) {
  const value = Object.values(PROFILES).find(profile => profile.name === name);
  assert.ok(value, 'Unknown v2 profile'); return value;
}
export function profileHash(profile) { assert.deepEqual(profile, profileFor(profile.name)); return hash(JSON.stringify(profile)); }
export function assertOffering(config) {
  assert.ok(Number.isFinite(config.requestsPerSecond) && config.requestsPerSecond > 0);
  for (const key of ['durationMs', 'deviceCadenceMs', 'expected', 'maxInFlight', 'requestTimeoutMs']) assert.ok(Number.isSafeInteger(config[key]) && config[key] > 0, key);
  assert.ok(Array.isArray(config.schoolDevices) && config.schoolDevices.length === 2 && config.schoolDevices.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 500));
  assert.equal(config.expected, Math.round(config.durationMs * config.requestsPerSecond / 1000));
  assert.equal(config.schoolDevices.reduce((a, b) => a + b, 0) * config.durationMs / config.deviceCadenceMs, config.expected);
  assert.ok(Number.isFinite(config.maxOfferLatenessMs) && config.maxOfferLatenessMs >= 0);
}
export function stickyTarget(studentOrdinal, active, distribution) {
  assert.ok(Number.isSafeInteger(studentOrdinal) && studentOrdinal >= 0);
  assert.ok(active.length > 0 && new Set(active).size === active.length);
  if (distribution === 'sticky80' && active.length === 3) return studentOrdinal % 10 < 8 ? active[0] : active[1 + studentOrdinal % 2];
  if(distribution==='lostToOneSurvivor'&&active.length===2)return studentOrdinal%10<8?active[0]:active[studentOrdinal%2];
  assert.ok(['uniform', 'sticky80', 'survivors'].includes(distribution));
  return active[studentOrdinal % active.length];
}
export function stageForRound(round,profile=PROFILES.mixed) {
  assert.equal(profile.kind,'mixed');assert.ok(Number.isSafeInteger(round) && round >= 0 && round < profile.rounds);
  return [...profile.stages].reverse().find(stage => round >= stage.fromRound);
}
