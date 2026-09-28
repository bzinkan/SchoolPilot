import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { assertApiServerMetrics, createServerProbeEvidence, createServerProbeRecorder,
  matchServerReadProbes, setApiProbeResponseHeaders } from '../scripts/load/paperwork/api-server-contract.mjs';
const path = '/api/classpilot/groups', id = 'server-one';
const expected = { serverId: id, imageDigest: `sha256:${'a'.repeat(64)}`, cpu: 1, memoryBytes: 2 * 1024 ** 3 };
const resource = () => ({ role: 'api', serverId: id, imageDigest: expected.imageDigest, limits: {cpu:1,memoryBytes:expected.memoryBytes},
  actualCgroupLimits: {memoryBytes:expected.memoryBytes,cpuMax:'100000 100000'}, observedPoolCaps:{main:16,session:2},
  memorySamples:5,peakCgroupMemoryBytes:1000,peakRssBytes:900,kernelPeakMemoryBytes:1100,failure:null,
  serverProbeEvidence:createServerProbeEvidence(id), apiPoolObservation:{notReadySamples:0,errors:[],profile:{role:'api',main:16,session:2,scheduler:0,schedulerLock:0}} });
const res = () => Object.assign(new EventEmitter(), {statusCode:200,headers:{},setHeader(key,value){this.headers[key]=value;}});
const req = (value='1',url=path,method='GET') => ({headers:value===undefined?{}:{'x-capacity-probe-id':value},url,method});
function paired() {
  const evidence=createServerProbeEvidence(id); let now=10; const record=createServerProbeRecorder(evidence,{now:()=>now});
  const response=res(); record(req(),response); now=13;response.emit('finish');
  return {evidence,client:[{id:1,path,status:200,phase:'baseline',durationMs:4}]};
}
test('API resource acceptance binds process role, identity, actual cgroup and pool limits',()=>{
  assert.equal(assertApiServerMetrics(resource(),expected).role,'api');
  const changes=[m=>m.role='driver',m=>m.serverId='different',m=>m.imageDigest=`sha256:${'b'.repeat(64)}`,
    m=>m.actualCgroupLimits.cpuMax='200000 100000',m=>m.actualCgroupLimits.memoryBytes/=2,
    m=>m.limits.cpu=2,m=>m.observedPoolCaps.main=2,m=>m.memorySamples=0,m=>m.peakRssBytes=NaN,
    m=>m.kernelPeakMemoryBytes=0,m=>m.failure='API_READINESS_LOSS',m=>m.serverProbeEvidence.serverId='driver',
    m=>m.apiPoolObservation.errors.push('failure'),m=>m.apiPoolObservation.profile.role='worker'];
  for(const change of changes){const m=resource();change(m);assert.throws(()=>assertApiServerMetrics(m,expected));}
});
test('server probe IDs match independent client timing without substituting server duration',()=>{
  const {client,evidence}=paired();assert.deepEqual(matchServerReadProbes(client,evidence),[{id:1,path,phase:'baseline',clientMs:4,serverMs:3,clientMinusServerMs:1}]);
});
test('probe observations cannot silently omit, duplicate, invent or remap requests',()=>{
  const changes=[p=>p.client[0].id=2,p=>p.client[0].path='/api/mydesk/capabilities',p=>p.client[0].status=500,
    p=>p.evidence.samples[0].completed=false,p=>p.evidence.samples[0].durationMs=NaN,
    p=>p.evidence.samples[0].method='POST',p=>p.evidence.samples.push({...p.evidence.samples[0]}),
    p=>p.evidence.samples[0].path='/other',p=>p.evidence.invalid=true,p=>p.evidence.samples=[],
    p=>{p.client.push({...p.client[0]});p.evidence.samples.push({...p.evidence.samples[0],id:2});}];
  for(const change of changes){const p=paired();change(p);assert.throws(()=>matchServerReadProbes(p.client,p.evidence));}
});
test('recorder keeps only permitted metadata and records finish once',()=>{
  const evidence=createServerProbeEvidence(id);let now=3;const record=createServerProbeRecorder(evidence,{now:()=>now});
  const response=res();record({...req('1',path+'?secret=never'),body:'private',headers:{...req().headers,authorization:'secret'}},response);
  now=5;response.emit('finish');now=8;response.emit('close');
  assert.deepEqual(evidence.samples,[{id:1,path,method:'GET',status:200,durationMs:2,completed:true}]);
  assert.ok(!JSON.stringify(evidence).includes('secret'));assert.ok(!JSON.stringify(evidence).includes('private'));
});
test('unfinished and aborted responses cannot appear as successful completed probes',()=>{
  const evidence=createServerProbeEvidence(id),record=createServerProbeRecorder(evidence),response=res();record(req(),response);response.emit('close');
  assert.equal(evidence.samples[0].completed,false);assert.throws(()=>matchServerReadProbes([{id:1,path,status:200,durationMs:3}],evidence));
});
test('invalid IDs and wrong paths fail closed and poison evidence',()=>{
  for(const request of [req('0'),req('-1'),req('4097'),req('1.5'),req(['1']),req('1','/other'),req('1',path,'POST')]){
    const evidence=createServerProbeEvidence(id),failures=[];const record=createServerProbeRecorder(evidence,{onFailure:c=>failures.push(c)});
    assert.throws(()=>record(request,res()),/INVALID_API_PROBE/);assert.equal(evidence.invalid,true);assert.deepEqual(failures,['INVALID_API_PROBE']);
  }
});
test('duplicate and over-bound observations cannot evade count limits',()=>{
  const evidence=createServerProbeEvidence(id),record=createServerProbeRecorder(evidence);record(req(),res());assert.throws(()=>record(req(),res()));
  const full=createServerProbeEvidence(id);full.samples=Array.from({length:4096},()=>({}));assert.throws(()=>createServerProbeRecorder(full)(req('2'),res()));
});
test('unmarked requests are unobserved and never add measurement rows',()=>{
  const evidence=createServerProbeEvidence(id);createServerProbeRecorder(evidence)({headers:{},url:'/api/mydesk/imports',method:'POST'},res());assert.deepEqual(evidence.samples,[]);
});
test('probe ready header is emitted only after live server readiness succeeds',()=>{
  const response=res();let called=0;setApiProbeResponseHeaders(req(),response,{serverId:id,assertReady(){called++;}});
  assert.equal(called,1);assert.deepEqual(response.headers,{'x-capacity-server-id':id,'x-capacity-api-ready':'1'});
  const failed=res();assert.throws(()=>setApiProbeResponseHeaders(req(),failed,{serverId:id,assertReady(){throw Error('not ready');}}));
  assert.equal(failed.headers['x-capacity-api-ready'],undefined);
  const ordinary=res();setApiProbeResponseHeaders({headers:{}},ordinary,{serverId:id,assertReady(){throw Error('not used');}});assert.equal(ordinary.headers['x-capacity-api-ready'],undefined);
});
