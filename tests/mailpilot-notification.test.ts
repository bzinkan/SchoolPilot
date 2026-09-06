import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createServer } from "node:http";
import { createMailpilotPubsubPushHandler } from "../src/services/mailpilotPubsubDelivery.js";
import { mailpilotClassificationAvailable, mailpilotHistoryCovered, mailpilotSafetySourceId, processMailpilotHistoryBatch } from "../src/services/mailpilotNotification.js";

test("mail source identity is stable, tenant/student scoped and does not reveal the provider identifier",()=>{
  const identity={schoolId:"school-a",studentId:"student-a",gmailMessageId:"sensitive-message-id"};
  const key=mailpilotSafetySourceId(identity);
  assert.equal(key,mailpilotSafetySourceId({...identity}));assert(!key.includes(identity.gmailMessageId));
  assert.notEqual(key,mailpilotSafetySourceId({...identity,schoolId:"school-b"}));
  assert.notEqual(key,mailpilotSafetySourceId({...identity,studentId:"student-b"}));
  assert.notEqual(key,mailpilotSafetySourceId({...identity,gmailMessageId:"other"}));
});

test("history coverage uses exact decimal order and classification failures cannot become benign mail",()=>{
  assert(mailpilotHistoryCovered("90071992547409930","90071992547409929"));
  assert(!mailpilotHistoryCovered("90071992547409929","90071992547409930"));
  assert(!mailpilotHistoryCovered(null,"10"));assert(!mailpilotHistoryCovered("invalid","10"));
  assert(!mailpilotClassificationAvailable(null));
  assert(!mailpilotClassificationAvailable({category:"unknown",confidence:0,reasoning:"Classification unavailable"}));
  assert(mailpilotClassificationAvailable({category:"unknown",confidence:0,reasoning:"No safety concern identified"}));
});

test("a failed message preserves cursor while later successful messages commit idempotently on retry",async()=>{
  const saved=new Set<string>();let cursor="100",fail=true;const stats:unknown[]=[];
  const run=()=>processMailpilotHistoryBatch({messageIds:["first","failed","later","first"],processMessage:async id=>{
    if(id==="failed"&&fail)throw new Error("private provider content must not escape");
    if(saved.has(id))return "skipped";saved.add(id);return "alert";
  },recordStats:async value=>{stats.push(value);},complete:async()=>{cursor="200";}});
  await assert.rejects(run(),{code:"MAILPILOT_MESSAGE_BATCH_INCOMPLETE"});
  assert.equal(cursor,"100");assert.deepEqual([...saved],["first","later"]);
  fail=false;await run();assert.equal(cursor,"200");assert.equal(saved.size,3);
  assert.deepEqual(stats,[{messagesScanned:3,alertsRaised:2,errors:1},{messagesScanned:3,alertsRaised:1,errors:0}]);
});

test("scan-log or cursor failure rejects the batch instead of acknowledging incomplete persistence",async()=>{
  let completed=false;
  await assert.rejects(processMailpilotHistoryBatch({messageIds:[],processMessage:async()=>"benign",recordStats:async()=>{throw new Error("stats failed");},complete:async()=>{completed=true;}}));
  assert.equal(completed,false);
  await assert.rejects(processMailpilotHistoryBatch({messageIds:[],processMessage:async()=>"benign",recordStats:async()=>{},complete:async()=>{throw new Error("cursor failed");}}));
});

test("actual push handler authenticates, waits for completion, returns503 on failure and safely acknowledges malformed pushes",async()=>{
  let release:()=>void=()=>{};let began:()=>void=()=>{};let fail=false,calls=0,errors=0;
  const started=new Promise<void>(resolve=>{began=resolve;});
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const app=express();app.use(express.json());app.post("/push",createMailpilotPubsubPushHandler({verificationToken:()=>"test-secret",onProcessingFailure:()=>{errors++;},processNotification:async(email,history)=>{
    calls++;assert.equal(email,"student@example.test");assert.equal(history,"90071992547409931");began();await blocked;if(fail)throw new Error("private body");
  }}));
  const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}/push`;
  const body=JSON.stringify({message:{data:Buffer.from(JSON.stringify({emailAddress:"Student@example.test",historyId:"90071992547409931"})).toString("base64")}});
  const options={method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer test-secret"},body};
  try{
    assert.equal((await fetch(url,{...options,headers:{"Content-Type":"application/json"}})).status,401);assert.equal(calls,0);
    let acknowledged=false;const pending=fetch(url,options).then(response=>{acknowledged=true;return response;});
    await started;await new Promise(resolve=>setImmediate(resolve));assert.equal(acknowledged,false,"successful ACK cannot precede durable processing");
    release();assert.equal((await pending).status,204);
    fail=true;const retried=await fetch(url,options);assert.equal(retried.status,503);assert.equal(errors,1);assert(!JSON.stringify(await retried.json()).includes("private body"));
    const malformed={...options,body:JSON.stringify({message:{data:Buffer.from('{"emailAddress":42}').toString("base64")}})};
    assert.equal((await fetch(url,malformed)).status,204);assert.equal(calls,2);
    fail=false;
    assert.equal((await fetch(`${url}?token=test-secret`,{...options,headers:{"Content-Type":"application/json"}})).status,204,"existing query-token subscriptions remain supported");
    assert.equal(calls,3);
  }finally{release();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
