import { executeRealtimeRedisCommandOutcome } from "../realtime/ws-redis.js";
import { assertNativeRequestActive, nativePhase, nativeRedisOutcome, nativeRequestRemainingMs, NATIVE_REDIS_BUDGET_MS } from "./classpilotNativeDiagnostics.js";
import { ClasspilotNativeError, nativeSecretHash, NATIVE_LIMITS, type NativeTarget, type NativeContext,
  type NativeApplication } from "./classpilotNativeProtocol.js";

export type NativeViewerLease = NativeContext & { schoolId: string; actorId: string; viewerInstanceId: string;
  authVersion: number; contextAuthorityRevision?: string; targets: NativeTarget[]; expiresAt: number };
export type NativeCaptureGrant = NativeContext & { id: string; schoolId: string; nativeSessionId: string; studentId: string;
  sourceRef: string; sourceGeneration: string; bindingRevision: number; controlRevision: number;
  contextAuthorityRevision?: string; issuedAt: number; expiresAt: number };
export type NativeStoredImage = NativeCaptureGrant & { sequence: number; capturedAt: string; receivedAt: string;
  foregroundApplication: NativeApplication | null; screenshot: string; imageExpiresAt: number };

type Command = (args: string[]) => Promise<unknown>;
function decode<T>(raw: unknown): T | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
  try { return JSON.parse(raw) as T; } catch { throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503); }
}

/** No in-process fallback: an uncertain shared store never grants collection. */
export class ClasspilotNativeStore {
  constructor(private readonly command: Command = async args => {
    assertNativeRequestActive();
    // JPEG reads/writes are larger than advisory presence commands. Allow a
    // bounded 750ms reply, still inside the 4s request/5s client upload budget.
    // An uncertain write is never retried or replaced with local authority.
    const outcome = await nativePhase("redis", () => executeRealtimeRedisCommandOutcome(args,
      { timeoutMs: Math.min(NATIVE_REDIS_BUDGET_MS, nativeRequestRemainingMs()) }));
    nativeRedisOutcome(outcome.status, outcome.status === "accepted" ? undefined : outcome.reason);
    if (outcome.status !== "accepted") throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
    return outcome.value;
  }, private readonly prefix = `${process.env.REDIS_PREFIX ?? "schoolpilot"}:native:v1`) {}
  private key(kind: string, ...parts: string[]) { return `${this.prefix}:${kind}:${nativeSecretHash(parts.join("\u001f"))}`; }
  viewerKey(schoolId: string, actorId: string, instanceId: string) { return this.key("viewer", schoolId, actorId, instanceId); }
  private sourceIndex(schoolId: string, sourceRef: string) { return this.key("viewers", schoolId, sourceRef); }
  private imageKey(schoolId: string, sourceRef: string) { return this.key("image", schoolId, sourceRef); }
  private grantKey(schoolId: string, sessionId: string, grantId: string) { return this.key("grant", schoolId, sessionId, grantId); }

  async rateLimit(scope: string[], maximum: number, windowMs: number): Promise<void> {
    const result = await this.command(["EVAL", "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]); end; return n", "1",
      this.key("limit", ...scope), String(windowMs)]);
    if (typeof result !== "number") throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
    if (result > maximum) throw new ClasspilotNativeError("NATIVE_RATE_LIMIT", 429, "Too many attempts. Wait before retrying.");
  }
  async checkFailureLimit(scope: string[], maximum: number): Promise<void> {
    const value = await this.command(["GET", this.key("limit", ...scope)]);
    if (value === null) return;
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
    if (Number(value) >= maximum) throw new ClasspilotNativeError("NATIVE_RATE_LIMIT", 429, "Too many attempts. Wait before retrying.");
  }

