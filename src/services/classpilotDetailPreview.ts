import { createHmac, randomBytes } from "node:crypto";
import { realtimeRedisCommand } from "../realtime/ws-redis.js";
import type { ScreenshotBinding } from "../realtime/ws-redis.js";
import type { ClasspilotScreenshotAuthorityProjection } from "./storage.js";

export const DETAIL_PREVIEW_LEASE_MS = 20_000;
export type DetailPreviewBinding = ScreenshotBinding & {
  teachingSessionId?: string;
  supervisionContextId?: string;
  controlRevision: number;
};
export type DetailPreviewLease = { leaseId: string; startedAt: number; expiresAt: number };
export type DetailPreviewImage = {
  screenshot: string; timestamp: number; capturedAt: string; bindingVersion: string;
  resolution: "detail"; captureCadenceMode: "active_view"; tabTitle?: string; tabUrl?: string;
};
type Group = DetailPreviewLease & { viewers: Record<string, number>; imageKey: string };
type RefreshTarget = { studentId: string; teachingSessionId?: string; supervisionContextId?: string };
type Viewer = { groupKey: string; leaseId: string; target: RefreshTarget };
const local = new Map<string, { value: string; expiresAt: number }>();
const MAX_LOCAL_KEYS = 4096;

function production(): boolean { return process.env.NODE_ENV === "production" || process.env.APP_ENV === "production"; }
function required(): boolean { return Boolean(process.env.REDIS_URL || production()); }
function digest(values: unknown[]): string {
  const secret = process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET || process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (!secret && production()) throw new Error("Detail preview storage unavailable");
  return createHmac("sha256", secret || "classpilot-detail-development-only").update(JSON.stringify(values)).digest("base64url");
}
export function detailPreviewBindingVersion(binding: DetailPreviewBinding): string {
  return `detail-v1:${digest(["binding", binding.schoolId, binding.studentId, binding.studentSessionId,
    binding.deviceId, binding.teachingSessionId ?? null, binding.supervisionContextId ?? null, binding.controlRevision])}`;
}
export function detailPreviewBindingForProjection(binding: ScreenshotBinding, projection?: ClasspilotScreenshotAuthorityProjection): DetailPreviewBinding | null {
  if (!projection) return null;
  const authority = projection.authority;
  // Current extension clients cannot produce detail for reporting-only Observe.
  // Leave its existing ordinary screenshot protocol and read boundary intact.
  const teachingSessionId = authority.kind === "teaching_session" ? authority.teachingSessionId : undefined;
  if (!teachingSessionId && authority.kind !== "supervision_context") return null;
  return { ...binding, controlRevision: authority.controlRevision,
    ...(teachingSessionId ? { teachingSessionId } : {}),
    ...(authority.kind === "supervision_context" ? { supervisionContextId: authority.supervisionContextId } : {}) };
}
function keys(binding: DetailPreviewBinding) {
  const version = detailPreviewBindingVersion(binding);
  return { group: `classpilot:detail-preview:v1:${version}`, image: `classpilot:detail-image:v1:${version}` };
}
function viewerKey(schoolId: string, userId: string, instanceId: string): string {
  return `classpilot:detail-viewer:v1:${digest(["viewer", schoolId, userId, instanceId])}`;
}

