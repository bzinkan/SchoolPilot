import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { ClasspilotWindowsError, WINDOWS_LIMITS, WINDOWS_POLICY_COMMANDS, WINDOWS_TAB_COMMANDS, createWindowsCredential, parseWindowsCredential, requireWindowsEnabled, windowsBrowserEnabled, windowsSameContext, nativeSecretHash, type WindowsTarget } from "./classpilotWindowsProtocol.js";
import { parseNativeCredential, createNativeCredential, ClasspilotNativeError, type NativeContext } from "./classpilotNativeProtocol.js";
import { classpilotWindowsStore as store } from "./classpilotWindowsStore.js";
import { resolveWindowsScreenshotPolicy } from "./classpilotWindowsScreenshotPolicy.js";
import type { ClasspilotScreenshotAuthorityClaim } from "./storage.js";
import { verifyClassPilotPin } from "./classpilotPins.js";
import { negotiateClasspilotProtocol,isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import { applyClasspilotControlCommand, serializeClasspilotStudentControlStateForDelivery,classpilotCommandPayloadRequiresPreciseCapability } from "./classpilotClassroomState.js";
import { classpilotControlStateExactBinding } from "./classpilotControlStateFrame.js";
import { classpilotAckControlRevision, classpilotAckEnvelopeMatchesBinding } from "./classpilotAckBinding.js";
import { terminalClasspilotCommandAckReceipt } from "./classpilotAckReceipt.js";
import { validateClasspilotCommandPayload } from "./classpilotCommandValidation.js";
import { classpilotFullMonitoringDeadline, resolveClasspilotMonitoringPolicy } from "./classpilotMonitoringPolicy.js";
import { requireScheduledClassroomRequestRevision } from "./classpilotActivityAuthority.js";
import { normalizeClasspilotPublicClassroomControls, classpilotPublicRealtimeBinding } from "./classpilotRealtimeStatus.js";
import { normalizeClasspilotNativeJpeg } from "./classpilotNativeImage.js";
import { recordWindowsObservation } from "./classpilotWindowsHistory.js";
import { getSchoolWebsitePolicy } from "./classpilotSchoolWebsitePolicy.js";
import { privateChatMessageLifecycle } from "./classpilotPrivateChatLifecycle.js";
import { classpilotFlightPathApplyPayload, requirePreciseRestrictionResourcesActive } from "./classpilotPreciseRestrictions.js";
import { classpilotSsoPolicyApprovesObservedUrl } from "./classpilotHeartbeatSsoSanitizer.js";
import { buildStudentFabState } from "./classpilotFab.js";
import { createWindowsMixedTool, WINDOWS_SHARED_TOOLS } from "./classpilotWindowsTools.js";
import { readClasspilotWindowsCoverage,setClasspilotWindowsCapabilityBlock } from "./storage.js";
import { classpilotExactTabCloseVersion } from "./classpilotExactTabCapability.js";
import { classpilotRequiredToolsCapability } from "./classpilotCommandDispatcher.js";
import { isSharedTeachingResourcesEnabled } from "../config/sharedTeachingResources.js";
import { getFlightPathById,getBlockListById,revokeClasspilotNativeInstallation } from "./storage.js";
import { withClasspilotWindowsAuthority, createClasspilotNativeEnrollment, redeemClasspilotNativeEnrollment, readClasspilotNativeInstallation, findClasspilotNativeStudent, createClasspilotWindowsGuard, readClasspilotWindowsGuard, renewClasspilotWindowsGuard, endClasspilotWindowsGuard, createClasspilotWindowsProof, redeemClasspilotWindowsProof, readClasspilotWindowsBrowser, touchClasspilotWindowsBrowser, listClasspilotWindowsBrowsers, authorizeClasspilotNativeStudents, authorizeClasspilotWindowsCommand, classpilotNativeCurrentAuthority, classpilotNativeEntitlementDeadline, getHeartbeatTrackingSettingsForSchool, getClasspilotStudentControlState, readClasspilotWindowsSettings, createClasspilotWindowsCommand, readClasspilotWindowsCommand, pendingClasspilotWindowsCommands, updateClasspilotWindowsTarget, setClasspilotWindowsRestrictions, getApplicableFlightPathById, getApplicableBlockListById, lockClasspilotStudentControlAuthorities, getClasspilotSsoPolicyForSchool, setClasspilotWindowsBrowserOverride, readClasspilotWindowsChatMessages, type NativeStorageDb } from "./storage.js";
import type { WindowsGuard, WindowsBrowser } from "../schema/classpilotWindows.js";
import type { NativeStaffScope } from "./classpilotNative.js";

export type WindowsScope=NativeStaffScope;
export type WindowsBinding=Awaited<ReturnType<typeof readClasspilotWindowsBrowser>>;
const WINDOWS_UNAVAILABLE_AUDIENCE="_windowsUnavailableStudentTargets";
const unavailableAudienceSchema=z.array(z.object({id:z.string().uuid(),studentId:z.string().min(1),code:z.literal("WINDOWS_SOURCE_UNAVAILABLE")}).strict());
function windowsUnavailableAudience(payload:Record<string,unknown>){return unavailableAudienceSchema.parse(payload[WINDOWS_UNAVAILABLE_AUDIENCE]??[]);}
function windowsPublicCommandPayload(payload:Record<string,unknown>){const publicPayload={...payload};delete publicPayload[WINDOWS_UNAVAILABLE_AUDIENCE];return publicPayload;}
const unsupportedWindowsCapabilities=new Set(["liveViewIceServersV1","liveViewNegotiationV1","kioskLaunchTicketV1","kioskLaunchTicketV2","managedDeviceContinuityV1","safetyEvidenceCaptureV1","screenshotObservationLeaseV1","screenshotReadOnlyObservationV1"]);
function currentWindowsCapabilities(browser:WindowsBrowser){
  return negotiateClasspilotProtocol({clientProtocolVersion:3,advertisedCapabilities:browser.acceptedCapabilities.filter(cap=>!unsupportedWindowsCapabilities.has(cap)),scope:{schoolId:browser.schoolId}}).acceptedCapabilities;
}
function unsupportedWindowsCommand(browser:WindowsBrowser,type:string,payload:Record<string,unknown>):string|null{
  if(type==="student-sign-out")return null; // server retires the guard; no client implementation is trusted.
  const caps=currentWindowsCapabilities(browser);
  if(!caps.includes("scopedAuthorityChecksV1")||!caps.includes("exactBindingAckV2"))return "exactBindingAckV2";
  if(type==="close-tabs"&&Array.isArray(payload.tabsToClose)&&!classpilotExactTabCloseVersion({...browser,acceptedCapabilities:caps}))return "exactTabCloseV2";
  if((type==="activate-tab"||type==="focus-tab"||payload.focusAfterOpen===true)&&!caps.includes("focusTabV1"))return "focusTabV1";
  if(type==="unlock-screen"&&payload.screenOnly===true&&!browser.extensionCapabilities.includes("screenOnlyUnlockV1"))return "screenOnlyUnlockV1";
  if(classpilotCommandPayloadRequiresPreciseCapability(type,payload)&&!caps.includes("preciseRestrictionResourcesV1"))return "preciseRestrictionResourcesV1";
  const tool=classpilotRequiredToolsCapability(type,payload);return tool&&!caps.includes(tool)?tool:null;
}
export function withWindowsSchool<T>(schoolId:string,studentIds:string[],action:(database:NativeStorageDb)=>Promise<T>){
  requireWindowsEnabled(schoolId);
  return runWithTenantContext({schoolId},()=>withClasspilotWindowsAuthority(schoolId,studentIds,action));
}
export async function withWindowsBrowser<T>(token:string,source:{sourceRef:string;bindingRevision:number}|undefined,action:(binding:WindowsBinding,database:NativeStorageDb)=>Promise<T>){
  const credential=parseWindowsCredential(token,"browser");
  return withWindowsSchool(credential.schoolId,[],async database=>{
    const binding=await readClasspilotWindowsBrowser(credential,source,database);
    binding.browser.acceptedCapabilities=currentWindowsCapabilities(binding.browser);
    await lockClasspilotStudentControlAuthorities(credential.schoolId,[binding.student.id],database);
    const result=await action(binding,database);
    if(binding.guard.expiresAt.getTime()<=Date.now()||binding.guard.absoluteExpiresAt.getTime()<=Date.now())throw new ClasspilotWindowsError("WINDOWS_CREDENTIAL_INVALID",401);
    return result;
  });
}
async function withGuard<T>(token:string,action:(guard:WindowsGuard,database:NativeStorageDb)=>Promise<T>){
  const credential=parseWindowsCredential(token,"guard");
  return withWindowsSchool(credential.schoolId,[],async database=>{const {guard}=await readClasspilotWindowsGuard(credential.schoolId,credential.id,database,credential.tokenHash);return action(guard,database);});
}
const times=(guard:WindowsGuard)=>({guardRevision:1,expiresAt:guard.expiresAt.toISOString(),absoluteExpiresAt:guard.absoluteExpiresAt.toISOString(),serverTime:new Date().toISOString(),renewAfterSeconds:WINDOWS_LIMITS.renewSeconds});
function staffRequest(scope:WindowsScope,context:NativeContext){return {...scope,...context,contextAuthorityRevision:context.supervisionContextId?requireScheduledClassroomRequestRevision(scope.contextAuthorityRevision):undefined};}
export async function issueWindowsEnrollment(scope:WindowsScope){const issued=createNativeCredential("enroll",scope.schoolId);return withWindowsSchool(scope.schoolId,[],async database=>{const token=await createClasspilotNativeEnrollment({...scope,id:issued.id,tokenHash:issued.tokenHash},database);return {enrollmentToken:issued.credential,expiresAt:token.expiresAt.toISOString()};});}
export async function revokeWindowsInstallation(scope:WindowsScope,id:string){return withWindowsSchool(scope.schoolId,[],database=>revokeClasspilotNativeInstallation(scope.schoolId,scope.actorId,id,database));}
export async function enrollWindowsInstallation(input:{enrollmentToken:string;clientVersion:string},ip:string){const credential=parseNativeCredential(input.enrollmentToken,"enroll");requireWindowsEnabled(credential.schoolId);await store.rateLimit(["enroll",ip],10,600_000);const issued=createNativeCredential("install",credential.schoolId);return withWindowsSchool(credential.schoolId,[],async database=>{await redeemClasspilotNativeEnrollment(credential,{id:issued.id,tokenHash:issued.tokenHash,clientVersion:input.clientVersion},database);return {installationCredential:issued.credential,schoolId:credential.schoolId};});}
export async function signInWindowsGuard(token:string,input:{identifier:string;pin:string;osSessionNonce:string},ip:string){
  const credential=parseNativeCredential(token,"install");
  await withWindowsSchool(credential.schoolId,[],database=>readClasspilotNativeInstallation(credential,database));
  await store.rateLimit(["pin-installation",credential.schoolId,credential.id],20,300_000);await store.rateLimit(["pin-ip",ip],100,300_000);
  return withWindowsSchool(credential.schoolId,[],async database=>{
    let student:Awaited<ReturnType<typeof findClasspilotNativeStudent>>;
    try{student=await findClasspilotNativeStudent(credential.schoolId,input.identifier,database);}catch(error){
      if(error instanceof ClasspilotNativeError&&error.code==="NATIVE_CREDENTIAL_INVALID")throw new ClasspilotWindowsError("WINDOWS_CREDENTIAL_INVALID",401);
      throw error;
    }
    const key=["pin-student",credential.schoolId,credential.id,student.id];await store.checkLimit(key,5);
    if(!(await verifyClassPilotPin(student,input.pin)).ok){await store.rateLimit(key,5,300_000);throw new ClasspilotWindowsError("WINDOWS_CREDENTIAL_INVALID",401);}
    await lockClasspilotStudentControlAuthorities(credential.schoolId,[student.id],database);
    const issued=createWindowsCredential("guard",credential.schoolId);
    const {guard}=await createClasspilotWindowsGuard({credential,id:issued.id,tokenHash:issued.tokenHash,studentId:student.id,osSessionNonce:input.osSessionNonce,studentCredentialFingerprint:nativeSecretHash(JSON.stringify([student.classpilotPinHash,student.classpilotPinEncrypted]))},database);
    return {guardCredential:issued.credential,schoolId:credential.schoolId,student:{id:student.id,displayName:`${student.firstName} ${student.lastName}`.trim()},...times(guard)};
  });
}
export async function renewWindowsGuard(token:string,nonce:string){const credential=parseWindowsCredential(token,"guard");return withWindowsSchool(credential.schoolId,[],async database=>times(await renewClasspilotWindowsGuard(credential,nonce,database)));}
export async function signOutWindowsGuard(token:string){return withGuard(token,(guard,database)=>endClasspilotWindowsGuard(guard,database));}
export async function issueWindowsPairingProof(token:string,input:{browserFamily:string;profileId:string;challenge:string}){return withGuard(token,async(guard,database)=>{await store.rateLimit(["proof",guard.schoolId,guard.id],20,60_000);const issued=createWindowsCredential("proof",guard.schoolId);const row=await createClasspilotWindowsProof(guard,{...input,id:issued.id,tokenHash:issued.tokenHash},database);return {proof:issued.credential,expiresAt:row.expiresAt.toISOString(),serverTime:new Date().toISOString()};});}
async function windowsPolicy(binding:WindowsBinding,database:NativeStorageDb,login?:true){
  const {browser,guard}=binding;
  const settings=await readClasspilotWindowsSettings(browser.schoolId,database);
  const tracking=await getHeartbeatTrackingSettingsForSchool(browser.schoolId,database,{lock:true,bypassCache:true});
  const monitoring=resolveClasspilotMonitoringPolicy(tracking,{acceptedCapabilities:browser.acceptedCapabilities});
  const authority=await classpilotNativeCurrentAuthority(browser.schoolId,browser.studentId,database);
  const state=authority?await getClasspilotStudentControlState(browser.schoolId,browser.studentId,database):undefined;
  const sso=await getClasspilotSsoPolicyForSchool(browser.schoolId,database);
  const classroomState=state&&browser.acceptedCapabilities.includes("scopedAuthorityChecksV1")&&browser.capabilityBlockedRevision!==state.revision?serializeClasspilotStudentControlStateForDelivery({state,
    gateActive:isClasspilotCapabilityActive("lateSignInRestrictionSsoV1",{schoolId:browser.schoolId}),acceptedCapabilities:browser.acceptedCapabilities,
    exactBinding:{schoolId:browser.schoolId,studentId:browser.studentId,studentSessionId:browser.id,deviceId:browser.id},
    authPassThrough:{gateActive:isClasspilotCapabilityActive("restrictionAuthPassThroughV1",{schoolId:browser.schoolId}),policyRevision:sso.revision,policy:sso.policy},...(login?{portalFirstOnLogin:true as const}:{})}).classroomState:null;
  if(classroomState&&browser.restrictionOverride?.controlRevision===classroomState.revision)classroomState.restrictions.screenLock=browser.restrictionOverride.screenLock;
  const schoolWebsitePolicy=await getSchoolWebsitePolicy(browser.schoolId);
  const deadline=Math.min(guard.expiresAt.getTime(),guard.absoluteExpiresAt.getTime(),await classpilotNativeEntitlementDeadline(browser.schoolId,database),authority?.expiresAt??Infinity);
  const expiresAt=tracking&&monitoring.policyMode==="full"?classpilotFullMonitoringDeadline(tracking,Date.now(),deadline):Date.now();
  const exactBinding=classpilotControlStateExactBinding({schoolId:browser.schoolId,studentId:browser.studentId,studentSessionId:browser.id,deviceId:browser.id,controlRevision:authority?.controlRevision??0});
  const claim:ClasspilotScreenshotAuthorityClaim&{contextAuthorityRevision?:string}=authority?.teachingSessionId?{kind:"teaching_session",teachingSessionId:authority.teachingSessionId,controlRevision:authority.controlRevision}:authority?.supervisionContextId?{kind:"supervision_context",supervisionContextId:authority.supervisionContextId,controlRevision:authority.controlRevision,contextAuthorityRevision:authority.contextAuthorityRevision}:{kind:"student_session",controlRevision:0};
  const screenshotPolicy=await resolveWindowsScreenshotPolicy({schoolId:browser.schoolId,studentId:browser.studentId,acceptedCapabilities:browser.acceptedCapabilities,trackingSettings:tracking,authority:claim,authorityStartedAt:browser.createdAt,expiresAt});
  const publicSettings={enableTrackingHours:settings?.enableTrackingHours??false,trackingStartTime:settings?.trackingStartTime??null,trackingEndTime:settings?.trackingEndTime??null,trackingDays:settings?.trackingDays??[],schoolTimezone:settings?.schoolTimezone??null,afterHoursMode:settings?.afterHoursMode??"off",instructionalCalendar:tracking?.instructionalCalendar??{},schedulingDateOverrides:tracking?.schedulingDateOverrides??{},maxTabsPerStudent:settings?.maxTabsPerStudent?Number(settings.maxTabsPerStudent):null};
  const fab=await buildStudentFabState(browser.schoolId,browser.studentId,{schoolSettings:settings,studentSessionId:browser.id,windowsDeviceId:browser.id,acceptedCapabilities:browser.acceptedCapabilities,dbInstance:database});
  return {settings:publicSettings,...publicSettings,schoolId:browser.schoolId,studentId:browser.studentId,studentSessionId:browser.id,serverProtocolVersion:3,acceptedCapabilities:browser.acceptedCapabilities,monitoringPolicy:monitoring,trackingPolicy:monitoring,planStatus:{active:true},...schoolWebsitePolicy,classroomState,
    fab:monitoring.mode==="full"?fab:{...fab,messagingEnabled:false,handRaisingEnabled:false,handRaised:false,messagesPaused:false,pauseReason:null,messagingChannelEnabled:false,classTools:null},
    exactBinding,screenshotPolicy,
    guardExpiresAt:guard.expiresAt.toISOString(),absoluteExpiresAt:guard.absoluteExpiresAt.toISOString(),serverTime:new Date().toISOString(),authority,expiresAt};
}
export async function pairWindowsBrowser(input:{proof:string;browserFamily:string;profileId:string;challenge:string;clientProtocolVersion:number;extensionVersion:string;capabilities:string[]},ip:string){
  const credential=parseWindowsCredential(input.proof,"proof");requireWindowsEnabled(credential.schoolId);await store.rateLimit(["pair",ip],100,60_000);
  return withWindowsSchool(credential.schoolId,[],async database=>{
    const protocol=negotiateClasspilotProtocol({clientProtocolVersion:input.clientProtocolVersion,advertisedCapabilities:input.capabilities.filter(cap=>!unsupportedWindowsCapabilities.has(cap)),scope:{schoolId:credential.schoolId}});
    const issued=createWindowsCredential("browser",credential.schoolId);
    const binding=await redeemClasspilotWindowsProof(credential,{...input,acceptedCapabilities:protocol.acceptedCapabilities},issued,database);
    await lockClasspilotStudentControlAuthorities(credential.schoolId,[binding.student.id],database);
    const {authority:_authority,expiresAt:_expiresAt,...policy}=await windowsPolicy(binding,database,true);
    return {...policy,studentToken:issued.credential,student:{id:binding.student.id,firstName:binding.student.firstName,lastName:binding.student.lastName,displayName:`${binding.student.firstName} ${binding.student.lastName}`.trim()},deviceId:binding.browser.id,sourceRef:binding.browser.sourceRef,bindingRevision:binding.browser.bindingRevision,browserFamily:binding.browser.browserFamily,...protocol};
  });
}
const tabsSchema=z.array(z.object({tabRef:z.string().min(1).max(200).optional(),url:z.string().max(4096),title:z.string().max(512),active:z.boolean().optional(),favicon:z.string().max(4096).optional()}).strip()).max(50);
const positiveSequence=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export async function windowsHeartbeat(token:string,input:Record<string,unknown>){return withWindowsBrowser(token,{sourceRef:z.string().uuid().parse(input.sourceRef),bindingRevision:z.number().int().positive().parse(input.bindingRevision)},async(binding,database)=>{
  const {browser,guard}=binding;const sequence=positiveSequence.parse(input.sequence);
  await store.rateLimit(["heartbeat",browser.schoolId,browser.id],30,60_000);
  const policy=await windowsPolicy(binding,database);
  const tabs=tabsSchema.parse(input.allOpenTabs??(Array.isArray(input.tabSnapshot)?input.tabSnapshot:[]));
  const telemetry={sourceRef:browser.sourceRef,bindingRevision:browser.bindingRevision,controlRevision:policy.authority?.controlRevision??0,sequence,observedAt:new Date().toISOString(),
    tabSnapshot:{tabs},tabSnapshotRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.tabSnapshotRevision??(input.tabSnapshot&&typeof input.tabSnapshot==="object"&&!Array.isArray(input.tabSnapshot)?(input.tabSnapshot as Record<string,unknown>).revision:undefined)??sequence),
    activeTabUrl:z.string().max(4096).parse(input.activeTabUrl??""),activeTabTitle:z.string().max(512).parse(input.activeTabTitle??""),activeTabRef:typeof input.activeTabRef==="string"?input.activeTabRef.slice(0,200):null,
    openTabCount:Math.min(1000,Math.max(tabs.length,Number(input.openTabCount)||0)),classroomControls:normalizeClasspilotPublicClassroomControls(input.classroomControls??input)};
  Object.assign(telemetry.tabSnapshot,{revision:telemetry.tabSnapshotRevision});
  if(policy.monitoringPolicy.policyMode==="full")await store.put("telemetry",browser.schoolId,browser.sourceRef,telemetry,Math.min(policy.expiresAt,Date.now()+45_000),sequence);
  await recordWindowsObservation(binding,database,input,{authority:policy.authority,expiresAt:policy.expiresAt,policyMode:policy.monitoringPolicy.policyMode});
  await touchClasspilotWindowsBrowser(browser,database);
  const messages=[];
  for(const {command,target} of await pendingClasspilotWindowsCommands(browser,database)){
    const current=policy.authority;
    if(!current||!windowsSameContext(command,current)||target.controlRevision!==current.controlRevision||target.sourceRef!==browser.sourceRef||target.bindingRevision!==browser.bindingRevision||unsupportedWindowsCommand(browser,command.commandType,command.payload)){await updateClasspilotWindowsTarget(target.id,browser.schoolId,{status:"stale"},database);continue;}
    try{await authorizeClasspilotWindowsCommand({schoolId:browser.schoolId,actorId:command.actorId,studentIds:[browser.studentId],commandType:command.commandType,teachingSessionId:command.teachingSessionId??undefined,supervisionContextId:command.supervisionContextId??undefined,contextAuthorityRevision:command.contextAuthorityRevision??undefined},database);}catch(error){if(error instanceof ClasspilotWindowsError){await updateClasspilotWindowsTarget(target.id,browser.schoolId,{status:"stale"},database);continue;}throw error;}
    const envelope={studentId:browser.studentId,studentSessionId:browser.id,exactBinding:policy.exactBinding,sourceRef:browser.sourceRef,bindingRevision:browser.bindingRevision,expiresAt:command.expiresAt.toISOString(),teachingSessionId:command.teachingSessionId,supervisionContextId:command.supervisionContextId,contextAuthorityRevision:command.contextAuthorityRevision,authority:{teachingSessionId:command.teachingSessionId,supervisionContextId:command.supervisionContextId}};
    let data=windowsPublicCommandPayload(command.payload);
    if(data.url==="CURRENT_URL")data.url=policy.classroomState?.restrictions.screenLock.url;
    if(command.commandType==="activate-tab"||command.commandType==="focus-tab"){const tab=(data.tabTargets as Array<Record<string,unknown>>)?.find(t=>t.studentId===browser.studentId);data={tabRef:tab?.tabRef,observedRevision:tab?.observedRevision};}
    if(command.commandType==="close-tabs"&&Array.isArray(data.tabsToClose)){const tabs=(data.tabsToClose as Array<Record<string,unknown>>).filter(t=>t.studentId===browser.studentId);data={closeAll:data.closeAll,tabRefs:tabs.map(t=>t.tabRef),snapshotRevision:tabs[0]?.observedRevision};}
    messages.push(command.commandType==="teacher-message"?{type:"teacher-message",_msgId:`${target.id}:${browser.bindingRevision}`,commandId:command.id,commandTargetId:target.id,...envelope,message:data.message,fromName:"Teacher"}:
      {type:"remote-control",_msgId:`${target.id}:${browser.bindingRevision}`,commandId:command.id,commandTargetId:target.id,...envelope,command:{id:command.id,commandId:command.id,type:command.commandType==="close-tabs"&&data.closeAll!==true?"close-tab":command.commandType,data,...envelope},...(policy.classroomState?{classroomState:policy.classroomState}:{})});
    await updateClasspilotWindowsTarget(target.id,browser.schoolId,{status:"delivered",deliveredAt:new Date()},database);
  }
  if(policy.monitoringPolicy.mode==="full"&&browser.acceptedCapabilities.includes("privateChatLifecycleV1"))for(const message of await readClasspilotWindowsChatMessages(browser,database))messages.push({type:"teacher-message",_msgId:message.id,messageId:message.id,studentId:browser.studentId,studentSessionId:browser.id,exactBinding:policy.exactBinding,teachingSessionId:message.sessionId,supervisionContextId:message.supervisionContextId,message:message.content,privateChatLifecycle:privateChatMessageLifecycle(message),fromName:"Teacher"});
  const {authority:_authority,expiresAt:_expiresAt,...publicPolicy}=policy;
  return {...publicPolicy,sourceRef:browser.sourceRef,bindingRevision:browser.bindingRevision,acceptedCapabilities:browser.acceptedCapabilities,messages};
});}
let activeWindowsDecodes=0;
export async function acceptWindowsScreenshot(token:string,input:Record<string,unknown>){
  const source={sourceRef:z.string().uuid().parse(input.sourceRef),bindingRevision:z.number().int().positive().parse(input.bindingRevision)};
  const encoded=z.string().max(360_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/).parse(input.screenshot??input.image);
  await withWindowsBrowser(token,source,async()=>undefined);
  if(activeWindowsDecodes>=2)throw new ClasspilotWindowsError("WINDOWS_IMAGE_BUSY",429);
  activeWindowsDecodes++;
  const raw=Buffer.from(encoded.slice(encoded.indexOf(",")+1),"base64");let normalized:Buffer|undefined;
  try{normalized=await normalizeClasspilotNativeJpeg(raw);const screenshot=`data:image/jpeg;base64,${normalized.toString("base64")}`;
    return await withWindowsBrowser(token,source,async(binding,database)=>{
      const sequence=positiveSequence.parse(input.sequence);const capturedAt=z.string().datetime({offset:true}).parse(input.capturedAt);const captured=Date.parse(capturedAt);
      const policy=await windowsPolicy(binding,database);const authority=policy.authority;
      const claimed=z.object({kind:z.enum(["teaching_session","supervision_context","student_session"]),teachingSessionId:z.string().optional(),supervisionContextId:z.string().optional(),controlRevision:z.number().int().nonnegative(),contextAuthorityRevision:z.string().optional()}).strict().parse(input.screenshotAuthority);
      if(!policy.screenshotPolicy.captureAllowed||claimed.controlRevision!==(authority?.controlRevision??0)||!windowsSameContext(claimed,authority??{})||claimed.kind!==(authority?.teachingSessionId?"teaching_session":authority?.supervisionContextId?"supervision_context":"student_session")||(authority?.supervisionContextId&&claimed.contextAuthorityRevision!==authority.contextAuthorityRevision)||captured>Date.now()+1000||Date.now()-captured>5000||captured<binding.browser.createdAt.getTime())throw new ClasspilotWindowsError("WINDOWS_AUTHORITY_STALE",409);
      const expiresAt=Math.min(policy.expiresAt,captured+45_000);
      if(!authority){
        await store.put("image-health",binding.browser.schoolId,binding.browser.sourceRef,{...source,sequence,observedAt:new Date().toISOString(),status:"discarded_no_class"},expiresAt,sequence);
        return {ok:true,discarded:true,serverTime:new Date().toISOString()};
      }
      const tabUrl=z.string().max(4096).parse(input.tabUrl??input.url??"");const tabTitle=z.string().max(512).parse(input.tabTitle??input.title??"");
      await store.put("image",binding.browser.schoolId,binding.browser.sourceRef,{...source,controlRevision:authority?.controlRevision??0,screenshot,screenshotAt:capturedAt,expiresAt:new Date(expiresAt).toISOString(),sequence,tabUrl,tabTitle},expiresAt,sequence);
      return {ok:true,expiresAt:new Date(expiresAt).toISOString(),serverTime:new Date().toISOString()};
    });
  }finally{raw.fill(0);normalized?.fill(0);activeWindowsDecodes--;}
}
export async function windowsTiles(scope:WindowsScope,input:NativeContext&{studentIds:string[];selectedSources?:WindowsTarget[]}){
  if(!windowsBrowserEnabled(scope.schoolId))return {enabled:false,tiles:[],serverTime:new Date().toISOString()};
  return withWindowsSchool(scope.schoolId,input.studentIds,async database=>{
    const allowed=await authorizeClasspilotNativeStudents({...staffRequest(scope,input),studentIds:input.studentIds},database);
    if(allowed.size!==input.studentIds.length)throw new ClasspilotWindowsError("WINDOWS_NOT_AUTHORIZED");
    const bindings=await listClasspilotWindowsBrowsers(scope.schoolId,input.studentIds,database);
    const tiles=[];
    for(const studentId of input.studentIds){const sources:Array<Record<string,unknown>>=[];const authority=await classpilotNativeCurrentAuthority(scope.schoolId,studentId,database);
      for(const {browser,guard} of bindings.filter(row=>row.browser.studentId===studentId)){
        const source:Record<string,unknown>={sourceRef:browser.sourceRef,bindingRevision:browser.bindingRevision,browserFamily:browser.browserFamily,isLoggedIn:Date.now()-browser.lastSeenAt.getTime()<45_000,lastSeenAt:browser.lastSeenAt.toISOString(),extensionVersion:browser.extensionVersion,clientProtocolVersion:browser.clientProtocolVersion,acceptedCapabilities:currentWindowsCapabilities(browser),extensionCapabilities:browser.extensionCapabilities,expiresAt:guard.expiresAt.toISOString()};
        const selected=input.selectedSources?.some(t=>t.studentId===studentId&&t.sourceRef===browser.sourceRef&&t.bindingRevision===browser.bindingRevision);
        if(selected&&authority&&windowsSameContext(authority,input)){
          const tracking=await getHeartbeatTrackingSettingsForSchool(scope.schoolId,database,{lock:true,bypassCache:true});
          if(tracking&&resolveClasspilotMonitoringPolicy(tracking).policyMode==="full"){
            const visibilityExpiresAt=classpilotFullMonitoringDeadline(tracking,Date.now(),Math.min(guard.expiresAt.getTime(),authority.expiresAt,
              browser.lastSeenAt.getTime()+45_000,await classpilotNativeEntitlementDeadline(scope.schoolId,database)));
            source.expiresAt=new Date(visibilityExpiresAt).toISOString();
            const telemetry=await store.get("telemetry",scope.schoolId,browser.sourceRef);
            if(telemetry?.bindingRevision===browser.bindingRevision&&telemetry.controlRevision===authority.controlRevision)Object.assign(source,telemetry);
            const image=await store.get("image",scope.schoolId,browser.sourceRef);
            if(image?.bindingRevision===browser.bindingRevision&&image.controlRevision===authority.controlRevision){
              const expiresAt=Math.min(Date.parse(String(image.expiresAt)),visibilityExpiresAt);
              if(expiresAt>Date.now())Object.assign(source,image,{expiresAt:new Date(expiresAt).toISOString()});
            }
          }
        }
        sources.push(source);
      }
      const coverage=(await readClasspilotWindowsCoverage(scope.schoolId,[studentId],database)).get(studentId);
      if(coverage?.state==="legacy"){
        tiles.push({studentId,browserSources:[],browserOwner:{transport:"legacy",realtimeBinding:classpilotPublicRealtimeBinding(coverage.studentSessionId)}});
        continue;
      }
      tiles.push({studentId,browserSources:sources,...(coverage?{platform:"windows",windowsSession:coverage,browserCoverage:["chrome","edge"].map(browserFamily=>{
        const source=sources.find(source=>source.browserFamily===browserFamily);
        return {browserFamily,state:coverage.state!=="active"?"unverifiable":!source?"unpaired":source.isLoggedIn?"connected":"disconnected"};
      })}:{})});
    }
    for(const tile of tiles)for(const source of tile.browserSources){if(Date.parse(String(source.expiresAt))<=Date.now()){
      for(const key of["screenshot","screenshotAt","tabSnapshot","tabSnapshotRevision","activeTabUrl","activeTabTitle","activeTabRef","openTabCount","classroomControls","aiClassification","aiCategory","tabUrl","tabTitle","observedAt"])delete source[key];
      source.isLoggedIn=false;
    }}
    return {enabled:true,tiles,serverTime:new Date().toISOString()};
  });
}

