import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {hash} from './contracts.mjs';

export function checkLowerStaffRows(rows,fixture,profile){
  const school=fixture.schools[0],foreign=fixture.schools[1],spec=profile.lowerStaffReads;
  assert.equal(rows.length,spec.ownSessionReads+spec.foreignSessionDenials);
  for(let wave=0;wave<spec.waveOffsetsMs.length;wave++)for(const kind of ['own','foreign']){
    const matches=rows.filter(row=>row.wave===wave&&row.kind===kind);assert.equal(matches.length,1);
    const row=matches[0];assert.equal(row.targetIndex,0);assert.equal(row.scheduledOffsetMs,spec.waveOffsetsMs[wave]);
    assert.ok(row.offeredOffsetMs>=row.scheduledOffsetMs&&row.offeredOffsetMs<profile.offering.durationMs);
    assert.ok(row.offeredOffsetMs-row.scheduledOffsetMs<=profile.offering.maxOfferLatenessMs);
    assert.ok(Number.isFinite(row.durationMs)&&row.durationMs>=0&&row.durationMs<=spec.requestTimeoutMs);
    if(kind==='own'){
      assert.equal(row.status,200);const session=row.body.session;
      assert.equal(session.id,school.currentSession);assert.equal(session.schoolId,school.id);
      assert.equal(session.groupId,school.groups[0]);assert.equal(session.teacherId,school.teachers[0]);
      assert.equal(session.endTime,null);assert.equal(session.lifecycle.state,'active');
      if(row.body.settings!==undefined)assert.ok(row.body.settings!==null&&typeof row.body.settings==='object');
      assert.ok(!JSON.stringify(row.body).includes(foreign.id));assert.ok(!JSON.stringify(row.body).includes(foreign.currentSession));
    }else{assert.equal(row.status,404);assert.deepEqual(row.body,{error:'Session not found'});}
  }
  return{passed:true,ownSessionReads:spec.ownSessionReads,foreignSessionDenials:spec.foreignSessionDenials,
    sameApi:true,schoolIndex:0,offered:rows.length,bodyProofSha256:hash(JSON.stringify(rows))};
}
export async function createLowerStaffReader(fixture,profile,{fetchFn=fetch,now=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  assert.equal(profile.lowerLoadEnvelope,true);assert.equal(profile.offering.schoolDevices[1],0);
  const base=fixture.apiBases[0],school=fixture.schools[0];
  async function request(path,{body,cookie,signal}={}){
    const response=await fetchFn(base+path,{method:body===undefined?'GET':'POST',signal:signal??AbortSignal.timeout(profile.lowerStaffReads.requestTimeoutMs),
      headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),'X-School-Id':school.id},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return{status:response.status,body:await response.json(),cookie:response.headers.getSetCookie().map(row=>row.split(';')[0]).join('; ')};
  }
  const login=await request('/api/auth/login',{body:{email:`scale-${school.teachers[0]}@example.test`,password:fixture.password}});
  assert.equal(login.status,200);assert.ok(login.cookie.includes('schoolpilot.sid='));
  const csrf=await request('/api/auth/csrf',{cookie:login.cookie});assert.equal(csrf.status,200);assert.equal(typeof csrf.body.csrfToken,'string');
  return async startsAtMs=>{
    assert.ok(Number.isFinite(startsAtMs));const epoch=now()+startsAtMs-Date.now(),rows=[];
    await Promise.all(profile.lowerStaffReads.waveOffsetsMs.map(async(scheduledOffsetMs,wave)=>{
      while(now()<epoch+scheduledOffsetMs)await sleep(Math.max(1,epoch+scheduledOffsetMs-now()));
      await Promise.all(['own','foreign'].map(async kind=>{
        const offeredAt=now(),id=fixture.schools[kind==='own'?0:1].currentSession;
        try{const response=await request('/api/classpilot/teaching-sessions/'+id,{cookie:login.cookie});
          rows.push({wave,kind,targetIndex:0,scheduledOffsetMs,offeredOffsetMs:offeredAt-epoch,durationMs:now()-offeredAt,status:response.status,body:response.body});
        }catch{rows.push({wave,kind,targetIndex:0,scheduledOffsetMs,offeredOffsetMs:offeredAt-epoch,durationMs:now()-offeredAt,status:0,body:{},error:'LOWER_STAFF_TRANSPORT_FAILED'});}
      }));
    }));
    rows.sort((a,b)=>a.wave-b.wave||a.kind.localeCompare(b.kind));let summary;
    try{summary=checkLowerStaffRows(rows,fixture,profile);}catch{summary={passed:false,error:'LOWER_STAFF_ORACLE_FAILED',offered:rows.length};}
    return{rows,summary};
  };
}
