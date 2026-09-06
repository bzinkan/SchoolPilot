import test from "node:test";
import assert from "node:assert/strict";
import { SAFETY_EMAIL_DETAIL_LIMIT, SAFETY_EMAIL_REPORT_LIMIT, safetyEmailText, safetyNotificationBundleKey, safetyNotificationRetry } from "../src/services/safetyNotificationModel.js";

const row=(index:number,caseId="case-one")=>({id:`alert-${index}`,school_id:"school",recipient:"admin@example.invalid",kind:"initial",case_id:caseId,first_name:"Synthetic",last_name:"Student",concern:`concern-${index}`,severity:"medium",first_seen_at:"2026-09-05T12:00:00Z",reason:"A retained rule matched."});
test("message details are bounded while all alerts and authenticated report links remain represented",()=>{
  const entries=Array.from({length:121},(_,index)=>row(index));entries[120]!.severity="critical";
  const text=safetyEmailText(entries,"America/Chicago","https://school.example.invalid");
  assert.match(text,/121 safety alert\(s\) across 1 student report/);
  assert.equal((text.match(/^• /gm)||[]).length,SAFETY_EMAIL_DETAIL_LIMIT);
  assert.match(text,/101 additional alert\(s\) are included/);assert.match(text,/concern-120 \(critical\)/);
  assert.match(text,/https:\/\/school.example.invalid\/classpilot\/admin\/safety\?case=case-one/);
  assert.equal(entries[0]!.id,"alert-0","Rendering does not reorder the delivery cohort");
});
test("large follow-up digests bound report links and explain all omitted reports",()=>{
  const entries=Array.from({length:1000},(_,index)=>({...row(index,`case-${index}`),first_name:"x".repeat(10000),reason:"r".repeat(10000)}));
  const text=safetyEmailText(entries,"America/New_York","https://school.example.invalid");
  assert.equal((text.match(/Review the authenticated student report:/g)||[]).length,SAFETY_EMAIL_REPORT_LIMIT);
  assert.match(text,/980 additional alert\(s\) across 980 more student report/);
  assert.match(text,/Review all authenticated student reports: https:\/\/school.example.invalid\/classpilot\/admin\/safety/);
  assert(text.length<25_000);assert.equal((text.match(/^• /gm)||[]).length,SAFETY_EMAIL_DETAIL_LIMIT);
});
test("bundle keys preserve school, recipient and initial report boundaries while follow-ups share recipient digest",()=>{
  const entry=row(0);const key=safetyNotificationBundleKey(entry);
  for(const changed of [{school_id:"other"},{recipient:"other@example.invalid"},{case_id:"other"},{kind:"followup"}])assert.notEqual(safetyNotificationBundleKey({...entry,...changed}),key);
  assert.equal(safetyNotificationBundleKey({...entry,kind:"followup"}),safetyNotificationBundleKey({...entry,kind:"followup",case_id:"other"}));
});
test("one bundle outcome preserves individual retry attempts and never retries unknown provider acceptance",()=>{
  assert.deepEqual(safetyNotificationRetry(1,"transient_failure"),{status:"pending",delaySeconds:60});
  assert.deepEqual(safetyNotificationRetry(4,"transient_failure"),{status:"pending",delaySeconds:480});
  assert.deepEqual(safetyNotificationRetry(5,"transient_failure"),{status:"failed",delaySeconds:0});
  assert.deepEqual(safetyNotificationRetry(1,"unknown"),{status:"unknown",delaySeconds:0});
});
