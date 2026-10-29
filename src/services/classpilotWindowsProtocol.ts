import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { nativeHashMatches, nativeSecretHash, type NativeContext } from "./classpilotNativeProtocol.js";
export { nativeHashMatches, nativeSecretHash };
export const WINDOWS_LIMITS = Object.freeze({ guardMs:45_000, absoluteMs:28_800_000, proofMs:60_000, renewSeconds:15, maxStudents:50, maxTabs:50, telemetryBytes:131_072, imageBytes:262_144 });
export class ClasspilotWindowsError extends Error {
  constructor(public code:string,public status=403,message="Windows browser access is unavailable") { super(message); }
}
export function windowsBrowserEnabled(schoolId:string,env:NodeJS.ProcessEnv=process.env):boolean {
  if(env.CLASSPILOT_WINDOWS_BROWSER_MODE!=="on")return false;
  const raw=env.CLASSPILOT_WINDOWS_BROWSER_SCHOOL_IDS;
  if(!raw||raw.length>20_000)return false;
  const ids=raw.split(",").map(x=>x.trim());
  return ids.length<=500&&ids.every(x=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(x))&&ids.includes(schoolId);
}
export function requireWindowsEnabled(schoolId:string) { if(!windowsBrowserEnabled(schoolId))throw new ClasspilotWindowsError("WINDOWS_NOT_ENABLED",404); }
export type WindowsCredential={kind:"guard"|"browser"|"proof";schoolId:string;id:string;tokenHash:string};
export function createWindowsCredential(kind:WindowsCredential["kind"],schoolId:string,id=randomUUID()) {
  const credential=`cpw1.${kind}.${Buffer.from(schoolId).toString("base64url")}.${id}.${randomBytes(32).toString("base64url")}`;
  return {id,credential,tokenHash:nativeSecretHash(credential)};
}
export function parseWindowsCredential(value:unknown,kind:WindowsCredential["kind"]):WindowsCredential {
  if(typeof value!=="string"||value.length>600)throw new ClasspilotWindowsError("WINDOWS_CREDENTIAL_INVALID",401);
  const p=value.split(".");
  if(p.length!==5||p[0]!=="cpw1"||p[1]!==kind||!/^[A-Za-z0-9_-]{1,267}$/.test(p[2]!)||!z.string().uuid().safeParse(p[3]).success||!/^[A-Za-z0-9_-]{43}$/.test(p[4]!))throw new ClasspilotWindowsError("WINDOWS_CREDENTIAL_INVALID",401);
  const schoolId=Buffer.from(p[2]!,"base64url").toString("utf8");
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(schoolId)||Buffer.from(schoolId).toString("base64url")!==p[2])throw new ClasspilotWindowsError("WINDOWS_CREDENTIAL_INVALID",401);
  return {kind,schoolId,id:p[3]!,tokenHash:nativeSecretHash(value)};
}
const id=z.string().min(1).max(200);
export const windowsSourceSchema=z.object({sourceRef:z.string().uuid(),bindingRevision:z.number().int().positive().max(2_147_483_647)});
export const windowsTargetSchema=windowsSourceSchema.extend({studentId:id}).strict();
export type WindowsTarget=z.infer<typeof windowsTargetSchema>;
export const windowsPairProofSchema=z.object({browserFamily:z.enum(["chrome","edge"]),profileId:z.string().uuid(),challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
export const windowsPairSchema=windowsPairProofSchema.extend({proof:z.string().max(600),clientProtocolVersion:z.literal(3),capabilities:z.array(z.string().max(100)).max(100),extensionVersion:z.string().min(1).max(40)}).strict();
export const windowsTileSchema=z.object({teachingSessionId:id.optional(),supervisionContextId:id.optional(),studentIds:z.array(id).min(1).max(50),selectedSources:z.array(windowsTargetSchema).max(50).optional()}).strict()
  .refine(x=>Boolean(x.teachingSessionId)!==Boolean(x.supervisionContextId),"Exactly one context required")
  .refine(x=>new Set(x.studentIds).size===x.studentIds.length&&new Set(x.selectedSources?.map(s=>s.studentId)).size===(x.selectedSources?.length??0),"Duplicate student")
  .refine(x=>x.selectedSources?.every(s=>x.studentIds.includes(s.studentId))??true,"Source outside scope");
export const WINDOWS_POLICY_COMMANDS=new Set(["lock-screen","unlock-screen","apply-flight-path","remove-flight-path","apply-block-list","remove-block-list","attention-mode","limit-tabs","temp-unblock","stop-focus","student-sign-out"]);
export const WINDOWS_TAB_COMMANDS=new Set(["open-tab","close-tabs","activate-tab","focus-tab"]);
export const windowsCommandSchema=z.object({teachingSessionId:id.optional(),supervisionContextId:id.optional(),targetScope:z.literal("students"),targetStudentIds:z.array(id).min(1).max(50),commandType:z.string().max(80),commandPayload:z.record(z.string(),z.unknown()),browserTargets:z.array(windowsTargetSchema).max(50).optional()}).strict()
 .refine(x=>Boolean(x.teachingSessionId)!==Boolean(x.supervisionContextId),"Exactly one context required")
 .refine(x=>new Set(x.targetStudentIds).size===x.targetStudentIds.length,"Duplicate student")
 .refine(x=>WINDOWS_TAB_COMMANDS.has(x.commandType)?!!x.browserTargets?.length:!x.browserTargets?.length,"Exact browser selection required for tab actions only");
export function windowsSameContext(a:{teachingSessionId?:string|null;supervisionContextId?:string|null},b:{teachingSessionId?:string|null;supervisionContextId?:string|null}) { return (a.teachingSessionId??null)===(b.teachingSessionId??null)&&(a.supervisionContextId??null)===(b.supervisionContextId??null); }
