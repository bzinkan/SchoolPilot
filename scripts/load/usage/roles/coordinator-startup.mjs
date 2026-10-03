import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {finished} from 'node:stream/promises';
export async function runStartup(owners,{write=value=>writeFileSync('/evidence/usage-scale.json',JSON.stringify(value,null,2)+'\n')}={}){
 const children=[],result={schemaVersion:1,mode:'startup',prototypeStartupPassed:false,resourceAcceptance:false,capacityAccepted:false,heartbeatOffers:0,reportOffers:0,workerRollups:0};
 try{
  owners.captureCoordinatorResources('before');
  for(const role of ['api','worker','generator'])children.push(await owners.child(role,role==='generator'?'release-enabled-generator.mjs':'release-enabled-process.mjs',{SCHEDULER_ENABLED:role==='worker'?'true':'false',USAGE_RELEASE_ROLE:role}));
  const[api,worker,generator]=await Promise.all(children.map(owner=>owner.ready));assert.deepEqual(api.pools,{api:16,session:2});assert.deepEqual(worker.pools,{worker:5});assert.equal(api.readiness,true);assert.equal(api.redis,true);
  result.readiness={api,worker,generator};const drains=await Promise.all([children[0].rpc('quiesce'),children[1].rpc('quiesce')]);assert.ok(drains.every(row=>row.complete===true));result.drains=drains;
  result.prototypeStartupPassed=true;
 }catch{result.failure='ROLE_STARTUP_PROOF_FAILED';process.exitCode=1;}
 finally{
  for(const owner of [...children].reverse()){
   if(owner.process.exitCode===null&&owner.process.connected){try{await owner.rpc('shutdown',undefined,15000);}catch{result.prototypeStartupPassed=false;process.exitCode=1;owner.process.kill('SIGTERM');}}
   const watchdog=setTimeout(()=>{result.prototypeStartupPassed=false;process.exitCode=1;owner.process.kill('SIGKILL');},15000);
   const exit=await owner.closed;clearTimeout(watchdog);await finished(owner.stdout);if(exit.code!==0){result.prototypeStartupPassed=false;process.exitCode=1;}
  }
  owners.captureCoordinatorResources('after');write(result);
 }
 return result;
}
