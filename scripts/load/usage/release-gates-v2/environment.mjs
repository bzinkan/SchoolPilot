import assert from 'node:assert/strict';
import { commonFixture } from './common-fixture.mjs';
import { hash } from './contracts.mjs';

export function remapObservedEnvironment(capture, scopeBinding, today, fixtureSchoolIds = commonFixture(today).schools.map(row=>row.id)) {
  const api = capture.definitions.find(row => row.service === 'schoolpilot-production-api'); assert.ok(api?.environment);
  assert.ok(Array.isArray(fixtureSchoolIds)&&fixtureSchoolIds.length===2&&new Set(fixtureSchoolIds).size===2);
  const scopes = new Map(scopeBinding.map(row => [row.observedSchoolId, fixtureSchoolIds[row.fixtureSchoolIndex]]));
  assert.ok([...scopes.values()].every(Boolean));
  const env = structuredClone(api.environment);
  const remap = id => { assert.ok(scopes.has(id), 'Observed school scope needs an explicit synthetic binding'); return scopes.get(id); };
  if (env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON) {
    const rollouts = JSON.parse(env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON);
    for (const rollout of Object.values(rollouts)) {
      for (const key of ['schoolIds', 'excludedSchoolIds']) if (Array.isArray(rollout[key])) rollout[key] = rollout[key].map(remap);
    }
    env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify(rollouts);
  }
  for (const [key, value] of Object.entries(env)) if (/(?:SCHOOL_IDS|EXCLUDED_SCHOOL_IDS)$/.test(key) && value) env[key] = value.split(',').map(id => remap(id.trim())).join(',');
  return { environment: env, observedFlagsSha256: hash(JSON.stringify(api.environment)), scopeBindingSha256: hash(JSON.stringify(scopeBinding)) };
}
export function roleEnvironment({ base, source, run, appUrl, adminUrl, profile, role, tables, secrets, clientCapabilities, arm = 'C', apiIndex = 0 }) {
  assert.ok(Number(base.DB_POOL_MAX) >= 16); assert.equal(base.SCHEDULER_DB_POOL_MAX, '5');
  // The observed raw20 is clamped by production source to effective16. Keep
  // the same effective quota and record the raw capture's independent hash.
  const maps = JSON.parse(base.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON || '{}');
  const newCaps = { preciseRestrictionResourcesV1: 'PRECISE_RESTRICTION_RESOURCES_V1', focusTabV1: 'FOCUS_TAB_V1', privateChatLifecycleV1: 'PRIVATE_CHAT_LIFECYCLE_V1' };
  if (arm !== 'A') for (const cap of Object.keys(newCaps)) maps[cap] = { mode: ['classroom', 'mixed', 'usage'].includes(profile.kind) ? 'on' : 'off' };
  const env = { ...base, DATABASE_URL: appUrl, DATABASE_URL_PRIVILEGED: appUrl, ADMIN_DATABASE_URL: adminUrl,
    ...secrets, NODE_ENV: 'test', GIT_SHA: source, RLS_GUC_ENABLED: 'true', RLS_ENABLED_TABLES: tables.join(','),
    REDIS_URL: 'redis://127.0.0.1:6387', SCHEDULER_ENABLED: role === 'worker' ? 'true' : 'false',
    DB_POOL_MAX: role === 'worker' ? '2' : '16', SESSION_DB_POOL_MAX: '2', SCHEDULER_DB_POOL_MAX: '5', SCHEDULER_LOCK_POOL_MAX: '8',
    CLASSPILOT_USAGE_ROLLUP_MODE: profile.usage ? 'on' : 'off', CLASSPILOT_DIGITAL_USAGE_MODE: profile.usage ? 'on' : 'off',
    CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify(maps),
    RUN_MIGRATIONS_ONLY: 'false', RUN_LEGACY_MIGRATIONS_ONLY: 'false', DOTENV_CONFIG_PATH: '/nonexistent-owned-fixture-env', DOTENV_CONFIG_QUIET: 'true',
    USAGE_LOCAL_SCALE: '1', USAGE_SCALE_CONTAINER: 'schoolpilot-usage-scale-' + run, USAGE_SOURCE_REVISION: source,
    USAGE_RELEASE_ROLE: role.startsWith('api') ? 'api' : role,
    PGAPPNAME: role.startsWith('api') ? 'usage_release_api' : role === 'worker' ? 'usage_release_worker' : 'usage_release_observer',
    RELEASE297_PROFILE: profile.name, RELEASE297_API_PORT: String(4001 + apiIndex), RELEASE297_EXTENSION_VERSION: arm === 'C' ? '2.9.7' : '2.9.6',
    RELEASE297_REQUIRED_CAPABILITIES: JSON.stringify(['scopedAuthorityChecksV1', 'screenshotTrackingWindowLeaseV1']),
    RELEASE297_CLIENT_CAPABILITIES: JSON.stringify(clientCapabilities??[]),
  };
  if (arm !== 'A') for (const [cap, flag] of Object.entries(newCaps)) env['CLASSPILOT_CAP_' + flag] = maps[cap].mode === 'on' ? 'true' : 'false';
  // This fixture-only writer serves no requests. Avoid initializing the
  // storage module's rate limiter before the serving Redis namespace exists.
  if(role==='seeder')delete env.REDIS_URL;
  return env;
}
export function validateBaselineAdvertisement(receipt){
  assert.equal(receipt.verified,true);assert.equal(receipt.version,'2.9.6');assert.match(receipt.taggedSource,/^[a-f0-9]{40}$/);
  assert.match(receipt.archiveSha256,/^[a-f0-9]{64}$/);assert.match(receipt.packagedServiceWorkerSha256,/^[a-f0-9]{64}$/);
  assert.equal(receipt.advertisedCapabilities?.length,36);assert.equal(new Set(receipt.advertisedCapabilities).size,36);
  assert.ok(receipt.advertisedCapabilities.includes('scopedAuthorityChecksV1')&&receipt.advertisedCapabilities.includes('screenshotTrackingWindowLeaseV1'));
  return [...receipt.advertisedCapabilities];
}
