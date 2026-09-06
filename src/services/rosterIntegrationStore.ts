import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import db from "../db.js";
import { students } from "../schema/students.js";
import { groups, groupStudents, groupTeachers } from "../schema/classpilot.js";
import { schools, schoolMemberships, users } from "../schema/core.js";
import { auditLogs, importRuns } from "../schema/shared.js";
import { rosterIntegrationConnections as connections, rosterIntegrationRuns as runs, rosterIntegrationIdentities as identities, rosterIntegrationMemberships as memberships } from "../schema/rosterIntegrations.js";
import { encryptSecret } from "./crypto.js";
import { rosterError, rosterHash, type RosterMapping, type RosterPackage, type RosterProvider } from "./rosterIntegrationModel.js";
import { catalogueRosterHash, classRosterHash, planRosterImport, type CatalogueClass, type RosterCatalogue, type RosterPlan, type RosterStep } from "./rosterIntegrationPlanner.js";
import { assertStudentEmailNotUsedByStaff, staffIdentityEmailLockKey, takeStaffIdentityLocks, upsertAdminClassroomClass } from "./storage.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { assertRosterReviewPlan } from "./rosterIntegrationReview.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Connection = typeof connections.$inferSelect;
type Run = typeof runs.$inferSelect;
const STAGE_TTL_MS = 24 * 60 * 60 * 1000;
export function publicRosterConnection(row: Connection) {
  return { id: row.id, provider: row.provider, name: row.name, providerIdentity: row.providerIdentity, status: row.status, mapping: row.mapping, revision: row.revision, automaticSync: row.automaticSync, tokenConfigured: Boolean(row.encryptedToken), initialReviewedAt: row.initialReviewedAt, lastAttemptAt: row.lastAttemptAt, lastSuccessAt: row.lastSuccessAt, lastErrorCode: row.lastErrorCode };
}
export function publicRosterRun(row: Run) {
  const plan = row.plan as RosterPlan | null;
  return { id: row.id, connectionId: row.connectionId, status: row.status, automatic: row.automatic, cursor: row.cursor, totalSteps: row.totalSteps, summary: row.summary, errorCode: row.errorCode, createdAt: row.createdAt, expiresAt: row.expiresAt, planHash: row.planHash, mapping: row.mapping, organizations: row.snapshot?.organizations || [], version: row.snapshot?.version, warnings: plan?.warnings || row.snapshot?.warnings || [], holds: plan?.holds || [], unresolved: plan?.unresolved.slice(0,200) || [], unresolvedCount: plan?.unresolved.length || 0 };
}
export async function getRosterConnection(schoolId: string, connectionId: string): Promise<Connection> {
  const [row] = await db.select().from(connections).where(and(eq(connections.schoolId,schoolId),eq(connections.id,connectionId))).limit(1);
  if(!row) throw rosterError("ROSTER_CONNECTION_NOT_FOUND","Roster connection not found.",404); return row;
}
export async function listRosterConnections(schoolId: string) { return (await db.select().from(connections).where(eq(connections.schoolId,schoolId)).orderBy(desc(connections.createdAt))).map(publicRosterConnection); }
export async function disconnectRosterConnection(schoolId:string,id:string,userId:string,expectedRevision:number){
  return db.transaction(async tx=>{const [current]=await tx.select().from(connections).where(and(eq(connections.schoolId,schoolId),eq(connections.id,id))).for("update");if(!current)throw rosterError("ROSTER_CONNECTION_NOT_FOUND","Roster connection not found.",404);if(current.revision!==expectedRevision)throw rosterError("ROSTER_PREVIEW_STALE","The connection changed. Refresh before disconnecting.",409);const [row]=await tx.update(connections).set({encryptedToken:null,automaticSync:false,status:"paused",revision:current.revision+1,updatedAt:new Date()}).where(eq(connections.id,id)).returning();await tx.update(runs).set({status:"failed",errorCode:"ROSTER_CONNECTION_DISCONNECTED",updatedAt:new Date()}).where(and(eq(runs.connectionId,id),eq(runs.schoolId,schoolId),inArray(runs.status,["fetching","applying"])));await tx.insert(auditLogs).values({schoolId,userId,action:"roster_connection_disconnected",entityType:"roster_connection",entityId:id});return publicRosterConnection(row!);});
}
export async function saveRosterConnection(input: { schoolId: string; userId: string; id?: string; expectedRevision?: number; provider?: RosterProvider; providerIdentity?: string; name?: string; token?: string; automaticSync?: boolean; status?: "active"|"paused"; mapping?: RosterMapping }) {
  return db.transaction(async tx=>{
    let existing: Connection|undefined;
    if(input.id) [existing]=await tx.select().from(connections).where(and(eq(connections.schoolId,input.schoolId),eq(connections.id,input.id))).for("update");
    if(input.id && !existing) throw rosterError("ROSTER_CONNECTION_NOT_FOUND","Roster connection not found.",404);
    if(existing && existing.revision!==input.expectedRevision) throw rosterError("ROSTER_PREVIEW_STALE","The connection changed. Refresh before saving.",409);
    if(existing && (await tx.select({id:runs.id}).from(runs).where(and(eq(runs.schoolId,input.schoolId),eq(runs.connectionId,existing.id),eq(runs.status,"applying"))).limit(1)).length) throw rosterError("ROSTER_IMPORT_RUNNING","Finish the current import before changing its connection.",409);
    if(input.automaticSync && (!existing?.initialReviewedAt || existing.provider!=="clever")) throw rosterError("ROSTER_INITIAL_REVIEW_REQUIRED","Review and apply the first Clever import before enabling nightly sync.");
    const changes={...(input.name!==undefined?{name:input.name}:{}),...(input.mapping?{mapping:input.mapping}:{}),...(input.automaticSync!==undefined?{automaticSync:input.automaticSync}:{}),...(input.status?{status:input.status}:{}),...(input.token!==undefined?{encryptedToken:encryptSecret(input.token),status:"active"}:{}),updatedAt:new Date()};
    const [row]=existing ? await tx.update(connections).set({...changes,revision:existing.revision+1}).where(eq(connections.id,existing.id)).returning() : await tx.insert(connections).values({schoolId:input.schoolId,createdBy:input.userId,provider:input.provider!,providerIdentity:input.providerIdentity!,name:input.name!,...changes}).returning();
    await tx.insert(auditLogs).values({schoolId:input.schoolId,userId:input.userId,action:existing?"roster_connection_updated":"roster_connection_created",entityType:"roster_connection",entityId:row!.id,metadata:{provider:row!.provider,tokenChanged:input.token!==undefined}});
    return publicRosterConnection(row!);
  });
}
export async function stageRosterPackage(schoolId: string, connectionId: string, snapshot: RosterPackage, userId: string|null, automatic=false): Promise<Run> {
  const connection=await getRosterConnection(schoolId,connectionId);
  if(connection.provider!==snapshot.provider || connection.status!=="active") throw rosterError("ROSTER_CONNECTION_UNAVAILABLE","The connection is paused or does not match this package.");
  const [row]=await db.insert(runs).values({schoolId,connectionId,snapshot,requestedBy:userId,automatic,mapping:connection.mapping,expiresAt:new Date(Date.now()+STAGE_TTL_MS)}).returning(); return row!;
}
export async function getRosterRun(schoolId:string,id:string):Promise<Run>{const [row]=await db.select().from(runs).where(and(eq(runs.schoolId,schoolId),eq(runs.id,id))).limit(1);if(!row)throw rosterError("ROSTER_RUN_NOT_FOUND","Import not found.",404);return row;}
export async function queueCleverRosterSync(schoolId:string,connectionId:string,userId:string|null,automatic=false):Promise<Run>{
  const connection=await getRosterConnection(schoolId,connectionId);
  if(connection.provider!=="clever"||!connection.encryptedToken||connection.status!=="active")throw rosterError("CLEVER_RECONNECT_REQUIRED","Configure an active Clever connection with its district token.");
  const [existing]=await db.select().from(runs).where(and(eq(runs.schoolId,schoolId),eq(runs.connectionId,connectionId),inArray(runs.status,["fetching","applying"]))).limit(1);if(existing)return existing;
  const [row]=await db.insert(runs).values({schoolId,connectionId,requestedBy:userId,automatic,status:"fetching",mapping:connection.mapping,baseRevision:connection.revision,expiresAt:new Date(Date.now()+STAGE_TTL_MS)}).returning();return row!;
}
/** A reconnect, disconnect or mapping edit during paging invalidates the entire fetched snapshot. */
export async function finishCleverRosterFetch(schoolId:string,runId:string,expectedRevision:number,snapshot:RosterPackage):Promise<Run>{
  const run=await getRosterRun(schoolId,runId);
  return db.transaction(async tx=>{
    const [connection]=await tx.select().from(connections).where(and(eq(connections.schoolId,schoolId),eq(connections.id,run.connectionId))).for("update");
    if(!connection||connection.status!=="active"||connection.revision!==expectedRevision||run.baseRevision!==expectedRevision)throw rosterError("ROSTER_CONNECTION_CHANGED","The connection changed while Clever was fetched. Start a new sync.",409);
    if(connection.provider!=="clever"||snapshot.provider!=="clever"||!snapshot.complete)throw rosterError("CLEVER_INCOMPLETE_SNAPSHOT","Only a complete Clever snapshot can finish this sync.",409);
    if(run.expiresAt.getTime()<=Date.now())throw rosterError("ROSTER_STAGE_EXPIRED","The import expired while Clever was fetched. Start a new sync.",409);
    const [updated]=await tx.update(runs).set({snapshot,status:"staged",updatedAt:new Date()}).where(and(eq(runs.schoolId,schoolId),eq(runs.id,runId),eq(runs.status,"fetching"))).returning();
    if(!updated)throw rosterError("ROSTER_RUN_CHANGED","The import was stopped while Clever was fetched.",409);
    return updated;
  });
}
export async function listRosterRuns(schoolId:string,connectionId:string){return (await db.select().from(runs).where(and(eq(runs.schoolId,schoolId),eq(runs.connectionId,connectionId))).orderBy(desc(runs.createdAt)).limit(30)).map(publicRosterRun);}