  async setViewer(lease: NativeViewerLease): Promise<void> {
    const key = this.viewerKey(lease.schoolId, lease.actorId, lease.viewerInstanceId);
    const indexes = lease.targets.map(target => this.sourceIndex(lease.schoolId, target.sourceRef));
    const now = Date.now();
    const ttl = Math.min(NATIVE_LIMITS.leaseMs, lease.expiresAt - now);
    if (ttl <= 0) throw new ClasspilotNativeError("NATIVE_GRANT_STALE", 409);
    const result = await this.command(["EVAL", `
      if redis.call('EXISTS',KEYS[2])==1 then return -1 end
      local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000);
      if tonumber(ARGV[2])<=now then return -3 end
      for i=3,#KEYS do
        redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now);
        if redis.call('ZCARD',KEYS[i])>=128 and not redis.call('ZSCORE',KEYS[i],KEYS[1]) then return -2 end
      end
      redis.call('SET',KEYS[1],ARGV[3],'PXAT',ARGV[2]);
      for i=3,#KEYS do redis.call('ZADD',KEYS[i],ARGV[2],KEYS[1]); redis.call('PEXPIREAT',KEYS[i],tonumber(ARGV[2])+45000) end
      return 1`, String(indexes.length + 2), key, `${key}:released`, ...indexes,
      String(now), String(lease.expiresAt), JSON.stringify(lease), String(ttl)]);
    if (result === -1) throw new ClasspilotNativeError("NATIVE_VIEWER_RELEASED", 409);
    if (result === -2) throw new ClasspilotNativeError("NATIVE_VIEWER_LIMIT", 429);
    if (result === -3) throw new ClasspilotNativeError("NATIVE_GRANT_STALE", 409);
    if (result !== 1) throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
  }

  async releaseViewer(schoolId: string, actorId: string, instanceId: string): Promise<void> {
    const key = this.viewerKey(schoolId, actorId, instanceId);
    const result = await this.command(["EVAL", "redis.call('SET',KEYS[2],'1','PX',300000); redis.call('DEL',KEYS[1]); return 1", "2", key, `${key}:released`]);
    if (result !== 1) throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
  }

  async getViewer(schoolId: string, actorId: string, instanceId: string): Promise<NativeViewerLease | null> {
    const lease = decode<NativeViewerLease>(await this.command(["GET", this.viewerKey(schoolId, actorId, instanceId)]));
    return lease && lease.schoolId === schoolId && lease.actorId === actorId && lease.viewerInstanceId === instanceId
      && lease.expiresAt > Date.now() ? lease : null;
  }

  async getViewers(schoolId: string, target: NativeTarget): Promise<NativeViewerLease[]> {
    const keys = await this.command(["ZRANGEBYSCORE", this.sourceIndex(schoolId, target.sourceRef), String(Date.now()), "+inf", "LIMIT", "0", "129"]);
    if (!Array.isArray(keys) || keys.length > 128 || keys.some(key => typeof key !== "string")) throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
    if (!keys.length) return [];
    const raw = await this.command(["MGET", ...(keys as string[])]);
    if (!Array.isArray(raw) || raw.length !== keys.length) throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
    return raw.map(value => decode<NativeViewerLease>(value)).filter((lease): lease is NativeViewerLease => Boolean(lease
      && lease.schoolId === schoolId && lease.expiresAt > Date.now() && Array.isArray(lease.targets)
      && lease.targets.some(item => item.studentId === target.studentId && item.sourceRef === target.sourceRef && item.bindingRevision === target.bindingRevision)));
  }

