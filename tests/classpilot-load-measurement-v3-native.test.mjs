import test from 'node:test';import assert from 'node:assert/strict';import{createRequire}from'node:module';import{readFileSync,readdirSync}from'node:fs';import{resolve,join}from'node:path';
import{makeReliabilityColorFixtures,CAPTURE_COLOR_BASES,stampCausalCapture,CapturePulseController,capturePulseMarker,measurementPlanDigest,measurementPlan}from'../scripts/load/classpilot-reliability-profile.mjs';
import{collectRenderedNavigationPixelWitness,createNativeScreenshotCapture,collectRenderedDashboardSample,compareRenderedCapturePaint,compareRenderedNavigationPaint,createNativeScreenshotDecoder,renderedCaptureFrameAuthorized,scoreRenderedCaptureAge,renderedDeadline}from'../scripts/load/run-classpilot-rendered-dashboards.mjs';
let chromium,favicon;
const chrome=process.env.CLASSPILOT_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const nativeTest=(name,run)=>test(name,{skip:process.env.CLP_RUN_NATIVE_MEASUREMENT!=='1'},async()=>{
  ({chromium}=createRequire(new URL('../schoolpilot-app/package.json',import.meta.url))('playwright'));
  favicon='data:image/svg+xml;base64,'+readFileSync(new URL('../schoolpilot-app/public/favicon.svg',import.meta.url)).toString('base64');await run();
});
const expectedRow=()=>({studentId:'local',marker:'local-token',hostname:'docs.google.com',activeTabTitle:'Local native paint',favicon});
const assertCodecRgba=(actual,expected)=>{
  assert.equal(actual.length,4);assert.equal(actual[3],expected[3]);
  // Chrome's platform JPEG codec differs by one byte for this fixture. The
  // actual native compositor proof retains its separate unchanged tolerance.
  for(let channel=0;channel<3;channel++)assert.ok(Number.isInteger(actual[channel])&&actual[channel]>=0&&actual[channel]<=255&&Math.abs(actual[channel]-expected[channel])<=1,'JPEG fixture RGB differs by more than one codec byte');
};
const html=()=>`<style>html,body{margin:0;background:white} [data-testid="card-student-local"]{margin:50px;background:white} span{display:flex;width:20px;height:20px;background:#e8e9ef;align-items:center;justify-content:center;border:1px solid #2563eb}span img{width:14px;height:14px;border-radius:4px}span div{width:8px;height:8px;border-radius:50%;background:rgba(80,80,80,.3)}</style><div data-testid="card-student-local"><span data-testid="tab-favicon-local-0" title="Local native paint · docs.google.com" class="ring-1 border-primary/70"><img src="${favicon}"></span></div>`;
async function localPage(browser,viewport={width:480,height:480}){
  const page=await browser.newPage({viewport});let actualOutbound=0,interceptedDocuments=0;
  await page.route('**/*',route=>{if(route.request().isNavigationRequest()&&route.request().url()==='https://measurement.local.invalid/'){
    interceptedDocuments+=1;return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body></body></html>'});}
    actualOutbound+=1;return route.abort();});
  await page.goto('https://measurement.local.invalid/');
  return{page,proof:()=>({actualOutbound,interceptedDocuments})};
}
nativeTest('native decoded icon/placeholder proof rejects ordinary and pointer-events:none overlays plus identical prior icon',async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true}),decoder=createNativeScreenshotDecoder(),capture=createNativeScreenshotCapture();
  try{const{page,proof}=await localPage(browser);const expected=expectedRow();await page.setContent(html());await page.locator('img').evaluate(image=>image.decode());
    const compare=async row=>{const witness=await renderedDeadline(page.evaluate(collectRenderedNavigationPixelWitness,[row])),png=await capture.capture(page,{width:480,height:480}),afterRows=await renderedDeadline(page.evaluate(collectRenderedNavigationPixelWitness,[row]));return{witness,result:await compareRenderedNavigationPaint({png,rows:witness,afterRows,viewport:{width:480,height:480}},decoder)};};
    assert.equal((await compare(expected)).result[0].matched,true,'Real decoded SVG has actual colored compositor pixels');
    assert.equal(await page.evaluate(()=>!document.querySelector('[data-testid="tab-favicon-local-0"]')),false,'Identical prior icon cannot satisfy first-round absence');
    for(const[events,color]of[['auto','black'],['none','black'],['none','rgb(30,58,95)']]){await page.evaluate(({events,color})=>{const overlay=document.createElement('div');overlay.id='overlay';overlay.style.cssText=`position:fixed;inset:0;background:${color};z-index:9999;pointer-events:${events}`;document.body.append(overlay);},{events,color});
      const value=await compare(expected);assert.equal(value.result[0].matched,false,events+' overlay cannot pass compositor proof');if(events==='none')assert.equal(value.witness[0].matched,true,'Pointer-events:none fools hit testing alone');await page.locator('#overlay').evaluate(node=>node.remove());}
    await page.locator('span').evaluate(node=>{node.querySelector('img').remove();node.append(document.createElement('div'));});
    assert.equal((await compare({...expected,favicon:undefined})).result[0].matched,true,'Actual placeholder pixels also verified');assert.equal(proof().actualOutbound,0);assert.equal(proof().interceptedDocuments,1);
  }finally{await browser.close();}
});
nativeTest('actual object-contain and outgoing frame contributors remain visible above caption overlays',async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true}),decoder=createNativeScreenshotDecoder(),capture=createNativeScreenshotCapture();
  try{const{page,proof}=await localPage(browser);
    const fixtures=makeReliabilityColorFixtures();
    const current=stampCausalCapture(fixtures[1],1700000000000,2,{pulseSequence:1,pulseMarker:'a'.repeat(24)}),previous=stampCausalCapture(fixtures[0],1700000000000,1,{pulseSequence:1,pulseMarker:'a'.repeat(24)});
    // The existing production object-contain/retained layout is exercised;
    // local codec fixtures here do not claim candidate UI or fleet acceptance.
    await page.setContent(`<style>body{margin:0;background:white}.box{position:relative;width:320px;aspect-ratio:16/9;margin:30px;overflow:hidden;background:#ddd}.box img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.caption{position:absolute;bottom:0;left:0;right:0;height:40px;background:linear-gradient(transparent,black)}</style><div data-testid="card-student-local"><div class="box"><img data-testid="screenshot-previous-local" src="${previous}"><img data-testid="screenshot-local" style="opacity:.5" src="${current}"><div class="caption">Caption</div></div></div>`);
    await page.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
    const sample=await page.evaluate(collectRenderedDashboardSample),card=sample.cards[0];assert.equal(card.displayed,true);assert.equal(card.decoded,true);assert.equal(card.points.length,3);assert.equal(card.opacity,.5);assertCodecRgba(card.rgba,CAPTURE_COLOR_BASES[1].decodedRgba);assertCodecRgba(card.previousRgba,CAPTURE_COLOR_BASES[0].decodedRgba);
    assert.ok(card.points.every(point=>point.x>=100&&point.x<=280&&point.y<140),'Interior points lie within the centered square above caption');
    const compare=async()=>{const before=await renderedDeadline(page.evaluate(collectRenderedDashboardSample)),png=await capture.capture(page,{width:480,height:480}),after=await renderedDeadline(page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true}));return{before,result:await compareRenderedCapturePaint({png,cards:before.cards,afterCards:after.cards,viewport:{width:480,height:480}},decoder)};};
    assert.equal((await compare()).result[0].matched,true,'Both exact causal contributors have real blended pixels');
    const known=[{...card.frame},{...card.previousFrame}];assert.ok(card.contributors.every(frame=>renderedCaptureFrameAuthorized(frame,known)));
    const sameMetadataOtherBytes=stampCausalCapture(fixtures[2],1700000000000,2,{pulseSequence:1,pulseMarker:'a'.repeat(24)});
    await page.getByTestId('screenshot-local').evaluate((image,source)=>{image.src=source;return image.decode();},sameMetadataOtherBytes);
    const altered=await page.evaluate(collectRenderedDashboardSample);assert.equal(altered.cards[0].frame.ordinal,card.frame.ordinal);
    assert.notEqual(altered.cards[0].frame.jpegSha256,card.frame.jpegSha256);assert.equal(renderedCaptureFrameAuthorized(altered.cards[0].frame,known),false,'Identical stamp with other JPEG bytes cannot establish authorized pixels');
    await page.getByTestId('screenshot-local').evaluate((image,source)=>{image.src=source;return image.decode();},current);
    await page.getByTestId('screenshot-previous-local').evaluate((image,source)=>{image.src=source;return image.decode();},'data:image/jpeg;base64,'+fixtures[0].toString('base64'));
    const legacy=await compare();assert.equal(legacy.before.cards[0].contributors[0],null);assert.equal(legacy.result[0].matched,false,'An unknown contributing prior JPEG cannot gain current-frame freshness');
    await page.getByTestId('screenshot-previous-local').evaluate((image,source)=>{image.src=source;return image.decode();},previous);
    await page.getByTestId('screenshot-local').evaluate(image=>image.style.opacity='1');
    for(const events of['auto','none']){await page.evaluate(events=>{const node=document.createElement('div');node.id='overlay';node.style.cssText=`position:fixed;inset:0;background:rgb(216,48,37);z-index:9999;pointer-events:${events}`;document.body.append(node);},events);assert.equal((await compare()).result[0].matched,false,'Stale-color '+events+' overlay cannot masquerade as current decoded JPEG');await page.locator('#overlay').evaluate(node=>node.remove());}
    assert.equal(proof().actualOutbound,0);
  }finally{await browser.close();}
});
nativeTest('a wedged native evaluate is refused at its caller deadline',async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});try{const{page,proof}=await localPage(browser);
    await assert.rejects(renderedDeadline(page.evaluate(()=>new Promise(()=>{})),30),/deadline exceeded/);assert.equal(proof().actualOutbound,0);
  }finally{await browser.close();}
});
nativeTest('actual StudentTile preserves exact causal contributors through native staggered frame swaps',async()=>{
  const{build}=await import('esbuild');
  const appRoot=resolve(process.env.CLP_NATIVE_APP_ROOT||'schoolpilot-app'),component=join(appRoot,'src/products/classpilot/components/StudentTile.jsx');
  const bundle=await build({absWorkingDir:appRoot,stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import StudentTile from ${JSON.stringify(component.replaceAll('\\','/'))};const root=createRoot(document.getElementById('root'));window.paintTiles=rows=>root.render(React.createElement('main',{style:{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:16,padding:16}},rows.map(row=>React.createElement(StudentTile,{key:row.student.studentId,...row}))));`,resolveDir:appRoot,sourcefile:'native-student-tile.jsx',loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},outfile:'native-student-tile.js'});
  const cssFiles=readdirSync(join(appRoot,'dist/assets')).filter(name=>name.endsWith('.css'));
  assert.ok(cssFiles.length>0,'Exact built candidate styles required');
  const css=cssFiles.map(name=>readFileSync(join(appRoot,'dist/assets',name),'utf8')).join('\n')+readFileSync(join(appRoot,'src/products/classpilot/components/studentTileFrame.css'),'utf8');
  const browser=await chromium.launch({executablePath:chrome,headless:true}),decoder=createNativeScreenshotDecoder(),capture=createNativeScreenshotCapture();
  let cancelled=false;const ownedTimers=new Map(),swaps=[];
  try{const{page,proof}=await localPage(browser,{width:1920,height:4320});const iconUrl='https://measurement.local.invalid/favicon.svg';await page.route(iconUrl,route=>route.fulfill({status:200,contentType:'image/svg+xml',body:readFileSync(join(appRoot,'public/favicon.svg'))}));await page.setContent('<!doctype html><style>'+css+'</style><div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
    const fixtures=makeReliabilityColorFixtures(),now=Date.now(),rows=Array.from({length:40},(_,index)=>({student:{studentId:'local-'+index,studentName:'Local '+index,realtimeBinding:'exact-public-'+index,controlRevision:1,status:'online',activeTabUrl:'https://docs.google.com/'},monitoringDisplay:{kind:'connected',status:'online',telemetryCurrent:true,observedAtMs:now},freshnessNowMs:now,observationActive:true,screenshotObservationStatus:'observed',screenshotData:{timestamp:now,bindingVersion:'v2:local-'+index,screenshot:stampCausalCapture(fixtures[index%3],now,1,{pulseSequence:1,pulseMarker:'a'.repeat(24)})}}));
    for(const[row,index]of rows.map((row,index)=>[row,index]))Object.assign(row.student,{activeTabRef:'tab-'+index,activeTabTitle:'Local native paint',openTabCount:1,allOpenTabs:[{tabRef:'tab-'+index,url:'https://docs.google.com/',title:'Local native paint',favicon:iconUrl}]});
    await page.evaluate(rows=>window.paintTiles(rows),rows);await page.waitForFunction(()=>document.querySelectorAll('[data-testid^="screenshot-local-"]').length===40);await new Promise(resolve=>setTimeout(resolve,200));
    await page.locator('[data-testid^="tab-favicon-local-"] img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
    const navRows=rows.map(row=>({...expectedRow(),studentId:row.student.studentId,favicon:iconUrl}));
    const navBefore=await renderedDeadline(page.evaluate(collectRenderedNavigationPixelWitness,navRows)),navPng=await capture.capture(page,{width:1920,height:4320}),navAfter=await renderedDeadline(page.evaluate(collectRenderedNavigationPixelWitness,{expectedRows:navRows,skipAnimationFrames:true}));
    assert.equal(navBefore.length,40);const nav=await compareRenderedNavigationPaint({png:navPng,rows:navBefore,afterRows:navAfter},decoder);assert.ok(nav.every(row=>row.matched),'All40 actual fractional icon layouts have an ordered colored glyph witness '+JSON.stringify(nav.map((row,index)=>({index,row,before:navBefore[index],after:navAfter[index]})).filter(value=>!value.row.matched).slice(0,2)));
    await page.evaluate(()=>{const overlay=document.createElement('div');overlay.id='nav-overlay';overlay.style.cssText='position:fixed;inset:0;background:rgb(30,58,95);z-index:9999;pointer-events:none';document.body.append(overlay);});
    const blue=await capture.capture(page,{width:1920,height:4320}),blueAfter=await renderedDeadline(page.evaluate(collectRenderedNavigationPixelWitness,{expectedRows:navRows,skipAnimationFrames:true}));
    assert.ok(blueAfter.every(row=>row.matched),'Solid-blue pointer-none overlay fools DOM/source/geometry checks');
    const blueResult=await compareRenderedNavigationPaint({png:blue,rows:navBefore,afterRows:blueAfter},decoder);assert.ok(blueResult.every(row=>!row.matched),'The arrow motif refuses unrelated flat-blue paint on all40 tiles');await page.locator('#nav-overlay').evaluate(node=>node.remove());
    const before=await renderedDeadline(page.evaluate(collectRenderedDashboardSample));assert.equal(before.cards.length,40);const faults=await page.evaluate(()=>{const image=document.querySelector('[data-testid="screenshot-local-0"]'),nodes=[];for(let node=image;node;node=node.parentElement){const s=getComputedStyle(node),b=node.getBoundingClientRect();nodes.push({tag:node.tagName,testId:node.getAttribute('data-testid'),opacity:s.opacity,display:s.display,visibility:s.visibility,overflowX:s.overflowX,overflowY:s.overflowY,box:{left:b.left,top:b.top,right:b.right,bottom:b.bottom}});}const b=image.getBoundingClientRect();return{nodes,hit:document.elementFromPoint(b.left+b.width/2,b.top+b.height*.3)?.outerHTML.slice(0,500)}});assert.ok(before.cards.every(card=>card.displayed&&card.decoded&&card.frame?.jpegSha256),JSON.stringify(faults));
    for(let index=0;index<40;index++){rows[index].screenshotData={...rows[index].screenshotData,timestamp:Date.now(),screenshot:stampCausalCapture(fixtures[(index+1)%3],now,index===0?2:2,{pulseSequence:2,pulseMarker:'b'.repeat(24)})};}
    await page.evaluate(rows=>window.paintTiles(rows),rows);await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid^="screenshot-local-"]')].every(image=>atob(image.currentSrc.split(',')[1]).slice(-98,-2).includes(':2:2:')));
    const png=await capture.capture(page,{width:1920,height:4320}),after=await renderedDeadline(page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true}));
    const painted=await compareRenderedCapturePaint({png,cards:before.cards,afterCards:after.cards},decoder);
    assert.ok(painted.every(row=>row.matched&&row.transitioned&&row.contributors.length>=2),'Actual retained frame or completed150ms fade remains conservatively bounded');
    const known=before.cards.concat(after.cards).flatMap(card=>card.contributors);
    assert.ok(painted.every(row=>row.contributors.every(frame=>renderedCaptureFrameAuthorized(frame,known))));
    // Stagger40 ordinary production swaps across the unchanged five-second
    // cohort cadence. All native observation cost remains in its real clock.
    for(const[row,index]of rows.map((row,index)=>[row,index])){const promise=new Promise((resolve,reject)=>{const timer=setTimeout(async()=>{ownedTimers.delete(timer);if(cancelled){resolve();return;}try{row.screenshotData={...row.screenshotData,timestamp:Date.now(),screenshot:stampCausalCapture(fixtures[(index+2)%3],now,3,{pulseSequence:3,pulseMarker:'c'.repeat(24)})};await renderedDeadline(page.evaluate(rows=>window.paintTiles(rows),rows));resolve();}catch(error){reject(error);}},index*125);ownedTimers.set(timer,resolve);});promise.catch(()=>{});swaps.push(promise);}
    for(let round=0;round<6;round++){const first=await renderedDeadline(page.evaluate(collectRenderedDashboardSample)),native=await capture.capture(page,{width:1920,height:4320}),last=await renderedDeadline(page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true}));const result=await compareRenderedCapturePaint({png:native,cards:first.cards,afterCards:last.cards},decoder);assert.ok(result.every(row=>row.matched),'Staggered real StudentTile swap remains measured '+JSON.stringify(result.filter(row=>!row.matched)));await new Promise(resolve=>setTimeout(resolve,600));}
    await Promise.all(swaps);
    // During a swap, this brown overlay is inside independent RGB min/max
    // bounds but is not any physically possible common-alpha source blend.
    const first=await page.evaluate(collectRenderedDashboardSample);rows[0].screenshotData={...rows[0].screenshotData,timestamp:Date.now(),screenshot:stampCausalCapture(fixtures[0],now,4,{pulseSequence:4,pulseMarker:'d'.repeat(24)})};await page.evaluate(rows=>window.paintTiles(rows),rows);
    await page.evaluate(()=>{const card=document.querySelector('[data-testid="card-student-local-0"]'),overlay=document.createElement('div');overlay.id='bad-overlay';overlay.style.cssText='position:absolute;inset:0;background:rgb(180,120,100);z-index:999;pointer-events:none';card.style.position='relative';card.append(overlay);});
    const bad=await capture.capture(page,{width:1920,height:4320}),last=await page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true});const result=await compareRenderedCapturePaint({png:bad,cards:first.cards,afterCards:last.cards},decoder);assert.equal(result.find(row=>row.studentId==='local-0').matched,false);assert.equal(proof().actualOutbound,0);
  }finally{cancelled=true;for(const[timer,resolve]of ownedTimers){clearTimeout(timer);resolve();}ownedTimers.clear();await Promise.allSettled(swaps);await browser.close();}
});
test('native decoder timeout retains its underlying permit and rejects future admissions',async()=>{
  const image=Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001','hex');let release,destroyed=false;
  const decoder=createNativeScreenshotDecoder({timeoutMs:20,decodeFactory:()=>({promise:new Promise(resolve=>{release=resolve;}),destroy:()=>{destroyed=true;}})});
  await assert.rejects(decoder.run(image,{width:1,height:1},()=>true),/deadline exceeded/);assert.equal(destroyed,true);assert.equal(decoder.summary().active,1);assert.equal(decoder.summary().poisoned,true);
  await assert.rejects(decoder.run(image,{width:1,height:1},()=>true),/unavailable/);const bytes=Buffer.from([1,2,3,255]);release({data:bytes,info:{width:1,height:1,channels:4}});await new Promise(resolve=>setImmediate(resolve));assert.equal(decoder.summary().active,0);assert.equal(decoder.summary().lateSettlements,1);assert.deepEqual([...bytes],[0,0,0,0]);
});
test('raw CDP timeout retires its own session but retains an ignored underlying capture permit',async()=>{
  let release,detached=0,parameters;
  const page={},capture=createNativeScreenshotCapture({timeoutMs:20,sessionFactory:()=>({
    send:(method,options)=>{assert.equal(method,'Page.captureScreenshot');parameters=options;return new Promise(resolve=>{release=resolve;});},
    detach:()=>{detached+=1;return Promise.resolve();}
  })});
  await assert.rejects(capture.capture(page,{width:1,height:1}),/deadline exceeded/);
  assert.equal(detached,1);assert.equal(capture.summary().active,1);assert.equal(capture.summary().poisoned,true);
  assert.equal(parameters.optimizeForSpeed,true);assert.deepEqual(parameters.clip,{x:0,y:0,width:1,height:1,scale:1});
  await assert.rejects(capture.capture({}, {width:1,height:1}),/unavailable/);
  const image=Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001','hex');
  release({data:image.toString('base64')});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(capture.summary().active,0);assert.equal(capture.summary().lateSettlements,1);
  assert.equal(capture.summary().started,1,'Ignored retirement cannot admit a second raw capture');
});
test('late owned CDP session creation is retired without sending a fenced screenshot',async()=>{
  let release,detached=0,sent=0;
  const capture=createNativeScreenshotCapture({timeoutMs:20,sessionFactory:()=>new Promise(resolve=>{release=resolve;})});
  await assert.rejects(capture.capture({}, {width:1,height:1}),/deadline exceeded/);assert.equal(capture.summary().active,1);
  release({send:()=>{sent+=1;throw Error('Fenced capture must not send');},detach:()=>{detached+=1;return Promise.resolve();}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(detached,1);assert.equal(sent,0);assert.equal(capture.summary().active,0);assert.equal(capture.summary().lateSettlements,1);assert.equal(capture.summary().poisoned,true);
});
nativeTest('fully authorized repeating-palette swap covered by old pixels retains the older causal age',async()=>{
  let clock=0,nonce=0;
  const expected={account:'135775632425',bucket:'schoolpilot-staging-load-135775632425',origin:'https://staging.school-pilot.net',
    campaign:'classpilot-staging-20261014-012345abcdef',runId:'40-0123456789abcdef',primaryDevices:40,
    candidateApiImage:'135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:'+'a'.repeat(64),
    sourceArtifactSha256:'b'.repeat(64),scriptBundleSha256:'c'.repeat(64),cohortSha256:'d'.repeat(64),
    planSha256:measurementPlanDigest(40),maximumPulses:measurementPlan(40).maximumPulses,maximumNavigationRounds:measurementPlan(40).navigationRounds};
  const binding='e'.repeat(43),controller=new CapturePulseController(expected,{now:()=>clock,nonce:()=>String(++nonce).padStart(48,'0')});
  const fixtures=makeReliabilityColorFixtures(),source=(color,ordinal)=>{const pulse=controller.issue();return stampCausalCapture(fixtures[color],1700000000000,ordinal,{pulseSequence:pulse.pulseSequence,pulseMarker:capturePulseMarker(pulse,binding)});};
  const oldRed=source(0,1);clock=15000;const currentRed=source(0,4);clock=16000;const currentGreen=source(1,5);
  const browser=await chromium.launch({executablePath:chrome,headless:true}),decoder=createNativeScreenshotDecoder(),capture=createNativeScreenshotCapture();
  try{const{page,proof}=await localPage(browser);
    await page.setContent(`<style>body{margin:0;background:white}.box{position:relative;width:320px;height:180px;margin:30px}.box img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}</style><div data-testid="card-student-local"><div class="box"><img data-testid="screenshot-local" src="${oldRed}"></div></div>`);
    await page.locator('img').evaluate(image=>image.decode());
    const old=await renderedDeadline(page.evaluate(collectRenderedDashboardSample)),oldPng=await capture.capture(page,{width:480,height:480}),oldAfter=await renderedDeadline(page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true}));
    const prior=(await compareRenderedCapturePaint({png:oldPng,cards:old.cards,afterCards:oldAfter.cards,viewport:{width:480,height:480}},decoder))[0];assert.equal(prior.matched,true);
    await page.getByTestId('screenshot-local').evaluate((image,source)=>{image.src=source;return image.decode();},currentRed);
    const before=await renderedDeadline(page.evaluate(collectRenderedDashboardSample));
    await page.getByTestId('screenshot-local').evaluate(async(image,source)=>{const previous=image.cloneNode();previous.setAttribute('data-testid','screenshot-previous-local');image.before(previous);image.src=source;await image.decode();const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;background:rgb(216,48,37);z-index:9999;pointer-events:none';document.body.append(overlay);},currentGreen);
    const png=await capture.capture(page,{width:480,height:480}),after=await renderedDeadline(page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true}));
    const composed=(await compareRenderedCapturePaint({png,cards:before.cards,afterCards:after.cards,viewport:{width:480,height:480}},decoder))[0];
    assert.equal(composed.matched,true,'Old red pixels are physically possible within the authorized red-to-green transition');assert.equal(composed.transitioned,true);
    const known=before.cards.concat(after.cards).flatMap(card=>card.contributors);assert.ok(composed.contributors.every(frame=>renderedCaptureFrameAuthorized(frame,known)));
    assert.equal(composed.contributors.length,2);assert.deepEqual(composed.rgba,prior.rgba);
    clock=19000;const input={frame:after.cards[0].frame,composed,previous:{frame:old.cards[0].frame,rgba:prior.rgba},publicBinding:binding,observedAt:clock,pulseController:controller};
    assert.equal(scoreRenderedCaptureAge(input),19000,'A new decoded source cannot refresh unchanged old compositor pixels');
    assert.equal(scoreRenderedCaptureAge({...input,previous:{rgba:prior.rgba}}),Infinity,'Unknown older paint cannot gain causal freshness');
    assert.equal(proof().actualOutbound,0);
  }finally{await browser.close();}
});
