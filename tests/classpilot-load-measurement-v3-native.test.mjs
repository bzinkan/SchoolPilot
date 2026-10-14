import test from 'node:test';import assert from 'node:assert/strict';import{createRequire}from'node:module';import{readFileSync,readdirSync}from'node:fs';import{resolve,join}from'node:path';
import{collectNavigationPixelWitness,makeReliabilityColorFixtures,CAPTURE_COLOR_BASES,stampCausalCapture}from'../scripts/load/classpilot-reliability-profile.mjs';
import{collectRenderedDashboardSample,compareRenderedCapturePaint,compareRenderedNavigationPaint,createNativeScreenshotDecoder,renderedCaptureFrameAuthorized,renderedDeadline}from'../scripts/load/run-classpilot-rendered-dashboards.mjs';
let chromium,favicon;
const chrome=process.env.CLASSPILOT_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const nativeTest=(name,run)=>test(name,{skip:process.env.CLP_RUN_NATIVE_MEASUREMENT!=='1'},async()=>{
  ({chromium}=createRequire(new URL('../schoolpilot-app/package.json',import.meta.url))('playwright'));
  favicon='data:image/svg+xml;base64,'+readFileSync(new URL('../schoolpilot-app/public/favicon.svg',import.meta.url)).toString('base64');await run();
});
const expectedRow=()=>({studentId:'local',marker:'local-token',hostname:'docs.google.com',activeTabTitle:'Local native paint',favicon});
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
  const browser=await chromium.launch({executablePath:chrome,headless:true}),decoder=createNativeScreenshotDecoder();
  try{const{page,proof}=await localPage(browser);const expected=expectedRow();await page.setContent(html());await page.locator('img').evaluate(image=>image.decode());
    const compare=async row=>{const witness=await renderedDeadline(page.evaluate(collectNavigationPixelWitness,[row])),png=await page.screenshot(),afterRows=await renderedDeadline(page.evaluate(collectNavigationPixelWitness,[row]));return{witness,result:await compareRenderedNavigationPaint({png,rows:witness,afterRows,viewport:{width:480,height:480}},decoder)};};
    assert.equal((await compare(expected)).result[0].matched,true,'Real decoded SVG has actual colored compositor pixels');
    assert.equal(await page.evaluate(()=>!document.querySelector('[data-testid="tab-favicon-local-0"]')),false,'Identical prior icon cannot satisfy first-round absence');
    for(const events of['auto','none']){await page.evaluate(events=>{const overlay=document.createElement('div');overlay.id='overlay';overlay.style.cssText=`position:fixed;inset:0;background:black;z-index:9999;pointer-events:${events}`;document.body.append(overlay);},events);
      const value=await compare(expected);assert.equal(value.result[0].matched,false,events+' overlay cannot pass compositor proof');if(events==='none')assert.equal(value.witness[0].matched,true,'Pointer-events:none fools hit testing alone');await page.locator('#overlay').evaluate(node=>node.remove());}
    await page.locator('span').evaluate(node=>{node.querySelector('img').remove();node.append(document.createElement('div'));});
    assert.equal((await compare({...expected,favicon:undefined})).result[0].matched,true,'Actual placeholder pixels also verified');assert.equal(proof().actualOutbound,0);assert.equal(proof().interceptedDocuments,1);
  }finally{await browser.close();}
});
nativeTest('actual object-contain and outgoing frame contributors remain visible above caption overlays',async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true}),decoder=createNativeScreenshotDecoder();
  try{const{page,proof}=await localPage(browser);
    const fixtures=makeReliabilityColorFixtures();
    const current=stampCausalCapture(fixtures[1],1700000000000,2,{pulseSequence:1,pulseMarker:'a'.repeat(24)}),previous=stampCausalCapture(fixtures[0],1700000000000,1,{pulseSequence:1,pulseMarker:'a'.repeat(24)});
    // The existing production object-contain/retained layout is exercised;
    // local codec fixtures here do not claim candidate UI or fleet acceptance.
    await page.setContent(`<style>body{margin:0;background:white}.box{position:relative;width:320px;aspect-ratio:16/9;margin:30px;overflow:hidden;background:#ddd}.box img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.caption{position:absolute;bottom:0;left:0;right:0;height:40px;background:linear-gradient(transparent,black)}</style><div data-testid="card-student-local"><div class="box"><img data-testid="screenshot-previous-local" src="${previous}"><img data-testid="screenshot-local" style="opacity:.5" src="${current}"><div class="caption">Caption</div></div></div>`);
    await page.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
    const sample=await page.evaluate(collectRenderedDashboardSample),card=sample.cards[0];assert.equal(card.displayed,true);assert.equal(card.decoded,true);assert.equal(card.points.length,3);assert.equal(card.opacity,.5);assert.deepEqual(card.rgba,CAPTURE_COLOR_BASES[1].decodedRgba);assert.deepEqual(card.previousRgba,CAPTURE_COLOR_BASES[0].decodedRgba);
    assert.ok(card.points.every(point=>point.x>=100&&point.x<=280&&point.y<140),'Interior points lie within the centered square above caption');
    const compare=async()=>{const before=await renderedDeadline(page.evaluate(collectRenderedDashboardSample)),png=await page.screenshot(),after=await renderedDeadline(page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true}));return{before,result:await compareRenderedCapturePaint({png,cards:before.cards,afterCards:after.cards,viewport:{width:480,height:480}},decoder)};};
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
  const bundle=await build({absWorkingDir:appRoot,stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import StudentTile from ${JSON.stringify(component.replaceAll('\\','/'))};const root=createRoot(document.getElementById('root'));window.paintTiles=rows=>root.render(React.createElement('main',{style:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:16,padding:16}},rows.map(row=>React.createElement(StudentTile,{key:row.student.studentId,...row}))));`,resolveDir:appRoot,sourcefile:'native-student-tile.jsx',loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},outfile:'native-student-tile.js'});
  const cssFiles=readdirSync(join(appRoot,'dist/assets')).filter(name=>name.endsWith('.css'));
  assert.ok(cssFiles.length>0,'Exact built candidate styles required');
  const css=cssFiles.map(name=>readFileSync(join(appRoot,'dist/assets',name),'utf8')).join('\n')+readFileSync(join(appRoot,'src/products/classpilot/components/studentTileFrame.css'),'utf8');
  const browser=await chromium.launch({executablePath:chrome,headless:true}),decoder=createNativeScreenshotDecoder();
  try{const{page,proof}=await localPage(browser,{width:1920,height:4320});await page.setContent('<!doctype html><style>'+css+'</style><div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
    const fixtures=makeReliabilityColorFixtures(),now=Date.now(),rows=Array.from({length:40},(_,index)=>({student:{studentId:'local-'+index,studentName:'Local '+index,realtimeBinding:'exact-public-'+index,controlRevision:1,status:'online',activeTabUrl:'https://docs.google.com/'},monitoringDisplay:{kind:'connected',status:'online',telemetryCurrent:true,observedAtMs:now},freshnessNowMs:now,observationActive:true,screenshotObservationStatus:'observed',screenshotData:{timestamp:now,bindingVersion:'v2:local-'+index,screenshot:stampCausalCapture(fixtures[index%3],now,1,{pulseSequence:1,pulseMarker:'a'.repeat(24)})}}));
    await page.evaluate(rows=>window.paintTiles(rows),rows);await page.waitForFunction(()=>document.querySelectorAll('[data-testid^="screenshot-local-"]').length===40);await new Promise(resolve=>setTimeout(resolve,200));
    const before=await renderedDeadline(page.evaluate(collectRenderedDashboardSample));assert.equal(before.cards.length,40);const faults=await page.evaluate(()=>{const image=document.querySelector('[data-testid="screenshot-local-0"]'),nodes=[];for(let node=image;node;node=node.parentElement){const s=getComputedStyle(node),b=node.getBoundingClientRect();nodes.push({tag:node.tagName,testId:node.getAttribute('data-testid'),opacity:s.opacity,display:s.display,visibility:s.visibility,overflowX:s.overflowX,overflowY:s.overflowY,box:{left:b.left,top:b.top,right:b.right,bottom:b.bottom}});}const b=image.getBoundingClientRect();return{nodes,hit:document.elementFromPoint(b.left+b.width/2,b.top+b.height*.3)?.outerHTML.slice(0,500)}});assert.ok(before.cards.every(card=>card.displayed&&card.decoded&&card.frame?.jpegSha256),JSON.stringify(faults));
    for(let index=0;index<40;index++){rows[index].screenshotData={...rows[index].screenshotData,timestamp:Date.now(),screenshot:stampCausalCapture(fixtures[(index+1)%3],now,index===0?2:2,{pulseSequence:2,pulseMarker:'b'.repeat(24)})};}
    await page.evaluate(rows=>window.paintTiles(rows),rows);await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid^="screenshot-local-"]')].every(image=>atob(image.currentSrc.split(',')[1]).slice(-98,-2).includes(':2:2:')));
    const png=await page.screenshot(),after=await renderedDeadline(page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true}));
    const painted=await compareRenderedCapturePaint({png,cards:before.cards,afterCards:after.cards},decoder);
    assert.ok(painted.every(row=>row.matched&&row.transitioned&&row.contributors.length>=2),'Actual retained frame or completed150ms fade remains conservatively bounded');
    const known=before.cards.concat(after.cards).flatMap(card=>card.contributors);
    assert.ok(painted.every(row=>row.contributors.every(frame=>renderedCaptureFrameAuthorized(frame,known))));
    // Stagger40 ordinary production swaps across the unchanged five-second
    // cohort cadence. All native observation cost remains in its real clock.
    const swaps=rows.map((row,index)=>new Promise(resolve=>setTimeout(async()=>{row.screenshotData={...row.screenshotData,timestamp:Date.now(),screenshot:stampCausalCapture(fixtures[(index+2)%3],now,3,{pulseSequence:3,pulseMarker:'c'.repeat(24)})};await page.evaluate(rows=>window.paintTiles(rows),rows);resolve();},index*125)));
    for(let round=0;round<6;round++){const first=await renderedDeadline(page.evaluate(collectRenderedDashboardSample)),native=await page.screenshot(),last=await renderedDeadline(page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true}));const result=await compareRenderedCapturePaint({png:native,cards:first.cards,afterCards:last.cards},decoder);assert.ok(result.every(row=>row.matched),'Staggered real StudentTile swap remains measured');await new Promise(resolve=>setTimeout(resolve,600));}
    await Promise.all(swaps);
    // During a swap, this brown overlay is inside independent RGB min/max
    // bounds but is not any physically possible common-alpha source blend.
    const first=await page.evaluate(collectRenderedDashboardSample);rows[0].screenshotData={...rows[0].screenshotData,timestamp:Date.now(),screenshot:stampCausalCapture(fixtures[0],now,4,{pulseSequence:4,pulseMarker:'d'.repeat(24)})};await page.evaluate(rows=>window.paintTiles(rows),rows);
    await page.evaluate(()=>{const card=document.querySelector('[data-testid="card-student-local-0"]'),overlay=document.createElement('div');overlay.id='bad-overlay';overlay.style.cssText='position:absolute;inset:0;background:rgb(180,120,100);z-index:999;pointer-events:none';card.style.position='relative';card.append(overlay);});
    const bad=await page.screenshot(),last=await page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true});const result=await compareRenderedCapturePaint({png:bad,cards:first.cards,afterCards:last.cards},decoder);assert.equal(result.find(row=>row.studentId==='local-0').matched,false);assert.equal(proof().actualOutbound,0);
  }finally{await browser.close();}
});
test('native decoder timeout retains its underlying permit and rejects future admissions',async()=>{
  const image=Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001','hex');let release,destroyed=false;
  const decoder=createNativeScreenshotDecoder({timeoutMs:20,decodeFactory:()=>({promise:new Promise(resolve=>{release=resolve;}),destroy:()=>{destroyed=true;}})});
  await assert.rejects(decoder.run(image,{width:1,height:1},()=>true),/deadline exceeded/);assert.equal(destroyed,true);assert.equal(decoder.summary().active,1);assert.equal(decoder.summary().poisoned,true);
  await assert.rejects(decoder.run(image,{width:1,height:1},()=>true),/unavailable/);const bytes=Buffer.from([1,2,3,255]);release({data:bytes,info:{width:1,height:1,channels:4}});await new Promise(resolve=>setImmediate(resolve));assert.equal(decoder.summary().active,0);assert.equal(decoder.summary().lateSettlements,1);assert.deepEqual([...bytes],[0,0,0,0]);
});
