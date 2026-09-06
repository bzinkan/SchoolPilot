import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema/index.js";
import { tenantALS, rlsGucEnabled } from "../db/tenantContext.js";
import { schedulerDb, schedulerPool } from "./schedulerDb.js";
import { rosterIntegrationConnections as connections, rosterIntegrationRuns as runs } from "../schema/rosterIntegrations.js";
import { schools } from "../schema/core.js";
import { decryptSecret } from "./crypto.js";
import { fetchCleverRoster } from "./cleverRosterClient.js";
import { applyRosterRun, assertApplyAuthority, finishCleverRosterFetch, getRosterConnection, getRosterRun, previewRosterRun, purgeRosterIntegrationStages, queueCleverRosterSync } from "./rosterIntegrationStore.js";
import { rosterError, rosterLocalSchedule } from "./rosterIntegrationModel.js";
import type { RosterPlan } from "./rosterIntegrationPlanner.js";

export { rosterLocalSchedule } from "./rosterIntegrationModel.js";

/** Called by the existing singleton scheduler. Uses only its dedicated pool, never an API checkout. */
export async function runDueRosterIntegrationJobs(now=new Date()):Promise<{processed:number;reason?:string}>{
  if(!rlsGucEnabled()){
    await schedulerDb.update(connections).set({lastErrorCode:"ROSTER_WORKER_RLS_REQUIRED"}).where(and(eq(connections.provider,"clever"),eq(connections.status,"active")));
    await schedulerDb.update(runs).set({status:"failed",errorCode:"ROSTER_WORKER_RLS_REQUIRED",updatedAt:now}).where(eq(runs.status,"fetching"));
    await purgeRosterIntegrationStages(schedulerDb);
    return {processed:0,reason:"ROSTER_WORKER_RLS_REQUIRED"};
  }
  const client=await schedulerPool.connect();let discard:Error|undefined;let processed=0;
  try{
    const lock=await client.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtextextended('roster-integration-worker',0::bigint)) AS locked");
    if(!lock.rows[0]?.locked)return {processed:0};
    const candidates=await schedulerDb.select({connection:connections,timeZone:schools.schoolTimezone}).from(connections).innerJoin(schools,eq(schools.id,connections.schoolId)).where(eq(connections.status,"active"));
    for(const {connection,timeZone} of candidates){
      const local=rosterLocalSchedule(now,timeZone);
      const pending=await schedulerDb.select({id:runs.id}).from(runs).where(and(eq(runs.schoolId,connection.schoolId),eq(runs.connectionId,connection.id),inArray(runs.status,["fetching","applying"]))).limit(1);
      const due=connection.provider==="clever"&&connection.automaticSync&&connection.initialReviewedAt&&local.due&&connection.lastAttemptLocalDate!==local.date;
      if(!due&&!pending.length)continue;
      await client.query("SELECT set_config('app.school_id',$1,false),set_config('app.is_super','off',false)",[connection.schoolId]);
      const scoped=drizzle(client,{schema});
      await tenantALS.run({client,db:scoped,schoolId:connection.schoolId,isSuper:false},async()=>{
        let runId=pending[0]?.id;
        if(!runId&&due){
          const [claimed]=await scoped.update(connections).set({lastAttemptLocalDate:local.date,lastAttemptAt:now}).where(and(eq(connections.schoolId,connection.schoolId),eq(connections.id,connection.id),sql`${connections.lastAttemptLocalDate} IS DISTINCT FROM ${local.date}`)).returning({id:connections.id});
          if(!claimed)return;runId=(await queueCleverRosterSync(connection.schoolId,connection.id,null,true)).id;
        }
        if(!runId)return;
        try{
          let run=await getRosterRun(connection.schoolId,runId);
          if(run.status==="fetching"){
            await scoped.transaction(tx=>assertApplyAuthority(tx,connection.schoolId,run.requestedBy));
            const current=await getRosterConnection(connection.schoolId,connection.id);
            if(!current.encryptedToken)throw rosterError("CLEVER_RECONNECT_REQUIRED","Reconnect Clever before syncing.");
            if(run.baseRevision!==current.revision||current.status!=="active")throw rosterError("ROSTER_CONNECTION_CHANGED","The connection changed before the sync started. Start a new sync.",409);
            if(run.expiresAt.getTime()<=Date.now())throw rosterError("ROSTER_STAGE_EXPIRED","The queued import expired. Start a new sync.",409);
            const snapshot=await fetchCleverRoster(current.providerIdentity,decryptSecret(current.encryptedToken));
            run=await finishCleverRosterFetch(connection.schoolId,run.id,current.revision,snapshot);
            if(current.mapping.organizationIds.length)run=await previewRosterRun(connection.schoolId,run.id,current.mapping,current.revision);else run=await getRosterRun(connection.schoolId,run.id);
            await scoped.update(connections).set({lastAttemptAt:new Date(),lastErrorCode:null}).where(eq(connections.id,current.id));
          }
          if(run.status==="applying"||(run.automatic&&run.status==="preview"&&!(run.plan as RosterPlan).holds.length))await applyRosterRun(connection.schoolId,run.id,run.planHash!,null,false,100);
          processed++;
        }catch(error){
          const code=String((error as {code?:string}).code||"ROSTER_SYNC_FAILED");
          await scoped.update(runs).set({status:"failed",errorCode:code,updatedAt:new Date()}).where(and(eq(runs.id,runId),inArray(runs.status,["fetching","applying"])));
          await scoped.update(connections).set({lastErrorCode:code,...(code==="CLEVER_RECONNECT_REQUIRED"?{status:"reconnect_required",automaticSync:false}:{})}).where(eq(connections.id,connection.id));
        }
      });
      if(processed>=1)break;
    }
    await client.query("SELECT set_config('app.school_id','',false),set_config('app.is_super','on',false)");
    await purgeRosterIntegrationStages(schedulerDb);
    return {processed};
  }finally{
    try{await client.query("SELECT pg_advisory_unlock(hashtextextended('roster-integration-worker',0::bigint)),set_config('app.school_id','',false),set_config('app.is_super','on',false)");}catch(error){discard=error instanceof Error?error:new Error("Roster worker scope reset failed");}
    client.release(discard);
  }
}
