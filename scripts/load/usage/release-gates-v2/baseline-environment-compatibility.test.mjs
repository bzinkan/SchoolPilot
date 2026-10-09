import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROFILES, profileHash, hash } from './contracts.mjs';
import { roleEnvironment } from './environment.mjs';
import { baselineFixedEnvironment, BASELINE_COMPATIBILITY_SOURCE, BASELINE_COMPATIBILITY_SUCCESSOR,
  BASELINE_COMPATIBILITY_PROFILE_SHA256, BASELINE_SUPPORTED_ROLLOUT_KEYS, BASELINE_UNSUPPORTED_CAPABILITIES } from './baseline-environment-compatibility.mjs';

function fixture() {
  const maps = { scopedAuthorityChecksV1: { mode: 'on', schoolIds: ['synthetic-school'] },
    exactBindingAckV2: { mode: 'canary', canaryPercent: 25 }, safetyEvidenceCaptureV1: { mode: 'observe' } };
  const environment = { DB_POOL_MAX: '20', SCHEDULER_DB_POOL_MAX: '5', CLASSPILOT_USAGE_ROLLUP_MODE: 'off',
    CLASSPILOT_DIGITAL_USAGE_MODE: 'off', CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: 'true',
    CLASSPILOT_CAP_EXACT_BINDING_ACK_V2: 'true', UNRELATED_SETTING: 'retained', JWT_SECRET: 'synthetic-only' };
  for (const [capability, flag] of Object.entries(BASELINE_UNSUPPORTED_CAPABILITIES)) {
    maps[capability] = { mode: 'on', schoolIds: ['synthetic-school'] }; environment[flag] = 'true';
  }
  environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify(maps);
  return { environment, source: BASELINE_COMPATIBILITY_SOURCE, arm: 'A', profile: PROFILES.sole, successorId: BASELINE_COMPATIBILITY_SUCCESSOR };
}

test('exact v3 fixed133 baseline projects only three unsupported capabilities and retains complete provenance', () => {
  const args = fixture(), original = structuredClone(args.environment), result = baselineFixedEnvironment(args);
  assert.deepEqual(args.environment, original);
  const expected = structuredClone(original), map = JSON.parse(expected.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON);
  for (const [capability, flag] of Object.entries(BASELINE_UNSUPPORTED_CAPABILITIES)) { delete map[capability]; delete expected[flag]; }
  expected.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify(map);
  assert.deepEqual(result.environment, expected);
  assert.equal(result.proof.originalEnvironmentSha256, hash(JSON.stringify(original)));
  assert.equal(result.proof.effectiveEnvironmentSha256, hash(JSON.stringify(expected)));
  assert.equal(result.proof.omitted.length, 3);
  assert.ok(result.proof.omitted.every(row => row.observedMode === 'on' && row.effectiveMode === 'unsupported_off'));
  assert.equal(Object.hasOwn(result.environment, 'CLASSPILOT_DAILY_USAGE_ROLLUP_MODE'), false);
  assert.equal(result.proof.acceptanceCriteriaChanged, false);
});

test('historical successors, unrelated runs and candidate roles retain previous environments exactly', () => {
  const args = fixture();
  for (const change of [{successorId:undefined}, {successorId:'release297-current-school-acceptance-ecf6ce01-v1'},
    {successorId:'release297-current-school-acceptance-ecf6ce01-cp-protected-v2'}, {arm:'B'}, {arm:'C'}]) {
    const actual = baselineFixedEnvironment({...args,...change});
    assert.equal(actual.environment, args.environment); assert.equal(actual.proof, null);
  }
  const roles = {source:'2001e8888992674493c3084981fa8aae27d70e1d',run:'a'.repeat(12),appUrl:'synthetic',adminUrl:'synthetic',profile:PROFILES.sole,tables:[],secrets:{},arm:'B'};
  for (const role of ['seeder','api0','worker','observer','generator']) {
    const before = roleEnvironment({...roles,role,base:args.environment});
    const unchanged = baselineFixedEnvironment({...args,arm:'B'}).environment;
    assert.deepEqual(roleEnvironment({...roles,role,base:unchanged}), before);
    const map = JSON.parse(before.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON);
    for (const [capability, flag] of Object.entries(BASELINE_UNSUPPORTED_CAPABILITIES)) {
      assert.deepEqual(map[capability], {mode:'off'}); assert.equal(before[flag], 'false');
    }
  }
});

test('projection rejects moved sources/profiles, changed observed modes and any other unknown map key', () => {
  const args = fixture();
  assert.throws(() => baselineFixedEnvironment({...args,source:'a'.repeat(40)}), /SOURCE_CHANGED/);
  assert.throws(() => baselineFixedEnvironment({...args,profile:PROFILES.lower133}), /PROFILE_CHANGED/);
  assert.throws(() => baselineFixedEnvironment({...args,profile:{...PROFILES.sole,offering:{...PROFILES.sole.offering,expected:797}}}));
  for (const unknown of ['futureUnreviewedV1','restrictionPortalFirstV1']) {
    const environment = structuredClone(args.environment), maps = JSON.parse(environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON);
    maps[unknown] = {mode:'off'}; environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify(maps);
    assert.throws(() => baselineFixedEnvironment({...args,environment}), /UNKNOWN_ROLLOUT_KEY/);
  }
  for (const changed of ['map','flag']) {
    const environment = structuredClone(args.environment), [capability,flag] = Object.entries(BASELINE_UNSUPPORTED_CAPABILITIES)[0];
    if (changed === 'flag') environment[flag] = 'false';
    else { const maps = JSON.parse(environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON); maps[capability].mode = 'off'; environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify(maps); }
    assert.throws(() => baselineFixedEnvironment({...args,environment}), /REVIEWED_BASELINE_CAPABILITY/);
  }
});

test('real exact baseline Git source proves the allowlist and unchanged fixed133 profile', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const source = execFileSync('git',['-C',root,'show',BASELINE_COMPATIBILITY_SOURCE+':src/services/classpilotProtocol.ts'],{encoding:'utf8',windowsHide:true});
  const declaration = source.match(/export const CLASSPILOT_PROTOCOL_V3_CAPABILITIES = \[([\s\S]*?)\] as const;/);
  assert.ok(declaration);
  const capabilities = [...declaration[1].matchAll(/"([A-Za-z0-9]+)"/g)].map(match=>match[1]);
  assert.deepEqual(BASELINE_SUPPORTED_ROLLOUT_KEYS,[...capabilities].filter(value=>value!=='restrictionPortalFirstV1'));
  for (const capability of Object.keys(BASELINE_UNSUPPORTED_CAPABILITIES)) assert.equal(capabilities.includes(capability), false);
  assert.match(source,/capability\) => capability !== "restrictionPortalFirstV1"/);
  assert.match(source,/if \(!supported\.has\(name\)/);
  assert.equal(profileHash(PROFILES.sole),BASELINE_COMPATIBILITY_PROFILE_SHA256);
  assert.deepEqual([PROFILES.sole.offering.expected,PROFILES.sole.offering.durationMs,PROFILES.sole.offering.schoolDevices,PROFILES.sole.usage],[798,60_000,[133,0],false]);
});
