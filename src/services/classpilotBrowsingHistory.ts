import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../db.js";
import { schools } from "../schema/core.js";
import { students } from "../schema/students.js";
import { settings } from "../schema/shared.js";
import { classpilotSessionUsage, dailyUsage } from "../schema/classpilot.js";
import { parseClasspilotRetentionDays } from "../util/classpilotRetention.js";
import { addLocalDays, localDateStartUtc } from "../util/schoolTime.js";
import { getClasspilotStudentHistoryAuthority, type ClasspilotStudentDataRole } from "./classpilotStudentData.js";
import { clipHistoryWindows, decodeHistoryCursor, encodeHistoryCursor, estimatedHistorySeconds, historyAggregateCovered, historyError, historyScopeHash, readHistoryCursor, resolveHistoryDates, type HistoryWindow } from "./classpilotBrowsingHistoryModel.js";
import { normalizeContentCategory } from "./classpilotContentCategories.js";

export type BrowsingHistoryRequest={schoolId:string;studentId:string;actorId:string;role:ClasspilotStudentDataRole;startDate?:unknown;endDate?:unknown;limit?:unknown;cursor?:unknown;now?:Date};
async function historyContext(input:BrowsingHistoryRequest){
  const now=input.now||new Date();
  const [student]=await db.select({id:students.id}).from(students).where(and(eq(students.schoolId,input.schoolId),eq(students.id,input.studentId))).limit(1);
  if(!student)throw historyError("HISTORY_DENIED","This student's browsing history is not available to you.",404);
  const [school]=await db.select({timeZone:schools.schoolTimezone}).from(schools).where(eq(schools.id,input.schoolId)).limit(1);
  const [policy]=await db.select({retentionHours:settings.retentionHours}).from(settings).where(eq(settings.schoolId,input.schoolId)).limit(1);
  const retentionDays=parseClasspilotRetentionDays(policy?.retentionHours);const retentionCutoff=new Date(now.getTime()-retentionDays*86400000);
  const cursorDates=readHistoryCursor(input.cursor,now);
  const dates=resolveHistoryDates({startDate:input.startDate??cursorDates?.startDate,endDate:input.endDate??cursorDates?.endDate,timeZone:school?.timeZone||"America/New_York",now});
  const scope=historyScopeHash([input.schoolId,input.studentId,input.actorId,input.role,dates.startDate,dates.endDate]);
  const cursor=decodeHistoryCursor(input.cursor,scope,now);const anchor=cursor?new Date(cursor.anchor):now;
  const authority=input.role==="teacher"?await getClasspilotStudentHistoryAuthority({...input,now,retentionCutoff}):null;
  if(authority&&!authority.windows.length)throw historyError("HISTORY_DENIED","You can view browsing only during classes or supervision you actually taught.",403);
  const requestedEnd=new Date(Math.min(dates.end.getTime(),anchor.getTime()));const expired=requestedEnd<=retentionCutoff;
  const start=new Date(Math.max(dates.start.getTime(),retentionCutoff.getTime()));
  const windows=clipHistoryWindows(authority?.windows||[{start,end:requestedEnd}],start,requestedEnd);
  if(authority&&!expired&&!windows.length)throw historyError("HISTORY_DENIED","You did not supervise this student during the selected dates.",403);
  return {now,dates,scope,cursor,anchor,authority,windows,expired,retentionDays,retentionCutoff,meta:{studentId:input.studentId,timeZone:dates.timeZone,startDate:dates.startDate,endDate:dates.endDate,today:dates.today,retentionDays,retainedFrom:retentionCutoff.toISOString(),partiallyExpired:dates.start<retentionCutoff&&!expired,scope:input.role==="teacher"?"supervised_intervals":"school",asOf:anchor.toISOString()}};
}
function windowValues(windows:HistoryWindow[]){return sql.join(windows.map(row=>sql`(${row.start.toISOString()}::timestamp,${row.end.toISOString()}::timestamp)`),sql`, `);}

