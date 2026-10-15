import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createNativePriorPaintStore,createNativeScreenshotCapture,createNativeScreenshotDecoder,
  collectRenderedNavigationPixelWitness,planNativeWitnessClips,captureNativeWitnessClips,
  compareNativeWitnessClips,readNativeViewportOrigin,renderedDeadline} from '../scripts/load/run-classpilot-rendered-dashboards.mjs';
import {makeReliabilityColorFixtures,stampCausalCapture} from '../scripts/load/classpilot-reliability-profile.mjs';

const provenance=viewport=>({actorId:'local-actor',runId:'local-prior-native-proof',schoolId:'local-school',
  teachingSessionId:'local-class',socketGeneration:1,bindingsSha256:'a'.repeat(64),viewport});
const tinyPng=()=>Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001','hex');
const tinyWitness={studentId:'local',points:[{x:0,y:0,rgba:[10,20,30,255]}],glyph:null};
const tinyDecoder=()=>createNativeScreenshotDecoder({decodeFactory:()=>({promise:Promise.resolve({data:Buffer.from([10,20,30,255]),info:{width:1,height:1,channels:4}})})});

test('native prior bitmap checks exact provenance, actual time, all sampled pixels and bounded memory',async()=>{
  const viewport={width:1,height:1},expected=provenance(viewport);let clock=0;
  const store=createNativePriorPaintStore({viewport,maxSnapshots:20,now:()=>clock});
  for(let index=0;index<20;index++){const png=tinyPng();await store.capture('actor-'+index,{png,decoder:tinyDecoder(),provenance:expected});assert.ok(png.every(value=>value===0));}
  assert.equal(store.summary().activeBytes,80);assert.equal(store.summary().declaredMaximumBytes,80);
  await assert.rejects(store.capture('overflow',{png:tinyPng(),decoder:tinyDecoder(),provenance:expected}),/count exceeded/);
  clock=100;store.setTrigger(clock);
  const input={witness:tinyWitness,composed:{matched:true,pixels:[10,20,30,255]},provenance:expected,triggerAt:clock};
  assert.equal(store.changed('missing',input),false);assert.equal(store.changed('actor-0',input),false,'Identical actual pixels cannot receive a first-round paint-change witness');
  assert.equal(store.changed('actor-0',{...input,composed:{matched:true,pixels:[23,20,30,255]}}),true,'Actual native delta exceeding unchanged12-byte tolerance is required');
  assert.equal(store.changed('actor-1',{...input,provenance:{...expected,socketGeneration:2}}),false);assert.equal(store.summary().activeSnapshots,19);
  clock=90001;assert.equal(store.changed('actor-0',{...input,composed:{matched:true,pixels:[23,20,30,255]}}),false,'A timely trigger does not extend bitmap lifetime aftert0');
  assert.equal(store.summary().activeSnapshots,18);store.dispose();assert.equal(store.summary().activeBytes,0);assert.equal(store.summary().closed,true);
});

test('late prior decode after disposal, key retirement or trigger cannot repopulate pixels',async()=>{
  for(const fence of ['dispose','invalidate','trigger']){
    const viewport={width:1,height:1},store=createNativePriorPaintStore({viewport,now:()=>0});let release;
    const raw=Buffer.from([10,20,30,255]),decoder=createNativeScreenshotDecoder({decodeFactory:()=>({promise:new Promise(resolve=>{release=resolve;})})}),png=tinyPng();
    const operation=store.capture('local',{png,decoder,provenance:provenance(viewport)}),rejected=assert.rejects(operation,/retired before settlement/);
    if(fence==='dispose')store.dispose();else if(fence==='invalidate')store.invalidate('local');else store.setTrigger(1);
    release({data:raw,info:{width:1,height:1,channels:4}});await rejected;
    assert.ok(raw.every(value=>value===0));assert.ok(png.every(value=>value===0));assert.equal(store.summary().activeBytes,0);assert.equal(store.summary().pendingSnapshots,0);assert.equal(store.summary().lateFenced,1);assert.equal(decoder.summary().active,0);store.dispose();
  }
});

