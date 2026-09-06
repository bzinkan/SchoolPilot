import { createHash } from "node:crypto";
import { addLocalDays, localDateInTimeZone, localDateStartUtc } from "../util/schoolTime.js";

export type HistoryWindow={start:Date;end:Date};
export const HISTORY_MAX_GAP_SECONDS=60;
export function historyError(code:string,message:string,status=400){return Object.assign(new Error(message),{code,status,expose:true});}
export function historyDate(value:unknown,fallback:string):string{
  if(value===undefined)return fallback;
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw historyError("HISTORY_DATE_INVALID","Use valid school-local dates in YYYY-MM-DD format.");
  return value;
}
export function resolveHistoryDates(input:{startDate?:unknown;endDate?:unknown;timeZone:string;now:Date}){
  const today=localDateInTimeZone(input.now,input.timeZone);const startDate=historyDate(input.startDate,today),endDate=historyDate(input.endDate,startDate);
  if(startDate>endDate||Date.parse(endDate)-Date.parse(startDate)>365*86400000)throw historyError("HISTORY_RANGE_INVALID","Choose an ordered date range of at most 366 days.");
  return {startDate,endDate,today,timeZone:input.timeZone,start:localDateStartUtc(startDate,input.timeZone),end:new Date(Math.min(input.now.getTime(),localDateStartUtc(addLocalDays(endDate,1),input.timeZone).getTime()))};
}
export function mergeHistoryWindows(windows:HistoryWindow[]):HistoryWindow[]{
  const result:HistoryWindow[]=[];for(const row of windows.filter(row=>row.end>row.start).sort((a,b)=>a.start.getTime()-b.start.getTime())){const last=result.at(-1);if(last&&row.start<=last.end){if(row.end>last.end)last.end=new Date(row.end);}else result.push({start:new Date(row.start),end:new Date(row.end)});}return result;
}
export function subtractHistoryWindows(windows:HistoryWindow[],exclusions:HistoryWindow[]):HistoryWindow[]{
  let result=mergeHistoryWindows(windows);for(const exclusion of mergeHistoryWindows(exclusions)){result=result.flatMap(row=>exclusion.end<=row.start||exclusion.start>=row.end?[row]:[...(exclusion.start>row.start?[{start:row.start,end:exclusion.start}]:[]),...(exclusion.end<row.end?[{start:exclusion.end,end:row.end}]:[])]);}return result;
}
export function clipHistoryWindows(windows:HistoryWindow[],start:Date,end:Date){return mergeHistoryWindows(windows.map(row=>({start:new Date(Math.max(start.getTime(),row.start.getTime())),end:new Date(Math.min(end.getTime(),row.end.getTime()))})));}
/** An aggregate cannot be divided by trimming its timestamps; authorize its entire source interval. */
export function historyAggregateCovered(aggregate:HistoryWindow,windows:HistoryWindow[]):boolean{
  return aggregate.end>aggregate.start&&mergeHistoryWindows(windows).some(row=>row.start<=aggregate.start&&row.end>=aggregate.end);
}
type HistoryCursor={v:1;timestamp:string;id:string;anchor:string;scope:string;startDate?:string;endDate?:string};
export function historyScopeHash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
export function encodeHistoryCursor(value:Omit<HistoryCursor,"v">){return Buffer.from(JSON.stringify({v:1,...value})).toString("base64url");}
export function readHistoryCursor(value:unknown,now:Date):HistoryCursor|null{
  if(value===undefined)return null;
  try{if(typeof value!=="string"||value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();const row=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));if(row.v!==1||typeof row.scope!=="string"||typeof row.id!=="string"||!row.id||row.id.length>256||typeof row.timestamp!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.timestamp)||!Number.isFinite(Date.parse(row.timestamp))||typeof row.anchor!=="string"||!Number.isFinite(Date.parse(row.anchor))||Date.parse(row.anchor)>now.getTime()+1000)throw new Error();if(row.startDate!==undefined)historyDate(row.startDate,"");if(row.endDate!==undefined)historyDate(row.endDate,"");return row;}catch{throw historyError("HISTORY_CURSOR_INVALID","This history cursor is invalid or belongs to another student or date range.");}
}
export function decodeHistoryCursor(value:unknown,scope:string,now:Date):HistoryCursor|null{
  const cursor=readHistoryCursor(value,now);if(cursor&&cursor.scope!==scope)throw historyError("HISTORY_CURSOR_INVALID","This history cursor is invalid or belongs to another student or date range.");return cursor;
}
export function estimatedHistorySeconds(observedAt:Date,nextAt:Date|null,authorityEnd:Date):number{
  if(!nextAt||nextAt>authorityEnd)return 0;const seconds=(nextAt.getTime()-observedAt.getTime())/1000;return seconds>0&&seconds<=HISTORY_MAX_GAP_SECONDS?seconds:0;
}
