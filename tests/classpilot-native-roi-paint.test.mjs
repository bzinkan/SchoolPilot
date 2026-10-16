import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {collectRenderedDashboardSample,collectRenderedNavigationPixelWitness,
  createNativeScreenshotCapture,createNativeScreenshotDecoder,createNativePriorPaintStore,
  nativeWitnessPoints,planNativeWitnessClips,captureNativeWitnessClips,compareNativeWitnessClips,
  compareRenderedCapturePixels,compareRenderedNavigationPixels,readNativeViewportOrigin,
  renderedDeadline} from '../scripts/load/run-classpilot-rendered-dashboards.mjs';
import {makeReliabilityColorFixtures,stampCausalCapture} from '../scripts/load/classpilot-reliability-profile.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const viewport={width:1920,height:4320};
const provenance={actorId:'local-roi-actor',runId:'local-roi-native',schoolId:'local-school',
  teachingSessionId:'local-session',socketGeneration:1,bindingsSha256:'a'.repeat(64),viewport};
const sources=Array.from({length:40},(_,index)=>makeReliabilityColorFixtures()[index%3]);
const frame=(index,at)=>stampCausalCapture(sources[index],at,1,{pulseSequence:1,pulseMarker:'a'.repeat(24)});
const nativeEnabled=process.env.CLP_RUN_NATIVE_MEASUREMENT==='1';

