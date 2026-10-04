import test from 'node:test';import assert from 'node:assert/strict';
import {verifyImageProbe,cleanupImageProbe} from './image-probe.mjs';
const name='schoolpilot-role-probe-0123456789ab',imageId='sha256:'+'1'.repeat(64),config='sha256:'+'2'.repeat(64),id='3'.repeat(64);
const image={RootFS:{Layers:['layer']},Config:{Labels:{revision:'source'}}};
const good=()=>({Id:id,Name:'/'+name,Image:config,Config:{Image:imageId,Labels:{'codex.usage-role-build':name}}});
test('uncertain create recovers only the exact uniquely labelled image and removes it',async()=>{
  let found=good();const files={},removed=[];await cleanupImageProbe({name,find:async()=>found,verify:x=>verifyImageProbe(x,{name,imageId,image},async()=>image),remove:async x=>{removed.push(x);found=null;},save:(n,x)=>files[n]=x});
  assert.deepEqual(removed,[id]);assert.equal(files['runtime-probe-create-recovery.json'].createOutcome,'unconfirmed');assert.equal(files['runtime-probe-cleanup.json'].cleanupPassed,true);
});
for(const mutation of['name','label','requestedImage','actualImage','remove'])test('uncertain probe cleanup fails closed for '+mutation,async()=>{
  const found=good(),files={};let removed=0;if(mutation==='name')found.Name='/other';if(mutation==='label')found.Config.Labels['codex.usage-role-build']='other';if(mutation==='requestedImage')found.Config.Image=config;
  await assert.rejects(()=>cleanupImageProbe({name,find:async()=>found,verify:x=>verifyImageProbe(x,{name,imageId,image},async()=>mutation==='actualImage'?{...image,RootFS:{Layers:['other']}}:image),remove:async()=>{removed++;throw Error('remove');},save:(n,x)=>files[n]=x}));
  assert.equal(removed,mutation==='remove'?1:0);assert.equal(files['runtime-probe-cleanup.json'].cleanupPassed,false);
});
