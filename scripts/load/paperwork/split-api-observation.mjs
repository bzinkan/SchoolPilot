import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { pool,sessionPool,apiPoolReadiness,startApiPoolReadiness,stopApiPoolReadiness,drainApiPoolReadiness,prewarmMainPool } from '/app/dist/db.js';
import { databasePoolLimits } from '/app/dist/config/databasePools.js';
import { nearestRankPercentile } from './latency-metrics.mjs';
export async function startApiObservation(metrics,{failureFile='/app/evidence/split-metrics.json'}={}){
  const profile=databasePoolLimits();assert.deepEqual(profile,{role:'api',main:16,session:2,scheduler:0,schedulerLock:0});
  assert.equal(pool.options.max,16);assert.equal(sessionPool.options.max,2);metrics.observedPoolCaps={main:pool.options.max,session:sessionPool.options.max};
  metrics.actualCgroupLimits={memoryBytes:Number(readFileSync('/sys/fs/cgroup/memory.max','utf8')),cpuMax:readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim()};
  assert.equal(metrics.actualCgroupLimits.memoryBytes,metrics.limits.memoryBytes);
  const [quota,period]=metrics.actualCgroupLimits.cpuMax.split(' ').map(Number);assert.equal(quota/period,metrics.limits.cpu);
  assert.equal(await prewarmMainPool(),16);
  startApiPoolReadiness(); assert.equal(apiPoolReadiness.status().ready,true);
  const samples=[],errors=[];let pending=null;
  const timer=setInterval(()=>{
    if(!apiPoolReadiness.status().ready){metrics.failure='API_READINESS_LOSS';metrics.apiPoolState=apiPoolReadiness.status();writeFileSync(failureFile,JSON.stringify(metrics,null,2));process.exit(87);}
    if(pending)return;
    const at=performance.now(),waiting=pool.waitingCount;
    pending=(async()=>{const client=await pool.connect();const acquired=performance.now();try{await client.query({text:'SELECT 1',query_timeout:2000});}finally{client.release();}samples.push({acquireMs:acquired-at,queryMs:performance.now()-acquired,waiting,ready:apiPoolReadiness.status().ready});})().catch(error=>errors.push(error.code||error.name)).finally(()=>{pending=null;});
  },1000);
  return {assertReady(){assert.equal(apiPoolReadiness.status().ready,true,'API_READINESS_LOSS');},async stop(){clearInterval(timer);await pending;stopApiPoolReadiness();await drainApiPoolReadiness();const percentile=values=>nearestRankPercentile(values,.95);metrics.apiPoolObservation={profile,samples:samples.length,notReadySamples:samples.filter(x=>!x.ready).length,errors,maxWaiting:Math.max(0,...samples.map(x=>x.waiting)),acquireP95Ms:percentile(samples.map(x=>x.acquireMs)),queryP95Ms:percentile(samples.map(x=>x.queryMs)),method:'Actual startApiPoolReadiness timer and singleton; production API pool profile/prewarm; no HTTP readyz'};metrics.kernelPeakMemoryBytes=Number(readFileSync('/sys/fs/cgroup/memory.peak','utf8'));assert.equal(errors.length,0);assert.equal(metrics.apiPoolObservation.notReadySamples,0);}};
}