// One atomic operation replaces the viewer's old selection, coalesces viewers
// of an exact binding, and fences uploads/releases against the current lease.
// These namespaces are independent of ordinary screenshots and safety evidence.
const SCRIPT = `
local op=ARGV[1]; local now=tonumber(ARGV[2]);
local function load(k) local s=redis.call('GET',k); if not s then return nil end; local ok,v=pcall(cjson.decode,s); if not ok then return nil end; return v end
local function prune(g) if not g or not g.viewers then return nil end; local count=0; local expiry=0; for v,e in pairs(g.viewers) do if tonumber(e)<=now then g.viewers[v]=nil else count=count+1; expiry=math.max(expiry,tonumber(e)) end end; if count==0 then return nil end; g.expiresAt=expiry; return g end
local function save(k,g) if g then redis.call('SET',k,cjson.encode(g),'PX',math.max(1,g.expiresAt-now)) else redis.call('DEL',k) end end
local function remove(k,v) local old=load(k); local g=prune(old); if g then g.viewers[v]=nil; g=prune(g) end; save(k,g); if not g and old and old.imageKey then redis.call('DEL',old.imageKey) end end
if op=='release' then local v=load(KEYS[1]); if not v or v.leaseId~=ARGV[3] then return 'false' end; remove(v.groupKey,KEYS[1]); redis.call('DEL',KEYS[1]); return cjson.encode(v.target) end
local g=prune(load(KEYS[2]));
if op=='renew' then
 local old=load(KEYS[1]); if old and old.groupKey~=KEYS[2] then remove(old.groupKey,KEYS[1]) end;
 if not g then g={leaseId=ARGV[3],startedAt=now,expiresAt=now+20000,viewers={},imageKey=KEYS[3]}; redis.call('DEL',KEYS[3]) end;
 local count=0; for _ in pairs(g.viewers) do count=count+1 end; if count>=128 and not g.viewers[KEYS[1]] then return 'unavailable' end;
 g.viewers[KEYS[1]]=now+20000; g.expiresAt=now+20000; save(KEYS[2],g); redis.call('SET',KEYS[1],cjson.encode({groupKey=KEYS[2],leaseId=g.leaseId,target=cjson.decode(ARGV[4])}),'PX',20000); return cjson.encode(g)
end
if not g then return 'null' end;
if op=='status' then return cjson.encode(g) end;
if op=='read' then local v=load(KEYS[1]); if not v or v.groupKey~=KEYS[2] or v.leaseId~=g.leaseId or not g.viewers[KEYS[1]] then return 'null' end; local img=load(KEYS[3]); if img and img.leaseId==g.leaseId and img.capturedAt>=g.startedAt and img.capturedAt<=now+1000 and now-img.capturedAt<20000 then return cjson.encode(img.image) end; return 'null' end;
if op=='write' then
 local captured=tonumber(ARGV[5]); if g.leaseId~=ARGV[3] or captured<g.startedAt or captured>now+1000 or now-captured>=20000 then return 'stale' end;
 local previous=load(KEYS[3]); if previous and previous.leaseId==g.leaseId and captured<previous.capturedAt+5000 then return 'superseded' end;
 local ttl=math.min(g.expiresAt-now,20000-(now-captured)); if ttl<=0 then return 'stale' end;
 redis.call('SET',KEYS[3],cjson.encode({leaseId=g.leaseId,capturedAt=captured,image=cjson.decode(ARGV[4])}),'PX',ttl); return 'stored'
end; return 'null'`;

function localOperation(op: string, names: string[], args: string[], now: number): string {
  for (const [key, item] of local) if (item.expiresAt <= now) local.delete(key);
  while (local.size >= MAX_LOCAL_KEYS) { const key = local.keys().next().value; if (!key) break; local.delete(key); }
  const read = <T>(key: string): T | null => { const item = local.get(key); return item ? JSON.parse(item.value) : null; };
  const put = (key: string, value: unknown, expiresAt: number) => { local.set(key, { value: JSON.stringify(value), expiresAt }); };
  const prune = (group: Group | null): Group | null => {
    if (!group) return null;
    for (const [viewer, expiry] of Object.entries(group.viewers)) if (expiry <= now) delete group.viewers[viewer];
    const deadlines = Object.values(group.viewers);
    return deadlines.length ? { ...group, expiresAt: Math.max(...deadlines) } : null;
  };
  const remove = (key: string, viewer: string) => {
    const old = read<Group>(key); if (old) delete old.viewers[viewer];
    const current = prune(old);
    if (current) put(key, current, current.expiresAt); else { local.delete(key); if (old) local.delete(old.imageKey); }
  };
  const viewer = names[0]!; const groupKey = names[1]!; const imageKey = names[2]!;
  if (op === "release") {
    const previous = read<Viewer>(viewer);
    if (!previous || previous.leaseId !== args[0]) return "false";
    remove(previous.groupKey, viewer); local.delete(viewer); return JSON.stringify(previous.target);
  }
  let group = prune(read<Group>(groupKey));
  if (op === "renew") {
    const previous = read<Viewer>(viewer);
    if (previous && previous.groupKey !== groupKey) remove(previous.groupKey, viewer);
    if (!group) { group = { leaseId: args[0]!, startedAt: now, expiresAt: now + DETAIL_PREVIEW_LEASE_MS, viewers: {}, imageKey }; local.delete(imageKey); }
    if (Object.keys(group.viewers).length >= 128 && !group.viewers[viewer]) return "unavailable";
    group.viewers[viewer] = now + DETAIL_PREVIEW_LEASE_MS; group.expiresAt = now + DETAIL_PREVIEW_LEASE_MS;
    put(groupKey, group, group.expiresAt); put(viewer, { groupKey, leaseId: group.leaseId, target: JSON.parse(args[1]!) }, group.expiresAt);
    return JSON.stringify(group);
  }
  if (!group) return "null";
  if (op === "status") return JSON.stringify(group);
  const stored = read<{ leaseId: string; capturedAt: number; image: DetailPreviewImage }>(imageKey);
  if (op === "read") {
    const own = read<Viewer>(viewer);
    return own?.groupKey === groupKey && own.leaseId === group.leaseId && group.viewers[viewer]
      && stored?.leaseId === group.leaseId && stored.capturedAt >= group.startedAt
      && stored.capturedAt <= now + 1000 && now - stored.capturedAt < DETAIL_PREVIEW_LEASE_MS ? JSON.stringify(stored.image) : "null";
  }
  const capturedAt = Number(args[2]);
  if (group.leaseId !== args[0] || capturedAt < group.startedAt || capturedAt > now + 1000 || now - capturedAt >= DETAIL_PREVIEW_LEASE_MS) return "stale";
  if (stored?.leaseId === group.leaseId && capturedAt < stored.capturedAt + 5000) return "superseded";
  put(imageKey, { leaseId: group.leaseId, capturedAt, image: JSON.parse(args[1]!) }, Math.min(group.expiresAt, capturedAt + DETAIL_PREVIEW_LEASE_MS));
  return "stored";
}

