import { z } from "zod";
import { withWindowsBrowser, windowsBrowserSettings } from "./classpilotWindows.js";
import { ClasspilotWindowsError, windowsSameContext } from "./classpilotWindowsProtocol.js";
import { classpilotWindowsStore } from "./classpilotWindowsStore.js";
import { endClasspilotWindowsGuard, classpilotNativeCurrentAuthority, getHeartbeatTrackingSettingsForSchool, raiseAuthorizedClasspilotStudentHand, lowerAuthorizedClasspilotStudentHand, createAuthorizedClasspilotStudentMessage, createClasspilotWindowsPollResponse, acknowledgeClasspilotWindowsChat, setClasspilotWindowsPolicyAck, readClasspilotWindowsChatTranscript } from "./storage.js";
import { resolveClasspilotMonitoringPolicy } from "./classpilotMonitoringPolicy.js";
import { mutateScheduledStudentHand, createScheduledStudentMessage, publishScheduledClassroomEvent } from "./classpilotScheduledClassroomTools.js";
import { mutateStudentHelp, submitQuestion, updateLessonProgress, scanToolSubmission } from "./classpilotClassTools.js";
import { publishClassToolsChanged } from "./classpilotToolsEvents.js";
import { getSchoolWebsitePolicy } from "./classpilotSchoolWebsitePolicy.js";
import { broadcastToStaffSessionLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import { scanStudentChatMessage } from "./classpilotChatSafety.js";
import { privateChatMessageLifecycle } from "./classpilotPrivateChatLifecycle.js";
import { recordWindowsMonitoringEvents } from "./classpilotWindowsMonitoringEvents.js";
import { deferUntilDatabaseCommit } from "../db.js";
import { runWithoutTenantContext } from "../db/tenantContext.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";

export const WINDOWS_ACTIONS=new Set(["sign-out","settings","school-status","raise-hand","lower-hand","send-message","chat-acks","school-policy-acks","events","poll-respond","chat-history","chat-read","class-tools:help","class-tools:help-withdraw","class-tools:questions","class-tools:progress"]);
export async function windowsBrowserAction(token:string,input:{operation:string;payload:Record<string,unknown>;sourceRef:string;bindingRevision:number}){
  if(!WINDOWS_ACTIONS.has(input.operation))throw new ClasspilotWindowsError("WINDOWS_ACTION_UNSUPPORTED",400);
  if(input.operation==="settings"||input.operation==="school-status"){
    const policy=await windowsBrowserSettings(token,input);
    return input.operation==="school-status"?{...policy,active:true,status:"active",isActive:true}:policy;
  }
  return withWindowsBrowser(token,input,async(binding,database)=>{
    const {browser}=binding;const payload=input.payload;
    if(input.operation==="sign-out"){await endClasspilotWindowsGuard(binding.guard,database,"browser_sign_out");return {ok:true};}
    await classpilotWindowsStore.rateLimit(["action",browser.schoolId,browser.id],60,60_000);
    const identity={schoolId:browser.schoolId,studentId:browser.studentId,studentSessionId:browser.id,deviceId:browser.id};
    if(input.operation==="school-policy-acks"){
      const ack=z.object({policyRevision:z.number().int().nonnegative(),status:z.enum(["applied","failed"]),closedTabCount:z.number().int().min(0).max(1000),errorCode:z.string().max(80).optional()}).strip().parse(payload);
      const policy=await getSchoolWebsitePolicy(browser.schoolId);
      if(policy.policyRevision!==ack.policyRevision)return {accepted:false,terminal:true,code:"POLICY_SUPERSEDED"};
      await setClasspilotWindowsPolicyAck(browser,{...ack,acknowledgedAt:new Date().toISOString()},database);
      return {accepted:true,terminal:false};
    }
    const authority=await classpilotNativeCurrentAuthority(browser.schoolId,browser.studentId,database);
    if(input.operation!=="events"&&(!authority||payload.studentControlRevision!==authority.controlRevision))throw new ClasspilotWindowsError("WINDOWS_AUTHORITY_STALE",409);
    const supplied={teachingSessionId:typeof(payload.teachingSessionId??payload.sessionId)==="string"?String(payload.teachingSessionId??payload.sessionId):undefined,supervisionContextId:typeof payload.supervisionContextId==="string"?payload.supervisionContextId:undefined};
    if((supplied.teachingSessionId||supplied.supervisionContextId)&&!windowsSameContext(supplied,authority??{}))throw new ClasspilotWindowsError("WINDOWS_AUTHORITY_STALE",409);
    const tracking=await getHeartbeatTrackingSettingsForSchool(browser.schoolId,database,{lock:true,bypassCache:true});
    if(resolveClasspilotMonitoringPolicy(tracking,{acceptedCapabilities:browser.acceptedCapabilities}).mode!=="full")throw new ClasspilotWindowsError("WINDOWS_MONITORING_PAUSED",403);
    if(input.operation==="events")return recordWindowsMonitoringEvents(binding,database,payload,authority??{});
    if(!authority)throw new ClasspilotWindowsError("WINDOWS_AUTHORITY_STALE",409);
    const studentScope={...identity,authority:authority.teachingSessionId?{teachingSessionId:authority.teachingSessionId}:{supervisionContextId:authority.supervisionContextId!},studentControlRevision:authority.controlRevision};
    const afterCommit=(action:()=>Promise<unknown>)=>deferUntilDatabaseCommit(()=>runWithoutTenantContext(()=>runWithTenantContext({schoolId:browser.schoolId},action)));
    const changed=()=>afterCommit(()=>publishClassToolsChanged({...studentScope,actorId:browser.studentId},[browser.studentId]));
    const capability=(name:string)=>{if(!browser.acceptedCapabilities.includes(name))throw new ClasspilotWindowsError("WINDOWS_CAPABILITY_REQUIRED",409);};
    if(input.operation==="raise-hand"||input.operation==="lower-hand"){
      const raised=input.operation==="raise-hand";
      if(authority.supervisionContextId){await mutateScheduledStudentHand({...identity,supervisionContextId:authority.supervisionContextId,studentControlRevision:authority.controlRevision,raised});}
      else if(raised)await raiseAuthorizedClasspilotStudentHand({...identity,expiresAt:new Date(authority.expiresAt)});
      else await lowerAuthorizedClasspilotStudentHand(identity);
      await changed();return {ok:true,handRaised:raised,raisedHands:raised?[{sessionId:authority.teachingSessionId,supervisionContextId:authority.supervisionContextId,raisedAt:new Date().toISOString()}]:[]};
    }
    if(input.operation==="send-message"){
      const content=z.string().trim().min(1).max(500).parse(payload.message);
      const clientMessageId=z.string().uuid().parse(payload.clientMessageId);
      const result=authority.supervisionContextId?await createScheduledStudentMessage({...identity,supervisionContextId:authority.supervisionContextId,studentControlRevision:authority.controlRevision,content,clientMessageId,expectedPrivateChatLifecycle:payload.expectedPrivateChatLifecycle}):await createAuthorizedClasspilotStudentMessage({...identity,teachingSessionId:authority.teachingSessionId,content,clientMessageId,expectedPrivateChatLifecycle:payload.expectedPrivateChatLifecycle});
      const message={id:result.message.id,studentId:browser.studentId,sessionId:authority.teachingSessionId,supervisionContextId:authority.supervisionContextId,content:result.message.content,message:result.message.content,senderType:"student",createdAt:result.message.createdAt,clientMessageId,privateChatLifecycle:privateChatMessageLifecycle(result.message)};
      if(result.created)afterCommit(async()=>{
        const event={type:"student-message",sessionId:authority.teachingSessionId,data:message};
        if("context"in result)await publishScheduledClassroomEvent(result.context,event);
        else{broadcastToStaffSessionLocal(browser.schoolId,authority.teachingSessionId!,event);await publishWS({kind:"staff-session",schoolId:browser.schoolId,sessionId:authority.teachingSessionId!},event);}
        await scanStudentChatMessage({...identity,...authority,messageId:message.id,content,occurredAt:result.message.createdAt});
      });
      return {message,messageId:message.id,clientMessageId,sessionId:authority.teachingSessionId,supervisionContextId:authority.supervisionContextId,delivered:true,duplicate:!result.created,messages:[message]};
    }
    if(input.operation==="poll-respond")return createClasspilotWindowsPollResponse(binding,z.object({pollId:z.string().min(1).max(200),selectedOption:z.number().int().optional(),textResponse:z.string().trim().max(500).optional()}).strip().parse(payload),database);
    if(input.operation==="chat-acks"){
      const acks=z.array(z.object({ackId:z.string().min(1).max(128),messageId:z.string().min(1).max(128).optional(),chatMessageId:z.string().min(1).max(128).optional(),status:z.string().optional(),deliveryStatus:z.string().optional(),privateChatLifecycle:z.unknown().optional()}).strip()).min(1).max(50).parse(payload.acks);
      const receipts=[];for(const ack of acks){const status=ack.deliveryStatus??ack.status;const messageId=ack.messageId??ack.chatMessageId??"";const accepted=["delivered","seen"].includes(status??"")&&await acknowledgeClasspilotWindowsChat(browser,messageId,status as "delivered"|"seen",ack.privateChatLifecycle,database);receipts.push({ackId:ack.ackId,messageId,accepted,...(accepted?{}:{code:"WINDOWS_CHAT_STALE"})});}return {receipts};
    }
    if(input.operation==="chat-history")return readClasspilotWindowsChatTranscript(browser,database);
    if(input.operation==="chat-read"){const ids=z.array(z.string().min(1).max(128)).max(50).parse(payload.messageIds);for(const id of ids)await acknowledgeClasspilotWindowsChat(browser,id,"seen",payload.privateChatLifecycle,database);return {ok:true};}
    if(input.operation==="class-tools:help"||input.operation==="class-tools:help-withdraw"){
      capability("helpRequestsV1");const help=await mutateStudentHelp(studentScope,input.operation==="class-tools:help"?"request":"withdraw",payload.data);
      changed();if(help?.explanation)afterCommit(()=>scanToolSubmission(studentScope,help.id,help.explanation!));return {help};
    }
    if(input.operation==="class-tools:questions"){
      capability("questionParkingV1");const data=z.object({clientRequestId:z.string().uuid(),question:z.string().trim().min(1).max(500)}).strict().parse(payload.data);
      const result=await submitQuestion(studentScope,data.clientRequestId,data.question);changed();if(result.created)afterCommit(()=>scanToolSubmission(studentScope,result.question.id,data.question));return result;
    }
    if(input.operation==="class-tools:progress"){capability("lessonActivitiesV1");const progress=await updateLessonProgress(studentScope,payload.data);await changed();return {progress};}
    throw new ClasspilotWindowsError("WINDOWS_ACTION_UNSUPPORTED",400);
  });
}
