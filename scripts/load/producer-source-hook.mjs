// Concrete PRIVATE producer seam: records the exact generated 40KiB JPEG
// synchronously before the unchanged device POST. No JPEG/frame queue exists.
import assert from 'node:assert/strict';
import {createGeneratedSourceLedger,createRetainedSourcePublisher,validateSourceContext} from './producer-source-ledger.mjs';
import {createProducerInitialKeyPreparation,sourceInitialAcceptedNotice} from './source-startup-contract.mjs';
export function createProducerSourceHook({context,bridge,readCausalCapture,capturePulseMarker,criticalControlPending,emit,now,initialNotice=null}){
 const c=validateSourceContext(context),bindings=new Map(c.publicBindings.map((binding,index)=>[binding,index]));
 const ledger=createGeneratedSourceLedger({context:c,readCausalCapture,capturePulseMarker});
 const initial=createProducerInitialKeyPreparation({context:c,publishOwnedCopy:value=>bridge.publishOwnedCopy(value),emit});
 if(initialNotice!==null)assert.deepEqual(initialNotice,sourceInitialAcceptedNotice(c));
 let prepared=initialNotice!==null,closed=false,publisher=null,startedAt=null,tailAttempted=false,tailResult=null;const counters={recorded:0,ignoredCanaries:0,failed:0};
 return{
  async prepare(){assert.ok(!closed&&!prepared);const notice=await initial.prepare();assert.ok(!closed);prepared=true;return notice;},
  start(value){assert.ok(prepared&&!closed&&!publisher);startedAt=value;publisher=createRetainedSourcePublisher({context:c,ledger,write:value=>bridge.writeRaw(value),criticalControlPending,retireLedgerConnection:()=>bridge.retire(),now,startedAt});},
  record({publicBinding,body,pulse,primary}){
   assert.equal(typeof primary,'boolean');assert.ok(!closed&&prepared&&publisher);
   if(!primary){counters.ignoredCanaries++;return;}
   try{assert.ok(bindings.has(publicBinding));const result=ledger.recordScreenshotBody({rowIndex:bindings.get(publicBinding),publicBinding,body,pulse});counters.recorded++;return result;}
   catch(error){counters.failed++;throw error;}
  },
  tick(){assert.ok(publisher&&!closed);return publisher.tick();},
  async finishDuration({pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
   assert.ok(publisher&&!closed&&!tailAttempted);tailAttempted=true;const due=startedAt+c.durationMs+1000;const before=now();assert.ok(Number.isFinite(before)&&before>=startedAt+c.durationMs,'Only the completed fixed traffic duration may request its metadata tail');
   await pause(Math.max(0,due-now()));assert.ok(!closed);tailResult=await publisher.tick();return tailResult;
  },
  close(){closed=true;initial.close();publisher?.close();if(!publisher)ledger.close();bridge.close();},
  whenSettled:()=>Promise.allSettled([initial.whenSettled(),publisher?.whenSettled(),bridge.whenSettled()].filter(Boolean)),
  summary:()=>({...counters,prepared,closed,source:ledger.summary(),publication:publisher?.summary()??null,adapter:bridge.summary(),rawJpegsRetained:0,
   currentPolicy:'PROPOSED-v2-oldest-metadata-FIFO2-Tplus1-tail',earlySourceCoverageProved:false,tailFlushImplemented:true,tailAttempted,tailResult,capacityAccepted:false})
 };
}
