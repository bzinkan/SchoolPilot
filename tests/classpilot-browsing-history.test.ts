import assert from "node:assert/strict";
import { test } from "node:test";
import { clipHistoryWindows, decodeHistoryCursor, encodeHistoryCursor, estimatedHistorySeconds, historyAggregateCovered, historyScopeHash, mergeHistoryWindows, readHistoryCursor, resolveHistoryDates, subtractHistoryWindows } from "../src/services/classpilotBrowsingHistoryModel.js";
const time=(value:string)=>new Date(`2026-09-01T${value}:00.000Z`);
test("history dates use school midnight including DST and reject invalid dates/ranges",()=>{
  const spring=resolveHistoryDates({startDate:"2026-03-08",endDate:"2026-03-08",timeZone:"America/New_York",now:new Date("2026-03-10T00:00:00Z")});assert.equal(spring.start.toISOString(),"2026-03-08T05:00:00.000Z");assert.equal(spring.end.getTime()-spring.start.getTime(),23*3600000);
  assert.throws(()=>resolveHistoryDates({startDate:"2026-02-30",timeZone:"UTC",now:new Date()}),{code:"HISTORY_DATE_INVALID"});
  assert.throws(()=>resolveHistoryDates({startDate:"2026-09-02",endDate:"2026-09-01",timeZone:"UTC",now:new Date()}),{code:"HISTORY_RANGE_INVALID"});
  assert.throws(()=>resolveHistoryDates({startDate:"2020-01-01",endDate:"2026-01-01",timeZone:"UTC",now:new Date()}),{code:"HISTORY_RANGE_INVALID"});
});
test("delegated supervision removes exact intervals, union merges own coverage without widening gaps",()=>{
  const classroom=[{start:time("09:00"),end:time("10:00")}];
  const remaining=subtractHistoryWindows(classroom,[{start:time("09:15"),end:time("09:30")}]);
  assert.deepEqual(remaining,[{start:time("09:00"),end:time("09:15")},{start:time("09:30"),end:time("10:00")}]);
  const union=mergeHistoryWindows([...remaining,{start:time("10:00"),end:time("10:30")}]);assert.equal(union.length,2);assert.equal(union[1]!.end.getTime(),time("10:30").getTime());
  assert.deepEqual(clipHistoryWindows(union,time("09:10"),time("09:45")),[{start:time("09:10"),end:time("09:15")},{start:time("09:30"),end:time("09:45")}]);
});
test("cursor preserves sub-millisecond order and rejects another student/date scope or malformed input",()=>{
  const now=time("12:00"),scope=historyScopeHash(["school","student","teacher","2026-09-01"]);
  const encoded=encodeHistoryCursor({timestamp:"2026-09-01T09:00:00.123456Z",id:"heartbeat",anchor:now.toISOString(),scope});
  assert.equal(decodeHistoryCursor(encoded,scope,now)?.timestamp,"2026-09-01T09:00:00.123456Z");
  assert.throws(()=>decodeHistoryCursor(encoded,historyScopeHash(["other"]),now),{code:"HISTORY_CURSOR_INVALID"});
  assert.throws(()=>decodeHistoryCursor("invalid!",scope,now),{code:"HISTORY_CURSOR_INVALID"});
});
test("duration estimation never fills long gaps, future tails or inaccessible intervals",()=>{
  const start=time("09:00"),end=time("10:00");
  assert.equal(estimatedHistorySeconds(start,new Date(start.getTime()+5000),end),5);
  assert.equal(estimatedHistorySeconds(start,new Date(start.getTime()+61000),end),0);
  assert.equal(estimatedHistorySeconds(start,null,end),0);
  assert.equal(estimatedHistorySeconds(start,new Date(start.getTime()+5000),new Date(start.getTime()+3000)),0);
  assert.equal(estimatedHistorySeconds(start,start,end),0);
});
test("whole-session domain aggregates are withheld for late capture, delegated gaps and clipped retention",()=>{
  const aggregate={start:time("09:00"),end:time("10:00")};
  assert.equal(historyAggregateCovered(aggregate,[aggregate]),true);
  assert.equal(historyAggregateCovered(aggregate,[{start:time("09:01"),end:time("10:00")}]),false);
  assert.equal(historyAggregateCovered(aggregate,subtractHistoryWindows([aggregate],[{start:time("09:15"),end:time("09:30")}])),false);
  assert.equal(historyAggregateCovered(aggregate,[{start:time("09:15"),end:time("09:30")}]),false);
  assert.equal(historyAggregateCovered(aggregate,[{start:time("09:00"),end:time("09:59")}]),false);
});
test("default-date cursors preserve their original day after midnight and keep the initial horizon",()=>{
  const anchor=new Date("2026-09-02T03:59:59Z"),later=new Date("2026-09-02T04:00:02Z");
  const cursor=encodeHistoryCursor({timestamp:"2026-09-02T03:58:00.000000Z",id:"row",anchor:anchor.toISOString(),scope:"scope",startDate:"2026-09-01",endDate:"2026-09-01"});
  const read=readHistoryCursor(cursor,later)!;
  const dates=resolveHistoryDates({startDate:read.startDate,endDate:read.endDate,timeZone:"America/New_York",now:later});
  assert.equal(dates.startDate,"2026-09-01");assert.equal(read.anchor,anchor.toISOString());assert.equal(Math.min(dates.end.getTime(),Date.parse(read.anchor)),anchor.getTime());
});
