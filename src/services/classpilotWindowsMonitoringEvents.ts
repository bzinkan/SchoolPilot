import { z } from "zod";
import { classpilotMonitoringEvents } from "../schema/classpilot.js";
import { sanitizeExtensionMonitoringEvent } from "./classpilotMonitoringEventSanitizer.js";
import { classpilotRetentionExpiresAt } from "../util/classpilotRetention.js";
import { windowsSameContext } from "./classpilotWindowsProtocol.js";
import type { WindowsBinding } from "./classpilotWindows.js";
import type { NativeStorageDb } from "./storage.js";
import { getSettingsForSchool } from "./storage.js";

/** Browser events use the existing sanitizer/retention, with identity taken only from the verified child. */
export async function recordWindowsMonitoringEvents(binding:WindowsBinding,database:NativeStorageDb,payload:Record<string,unknown>,authority:{teachingSessionId?:string|null;supervisionContextId?:string|null;contextAuthorityRevision?:string|null}){
  const values=z.array(z.unknown()).min(1).max(50).parse(payload.events),now=new Date();
  const settings=await getSettingsForSchool(binding.browser.schoolId,database);
  const results:Array<{sourceEventId:string|null;status:"stored"|"duplicate"|"not_retained"}>=[];
  for(const value of values){
    const event=sanitizeExtensionMonitoringEvent(value,now);
    const raw=value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
    const rejected=()=>results.push({sourceEventId:event?.sourceEventId??null,status:"not_retained"});
    const claimed={teachingSessionId:typeof raw.teachingSessionId==="string"?raw.teachingSessionId:null,supervisionContextId:typeof raw.supervisionContextId==="string"?raw.supervisionContextId:null};
    if(!event||!windowsSameContext(claimed,authority)||event.occurredAt<binding.browser.createdAt||event.occurredAt>now
      ||(authority.supervisionContextId&&String(raw.contextAuthorityRevision??"")!==String(authority.contextAuthorityRevision??""))){rejected();continue;}
    const retentionExpiresAt=classpilotRetentionExpiresAt(event.occurredAt,settings?.retentionHours);
    if(retentionExpiresAt<=now){rejected();continue;}
    const rows=await database.insert(classpilotMonitoringEvents).values({schoolId:binding.browser.schoolId,studentId:binding.student.id,
      deviceId:binding.browser.id,studentSessionId:binding.browser.id,teachingSessionId:authority.teachingSessionId??null,supervisionContextId:authority.supervisionContextId??null,
      ...event,origin:"extension",receivedAt:now,retentionExpiresAt,
      metadata:{...event.metadata,browserFamily:binding.browser.browserFamily,sourceRef:binding.browser.sourceRef,bindingRevision:binding.browser.bindingRevision}})
      .onConflictDoNothing().returning({id:classpilotMonitoringEvents.id});
    results.push({sourceEventId:event.sourceEventId,status:rows.length?"stored":"duplicate"});
  }
  return {results};
}
