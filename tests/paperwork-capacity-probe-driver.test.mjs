import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadProbeEvidence, measureReadProbe, recordReadProbe } from '../scripts/load/paperwork/latency-metrics.mjs';
import { matchServerReadProbes } from '../scripts/load/paperwork/api-server-contract.mjs';

test('driver records its explicit probe identity without replacing full-request duration', async () => {
  const evidence=createReadProbeEvidence(); let tick=0;
  await measureReadProbe(evidence,{id:42,path:'/api/mydesk/capabilities',phase:'baseline'},
    async()=>({status:200}),{now:()=>tick++*10,originMs:0});
  assert.deepEqual(evidence.samples,[{id:42,path:'/api/mydesk/capabilities',phase:'baseline',startedAtMs:0,durationMs:10,status:200}]);
  const matched=matchServerReadProbes(evidence.samples,{version:1,role:'api',serverId:'server',header:'x-capacity-probe-id',maxSamples:4096,invalid:false,
    samples:[{id:42,path:'/api/mydesk/capabilities',method:'GET',status:200,durationMs:7,completed:true}]});
  assert.equal(matched[0].clientMs,10); assert.equal(matched[0].serverMs,7); assert.equal(matched[0].clientMinusServerMs,3);
});

test('driver rejects invalid optional probe identity while preserving legacy metadata support', () => {
  const evidence=createReadProbeEvidence();
  const sample={path:'/api/mydesk/capabilities',phase:'baseline',startedAtMs:0,durationMs:1,status:200};
  for (const id of [0,-1,4097,1.5,'42']) assert.throws(()=>recordReadProbe(evidence,{...sample,id}),/INVALID_LATENCY_SAMPLE/);
  recordReadProbe(evidence,sample); assert.equal('id' in evidence.samples[0],false);
});

test('failed driver requests retain probe identity and cannot match a successful server result', async () => {
  const evidence=createReadProbeEvidence(); let tick=0;
  await assert.rejects(measureReadProbe(evidence,{id:1,path:'/api/classpilot/groups',phase:'preparing'},
    async()=>{throw new Error('connection interrupted');},{now:()=>tick++*10,originMs:0}));
  assert.equal(evidence.samples[0].id,1); assert.equal(evidence.samples[0].status,null);
  assert.throws(()=>matchServerReadProbes(evidence.samples,{version:1,role:'api',header:'x-capacity-probe-id',maxSamples:4096,invalid:false,
    samples:[{id:1,path:'/api/classpilot/groups',method:'GET',status:200,durationMs:7,completed:true}]}));
});
