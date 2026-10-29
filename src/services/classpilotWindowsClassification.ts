import { and,eq,isNull } from "drizzle-orm";
import { z } from "zod";
import { classpilotWindowsBrowserEvents as events } from "../schema/classpilotWindowsHistory.js";
import { classpilotAiDecisions,evidenceArtifacts } from "../schema/shared.js";
import { classifyUrl } from "./aiClassification.js";
import { classpilotTeacherIntentForUrl } from "./classpilotTeacherIntent.js";
import { resolveClasspilotMonitoringPolicy,classpilotSafetyObservation } from "./classpilotMonitoringPolicy.js";
import { classpilotBrowserSafetySeverity } from "./classpilotBrowserSafetySeverity.js";
import { isSafetyUrlSuppressed,recordSafetyAlert } from "./safetyCenter.js";
import { withWindowsBrowser } from "./classpilotWindows.js";
import { classpilotWindowsStore as store } from "./classpilotWindowsStore.js";
import { withoutWindowsRequest } from "./classpilotWindowsDiagnostics.js";
import { classpilotNativeCurrentAuthority,getClasspilotStudentControlState,getSchoolById,getSettingsForSchool,getHeartbeatTrackingSettingsForSchool } from "./storage.js";
import { serializeClasspilotStudentControlState } from "./classpilotClassroomState.js";
import { trackHeartbeatClassificationProducer } from "./heartbeatClassificationBatcher.js";
import { screenshotBindingVersion } from "../realtime/ws-redis.js";
import { windowsBrowserEvidenceEligible } from "./classpilotWindowsSafetyModel.js";

