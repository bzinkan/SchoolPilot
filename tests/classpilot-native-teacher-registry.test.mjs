import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createNativeBinaryBudget,createNativeTeacherRegistry,createNativeScreenshotCapture,
  createNativeScreenshotDecoder,createNativePriorPaintStore,nativeObservationPhases,RENDERED_VIEWPORT} from '../scripts/load/run-classpilot-rendered-dashboards.mjs';
import {createBoundedObserverPool} from '../scripts/load/classpilot-reliability-profile.mjs';
const nativeReservation=32*1024*1024+RENDERED_VIEWPORT.width*RENDERED_VIEWPORT.height*4;
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const idleCapture=()=>({summary:()=>({maximumActive:1,maximumPages:1,active:0,poisoned:false}),whenSettled:()=>Promise.resolve([])});
const idleDecoder=()=>({summary:()=>({maximumActive:1,active:0,poisoned:false}),whenSettled:()=>Promise.resolve([])});
function registration(key,extra={}){let retired=0;const browser={},page={evaluate:async()=>undefined};return{key,browser,page,capture:idleCapture(),decoder:idleDecoder(),retire:async()=>{retired++;},retired:()=>retired,...extra};}
const tinyPng=()=>Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001','hex');

test('five-second planned phases remain absolute and complete after observation delay',()=>{
  assert.deepEqual(nativeObservationPhases(1234.5,6),[1234.5,6234.5,11234.5,16234.5,21234.5,26234.5]);
  const schedule=nativeObservationPhases(0,6),lateCompletion=14000;
  assert.deepEqual(schedule.filter(at=>at<=lateCompletion),[0,5000,10000],'Late observations do not reset or remove planned ticks');
  assert.equal(nativeObservationPhases(0,1080).length,1080);
  for(const [start,count]of [[NaN,6],[Infinity,6],[-1,6],[0,0],[0,1081],[0,'6']])assert.throws(()=>nativeObservationPhases(start,count));
});

test('nonfinite, regressed and late observation clocks refuse current evidence and caller fulfillment',async()=>{
  for(const badClock of [99,NaN,Infinity,121]){
    let clock=100,current;const gate=deferred(),registry=createNativeTeacherRegistry({deadlineMs:20,now:()=>clock}),owner=registry.register(registration('clock'));
    const operation=owner.observe(({isCurrent})=>{current=isCurrent;return gate.promise;});const rejected=assert.rejects(operation,/retired|late/);await turn();
    assert.equal(current(),true);clock=badClock;assert.equal(current(),false);gate.resolve('not-current');await rejected;await registry.whenSettled();
    assert.equal(registry.summary().memory.activeBytes,0);await registry.close();
  }
});

test('binary reservations are bounded, unique, strict and idempotent',()=>{
  const budget=createNativeBinaryBudget({maximumBytes:10}),release=budget.reserve('one',6);
  assert.equal(budget.summary().activeBytes,6);assert.throws(()=>budget.reserve('one',1));assert.throws(()=>budget.reserve('other',5));
  for(const bytes of [0,-1,1.5,NaN,'1'])assert.throws(()=>budget.reserve('invalid',bytes));
  release();release();assert.equal(budget.summary().activeBytes,0);assert.equal(budget.summary().reservations,0);assert.equal(budget.summary().peakBytes,6);
  assert.throws(()=>createNativeBinaryBudget({maximumBytes:2147483649}));
});

test('twenty distinct native owners are bounded and cannot share browser, page or adapters',async()=>{
  const registry=createNativeTeacherRegistry(),first=registration('first');registry.register(first);
  for(const same of [{key:first.key},{browser:first.browser},{page:first.page},{capture:first.capture},{decoder:first.decoder}])
    assert.throws(()=>registry.register(registration('duplicate-'+Object.keys(same)[0],same)));
  for(let index=1;index<20;index++)registry.register(registration('owner-'+index));
  assert.equal(registry.summary().owners,20);assert.throws(()=>registry.register(registration('twenty-first')));
  await registry.close();assert.throws(()=>registry.register(registration('after-close')));assert.equal(registry.summary().memory.activeBytes,0);
});

