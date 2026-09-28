import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pool, apiPoolReadiness } from '/app/dist/db.js';
import { schedulerPool, schedulerLockPool } from '/app/dist/services/schedulerDb.js';
import { expireClasspilotEvidenceCaptureRequests, runWithSchedulerLock } from '/app/dist/services/scheduler.js';
import { runStaffIdentityIntegrityScan } from '/app/dist/services/staffIdentityMonitoring.js';

export function startSchedulerOverlap({ fixturePool, actor, metrics }) {
  let phase='baseline', stopped=false, integrityDone=false;
  const pending=new Set(), probes=[], jobs=[], heartbeat=[], errors=[];
  const observedStart=performance.now();
  const progress=()=>apiPoolReadiness.recordProgress();
  apiPoolReadiness.start();
  for(const event of ['acquire','release','remove']) pool.on(event,progress);
  const counts=()=>({main:{total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount},scheduler:{total:schedulerPool.totalCount,idle:schedulerPool.idleCount,waiting:schedulerPool.waitingCount},locks:{total:schedulerLockPool.totalCount,idle:schedulerLockPool.idleCount,waiting:schedulerLockPool.waitingCount}});
  const track=promise=>{ pending.add(promise); void promise.catch(error=>errors.push({code:error.code||error.name||'Error'})).finally(()=>pending.delete(promise)); };
  let tick=0, probeBusy=false;
  const probeTimer=setInterval(()=>{
    const expected=observedStart+(++tick)*1000;
    heartbeat.push({phase,delayMs:Math.max(0,performance.now()-expected)});
    if(probeBusy) { errors.push({code:'PROBE_OVERLAP'}); return; }
    probeBusy=true;
    track((async()=>{
      const at=performance.now(), before=counts();
      const main=performance.now(); const client=await pool.connect(); const acquired=performance.now();
      try { await client.query({text:'SELECT 1',query_timeout:2000}); } finally { client.release(); }
      const mainEnd=performance.now();
      const scheduler=performance.now(); await schedulerPool.query({text:'SELECT 1',query_timeout:2000});
      const schedulerEnd=performance.now();
      await apiPoolReadiness.sample();
      probes.push({phase,atMs:at-observedStart,mainAcquireMs:acquired-main,mainQueryMs:mainEnd-acquired,schedulerQueryMs:schedulerEnd-scheduler,counts:before,readiness:apiPoolReadiness.status()});
    })().finally(()=>{probeBusy=false;}));
  },1000);
  let due=observedStart+10000, scheduledTimer;
  const tickJobs=()=>{
    if(stopped) return;
    const scheduledFor=due; due+=60000;
    scheduledTimer=setTimeout(tickJobs,Math.max(0,due-performance.now()));
    track((async()=>{
      const currentPhase=phase, started=performance.now();
      const ids=Array.from({length:100},()=>randomUUID());
      await fixturePool.query(`INSERT INTO classpilot_evidence_capture_requests
        (id,school_id,student_id,student_session_id,device_id,heartbeat_id,tab_ref,tab_snapshot_revision,expected_url_digest,requested_at,expires_at)
        SELECT unnest($1::text[]),$2,$3,$4,$5,$6,'synthetic-tab',1,repeat('a',64),now()-interval '2 minutes',now()-interval '1 minute'`,[ids,actor.schoolId,actor.studentId,randomUUID(),randomUUID(),randomUUID()]);
      const locked=await runWithSchedulerLock('expireClasspilotEvidenceCaptureRequests',expireClasspilotEvidenceCaptureRequests);
      assert.equal(locked.acquired,true);
      const proof=await fixturePool.query(`SELECT count(*)::int count FROM classpilot_evidence_capture_requests r JOIN evidence_artifacts a ON a.id=r.artifact_id WHERE r.id=ANY($1::text[]) AND r.status='expired' AND a.status='unavailable' AND a.metadata->>'unavailableReason'='expired'`,[ids]);
      assert.equal(proof.rows[0].count,100);
      jobs.push({job:'expireClasspilotEvidenceCaptureRequests',phase:currentPhase,dueAtMs:scheduledFor-observedStart,startDelayMs:started-scheduledFor,durationMs:performance.now()-started,rowsExpired:proof.rows[0].count,lockAcquired:locked.acquired});
      if(phase==='loaded'&&!integrityDone) {
        integrityDone=true;
        const scanStart=performance.now();
        const scan=await runWithSchedulerLock('staffIdentityIntegrityScan',runStaffIdentityIntegrityScan);
        assert.equal(scan.acquired,true); assert.equal(scan.result.status,'completed'); assert.equal(scan.result.scanFailures,0); assert.equal(scan.result.schoolsScanned,2);
        jobs.push({job:'staffIdentityIntegrityScan',phase:'loaded',durationMs:performance.now()-scanStart,lockAcquired:true,summary:scan.result});
      }
    })());
  };
  scheduledTimer=setTimeout(tickJobs,10000);
  return {
    setPhase(value){phase=value;},
    async stop(){
      stopped=true; clearInterval(probeTimer); clearTimeout(scheduledTimer); await Promise.allSettled([...pending]);
      apiPoolReadiness.stop(); await apiPoolReadiness.drain();
      for(const event of ['acquire','release','remove']) pool.off(event,progress);
      const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {count:sorted.length,p50Ms:sorted[Math.floor(sorted.length*.5)]??null,p95Ms:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??null,maxMs:sorted.at(-1)??null};};
      let peak=null; try { peak=Number(readFileSync('/sys/fs/cgroup/memory.peak','utf8').trim()); } catch {}
      metrics.schedulerOverlap={durationMs:performance.now()-observedStart,mode:'actual exported callbacks and advisory locks; bounded harness cadence; no startScheduler/worker/index',jobs,errors,readiness:{samples:probes.length,notReadySamples:probes.filter(x=>!x.readiness.ready).length,method:'actual apiPoolReadiness singleton sampled manually with production progress hooks; worker pool profile; no HTTP readyz'},maxPoolWaiting:{main:Math.max(0,...probes.map(x=>x.counts.main.waiting)),scheduler:Math.max(0,...probes.map(x=>x.counts.scheduler.waiting)),locks:Math.max(0,...probes.map(x=>x.counts.locks.waiting))},heartbeat:{method:'harness one-second timer lag, not worker Heartbeat emission',baseline:summary(heartbeat.filter(x=>x.phase==='baseline').map(x=>x.delayMs)),loaded:summary(heartbeat.filter(x=>x.phase==='loaded').map(x=>x.delayMs))},database:Object.fromEntries(['baseline','loaded'].map(p=>[p,{mainAcquire:summary(probes.filter(x=>x.phase===p).map(x=>x.mainAcquireMs)),mainQuery:summary(probes.filter(x=>x.phase===p).map(x=>x.mainQueryMs)),schedulerQuery:summary(probes.filter(x=>x.phase===p).map(x=>x.schedulerQueryMs))}])),kernelPeakMemoryBytes:peak,limits:['Only evidence-capture expiry and one staff-identity scan are covered; no full scheduler fleet or heavy rollups/email/Google/Redis jobs.','Synthetic due-row volume and two-school database are not production fleet scale.']};
      assert.equal(errors.length,0,JSON.stringify(errors));
      assert.equal(metrics.schedulerOverlap.readiness.notReadySamples,0);
      assert.ok(jobs.filter(x=>x.job==='expireClasspilotEvidenceCaptureRequests'&&x.phase==='loaded').length>=2);
      assert.equal(integrityDone,true);
      // The paperwork scheduler refills every five seconds. A full missed cadence is a failure here.
      metrics.schedulerOverlap.delayLimitMs=5000;
      metrics.schedulerOverlap.withinDelayLimit=heartbeat.every(row=>row.delayMs<5000)
        && jobs.every(row=>row.startDelayMs===undefined || row.startDelayMs<5000);
      assert.equal(metrics.schedulerOverlap.withinDelayLimit,true,'SCHEDULER_DELAY_LIMIT');
    }
  };
}