/** Search bounded candidate DTOs instead of materializing a school's entire roster per keystroke. */
export async function findRosterCandidates(schoolId:string,connectionId:string,type:"student"|"teacher"|"class",search:string){
  await getRosterConnection(schoolId,connectionId);
  const term=search.trim().toLowerCase().slice(0,120);
  if(type==="class")return db.select({id:groups.id,label:groups.name}).from(groups).where(and(eq(groups.schoolId,schoolId),eq(groups.groupType,"admin_class"),eq(groups.status,"active"),sql`strpos(lower(${groups.name}),${term}) > 0`)).orderBy(groups.name,groups.id).limit(100);
  if(type==="student")return db.select({id:students.id,label:sql<string>`concat(${students.firstName},' ',${students.lastName},' · ',coalesce(${students.email},${students.studentIdNumber},''))`}).from(students).where(and(eq(students.schoolId,schoolId),eq(students.status,"active"),sql`strpos(lower(concat(${students.firstName},' ',${students.lastName},' ',${students.email},' ',${students.studentIdNumber})),${term}) > 0`)).orderBy(students.lastName,students.firstName,students.id).limit(100);
  return db.selectDistinct({id:users.id,label:sql<string>`concat(coalesce(${users.displayName},${users.email}),' · ',${users.email})`}).from(schoolMemberships).innerJoin(users,eq(users.id,schoolMemberships.userId)).innerJoin(schools,eq(schools.id,schoolMemberships.schoolId)).where(and(eq(schoolMemberships.schoolId,schoolId),eq(schoolMemberships.status,"active"),inArray(schoolMemberships.role,["teacher","admin","school_admin"]),sql`lower(split_part(${users.email},'@',2)) = lower(${schools.domain})`,sql`strpos(lower(concat(${users.displayName},' ',${users.email})),${term}) > 0`)).orderBy(users.id).limit(100);
}