test('registering active, poisoned or wider native adapters fails before owner admission',async()=>{
  for(const [field,summary]of [['capture',{maximumActive:1,maximumPages:1,active:1,poisoned:false}],['capture',{maximumActive:1,maximumPages:1,active:0,poisoned:true}],
    ['capture',{maximumActive:2,maximumPages:1,active:0,poisoned:false}],['capture',{maximumActive:1,maximumPages:2,active:0,poisoned:false}],
    ['decoder',{maximumActive:1,active:1,poisoned:false}],['decoder',{maximumActive:1,active:0,poisoned:true}],['decoder',{maximumActive:2,active:0,poisoned:false}]]){
    const registry=createNativeTeacherRegistry();assert.throws(()=>registry.register(registration('invalid',{[field]:{summary:()=>summary,whenSettled:()=>Promise.resolve([])}})));
    assert.equal(registry.summary().owners,0);await registry.close();
  }
});

test('all twenty owners may progress independently while retaining at most one job each',async()=>{
  const registry=createNativeTeacherRegistry(),gates=Array.from({length:20},deferred),owners=Array.from({length:20},(_,index)=>registry.register(registration('owner-'+index)));
  const operations=owners.map((owner,index)=>owner.observe(()=>gates[index].promise));await turn();
  assert.equal(registry.summary().active,20);assert.equal(registry.summary().peakActive,20);assert.equal(registry.summary().memory.activeBytes,nativeReservation*20);
  assert.ok(registry.summary().memory.activeBytes<=2147483648);assert.ok(owners.every(owner=>owner.summary().active));
  gates.forEach((gate,index)=>gate.resolve(index));assert.deepEqual(await Promise.all(operations),Array.from({length:20},(_,index)=>index));
  await registry.whenSettled();assert.equal(registry.summary().active,0);assert.equal(registry.summary().memory.activeBytes,0);await registry.close();
});

test('bounded next-slot navigation priority still services a queued capture before another navigation',async()=>{
  const registry=createNativeTeacherRegistry(),owner=registry.register(registration('fair')),first=deferred(),order=[];
  const a=owner.observe(async()=>{order.push('first-capture');await first.promise;},{kind:'capture'});await turn();
  const c=owner.observe(()=>order.push('capture'),{kind:'capture'}),n=owner.observe(()=>order.push('navigation'),{kind:'navigation'});
  await assert.rejects(owner.observe(()=>order.push('overflow'),{kind:'navigation'}),/queue exceeded/);
  assert.equal(owner.summary().queued,2);first.resolve();await Promise.all([a,c,n]);await registry.whenSettled();
  assert.deepEqual(order,['first-capture','navigation','capture']);assert.equal(registry.summary().queueRejected,1);
  const gate=deferred();const active=owner.observe(async()=>{order.push('first-navigation');await gate.promise;},{kind:'navigation'});await turn();
  const nextNav=owner.observe(()=>order.push('second-navigation'),{kind:'navigation'}),capture=owner.observe(()=>order.push('next-capture'),{kind:'capture'});
  gate.resolve();await Promise.all([active,nextNav,capture]);await registry.whenSettled();
  assert.deepEqual(order.slice(3),['first-navigation','next-capture','second-navigation']);await registry.close();
});

test('an expired queued attempt is rejected and accounted without executing or removing active work',async()=>{
  const registry=createNativeTeacherRegistry({deadlineMs:100,queueDeadlineMs:10}),owner=registry.register(registration('queue-expiry')),gate=deferred();let ran=0;
  const active=owner.observe(()=>gate.promise);await turn();
  await assert.rejects(owner.observe(()=>{ran++;}),/queue deadline exceeded/);assert.equal(ran,0);assert.equal(registry.summary().queueExpired,1);assert.equal(owner.summary().active,true);
  gate.resolve();await active;await registry.whenSettled();assert.equal(registry.summary().memory.activeBytes,0);await registry.close();
});

test('a stalled DOM caller retains its owner and budget until true settlement while another owner updates',async()=>{
  const registry=createNativeTeacherRegistry({deadlineMs:20}),raw=deferred(),record=registration('stalled',{page:{evaluate:()=>raw.promise}}),owner=registry.register(record);
  const operation=owner.observe(({page})=>page.evaluate(()=>undefined)),rejection=assert.rejects(operation,/deadline exceeded/);await turn();
  const queued=owner.observe(()=>{throw Error('Retired queued work must not execute');}),queuedRejection=assert.rejects(queued,/retired/);
  await Promise.all([rejection,queuedRejection]);assert.equal(record.retired(),1);assert.equal(owner.summary().active,true);assert.equal(owner.summary().rawDom,1);assert.equal(registry.summary().memory.activeBytes,nativeReservation);
  await assert.rejects(owner.observe(()=>true),/retired/);
  const healthy=registry.register(registration('healthy'));assert.equal(await healthy.observe(()=>42),42);await turn();assert.equal(owner.summary().active,true);
  raw.resolve('late');await registry.whenSettled();assert.equal(owner.summary().active,false);assert.equal(owner.summary().rawDom,0);assert.equal(registry.summary().memory.activeBytes,0);assert.equal(owner.summary().poisoned,true);await registry.close();
});