  async saveGrant(grant: NativeCaptureGrant, viewers: NativeViewerLease[]): Promise<void> {
    const ttl = Math.min(NATIVE_LIMITS.leaseMs, grant.expiresAt - Date.now());
    if (ttl <= 0 || !viewers.length) throw new ClasspilotNativeError("NATIVE_GRANT_STALE", 409);
    // DELETE does not need a database lock. Fence its race with issuance in the
    // same Redis command, using the exact descriptors whose DB authority was checked.
    const result = await this.command(["EVAL", `
      local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000);
      if tonumber(ARGV[2])<=now then return -1 end
      local expected=cjson.decode(ARGV[3]);
      for i=2,#KEYS do if redis.call('GET',KEYS[i])~=expected[i-1] then return -1 end end
      redis.call('SET',KEYS[1],ARGV[1],'PXAT',ARGV[2]); return 1`, String(viewers.length + 1),
      this.grantKey(grant.schoolId, grant.nativeSessionId, grant.id),
      ...viewers.map(viewer => this.viewerKey(viewer.schoolId, viewer.actorId, viewer.viewerInstanceId)),
      JSON.stringify(grant), String(grant.expiresAt), JSON.stringify(viewers.map(viewer => JSON.stringify(viewer)))]);
    if (result === -1) throw new ClasspilotNativeError("NATIVE_GRANT_STALE", 409);
    if (result !== 1) throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
  }
  async getGrant(schoolId: string, sessionId: string, id: string): Promise<NativeCaptureGrant | null> {
    return decode<NativeCaptureGrant>(await this.command(["GET", this.grantKey(schoolId, sessionId, id)]));
  }
  async clearImage(schoolId: string, sourceRef: string, throughBindingRevision: number): Promise<void> {
    // An old cleanup can arrive after a new source already published. Delete
    // only images covered by the binding revision that authorized this stop.
    const result = await this.command(["EVAL", `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
      local image=cjson.decode(raw); if tonumber(image.bindingRevision)>tonumber(ARGV[1]) then return 0 end
      return redis.call('DEL',KEYS[1])`, "1", this.imageKey(schoolId, sourceRef), String(throughBindingRevision)]);
    if (typeof result !== "number") throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
  }
  async readImage(schoolId: string, sourceRef: string): Promise<NativeStoredImage | null> {
    return decode<NativeStoredImage>(await this.command(["GET", this.imageKey(schoolId, sourceRef)]));
  }
  async saveImage(image: NativeStoredImage, sessionEnd: number, viewers: NativeViewerLease[]): Promise<void> {
    if (!viewers.length) throw new ClasspilotNativeError("NATIVE_GRANT_STALE", 409);
    const now = Date.now();
    const result = await this.command(["EVAL", `
      local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000);
      local grant=redis.call('GET',KEYS[1]); if not grant then return -1 end
      local g=cjson.decode(grant); if tonumber(g.expiresAt)<=now or tonumber(ARGV[4])<=now or tonumber(ARGV[7])<now then return -1 end
      local expected=cjson.decode(ARGV[6]);
      for i=4,#KEYS do if redis.call('GET',KEYS[i])~=expected[i-3] then return -1 end end
      local previous=redis.call('GET',KEYS[3]); if previous and tonumber(previous)>=tonumber(ARGV[2]) then return -2 end
      local current=redis.call('GET',KEYS[2]);
      if current then
        local stored=cjson.decode(current); local candidate=cjson.decode(ARGV[3]);
        if tonumber(stored.bindingRevision)>tonumber(candidate.bindingRevision) then return -1 end
        if tonumber(stored.bindingRevision)==tonumber(candidate.bindingRevision) and tonumber(stored.sequence)>=tonumber(candidate.sequence) then return -2 end
      end
      if tonumber(ARGV[5])<=now then return -1 end
      redis.call('SET',KEYS[3],ARGV[2],'PXAT',ARGV[5]); redis.call('SET',KEYS[2],ARGV[3],'PXAT',ARGV[4]); return 1`, String(viewers.length + 3),
      this.grantKey(image.schoolId, image.nativeSessionId, image.id), this.imageKey(image.schoolId, image.sourceRef),
      this.key("sequence", image.schoolId, image.nativeSessionId, image.sourceGeneration),
      ...viewers.map(viewer => this.viewerKey(viewer.schoolId, viewer.actorId, viewer.viewerInstanceId)),
      String(now), String(image.sequence), JSON.stringify(image), String(image.imageExpiresAt),
      String(sessionEnd), JSON.stringify(viewers.map(viewer => JSON.stringify(viewer))), String(Date.parse(image.capturedAt) + NATIVE_LIMITS.uploadAgeMs)]);
    if (result === -1 || result === -2) throw new ClasspilotNativeError(result === -2 ? "NATIVE_SEQUENCE_REPLAY" : "NATIVE_GRANT_STALE", 409);
    if (result !== 1) throw new ClasspilotNativeError("NATIVE_STORE_UNAVAILABLE", 503);
  }
}
export const classpilotNativeStore = new ClasspilotNativeStore();