export async function loadRosterCatalogue(schoolId:string,connectionId:string,database:typeof db=db):Promise<RosterCatalogue>{
  const [school]=await database.select({domain:schools.domain}).from(schools).where(eq(schools.id,schoolId)).limit(1);
  const studentRows=await database.select({id:students.id,firstName:students.firstName,lastName:students.lastName,email:students.email,emailLc:students.emailLc,studentIdNumber:students.studentIdNumber,gradeLevel:students.gradeLevel,status:students.status}).from(students).where(eq(students.schoolId,schoolId));
  const staffRows=await database.select({id:users.id,email:users.email,name:users.displayName,status:schoolMemberships.status}).from(schoolMemberships).innerJoin(users,eq(users.id,schoolMemberships.userId)).where(and(eq(schoolMemberships.schoolId,schoolId),inArray(schoolMemberships.role,["teacher","admin","school_admin"])));
  const teacherMap=new Map<string,RosterCatalogue["teachers"][number]>();
  for(const row of staffRows){if(teacherMap.get(row.id)?.status==="active"&&row.status!=="active")continue;teacherMap.set(row.id,{...row,name:row.name||row.email,domainEligible:Boolean(school?.domain&&row.email.toLowerCase().split("@")[1]===school.domain.toLowerCase())});}
  const groupRows=await database.select().from(groups).where(and(eq(groups.schoolId,schoolId),eq(groups.groupType,"admin_class")));
  const studentMemberships=await database.select({id:groupStudents.id,groupId:groupStudents.groupId,memberId:groupStudents.studentId}).from(groupStudents).innerJoin(groups,eq(groups.id,groupStudents.groupId)).where(eq(groups.schoolId,schoolId));
  const teacherMemberships=await database.select({id:groupTeachers.id,groupId:groupTeachers.groupId,memberId:groupTeachers.teacherId,role:groupTeachers.role}).from(groupTeachers).innerJoin(groups,eq(groups.id,groupTeachers.groupId)).where(eq(groups.schoolId,schoolId));
  const sourceIdentities=await database.select().from(identities).where(eq(identities.schoolId,schoolId));
  const sourceMemberships=await database.select().from(memberships).where(eq(memberships.schoolId,schoolId));
  const studentMap=new Map<string,CatalogueClass["students"]>();for(const row of studentMemberships){const current=studentMap.get(row.groupId)||[];current.push({id:row.id,memberId:row.memberId});studentMap.set(row.groupId,current);}
  const teacherGroups=new Map<string,CatalogueClass["teachers"]>();for(const row of teacherMemberships){const current=teacherGroups.get(row.groupId)||[];current.push({id:row.id,memberId:row.memberId,role:row.role});teacherGroups.set(row.groupId,current);}
  return {students:studentRows,teachers:[...teacherMap.values()],classes:groupRows.map(row=>({id:row.id,name:row.name,gradeLevel:row.gradeLevel,term:row.term,teacherId:row.teacherId,status:row.status,archivedAt:row.archivedAt?.toISOString()||null,scheduleEnabled:row.scheduleEnabled,blockStartTime:row.blockStartTime,blockEndTime:row.blockEndTime,groupType:row.groupType,scheduleRule:row.scheduleRule,students:studentMap.get(row.id)||[],teachers:teacherGroups.get(row.id)||[]})),identities:sourceIdentities.filter(row=>row.connectionId===connectionId),otherSourceClassIds:[...new Set(sourceIdentities.filter(row=>row.connectionId!==connectionId&&row.entityType==="class"&&row.sourcePresent).map(row=>row.internalId))].sort(),memberships:sourceMemberships.map(({connectionId,groupId,memberId,memberType,role,ownsMembership,manualPreserved,sourcePresent,physicalRowId})=>({connectionId,groupId,memberId,memberType,role,ownsMembership,manualPreserved,sourcePresent,physicalRowId})),schoolDomain:school?.domain?.toLowerCase()||null};
}
export async function previewRosterRun(schoolId:string,runId:string,mapping:RosterMapping,expectedRevision?:number):Promise<Run>{
  const run=await getRosterRun(schoolId,runId); if(!["staged","preview","held","failed"].includes(run.status)||!run.snapshot||run.expiresAt.getTime()<Date.now())throw rosterError("ROSTER_RUN_EXPIRED","This import cannot be previewed; upload or fetch a new package.",409);
  const connection=await getRosterConnection(schoolId,run.connectionId);
  if(expectedRevision!==undefined&&connection.revision!==expectedRevision)throw rosterError("ROSTER_CONNECTION_CHANGED","The connection changed before the fetched roster was previewed. Start a new sync.",409);
  const catalogue=await loadRosterCatalogue(schoolId,run.connectionId);const plan=planRosterImport(run.snapshot,mapping,catalogue,connection.id); const planHash=rosterHash({plan,mapping,revision:connection.revision});
  const [updated]=await db.update(runs).set({mapping,plan,planHash,baseRevision:connection.revision,cursor:0,totalSteps:plan.steps.length,summary:plan.summary,status:plan.holds.length?"held":"preview",updatedAt:new Date()}).where(and(eq(runs.schoolId,schoolId),eq(runs.id,runId),inArray(runs.status,["staged","preview","held","failed"]))).returning();if(!updated)throw rosterError("ROSTER_PREVIEW_STALE","The import changed. Refresh the preview.",409);return updated;
}
export async function assertApplyAuthority(tx:Transaction,schoolId:string,userId:string|null){
  await assertClasspilotEntitled(schoolId,tx as unknown as typeof db,{lock:true});
  if(userId){const [member]=await tx.select({id:schoolMemberships.id}).from(schoolMemberships).where(and(eq(schoolMemberships.schoolId,schoolId),eq(schoolMemberships.userId,userId),eq(schoolMemberships.status,"active"),inArray(schoolMemberships.role,["admin","school_admin"]))).limit(1);if(!member)throw rosterError("ROSTER_ADMIN_REQUIRED","Active school administrator access is required.",403);}
}
async function lockStep(tx:Transaction,run:Run,cursor:number){
  await assertApplyAuthority(tx,run.schoolId,run.requestedBy);
  const [current]=await tx.select().from(runs).where(and(eq(runs.schoolId,run.schoolId),eq(runs.id,run.id))).for("update");
  if(!current||current.status!=="applying"||current.cursor!==cursor)throw rosterError("ROSTER_STEP_CHANGED","This step was already processed. Refresh the import.",409);
  const [connection]=await tx.select().from(connections).where(and(eq(connections.id,run.connectionId),eq(connections.schoolId,run.schoolId))).limit(1);
  if(!connection||connection.status!=="active"||connection.revision!==run.baseRevision)throw rosterError("ROSTER_PREVIEW_STALE","The connection changed after this preview.",409);
}
async function checkpoint(tx:Transaction,run:Run,cursor:number,step:RosterStep,lastApplied:Record<string,unknown>){
  const entityType=step.kind==="archive"?"class":step.kind;
  await tx.insert(identities).values({schoolId:run.schoolId,connectionId:run.connectionId,entityType,externalId:step.externalId,internalId:step.internalId,ownedFields:step.ownedFields,lastApplied,sourceCreated:step.sourceCreated,sourcePresent:step.kind!=="archive",lastRunId:run.id}).onConflictDoUpdate({target:[identities.schoolId,identities.connectionId,identities.entityType,identities.externalId],set:{ownedFields:step.ownedFields,lastApplied,sourcePresent:step.kind!=="archive",lastRunId:run.id,updatedAt:new Date()}});
  await tx.update(runs).set({cursor:cursor+1,updatedAt:new Date(),errorCode:null}).where(eq(runs.id,run.id));
}
async function executeRosterStep(run:Run,cursor:number,step:RosterStep){
  if(step.kind==="student"||step.kind==="teacher")return db.transaction(async tx=>{
    await lockStaffAssignmentLifecycleSchool(tx,run.schoolId); await lockStep(tx,run,cursor);
    if(step.kind==="teacher"){
      const [school]=await tx.select({domain:schools.domain}).from(schools).where(eq(schools.id,run.schoolId));
      const [person]=await tx.select({id:users.id,email:users.email,name:users.displayName,status:schoolMemberships.status}).from(schoolMemberships).innerJoin(users,eq(users.id,schoolMemberships.userId)).where(and(eq(schoolMemberships.schoolId,run.schoolId),eq(schoolMemberships.userId,step.internalId),eq(schoolMemberships.status,"active"),inArray(schoolMemberships.role,["teacher","admin","school_admin"]))).limit(1);
      const teacher=person?{...person,name:person.name||person.email,domainEligible:Boolean(school?.domain&&person.email.toLowerCase().split("@")[1]===school.domain.toLowerCase())}:undefined;
      if(!teacher||rosterHash(teacher)!==step.expectedHash||!teacher.domainEligible||teacher.status!=="active")throw rosterError("ROSTER_PREVIEW_STALE","A teacher changed after preview. Create a new preview.",409);
      await checkpoint(tx,run,cursor,step,{});return;
    }
    const [current]=await tx.select({id:students.id,firstName:students.firstName,lastName:students.lastName,email:students.email,emailLc:students.emailLc,studentIdNumber:students.studentIdNumber,gradeLevel:students.gradeLevel,status:students.status}).from(students).where(and(eq(students.schoolId,run.schoolId),eq(students.id,step.internalId))).for("update");
    if((step.create&&current)||(!step.create&&(!current||rosterHash(current)!==step.expectedHash)))throw rosterError("ROSTER_PREVIEW_STALE","A student changed after preview. Create a new preview.",409);
    const email=typeof step.data.emailLc==="string"?step.data.emailLc:null;
    if(email){await takeStaffIdentityLocks(tx as unknown as typeof db,[staffIdentityEmailLockKey(email)]);await assertStudentEmailNotUsedByStaff(run.schoolId,email,tx as unknown as typeof db);const [school]=await tx.select({domain:schools.domain}).from(schools).where(eq(schools.id,run.schoolId));if(!school?.domain||email.split("@")[1]!==school.domain.toLowerCase())throw rosterError("ROSTER_EMAIL_DOMAIN_CHANGED","The student email no longer matches this school's domain.",409);}
    const data=step.data as Partial<typeof students.$inferInsert>;
    if(step.create)await tx.insert(students).values({...data,id:step.internalId,schoolId:run.schoolId,firstName:String(data.firstName),lastName:String(data.lastName),status:"active"});
    else if(Object.keys(data).length)await tx.update(students).set({...data,updatedAt:new Date()}).where(and(eq(students.schoolId,run.schoolId),eq(students.id,step.internalId)));
    await checkpoint(tx,run,cursor,step,{...(current||{}),...step.data});
  });
  let before:CatalogueClass|undefined;let contributions: RosterCatalogue["memberships"]=[];
  await upsertAdminClassroomClass({schoolId:run.schoolId,existingGroupId:step.create?undefined:step.internalId,data:{...step.data,...(step.create?{id:step.internalId,groupType:"admin_class",status:"active",scheduleEnabled:false}:{}),...(step.kind==="archive"?{archivedAt:new Date(),status:"archived",scheduleEnabled:false}:{})},primaryTeacherId:step.primaryTeacherId,coTeacherIds:step.coTeacherIds,studentIds:step.studentIds,replaceStudentRoster:true,scheduleChangeActorId:run.requestedBy||undefined,
    beforeWrite:async(tx,current)=>{
      await lockStep(tx,run,cursor);
      if(current){const studentRows=await tx.select({id:groupStudents.id,memberId:groupStudents.studentId}).from(groupStudents).where(eq(groupStudents.groupId,current.id));const teacherRows=await tx.select({id:groupTeachers.id,memberId:groupTeachers.teacherId,role:groupTeachers.role}).from(groupTeachers).where(eq(groupTeachers.groupId,current.id));before={id:current.id,name:current.name,gradeLevel:current.gradeLevel,term:current.term,teacherId:current.teacherId,status:current.status,archivedAt:current.archivedAt?.toISOString()||null,scheduleEnabled:current.scheduleEnabled,scheduleRule:current.scheduleRule,blockStartTime:current.blockStartTime,blockEndTime:current.blockEndTime,groupType:current.groupType,students:studentRows,teachers:teacherRows};}
      contributions=await tx.select().from(memberships).where(and(eq(memberships.schoolId,run.schoolId),eq(memberships.groupId,step.internalId)));
      if((step.create&&before)||(!step.create&&(!before||classRosterHash(before)!==step.expectedHash)))throw rosterError("ROSTER_PREVIEW_STALE","A class or its roster changed after preview. Review again.",409);
      if(step.kind==="archive" || (before?.status === "archived" && step.data.status === "active")){
        const other=await tx.select({id:identities.id}).from(identities).where(and(eq(identities.schoolId,run.schoolId),eq(identities.entityType,"class"),eq(identities.internalId,step.internalId),sql`${identities.connectionId} <> ${run.connectionId}`,eq(identities.sourcePresent,true))).limit(1);
        if(other.length)throw rosterError("ROSTER_CLASS_SHARED","A class shared with another integration cannot be archived or restored by this import.",409);
        if (step.kind !== "archive") {
          const [source] = await tx.select().from(identities).where(and(eq(identities.schoolId,run.schoolId),eq(identities.connectionId,run.connectionId),eq(identities.entityType,"class"),eq(identities.externalId,step.externalId))).limit(1);
          if (!source?.sourceCreated || source.sourcePresent || source.lastApplied.status !== "archived" || !before?.archivedAt || source.lastApplied.archivedAt !== before.archivedAt) throw rosterError("ROSTER_PREVIEW_STALE","The source archive changed after preview. Review this class again.",409);
        }
      }
      // A manual add can be an ON CONFLICT no-op, so membership row identity alone is insufficient.
      for(const member of contributions.filter(row=>row.connectionId===run.connectionId&&row.groupId===step.internalId&&row.manualPreserved)){
        const retained=member.memberType==="student"?step.studentIds:step.coTeacherIds;
        if(step.kind==="archive"||(!retained?.includes(member.memberId)&&step.primaryTeacherId!==member.memberId))throw rosterError("ROSTER_PREVIEW_STALE","A manual roster contribution changed after preview.",409);
      }
    },
    afterWrite:async(tx,group)=>{
      if(step.kind!=="archive"){
        const studentRows=await tx.select().from(groupStudents).where(eq(groupStudents.groupId,group.id));const teacherRows=await tx.select().from(groupTeachers).where(eq(groupTeachers.groupId,group.id));
        // Canonical class mutations can recreate junction rows. Carry other sources' existing
        // ownership forward only when their original physical row was still authoritative.
        for(const contribution of contributions.filter(row=>row.connectionId!==run.connectionId)){
          const previous=(contribution.memberType==="student"?before?.students:before?.teachers)?.find(row=>row.memberId===contribution.memberId);
          const physical=contribution.memberType==="student"?studentRows.find(row=>row.studentId===contribution.memberId):teacherRows.find(row=>row.teacherId===contribution.memberId);
          if(previous?.id===contribution.physicalRowId&&physical)await tx.update(memberships).set({physicalRowId:physical.id,updatedAt:new Date()}).where(and(eq(memberships.schoolId,run.schoolId),eq(memberships.connectionId,contribution.connectionId),eq(memberships.groupId,group.id),eq(memberships.memberType,contribution.memberType),eq(memberships.memberId,contribution.memberId)));
        }
        await tx.update(memberships).set({sourcePresent:false,lastRunId:run.id,updatedAt:new Date()}).where(and(eq(memberships.schoolId,run.schoolId),eq(memberships.connectionId,run.connectionId),eq(memberships.groupId,group.id)));
        for(const type of ["student","teacher"] as const){
          const desired=type==="student"?step.sourceStudentIds||[]:step.sourceTeacherIds||[];
          for(const memberId of desired){
            const physical=type==="student"?studentRows.find(row=>row.studentId===memberId):teacherRows.find(row=>row.teacherId===memberId);
            const old=contributions.find(row=>row.connectionId===run.connectionId&&row.groupId===group.id&&row.memberType===type&&row.memberId===memberId);
            const wasPresent=(type==="student"?before?.students:before?.teachers)?.some(row=>row.memberId===memberId)===true;
            const manual=old?.manualPreserved===true||(!old&&wasPresent);const owns=old?.ownsMembership??!wasPresent;
            await tx.insert(memberships).values({schoolId:run.schoolId,connectionId:run.connectionId,groupId:group.id,memberId,memberType:type,role:type==="student"?"student":memberId===group.teacherId?"primary":"co-teacher",ownsMembership:owns,manualPreserved:manual,sourcePresent:true,physicalRowId:physical?.id||null,lastRunId:run.id}).onConflictDoUpdate({target:[memberships.schoolId,memberships.connectionId,memberships.groupId,memberships.memberType,memberships.memberId],set:{sourcePresent:true,physicalRowId:physical?.id||null,manualPreserved:manual,role:type==="student"?"student":memberId===group.teacherId?"primary":"co-teacher",lastRunId:run.id,updatedAt:new Date()}});
          }
        }
      } else await tx.update(memberships).set({sourcePresent:false,lastRunId:run.id,updatedAt:new Date()}).where(and(eq(memberships.schoolId,run.schoolId),eq(memberships.connectionId,run.connectionId),eq(memberships.groupId,group.id)));
      await checkpoint(tx,run,cursor,step,{name:group.name,gradeLevel:group.gradeLevel,term:group.term,teacherId:group.teacherId,status:group.status,archivedAt:group.archivedAt?.toISOString()||null});
    }
  });
}

