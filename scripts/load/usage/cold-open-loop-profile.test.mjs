import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { COLD_OPEN_LOOP_PROFILE, assertColdFixtureSnapshot } from './cold-open-loop-profile.mjs';

const expected={sourceRevision:'a'.repeat(40),sourceHashes:{worker:'b'.repeat(64)},today:'2026-10-02',registrySha256:'c'.repeat(64)};
function fixture() {
  return {...structuredClone(expected),version:1,profileName:COLD_OPEN_LOOP_PROFILE.name,
    schools:Array.from({length:2},(_,index)=>{
      const staff=randomUUID();
      return {index,id:randomUUID(),staff,email:`scale-${staff}@example.test`,
        ...Object.fromEntries(Object.entries({teachers:100,students:500,groups:100,studentSessions:500,devices:500}).map(([key,count])=>
          [key,Array.from({length:count},()=>key==='devices'?`synthetic-scale-${randomUUID()}`:randomUUID())]))};
    }),preparation:{fixtureCounts:[{raw:1_000_001},{raw:1_000_001}],heavyDeviceBindings:[{pairs:500,devices:500,invalid:0},{pairs:500,devices:500,invalid:0}],aiDecisionBindings:[{rows:10_000,invalid:0},{rows:10_000,invalid:0}]}};
}

test('cold profile preserves AI grains, quotas, 100rps and actual48s headroom gate',()=>{
  assert.equal(COLD_OPEN_LOOP_PROFILE.aiDecisionRowsPerSchool,10_000);
  assert.equal(COLD_OPEN_LOOP_PROFILE.fullWorkerAcceptanceMs,48_000);
  assert.equal(COLD_OPEN_LOOP_PROFILE.httpOffering.requestsPerSecond,100);
  assert.equal(COLD_OPEN_LOOP_PROFILE.classPilot.extensionVersion,'2.9.7');
  assert.equal(COLD_OPEN_LOOP_PROFILE.classPilot.capabilities.length,39);
  assert.equal(new Set(COLD_OPEN_LOOP_PROFILE.classPilot.capabilities).size,39);
  for(const cap of ['privateChatLifecycleV1','scopedAuthorityChecksV1','studentChatIdempotencyV1']) assert.ok(COLD_OPEN_LOOP_PROFILE.classPilot.capabilities.includes(cap));
  assert.match(COLD_OPEN_LOOP_PROFILE.classPilot.sourceCommit,/^[a-f0-9]{40}$/);
  assert.match(COLD_OPEN_LOOP_PROFILE.classPilot.sourceLfSha256,/^[a-f0-9]{64}$/);
  assert.match(COLD_OPEN_LOOP_PROFILE.coldDefinition,/host filesystem caches are not flushed/);
  assert.doesNotThrow(()=>assertColdFixtureSnapshot(fixture(),expected));
});

test('cold resume rejects different source/schema/day and changed binding cardinalities',()=>{
  for(const change of [s=>s.sourceRevision='f'.repeat(40),s=>s.sourceHashes.worker='f'.repeat(64),s=>s.today='2026-10-03',
    s=>s.registrySha256='f'.repeat(64),s=>s.schools.pop(),s=>s.schools[0].students.pop(),
    s=>s.schools[1].students[0]=s.schools[0].students[0],s=>s.preparation.fixtureCounts[0].raw=999999,
    s=>s.preparation.aiDecisionBindings[0].rows=0,s=>s.preparation.heavyDeviceBindings[0].invalid=1,
    s=>s.schools[0].token='do-not-persist-auth-token',s=>s.schools[0].deviceTokens=[]]) {
    const value=fixture(); change(value); assert.throws(()=>assertColdFixtureSnapshot(value,expected));
  }
});
