import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { createFairMainPoolClass } from '../src/db/fairMainPool.ts';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const als = new AsyncLocalStorage();
const tick = () => new Promise(resolve => setImmediate(resolve));
class Clock {
  time = 0; timers = new Set();
  now = () => this.time;
  setTimer = (callback, ms) => { const t = { callback, at: this.time + ms, unref() {} }; this.timers.add(t); return t; };
  clearTimer = timer => this.timers.delete(timer);
  advance(ms) {
    this.time += ms;
    while (true) { const t = [...this.timers].sort((a, b) => a.at - b.at).find(t => t.at <= this.time); if (!t) break; this.timers.delete(t); t.callback(); }
  }
}
function fixture(t, { syncConnect = false, deferClose = false, loseQueryContext = false, max = 16 } = {}) {
  const clock = new Clock(), clients = [], events = [], acquired = [], queryCalls = [];
  let alive = 0, peakAlive = 0;
  class FakeClient extends EventEmitter {
    _queryable = true; _ending = false; ended = false;
    constructor(options) { super(); this.options = options; clients.push(this); alive++; peakAlive = Math.max(peakAlive, alive); }
    connect(callback) { this.connectionCallback = AsyncResource.bind(callback); if (syncConnect) this.succeed(); }
    succeed() { const cb = this.connectionCallback; this.connectionCallback = null; cb?.(); }
    fail(error) { const cb = this.connectionCallback; this.connectionCallback = null; this.finishEnd(); cb?.(error); }
    isConnected() { return !this.connectionCallback && !this.ended; }
    ref() {} unref() {}
    end(callback) {
      assert.equal(this instanceof FakeClient, true, 'end receiver preserved');
      this._ending = true;
      if (this.ended) { if (callback) { callback(); return; } return Promise.resolve(); }
      const result = callback ? undefined : new Promise(resolve => { callback = resolve; });
      (this.endCallbacks ??= []).push(callback);
      if (!deferClose) queueMicrotask(() => this.finishEnd());
      return result;
    }
    finishEnd(error) {
      if (!this.ended) { this.ended = true; alive--; this.emit('end'); }
      for (const cb of this.endCallbacks?.splice(0) ?? []) cb(error);
    }
    query(text, values, callback) {
      if (typeof values === 'function') { callback = values; values = undefined; }
      queryCalls.push({ text, values, context: als.getStore() });
      if (text === 'sync throw') throw new Error('query threw');
      this.queryCallback = loseQueryContext ? callback : AsyncResource.bind(callback);
    }
    finishQuery(error, result = { rows: [{ ok: true }] }) { const cb = this.queryCallback; this.queryCallback = null; cb(error, result); }
  }
  const FairPool = createFairMainPoolClass(Pool, { readOperation: () => als.getStore()?.operation, runtime: clock });
  const pool = new FairPool({ max, min: 0, connectionTimeoutMillis: 5000, idleTimeoutMillis: 0, Client: FakeClient });
  for (const event of ['connect', 'acquire', 'release', 'remove', 'error']) pool.on(event, (...args) => events.push({ event, args }));
  pool.on('acquire', client => acquired.push(client));
  let cleanupStarted = false;
  const cleanup = async () => {
    if (cleanupStarted) return; cleanupStarted = true;
    const ended = pool.ending ? undefined : pool.end();
    for (const c of clients) c.succeed();
    for (const c of clients) { if (c.release) { try { c.release(); } catch (error) { assert.match(error.message, /already been released/); } } c.finishEnd(); }
    await ended; await tick();
    assert.equal(pool.schedulingSnapshot().ownedSlots, 0);
    assert.equal(clock.timers.size, 0);
    assert.equal(alive, 0);
  };
  t.after(cleanup);
  const connect = (operation = 'default', id = operation) => als.run({ operation, id }, () => pool.connect());
  const occupy = async () => { const promises = Array.from({ length: max }, (_, i) => connect('default', 'held' + i)); clients.forEach(c => c.succeed()); return Promise.all(promises); };
  return { clock, clients, events, acquired, queryCalls, pool, connect, occupy, cleanup, physical: () => ({ alive, peakAlive }) };
}

