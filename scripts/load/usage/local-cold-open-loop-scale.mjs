import assert from 'node:assert/strict';
import { runSchoolDayScale } from './local-school-day-scale.mjs';

assert.ok(['prepare','measure'].includes(process.env.USAGE_SCALE_COLD_PHASE));
await runSchoolDayScale({ aiScenario:true, openLoop:true, coldPhase:process.env.USAGE_SCALE_COLD_PHASE }).catch(error=>{
  console.error(JSON.stringify({event:'local_school_day_cold_open_loop_failed',name:error.name,code:error.code||'SCALE_ASSERTION',message:error.message}));
  process.exitCode=1;
});
