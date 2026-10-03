import { AsyncResource } from 'node:async_hooks';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readClasspilotDigitalUsageMode } from '../config/classpilotUsageModes.js';
import type { DatabaseProcessRole } from '../config/databasePools.js';

type Lane = 'default' | 'usage_report';
type Release = (error?: Error | boolean) => void;
type ConnectCallback = (error: Error | undefined, client: pg.PoolClient | undefined, release: Release) => void;
export interface FairPoolRuntime {
  now(): number;
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<FairPoolRuntime['setTimer']>): void;
}
interface Entry {
  kind: Lane; deadline: number; callback: ConnectCallback; resource: AsyncResource;
  state: 'queued' | 'native' | 'leased' | 'closing' | 'done'; callerSettled: boolean;
  timer?: ReturnType<FairPoolRuntime['setTimer']>; previous: Entry | null; next: Entry | null;
  nativeClient?: pg.PoolClient; beforeClosing?: Entry['state'];
}
interface ClientState {
  closing: boolean; ended: boolean; connected: boolean; removed: boolean;
  onRemoved: Set<() => void>; owner?: Entry;
}
export interface FairPoolOptions extends Omit<pg.PoolConfig, 'Client' | 'Promise'> {
  Client?: typeof pg.Client; Promise?: PromiseConstructor;
}
export function shouldScheduleUsagePool(role: DatabaseProcessRole, env: NodeJS.ProcessEnv = process.env): boolean {
  return role === 'api' && readClasspilotDigitalUsageMode(env) === 'on';
}


export interface FairMainPoolInstance extends pg.Pool {
  schedulingSnapshot(): {
    max: number; callerBudgetMs: number; queuedDefault: number; queuedUsageReports: number;
    ownedSlots: number; nativeInFlight: number; leased: number; closing: number;
    unendedClients: number; ending: boolean; waitingCount: number;
  };
}

