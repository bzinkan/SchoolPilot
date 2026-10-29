import { randomUUID } from "node:crypto";
import { deferUntilDatabaseCommit } from "../db.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { runWithoutTenantContext } from "../db/tenantContext.js";
import { ClasspilotWindowsError } from "./classpilotWindowsProtocol.js";
import { normalizeCommandPayload, classpilotCommandFrameForTarget, classpilotPersistedTargetAuthorityRevisions, classpilotRequiredToolsCapability } from "./classpilotCommandDispatcher.js";
import { classpilotCommandAuthorityEnvelope } from "./classpilotCommandAuthority.js";
import { classpilotCommandDeliveryPolicy } from "./classpilotCommandDelivery.js";
import { readClasspilotRealtimeStatusBatch, classpilotRealtimeFresh } from "./classpilotRealtimeStatus.js";
import { sendToStudentBindingLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import { createClasspilotCommandWithTargets, createClasspilotWindowsCommand, readClasspilotWindowsCommand, readClasspilotWindowsToolStart, listClasspilotWindowsBrowsers,
  getActiveSessionsForStudents, authorizeClasspilotWindowsCommand, classpilotNativeCurrentAuthority, lockClasspilotStudentControlAuthorities,
  withClasspilotStudentControlDeliveryAuthority, classpilotStudentRelayMessageAllowed, markClasspilotCommandTargetsSent, type NativeStorageDb, type ClasspilotCommandWithTargets } from "./storage.js";
import type { NativeContext } from "./classpilotNativeProtocol.js";
import type { NativeStaffScope } from "./classpilotNative.js";
import type { InsertClasspilotCommandTarget } from "../schema/classpilot.js";

export const WINDOWS_SHARED_TOOLS=new Set(["timer","poll","lesson-activity","teacher-message"]);

/** One resource/header, one frozen student audience, two independent transports. */
export async function createWindowsMixedTool(scope:NativeStaffScope,input:NativeContext&{targetStudentIds:string[];commandType:string;commandPayload:Record<string,unknown>},database:NativeStorageDb){
  const original=await readClasspilotWindowsToolStart({schoolId:scope.schoolId,...input,payload:input.commandPayload},database);
  const studentIds=original?[...new Set(original.command.targets.map(t=>t.studentId))]:input.targetStudentIds;
  if(!studentIds.length)throw new ClasspilotWindowsError("WINDOWS_TOOL_AUDIENCE_STALE",409);
  await lockClasspilotStudentControlAuthorities(scope.schoolId,studentIds,database);
  await authorizeClasspilotWindowsCommand({...scope,...input,studentIds},database);
  const normalized=await normalizeCommandPayload(input.commandType,input.commandPayload,scope.schoolId,scope.actorId,input.teachingSessionId,input.supervisionContextId);
  const bindings=await listClasspilotWindowsBrowsers(scope.schoolId,studentIds,database);
  const windowStudents=new Set(original?original.windowsTargets.map(t=>t.studentId):bindings.map(b=>b.browser.studentId));
  const sessions=await getActiveSessionsForStudents(scope.schoolId,studentIds.filter(id=>!windowStudents.has(id)),database);
  const capability=classpilotRequiredToolsCapability(input.commandType,normalized.payload);
  const legacyEvidence=capability?await readClasspilotRealtimeStatusBatch(scope.schoolId,sessions.map(s=>({studentId:s.studentId,studentSessionId:s.id,deviceId:s.deviceId}))):null;
  const legacyTargets:Array<InsertClasspilotCommandTarget>=studentIds.map(studentId=>{
    const old=original?.command.targets.find(t=>t.studentId===studentId);
    const session=sessions.find(s=>s.studentId===studentId&&(!original||(old?.studentSessionId===s.id&&old.deviceId===s.deviceId&&old.status!=="unavailable")));
    const snapshot=legacyEvidence?.get(studentId);
    const available=!!session&&(!capability||(snapshot?.status==="hit"&&classpilotRealtimeFresh(snapshot.snapshot)&&snapshot.snapshot.acceptedCapabilities?.includes(capability)));
    return {schoolId:scope.schoolId,teachingSessionId:input.teachingSessionId??null,supervisionContextId:input.supervisionContextId??null,commandId:"",studentId,
      studentSessionId:available?session!.id:null,deviceId:available?session!.deviceId:null,status:available?"requested":"unavailable",
      errorMessage:windowStudents.has(studentId)?"WINDOWS_BROWSER_AUDIENCE":available?null:"Student's original browser binding is unavailable"};
  });
  const id=randomUUID();
  const canonical=await createClasspilotCommandWithTargets({id,schoolId:scope.schoolId,teacherId:scope.actorId,teachingSessionId:input.teachingSessionId??null,
    supervisionContextId:input.supervisionContextId??null,targetScope:"students",commandType:input.commandType,commandPayload:normalized.payload,
    requestedCount:studentIds.length,expiresAt:new Date(Date.now()+15_000)},legacyTargets,{authority:{schoolId:scope.schoolId,actorId:scope.actorId,
      teachingSessionId:input.teachingSessionId,supervisionContextId:input.supervisionContextId,contextAuthorityRevision:scope.contextAuthorityRevision},pollMutation:normalized.extra?.pollMutation});
  const candidates=original?original.windowsTargets:bindings.map(({browser})=>({browserId:browser.id,studentId:browser.studentId,sourceRef:browser.sourceRef,bindingRevision:browser.bindingRevision}));
  const windowsTargets=[];
  for(const candidate of candidates){
    const live=bindings.find(b=>b.browser.id===candidate.browserId&&b.browser.sourceRef===candidate.sourceRef&&b.browser.bindingRevision===candidate.bindingRevision);
    const authority=await classpilotNativeCurrentAuthority(scope.schoolId,candidate.studentId,database);
    if(!authority)throw new ClasspilotWindowsError("WINDOWS_AUTHORITY_STALE",409);
    windowsTargets.push({id:randomUUID(),schoolId:scope.schoolId,commandId:id,browserId:candidate.browserId,studentId:candidate.studentId,
      sourceRef:candidate.sourceRef,bindingRevision:candidate.bindingRevision,controlRevision:authority.controlRevision,
      status:live&&(!capability||live.browser.acceptedCapabilities.includes(capability))?"pending":"stale"});
  }
  await createClasspilotWindowsCommand({id,schoolId:scope.schoolId,actorId:scope.actorId,teachingSessionId:canonical.teachingSessionId,supervisionContextId:canonical.supervisionContextId,
    contextAuthorityRevision:scope.contextAuthorityRevision??null,commandType:canonical.commandType,payload:canonical.commandPayload as Record<string,unknown>,expiresAt:canonical.expiresAt!},windowsTargets,database);
  deferUntilDatabaseCommit(()=>runWithoutTenantContext(()=>runWithTenantContext({schoolId:scope.schoolId},()=>deliverLegacyTool(canonical,normalized.extensionType))));
  return readClasspilotWindowsCommand(scope.schoolId,id,database);
}

async function deliverLegacyTool(command:ClasspilotCommandWithTargets,extensionType:string){
  for(const target of command.targets){
    if(target.status!=="requested"||!target.studentSessionId||!target.deviceId)continue;
    const exact={schoolId:command.schoolId,studentId:target.studentId,studentSessionId:target.studentSessionId,deviceId:target.deviceId};
    let frame:ReturnType<typeof classpilotCommandFrameForTarget>=null;
    const delivery=await withClasspilotStudentControlDeliveryAuthority(exact,async database=>{
      const authority=await classpilotStudentRelayMessageAllowed(exact,{commandId:command.id,authority:classpilotCommandAuthorityEnvelope(command).authority},database);
      if(!authority)return null;
      return classpilotCommandFrameForTarget(command.schoolId,command.commandType,extensionType,{...(command.commandPayload as object),commandId:command.id},
        {...exact,studentName:target.studentId,available:true,...classpilotPersistedTargetAuthorityRevisions(target.result)},
        {policy:classpilotCommandDeliveryPolicy(command.commandType),expiresAt:command.expiresAt,exactBindingControlRevision:classpilotPersistedTargetAuthorityRevisions(target.result).controlRevision},
        undefined,classpilotCommandAuthorityEnvelope(command));
    },(_claimed,prepared)=>{frame=prepared;return prepared?sendToStudentBindingLocal(exact,prepared):false;});
    if(delivery.authorized&&frame){
      const remote=await publishWS({kind:"student-binding",...exact},frame);
      if(delivery.value||remote)await markClasspilotCommandTargetsSent(command.id,[target.deviceId]);
    }
  }
}