/** Exact student key, stable seek cursor and a bounded next-observation lookup per returned row. */
export async function getStudentBrowsingHistory(input:BrowsingHistoryRequest){
  const context=await historyContext(input);const requested=input.limit===undefined?100:Number(input.limit);
  if(!Number.isInteger(requested)||requested<1)throw historyError("HISTORY_LIMIT_INVALID","History page size must be a positive integer.");
  const limit=Math.min(500,requested);const empty={...context.meta,state:context.expired?"expired":"empty",entries:[],nextCursor:null,hasMore:false,estimatedDurationNote:"Durations are estimates between consecutive observations up to 60 seconds apart; gaps and the last observation add no time."};
  if(context.expired||!context.windows.length)return empty;
  const cursorPredicate=context.cursor?sql`AND (h.timestamp,h.id)<(${context.cursor.timestamp}::timestamp,${context.cursor.id})`:sql``;
  const rows=await db.execute<{id:string;timestamp:string;active_tab_url:string|null;active_tab_title:string;ai_category:string|null;content_category:string|null;teacher_intent_source:string|null;screen_locked:boolean|null;camera_active:boolean|null;authority_end:Date;next_observed_at:Date|null}>(sql`
    WITH authorized_windows(start_at,end_at) AS (VALUES ${windowValues(context.windows)}), candidate AS (
      SELECT h.id,h.device_id,h.timestamp,h.active_tab_url,h.active_tab_title,h.ai_category,h.content_category,h.teacher_intent_source,h.screen_locked,h.camera_active,
        (SELECT max(w.end_at) FROM authorized_windows w WHERE h.timestamp>=w.start_at AND h.timestamp<w.end_at) AS authority_end
      FROM heartbeats h WHERE h.school_id=${input.schoolId} AND h.student_id=${input.studentId}
        AND h.timestamp>=${context.windows[0]!.start.toISOString()}::timestamp AND h.timestamp<${context.windows.at(-1)!.end.toISOString()}::timestamp
        AND EXISTS(SELECT 1 FROM authorized_windows w WHERE h.timestamp>=w.start_at AND h.timestamp<w.end_at)
        ${cursorPredicate} ORDER BY h.timestamp DESC,h.id DESC LIMIT ${limit+1}
    )
    SELECT h.id,to_char(h.timestamp,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp,h.active_tab_url,h.active_tab_title,h.ai_category,h.content_category,h.teacher_intent_source,h.screen_locked,h.camera_active,h.authority_end AT TIME ZONE 'UTC' AS authority_end,
      next_observation.timestamp AT TIME ZONE 'UTC' AS next_observed_at
    FROM candidate h LEFT JOIN LATERAL (
      SELECT n.timestamp FROM heartbeats n WHERE n.school_id=${input.schoolId} AND n.student_id=${input.studentId} AND n.device_id=h.device_id
        AND (n.timestamp,n.id)>(h.timestamp,h.id) AND n.timestamp<=h.timestamp+interval '60 seconds' AND n.timestamp<h.authority_end
      ORDER BY n.timestamp,n.id LIMIT 1
    ) next_observation ON true ORDER BY h.timestamp DESC,h.id DESC
  `);
  const page=rows.rows.slice(0,limit),hasMore=rows.rows.length>limit,last=page.at(-1);
  const entries=page.map(row=>({id:row.id,timestamp:row.timestamp,activeTabUrl:row.active_tab_url,activeTabTitle:row.active_tab_title,aiCategory:row.ai_category,contentCategory:normalizeContentCategory(row.content_category),teacherIntentSource:row.teacher_intent_source||null,screenLocked:row.screen_locked===true,cameraActive:row.camera_active===true,estimatedSeconds:estimatedHistorySeconds(new Date(row.timestamp),row.next_observed_at?new Date(row.next_observed_at):null,new Date(row.authority_end))}));
  return {...empty,state:entries.length?"available":"empty",entries,hasMore,nextCursor:hasMore&&last?encodeHistoryCursor({timestamp:last.timestamp,id:last.id,anchor:context.anchor.toISOString(),scope:context.scope,startDate:context.dates.startDate,endDate:context.dates.endDate}):null};
}