test('actual StudentTile rejects removed-strip DOM with retained old SVG paint before first navigation',
  {skip:process.env.CLP_RUN_NATIVE_MEASUREMENT!=='1',timeout:30000},async()=>{
  const appRoot=resolve(process.env.CLP_NATIVE_APP_ROOT||'schoolpilot-app');
  const{chromium}=createRequire(join(appRoot,'package.json'))('playwright'),{build}=await import('esbuild');
  const component=join(appRoot,'src/products/classpilot/components/StudentTile.jsx');
  const bundle=await build({absWorkingDir:appRoot,stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import StudentTile from ${JSON.stringify(component.replaceAll('\\','/'))};const root=createRoot(document.getElementById('root'));window.paintTile=row=>root.render(React.createElement('main',{style:{width:400,padding:16}},React.createElement(StudentTile,row)));`,resolveDir:appRoot,sourcefile:'native-prior-student-tile.jsx',loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},outfile:'native-prior-student-tile.js'});
  const cssFiles=readdirSync(join(appRoot,'dist/assets')).filter(name=>name.endsWith('.css'));assert.ok(cssFiles.length>0);
  const css=cssFiles.map(name=>readFileSync(join(appRoot,'dist/assets',name),'utf8')).join('\n')+readFileSync(join(appRoot,'src/products/classpilot/components/studentTileFrame.css'),'utf8');
  const viewport={width:800,height:800},iconUrl='https://measurement.local.invalid/favicon.svg',decoder=createNativeScreenshotDecoder(),capture=createNativeScreenshotCapture();let clock=0,actualOutbound=0,documents=0;
  const browser=await chromium.launch({executablePath:process.env.CLASSPILOT_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),stores=[];
  try{
    const page=await browser.newPage({viewport});await page.route('**/*',route=>{
      if(route.request().isNavigationRequest()&&route.request().url()==='https://measurement.local.invalid/'){documents++;return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><body></body>'});}
      if(route.request().url()===iconUrl)return route.fulfill({status:200,contentType:'image/svg+xml',body:readFileSync(join(appRoot,'public/favicon.svg'))});
      actualOutbound++;return route.abort();
    });await page.goto('https://measurement.local.invalid/');await page.setContent('<!doctype html><style>'+css+'</style><div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
    const wall=Date.now(),row={student:{studentId:'local',studentName:'Local prior proof',status:'online',realtimeBinding:'local-public-binding',activeTabRef:'old',activeTabUrl:'https://docs.google.com/',activeTabTitle:'Old local title',allOpenTabs:[{tabRef:'old',url:'https://docs.google.com/',title:'Old local title',favicon:iconUrl}]},monitoringDisplay:{kind:'connected',status:'online',telemetryCurrent:true,observedAtMs:wall},freshnessNowMs:wall,observationActive:true,screenshotObservationStatus:'observed',screenshotData:{timestamp:wall,bindingVersion:'v2:local',screenshot:stampCausalCapture(makeReliabilityColorFixtures()[0],wall,1,{pulseSequence:1,pulseMarker:'a'.repeat(24)})}};
    await page.evaluate(row=>window.paintTile(row),row);await page.waitForSelector('[data-testid="tab-favicon-local-0"] img');await page.locator('[data-testid="tab-favicon-local-0"] img').evaluate(image=>image.decode());
    // Preserve exactly the actual old glyph position and pixels while removing
    // its live StudentTile DOM. Pointer-none makes metadata/hit checks pass.
    await page.locator('[data-testid="tab-favicon-local-0"] img').evaluate(image=>{const box=image.getBoundingClientRect(),old=image.cloneNode();old.id='old-svg-paint';old.removeAttribute('data-testid');old.style.cssText=`position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;z-index:9999;pointer-events:none`;document.body.append(old);});
    row.student.allOpenTabs=[];await page.evaluate(row=>window.paintTile(row),row);await page.waitForFunction(()=>!document.querySelector('[data-testid="tab-favicon-local-0"]'));
    const first=createNativePriorPaintStore({viewport,now:()=>clock});stores.push(first);const expectedProvenance=provenance(viewport);
    await first.capture('local',{png:await capture.capture(page,viewport),decoder,provenance:expectedProvenance});clock=100;first.setTrigger(clock);
    const paintNavigation=async title=>{row.student.activeTabTitle=title;row.student.activeTabRef=title;row.student.allOpenTabs=[{tabRef:title,url:'https://docs.google.com/',title,favicon:iconUrl}];await page.evaluate(row=>window.paintTile(row),row);await page.locator('[data-testid="tab-favicon-local-0"] img').evaluate(image=>image.decode());
      const expected={studentId:'local',marker:title,hostname:'docs.google.com',activeTabTitle:title,favicon:iconUrl},before=await renderedDeadline(page.evaluate(collectRenderedNavigationPixelWitness,[expected])),plan=planNativeWitnessClips(before,{kind:'navigation',viewport}),native=await captureNativeWitnessClips(page,plan,capture),after=await renderedDeadline(page.evaluate(collectRenderedNavigationPixelWitness,{expectedRows:[expected],skipAnimationFrames:true}));
      const composed=await compareNativeWitnessClips({bundle:native,rows:before,afterRows:after,kind:'navigation',viewport,originAfter:await readNativeViewportOrigin(page,viewport)},decoder);return{witness:before[0],composed:composed[0]};};
    const stale=await paintNavigation('new-'+randomBytes(24).toString('hex'));assert.equal(stale.witness.matched,true);assert.equal(stale.composed.matched,true,'Actual old native SVG passes new metadata/source/glyph checks');
    assert.equal(first.changed('local',{...stale,provenance:expectedProvenance,triggerAt:100}),false,'DOMabsence plus a whole-page hash cannot grant new paint credit to unchanged old SVG');first.dispose();assert.equal(first.summary().activeBytes,0);
    await page.locator('#old-svg-paint').evaluate(node=>node.remove());row.student.allOpenTabs=[];await page.evaluate(row=>window.paintTile(row),row);await page.waitForFunction(()=>!document.querySelector('[data-testid="tab-favicon-local-0"]'));
    clock=200;const fresh=createNativePriorPaintStore({viewport,now:()=>clock});stores.push(fresh);await fresh.capture('local',{png:await capture.capture(page,viewport),decoder,provenance:expectedProvenance});clock=300;fresh.setTrigger(clock);
    const changed=await paintNavigation('fresh-'+randomBytes(24).toString('hex'));assert.equal(changed.composed.matched,true);assert.equal(fresh.changed('local',{...changed,provenance:expectedProvenance,triggerAt:300}),true,'New actual glyph pixels differ from the exact pre-trigger native bitmap at final DOM coordinates');fresh.dispose();assert.equal(fresh.summary().activeBytes,0);
    assert.equal(actualOutbound,0);assert.equal(documents,1);assert.equal(capture.summary().active,0);assert.equal(decoder.summary().active,0);
  }finally{for(const store of stores)store.dispose();await browser.close();}
});
