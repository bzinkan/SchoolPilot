import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCHOOL_DAY_PROFILE, schoolDaySessionRoster, schoolDayObservation, schoolDayOracle, schoolDayRangeDomains } from './school-day-profile.mjs';

test('school day matches ten-second cadence and one million unique observations without duplicates', () => {
  assert.equal(SCHOOL_DAY_PROFILE.students * SCHOOL_DAY_PROFILE.observationsPerStudent, 1_000_000);
  assert.equal(SCHOOL_DAY_PROFILE.cadenceSeconds, 10);
  assert.deepEqual([schoolDayObservation(0, 0).seconds, schoolDayObservation(0, 1999).seconds], [0, 19990]);
  assert.equal(schoolDayObservation(0, 1999).attributedSeconds, 15);
});

test('six frozen lessons rotate cohorts and leave passing windows unattributed', () => {
  assert.deepEqual(schoolDaySessionRoster(0, 0), [0,1,2,3,4]);
  assert.deepEqual(schoolDaySessionRoster(0, 1), [495,496,497,498,499]);
  assert.equal(schoolDayObservation(0, 299).classIndex, 0);
  assert.equal(schoolDayObservation(0, 300).classIndex, null);
  assert.equal(schoolDayObservation(0, 359).classIndex, null);
  assert.equal(schoolDayObservation(0, 360).classIndex, 1);
  for (let period = 0; period < 6; period++) {
    const members = Array.from({ length:100 }, (_, group) => schoolDaySessionRoster(group, period)).flat();
    assert.equal(new Set(members).size, 500);
    for (let group = 0; group < 100; group++) for (const student of schoolDaySessionRoster(group, period)) assert.equal(schoolDayObservation(student, period * 360).classIndex, group);
  }
});

test('domain dwell is three minutes twenty seconds with eight domains per student and two hundred per school', () => {
  const first = schoolDayObservation(0, 0).domain;
  assert.equal(schoolDayObservation(0, 19).domain, first);
  assert.notEqual(schoolDayObservation(0, 20).domain, first);
  assert.equal(new Set(Array.from({ length:2000 }, (_, n) => schoolDayObservation(0,n).domain)).size, 8);
  assert.equal(new Set(Array.from({ length:500 }, (_, student) => Array.from({ length:8 }, (_, domain) => schoolDayObservation(student,domain*20).domain)).flat()).size, 200);
});

test('independent school/grade/student totals and class rotations retain all categories and passing time', () => {
  for (const [scope, expected] of [
    ['school', [10002500,5002500,2500000,2500000,1000000,500,84000]],
    ['grade', [2000500,1000500,500000,500000,200000,100,16800]],
    ['class', [85025,42525,21250,21250,8500,30,720]],
    ['student', [20005,10005,5000,5000,2000,1,168]],
  ]) {
    const result = schoolDayOracle(scope);
    assert.deepEqual([result.monitored,result.instructional,result.offTask,result.unknown,result.heartbeats,result.students,result.grains], expected);
    assert.equal(result.monitored, result.instructional + result.offTask + result.unknown);
  }
});

test('ranked range domains use independent history totals, exact ASCII ties and do not mutate heavy oracle', () => {
  const oracle = schoolDayOracle('school'), before = [...oracle.domains.educational];
  const without = schoolDayRangeDomains('school',361,false,oracle);
  assert.deepEqual(without.educational[0], {domain:'history-0.example.test',seconds:32490});
  assert.equal(without.educational[1].domain, 'history-1.example.test');
  assert.equal(without.educational[2].domain, 'history-10.example.test');
  const withHeavy = schoolDayRangeDomains('school',361,true,oracle);
  assert.equal(withHeavy.educational.length,10);
  assert.deepEqual([...oracle.domains.educational], before);
  const again = schoolDayRangeDomains('school',361,true,oracle);
  assert.deepEqual(again,withHeavy);
});

test('separate harness keeps exact raw/cardinality gates, independent categories/domains and full original acceptance', () => {
  const script = readFileSync(new URL('./local-school-day-scale.mjs',import.meta.url),'utf8');
  assert.match(script,/generate_series\(0,1999\)/);
  assert.doesNotMatch(script,/CROSS JOIN generate_series\(0,1\) duplicate/);
  assert.match(script,/schoolDaySessionRoster/);
  assert.match(script,/result\.rowCount, heavyOracles\.school\.grains/);
  for (const gate of ['367-day','currentDayRawOracle','csvStrictAuditRecorded','crossSchoolIdsDenied','gapWithheld','expiredDateWithheld','Promise.allSettled','actualHttpIngest','successfulEmptyDay','heavyDayAtomicity']) assert.ok(script.includes(gate),gate);
});