/** Day summaries use retained materializations; a teacher never receives school-wide daily totals. */
export async function getStudentBrowsingDomains(input:BrowsingHistoryRequest){
  const context=await historyContext(input);const base={...context.meta,state:context.expired?"expired":"empty",days:[] as Array<{date:string;domains:Array<{domain:string;seconds:number;contentCategory:string|null}>;computedAt:string}>,source:input.role==="teacher"?"class_session_usage":"daily_usage",partial:context.authority?.hasSupervision===true};
  if(context.expired||!context.windows.length)return base;
  const sessionIds=context.authority?.sessions.map(row=>row.id)||[];
  const sessionsById=new Map(context.authority?.sessions.map(row=>[row.id,row]));
  const rows=input.role==="teacher"?(sessionIds.length?await db.select({sessionId:classpilotSessionUsage.teachingSessionId,date:classpilotSessionUsage.localDate,topDomains:classpilotSessionUsage.topDomains,computedAt:classpilotSessionUsage.computedAt}).from(classpilotSessionUsage).where(and(eq(classpilotSessionUsage.schoolId,input.schoolId),eq(classpilotSessionUsage.studentId,input.studentId),inArray(classpilotSessionUsage.teachingSessionId,sessionIds),sql`${classpilotSessionUsage.localDate}>=${context.dates.startDate}`,sql`${classpilotSessionUsage.localDate}<=${context.dates.endDate}`)):[]):await db.select({sessionId:sql<string|null>`NULL`,date:dailyUsage.date,topDomains:dailyUsage.topDomains,computedAt:dailyUsage.computedAt}).from(dailyUsage).where(and(eq(dailyUsage.schoolId,input.schoolId),eq(dailyUsage.studentId,input.studentId),sql`${dailyUsage.date}>=${context.dates.startDate}`,sql`${dailyUsage.date}<=${context.dates.endDate}`));
  const days=new Map<string,{domains:Map<string,{domain:string;seconds:number;contentCategory:string|null}>;computedAt:Date}>();
  for(const row of rows){
    const dayStart=localDateStartUtc(row.date,context.dates.timeZone),dayEnd=localDateStartUtc(addLocalDays(row.date,1),context.dates.timeZone);
    if(input.role==="teacher"){
      const session=row.sessionId?sessionsById.get(row.sessionId):undefined;
      const aggregate=session?{start:new Date(Math.max(session.start.getTime(),dayStart.getTime())),end:new Date(Math.min(session.end.getTime(),dayEnd.getTime()))}:null;
      if(!session?.final||!aggregate||(session.timeZone&&session.timeZone!==context.dates.timeZone)||!historyAggregateCovered(aggregate,context.windows)){base.partial=true;continue;}
    }else if(dayStart<context.retentionCutoff){base.partial=true;continue;}
    let day=days.get(row.date);if(!day){day={domains:new Map(),computedAt:row.computedAt};days.set(row.date,day);}if(row.computedAt>day.computedAt)day.computedAt=row.computedAt;
    for(const value of Array.isArray(row.topDomains)?row.topDomains:[]){if(!value||typeof value!=="object")continue;const item=value as Record<string,unknown>;if(typeof item.domain!=="string"||!item.domain||item.domain.length>253)continue;const seconds=Number(item.seconds);if(!Number.isFinite(seconds)||seconds<=0)continue;const category=normalizeContentCategory(item.contentCategory);const current=day.domains.get(item.domain);day.domains.set(item.domain,{domain:item.domain,seconds:(current?.seconds||0)+seconds,contentCategory:current&&current.contentCategory!==category?null:category});}}
  base.days=[...days].sort(([a],[b])=>b.localeCompare(a)).map(([date,day])=>({date,computedAt:day.computedAt.toISOString(),domains:[...day.domains.values()].sort((a,b)=>b.seconds-a.seconds||a.domain.localeCompare(b.domain)).slice(0,10)}));
  return {...base,state:base.days.length?"available":"unavailable",note:base.partial?"Some summaries are withheld because their full interval is not available within your selected access and retention window. Use detailed observations for those intervals.":"Summaries appear after daily or class reports are materialized. Missing summaries do not imply no browsing."};
}
