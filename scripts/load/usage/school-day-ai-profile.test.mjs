import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHOOL_DAY_PROFILE, schoolDayObservation } from './school-day-profile.mjs';
import { SCHOOL_DAY_AI_PROFILE, schoolDayAiDecisionSamples } from './school-day-ai-profile.mjs';

test('nonempty AI scenario retains the school-day workload and binds exactly twenty matching decisions per student', () => {
  const samples = schoolDayAiDecisionSamples();
  assert.deepEqual(samples, [0,100,200,300,400,500,600,700,800,900,1000,1100,1200,1300,1400,1500,1600,1700,1800,1900]);
  assert.equal(samples.length * SCHOOL_DAY_PROFILE.students, 10_000);
  assert.notEqual(SCHOOL_DAY_AI_PROFILE.name, SCHOOL_DAY_PROFILE.name);
  for (const [key,value] of Object.entries(SCHOOL_DAY_PROFILE)) if (key !== 'name') assert.equal(SCHOOL_DAY_AI_PROFILE[key], value);
  const observations = new Set();
  for (let student = 0; student < 500; student++) for (const sample of samples) {
    const observation = schoolDayObservation(student,sample);
    assert.equal(observation.classification, 'educational');
    assert.ok(observation.seconds >= 0 && observation.seconds < 24*3600);
    observations.add(`${student}/${sample}`);
  }
  assert.equal(observations.size,10_000);
  assert.equal(schoolDayObservation(0,samples[1]).seconds-schoolDayObservation(0,samples[0]).seconds,1_000);
});