test('all16 native slots are work-conserving and prewarm releases remain reusable', async t => {
  const f = fixture(t), held = await f.occupy();
  assert.equal(f.pool.totalCount, 16); assert.equal(f.physical().peakAlive, 16);
  held.forEach(c => c.release());
  assert.equal(f.pool.idleCount, 16); assert.equal(f.pool.waitingCount, 0);
  const c = await f.connect(); c.release(); assert.equal(f.clients.length, 16);
});
test('FIFO within each class and starvation-safe alternation with both queues pending', async t => {
  const f = fixture(t), held = await f.occupy(), order = [];
  const jobs = ['d0','d1','d2','r0','r1','r2'].map(id => f.connect(id[0] === 'r' ? 'usage_report' : 'default', id).then(c => { order.push(id); c.release(); }));
  assert.equal(f.pool.waitingCount, 6);
  held[0].release(); await Promise.all(jobs);
  assert.deepEqual(order, ['r0','d0','r1','d1','r2','d2']);
  held.slice(1).forEach(c => c.release());
});
test('default flood cannot starve reports and report flood cannot reserve unused capacity', async t => {
  const f = fixture(t), held = await f.occupy(), order = [];
  const jobs = Array.from({length:80},(_,i)=>f.connect(i<40?'default':'usage_report',String(i)).then(c=>{order.push(i);c.release();}));
  held[0].release(); await Promise.all(jobs);
  for(let i=0;i<80;i+=2){assert.equal(order[i],40+i/2);assert.equal(order[i+1],i/2);}
  held.slice(1).forEach(c=>c.release());
  const reports=Array.from({length:16},()=>f.connect('usage_report')); const all=await Promise.all(reports);
  assert.equal(f.pool.schedulingSnapshot().leased,16);all.forEach(c=>c.release());
});
test('only exact trusted usage_report label receives the report lane', async t => {
  const f=fixture(t),held=await f.occupy(),order=[];
  const a=f.connect('usage_report_admission').then(c=>{order.push('default');c.release();});
  const b=f.connect('usage_report').then(c=>{order.push('report');c.release();});
  held[0].release();await Promise.all([a,b]);assert.deepEqual(order,['report','default']);held.slice(1).forEach(c=>c.release());
});
test('outer queue expires before dispatch without allocating a native client', async t => {
  const f=fixture(t),held=await f.occupy();const pending=f.connect();const rejected=assert.rejects(pending,/timeout exceeded/);
  f.clock.advance(5000);await rejected;assert.equal(f.pool.waitingCount,0);assert.equal(f.clients.length,16);held.forEach(c=>c.release());
});
test('caller deadline covers queue plus native connect, retaining late native ownership', async t => {
  const f=fixture(t,{deferClose:true}),held=await f.occupy();const pending=f.connect();const rejected=assert.rejects(pending,/timeout exceeded/);
  f.clock.advance(4000);held[0].release(new Error('discard'));assert.equal(f.pool.schedulingSnapshot().closing,1);
  held[0].finishEnd();assert.equal(f.clients.length,17);assert.equal(f.physical().peakAlive,16);
  f.clock.advance(1000);await rejected;assert.equal(f.pool.schedulingSnapshot().nativeInFlight,1);assert.equal(f.pool.schedulingSnapshot().ownedSlots,16);
  f.clients[16].succeed();assert.equal(f.pool.schedulingSnapshot().nativeInFlight,0);assert.equal(f.pool.schedulingSnapshot().ownedSlots,15);
  assert.equal(f.pool.idleCount,1);held.slice(1).forEach(c=>c.release());
});
test('deadline check rejects a late callback even before delayed timer can run', async t => {
  const f=fixture(t);const promise=f.connect();const rejected=assert.rejects(promise,/timeout exceeded/);f.clock.time=5001;f.clients[0].succeed();await rejected;assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);
});
test('native connect error is passed unchanged and frees its permit once', async t => {
  const f=fixture(t),error=new Error('native refused'),p=f.connect();const rejected=assert.rejects(p,e=>e===error);f.clients[0].fail(error);await rejected;assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);
});
test('callback connect supplies identical third release and original ALS after queueing', async t => {
  const f=fixture(t),held=await f.occupy();let received;
  const returned=als.run({operation:'usage_report',id:'original'},()=>f.pool.connect((error,client,release)=>{assert.equal(error,undefined);received=als.getStore();assert.equal(release,client.release);release();assert.throws(release,/already been released/);}));
  assert.equal(returned,undefined);als.run({operation:'default',id:'other'},()=>held[0].release());await tick();assert.deepEqual(received,{operation:'usage_report',id:'original'});held.slice(1).forEach(c=>c.release());
});
test('Promise continuations retain caller ALS while simultaneous tenants remain separate', async t => {
  const f=fixture(t),held=await f.occupy();const seen=[];
  const jobs=['A','B'].map(id=>als.run({operation:'usage_report',id},async()=>{const c=await f.pool.connect();seen.push(als.getStore().id);c.release();}));
  held[0].release();await Promise.all(jobs);assert.deepEqual(seen,['A','B']);held.slice(1).forEach(c=>c.release());
});
test('inherited Promise pool.query uses scheduler and preserves SQL/values/result', async t => {
  const f=fixture(t),held=await f.occupy(),sql={text:'SELECT $1',name:'same-config'},values=['quoted value'];
  const query=als.run({operation:'usage_report',id:'query-owner'},()=>f.pool.query(sql,values));held[0].release();await tick();
  assert.deepEqual(f.queryCalls[0],{text:sql,values,context:{operation:'usage_report',id:'query-owner'}});
  const active=f.clients.find(c=>c.queryCallback),result={rows:[{value:'returned'}]};active.finishQuery(undefined,result);assert.equal(await query,result);held.slice(1).forEach(c=>c.release());
});
test('callback pool.query preserves overload, callback ALS and one lease release', async t => {
  const f=fixture(t),seen=[];
  const returned=als.run({operation:'usage_report',id:'cb'},()=>f.pool.query('SELECT 1',(error,result)=>{seen.push([error,result,als.getStore()]);}));
  assert.equal(returned,undefined);f.clients[0].succeed();f.clients[0].finishQuery();assert.equal(seen.length,1);assert.deepEqual(seen[0][2],{operation:'usage_report',id:'cb'});assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);
});
test('query callback throw remains a caller throw after exactly one healthy release', async t => {
  const f=fixture(t),error=new Error('caller throw');f.pool.query('SELECT 1',()=>{throw error;});f.clients[0].succeed();assert.throws(()=>f.clients[0].finishQuery(),e=>e===error);assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);
});
test('connect callback throw does not become a second callback or release its owned client', async t => {
  const f=fixture(t),error=new Error('caller threw');let calls=0,client;
  f.pool.connect((e,c)=>{calls++;client=c;throw error;});assert.throws(()=>f.clients[0].succeed(),e=>e===error);assert.equal(calls,1);assert.equal(f.pool.schedulingSnapshot().ownedSlots,1);client.release();
});
test('sync native connect and callback throws retain pg callback semantics', async t => {
  const f=fixture(t,{syncConnect:true}),error=new Error('sync caller');let release;
  assert.throws(()=>f.pool.connect((e,c,r)=>{release=r;throw error;}),e=>e===error);assert.equal(f.pool.schedulingSnapshot().ownedSlots,1);release();
});
test('query errors discard and keep capacity until asynchronous physical removal', async t => {
  const f=fixture(t,{deferClose:true}),held=await f.occupy();const query=f.pool.query('SELECT 1');const rejected=assert.rejects(query,/bad query/);held[0].release();await tick();const c=f.clients.find(c=>c.queryCallback);c.finishQuery(new Error('bad query'));await rejected;
  const next=f.connect();assert.equal(f.pool.waitingCount,1);assert.equal(f.pool.schedulingSnapshot().closing,1);assert.equal(f.clients.length,16);c.finishEnd();f.clients[16].succeed();(await next).release();assert.equal(f.physical().peakAlive,16);held.slice(1).forEach(c=>c.release());
});
test('native query synchronous error preserves rejection and discarded cleanup', async t => {
  const f=fixture(t);const promise=f.pool.query('sync throw');const rejected=assert.rejects(promise,/query threw/);f.clients[0].succeed();await rejected;await tick();assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);
});
test('end then await then release uses original end Promise and remove before permit release', async t => {
  const f=fixture(t,{deferClose:true});const p=f.connect();f.clients[0].succeed();const c=await p;const ending=c.end();assert.ok(ending instanceof Promise);assert.equal(f.pool.schedulingSnapshot().ownedSlots,1);c.finishEnd();await ending;assert.equal(f.pool.schedulingSnapshot().ownedSlots,1);c.release();assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);
});
test('explicit end callback and async discard close error preserve argument/receiver behavior', async t => {
  const f=fixture(t,{deferClose:true});const p=f.connect();f.clients[0].succeed();const c=await p,error=new Error('close callback error');let observed;c.end(e=>{observed=e;});c.release(error);assert.equal(f.pool.schedulingSnapshot().closing,1);c.finishEnd(error);assert.equal(observed,error);assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);
});
test('idle client errors preserve native error/remove events without freeing another lease', async t => {
  const f=fixture(t),held=await f.occupy();held[0].release();const error=new Error('idle error');held[0].emit('error',error);await tick();assert.equal(f.pool.schedulingSnapshot().ownedSlots,15);assert.ok(f.events.some(e=>e.event==='error'&&e.args[0]===error));held.slice(1).forEach(c=>c.release());
});
test('pool.end rejects queued callers and waits for live plus late native cleanup', async t => {
  const f=fixture(t,{deferClose:true});const live=f.connect();f.clients[0].succeed();const c=await live;const pending=Array.from({length:16},()=>f.connect());const rejected=pending.map(p=>assert.rejects(p,/after calling end/));let complete=false;const ending=f.pool.end().then(()=>{complete=true;});await Promise.all(rejected);await tick();assert.equal(complete,false);assert.equal(f.pool.waitingCount,0);
  f.clients.slice(1).forEach(c=>c.succeed());assert.equal(f.pool.schedulingSnapshot().closing,15);f.clients.slice(1).forEach(c=>c.finishEnd());c.release();c.finishEnd();await ending;assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);assert.equal(f.physical().peakAlive,16);
});
test('callback pool.end and duplicate end/connect errors preserve public forms', async t => {
  const f=fixture(t);let calls=0;const result=f.pool.end(error=>{assert.equal(error,undefined);calls++;});assert.equal(result,undefined);await tick();assert.equal(calls,1);await assert.rejects(f.pool.end(),/more than once/);let cbError;f.pool.end(e=>{cbError=e;});assert.match(cbError.message,/more than once/);await assert.rejects(f.connect(),/after calling end/);
});
test('invalid inherited query function overload remains native asynchronous error', async t => {
  const f=fixture(t);let error;const result=f.pool.query(e=>{error=e;});assert.equal(result,undefined);await tick();assert.match(error.message,/not supported/);assert.equal(f.clients.length,0);
});
test('prototype refuses pool budget changes and preserves native options', () => {
  const Class=createFairMainPoolClass(Pool,{readOperation:()=>undefined});assert.throws(()=>new Class({max:17,connectionTimeoutMillis:5000}));assert.throws(()=>new Class({max:16,connectionTimeoutMillis:6000}));
});
test('a rejected queued callback throwing during end does not strand native shutdown', async t => {
  const f=fixture(t),held=await f.occupy(),error=new Error('queued callback threw');let calls=0;
  f.pool.connect(()=>{calls++;throw error;});
  assert.throws(()=>f.pool.end(),e=>e===error);
  assert.equal(f.pool.ending,true,'native end starts even when a caller throws');
  held.forEach(c=>c.release());await tick();assert.equal(calls,1);assert.equal(f.pool.ended,true);
});

