import assert from 'node:assert/strict';
import { SCHOOL_DAY_AI_PROFILE } from './school-day-ai-profile.mjs';
import { OPEN_LOOP_HEARTBEATS } from './open-loop-heartbeats.mjs';
import classPilot from './classpilot-297-advertised-capabilities.json' with { type: 'json' };

export const COLD_OPEN_LOOP_PROFILE = Object.freeze({ ...SCHOOL_DAY_AI_PROFILE,
  name: 'six-lessons-200-domains-1m-unique-10k-ai-cold-open-loop-100rps',
  httpOffering: OPEN_LOOP_HEARTBEATS, fullWorkerAcceptanceMs: 48_000,
  classPilot: Object.freeze({ ...classPilot, capabilities: Object.freeze([...classPilot.capabilities]) }),
  coldDefinition: 'Fresh owned fixture, seeded and ANALYZEd, all clients closed, owned PostgreSQL restarted before a fresh measurement process. PostgreSQL shared buffers reset; host filesystem caches are not flushed.',
});

export function assertColdFixtureSnapshot(snapshot, expected) {
  assert.equal(snapshot.version, 1); assert.equal(snapshot.sourceRevision, expected.sourceRevision);
  assert.deepEqual(snapshot.sourceHashes, expected.sourceHashes); assert.equal(snapshot.today, expected.today);
  assert.equal(snapshot.registrySha256, expected.registrySha256);
  assert.equal(snapshot.profileName, COLD_OPEN_LOOP_PROFILE.name);
  assert.equal(snapshot.schools.length, 2);
  const ids = new Set();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const [index,school] of snapshot.schools.entries()) {
    assert.equal(school.index,index); assert.match(school.id,uuid); assert.match(school.staff,uuid);
    for(const [key,count] of Object.entries({teachers:100,students:500,groups:100,studentSessions:500,devices:500})) {
      assert.equal(school[key].length,count); assert.equal(new Set(school[key]).size,count);
      for(const id of school[key]) {
        assert.match(id,key==='devices'?/^synthetic-scale-[0-9a-f-]{36}$/:uuid);
        assert.ok(!ids.has(id),'Cold fixture identities must stay distinct'); ids.add(id);
      }
    }
    assert.equal(school.email,`scale-${school.staff}@example.test`);
    assert.equal('token' in school,false); assert.equal('deviceTokens' in school,false);
  }
  assert.ok(snapshot.preparation.fixtureCounts.every(row=>Number(row.raw)===1_000_001));
  assert.equal(snapshot.preparation.heavyDeviceBindings.length,2);
  assert.equal(snapshot.preparation.aiDecisionBindings.length,2);
  assert.ok(snapshot.preparation.heavyDeviceBindings.every(row=>row.pairs===500 && row.devices===500 && row.invalid===0));
  assert.ok(snapshot.preparation.aiDecisionBindings.every(row=>row.rows===10_000 && row.invalid===0));
  return snapshot;
}