export async function dispatchWindowsCommand(scope:WindowsScope,input:NativeContext&{targetScope:"students";targetStudentIds:string[];commandType:string;commandPayload:Record<string,unknown>;browserTargets?:WindowsTarget[]}){
  if(Object.hasOwn(input.commandPayload,WINDOWS_UNAVAILABLE_AUDIENCE))throw new ClasspilotWindowsError("WINDOWS_INVALID_REQUEST",400);
  const payload=validateClasspilotCommandPayload(input.commandType,input.commandPayload);
  if(!WINDOWS_POLICY_COMMANDS.has(input.commandType)&&!WINDOWS_TAB_COMMANDS.has(input.commandType)&&!["timer","poll","teacher-message","lesson-activity"].includes(input.commandType))throw new ClasspilotWindowsError("WINDOWS_COMMAND_UNSUPPORTED",400);
  return withWindowsSchool(scope.schoolId,input.targetStudentIds,async database=>{
    const request={...staffRequest(scope,input),studentIds:input.targetStudentIds,commandType:input.commandType};
    await authorizeClasspilotWindowsCommand(request,database);
    if(WINDOWS_SHARED_TOOLS.has(input.commandType))return publicWindowsCommand(await createWindowsMixedTool({...scope,contextAuthorityRevision:request.contextAuthorityRevision},input,database));
    let bindings=await listClasspilotWindowsBrowsers(scope.schoolId,input.targetStudentIds,database);
    if(WINDOWS_TAB_COMMANDS.has(input.commandType)){
      const targets=input.browserTargets??[];
      if(targets.length!==input.targetStudentIds.length||new Set(targets.map(t=>t.studentId)).size!==targets.length||targets.some(t=>!input.targetStudentIds.includes(t.studentId)))throw new ClasspilotWindowsError("WINDOWS_TARGET_REQUIRED",400);
      bindings=bindings.filter(({browser})=>targets.some(t=>t.studentId===browser.studentId&&t.sourceRef===browser.sourceRef&&t.bindingRevision===browser.bindingRevision));
      if(bindings.length!==targets.length)throw new ClasspilotWindowsError("WINDOWS_BINDING_STALE",409);
    }
    // Preserve the entire authorized explicit audience. An offline student is
    // an immutable unavailable result, never a fabricated browser binding and
    // never grounds for preventing policy delivery to the available peers.
    const unavailableStudents=input.targetStudentIds.filter(id=>!bindings.some(row=>row.browser.studentId===id));
    const unavailableAudience=unavailableStudents.map(studentId=>({id:randomUUID(),studentId,code:"WINDOWS_SOURCE_UNAVAILABLE" as const}));
    if(input.commandType==="apply-flight-path"){
      const path=await (isSharedTeachingResourcesEnabled(scope.schoolId)?getApplicableFlightPathById:getFlightPathById)(String(payload.flightPathId),scope.schoolId,scope.actorId);
      if(!path||(payload.expectedFlightPathUpdatedAt&&new Date(String(payload.expectedFlightPathUpdatedAt)).getTime()!==path.updatedAt?.getTime()))throw new ClasspilotWindowsError("WINDOWS_RESOURCE_STALE",409);
      Object.assign(payload,classpilotFlightPathApplyPayload({schoolId:scope.schoolId,flightPath:path}));
    }
    if(input.commandType==="apply-block-list"){
      const list=await (isSharedTeachingResourcesEnabled(scope.schoolId)?getApplicableBlockListById:getBlockListById)(String(payload.blockListId),scope.schoolId,scope.actorId);
      if(!list)throw new ClasspilotWindowsError("WINDOWS_RESOURCE_STALE",409);
      Object.assign(payload,{blockedDomains:list.blockedDomains,blockListName:list.name});
    }
    const unsupported=new Map(bindings.map(({browser})=>[browser.id,unsupportedWindowsCommand(browser,input.commandType,payload)]));
    if(WINDOWS_TAB_COMMANDS.has(input.commandType))for(const {browser} of bindings){
      if(unsupported.get(browser.id))continue;
      const selections=(Array.isArray(payload.tabTargets)?payload.tabTargets:Array.isArray(payload.tabsToClose)?payload.tabsToClose:[]) as Array<{studentId:string;tabRef:string;observedRevision:number}>;
      if(selections.length){const snapshot=await store.get("telemetry",scope.schoolId,browser.sourceRef);const tabs=((snapshot?.tabSnapshot as {tabs?:Array<{tabRef?:string}>}|undefined)?.tabs??[]);
        const own=selections.filter(t=>t.studentId===browser.studentId);
        if(!own.length||own.some(t=>t.observedRevision!==snapshot?.tabSnapshotRevision||!tabs.some(tab=>tab.tabRef===t.tabRef)))throw new ClasspilotWindowsError("WINDOWS_TAB_SNAPSHOT_STALE",409);
      }
    }
    if(payload.resource!==undefined)requirePreciseRestrictionResourcesActive(scope.schoolId);
    const currentPageUrls=new Map<string,string>();
    if(payload.url==="CURRENT_URL"){
      const sso=await getClasspilotSsoPolicyForSchool(scope.schoolId);
      for(const {browser} of bindings){const snapshot=await store.get("telemetry",scope.schoolId,browser.sourceRef);const url=String(snapshot?.activeTabUrl??"");
        if(unsupported.get(browser.id))continue;
        const authority=await classpilotNativeCurrentAuthority(scope.schoolId,browser.studentId,database);
        if(!authority||snapshot?.controlRevision!==authority.controlRevision||snapshot?.bindingRevision!==browser.bindingRevision||!/^https?:\/\//i.test(url)||classpilotSsoPolicyApprovesObservedUrl(url,sso.policy))throw new ClasspilotWindowsError("WINDOWS_CURRENT_PAGE_UNAVAILABLE",409);
        currentPageUrls.set(browser.id,url);
      }
    }
    const id=randomUUID();let expiresAt=Date.now()+15_000;
    const targets=[];
    for(const studentId of input.targetStudentIds){
      if(unavailableStudents.includes(studentId))continue;
      let control=await getClasspilotStudentControlState(scope.schoolId,studentId,database);
      const authority=await classpilotNativeCurrentAuthority(scope.schoolId,studentId,database);
      if(!control||!authority)throw new ClasspilotWindowsError("WINDOWS_AUTHORITY_STALE",409);
      const hasCapableSource=bindings.some(row=>row.browser.studentId===studentId&&!unsupported.get(row.browser.id));
      if(hasCapableSource&&WINDOWS_POLICY_COMMANDS.has(input.commandType)&&input.commandType!=="student-sign-out"){
        const desired=(control.desiredState??{}) as Record<string,unknown>;
        const restrictions=currentPageUrls.size?applyClasspilotControlCommand(desired.restrictions??desired,"unlock-screen",{screenOnly:true}):applyClasspilotControlCommand(desired.restrictions??desired,input.commandType,payload);
        if(input.commandType==="stop-focus")delete (restrictions as unknown as Record<string,unknown>).focus;
        control=await setClasspilotWindowsRestrictions(scope.schoolId,studentId,{...desired,restrictions},database);
      }
      expiresAt=Math.min(expiresAt,authority.expiresAt);
      for(const {browser,guard} of bindings.filter(row=>row.browser.studentId===studentId)){
        expiresAt=Math.min(expiresAt,guard.expiresAt.getTime());
        const missing=unsupported.get(browser.id);
        if(WINDOWS_POLICY_COMMANDS.has(input.commandType)&&input.commandType!=="student-sign-out")await setClasspilotWindowsCapabilityBlock(browser,missing?control.revision:null,database);
        if(missing){targets.push({id:randomUUID(),schoolId:scope.schoolId,commandId:id,browserId:browser.id,studentId,sourceRef:browser.sourceRef,bindingRevision:browser.bindingRevision,controlRevision:control.revision,status:"stale",result:{code:"WINDOWS_CAPABILITY_REQUIRED",capability:missing}});continue;}
        if(currentPageUrls.size)await setClasspilotWindowsBrowserOverride(browser,{controlRevision:control.revision,screenLock:{active:true,url:currentPageUrls.get(browser.id)!}},database);
        else if(WINDOWS_POLICY_COMMANDS.has(input.commandType)&&browser.restrictionOverride?.controlRevision===control.revision-1&&!["lock-screen","unlock-screen","apply-flight-path"].includes(input.commandType))await setClasspilotWindowsBrowserOverride(browser,{...browser.restrictionOverride,controlRevision:control.revision},database);
        targets.push({id:randomUUID(),schoolId:scope.schoolId,commandId:id,browserId:browser.id,studentId,sourceRef:browser.sourceRef,bindingRevision:browser.bindingRevision,controlRevision:control.revision,status:input.commandType==="student-sign-out"?"succeeded":"pending"});
      }
    }
    await createClasspilotWindowsCommand({id,schoolId:scope.schoolId,actorId:scope.actorId,teachingSessionId:input.teachingSessionId??null,supervisionContextId:input.supervisionContextId??null,contextAuthorityRevision:request.contextAuthorityRevision??null,commandType:input.commandType,payload:{...payload,...(unavailableAudience.length?{[WINDOWS_UNAVAILABLE_AUDIENCE]:unavailableAudience}:{})},expiresAt:new Date(expiresAt)},targets,database);
    if(input.commandType==="student-sign-out")for(const guard of new Map(bindings.map(row=>[row.guard.id,row.guard])).values())await endClasspilotWindowsGuard(guard,database,"teacher_sign_out");
    return publicWindowsCommand(await readClasspilotWindowsCommand(scope.schoolId,id,database));
  });
}
function publicWindowsCommand(value:Awaited<ReturnType<typeof readClasspilotWindowsCommand>>){
  const statuses:Record<string,string>={pending:"requested",delivered:"sent",succeeded:"completed",failed:"failed",expired:"expired",stale:"unavailable"};
  const targets=[...value.targets.map(({target,browserFamily})=>({id:target.id,studentId:target.studentId,sourceRef:target.sourceRef,bindingRevision:target.bindingRevision,browserFamily,
    status:["pending","delivered"].includes(target.status)&&value.command.expiresAt.getTime()<=Date.now()?"expired":statuses[target.status]??"unavailable",
    sentAt:target.deliveredAt,completedAt:target.ackedAt,result:target.result})),...value.legacyTargets.map(target=>({id:target.id,studentId:target.studentId,
      status:["requested","sent","received"].includes(target.status)&&value.command.expiresAt.getTime()<=Date.now()?"expired":target.status,
      sentAt:target.sentAt,completedAt:target.completedAt,result:target.result})),...windowsUnavailableAudience(value.command.payload).map(target=>({
        id:target.id,studentId:target.studentId,status:"unavailable",sentAt:null,completedAt:null,result:{code:target.code},
      }))];
  const summary={requested:targets.length,attempted:targets.filter(t=>t.sentAt||t.status==="completed").length,acknowledged:targets.filter(t=>t.completedAt||t.status==="completed").length,
    pending:targets.filter(t=>["requested","sent"].includes(t.status)).length,completed:targets.filter(t=>t.status==="completed").length,
    expired:targets.filter(t=>t.status==="expired").length,failed:targets.filter(t=>t.status==="failed").length,unavailable:targets.filter(t=>t.status==="unavailable").length};
  return {command:{id:value.command.id,commandType:value.command.commandType,commandPayload:windowsPublicCommandPayload(value.command.payload),teachingSessionId:value.command.teachingSessionId,supervisionContextId:value.command.supervisionContextId,createdAt:value.command.createdAt,expiresAt:value.command.expiresAt,targets,summary},targets,summary,serverTime:new Date().toISOString()};
}
export async function windowsCommandOutcome(scope:WindowsScope,id:string,context:NativeContext){return withWindowsSchool(scope.schoolId,[],async database=>{
  const value=await readClasspilotWindowsCommand(scope.schoolId,id,database);
  if(!windowsSameContext(value.command,context))throw new ClasspilotWindowsError("WINDOWS_NOT_AUTHORIZED");
  const studentIds=[...new Set([...value.targets.map(row=>row.target.studentId),...value.legacyTargets.map(row=>row.studentId),...windowsUnavailableAudience(value.command.payload).map(row=>row.studentId)])];
  await authorizeClasspilotWindowsCommand({...staffRequest(scope,context),studentIds,commandType:value.command.commandType},database);
  return publicWindowsCommand(value);
});}
export async function windowsCommandAcks(token:string,input:Record<string,unknown>){
  return withWindowsBrowser(token,windowsSourceSchemaForAck(input),async({browser},database)=>{
    const acks=z.array(z.object({ackId:z.string().trim().min(1).max(128),commandId:z.string().uuid(),
      ackState:z.string().optional(),status:z.string().optional(),result:z.record(z.string(),z.unknown()).optional(),
    }).passthrough()).min(1).max(50).parse(input.acks);
    const receipts=[];
    const binding={schoolId:browser.schoolId,studentId:browser.studentId,studentSessionId:browser.id,deviceId:browser.id};
    for(const ack of acks){
      const reject=(code:Parameters<typeof terminalClasspilotCommandAckReceipt>[2])=>receipts.push(terminalClasspilotCommandAckReceipt(ack.ackId,ack.commandId,code));
      const normalize=(state:unknown)=>state==="succeeded"?"completed":state;
      const state=normalize(ack.ackState??ack.status);
      if(!["received","completed","failed","expired"].includes(String(state))
        ||(ack.ackState!==undefined&&ack.status!==undefined&&normalize(ack.ackState)!==normalize(ack.status))){reject("COMMAND_ACK_MALFORMED");continue;}
      const revision=classpilotAckControlRevision(ack);
      const exactRequired=browser.acceptedCapabilities.includes("exactBindingAckV2");
      if(!classpilotAckEnvelopeMatchesBinding(ack,binding)||(exactRequired&&(ack.bindingVersion!==2||revision===undefined
        ||Object.entries(binding).some(([key,value])=>ack[key]!==value)))){reject("COMMAND_ACK_BINDING_MISMATCH");continue;}
      let value:Awaited<ReturnType<typeof readClasspilotWindowsCommand>>;
      try{value=await readClasspilotWindowsCommand(browser.schoolId,ack.commandId,database);}catch(error){
        if(error instanceof ClasspilotWindowsError&&error.code==="WINDOWS_COMMAND_NOT_FOUND"){reject("COMMAND_ACK_TARGET_GONE");continue;}throw error;
      }
      const row=value.targets.find(row=>row.target.browserId===browser.id);
      if(!row){reject("COMMAND_ACK_TARGET_GONE");continue;}
      if(value.command.expiresAt.getTime()<=Date.now()){reject("COMMAND_ACK_TARGET_EXPIRED");continue;}
      const authority=await classpilotNativeCurrentAuthority(browser.schoolId,browser.studentId,database);
      if(!authority||!windowsSameContext(value.command,authority)||row.target.controlRevision!==authority.controlRevision
        ||row.target.sourceRef!==browser.sourceRef||row.target.bindingRevision!==browser.bindingRevision
        ||(revision!==undefined&&revision!==authority.controlRevision)){reject("COMMAND_ACK_BINDING_MISMATCH");continue;}
      try{await authorizeClasspilotWindowsCommand({schoolId:browser.schoolId,actorId:value.command.actorId,studentIds:[browser.studentId],commandType:value.command.commandType,
        teachingSessionId:value.command.teachingSessionId??undefined,supervisionContextId:value.command.supervisionContextId??undefined,
        contextAuthorityRevision:value.command.contextAuthorityRevision??undefined},database);}catch(error){
        if((error instanceof ClasspilotWindowsError||error instanceof ClasspilotNativeError)&&[401,403,409].includes(error.status)){reject("COMMAND_ACK_BINDING_MISMATCH");continue;}throw error;
      }
      // The shared worker reports inbox persistence/notification failures as
      // failed ACKs. While the original authority is current, keep durable
      // teacher messages eligible for the next exact-source heartbeat retry.
      const retryMessage=value.command.commandType==="teacher-message"&&state==="failed";
      const next=retryMessage||state==="received"?"delivered":state==="completed"?"succeeded":String(state);
      const idempotent=!retryMessage&&row.target.status===next;
      if(!idempotent&&["succeeded","failed","expired","stale"].includes(row.target.status)){reject("COMMAND_ACK_INVALID_TRANSITION");continue;}
      if(!idempotent){
        const outcome=ack.result?.outcome??ack.outcome;
        await updateClasspilotWindowsTarget(row.target.id,browser.schoolId,{status:next,ackedAt:new Date(),result:{
          code:typeof ack.result?.code==="string"?ack.result.code.slice(0,80):undefined,
          outcome:typeof outcome==="string"?outcome.slice(0,80):undefined,
        }},database);
      }
      receipts.push({ackId:ack.ackId,commandId:ack.commandId,accepted:true,disposition:idempotent?"idempotent":"applied",retryable:false,
        code:idempotent?"COMMAND_ACK_IDEMPOTENT":"COMMAND_ACK_APPLIED"});
    }
    return {receipts};
  });
}
function windowsSourceSchemaForAck(input:Record<string,unknown>){return {sourceRef:z.string().uuid().parse(input.sourceRef),bindingRevision:z.number().int().positive().parse(input.bindingRevision)};}
export async function windowsBrowserSettings(token:string,source:{sourceRef:string;bindingRevision:number}){return withWindowsBrowser(token,source,async(binding,database)=>{const {authority:_authority,expiresAt:_expiresAt,...policy}=await windowsPolicy(binding,database);return policy;});}
