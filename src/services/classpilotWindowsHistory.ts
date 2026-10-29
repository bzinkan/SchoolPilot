import { randomUUID } from "node:crypto";
import { and,eq,sql } from "drizzle-orm";
import { z } from "zod";
import { classpilotWindowsBrowserEvents as events } from "../schema/classpilotWindowsHistory.js";
import { classpilotWindowsBrowsers } from "../schema/classpilotWindows.js";
import { historyContext,type BrowsingHistoryRequest } from "./classpilotBrowsingHistory.js";
import { encodeHistoryCursor,historyError } from "./classpilotBrowsingHistoryModel.js";
import { withWindowsSchool,type WindowsBinding } from "./classpilotWindows.js";
import type { NativeStorageDb } from "./storage.js";

/** Metadata only. Browser pixels and native observations never reach this model. */
export async function recordWindowsObservation(binding:WindowsBinding,database:NativeStorageDb,input:Record<string,unknown>,policy:{authority:{teachingSessionId?:string|null;supervisionContextId?:string|null}|null|undefined;expiresAt:number;policyMode:string}){
  const now=Date.now();
  if(policy.policyMode!=="full"||policy.expiresAt<=now)return;
  const observationId=z.string().uuid().parse(input.observationId);
  const sequence=z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.sequence);
  const focused=input.browserFocused===true;
  await database.insert(events).values({id:randomUUID(),schoolId:binding.browser.schoolId,studentId:binding.student.id,browserId:binding.browser.id,
    sourceRef:binding.browser.sourceRef,bindingRevision:binding.browser.bindingRevision,observationId,sequence,observedAt:new Date(now),
    usageEndsAt:new Date(focused?Math.min(now+10_000,policy.expiresAt):now),browserFocused:focused,
    activeTabUrl:z.string().max(4096).parse(input.activeTabUrl??""),activeTabTitle:z.string().max(512).parse(input.activeTabTitle??""),
    teachingSessionId:policy.authority?.teachingSessionId??null,supervisionContextId:policy.authority?.supervisionContextId??null}).onConflictDoNothing();
}

export type WindowsHistoryRequest=BrowsingHistoryRequest&{sourceRef:string;bindingRevision:number};
export async function getWindowsBrowsingHistory(input:WindowsHistoryRequest){
  return withWindowsSchool(input.schoolId,[input.studentId],async database=>{
    const [source]=await database.select({id:classpilotWindowsBrowsers.id,browserFamily:classpilotWindowsBrowsers.browserFamily}).from(classpilotWindowsBrowsers).where(and(
      eq(classpilotWindowsBrowsers.schoolId,input.schoolId),eq(classpilotWindowsBrowsers.studentId,input.studentId),eq(classpilotWindowsBrowsers.sourceRef,input.sourceRef),eq(classpilotWindowsBrowsers.bindingRevision,input.bindingRevision))).limit(1);
    if(!source)throw historyError("HISTORY_DENIED","This browser source is not available.",404);
    // Keep the same retention, dates and actually-supervised intervals as Chromebook history.
    const context=await historyContext({...input,view:"all",grouping:"observations"},["windows",input.sourceRef,String(input.bindingRevision)]);
    const limit=z.coerce.number().int().min(1).max(500).default(100).parse(input.limit);
    const base={...context.meta,sourceRef:input.sourceRef,bindingRevision:input.bindingRevision,browserFamily:source.browserFamily,
      state:context.expired?"expired":"empty",entries:[] as unknown[],hasMore:false,nextCursor:null as string|null,
      estimatedDurationNote:"Focused activity is estimated for at most ten seconds after an observation. Student totals merge overlapping browser intervals."};
    if(context.expired||!context.windows.length)return base;
    const windows=sql.join(context.windows.map(w=>sql`(${w.start.toISOString()}::timestamptz,${w.end.toISOString()}::timestamptz)`),sql`, `);
    const cursor=context.cursor?sql`AND (e.observed_at,e.id)<(${context.cursor.timestamp}::timestamptz,${context.cursor.id})`:sql``;
    const rows=await database.execute<{id:string;timestamp:Date;active_tab_url:string;active_tab_title:string;classification:Record<string,unknown>|null;seconds:number}>(sql`
      WITH authorized(start_at,end_at) AS (VALUES ${windows})
      SELECT e.id,e.observed_at AS timestamp,e.active_tab_url,e.active_tab_title,e.classification,
        greatest(0,extract(epoch FROM least(e.usage_ends_at,(SELECT max(end_at) FROM authorized WHERE e.observed_at>=start_at AND e.observed_at<end_at))-e.observed_at))::float AS seconds
      FROM classpilot_windows_browser_events e
      WHERE e.school_id=${input.schoolId} AND e.student_id=${input.studentId} AND e.browser_id=${source.id}
        AND e.source_ref=${input.sourceRef} AND e.binding_revision=${input.bindingRevision}
        AND EXISTS(SELECT 1 FROM authorized WHERE e.observed_at>=start_at AND e.observed_at<end_at)
        ${cursor} ORDER BY e.observed_at DESC,e.id DESC LIMIT ${limit+1}`);
    const page=rows.rows.slice(0,limit),hasMore=rows.rows.length>limit,last=page.at(-1);
    const entries=page.map(row=>({id:row.id,timestamp:new Date(row.timestamp).toISOString(),activeTabUrl:row.active_tab_url,activeTabTitle:row.active_tab_title,estimatedSeconds:Number(row.seconds),aiCategory:row.classification?.category??null,contentCategory:row.classification?.contentCategory??null,teacherIntentSource:row.classification?.teacherIntentSource??null,screenLocked:false,cameraActive:false}));
    return {...base,state:entries.length?"available":"empty",entries,hasMore,nextCursor:hasMore&&last?encodeHistoryCursor({timestamp:new Date(last.timestamp).toISOString(),id:last.id,anchor:context.anchor.toISOString(),scope:context.scope,startDate:context.dates.startDate,endDate:context.dates.endDate}):null};
  });
}

/** Half-open interval union, shared by browser-usage tests and on-demand summaries. */
export function windowsObservedSeconds(intervals:Array<{start:number;end:number}>):number{
  const ordered=intervals.filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end>x.start).sort((a,b)=>a.start-b.start||a.end-b.end);
  let total=0,end=-Infinity;
  for(const interval of ordered){total+=Math.max(0,interval.end-Math.max(interval.start,end));end=Math.max(end,interval.end);}
  return total/1000;
}