test('warm prior admission stays at two after caller deadlines until ignored DOM work truly settles',async()=>{
  const registry=createNativeTeacherRegistry({deadlineMs:20}),warm=createBoundedObserverPool({limit:2,maximumQueue:3});
  const gates=Array.from({length:3},deferred),callerRejected=deferred();let admitted=0;
  const owners=gates.map((gate,index)=>registry.register(registration('warm-'+index,{page:{evaluate:()=>gate.promise}})));
  const operations=owners.map(owner=>warm.run(async()=>{
    try{return await owner.observe(({page})=>{admitted++;return page.evaluate(()=>true);},{kind:'prior'});}
    catch(error){callerRejected.resolve();throw error;}
    finally{await owner.whenSettled();}
  }));operations.forEach(operation=>operation.catch(()=>{}));
  try{
    await Promise.race([callerRejected.promise,delay(100).then(()=>{throw Error('Expected bounded owner caller rejection');})]);await turn();
    assert.equal(admitted,2,'A rejected caller cannot release a warm permit while its DOM work survives');
    assert.equal(warm.summary().active,2);assert.equal(registry.summary().active,2);
    assert.equal(registry.summary().memory.activeBytes,nativeReservation*2);
    gates[0].resolve('late-first');await turn();await turn();
    assert.equal(admitted,3,'A third prior may start only after an earlier raw owner settles');
    assert.ok(registry.summary().active<=2);assert.ok(warm.summary().peakActive<=2);
    gates[1].resolve('late-second');gates[2].resolve('third');
    await Promise.allSettled(operations);await registry.whenSettled();
    assert.equal(registry.summary().peakActive,2);assert.equal(registry.summary().memory.activeBytes,0);
  }finally{gates.forEach(gate=>gate.resolve());await registry.close();await Promise.allSettled(operations);await registry.whenSettled();}
});

test('ignored native capture cancellation retains the real raw permit and owner reservation',async()=>{
  const registry=createNativeTeacherRegistry({deadlineMs:100}),raw=deferred();let detached=0;
  const capture=createNativeScreenshotCapture({timeoutMs:15,maximumActive:1,maximumPages:1,sessionFactory:()=>({send:()=>raw.promise,detach:async()=>{detached++;}})});
  const owner=registry.register(registration('capture-stall',{capture}));await assert.rejects(owner.observe(({page,capture})=>capture.capture(page,{width:1,height:1})),/deadline exceeded/);
  assert.equal(detached,1);assert.equal(capture.summary().active,1);assert.equal(owner.summary().active,true);assert.equal(registry.summary().memory.activeBytes,nativeReservation);
  await assert.rejects(owner.observe(()=>true),/retired/);raw.resolve({data:tinyPng().toString('base64')});await registry.whenSettled();
  assert.equal(capture.summary().active,0);assert.equal(capture.summary().lateSettlements,1);assert.equal(capture.summary().peakActive,1);assert.equal(registry.summary().memory.activeBytes,0);await registry.close();
});

test('ignored decoder cancellation retains raw RGBA and zeros it before owner budget release',async()=>{
  const registry=createNativeTeacherRegistry({deadlineMs:100}),raw=deferred();let destroyed=0;
  const decoder=createNativeScreenshotDecoder({timeoutMs:15,maximumActive:1,decodeFactory:()=>({promise:raw.promise,destroy:()=>{destroyed++;}})});
  const owner=registry.register(registration('decoder-stall',{decoder}));await assert.rejects(owner.observe(({decoder})=>decoder.run(tinyPng(),{width:1,height:1},()=>true)),/deadline exceeded/);
  assert.equal(destroyed,1);assert.equal(decoder.summary().active,1);assert.equal(owner.summary().active,true);assert.equal(registry.summary().memory.activeBytes,nativeReservation);
  const bytes=Buffer.from([10,20,30,255]);raw.resolve({data:bytes,info:{width:1,height:1,channels:4}});await registry.whenSettled();
  assert.ok(bytes.every(value=>value===0));assert.equal(decoder.summary().active,0);assert.equal(registry.summary().memory.activeBytes,0);await registry.close();
});