/** Accepts URL/title browser metadata only. Native observation credentials and pixels have no entry here. */
export async function classifyWindowsObservation(token:string,input:Record<string,unknown>){
  const source={sourceRef:z.string().uuid().parse(input.sourceRef),bindingRevision:z.number().int().positive().parse(input.bindingRevision)};
  const observation=classpilotSafetyObservation(input);if(!observation)return;
  const sequence=z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.sequence);
  const snapshot=await withWindowsBrowser(token,source,async(binding,database)=>{
    const tracking=await getHeartbeatTrackingSettingsForSchool(binding.browser.schoolId,database,{lock:true,bypassCache:true});
    const policy=resolveClasspilotMonitoringPolicy(tracking,{acceptedCapabilities:binding.browser.acceptedCapabilities});
    if(policy.mode==="off")return null;
    const [event]=policy.mode==="full"?await database.select().from(events).where(and(eq(events.schoolId,binding.browser.schoolId),eq(events.browserId,binding.browser.id),eq(events.sequence,sequence))).limit(1):[];
    const stored=event?classpilotSafetyObservation({activeTabUrl:event.activeTabUrl,activeTabTitle:event.activeTabTitle}):null;
    if(policy.mode==="full"&&(!event||event.classification||stored?.url!==observation.url||stored?.title!==observation.title))return null;
    const school=await getSchoolById(binding.browser.schoolId,database);
    const settings=await getSettingsForSchool(binding.browser.schoolId,database);
    const authority=await classpilotNativeCurrentAuthority(binding.browser.schoolId,binding.student.id,database);
    const state=authority?await getClasspilotStudentControlState(binding.browser.schoolId,binding.student.id,database):null;
    return {mode:policy.mode,event,domain:school?.domain,allowedDomains:settings?.allowedDomains??[],
      flightPath:state?serializeClasspilotStudentControlState(state).restrictions?.flightPath:null,
      controlRevision:authority?.controlRevision??0,observedAt:event?.observedAt??new Date()};
  });
  if(!snapshot)return;
  let classification=await classifyUrl(observation.url,observation.title,{schoolDomain:snapshot.domain});
  if(!classification)return;
  classification={...classification,teacherIntentSource:classification.category==="non-educational"?classpilotTeacherIntentForUrl(observation.url,{allowedDomains:snapshot.allowedDomains,flightPath:snapshot.flightPath}):null};
  const result=classification;
  await withWindowsBrowser(token,source,async(binding,database)=>{
    const tracking=await getHeartbeatTrackingSettingsForSchool(binding.browser.schoolId,database,{lock:true,bypassCache:true});
    const policy=resolveClasspilotMonitoringPolicy(tracking,{acceptedCapabilities:binding.browser.acceptedCapabilities});
    if(policy.mode!==snapshot.mode)return;
    const suppressed=result.safetyAlert&&await isSafetyUrlSuppressed(binding.browser.schoolId,observation.url,database);
    const currentClassification={...result,safetyAlert:suppressed?null:result.safetyAlert};
    const bindingTuple={schoolId:binding.browser.schoolId,studentId:binding.student.id,studentSessionId:binding.browser.id,deviceId:binding.browser.id};
    if(snapshot.event){
      const updated=await database.update(events).set({classification:currentClassification}).where(and(eq(events.schoolId,binding.browser.schoolId),eq(events.id,snapshot.event.id),eq(events.browserId,binding.browser.id),isNull(events.classification))).returning({id:events.id});
      if(!updated.length)return;
      await database.insert(classpilotAiDecisions).values({schoolId:binding.browser.schoolId,studentId:binding.student.id,deviceId:binding.browser.id,heartbeatId:snapshot.event.id,
        url:observation.url,title:observation.title,domain:result.domain,category:result.category,contentCategory:result.contentCategory??null,teacherIntentSource:result.teacherIntentSource??null,
        safetyAlert:currentClassification.safetyAlert,confidence:result.confidence==null?null:Math.round(result.confidence),reasoning:result.reasoning??null,matchedRule:result.matchedTerm??null,
        actionTaken:"alert-only",reviewStatus:currentClassification.safetyAlert?"unreviewed":null,metadata:{sourceRef:source.sourceRef,bindingRevision:source.bindingRevision,browserFamily:binding.browser.browserFamily}});
      // Historical classification is retained, but only the current page can affect tiles or safety.
      if(!await store.patchClassification(binding.browser.schoolId,source.sourceRef,sequence,currentClassification))return;
    }
    if(!currentClassification.safetyAlert)return;
    const authority=await classpilotNativeCurrentAuthority(binding.browser.schoolId,binding.student.id,database);
    if((authority?.controlRevision??0)!==snapshot.controlRevision)return;
    const safety=await recordSafetyAlert({schoolId:binding.browser.schoolId,studentId:binding.student.id,sourceType:"browser",sourceId:snapshot.event?.id??`${binding.browser.id}:${sequence}`,
      url:observation.url,title:observation.title,safetyAlert:currentClassification.safetyAlert,severity:classpilotBrowserSafetySeverity(currentClassification),classificationSource:result.source??"unknown",
      matchedTerm:result.matchedTerm,reason:result.reasoning,rulesetVersion:result.rulesetVersion,modelVersion:result.modelVersion,confidence:result.confidence,occurredAt:snapshot.observedAt,
      heartbeatId:snapshot.event?.id??null,teachingSessionId:authority?.teachingSessionId??null},database);
    if(!snapshot.event||!safety.created||!safety.caseId||policy.mode!=="full")return;
    const image=await store.get("image",binding.browser.schoolId,source.sourceRef);
    if(!windowsBrowserEvidenceEligible(image,{...source,url:observation.url,controlRevision:snapshot.controlRevision,observedAt:snapshot.observedAt.getTime()}))return;
    await database.insert(evidenceArtifacts).values({...bindingTuple,bindingVersion:screenshotBindingVersion(bindingTuple),caseId:safety.caseId,sourceType:"classpilot_windows_screenshot",sourceId:snapshot.event.id,
      artifactType:"screenshot",status:"available",label:"Browser safety screenshot",contentType:"image/jpeg",content:String(image!.screenshot),capturedAt:new Date(String(image!.screenshotAt)),
      metadata:{sourceRef:source.sourceRef,bindingRevision:source.bindingRevision,browserFamily:binding.browser.browserFamily,tabUrl:observation.url,capturedFromExactBinding:true}});
  });
}
export function scheduleWindowsClassification(token:string,input:Record<string,unknown>){
  void withoutWindowsRequest(()=>trackHeartbeatClassificationProducer(classifyWindowsObservation(token,input))).catch(()=>{/* Optional browser classification never logs page or identity data. */});
}