// Preserve native pg logical limits, queries and events. Closing sockets can
// transiently outlive native pool entries; public end tracking makes shutdown
// honest without replacing pg internals or claiming a stricter socket ceiling.
export function createFairMainPoolClass(NativePool: typeof pg.Pool, { readOperation, NativeClient = pg.Client, runtime = {
  now: () => performance.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: timer => clearTimeout(timer),
} }: { readOperation: () => string | undefined; NativeClient?: typeof pg.Client; runtime?: FairPoolRuntime }): new (options: FairPoolOptions) => FairMainPoolInstance {
  return class FairMainPool extends NativePool {
    #queues = { default: new Fifo(), usage_report: new Fifo() };
    #entries = new Set<Entry>();
    #clients = new WeakMap<pg.Client, ClientState>();
    #unendedClients = new Set<pg.Client>();
    #slots = 0;
    #native = 0;
    #leased = 0;
    #closing = 0;
    #pumping = false;
    #last: Lane = 'default';
    #endRequested = false;
    #nativeEndCallReturned = false;
    #ownershipDrained: Promise<void>;
    #resolveOwnershipDrained!: () => void;
    #promise: PromiseConstructor;

    constructor(options: FairPoolOptions) {
      // Scope deliberately matches the existing API main pool only.
      assert.ok(Number.isInteger(options.max) && options.max !== undefined && options.max >= 1 && options.max <= 16);
      assert.equal(options.connectionTimeoutMillis, 5000);
      const ConfiguredClient = options.Client ?? NativeClient;
      const hooks: { created?: (client: pg.Client) => void } = {};
      // options.Client is pg's public custom-client extension point. The
      // subtype sees failed connection attempts before Pool emits connect.
      // A constructor throw propagates to the native-connect catch unchanged.
      const OwnedClient = ConfiguredClient && class extends ConfiguredClient {
        constructor(...args: ConstructorParameters<typeof pg.Client>) { super(...args); hooks.created?.(this); }
      };
      super(OwnedClient ? { ...options, Client: OwnedClient } : options);
      this.#promise = options.Promise ?? Promise;
      // pg declares this readonly property but implements a public getter.
      Object.defineProperty(this, 'waitingCount', { configurable: true, get: () =>
        this.#queues.default.size + this.#queues.usage_report.size +
        Reflect.get(NativePool.prototype, 'waitingCount', this) });
      hooks.created = client => this.#observeClient(client);
      this.#ownershipDrained = new Promise(resolve => { this.#resolveOwnershipDrained = resolve; });
      this.on('connect', client => {
        const state = this.#observeClient(client);
        state.connected = true;
      });
      this.on('remove', client => {
        const state = this.#clients.get(client);
        if (!state) return;
        state.removed = true;
        for (const done of [...state.onRemoved]) done();
        state.onRemoved.clear();
      });
    }

    #observeClient(client: pg.Client) {
      const existing = this.#clients.get(client);
      if (existing) return existing;
      const state: ClientState = { closing: false, ended: false, connected: false, removed: false,
        onRemoved: new Set(), owner: undefined };
      this.#clients.set(client, state);
      this.#unendedClients.add(client);
      client.once('end', () => {
        state.ended = true;
        this.#unendedClients.delete(client);
        // Tracking is global: a constructor reached through pg's native queue
        // must not be attributed to whichever caller's ALS happens to run it.
        // Successful lease permits still wait for release/remove, not end.
        this.#checkOwnershipDrained();
      });
      const originalEnd = client.end;
      const recordEnd = () => {
        if (state.closing) return;
        state.closing = true;
      };
      client.end = function (...args: [] | [callback: (error: Error) => void]) {
        recordEnd();
        return Reflect.apply(originalEnd, this, args);
      };
      return state;
    }

    schedulingSnapshot() {
      return { max: this.options.max, callerBudgetMs: 5000,
        queuedDefault: this.#queues.default.size, queuedUsageReports: this.#queues.usage_report.size,
        ownedSlots: this.#slots, nativeInFlight: this.#native, leased: this.#leased,
        closing: this.#closing, unendedClients: this.#unendedClients.size,
        ending: this.#endRequested, waitingCount: this.waitingCount };
    }

    connect(): Promise<pg.PoolClient>;
    connect(callback: (error: Error | undefined, client: pg.PoolClient | undefined, release: Release) => void): void;
    connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
      if (this.#endRequested) return callback
        ? Reflect.apply(callback, undefined, [new Error('Cannot use a pool after calling end on the pool')])
        : this.#promise.reject(new Error('Cannot use a pool after calling end on the pool'));
      if (!callback) {
        return new this.#promise<pg.PoolClient>((resolve, reject) => this.connect((error, client) => error || !client ? reject(error ?? new Error('Native pool returned no client')) : resolve(client)))
          .catch(error => { Error.captureStackTrace(error); throw error; });
      }
      const entry: Entry = {
        kind: readOperation() === 'usage_report' ? 'usage_report' : 'default',
        deadline: runtime.now() + 5000, callback, resource: new AsyncResource('fair-main-pool-checkout'),
        state: 'queued', callerSettled: false, timer: undefined, previous: null, next: null,
      };
      entry.timer = runtime.setTimer(() => this.#expire(entry), 5000);
      entry.timer?.unref?.();
      this.#entries.add(entry);
      this.#queues[entry.kind].push(entry);
      this.#pump();
      return undefined;
    }

    query: pg.Pool['query'] = (...args: unknown[]) => {
      // Native pg delivers query callbacks from a socket context. Capture an
      // explicitly supplied callback at request entry, while leaving Promise
      // form, SQL, arguments, native dispatch and error handling untouched.
      let index = args.length - 1;
      while (index >= 0 && typeof args[index] !== 'function') index--;
      if (index < 0) return Reflect.apply(super.query, this, args);
      const callback = args[index];
      if (typeof callback !== 'function') throw new TypeError('Query callback must be a function');
      const resource = new AsyncResource('fair-main-pool-query');
      args[index] = function (this: unknown, ...values: unknown[]) {
        try { return resource.runInAsyncScope(() => Reflect.apply(callback, this, values)); }
        finally { resource.emitDestroy(); }
      };
      try { return Reflect.apply(super.query, this, args); }
      catch (error) { resource.emitDestroy(); throw error; }
    }

    #settle(entry: Entry, error?: Error, client?: pg.PoolClient, release?: Release) {
      if (entry.callerSettled) return;
      entry.callerSettled = true;
      if (entry.timer) runtime.clearTimer(entry.timer);
      try { entry.resource.runInAsyncScope(entry.callback, undefined, error, client, release); }
      finally { entry.resource.emitDestroy(); }
    }

    #expire(entry: Entry) {
      if (entry.callerSettled) return;
      if (entry.state === 'queued') {
        this.#queues[entry.kind].remove(entry);
        entry.state = 'done';
        this.#entries.delete(entry);
      }
      // Native-in-flight ownership survives this rejection until settlement.
      try { this.#settle(entry, new Error('timeout exceeded when trying to connect')); }
      finally { this.#pump(); }
    }

    #pump() {
      if (this.#pumping || this.#endRequested) return;
      this.#pumping = true;
      try {
        while (this.#slots < this.options.max) {
          const a = this.#queues.default.size, b = this.#queues.usage_report.size;
          if (!a && !b) break;
          const kind = a && b ? (this.#last === 'default' ? 'usage_report' : 'default') : b ? 'usage_report' : 'default';
          const entry = this.#queues[kind].shift();
          if (!entry) break;
          if (runtime.now() >= entry.deadline) {
            entry.state = 'done'; this.#entries.delete(entry);
            this.#settle(entry, new Error('timeout exceeded when trying to connect'));
            continue;
          }
          this.#last = kind;
          entry.state = 'native'; this.#slots++; this.#native++;
          let callbackEntered = false;
          const complete = (error?: Error, client?: pg.PoolClient, release?: Release) => {
            callbackEntered = true;
            this.#native--;
            if (error || !client) {
              // Native failure returns no client. Its callback ends this
              // admission permit; global public-end tracking owns any closing
              // socket independently and keeps shutdown honest.
              this.#finish(entry);
              this.#settle(entry, error ?? new Error('Native pool returned no client'));
              return;
            }
            entry.nativeClient = client;
            const state = this.#clients.get(client);
            if (state) state.owner = entry;
            const nativeRelease = release ?? client.release;
            let released = false;
            const wrappedRelease: Release = error => {
              if (released) throw new Error('Release called on client which has already been released to the pool.');
              released = true;
              // Do not admit replacement work until synchronous release and any
              // resulting public remove event have completed. Unexpected release
              // throws retain ownership rather than guessing the client is safe.
              Reflect.apply(nativeRelease, client, [error]);
              this.#finishWhenRemoved(entry, client);
            };
            client.release = wrappedRelease;
            entry.state = 'leased'; this.#leased++;
            if (entry.callerSettled || this.#endRequested || runtime.now() >= entry.deadline) {
              wrappedRelease();
              if (!entry.callerSettled) this.#settle(entry, new Error(this.#endRequested
                ? 'Cannot use a pool after calling end on the pool' : 'timeout exceeded when trying to connect'));
              return;
            }
            this.#settle(entry, undefined, client, wrappedRelease);
          };
          try {
            entry.resource.runInAsyncScope(() => super.connect(complete));
          } catch (error) {
            if (callbackEntered) throw error; // Never reinterpret a caller callback throw as a connect failure.
            complete(error instanceof Error ? error : new Error(String(error)));
          }
        }
      } finally { this.#pumping = false; }
    }

    #finishWhenRemoved(entry: Entry, client: pg.PoolClient) {
      const state = client && this.#clients.get(client);
      if (state?.connected && state.closing && !state.removed) {
        entry.beforeClosing = entry.state;
        entry.state = 'closing'; this.#closing++;
        state.onRemoved.add(() => this.#finish(entry));
      } else this.#finish(entry);
    }

    #finish(entry: Entry) {
      if (entry.state === 'done') return;
      if (entry.state === 'leased' || entry.beforeClosing === 'leased') this.#leased--;
      if (entry.state === 'closing') this.#closing--;
      entry.state = 'done'; this.#slots--; this.#entries.delete(entry);
      const state = entry.nativeClient && this.#clients.get(entry.nativeClient);
      if (state?.owner === entry) state.owner = undefined;
      this.#checkOwnershipDrained();
      this.#pump();
    }

    #checkOwnershipDrained() {
      // Native end synchronously starts idle closes. Do not resolve before
      // all of those newly-owned closes have been registered.
      if (this.#nativeEndCallReturned && this.#slots === 0 && this.#unendedClients.size === 0) this.#resolveOwnershipDrained();
    }

    end(): Promise<void>;
    end(callback: (error?: Error) => void): void;
    end(callback?: (error?: Error) => void): Promise<void> | void {
      if (this.#endRequested) return callback
        ? callback(new Error('Called end on pool more than once'))
        : this.#promise.reject(new Error('Called end on pool more than once'));
      this.#endRequested = true;
      let callbackThrew = false, callbackError;
      // Rejections are delivered in the original ALS context; live leases still
      // belong to their callers and native-in-flight leases remain owned here.
      for (const entry of [...this.#entries]) {
        if (entry.state === 'queued') {
          this.#queues[entry.kind].remove(entry); entry.state = 'done'; this.#entries.delete(entry);
        }
        if (!entry.callerSettled) {
          try { this.#settle(entry, new Error('Cannot use a pool after calling end on the pool')); }
          catch (error) { if (!callbackThrew) { callbackThrew = true; callbackError = error; } }
        }
      }
      const nativeEnded = new this.#promise<void>((resolve, reject) => super.end((error?: Error) => error ? reject(error) : resolve()));
      this.#nativeEndCallReturned = true;
      this.#checkOwnershipDrained();
      const result = this.#promise.all([nativeEnded, this.#ownershipDrained]).then(() => undefined);
      // A caller's thrown callback must remain a throw without preventing
      // already-owned cleanup or generating an orphaned rejection later.
      if (callbackThrew) { void result.catch(() => {}); throw callbackError; }
      if (callback) { result.then(() => callback(), error => callback(error)); return undefined; }
      return result;
    }
  };
}

class Fifo {
  head: Entry | null = null; tail: Entry | null = null; size = 0;
  push(entry: Entry) { entry.previous = this.tail; if (this.tail) this.tail.next = entry; else this.head = entry; this.tail = entry; this.size++; }
  shift() { const entry = this.head; if (entry) this.remove(entry); return entry; }
  remove(entry: Entry) {
    if (entry.previous) entry.previous.next = entry.next; else this.head = entry.next;
    if (entry.next) entry.next.previous = entry.previous; else this.tail = entry.previous;
    entry.previous = entry.next = null; this.size--;
  }
}