function edgeNative(connect) {
  return class extends EventEmitter {
    constructor(options){super();this.options=options;this.Promise=Promise;}
    connect(callback){return connect.call(this,callback);}
    get waitingCount(){return 0;}
    end(callback){this.ending=true;queueMicrotask(()=>{this.ended=true;callback();});}
  };
}
test('synchronous native error, native throw and no-client callback each settle once', async () => {
  for(const mode of ['callback-error','throw','no-client']){
    const original=new Error(mode),clock=new Clock();
    const Class=createFairMainPoolClass(edgeNative(function(cb){if(mode==='throw')throw original;if(mode==='callback-error')cb(original);else cb();}),{readOperation:()=>undefined,runtime:clock});
    const pool=new Class({max:16,connectionTimeoutMillis:5000});let calls=0;
    pool.connect(error=>{calls++;if(mode==='no-client')assert.match(error.message,/no client/);else assert.equal(error,original);});
    assert.equal(calls,1);assert.equal(pool.schedulingSnapshot().ownedSlots,0);assert.equal(clock.timers.size,0);await pool.end();
  }
});
test('delayed idle error preserves pg configured capacity and tracks all closes for shutdown', async t => {
  const f=fixture(t,{deferClose:true}),held=await f.occupy();held.forEach(c=>c.release());
  held[0].emit('error',new Error('idle close delayed'));
  const jobs=Array.from({length:16},()=>f.connect());await tick();
  assert.equal(f.pool.totalCount,16);assert.equal(f.pool.schedulingSnapshot().ownedSlots,16);
  f.clients.slice(16).forEach(c=>c.succeed());const clients=await Promise.all(jobs);clients.forEach(c=>c.release());
  assert.equal(f.pool.schedulingSnapshot().unendedClients,17);held[0].finishEnd();
});
test('all idle clients closing preserve native max and independent pending-end tracking', async t => {
  const f=fixture(t,{deferClose:true}),held=await f.occupy();held.forEach(c=>c.release());held.forEach(c=>c.emit('error',new Error('all idle delayed')));
  const jobs=Array.from({length:16},()=>f.connect());await tick();assert.equal(f.pool.totalCount,16);assert.equal(f.pool.schedulingSnapshot().ownedSlots,16);
  assert.equal(f.pool.schedulingSnapshot().unendedClients,32);
  for(let i=0;i<16;i++){held[i].finishEnd();f.clients[16+i].succeed();}
  (await Promise.all(jobs)).forEach(c=>c.release());
});
test('pool.end waits for idle removals already started outside end', async t => {
  const f=fixture(t,{deferClose:true}),held=await f.occupy();held.forEach(c=>c.release());held.forEach(c=>c.emit('error',new Error('idle delayed')));
  let ended=false;const ending=f.pool.end().then(()=>{ended=true;});await tick();assert.equal(ended,false);assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);assert.equal(f.pool.schedulingSnapshot().unendedClients,16);
  held.forEach(c=>c.finishEnd());await ending;assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);
});
test('pool.end initiates and waits for delayed healthy-idle closure', async t => {
  const f=fixture(t,{deferClose:true}),held=await f.occupy();held.forEach(c=>c.release());let ended=false;const ending=f.pool.end().then(()=>{ended=true;});await tick();assert.equal(ended,false);
  held.forEach(c=>c.finishEnd());await ending;assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);assert.equal(f.physical().alive,0);
});
test('configured Client synchronous constructor throw frees unregistered native permit', async () => {
  const clock=new Clock(),error=new Error('constructor rejected');class Client{constructor(){throw error;}}
  const Class=createFairMainPoolClass(Pool,{readOperation:()=>undefined,runtime:clock});const pool=new Class({max:16,connectionTimeoutMillis:5000,Client});
  await assert.rejects(pool.connect(),e=>e===error);assert.equal(pool.schedulingSnapshot().ownedSlots,0);assert.equal(clock.timers.size,0);await pool.end();
});
test('public Client subtype preserves instanceof and inherited static behavior', async t => {
  const f=fixture(t);const p=f.connect();f.clients[0].succeed();const client=await p;
  assert.ok(client instanceof f.pool.options.Client);assert.equal(Object.getPrototypeOf(f.pool.options.Client).name,'FakeClient');
  const base=Object.getPrototypeOf(f.pool.options.Client);base.publicStaticProbe='sentinel';assert.equal(f.pool.options.Client.publicStaticProbe,'sentinel');client.release();
});
test('query callback success and error restore request ALS from unrelated socket context', async t => {
  const f=fixture(t,{loseQueryContext:true});const seen=[];
  for(const error of [undefined,new Error('query error')]){
    als.run({operation:'usage_report',id:'request'},()=>f.pool.query('SELECT 1',(e)=>{assert.equal(e,error);seen.push(als.getStore());}));
    f.clients.forEach(c=>c.succeed());await tick();const client=f.clients.find(c=>c.queryCallback);
    als.run({operation:'default',id:'socket'},()=>client.finishQuery(error));await tick();
  }
  assert.deepEqual(seen,[{operation:'usage_report',id:'request'},{operation:'usage_report',id:'request'}]);
});
test('idle disappearance after native enqueue preserves configured pool max and correct entry callbacks', async t => {
  const f=fixture(t,{deferClose:true}),held=await f.occupy();held.forEach(c=>c.release());
  const jobs=Array.from({length:16},()=>f.connect()); // pg schedules native queue pulses for its idle clients.
  held.forEach(c=>c.emit('error',new Error('idle vanished before next native pulse')));
  await tick();assert.equal(f.pool.totalCount,16);assert.equal(f.pool.schedulingSnapshot().ownedSlots,16);
  // Native pg can transiently retain another16closing sockets. No constructor
  // is assigned to a caller from the native queue's ambient ALS context.
  held.forEach(c=>c.finishEnd());f.clients.slice(16).forEach(c=>c.succeed());(await Promise.all(jobs)).forEach(c=>c.release());
});
test('queued idle disappearance with mixed native errors cannot attach failure cleanup to another caller', async t => {
  const f=fixture(t,{deferClose:true}),held=await f.occupy();held.forEach(c=>c.release());const seen=[];
  const jobs=Array.from({length:16},(_,i)=>als.run({operation:i%2?'usage_report':'default',id:i},()=>f.pool.connect().then(c=>{seen.push({id:i,kind:'success',context:als.getStore().id});c.release();},()=>seen.push({id:i,kind:'failure',context:als.getStore().id}))));
  held.forEach(c=>c.emit('error',new Error('idle vanished')));await tick();held.forEach(c=>c.finishEnd());
  f.clients.slice(16).forEach((c,i)=>i%2?c.succeed():c.fail(new Error('native failed')));await Promise.all(jobs);
  assert.equal(seen.length,16);assert.ok(seen.every(r=>r.id===r.context));assert.equal(seen.filter(r=>r.kind==='failure').length,8);assert.equal(f.pool.schedulingSnapshot().ownedSlots,0);
});
test('existing lower main-pool limits1,2,8,16 are retained exactly', async t => {
  for(const max of [1,2,8,16]){const f=fixture(t,{max}),held=await f.occupy();assert.equal(f.pool.totalCount,max);assert.equal(f.pool.options.max,max);const extra=f.connect();assert.equal(f.pool.waitingCount,1);held[0].release();(await extra).release();held.slice(1).forEach(c=>c.release());await f.cleanup();}
});

