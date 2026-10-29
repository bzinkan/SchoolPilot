import { assertWindowsRequestActive, windowsRequestRemainingMs } from "./classpilotWindowsDiagnostics.js";
import { executeRealtimeRedisCommandOutcome } from "../realtime/ws-redis.js";
import { ClasspilotWindowsError, nativeSecretHash } from "./classpilotWindowsProtocol.js";

type Command=(args:string[])=>Promise<unknown>;
/** Independent namespace; no legacy device cache, local fallback or image disk. */
export class ClasspilotWindowsStore {
  constructor(private command:Command=async args=>{
    assertWindowsRequestActive();
    const result=await executeRealtimeRedisCommandOutcome(args,{timeoutMs:Math.min(750,windowsRequestRemainingMs())});
    assertWindowsRequestActive();
    if(result.status!=="accepted")throw new ClasspilotWindowsError("WINDOWS_STORE_UNAVAILABLE",503);
    return result.value;
  },private prefix=`${process.env.REDIS_PREFIX??"schoolpilot"}:windows:v1`){}
  private key(kind:string,...parts:string[]){return `${this.prefix}:${kind}:${nativeSecretHash(parts.join("\u001f"))}`;}
  async rateLimit(parts:string[],max:number,ms:number){
    const count=await this.command(["EVAL","local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end;return n","1",this.key("limit",...parts),String(ms)]);
    if(typeof count!=="number")throw new ClasspilotWindowsError("WINDOWS_STORE_UNAVAILABLE",503);
    if(count>max)throw new ClasspilotWindowsError("WINDOWS_RATE_LIMIT",429);
  }
  async checkLimit(parts:string[],max:number){const value=await this.command(["GET",this.key("limit",...parts)]);if(value!==null&&(typeof value!=="string"||!/^\d+$/.test(value)))throw new ClasspilotWindowsError("WINDOWS_STORE_UNAVAILABLE",503);if(Number(value)>=max)throw new ClasspilotWindowsError("WINDOWS_RATE_LIMIT",429);}
  async put(kind:"telemetry"|"image"|"image-health",schoolId:string,sourceRef:string,value:Record<string,unknown>,expiresAt:number,sequence:number){
    const result=await this.command(["EVAL",`local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000);if tonumber(ARGV[2])<=now then return -1 end
      local previous=redis.call('GET',KEYS[2]);if previous and tonumber(previous)>=tonumber(ARGV[3]) then return -2 end
      redis.call('SET',KEYS[1],ARGV[1],'PXAT',ARGV[2]);redis.call('SET',KEYS[2],ARGV[3],'PXAT',ARGV[4]);return 1`,"2",this.key(kind,schoolId,sourceRef),this.key(`${kind}-sequence`,schoolId,sourceRef),JSON.stringify(value),String(expiresAt),String(sequence),String(Math.max(expiresAt,Date.now()+28_800_000))]);
    if(result===-1||result===-2)throw new ClasspilotWindowsError(result===-1?"WINDOWS_AUTHORITY_STALE":"WINDOWS_SEQUENCE_STALE",409);
    if(result!==1)throw new ClasspilotWindowsError("WINDOWS_STORE_UNAVAILABLE",503);
  }
  async get(kind:"telemetry"|"image",schoolId:string,sourceRef:string):Promise<Record<string,unknown>|null>{
    const raw=await this.command(["GET",this.key(kind,schoolId,sourceRef)]);if(raw===null)return null;
    if(typeof raw!=="string")throw new ClasspilotWindowsError("WINDOWS_STORE_UNAVAILABLE",503);
    try{return JSON.parse(raw) as Record<string,unknown>;}catch{throw new ClasspilotWindowsError("WINDOWS_STORE_UNAVAILABLE",503);}
  }
  async patchClassification(schoolId:string,sourceRef:string,sequence:number,classification:Record<string,unknown>){
    const result=await this.command(["EVAL",`local raw=redis.call('GET',KEYS[1]);if not raw then return 0 end
      local value=cjson.decode(raw);if tonumber(value.sequence)~=tonumber(ARGV[1]) then return 0 end
      local ttl=redis.call('PTTL',KEYS[1]);if ttl<=0 then return 0 end
      local classification=cjson.decode(ARGV[2]);local body=string.match(raw,'^(.*)}%s*$');if not body then return 0 end
      local patched=body..',"aiClassification":'..ARGV[2]..',"aiCategory":'..cjson.encode(classification.category)..'}'
      redis.call('SET',KEYS[1],patched,'KEEPTTL');return 1`,"1",this.key("telemetry",schoolId,sourceRef),String(sequence),JSON.stringify(classification)]);
    if(result!==0&&result!==1)throw new ClasspilotWindowsError("WINDOWS_STORE_UNAVAILABLE",503);
    return result===1;
  }
}
export const classpilotWindowsStore=new ClasspilotWindowsStore();