/** Checkpoint commits with each school-authorized mutation. A restart resumes the next uncommitted step. */
export async function applyRosterRun(schoolId:string,runId:string,planHash:string,userId:string|null,approveHeld=false,maxSteps=25):Promise<Run>{
  let run=await getRosterRun(schoolId,runId); const plan=run.plan as RosterPlan|null;
  if(run.status==="completed")return run;
  if(!plan||run.planHash!==planHash||run.expiresAt.getTime()<Date.now())throw rosterError("ROSTER_PREVIEW_STALE","The preview is missing, expired, or changed.",409);
  assertRosterReviewPlan(plan,run.planHash,planHash);
  if(plan.unresolved.length||plan.holds.includes("incomplete_snapshot"))throw rosterError("ROSTER_REVIEW_REQUIRED","Resolve every identity and provide a complete snapshot before applying.",409);
  if(run.status!=="applying"){
    if(!["preview","held","failed"].includes(run.status))throw rosterError("ROSTER_RUN_STATE","This import is not ready to apply.",409);
    if(plan.holds.length&&!approveHeld)throw rosterError("ROSTER_REVIEW_REQUIRED","This import is held for explicit administrator review.",409);
    if(!userId && plan.holds.length)throw rosterError("ROSTER_REVIEW_REQUIRED","An administrator must approve the held import.",409);
    const connection=await getRosterConnection(schoolId,run.connectionId);
    if(connection.revision!==run.baseRevision)throw rosterError("ROSTER_PREVIEW_STALE","The connection changed after preview.",409);
    if(run.cursor===0&&catalogueRosterHash(await loadRosterCatalogue(schoolId,run.connectionId))!==plan.catalogueHash)throw rosterError("ROSTER_PREVIEW_STALE","School roster data changed after preview. Review a fresh preview.",409);
    const [updated]=await db.update(runs).set({status:"applying",requestedBy:userId||run.requestedBy,updatedAt:new Date(),errorCode:null}).where(and(eq(runs.schoolId,schoolId),eq(runs.id,runId),inArray(runs.status,["preview","held","failed"]))).returning();if(!updated)throw rosterError("ROSTER_RUN_CHANGED","This import is already being processed.",409);run=updated;
  }
  const end=Math.min(plan.steps.length,run.cursor+Math.max(1,Math.min(maxSteps,100)));
  try {
    for(let cursor=run.cursor;cursor<end;cursor++)await executeRosterStep(run,cursor,plan.steps[cursor]!);
    if(end===plan.steps.length)await db.transaction(async tx=>{
      await lockStaffAssignmentLifecycleSchool(tx,schoolId);await lockStep(tx,run,end);
      await tx.update(runs).set({status:"completed",updatedAt:new Date(),snapshot:null,plan:null}).where(eq(runs.id,run.id));
      await tx.update(connections).set({mapping:run.mapping!,revision:sql`${connections.revision}+1`,initialReviewedAt:sql`COALESCE(${connections.initialReviewedAt},now())`,lastSuccessAt:new Date(),lastErrorCode:null,updatedAt:new Date()}).where(eq(connections.id,run.connectionId));
      await tx.update(identities).set({sourcePresent:false,updatedAt:new Date()}).where(and(eq(identities.schoolId,schoolId),eq(identities.connectionId,run.connectionId),inArray(identities.entityType,["student","teacher"]),sql`${identities.lastRunId} <> ${run.id}`));
      await tx.insert(importRuns).values({schoolId,userId:run.requestedBy,source:run.snapshot?.provider||"roster_integration",scope:"mapped_school",totalFound:plan.steps.length,imported:plan.summary.createStudents+plan.summary.createClasses,updated:plan.summary.updateStudents+plan.summary.updateClasses,skipped:0,warnings:plan.warnings});
      await tx.insert(auditLogs).values({schoolId,userId:run.requestedBy,action:"roster_import_completed",entityType:"roster_import",entityId:run.id,metadata:plan.summary});
    });
  }catch(error){
    const code=String((error as {code?:string}).code||"ROSTER_APPLY_FAILED");
    if(code!=="ROSTER_STEP_CHANGED")await db.update(runs).set({status:"failed",errorCode:code,updatedAt:new Date()}).where(and(eq(runs.id,run.id),eq(runs.status,"applying")));
    throw error;
  }
  return getRosterRun(schoolId,runId);
}

export async function purgeRosterIntegrationStages(database:typeof db=db):Promise<void>{
  await database.update(runs).set({snapshot:null,plan:null,status:"expired",errorCode:"ROSTER_STAGE_EXPIRED",updatedAt:new Date()}).where(and(lt(runs.expiresAt,new Date()),inArray(runs.status,["fetching","staged","preview","held","failed","applying"])));
}