async function operation(op: string, names: string[], args: string[], now: number): Promise<string> {
  if (required() && !process.env.REDIS_URL) throw new Error("Detail preview storage unavailable");
  try {
    const result = await realtimeRedisCommand(["EVAL", SCRIPT, String(names.length), ...names, op, String(now), ...args], { readyTimeoutMs: 250 });
    if (typeof result === "string" && result !== "unavailable") return result;
    if (required()) throw new Error("Detail preview storage unavailable");
  } catch { if (required()) throw new Error("Detail preview storage unavailable"); }
  const fallback = localOperation(op, names, args, now);
  if (fallback === "unavailable") throw new Error("Detail preview storage unavailable");
  return fallback;
}
type ViewerOptions = { schoolId: string; viewerUserId: string; viewerInstanceId: string; now?: number };
export async function renewDetailPreview(options: ViewerOptions & { binding: DetailPreviewBinding }): Promise<DetailPreviewLease> {
  const k = keys(options.binding);
  const target: RefreshTarget = { studentId: options.binding.studentId, teachingSessionId: options.binding.teachingSessionId,
    supervisionContextId: options.binding.supervisionContextId };
  return JSON.parse(await operation("renew", [viewerKey(options.schoolId, options.viewerUserId, options.viewerInstanceId), k.group, k.image], [randomBytes(24).toString("base64url"), JSON.stringify(target)], options.now ?? Date.now()));
}
export async function releaseDetailPreview(options: ViewerOptions & { leaseId: string; onReleased?: (target: RefreshTarget) => void }): Promise<boolean> {
  const result = await operation("release", [viewerKey(options.schoolId, options.viewerUserId, options.viewerInstanceId)], [options.leaseId], options.now ?? Date.now());
  if (result === "false") return false;
  options.onReleased?.(JSON.parse(result));
  return true;
}
export async function detailPreviewStatus(options: { binding: DetailPreviewBinding; now?: number }): Promise<DetailPreviewLease | null> {
  const k = keys(options.binding);
  const group: Group | null = JSON.parse(await operation("status", ["", k.group, k.image], [], options.now ?? Date.now()));
  return group ? { leaseId: group.leaseId, startedAt: group.startedAt, expiresAt: group.expiresAt } : null;
}
export async function readDetailPreview(options: ViewerOptions & { binding: DetailPreviewBinding }): Promise<DetailPreviewImage | null> {
  const k = keys(options.binding);
  return JSON.parse(await operation("read", [viewerKey(options.schoolId, options.viewerUserId, options.viewerInstanceId), k.group, k.image], [], options.now ?? Date.now()));
}
export async function writeDetailPreview(options: { binding: DetailPreviewBinding; leaseId: string; image: DetailPreviewImage; now?: number }): Promise<"stored" | "stale" | "superseded"> {
  const k = keys(options.binding);
  const result = await operation("write", ["", k.group, k.image], [options.leaseId, JSON.stringify(options.image), String(options.image.timestamp)], options.now ?? Date.now());
  return result === "stored" ? "stored" : result === "superseded" ? "superseded" : "stale";
}
