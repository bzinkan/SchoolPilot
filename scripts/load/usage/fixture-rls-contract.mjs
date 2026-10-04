import assert from 'node:assert/strict';
export const DEFAULT_USAGE_RLS_INVENTORY = 'classpilotUsageRollupDaysPostExpand';
export function fixtureRlsContract(registry, registrySha256, env) {
  const name = env.USAGE_SCALE_RLS_INVENTORY || DEFAULT_USAGE_RLS_INVENTORY;
  assert.ok([DEFAULT_USAGE_RLS_INVENTORY,'passpilotAppointmentsPostExpand','classpilotPrivateChatLifecyclePostExpand'].includes(name), 'Only reviewed usage inventories are permitted');
  const tables = registry.inventories?.[name]?.tables;
  assert.ok(Array.isArray(tables), 'Requested inventory is missing from this source');
  assert.equal(tables.length, name === DEFAULT_USAGE_RLS_INVENTORY ? 127 : name === 'passpilotAppointmentsPostExpand' ? 128 : 129);
  assert.equal(new Set(tables).size, tables.length);
  assert.ok(tables.every(table => /^[a-z][a-z0-9_]*$/.test(table)));
  assert.match(registrySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((env.RLS_ENABLED_TABLES || '').split(','), tables, 'Admission must preserve the selected registry order');
  const effectiveModes = Object.fromEntries(['CLASSPILOT_USAGE_ROLLUP_MODE','CLASSPILOT_DIGITAL_USAGE_MODE',
    'CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE','PASSPILOT_RULES_MODE','PASSPILOT_APPOINTMENTS_MODE','PASSPILOT_REPORTS_MODE'].map(key => [key, env[key] ?? 'off']));
  assert.ok(Object.values(effectiveModes).every(value => ['off','on','shadow','v2'].includes(value)), 'Only mode enums may enter fixture evidence');
  // This existing scheduler mode defaults to shadow, including configured off.
  // The compiled production parser verifies this independent metadata below.
  const dailyConfigured = env.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE ?? null;
  const dailyValue = String(dailyConfigured || 'shadow').trim().toLowerCase();
  const dailyUsageRollup = {configured:dailyConfigured,effective:dailyValue === 'on' || dailyValue === 'set_based' ? 'set_based' : dailyValue === 'legacy' ? 'legacy' : 'shadow'};
  effectiveModes.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE = dailyUsageRollup.effective;
  const newCapabilityGates = {};
  if (name !== DEFAULT_USAGE_RLS_INVENTORY) {
    for (const [key,value] of Object.entries(effectiveModes)) assert.equal(value, key === 'CLASSPILOT_DAILY_USAGE_ROLLUP_MODE' ? 'shadow' : ['CLASSPILOT_USAGE_ROLLUP_MODE','CLASSPILOT_DIGITAL_USAGE_MODE'].includes(key) ? 'on' : 'off', `${key} must retain the combined usage profile mode`);
    assert.equal(env.SCHEDULER_ENABLED, 'false');
    const rollout = JSON.parse(env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON || '{}');
    assert.ok(rollout && typeof rollout === 'object' && !Array.isArray(rollout), 'Combined capability rollout must be an object');
    const capabilities = [['preciseRestrictionResourcesV1','CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1'],['focusTabV1','CLASSPILOT_CAP_FOCUS_TAB_V1']];
    if(name==='classpilotPrivateChatLifecyclePostExpand') capabilities.push(['privateChatLifecycleV1','CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1']);
    for (const [capability,key] of capabilities) {
      assert.equal(env[key], 'false', `${key} must be explicitly off`);
      assert.deepEqual(rollout[capability], {mode:'off'}, `${capability} rollout must be explicitly off`);
      newCapabilityGates[capability] = {configuredSwitch:env[key],configuredRollout:rollout[capability],effectiveRollout:'off',active:false};
    }
  }
  return {name,registrySha256,tables:[...tables],effectiveModes,dailyUsageRollup,schedulerEnabled:env.SCHEDULER_ENABLED === 'true',newCapabilityGates,heartbeatOfferedCapabilities:[],productionParserVerified:false};
}
export function assertFixtureRuntimeModes(contract, daily, protocol, env) {
  assert.equal(daily.parseDailyUsageRollupMode(env.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE), contract.dailyUsageRollup.effective, 'Production daily parser must match recorded metadata');
  protocol.assertClasspilotCapabilityRolloutsEnv(env);
  for (const [capability,gate] of Object.entries(contract.newCapabilityGates)) {
    assert.equal(protocol.classpilotCapabilityRolloutMode(capability,env), gate.effectiveRollout, 'Production rollout parser must confirm off');
    assert.equal(protocol.isClasspilotCapabilityActive(capability,{schoolId:'synthetic-fixture'},env), gate.active, 'Production capability parser must confirm inactive');
  }
  contract.productionParserVerified = true;
}
export function assertCompleteFixtureCatalog(contract, rows) {
  assert.deepEqual(rows.map(row => row.relname).sort(), [...contract.tables].sort(), 'Every selected table must exist in the fixture');
  assert.ok(rows.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.owns_table), 'Every selected table must force RLS under a non-owner role');
}
