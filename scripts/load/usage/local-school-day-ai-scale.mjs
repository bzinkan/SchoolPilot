import { runSchoolDayScale } from './local-school-day-scale.mjs';

await runSchoolDayScale({ aiScenario: true }).catch(error => {
  console.error(JSON.stringify({ event: 'local_school_day_ai_scale_failed', name: error.name, code: error.code || 'SCALE_ASSERTION', message: error.message }));
  process.exitCode = 1;
});
