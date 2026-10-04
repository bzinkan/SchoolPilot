import assert from 'node:assert/strict';
import { schoolDayOracle } from '../school-day-profile.mjs';

// The same actual worker and independent database/CSV oracles are used by
// the short Usage campaign and each continuous survival variant.
export async function runHeavyUsageWorkers(worker,fixture) {
  return Promise.all(fixture.schools.map(async school=>{
    const date=new Date(fixture.heavyDate+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+1);
    const offset=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',timeZoneName:'longOffset',hour:'2-digit',hourCycle:'h23'})
      .formatToParts(date).find(part=>part.type==='timeZoneName').value.replace('GMT','');
    const result=await worker.rpc('rollup',{schoolId:school.id,date:fixture.heavyDate,cutoff:`${date.toISOString().slice(0,10)}T00:00:00${offset}`});
    const oracle=schoolDayOracle('school');return{schoolIndex:school.index,...result,
      correct:result.seconds===oracle.monitored&&result.heartbeatCount===oracle.heartbeats&&result.rowCount===oracle.grains};
  }));
}
export async function completeUsageChecks({worker,observer,generator,fixture}) {
  const cutoff=new Date(Math.floor(Date.now()/1000)*1000).toISOString(),rawOracle=await observer.rpc('correctness',{cutoff}),currentWorkers=[];
  for(const school of fixture.schools){
    const expected=rawOracle.schools.find(row=>row.schoolIndex===school.index);
    const result=await worker.rpc('rollup',{schoolId:school.id,date:fixture.today,cutoff});
    currentWorkers.push({schoolIndex:school.index,...result,correct:result.seconds===expected.expectedSeconds&&result.durationMs<=48_000});
  }
  const exports=await generator.rpc('correctness');let correct=currentWorkers.every(row=>row.correct)&&exports.length===8;
  for(const row of exports){
    const school=fixture.schools[row.schoolIndex],seconds=new Map(rawOracle.schools.find(result=>result.schoolIndex===row.schoolIndex).secondsByStudent);
    const ids=school.students.filter((_,n)=>row.scope==='school'||(row.scope==='grade'?n%5===0:row.scope==='class'?n<5:n===0));
    const current=ids.reduce((n,id)=>n+(seconds.get(id)||0),0),expected=fixture.historyDays*90*ids.length+schoolDayOracle(row.scope).monitored+current;
    correct&&=row.report.totals.monitoredBrowserSeconds===expected&&row.report.byDay.find(day=>day.date===fixture.today)?.monitoredBrowserSeconds===current
      &&row.csv.includes(`"Total","","${(expected/60).toFixed(1)}"`);delete row.csv;
  }
  const audit=await observer.rpc('correctness',{audit:true,cutoff}),drain=await worker.rpc('drain'),state=await worker.rpc('snapshot');
  assert.ok(state.database?.acquisitions?.count>0);assert.equal(state.database.acquisitions.failures,0);
  assert.ok(Object.keys(state.database.statements).length>0);assert.ok(Object.values(state.database.statements).every(row=>row.failures===0));
  return{correctness:{passed:correct&&audit.passed===true,rawOracle,currentWorkers,exports,audit},workerDatabase:state.database,drain};
}
