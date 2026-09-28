import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeApiEvidence } from '../scripts/load/paperwork/finalize-api-evidence.mjs';
const expected = { imageDigest: `sha256:${'a'.repeat(64)}`, revision: 'b'.repeat(40), cpu: 1, memoryBytes: 2 * 1024 ** 3 };
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'schoolpilot-api-evidence-unit-'));
  const files = ['split-api-server.mjs', 'api-server-contract.mjs', 'physical-object-store.mjs'];
  for (const file of files) writeFileSync(join(directory, file), '// Synthetic offline contract fixture: ' + file);
  writeFileSync(join(directory, 'finalize-api-evidence.mjs'), readFileSync(new URL('../scripts/load/paperwork/finalize-api-evidence.mjs',import.meta.url)));
  const path = '/api/classpilot/groups';
  const api = { role: 'api', serverId: 'offline-server', imageDigest: expected.imageDigest, sourceRevision: expected.revision,
    limits:{cpu:1,memoryBytes:expected.memoryBytes},actualCgroupLimits:{cpuMax:'100000 100000',memoryBytes:expected.memoryBytes},
    observedPoolCaps:{main:16,session:2},failure:null,memorySamples:10,peakCgroupMemoryBytes:500000000,peakRssBytes:400000000,kernelPeakMemoryBytes:510000000,
    apiPoolObservation:{notReadySamples:0,errors:[],profile:{role:'api',main:16,session:2,scheduler:0,schedulerLock:0}},
    serverProbeEvidence:{version:1,role:'api',serverId:'offline-server',header:'x-capacity-probe-id',maxSamples:4096,invalid:false,samples:[{id:1,path,method:'GET',status:200,durationMs:10,completed:true}]},
    serverSourceSha256:sha(readFileSync(join(directory,files[0]))),contractSourceSha256:sha(readFileSync(join(directory,files[1]))),storageSourceSha256:sha(readFileSync(join(directory,files[2]))) };
  const driver={topologyVersion:3,measurementHost:'separate_load_driver',imageDigest:expected.imageDigest,sourceRevision:expected.revision,apiServerMetrics:{serverId:api.serverId},readProbeEvidence:{samples:[{id:1,path,status:200,durationMs:12,phase:'baseline'}]}};
  const save = () => {writeFileSync(join(directory,'split-api-server-metrics.json'),JSON.stringify(api));writeFileSync(join(directory,'split-metrics.json'),JSON.stringify(driver));};
  try { save();run({directory,api,driver,save}); } finally { rmSync(directory,{recursive:true,force:true}); }
}
test('final API report is independently bound without modifying original reports',()=>fixture(({directory})=>{
  const before=['split-api-server-metrics.json','split-metrics.json'].map(file=>readFileSync(join(directory,file),'utf8'));
  const result=finalizeApiEvidence(directory,expected);assert.equal(result.accepted,true);assert.equal(result.matchedProbeCount,1);assert.equal(result.finalKernelPeakMemoryBytes,510000000);
  assert.deepEqual(['split-api-server-metrics.json','split-metrics.json'].map(file=>readFileSync(join(directory,file),'utf8')),before);
}));
for(const [name,change] of [
  ['API identity',({api})=>api.serverId='other'],['revision',({api})=>api.sourceRevision='c'.repeat(40)],
  ['driver revision',({driver})=>driver.sourceRevision='c'.repeat(40)],['driver colocated',({driver})=>driver.measurementHost='api_process'],
  ['API CPU',({api})=>api.actualCgroupLimits.cpuMax='200000 100000'],['API memory',({api})=>api.actualCgroupLimits.memoryBytes/=2],
  ['server bytes',({directory})=>writeFileSync(join(directory,'split-api-server.mjs'),'changed')],
  ['contract bytes',({directory})=>writeFileSync(join(directory,'api-server-contract.mjs'),'changed')],
  ['store bytes',({directory})=>writeFileSync(join(directory,'physical-object-store.mjs'),'changed')],
  ['finalizer bytes',({directory})=>writeFileSync(join(directory,'finalize-api-evidence.mjs'),'changed')],
  ['final peak',({api})=>api.kernelPeakMemoryBytes=Math.ceil(expected.memoryBytes*.70)],
  ['observed peak',({api})=>api.peakCgroupMemoryBytes=Math.ceil(expected.memoryBytes*.70)],
  ['readiness',({api})=>api.apiPoolObservation.notReadySamples=1],['failure',({api})=>api.failure='API_FAILED'],
  ['probe ID',({driver})=>driver.readProbeEvidence.samples[0].id=2],
  ['incomplete probe',({api})=>api.serverProbeEvidence.samples[0].completed=false],
  ['missing probe',({api})=>api.serverProbeEvidence.samples=[]],
]) test(`final API validation rejects changed ${name}`,()=>fixture(value=>{change(value);value.save();assert.throws(()=>finalizeApiEvidence(value.directory,expected));}));
