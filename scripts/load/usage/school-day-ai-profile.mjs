import { SCHOOL_DAY_PROFILE } from './school-day-profile.mjs';

// A separately named scenario forces the nonempty newest-decision lookup.
// Matching categories preserve the existing independently computed 84k grains.
export const SCHOOL_DAY_AI_PROFILE = Object.freeze({
  ...SCHOOL_DAY_PROFILE,
  name: 'six-lessons-200-domains-1m-unique-10k-ai',
  aiDecisionRowsPerSchool: 10_000,
  aiDecisionsPerStudent: 20,
  aiDecisionEveryObservations: 100,
  aiDecisionCadenceSeconds: 1_000,
  aiDecisionCategory: 'matches the selected heartbeat',
});

export function schoolDayAiDecisionSamples() {
  return Array.from({ length: 20 }, (_, index) => index * 100);
}
