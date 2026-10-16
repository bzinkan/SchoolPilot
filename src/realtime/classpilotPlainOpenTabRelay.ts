import { createHash } from "node:crypto";
import type { WsRedisTarget } from "./ws-redis.js";

/** Receiving-side coalescing only. Original one-shot frames are never rebuilt. */
export type PlainOpenTabRelayTarget = Extract<WsRedisTarget, { kind: "student-binding" }>;

type RecordValue = Record<string, unknown>;
export type PlainOpenTabRelayRow = PlainOpenTabRelayTarget & { frame: RecordValue };
export type PlainOpenTabRelayAuthority = {
  command: {
    id: string; schoolId: string; commandType: string; commandPayload: unknown;
    teachingSessionId: string | null; supervisionContextId: string | null;
    expiresAt: Date | null;
  };
  isCurrent: () => boolean;
};
type Outcome = { authorized: true; value: boolean } | { authorized: false };
type Ports = {
  hasLocal: (target: PlainOpenTabRelayTarget, message: unknown) => boolean;
  sendLocal: (target: PlainOpenTabRelayTarget, message: unknown) => boolean;
  fallback: (target: PlainOpenTabRelayTarget, message: unknown) => Promise<boolean>;
  runBatch: (options: { schoolId: string; commandId: string; targets: readonly PlainOpenTabRelayRow[] },
    send: (target: PlainOpenTabRelayRow, authority: PlainOpenTabRelayAuthority) => boolean) => Promise<readonly Outcome[]>;
  now?: () => number;
  monotonicNow?: () => number;
  onQueueWait?: (durationMs: number) => void;
  onNotAdmitted?: () => void;
};
export const PLAIN_OPEN_TAB_RELAY_LIMITS = Object.freeze({
  targetsPerBatch: 40, groups: 32, frames: 1280, bytes: 1024 * 1024, concurrentBatches: 2,
});
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object"
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const id = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 256 && value === value.trim();
const exact = (value: RecordValue, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const expiry = (value: unknown): number => {
  if (typeof value !== "string") return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
};
const frameKeys = ["type", "_msgId", "commandId", "studentId", "studentSessionId", "deliveryPolicy", "expiresAt", "command"];
const commandKeys = ["type", "commandId", "studentId", "studentSessionId", "deliveryPolicy", "expiresAt",
  "authority", "teachingSessionId", "supervisionContextId", "data"];
function plainFrame(target: PlainOpenTabRelayTarget, value: unknown, now: number): value is RecordValue {
  if (![target.schoolId, target.studentId, target.studentSessionId, target.deviceId].every(id)
    || !object(value) || !exact(value, frameKeys) || value.type !== "remote-control" || !id(value._msgId)
    || !id(value.commandId) || value.studentId !== target.studentId || value.studentSessionId !== target.studentSessionId
    || value.deliveryPolicy !== "transient_action" || !(expiry(value.expiresAt) > now)
    || !object(value.command) || !exact(value.command, commandKeys)) return false;
  const command = value.command;
  return command.type === "open-tab" && command.commandId === value.commandId
    && command.studentId === target.studentId && command.studentSessionId === target.studentSessionId
    && command.deliveryPolicy === value.deliveryPolicy && expiry(command.expiresAt) > now
    && command.expiresAt === value.expiresAt && object(command.data) && exact(command.data, ["url"])
    && typeof command.data.url === "string" && /^https?:\/\//i.test(command.data.url)
    && object(command.authority) && exact(command.authority, ["teachingSessionId", "supervisionContextId"])
    && command.teachingSessionId === command.authority.teachingSessionId
    && command.supervisionContextId === command.authority.supervisionContextId
    && ((id(command.teachingSessionId) && command.supervisionContextId === null)
      || (id(command.supervisionContextId) && command.teachingSessionId === null));
}
function freeze(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  Object.freeze(value);
}
function matchesAuthority(row: PlainOpenTabRelayRow, authority: PlainOpenTabRelayAuthority, now: number): boolean {
  if (!plainFrame(row, row.frame, now)) return false;
  const original = row.frame.command as RecordValue, command = authority.command;
  const data = original.data as RecordValue, claimed = original.authority as RecordValue;
  return command.schoolId === row.schoolId && command.id === row.frame.commandId
    && command.id === original.commandId && command.commandType === "open-tab"
    && object(command.commandPayload) && exact(command.commandPayload, ["url"])
    && command.commandPayload.url === data.url
    && claimed.teachingSessionId === command.teachingSessionId
    && claimed.supervisionContextId === command.supervisionContextId
    && original.teachingSessionId === command.teachingSessionId
    && original.supervisionContextId === command.supervisionContextId
    && command.expiresAt instanceof Date && Number.isFinite(command.expiresAt.getTime())
    && expiry(row.frame.expiresAt) <= command.expiresAt.getTime()
    && expiry(original.expiresAt) <= command.expiresAt.getTime();
}
type Item = { row: PlainOpenTabRelayRow; bytes: number; enqueuedAt: number; resolve: (value: boolean) => void };
type Group = { key: string; schoolId: string; commandId: string; items: Item[] };
type KnownFrame = { signature: string; promise: Promise<boolean>; expiresAt: number; bytes: number };

export class ClasspilotPlainOpenTabRelay {
  private readonly queued = new Map<string, Group>();
  private readonly activeKeys = new Set<string>();
  // Retain only hashes and owned outcomes until the ORIGINAL deadline. A Redis
  // duplicate after a partial send/commit failure must not open another attempt.
  private readonly known = new Map<string, Map<string, KnownFrame>>();
  private knownFrames = 0;
  private knownBytes = 0;
  private readonly pending = new Set<Promise<boolean>>();
  private flushHandle: ReturnType<typeof setImmediate> | undefined;
  private active = 0;
  private frames = 0;
  private bytes = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  constructor(private readonly ports: Ports) {
    this.now = ports.now ?? Date.now;
    this.monotonicNow = ports.monotonicNow ?? (() => performance.now());
  }

  deliver(target: PlainOpenTabRelayTarget, message: unknown): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    let row: PlainOpenTabRelayRow, bytes: number, signature: string;
    try {
      if (!plainFrame(target, message, -Infinity)) return this.fallback(target, message);
      if (!plainFrame(target, message, this.now())) return Promise.resolve(false);
      const copy = structuredClone({ ...target, frame: message });
      const encoded = JSON.stringify(copy);
      bytes = Buffer.byteLength(encoded);
      signature = createHash("sha256").update(encoded).digest("hex");
      freeze(copy); row = copy;
    } catch { return this.notAdmitted(); }
    const key = JSON.stringify([row.schoolId, row.frame.commandId]);
    this.pruneKnown();
    const known = this.known.get(key);
    const duplicate = known?.get(row.studentId);
    if (duplicate) return duplicate.signature === signature ? duplicate.promise : this.notAdmitted();
    const previous = this.queued.get(key);
    if ((!known && this.known.size >= PLAIN_OPEN_TAB_RELAY_LIMITS.groups)
      || (known?.size ?? 0) >= PLAIN_OPEN_TAB_RELAY_LIMITS.targetsPerBatch
      || this.frames >= PLAIN_OPEN_TAB_RELAY_LIMITS.frames
      || this.knownFrames >= PLAIN_OPEN_TAB_RELAY_LIMITS.frames
      || bytes > PLAIN_OPEN_TAB_RELAY_LIMITS.bytes - this.bytes
      || bytes > PLAIN_OPEN_TAB_RELAY_LIMITS.bytes - this.knownBytes) return this.notAdmitted();
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    const item = { row, bytes, resolve, enqueuedAt: this.monotonicNow() };
    const group = previous ?? { key, schoolId: row.schoolId, commandId: String(row.frame.commandId), items: [] };
    const history = known ?? new Map<string, KnownFrame>();
    try {
      history.set(row.studentId, { signature, promise, expiresAt: expiry(row.frame.expiresAt), bytes });
      if (!known) this.known.set(key, history);
      if (!previous) this.queued.set(key, group);
      group.items.push(item);
    } catch {
      history.delete(row.studentId);
      if (!known) this.known.delete(key);
      if (!previous) this.queued.delete(key);
      resolve(false); return this.notAdmitted();
    }
    this.frames++; this.bytes += bytes; this.knownFrames++; this.knownBytes += bytes;
    this.own(promise); this.schedule(); return promise;
  }

  stop(): void {
    this.stopped = true;
    if (this.flushHandle) { clearImmediate(this.flushHandle); this.flushHandle = undefined; }
    this.flush();
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  state() { return { queuedGroups: this.queued.size, activeBatches: this.active,
    frames: this.frames, bytes: this.bytes, pending: this.pending.size, stopped: this.stopped }; }

  private own(promise: Promise<boolean>): void {
    this.pending.add(promise);
    const remove = () => { this.pending.delete(promise); };
    void promise.then(remove, remove);
  }
  private fallback(target: PlainOpenTabRelayTarget, message: unknown): Promise<boolean> {
    const promise = Promise.resolve().then(() => this.ports.fallback(target, message)).catch(() => false);
    this.own(promise); return promise;
  }
  private release(item: Item): void { this.frames--; this.bytes -= item.bytes; }
  private notAdmitted(): Promise<boolean> {
    try { this.ports.onNotAdmitted?.(); } catch { /* Numeric diagnostics cannot own delivery. */ }
    return Promise.resolve(false);
  }
  private pruneKnown(): void {
    const now = this.now();
    for (const [key, group] of this.known) {
      if (this.activeKeys.has(key) || this.queued.has(key)) continue;
      for (const [student, entry] of group) if (entry.expiresAt <= now) {
        group.delete(student); this.knownFrames--; this.knownBytes -= entry.bytes;
      }
      if (!group.size) this.known.delete(key);
    }
  }
  private schedule(): void {
    if (this.flushHandle) return;
    try { this.flushHandle = setImmediate(() => { this.flushHandle = undefined; this.flush(); }); }
    catch {
      for (const group of this.queued.values()) for (const item of group.items) {
        this.release(item); item.resolve(false);
      }
      this.queued.clear();
    }
  }
  private flush(): void {
    while (this.active < PLAIN_OPEN_TAB_RELAY_LIMITS.concurrentBatches && this.queued.size) {
      const group = [...this.queued.values()].find(value => !this.activeKeys.has(value.key));
      if (!group) return;
      this.queued.delete(group.key);
      const current: Item[] = [];
      for (const item of group.items) {
        let admitted = false;
        try { admitted = plainFrame(item.row, item.row.frame, this.now()) && this.ports.hasLocal(item.row, item.row.frame); }
        catch { /* A local socket lookup failure retires only this owned item. */ }
        if (admitted) {
          current.push(item);
          try { this.ports.onQueueWait?.(Math.max(0, this.monotonicNow() - item.enqueuedAt)); } catch { /* Numeric sink only. */ }
        } else { this.release(item); item.resolve(false); }
      }
      if (!current.length) continue;
      this.active++; this.activeKeys.add(group.key);
      void this.run(group, current);
    }
  }
  private async run(group: Group, items: Item[]): Promise<void> {
    try {
      const outcomes = await this.ports.runBatch({ schoolId: group.schoolId, commandId: group.commandId,
        targets: items.map(item => item.row) }, (row, authority) => {
        if (!matchesAuthority(row, authority, this.now()) || !this.ports.hasLocal(row, row.frame)) return false;
        // No await between the original two deadlines, database-clock lease and
        // final exact socket/capability check and the unchanged local send.
        if (!(expiry(row.frame.expiresAt) > this.now())
          || !(expiry((row.frame.command as RecordValue).expiresAt) > this.now()) || !authority.isCurrent()) return false;
        return this.ports.sendLocal(row, row.frame);
      });
      for (let i = 0; i < items.length; i++) {
        const outcome = outcomes[i]; items[i]!.resolve(outcome?.authorized === true && outcome.value === true);
      }
    } catch {
      // A synchronous send can precede a later send/commit error. It is never
      // safe to retry or route this group through the serialized path now.
      for (const item of items) item.resolve(false);
    } finally {
      for (const item of items) this.release(item);
      this.active--; this.activeKeys.delete(group.key);
      if (this.stopped) this.flush(); else if (this.queued.size) this.schedule();
    }
  }
}