test('public connection wrappers observe each logical Promise/callback acquisition exactly once', async t => {
  const { measureMethod } = await import('../scripts/load/usage/release-enabled-instrumentation.mjs');
  const f = fixture(t), observations = [];
  let captured = 0, pending = 0;
  measureMethod(f.pool, 'connect', (_duration, error) => { pending--; observations.push(error); },
    { capture: () => { captured++; pending++; } });
  const promise = f.connect(); f.clients[0].succeed();
  const first = await promise; first.release();
  assert.equal(captured, 1, 'one public Promise checkout must not re-enter the observed public method');
  assert.equal(observations.length, 1); assert.equal(pending, 0);
  await new Promise((resolve, reject) => f.pool.connect((error, client, release) => {
    if (error) { reject(error); return; }
    assert.equal(release, client.release); release(); resolve();
  }));
  assert.equal(captured, 2); assert.equal(observations.length, 2); assert.equal(pending, 0);
  const held = await f.connect(); held.release(new Error('synthetic discard')); await tick();
  const failure = new Error('synthetic connection refusal');
  const rejected = f.connect(); const checked = assert.rejects(rejected, error => error === failure);
  f.clients.at(-1).fail(failure); await checked;
  assert.equal(captured, 4); assert.equal(observations.length, 4);
  assert.equal(observations.filter(Boolean).length, 1); assert.equal(pending, 0);
  assert.equal(f.pool.schedulingSnapshot().ownedSlots, 0);
});
