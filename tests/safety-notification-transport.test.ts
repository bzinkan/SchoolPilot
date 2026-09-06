import test from "node:test";
import assert from "node:assert/strict";
import { sendSafetyEmailBounded } from "../src/services/safetyEmailTransport.js";

const message={to:'fixture@example.invalid',subject:'Synthetic safety fixture',text:'No student data'};
test('accepted and retryable provider outcomes are preserved',async()=>{
  assert.deepEqual(await sendSafetyEmailBounded(async()=>({status:'sent',providerMessageId:'fixture'}),message),{status:'sent',providerMessageId:'fixture'});
  assert.deepEqual(await sendSafetyEmailBounded(async()=>({status:'transient_failure',error:'RATE_LIMITED'}),message),{status:'transient_failure',error:'RATE_LIMITED'});
});
test('a hanging provider is bounded and its late acceptance is not retried',async()=>{
  let accepted!:(value:{status:'sent'})=>void;
  let calls=0;
  const result=await sendSafetyEmailBounded(()=>{calls++;return new Promise(resolve=>{accepted=resolve;});},message,5);
  assert.deepEqual(result,{status:'unknown',error:'SAFETY_EMAIL_TRANSPORT_TIMEOUT'});
  accepted({status:'sent'});
  await Promise.resolve();
  assert.equal(calls,1);
  assert.equal(result.status,'unknown');
});
test('transport exceptions retain no provider error or message contents',async()=>{
  const result=await sendSafetyEmailBounded(async()=>{throw new Error('private provider response');},message);
  assert.deepEqual(result,{status:'unknown',error:'SAFETY_EMAIL_TRANSPORT_EXCEPTION'});
});