test('budget exhaustion retires only the unadmitted owner without starting its task',async()=>{
  const budget=createNativeBinaryBudget({maximumBytes:nativeReservation}),registry=createNativeTeacherRegistry({memoryBudget:budget}),gate=deferred();
  const a=registry.register(registration('one')),second=registration('two'),b=registry.register(second);const active=a.observe(()=>gate.promise);await turn();let ran=0;
  await assert.rejects(b.observe(()=>{ran++;}),/budget exceeded/);assert.equal(ran,0);assert.equal(second.retired(),1);assert.equal(registry.summary().active,1);assert.equal(budget.summary().activeBytes,nativeReservation);
  gate.resolve();await active;await registry.whenSettled();assert.equal(budget.summary().activeBytes,0);await registry.close();
});

test('closure rejects queued and late current-generation results while preserving underlying accounting',async()=>{
  const registry=createNativeTeacherRegistry(),raw=deferred(),record=registration('closure'),owner=registry.register(record);
  const active=owner.observe(()=>raw.promise),activeRejected=assert.rejects(active,/retired|closed/);await turn();
  const queued=owner.observe(()=>{throw Error('Closed queued work must not execute');}),queuedRejected=assert.rejects(queued,/closed/);
  await registry.close();await queuedRejected;assert.equal(record.retired(),1);assert.equal(owner.summary().active,true);assert.equal(registry.summary().memory.activeBytes,nativeReservation);
  raw.resolve('late-result');await activeRejected;await registry.whenSettled();assert.equal(registry.summary().active,0);assert.equal(registry.summary().memory.activeBytes,0);await registry.close();assert.equal(record.retired(),1);
});

test('a completed job cannot remain current or inject DOM work into a later observation',async()=>{
  const registry=createNativeTeacherRegistry(),gate=deferred();let oldCurrent,oldPage,reads=0,current;
  const owner=registry.register(registration('generation',{page:{evaluate:async()=>{reads++;}}}));
  try{
    await owner.observe(({page,isCurrent})=>{oldCurrent=isCurrent;oldPage=page;return true;});await registry.whenSettled();
    assert.equal(oldCurrent(),false,'Completed observation generation must be fenced');
    current=owner.observe(()=>gate.promise);await turn();
    assert.equal(oldCurrent(),false,'A later active job cannot revive its predecessor');
    await assert.rejects(Promise.resolve().then(()=>oldPage.evaluate(()=>true)),/retired|generation|current|owner/);
    assert.equal(reads,0,'No old-generation DOM operation may reach the actual Page');
  }finally{gate.resolve();if(current)await current.catch(()=>{});await registry.close();await registry.whenSettled();}
});

test('stored prior RGBA is zeroed before its separate reservation is released, including late disposal',async()=>{
  for(const late of [false,true]){
    const budget=createNativeBinaryBudget({maximumBytes:8}),raw=Buffer.from([10,20,30,255]),gate=deferred(),viewport={width:1,height:1};let copy,released=0;
    const wrapped={reserve:(key,bytes)=>{const release=budget.reserve(key,bytes);return()=>{assert.ok(copy.every(value=>value===0),'Stored prior pixels must be zero before release');released++;release();};}};
    const decoder=createNativeScreenshotDecoder({maximumActive:1,decodeFactory:()=>({promise:late?gate.promise:Promise.resolve({data:raw,info:{width:1,height:1,channels:4}})})});
    const store=createNativePriorPaintStore({viewport,now:()=>0,memoryBudget:wrapped}),original=Buffer.from;
    Buffer.from=function(value,...args){const result=original.call(Buffer,value,...args);if(value===raw)copy=result;return result;};
    try{
      const operation=store.capture('actor',{png:tinyPng(),decoder,provenance:{actorId:'actor',runId:'run',schoolId:'school',teachingSessionId:'class',socketGeneration:1,bindingsSha256:'a'.repeat(64),viewport}});
      if(late){const rejected=assert.rejects(operation,/retired before settlement/);store.dispose();assert.equal(budget.summary().activeBytes,4);gate.resolve({data:raw,info:{width:1,height:1,channels:4}});await rejected;}
      else{await operation;assert.equal(budget.summary().activeBytes,4);store.invalidate('actor');}
      assert.ok(raw.every(value=>value===0));assert.ok(copy.every(value=>value===0));assert.equal(released,1);assert.equal(budget.summary().activeBytes,0);store.dispose();
    }finally{Buffer.from=original;}
  }
});
