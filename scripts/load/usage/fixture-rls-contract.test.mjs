import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRlsContract,assertFixtureRuntimeModes,assertCompleteFixtureCatalog,DEFAULT_USAGE_RLS_INVENTORY} from './fixture-rls-contract.mjs';
const tables = Array.from({length:127},(_,i) => `fixture_table_${i}`);
const combined = [...tables,'passpilot_appointments'];
const registry = {inventories:{[DEFAULT_USAGE_RLS_INVENTORY]:{tables},passpilotAppointmentsPostExpand:{tables:combined}}};
const env = selected => ({USAGE_SCALE_RLS_INVENTORY:selected,RLS_ENABLED_TABLES:(selected === 'passpilotAppointmentsPostExpand' ? combined : tables).join(','),CLASSPILOT_USAGE_ROLLUP_MODE:'on',CLASSPILOT_DIGITAL_USAGE_MODE:'on',SCHEDULER_ENABLED:'false',CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1:'false',CLASSPILOT_CAP_FOCUS_TAB_V1:'false',CLASSPILOT_CAPABILITY_ROLLOUTS_JSON:JSON.stringify({preciseRestrictionResourcesV1:{mode:'off'},focusTabV1:{mode:'off'}})});
test('standalone default preserves127 and combined128 is explicit and requires its source inventory',() => {
  assert.equal(fixtureRlsContract(registry,'a'.repeat(64),env()).tables.length,127);
  assert.equal(fixtureRlsContract(registry,'a'.repeat(64),env('passpilotAppointmentsPostExpand')).tables.length,128);
  assert.throws(() => fixtureRlsContract({inventories:{[DEFAULT_USAGE_RLS_INVENTORY]:{tables}}},'a'.repeat(64),env('passpilotAppointmentsPostExpand')),/missing/);
  assert.throws(() => fixtureRlsContract(registry,'a'.repeat(64),{...env(),USAGE_SCALE_RLS_INVENTORY:'unreviewed'}),/reviewed/);
  assert.throws(() => fixtureRlsContract(registry,'a'.repeat(64),{...env(),RLS_ENABLED_TABLES:[...tables].reverse().join(',')}),/order/);
});
test('existing daily rollup reports configured value separately and real shadow default, with scheduler disabled',() => {
  for (const configured of [undefined,'off','shadow','']) {
    const contract=fixtureRlsContract(registry,'a'.repeat(64),{...env('passpilotAppointmentsPostExpand'),CLASSPILOT_DAILY_USAGE_ROLLUP_MODE:configured});
    assert.deepEqual(contract.dailyUsageRollup,{configured:configured ?? null,effective:'shadow'});
    assert.equal(contract.effectiveModes.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE,'shadow');
    assert.equal(contract.schedulerEnabled,false);
  }
  for (const configured of ['on','set_based','legacy']) assert.throws(() => fixtureRlsContract(registry,'a'.repeat(64),{...env('passpilotAppointmentsPostExpand'),CLASSPILOT_DAILY_USAGE_ROLLUP_MODE:configured}),/profile mode/);
});
test('combined profile rejects either active new capability switch or any broader rollout',() => {
  for (const key of ['CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1','CLASSPILOT_CAP_FOCUS_TAB_V1']) {
    for (const value of [undefined,'on','1','true','yes']) assert.throws(() => fixtureRlsContract(registry,'a'.repeat(64),{...env('passpilotAppointmentsPostExpand'),[key]:value}),/explicitly off/);
  }
  for (const capability of ['preciseRestrictionResourcesV1','focusTabV1']) for (const mode of ['on','observe','canary']) {
    const selected=env('passpilotAppointmentsPostExpand');
    const rollouts=JSON.parse(selected.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON); rollouts[capability]={mode};
    assert.throws(() => fixtureRlsContract(registry,'a'.repeat(64),{...selected,CLASSPILOT_CAPABILITY_ROLLOUTS_JSON:JSON.stringify(rollouts)}),/explicitly off/);
  }
  assert.throws(() => fixtureRlsContract(registry,'a'.repeat(64),{...env('passpilotAppointmentsPostExpand'),CLASSPILOT_CAPABILITY_ROLLOUTS_JSON:'{'}),SyntaxError);
});
test('production parser verification rejects mismatched daily or capability metadata',() => {
  const selected=env('passpilotAppointmentsPostExpand');
  const contract=fixtureRlsContract(registry,'a'.repeat(64),selected);
  const daily={parseDailyUsageRollupMode:() => 'shadow'};
  const protocol={assertClasspilotCapabilityRolloutsEnv:() => {},classpilotCapabilityRolloutMode:() => 'off',isClasspilotCapabilityActive:() => false};
  assert.throws(() => assertFixtureRuntimeModes(contract,{parseDailyUsageRollupMode:() => 'legacy'},protocol,selected),/daily parser/);
  assert.throws(() => assertFixtureRuntimeModes(contract,daily,{...protocol,classpilotCapabilityRolloutMode:() => 'on'},selected),/rollout parser/);
  assert.throws(() => assertFixtureRuntimeModes(contract,daily,{...protocol,isClasspilotCapabilityActive:() => true},selected),/capability parser/);
  assertFixtureRuntimeModes(contract,daily,protocol,selected);
  assert.equal(contract.productionParserVerified,true);
});
test('combined profile rejects active unrelated modes and missing, unforced or owner catalog rows',() => {
  const selected=env('passpilotAppointmentsPostExpand');
  for(const key of ['PASSPILOT_RULES_MODE','PASSPILOT_APPOINTMENTS_MODE','PASSPILOT_REPORTS_MODE','CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE','CLASSPILOT_DAILY_USAGE_ROLLUP_MODE']) assert.throws(() => fixtureRlsContract(registry,'a'.repeat(64),{...selected,[key]:'on'}),/profile mode/);
  const contract=fixtureRlsContract(registry,'a'.repeat(64),selected);
  const rows=combined.map(relname => ({relname,relrowsecurity:true,relforcerowsecurity:true,owns_table:false}));
  assertCompleteFixtureCatalog(contract,rows);
  assert.throws(() => assertCompleteFixtureCatalog(contract,rows.slice(1)),/Every selected table/);
  for(const replacement of [{relforcerowsecurity:false},{relrowsecurity:false},{owns_table:true}]) assert.throws(() => assertCompleteFixtureCatalog(contract,[{...rows[0],...replacement},...rows.slice(1)]),/non-owner/);
});
test('final129 is explicit, preserves old defaults, and requires private lifecycle off plus the complete catalog',()=>{
  const current=[...combined,'classpilot_private_chat_threads'];
  const currentRegistry={inventories:{...registry.inventories,classpilotPrivateChatLifecyclePostExpand:{tables:current}}};
  const selected={...env('passpilotAppointmentsPostExpand'),USAGE_SCALE_RLS_INVENTORY:'classpilotPrivateChatLifecyclePostExpand',RLS_ENABLED_TABLES:current.join(','),
    CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1:'false',CLASSPILOT_CAPABILITY_ROLLOUTS_JSON:JSON.stringify({preciseRestrictionResourcesV1:{mode:'off'},focusTabV1:{mode:'off'},privateChatLifecycleV1:{mode:'off'}})};
  const contract=fixtureRlsContract(currentRegistry,'a'.repeat(64),selected);
  assert.equal(contract.tables.length,129); assert.equal(contract.newCapabilityGates.privateChatLifecycleV1.active,false);
  assert.equal(fixtureRlsContract(currentRegistry,'a'.repeat(64),env()).tables.length,127);
  assert.equal(fixtureRlsContract(currentRegistry,'a'.repeat(64),env('passpilotAppointmentsPostExpand')).tables.length,128);
  assert.throws(()=>fixtureRlsContract(registry,'a'.repeat(64),selected),/missing/);
  for(const value of [undefined,'true','on']) assert.throws(()=>fixtureRlsContract(currentRegistry,'a'.repeat(64),{...selected,CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1:value}),/explicitly off/);
  assert.throws(()=>fixtureRlsContract(currentRegistry,'a'.repeat(64),{...selected,CLASSPILOT_CAPABILITY_ROLLOUTS_JSON:JSON.stringify({preciseRestrictionResourcesV1:{mode:'off'},focusTabV1:{mode:'off'},privateChatLifecycleV1:{mode:'on'}})}),/explicitly off/);
  const rows=current.map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true,owns_table:false}));
  assertCompleteFixtureCatalog(contract,rows);
  assert.throws(()=>assertCompleteFixtureCatalog(contract,rows.slice(0,-1)),/Every selected table/);
});