test('actual forty StudentTiles preserve every unscaled native ROI pixel, deny overlays and changed origins',
  {skip:!nativeEnabled,timeout:90000},async()=>{
  const appRoot=resolve(process.env.CLP_NATIVE_APP_ROOT||'schoolpilot-app');
  const {chromium}=createRequire(join(appRoot,'package.json'))('playwright'),{build}=await import('esbuild');
  const component=join(appRoot,'src/products/classpilot/components/StudentTile.jsx');
  const bundle=await build({absWorkingDir:appRoot,stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import StudentTile from ${JSON.stringify(component.replaceAll('\\','/'))};const root=createRoot(document.getElementById('root'));window.paintTiles=rows=>root.render(React.createElement('main',{style:{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:16,padding:16}},rows.map(row=>React.createElement(StudentTile,{key:row.student.studentId,...row}))));`,resolveDir:appRoot,sourcefile:'native-roi-student-tile.jsx',loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},outfile:'native-roi-student-tile.js'});
  const cssFiles=readdirSync(join(appRoot,'dist/assets')).filter(name=>name.endsWith('.css'));
  assert.ok(cssFiles.length>0,'Actual built candidate styles are required');
  const css=cssFiles.map(name=>readFileSync(join(appRoot,'dist/assets',name),'utf8')).join('\n')+readFileSync(join(appRoot,'src/products/classpilot/components/studentTileFrame.css'),'utf8');
  const decoder=createNativeScreenshotDecoder(),capture=createNativeScreenshotCapture(),stores=[],retained=[];
  const browser=await chromium.launch({executablePath:process.env.CLASSPILOT_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
    args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  let outbound=0,documents=0,clock=0;
  try{
    const page=await browser.newPage({viewport}),origin='https://measurement.local.invalid/',iconUrl=origin+'favicon.svg';
    await page.route('**/*',route=>{
      if(route.request().isNavigationRequest()&&route.request().url()===origin){documents++;return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><body></body>'});}
      if(route.request().url()===iconUrl)return route.fulfill({status:200,contentType:'image/svg+xml',body:readFileSync(join(appRoot,'public/favicon.svg'))});
      outbound++;return route.abort();
    });
    await page.goto(origin);assert.equal(await page.evaluate(()=>isSecureContext&&!!crypto.subtle),true);
    await page.setContent('<!doctype html><style>'+css+'</style><div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
    const at=Date.now(),rows=Array.from({length:40},(_,index)=>({student:{studentId:'local-'+index,studentName:'Local '+index,status:'online',realtimeBinding:'local-binding-'+index,
      activeTabRef:'initial-'+index,activeTabUrl:'https://docs.google.com/',activeTabTitle:'Initial local title',allOpenTabs:[]},
      monitoringDisplay:{kind:'connected',status:'online',telemetryCurrent:true,observedAtMs:at},freshnessNowMs:at,observationActive:true,screenshotObservationStatus:'observed',
      screenshotData:{timestamp:at,bindingVersion:'v2:local-'+index,screenshot:frame(index,at)}}));
    assert.equal(new Set(rows.map(row=>hash(Buffer.from(row.screenshotData.screenshot.split(',')[1],'base64')))).size,40);
    await page.evaluate(rows=>window.paintTiles(rows),rows);
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid^="screenshot-local-"]').length===40);
    await page.locator('[data-testid^="screenshot-local-"]').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
    await new Promise(resolve=>setTimeout(resolve,200));
    const initial=await renderedDeadline(page.evaluate(collectRenderedDashboardSample));
    assert.equal(initial.cards.length,40);assert.ok(initial.cards.every(row=>row.decoded&&row.displayed&&row.frame?.jpegSha256));
    // Seven actual fractional columns, not a copied bare-image layout.
    assert.equal(new Set(initial.cards.map(row=>Math.round(row.geometry.left))).size,7);
    const first=createNativePriorPaintStore({viewport,now:()=>clock});stores.push(first);
    assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-testid^="tab-favicon-"]').length),0);
    await first.capture('actor',{png:await capture.capture(page,viewport),decoder,provenance});clock=100;first.setTrigger(clock);
    const adopt=async prefix=>{
      for(const row of rows){const marker=prefix+'-'+row.student.studentId;row.student.activeTabTitle=marker;row.student.activeTabRef=marker;
        row.student.allOpenTabs=[{tabRef:marker,url:'https://docs.google.com/',title:marker,favicon:iconUrl}];}
      await page.evaluate(rows=>window.paintTiles(rows),rows);
      await page.waitForFunction(()=>document.querySelectorAll('[data-testid^="tab-favicon-"] img').length===40);
      await page.locator('[data-testid^="tab-favicon-"] img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
      return rows.map(row=>({studentId:row.student.studentId,marker:row.student.activeTabTitle,hostname:'docs.google.com',activeTabTitle:row.student.activeTabTitle,favicon:iconUrl}));
    };
    let expected=await adopt('first-'+randomBytes(24).toString('hex'));
    const read=kind=>renderedDeadline(page.evaluate(kind==='capture'?collectRenderedDashboardSample:collectRenderedNavigationPixelWitness,
      kind==='capture'?{skipAnimationFrames:true}:{expectedRows:expected,skipAnimationFrames:true})).then(value=>kind==='capture'?value.cards:value);
    const oracle=async kind=>{
      const before=await read(kind);assert.equal(before.length,40);assert.ok(before.every(row=>kind==='capture'?row.displayed&&row.decoded:row.matched));
      const plan=planNativeWitnessClips(before,{kind,viewport});assert.equal(plan.clips.length,1);
      assert.equal(plan.witnessCount,kind==='capture'?120:520);
      const full=await capture.capture(page,viewport);retained.push(full);
      const native=await captureNativeWitnessClips(page,plan,capture),pngs=native.parts.map(part=>part.png);retained.push(...pngs);
      const after=await read(kind),originAfter=await readNativeViewportOrigin(page,viewport);
      const all=nativeWitnessPoints;
      const fullProof=await decoder.run(full,viewport,pixel=>({vectors:before.map(row=>all(row,kind).map(pixel)),
        result:kind==='capture'?compareRenderedCapturePixels(before,after,pixel):compareRenderedNavigationPixels(before,after,pixel)}));
      const part=native.parts[0],clipVectors=await decoder.run(part.png,{width:part.clip.width,height:part.clip.height},
        pixel=>before.map(row=>all(row,kind).map(point=>pixel({x:point.x-part.clip.x,y:point.y-part.clip.y}))));
      assert.deepEqual(clipVectors,fullProof.vectors,'Every original integer native pixel, including all nine glyph ROI pixels, agrees exactly without resampling');
      const clipped=await compareNativeWitnessClips({bundle:native,rows:before,afterRows:after,kind,viewport,originAfter},decoder);
      assert.deepEqual(clipped,fullProof.result,'The actual ROI production comparator matches the full native oracle');
      assert.ok(pngs.every(png=>png.every(value=>value===0)));full.fill(0);
      return {before,result:clipped,plan};
    };
    const captures=await oracle('capture');assert.ok(captures.result.every(row=>row.matched));
    const navigation=await oracle('navigation');assert.ok(navigation.result.every(row=>row.matched));
    assert.ok(navigation.before.every((row,index)=>first.changed('actor',{witness:row,composed:navigation.result[index],provenance,triggerAt:100})),
      'All forty first native glyphs visibly differ from the exact absent-strip prior bitmap');
    first.dispose();assert.equal(first.summary().activeBytes,0);
    await page.evaluate(()=>{const overlay=document.createElement('div');overlay.id='navy-overlay';overlay.style.cssText='position:fixed;inset:0;background:rgb(30,58,95);z-index:9999;pointer-events:none';document.body.append(overlay);});
    const navy=await oracle('navigation');assert.ok(navy.before.every(row=>row.matched),'A pointer-none solid fill fools DOM witnesses');
    assert.ok(navy.result.every(row=>!row.matched),'All forty ordered glyphs reject unrelated flat navy paint');
    await page.locator('#navy-overlay').evaluate(node=>node.remove());
    // New metadata over the same retained old native glyph cannot create
    // first-navigation paint credit. This uses actual prior bitmap pixels.
    await page.locator('[data-testid^="tab-favicon-"] img').evaluateAll(images=>{for(const image of images){const box=image.getBoundingClientRect(),old=image.cloneNode();old.className='old-icon-overlay';old.style.cssText=`position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;z-index:9999;pointer-events:none`;document.body.append(old);}});
    clock=200;const old=createNativePriorPaintStore({viewport,now:()=>clock});stores.push(old);
    await old.capture('actor',{png:await capture.capture(page,viewport),decoder,provenance});clock=300;old.setTrigger(clock);
    expected=await adopt('new-'+randomBytes(24).toString('hex'));
    const stale=await oracle('navigation');assert.ok(stale.result.every(row=>row.matched),'Old identical glyph pixels still match new semantic metadata');
    assert.ok(stale.before.every((row,index)=>!old.changed('actor',{witness:row,composed:stale.result[index],provenance,triggerAt:300})),
      'Unchanged native prior glyphs cannot establish a newly painted navigation generation');
    old.dispose();assert.equal(old.summary().activeBytes,0);
    await page.locator('.old-icon-overlay').evaluateAll(nodes=>nodes.forEach(node=>node.remove()));
    await page.evaluate(()=>{document.body.style.minHeight='5000px';scrollTo(0,40);});
    await page.waitForFunction(()=>scrollY===40);
    const started=capture.summary().started;
    await assert.rejects(captureNativeWitnessClips(page,navigation.plan,capture),/zero viewport\/document origin/);
    assert.equal(capture.summary().started,started,'Real scrolled origin is denied before a native capture');
    await page.evaluate(()=>scrollTo(0,0));await readNativeViewportOrigin(page,viewport);
    assert.equal(outbound,0);assert.equal(documents,1);assert.equal(capture.summary().active,0);assert.equal(decoder.summary().active,0);
    assert.equal(capture.summary().timeouts,0);assert.equal(decoder.summary().timeouts,0);
  }finally{for(const store of stores)store.dispose();for(const png of retained)png.fill(0);await browser.close();}
});
