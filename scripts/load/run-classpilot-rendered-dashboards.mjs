import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export const RENDERED_CONTROLLER_DEPENDENCIES = Object.freeze({
  "classpilot-load-test.mjs": "12e25632b1d42c1bfbb1292f4c0d9409b28d1f0e3193c16218372c1d3f90d58d",
  "classpilot-reliability-profile.mjs": "e667d334eb8ef9f785d4ff07115ac2eb32b1268a403ecd9f497ba405149dfe32",
  "command-status-observer.mjs": "8d3dacb4fae02d0bf8b0a3ef1be312b1f0c6732b3b9e0760b129a49725ae87af",
  "fine-endpoint-latency.mjs": "415a63011f412fb02311d5643291840c365628f1e86ca9954c0b985d3e58cea4",
  "monotonic-deadline.mjs": "4b63a0de37a931d37112603101d20d2419fc1b7ed4f83029aea534f27a35bc49",
  "prepare-classpilot-load-test.mjs": "04d617610fec0add453b0f15e6a2398788ed8df3d1c18b8ec282e8d3160a551e",
  "producer-source-hook.mjs": "b909b3dbbb2286e7d477cacb76ef577c33ffc2af02a832fc2f689ed33b8480cb",
  "producer-source-ledger.mjs": "20a96bb8178b87551b831728e11f89ae9c40396e518aac5cd1898645aad43cce",
  "reliability-rendered-frame.mjs": "6108cd9f0898999de8a84b73e6df737fc1b39d0c1bc97aa17a71beb903e59eb7",
  "remote-generator-manifest.mjs": "ca00f895d943db2b1e667fc8d8898d80a06724971536939eb0b5cb48483019ba",
  "rendered-http-metrics.mjs": "0d8870681081ab48675bc20ef9b2a51d4101ffe92dbbf38ba5dfbb9314f642dc",
  "run-classpilot-reliability.mjs": "db9981c531314e772fc2875030aaed52fd16c67254813d1008d942b2bafb1f95",
  "run-classpilot-remote-generator.mjs": "0a47103641b600c9a4fa6dbc74fdf81094b03fb694410fe8e78af262e5e5e511",
  "session-cookie.mjs": "8c5d40d5217a05a08777cb53d3f27b43851b7189a9af631d0badb9c03f4bc8be",
  "source-ledger-harness-runtime.mjs": "7b1659aeed1657b9dde9233dcf6e3cd39e0431fedbeded590b93d02e0d5685ac",
  "source-ledger-sdk-bridge.mjs": "7006092b95b76eb2c9f0d56ddfada525289c53fda95646cec1fbb756fd2f870f",
  "source-startup-contract.mjs": "f40b5ff56563bdfa554b53386ba0363f3ebf8ba12cec7d452e5db5fc39e8316c",
  "staging-start-barrier.mjs": "6c117f54ea8dbf4305e068ec52090f7729748041382ad632dc0cfa380e8814a2",
  "tile-poll-accounting.mjs": "9845f899f5cac81737a165a955afc7fb154985255c63b225c582c5ccd8d6e808"
});
export function assertRenderedControllerDependencyClosure(directory) {
  const physicalRoot = realpathSync(directory), canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
  for (const [name, expected] of Object.entries(RENDERED_CONTROLLER_DEPENDENCIES)) {
    const file = join(physicalRoot, name);
    let bytes;
    try {
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 2 * 1024 * 1024
        || canonical(realpathSync(file)) !== canonical(file)) throw Error('Invalid dependency file');
      bytes = readFileSync(file);
      const after = lstatSync(file);
      if (!after.isFile() || after.isSymbolicLink() || bytes.length !== before.size
        || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])
        || createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Dependency identity mismatch');
    } catch {
      throw Error('Exact rendered controller dependency closure required');
    } finally { bytes?.fill(0); }
  }
  return Object.freeze({ version: 1, files: Object.keys(RENDERED_CONTROLLER_DEPENDENCIES).length,
    sha256: createHash('sha256').update(JSON.stringify(RENDERED_CONTROLLER_DEPENDENCIES)).digest('hex') });
}

// This closure covers only fixed local source. Installed native/npm libraries
// remain separately pinned by the candidate artifact and native gate.
export const RENDERED_CONTROLLER_DEPENDENCY_EVIDENCE = assertRenderedControllerDependencyClosure(dirname(fileURLToPath(import.meta.url)));
export async function importRenderedControllerDependency(name) {
  assert.ok(Object.hasOwn(RENDERED_CONTROLLER_DEPENDENCIES, name), 'Undeclared rendered controller dependency');
  return import(new URL('./' + name, import.meta.url).href);
}
const sharp = (await import('sharp')).default;
const { createMeasurementArtifactChannel, measurementOperationRetryable } = await importRenderedControllerDependency("run-classpilot-remote-generator.mjs");
const { assertExternalPaths, loadExternalConfig, preparePrivateOutputDirectory } = await importRenderedControllerDependency("prepare-classpilot-load-test.mjs");
const { hasLoadSessionCookie, loadSessionCookieName } = await importRenderedControllerDependency("session-cookie.mjs");
const { reliabilityProfile, reliabilityScreenshotBindingMatches, RELIABILITY_ENDPOINT_SHA256,
  CapturePulseController, measurementExpected, publicBindingFromDevice, validateRevisionBootstrap,
  observeRenderedStudentState, navigationSnapshot, navigationMessageMatches, navigationGate,
  validateMeasurementSignal, validateMeasurementWaiting, validateMeasurementReadySignal,
  validateMeasurementPendingSignal, MeasurementStartupGate, MEASUREMENT_LIMITS, createBoundedObserverPool } = await importRenderedControllerDependency("classpilot-reliability-profile.mjs");
const { readReliabilityFrame } = await importRenderedControllerDependency("reliability-rendered-frame.mjs");
const { validateStagingRunManifest, waitForStagingStart } = await importRenderedControllerDependency("staging-start-barrier.mjs");
const { RenderedHttpMetrics, attachRenderedHttpMetrics } = await importRenderedControllerDependency("rendered-http-metrics.mjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const RENDERED_VIEWPORT = Object.freeze({ width: 1920, height: 4320 });

export async function renderedDeadline(operation, milliseconds = 8000) {
  const controller = new AbortController();
  const suppliedTrace=operation?.nativeMeasurementTrace,trace=typeof suppliedTrace==='function'?event=>{try{suppliedTrace(event);}catch{}}:null,startedAt=performance.now();
  if(typeof trace==='function')trace({category:'caller_start',at:startedAt,budgetMs:milliseconds});
  const timeout = delay(milliseconds, null, { signal: controller.signal, ref: false })
    .then(() => { if(typeof trace==='function')trace({category:'caller_deadline',at:performance.now(),budgetMs:milliseconds,latenessMs:performance.now()-startedAt-milliseconds});throw new Error('Rendered instrumentation deadline exceeded'); });
  try { const result=await Promise.race([operation, timeout]);if(typeof trace==='function')trace({category:'caller_fulfilled',at:performance.now()});return result; }
  catch(error){if(typeof trace==='function')trace({category:'caller_rejected',at:performance.now()});throw error;}
  finally { controller.abort(); }
}

export function renderedHttpEndpointClassificationComplete(summary) {
  return summary?.counters?.unclassifiedRequests === 0
    && summary?.fineEndpointLatency?.unclassifiedCount === 0;
}

export function createRenderedInterruptionEvidence({now=()=>performance.now(),startAt=()=>null,endAt=()=>null,phase=()=> 'other'}={}) {
  const sources=['signal','navigation','publication','publication-drain','other'],phases=['preparing','start-barrier','warming','classroom-command-burst','sampling','draining-http-evidence','other'];
  const counts=Object.fromEntries(sources.map(key=>[key,0]));let first=null;
  return Object.freeze({record(source,error){
    source=sources.includes(source)?source:'other';counts[source]=Math.min(1000000,counts[source]+1);
    if(first)return;
    const at=now(),start=startAt(),end=endAt(),actualPhase=phase();
    const valid=Number.isFinite(at)&&Number.isFinite(start)&&at>=start;
    const category=source==='signal'?'signal':source==='publication-drain'?'publication-drain-failed'
      :[403,404].includes(error?.$metadata?.httpStatusCode)||[error?.name,error?.Code,error?.code].some(value=>value==='AccessDenied'||value==='NoSuchKey')?'storage-denied'
      :error?.name==='AbortError'?'cancelled':['deadline','busy'].includes(error?.measurementReadCode)?'deadline-or-busy'
      :error?.code==='ERR_ASSERTION'?'validation':'operation-rejected';
    first={source,category,phase:phases.includes(actualPhase)?actualPhase:'other',elapsedMs:valid?at-start:null,afterTimedWindow:valid&&Number.isFinite(end)&&at>=end};
  },summary:()=>({first:first?{...first}:null,counts:{...counts}})});
}

// Stop admission first, then allow the already admitted publisher caller to
// settle under its original500ms bound before destroying its SDK. One sleeping
// cadence wait can add at most1000ms. A true failure remains an interruption.
export async function drainRenderedPublicationBeforeClose({publicationLoop,close,onFailure,timeoutMs=1500}) {
  assert.equal(typeof close,'function');assert.equal(typeof onFailure,'function');assert.ok(Number.isFinite(timeoutMs)&&timeoutMs>0&&timeoutMs<=1500);
  try{if(publicationLoop)await renderedDeadline(publicationLoop,timeoutMs);}
  catch(error){onFailure(error);}
  finally{try{close();}catch(error){onFailure(error);throw error;}}
}

// Lossless full-resolution native capture. Timeout poisons this controller
// and retires only its own CDP session; the underlying permit remains held
// until actual settlement. A late PNG can never become measurement evidence.
export function createNativeScreenshotCapture({timeoutMs=8000,maximumActive=2,maximumPages=20,sessionFactory=page=>page.context().newCDPSession(page)}={}){
  const sessions=new WeakMap(),pending=new Set();let pages=0,active=0,poisoned=false;
  const counters={started:0,completed:0,timeouts:0,lateSettlements:0,peakActive:0,peakPngBytes:0};
  const capture=async(page,viewport=RENDERED_VIEWPORT,requestedClip=null,budgetMs=timeoutMs)=>{
    assert.ok(!poisoned&&active<maximumActive,'Native capture unavailable or concurrency exceeded');
    assert.ok(Number.isSafeInteger(viewport.width)&&Number.isSafeInteger(viewport.height)&&viewport.width>0&&viewport.height>0&&viewport.width*viewport.height<=RENDERED_VIEWPORT.width*RENDERED_VIEWPORT.height);
    const clip=requestedClip||{x:0,y:0,width:viewport.width,height:viewport.height};assert.deepEqual(Object.keys(clip).sort(),['height','width','x','y']);for(const key of ['x','y','width','height'])assert.ok(Number.isSafeInteger(clip[key]));assert.ok(clip.x>=0&&clip.y>=0&&clip.width>0&&clip.height>0&&clip.x+clip.width<=viewport.width&&clip.y+clip.height<=viewport.height);assert.ok(Number.isFinite(budgetMs)&&budgetMs>0);budgetMs=Math.min(timeoutMs,budgetMs);
    if(!sessions.has(page)){assert.ok(pages<maximumPages,'Native capture page bound exceeded');pages+=1;sessions.set(page,Promise.resolve().then(()=>sessionFactory(page)));}
    active+=1;counters.started+=1;counters.peakActive=Math.max(counters.peakActive,active);
    let fenced=false,session,timer;
    const raw=(async()=>{
      session=await sessions.get(page);
      if(fenced){Promise.resolve().then(()=>session.detach()).catch(()=>{});throw Error('Native capture session arrived after deadline');}
      const result=await session.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false,optimizeForSpeed:true,clip:{...clip,scale:1}});
      assert.ok(typeof result.data==='string'&&result.data.length<=Math.ceil(32*1024*1024/3)*4,'Bounded native PNG response required');
      const png=Buffer.from(result.data,'base64');
      if(fenced){png.fill(0);return null;}
      try{assert.ok(png.length>=24&&png.length<=32*1024*1024);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.subarray(12,16).toString('ascii'),'IHDR');
      assert.equal(png.readUInt32BE(16),clip.width);assert.equal(png.readUInt32BE(20),clip.height);}catch(error){png.fill(0);throw error;}
      counters.peakPngBytes=Math.max(counters.peakPngBytes,png.length);return png;
    })();
    const underlying=raw.finally(()=>{active-=1;counters.completed+=1;if(fenced)counters.lateSettlements+=1;});pending.add(underlying);underlying.finally(()=>pending.delete(underlying)).catch(()=>{});underlying.catch(()=>{});
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{fenced=true;poisoned=true;counters.timeouts+=1;
      if(session)Promise.resolve().then(()=>session.detach()).catch(()=>{});reject(Error('Native CDP capture deadline exceeded'));
    },budgetMs);});
    try{return await Promise.race([underlying,deadline]);}finally{clearTimeout(timer);}
  };
  return{capture,whenSettled:()=>Promise.allSettled([...pending]),summary:()=>({...counters,active,poisoned,pages,maximumActive,maximumPages})};
}

// This function runs in the actual candidate page, after the compositor has
// had two animation frames. Mounted or decoded offscreen images do not count.
export async function collectRenderedDashboardSample({ skipAnimationFrames = false } = {}) {
  if (!skipAnimationFrames) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const cacheKey=Symbol.for('classpilot.measurement.exact-image-source-cache.v1');
  if(!globalThis[cacheKey])globalThis[cacheKey]=new WeakMap();
  const cache=globalThis[cacheKey], startedAt=performance.now();
  const cards=[...document.querySelectorAll('[data-testid^="card-student-"]')];
  if(cards.length>40)throw Error('Capture color snapshot exceeds forty cards');
  const values=new Map(),pendingReadbacks=[];
  const metrics={uniqueImages:0,decodedImages:0,cacheHitImages:0,readbackImages:0,canvasCount:0,readbackCount:0,
    sourcePreparationMs:0,drawMs:0,readbackMs:0,layoutMs:0,digestRemainingMs:0,totalMs:0};
  const readImage=image=>{
    if(!image)return{frame:null,rgba:null,digest:Promise.resolve(null)};
    if(values.has(image))return values.get(image);
    if(values.size>=80)throw Error('Capture color snapshot exceeds eighty images');
    metrics.uniqueImages++;
    if(image.complete&&image.naturalWidth)metrics.decodedImages++;
    const source=image.currentSrc||'',prior=cache.get(image);
    if(prior?.source===source&&(prior.rgba||!image.complete||!image.naturalWidth)){
      metrics.cacheHitImages++;values.set(image,prior);return prior;
    }
    let frame=null,rgba=null,digest=Promise.resolve(null);
    if(source.startsWith('data:image/jpeg;base64,')){
      const binary=atob(source.slice('data:image/jpeg;base64,'.length));
      const m=binary.slice(-98,-2).match(/^CLP_REL_FRAME_V2:(\d{13}):(\d{1,16}):(\d{1,7}):([a-f0-9]{24}):END/);
      if(m&&binary.length===40960){
        frame={capturedAt:Number(m[1]),ordinal:Number(m[2]),pulseSequence:Number(m[3]),pulseMarker:m[4]};
        if(!crypto.subtle)throw Error('Secure WebCrypto source hash required');
        const bytes=new Uint8Array(40960);for(let index=0;index<40960;index++)bytes[index]=binary.charCodeAt(index);
        digest=crypto.subtle.digest('SHA-256',bytes).then(value=>[...new Uint8Array(value)].map(byte=>byte.toString(16).padStart(2,'0')).join(''));
      }
    }
    // Each actual IMG/currentSrc retains its own complete source identity.
    // Only uncached decoded images enter the synchronous readback batch.
    const value={source,frame,rgba,digest};cache.set(image,value);values.set(image,value);
    if(image.complete&&image.naturalWidth)pendingReadbacks.push({image,source,value,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight});
    return value;
  };
  for(const card of cards){
    const studentId=card.getAttribute('data-testid').slice('card-student-'.length);
    readImage(card.querySelector(`[data-testid="screenshot-${CSS.escape(studentId)}"]`));
    readImage(card.querySelector(`[data-testid="screenshot-previous-${CSS.escape(studentId)}"]`));
  }
  metrics.sourcePreparationMs=performance.now()-startedAt;
  metrics.readbackImages=pendingReadbacks.length;
  if(pendingReadbacks.length){
    const canvas=document.createElement('canvas');let pixels=null,context;
    canvas.width=pendingReadbacks.length;canvas.height=1;metrics.canvasCount=1;
    try{
      context=canvas.getContext('2d');
      if(!context)throw Error('Default capture readback context required');
      const drawStarted=performance.now();
      for(let index=0;index<pendingReadbacks.length;index++){
        const {image,source,naturalWidth,naturalHeight}=pendingReadbacks[index];
        if(image.currentSrc!==source||!image.complete||image.naturalWidth!==naturalWidth||image.naturalHeight!==naturalHeight)
          throw Error('Capture image changed inside synchronous readback');
        context.drawImage(image,index,0,1,1);
      }
      metrics.drawMs=performance.now()-drawStarted;
      const readStarted=performance.now();pixels=context.getImageData(0,0,pendingReadbacks.length,1).data;
      metrics.readbackMs=performance.now()-readStarted;metrics.readbackCount=1;
      if(!(pixels instanceof Uint8ClampedArray)||pixels.length!==pendingReadbacks.length*4)
        throw Error('Exact bounded capture readback bytes required');
      for(let index=0;index<pendingReadbacks.length;index++){
        const {image,source,naturalWidth,naturalHeight}=pendingReadbacks[index];
        if(image.currentSrc!==source||!image.complete||image.naturalWidth!==naturalWidth||image.naturalHeight!==naturalHeight)
          throw Error('Capture image changed inside synchronous readback');
      }
      for(let index=0;index<pendingReadbacks.length;index++)pendingReadbacks[index].value.rgba=[...pixels.subarray(index*4,index*4+4)];
    }catch(error){for(const {image,value}of pendingReadbacks)if(cache.get(image)===value)cache.delete(image);throw error;}
    finally{pixels?.fill(0);try{if(context)context.clearRect(0,0,canvas.width,canvas.height);}finally{canvas.width=canvas.height=0;}}
  }
  const styles=new WeakMap();const styleOf=node=>{if(!styles.has(node))styles.set(node,getComputedStyle(node));return styles.get(node);};
  const layoutStarted=performance.now(),visible=document.visibilityState==='visible';
  const pendingCards=cards.map(async card=>{
    const studentId=card.getAttribute('data-testid').slice('card-student-'.length), image=card.querySelector(`[data-testid="screenshot-${CSS.escape(studentId)}"]`), previous=card.querySelector(`[data-testid="screenshot-previous-${CSS.escape(studentId)}"]`);
    const currentValue=readImage(image),previousValue=readImage(previous),frame=currentValue.frame?{...currentValue.frame}:null,previousFrame=previousValue.frame?{...previousValue.frame}:null,box=image?.getBoundingClientRect();
    let displayed=!!box&&box.width>0&&box.height>0&&box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight;
    for(let node=image;displayed&&node;node=node.parentElement){const s=styleOf(node),b=node.getBoundingClientRect();
      if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)!==1 && node!==image
        ||/hidden|clip|scroll|auto/.test(s.overflowX)&&(box.left<b.left||box.right>b.right)
        ||/hidden|clip|scroll|auto/.test(s.overflowY)&&(box.top<b.top||box.bottom>b.bottom))displayed=false;}
    const decoded=!!image?.complete&&image.naturalWidth>0, rgba=currentValue.rgba, previousRgba=previousValue.rgba, opacity=image?Number(styleOf(image).opacity):0, points=[];
    if(displayed&&decoded&&rgba){
      // object-contain paints a centered square for these1x1 fixtures. Sample
      // the upper interior, outside the actual screenshot caption gradient.
      const scale=Math.min(box.width/image.naturalWidth,box.height/image.naturalHeight), width=image.naturalWidth*scale,height=image.naturalHeight*scale,left=box.left+(box.width-width)/2,top=box.top+(box.height-height)/2;
      for(const[x,y]of[[.35,.2],[.5,.3],[.65,.4]]){const px=Math.floor(left+width*x),py=Math.floor(top+height*y),hit=document.elementFromPoint(px,py);
        if(!hit||!(hit===image||hit===previous||image.contains(hit)||hit.contains(image)&&image.closest('button')?.contains(hit)))displayed=false;points.push({x:px,y:py});}
    }
    const geometry=box?{left:box.left,top:box.top,width:box.width,height:box.height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,objectFit:styleOf(image).objectFit}:null;
    const opacityAnimated=!!image?.getAnimations().some(animation=>animation.playState==='running');
    // Geometry/source references above form one synchronous DOM snapshot.
    // Digest completion cannot silently switch to a later DOM/source binding.
    if(frame)frame.jpegSha256=await currentValue.digest;if(previousFrame)previousFrame.jpegSha256=await previousValue.digest;
    return{studentId,frame,previousFrame,displayed,decoded,points,rgba,previousRgba,opacity,geometry,opacityAnimated,
      contributors:previous?[previousFrame,frame]:[frame]};
  });
  metrics.layoutMs=performance.now()-layoutStarted;
  const digestStarted=performance.now(),resultCards=await Promise.all(pendingCards);
  metrics.digestRemainingMs=performance.now()-digestStarted;metrics.totalMs=performance.now()-startedAt;
  return{visible,cards:resultCards,measurementTiming:metrics};
}

export async function collectRenderedNavigationPixelWitness(input) {
  const expectedRows=Array.isArray(input)?input:input.expectedRows;
  if(Array.isArray(input)||!input.skipAnimationFrames)await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return expectedRows.map(expected => {
    const card = document.querySelector(`[data-testid="card-student-${CSS.escape(expected.studentId)}"]`);
    const tab = card?.querySelector(`[data-testid="tab-favicon-${CSS.escape(expected.studentId)}-0"]`);
    const image = tab?.querySelector('img'), paint = image || tab?.querySelector('div'), box = paint?.getBoundingClientRect();
    let visible = document.visibilityState === 'visible' && !!box && box.width > 0 && box.height > 0
      && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
    for (let node = paint; visible && node; node = node.parentElement) {
      const style = getComputedStyle(node), b = node.getBoundingClientRect();
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) !== 1
        || /hidden|clip|scroll|auto/.test(style.overflowX) && (box.left < b.left || box.right > b.right)
        || /hidden|clip|scroll|auto/.test(style.overflowY) && (box.top < b.top || box.bottom > b.bottom)) visible = false;
    }
    const titleMatches = tab?.getAttribute('title') === `${expected.activeTabTitle} · ${expected.hostname}`;
    const active = tab?.classList.contains('ring-1') && tab?.classList.contains('border-primary/70');
    const sourceMatches = expected.favicon ? image?.currentSrc === expected.favicon && image.complete && image.naturalWidth > 0 : !image && !!paint;
    const points = [], canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    let glyph=null;
    const context = canvas.getContext('2d');
    if (visible && sourceMatches && titleMatches && active) {
      if (image) {
        // Match native destination pixels, including fractional layout offset;
        // a32px surrogate introduces SVG rasterization/antialiasing error.
        canvas.width=Math.ceil(box.width)+2;canvas.height=Math.ceil(box.height)+2;
        context.drawImage(image,box.left-Math.floor(box.left),box.top-Math.floor(box.top),box.width,box.height);
      }
      else {
        const stack = []; for (let node = paint; node; node = node.parentElement) stack.push(node);
        for (const node of stack.reverse()) { context.fillStyle = getComputedStyle(node).backgroundColor; context.fillRect(0, 0, 32, 32); }
      }
      const anchors = image ? [[.2,.2],[.5,.2],[.8,.2],[.4,.75]]
        : [[.4,.4],[.5,.4],[.6,.4],[.4,.5],[.5,.5],[.6,.5],[.5,.6]];
      for (const [x, y] of anchors) {
        const screenX = Math.floor(box.left + box.width * x), screenY = Math.floor(box.top + box.height * y);
        const hit = document.elementFromPoint(screenX, screenY);
        if (!hit || !(tab === hit || tab.contains(hit))) visible = false;
        const rgba = [...context.getImageData(image?screenX-Math.floor(box.left):Math.floor(32*x), image?screenY-Math.floor(box.top):Math.floor(32*y), 1, 1).data];
        if (rgba[3] === 255) points.push({ x: screenX, y: screenY, rgba });
      }
      if(image&&Math.abs(box.width-14)<.001&&Math.abs(box.height-14)<.001&&image.naturalWidth===64&&image.naturalHeight===64){
        // The tiny arrow's diagonal edges rasterize differently in canvas
        // and the actual IMG compositor. Require its independently bounded
        // ordered white/two-yellow motif, with opaque colors from the exact
        // decoded source. Four stable blue interiors alone would allow a
        // solid-blue overlay to masquerade as the icon.
        canvas.width=canvas.height=64;context.drawImage(image,0,0,64,64);
        const white=[...context.getImageData(32,29,1,1).data],yellow=[...context.getImageData(28,34,1,1).data];
        if(white[3]===255&&yellow[3]===255&&white.some((value,index)=>index<3&&Math.abs(value-yellow[index])>24))
          glyph={left:Math.floor(box.left)+5,top:Math.floor(box.top)+6,width:3,height:3,white,yellow};
      }
    }
    return { studentId: expected.studentId, marker: expected.marker, points,glyph,
      matched: !!visible && !!sourceMatches && !!titleMatches && !!active && (image?points.length===4&&!!glyph:points.length>=5) };
  });
}

export function renderedCaptureFrameAuthorized(frame, knownFrames) {
  return Boolean(frame&&/^[a-f0-9]{64}$/.test(frame.jpegSha256||'')&&knownFrames?.some(candidate=>
    candidate.ordinal===frame.ordinal&&candidate.capturedAt===frame.capturedAt&&candidate.pulseSequence===frame.pulseSequence
    &&candidate.pulseMarker===frame.pulseMarker&&candidate.jpegSha256===frame.jpegSha256));
}

// Decode once in the controller, at original compositor coordinates. Never
// send the full PNG back to a renderer or allocate a viewport canvas there.
// On timeout, retain the underlying permit and poison this measurement
// decoder: ignored native cancellation cannot admit overlapping work.
export function createNativeScreenshotDecoder({ timeoutMs = 8000, maximumActive = 2, decodeFactory,onEvent } = {}) {
  sharp.cache(false);
  let active = 0, poisoned = false;const pending=new Set();
  const counters = { started: 0, completed: 0, timeouts: 0, lateSettlements: 0, peakActive: 0, peakRawBytes: 0, traceErrors:0 };
  const emit=event=>{try{onEvent?.(event);}catch{counters.traceErrors++;}};
  const actualFactory = png => {
    const pipeline = sharp(png, { limitInputPixels: RENDERED_VIEWPORT.width * RENDERED_VIEWPORT.height, failOn: 'warning' })
      .ensureAlpha().raw().timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) });
    return { promise: pipeline.toBuffer({ resolveWithObject: true }), destroy: () => pipeline.destroy() };
  };
  const run = async (png, viewport, sample, budgetMs=timeoutMs) => {
    assert.ok(Number.isFinite(budgetMs)&&budgetMs>0&&budgetMs<=timeoutMs);
    assert.ok(!poisoned && active < maximumActive, 'Native decoder unavailable or bounded concurrency exceeded');
    assert.ok(Buffer.isBuffer(png) && png.length >= 24 && png.length <= 32 * 1024 * 1024);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Native PNG required');
    assert.equal(png.subarray(12,16).toString('ascii'), 'IHDR');
    assert.ok(Number.isSafeInteger(viewport.width) && Number.isSafeInteger(viewport.height) && viewport.width > 0 && viewport.height > 0
      && viewport.width * viewport.height <= RENDERED_VIEWPORT.width * RENDERED_VIEWPORT.height);
    assert.equal(png.readUInt32BE(16), viewport.width); assert.equal(png.readUInt32BE(20), viewport.height);
    active += 1; counters.started += 1; counters.peakActive = Math.max(counters.peakActive, active);
    const sequence=counters.started,beganAt=performance.now();emit({category:'decode_begin',sequence,at:beganAt,budgetMs,encodedBytes:png.length,width:viewport.width,height:viewport.height});
    let timedOut = false, job, timer;
    try { job = (decodeFactory || actualFactory)(png); }
    catch (error) { active -= 1; throw error; }
    const underlying = Promise.resolve(job.promise).then(({ data, info }) => {
      emit({category:'decode_native_result',sequence,at:performance.now(),late:timedOut});
      try {
        assert.ok(Buffer.isBuffer(data)); assert.equal(info.width, viewport.width); assert.equal(info.height, viewport.height);
        assert.equal(info.channels, 4); assert.equal(data.length, viewport.width * viewport.height * 4);
        counters.peakRawBytes = Math.max(counters.peakRawBytes, data.length);
        if (timedOut) return null;
        const pixel = ({ x, y }) => {
          assert.ok(Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0 && x < info.width && y < info.height);
          const start = (y * info.width + x) * 4; return [...data.subarray(start, start + 4)];
        };
        emit({category:'decode_sample_begin',sequence,at:performance.now()});try{return sample(pixel,{data,info});}finally{emit({category:'decode_sample_end',sequence,at:performance.now()});}
      } finally { data?.fill?.(0); }
    });
    const settled = underlying.finally(() => { active -= 1; counters.completed += 1; if (timedOut) counters.lateSettlements += 1;emit({category:'decode_settled',sequence,at:performance.now(),late:timedOut}); });
    pending.add(settled);settled.finally(()=>pending.delete(settled)).catch(()=>{});settled.catch(() => {});
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      timedOut = true; poisoned = true; counters.timeouts += 1;emit({category:'decode_caller_deadline',sequence,at:performance.now(),latenessMs:performance.now()-beganAt-budgetMs}); job.destroy?.(); reject(new Error('Native compositor decode deadline exceeded'));
    }, budgetMs); });
    try { return await Promise.race([settled, deadline]); } finally { clearTimeout(timer); }
  };
  return { run, whenSettled:()=>Promise.allSettled([...pending]), summary: () => ({ ...counters, active, poisoned, maximumActive,nativeWorkerConcurrency:sharp.concurrency() }) };
}

const sameFrame = (first, second) => Boolean(first && second && first.jpegSha256 === second.jpegSha256
  && first.ordinal === second.ordinal && first.capturedAt === second.capturedAt
  && first.pulseSequence === second.pulseSequence && first.pulseMarker === second.pulseMarker);
export function renderedCaptureFenceMatches(card, after) {
  return Boolean(card && after && card.displayed && after.displayed && card.decoded && after.decoded
    && JSON.stringify(card.geometry) === JSON.stringify(after.geometry) && JSON.stringify(card.points) === JSON.stringify(after.points)
    && (sameFrame(card.frame, after.frame) && JSON.stringify(card.rgba) === JSON.stringify(after.rgba)
      && (card.opacity >= 1 && after.opacity >= 1 || after.opacity>=1&&!after.previousFrame
        || sameFrame(card.previousFrame, after.previousFrame)
        && JSON.stringify(card.previousRgba) === JSON.stringify(after.previousRgba))
      // A legitimate production swap retains the exact prior current frame.
      // Multiple/unlinked swaps in one native read are unknown and refused.
      || !sameFrame(card.frame, after.frame) && (sameFrame(card.frame, after.previousFrame)
          && JSON.stringify(card.rgba) === JSON.stringify(after.previousRgba)
        || !after.previousFrame&&after.opacity>=1&&after.frame?.ordinal===card.frame?.ordinal+1)));
}
export function renderedCaptureContributors(card, after) {
  const all=[...(card?.contributors||[]),...(after?.contributors||[])],seen=new Set();
  return all.filter(frame=>{if(!frame)return true;const key=frame.jpegSha256;if(seen.has(key))return false;seen.add(key);return true;});
}
export function nativePixelsCausallyChanged(previous, current) {
  // The unchanged compositor matcher permits twelve bytes of channel error.
  // A difference inside that envelope cannot prove a new physical paint.
  const valid = value => Array.isArray(value) && value.length > 0 && value.length % 4 === 0
    && value.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255);
  return valid(previous) && valid(current) && previous.length === current.length
    && previous.some((channel, index) => Math.abs(channel - current[index]) > 12);
}
export function scoreRenderedCaptureAge({frame,composed,previous,publicBinding,observedAt,pulseController}){
  // An unproved DOM-only initial image or empty placeholder is UNKNOWN.
  if (!previous?.rgba && previous?.nativeAbsence !== true) return Infinity;
  const changed=previous?.nativeAbsence===true||nativePixelsCausallyChanged(previous.rgba,composed?.rgba);
  if(sameFrame(previous?.frame,frame)||changed)return Math.max(...composed.contributors.map(value=>pulseController.ageUpper(value,publicBinding,observedAt)));
  if(previous?.frame)return pulseController.ageUpper(previous.frame,publicBinding,observedAt);
  return Infinity;
}
// One common alpha must explain ALL channels and points. Independent channel
// bounds over three colors would accept pixels that no legal fade can paint.
export function renderedPixelsMatchBlend(pixels,current,previous,minimum=0,maximum=1,tolerance=12){
  if(!current||!previous||!pixels.length)return false;
  let low=minimum,high=maximum;
  for(const pixel of pixels)for(let channel=0;channel<4;channel++){
    const change=current[channel]-previous[channel],observed=pixel[channel]-previous[channel];
    if(Math.abs(change)<.001){if(Math.abs(observed)>tolerance)return false;continue;}
    const a=(observed-tolerance)/change,b=(observed+tolerance)/change;
    low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));if(low>high)return false;
  }
  return low<=high;
}
export function compareRenderedCapturePixels(cards,afterCards,pixel){return cards.map(card => {
    const after = afterCards.find(row => row.studentId === card.studentId), actual = card.points.map(pixel);
    const low = Math.min(card.opacity, after?.opacity ?? 0), old = card.previousRgba;
    const contributors=renderedCaptureContributors(card,after),swapped=!sameFrame(card.frame,after?.frame);
    const legalPaint=swapped
      ? renderedPixelsMatchBlend(actual,card.rgba,old||card.rgba,0,1)
        ||renderedPixelsMatchBlend(actual,after?.rgba,after?.previousRgba||card.rgba,0,1)
      : renderedPixelsMatchBlend(actual,card.rgba,old||card.rgba,card.opacityAnimated||after?.opacityAnimated?0:low,card.opacityAnimated||after?.opacityAnimated?1:Math.max(card.opacity,after?.opacity??0));
    const matched = renderedCaptureFenceMatches(card, after) && card.rgba && card.points.length === 3
      && contributors.length>0&&contributors.every(frame=>frame&&/^[a-f0-9]{64}$/.test(frame.jpegSha256||''))
      && (low >= 1 || old && card.previousFrame || swapped)&&legalPaint;
    return { studentId: card.studentId, matched: Boolean(matched), rgba: actual[1] || null,contributors,transitioned:swapped };
  } );
}
export function compareRenderedNavigationPixels(rows,afterRows,pixel){return rows.map(row => {
    const after = afterRows.find(value => value.studentId === row.studentId), actual = row.points.map(pixel);
    const same = row.matched && after?.matched && row.marker === after.marker && JSON.stringify(row.points) === JSON.stringify(after.points)
      &&JSON.stringify(row.glyph)===JSON.stringify(after.glyph);
    const glyphPixels=row.glyph?Array.from({length:9},(_,index)=>pixel({x:row.glyph.left+index%3,y:row.glyph.top+Math.floor(index/3)})):[];
    const near=(actual,expected)=>actual.every((value,channel)=>Math.abs(value-expected[channel])<=12);
    const motif=!row.glyph||[0,1,3,4].some(index=>near(glyphPixels[index],row.glyph.white)
      &&near(glyphPixels[index+3],row.glyph.yellow)&&near(glyphPixels[index+4],row.glyph.yellow));
    return { studentId: row.studentId, marker: row.marker, matched: Boolean(same&&motif&&(row.glyph?row.points.length===4:row.points.length>=5)
      && row.points.every((point,index) => near(actual[index],point.rgba))), pixels: actual.concat(glyphPixels).flat() };
  } );
}
export async function compareRenderedCapturePaint({png,cards,afterCards,viewport=RENDERED_VIEWPORT},decoder=createNativeScreenshotDecoder()){return decoder.run(png,viewport,pixel=>compareRenderedCapturePixels(cards,afterCards,pixel));}
export async function compareRenderedNavigationPaint({png,rows,afterRows,viewport=RENDERED_VIEWPORT},decoder=createNativeScreenshotDecoder()){return decoder.run(png,viewport,pixel=>compareRenderedNavigationPixels(rows,afterRows,pixel));}


export function nativeViewportOriginProof(){
 const v=visualViewport;return{width:innerWidth,height:innerHeight,scrollX,scrollY,devicePixelRatio,visualViewport:v?{pageLeft:v.pageLeft,pageTop:v.pageTop,offsetLeft:v.offsetLeft,offsetTop:v.offsetTop,width:v.width,height:v.height,scale:v.scale}:null};
}
export function assertNativeViewportOrigin(origin,viewport=RENDERED_VIEWPORT){
 assert.deepEqual(origin,{width:viewport.width,height:viewport.height,scrollX:0,scrollY:0,devicePixelRatio:1,visualViewport:{pageLeft:0,pageTop:0,offsetLeft:0,offsetTop:0,width:viewport.width,height:viewport.height,scale:1}},'Sparse native witnesses require a stable supported zero viewport/document origin and scale1');
 return origin;
}
export async function readNativeViewportOrigin(page,viewport=RENDERED_VIEWPORT,budgetMs=2000){
 assert.ok(Number.isFinite(budgetMs)&&budgetMs>0&&budgetMs<=2000);const origin=await renderedDeadline(page.evaluate(nativeViewportOriginProof),budgetMs);return assertNativeViewportOrigin(origin,viewport);
}


export const SPARSE_NATIVE_LIMITS=Object.freeze({maximumRows:40,maximumClips:8,maximumBytes:32*1024*1024,deadlineMs:8000,margin:2});
export function nativeWitnessPoints(row,kind){
 assert.ok(['capture','navigation'].includes(kind));assert.ok(Array.isArray(row.points));
 const points=row.points.map(point=>({x:point.x,y:point.y}));
 if(kind==='navigation'&&row.glyph){assert.deepEqual(Object.keys(row.glyph).sort(),['height','left','top','white','width','yellow']);assert.equal(row.glyph.width,3);assert.equal(row.glyph.height,3);
  for(let y=0;y<3;y++)for(let x=0;x<3;x++)points.push({x:row.glyph.left+x,y:row.glyph.top+y});}
 return points;
}
export function planNativeWitnessClips(rows,{kind,viewport=RENDERED_VIEWPORT}={}){
 assert.ok(Array.isArray(rows)&&rows.length>0&&rows.length<=SPARSE_NATIVE_LIMITS.maximumRows);
 assert.equal(new Set(rows.map(row=>row.studentId)).size,rows.length);
 assert.ok(Number.isSafeInteger(viewport.width)&&Number.isSafeInteger(viewport.height)&&viewport.width>0&&viewport.height>0&&viewport.width*viewport.height<=RENDERED_VIEWPORT.width*RENDERED_VIEWPORT.height);
 const intervals=[];
 for(const row of rows){
  assert.ok(typeof row.studentId==='string'&&row.studentId.length>0);
  const points=nativeWitnessPoints(row,kind);if(!points.length)continue;
  for(const point of points)assert.ok(Number.isSafeInteger(point.x)&&Number.isSafeInteger(point.y)&&point.x>=SPARSE_NATIVE_LIMITS.margin&&point.y>=SPARSE_NATIVE_LIMITS.margin&&point.x<viewport.width-SPARSE_NATIVE_LIMITS.margin&&point.y<viewport.height-SPARSE_NATIVE_LIMITS.margin,'Every planned native witness needs an integer in-viewport interior');
  intervals.push({left:Math.min(...points.map(p=>p.x))-2,right:Math.max(...points.map(p=>p.x))+3,top:Math.min(...points.map(p=>p.y))-2,bottom:Math.max(...points.map(p=>p.y))+3});
 }
 intervals.sort((a,b)=>a.left-b.left||a.top-b.top);
 const groups=[];for(const interval of intervals){const previous=groups.at(-1);if(previous&&interval.left<previous.right){previous.right=Math.max(previous.right,interval.right);previous.top=Math.min(previous.top,interval.top);previous.bottom=Math.max(previous.bottom,interval.bottom);}else groups.push({...interval});}
 assert.ok(groups.length<=SPARSE_NATIVE_LIMITS.maximumClips,'Native sparse clip count exceeded');
 const clips=groups.length?[{x:Math.min(...groups.map(group=>group.left)),y:Math.min(...groups.map(group=>group.top)),width:Math.max(...groups.map(group=>group.right))-Math.min(...groups.map(group=>group.left)),height:Math.max(...groups.map(group=>group.bottom))-Math.min(...groups.map(group=>group.top))}]:[];
 const pixels=clips.reduce((sum,clip)=>sum+clip.width*clip.height,0);assert.ok(pixels<=viewport.width*viewport.height,'Native sparse area exceeded full viewport');
 for(const row of rows)for(const point of nativeWitnessPoints(row,kind))assert.equal(clips.filter(clip=>point.x>=clip.x+2&&point.y>=clip.y+2&&point.x<clip.x+clip.width-2&&point.y<clip.y+clip.height-2).length,1,'Every witness must belong to exactly one native clip');
 return{kind,viewport:{...viewport},clips,witnessCount:rows.reduce((sum,row)=>sum+nativeWitnessPoints(row,kind).length,0),rows:rows.length,pixels};
}
export async function captureNativeWitnessClips(page,plan,nativeCapture,{now=()=>performance.now()}={}){
 assert.ok(plan&&Array.isArray(plan.clips)&&plan.clips.length<=SPARSE_NATIVE_LIMITS.maximumClips);
 const startedAt=now(),deadlineAt=startedAt+SPARSE_NATIVE_LIMITS.deadlineMs,parts=[];let bytes=0;const origin=await readNativeViewportOrigin(page,plan.viewport);
 try{
  for(const clip of plan.clips){const remaining=deadlineAt-now();assert.ok(remaining>0,'Whole native clip batch deadline exceeded');
   const png=await nativeCapture.capture(page,plan.viewport,clip,Math.min(SPARSE_NATIVE_LIMITS.deadlineMs,remaining));bytes+=png.length;parts.push({clip:{...clip},png});
   assert.ok(bytes<=SPARSE_NATIVE_LIMITS.maximumBytes,'Whole native clip batch bytes exceeded');assert.ok(now()<=deadlineAt,'Whole native clip batch deadline exceeded');
  }
  const finalOriginBudget=Math.min(2000,deadlineAt-now());assert.ok(finalOriginBudget>0,'Whole native clip batch deadline exceeded');const originAfterCapture=await readNativeViewportOrigin(page,plan.viewport,finalOriginBudget);assert.deepEqual(originAfterCapture,origin);assert.ok(now()<=deadlineAt,'Whole native clip batch deadline exceeded');return{plan,parts,bytes,startedAt,deadlineAt,capturedAt:now(),origin};
 }catch(error){for(const part of parts)part.png.fill(0);throw error;}
}
export async function compareNativeWitnessClips({bundle,rows,afterRows,kind,viewport=RENDERED_VIEWPORT,originAfter,now=()=>performance.now()},decoder=createNativeScreenshotDecoder()){
 const values=new Map();try{
 assertNativeViewportOrigin(bundle.origin,viewport);assertNativeViewportOrigin(originAfter,viewport);assert.deepEqual(originAfter,bundle.origin);
 const expected=planNativeWitnessClips(rows,{kind,viewport});assert.deepEqual(bundle.plan,expected);
 assert.equal(bundle.parts.length,expected.clips.length);assert.ok(Number.isFinite(bundle.deadlineAt));
 const requested=new Map();for(const row of rows)for(const point of nativeWitnessPoints(row,kind))requested.set(point.x+','+point.y,point);
  for(let index=0;index<bundle.parts.length;index++){
   const part=bundle.parts[index];assert.deepEqual(part.clip,expected.clips[index]);
   const inside=[...requested].filter(([,point])=>point.x>=part.clip.x&&point.x<part.clip.x+part.clip.width&&point.y>=part.clip.y&&point.y<part.clip.y+part.clip.height);
   const remaining=bundle.deadlineAt-now();assert.ok(remaining>0,'Whole native clip batch completion deadline exceeded');
   await decoder.run(part.png,{width:part.clip.width,height:part.clip.height},pixel=>{for(const[key,point]of inside){assert.ok(!values.has(key),'Native witness clip overlap');values.set(key,pixel({x:point.x-part.clip.x,y:point.y-part.clip.y}));}},Math.min(SPARSE_NATIVE_LIMITS.deadlineMs,remaining));
   assert.ok(now()<=bundle.deadlineAt,'Whole native clip batch completion deadline exceeded');
  }
  assert.equal(values.size,requested.size,'No planned native witness may be omitted');
  const pixel=point=>{const value=values.get(point.x+','+point.y);assert.ok(value,'Native witness not captured');return value;};
  return kind==='capture'?compareRenderedCapturePixels(rows,afterRows,pixel):compareRenderedNavigationPixels(rows,afterRows,pixel);
 }finally{for(const part of bundle.parts||[])part.png?.fill?.(0);values.clear();}
}

export function createNativePriorPaintStore({viewport=RENDERED_VIEWPORT,maxSnapshots=20,maximumAgeMs=90000,now=()=>performance.now(),memoryBudget}={}){
 assert.ok(Number.isSafeInteger(maxSnapshots)&&maxSnapshots>0&&maxSnapshots<=20);assert.ok(Number.isSafeInteger(maximumAgeMs)&&maximumAgeMs>0&&maximumAgeMs<=90000);
 const bytesPerSnapshot=viewport.width*viewport.height*4;assert.ok(bytesPerSnapshot>0&&bytesPerSnapshot<=RENDERED_VIEWPORT.width*RENDERED_VIEWPORT.height*4);
 const snapshots=new Map(),pending=new Set(),epochs=new Map();let closed=false,triggerAt=null,epoch=0;
 const counters={captured:0,invalidated:0,lateFenced:0,peakSnapshots:0,peakBytes:0};
 const provenanceValid=value=>{assert.deepEqual(Object.keys(value).sort(),['actorId','bindingsSha256','runId','schoolId','socketGeneration','teachingSessionId','viewport']);for(const key of ['actorId','runId','schoolId','teachingSessionId'])assert.ok(typeof value[key]==='string'&&value[key].length>0&&value[key].length<=128);assert.ok(Number.isSafeInteger(value.socketGeneration)&&value.socketGeneration>0);assert.match(value.bindingsSha256,/^[a-f0-9]{64}$/);assert.deepEqual(value.viewport,viewport);};
 const invalidate=key=>{epochs.set(key,(epochs.get(key)||0)+1);const stored=snapshots.get(key);if(stored){stored.data.fill(0);stored.release?.();snapshots.delete(key);counters.invalidated++;}};
 const capture=async(key,{png,decoder,provenance})=>{
  assert.ok(!closed&&triggerAt===null&&!pending.has(key)&&!snapshots.has(key));assert.ok(typeof key==='string'&&key.length>0);provenanceValid(provenance);
  assert.ok(pending.size+snapshots.size<maxSnapshots,'Native prior snapshot count exceeded');pending.add(key);
  const localEpoch=epoch,keyEpoch=epochs.get(key)||0;let data,release;
  try{
   release=memoryBudget?.reserve('prior-'+key,bytesPerSnapshot);
   data=await decoder.run(png,viewport,(_pixel,raw)=>Buffer.from(raw.data));
   assert.ok(Buffer.isBuffer(data)&&data.length===bytesPerSnapshot);
   if(closed||epoch!==localEpoch||triggerAt!==null||(epochs.get(key)||0)!==keyEpoch){data.fill(0);data=null;counters.lateFenced++;throw Error('Native prior snapshot retired before settlement');}
   const preparedAt=now();snapshots.set(key,{data,provenance:structuredClone(provenance),preparedAt,release});data=null;release=null;counters.captured++;
   counters.peakSnapshots=Math.max(counters.peakSnapshots,snapshots.size);counters.peakBytes=Math.max(counters.peakBytes,snapshots.size*bytesPerSnapshot);return{preparedAt,bytes:bytesPerSnapshot};
  }finally{pending.delete(key);data?.fill(0);png.fill(0);release?.();}
 };
 const setTrigger=value=>{assert.ok(Number.isFinite(value)&&value>=0&&triggerAt===null);triggerAt=value;};
 const changed=(key,{witness,composed,provenance,triggerAt:entryAt})=>{
  const stored=snapshots.get(key);if(!stored)return false;
  try{provenanceValid(provenance);const observedAt=now();assert.ok(!closed&&Number.isFinite(entryAt)&&Number.isFinite(observedAt)&&observedAt>=entryAt&&entryAt===triggerAt&&stored.preparedAt<entryAt&&entryAt-stored.preparedAt<=maximumAgeMs&&observedAt-stored.preparedAt<=maximumAgeMs);assert.deepEqual(stored.provenance,provenance);}catch{invalidate(key);return false;}
  if(!composed?.matched)return false;
  const points=nativeWitnessPoints(witness,'navigation');assert.ok(composed.pixels.length===points.length*4);
  let different=false;for(let index=0;index<points.length;index++){const point=points[index];assert.ok(Number.isSafeInteger(point.x)&&Number.isSafeInteger(point.y)&&point.x>=0&&point.y>=0&&point.x<viewport.width&&point.y<viewport.height);const offset=(point.y*viewport.width+point.x)*4;for(let channel=0;channel<4;channel++)if(Math.abs(stored.data[offset+channel]-composed.pixels[index*4+channel])>12)different=true;}
  return different;
 };
 const dispose=()=>{closed=true;epoch++;for(const stored of snapshots.values()){stored.data.fill(0);stored.release?.();}snapshots.clear();};
 return{capture,setTrigger,changed,invalidate,dispose,summary:()=>({...counters,activeSnapshots:snapshots.size,pendingSnapshots:pending.size,activeBytes:snapshots.size*bytesPerSnapshot,declaredMaximumBytes:maxSnapshots*bytesPerSnapshot,maxSnapshots,maximumAgeMs,closed,triggered:triggerAt!==null})};
}


// This budget covers explicitly retained native PNG, active decode RGBA and
// stored prior RGBA. Base64/RPC strings, cache and browser RSS are measured
// separately; a reservation is never released before raw work settles.
export function createNativeBinaryBudget({maximumBytes=2147483648}={}){
 assert.ok(Number.isSafeInteger(maximumBytes)&&maximumBytes>0&&maximumBytes<=2147483648);const held=new Map();let activeBytes=0,peakBytes=0;
 return{reserve:(key,bytes)=>{assert.ok(typeof key==='string'&&key.length>0&&!held.has(key));assert.ok(Number.isSafeInteger(bytes)&&bytes>0&&activeBytes+bytes<=maximumBytes,'Native binary budget exceeded');held.set(key,bytes);activeBytes+=bytes;peakBytes=Math.max(peakBytes,activeBytes);let released=false;return()=>{if(released)return;released=true;assert.equal(held.get(key),bytes);held.delete(key);activeBytes-=bytes;};},summary:()=>({maximumBytes,activeBytes,peakBytes,reservations:held.size})};
}

export function nativeObservationPhases(startedAt,count){assert.ok(Number.isFinite(startedAt)&&startedAt>=0);assert.ok(Number.isSafeInteger(count)&&count>0&&count<=1080);return Array.from({length:count},(_,index)=>startedAt+index*5000);}

export function createNativeTeacherRegistry({maximumOwners=20,maximumQueue=2,deadlineMs=8000,queueDeadlineMs=24000,memoryBudget=createNativeBinaryBudget(),now=()=>performance.now(),onEvent}={}){
 assert.ok(Number.isSafeInteger(maximumOwners)&&maximumOwners>0&&maximumOwners<=20);assert.equal(maximumQueue,2);assert.ok(deadlineMs>0&&deadlineMs<=8000&&queueDeadlineMs>0&&queueDeadlineMs<=24000);
 const owners=new Map(),browserSet=new WeakSet(),pageSet=new WeakSet(),captureSet=new WeakSet(),decoderSet=new WeakSet(),retained=new Set();let closed=false,active=0,peakActive=0;
 const counters={admitted:0,completed:0,failed:0,queueRejected:0,queueExpired:0,retired:0,traceErrors:0};
 const emit=event=>{try{onEvent?.(event);}catch{counters.traceErrors++;}};
 const failureCategory=error=>/Native CDP capture deadline/.test(error?.message||'')?'capture-deadline':/Native compositor decode deadline/.test(error?.message||'')?'decode-deadline':/Rendered instrumentation deadline/.test(error?.message||'')?'dom-deadline':/closed/i.test(error?.message||'')?'context-closed':/retired|current job generation/i.test(error?.message||'')?'generation-retired':'other';
 const register=({key,browser,page,capture,decoder,retire})=>{
  assert.ok(!closed&&owners.size<maximumOwners&&!owners.has(key),'Distinct bounded native teacher required');assert.ok(typeof key==='string'&&key.length>0&&browser&&page&&!browserSet.has(browser)&&!pageSet.has(page)&&!captureSet.has(capture)&&!decoderSet.has(decoder));assert.equal(typeof retire,'function');assert.equal(capture.summary().maximumActive,1);assert.equal(capture.summary().maximumPages,1);assert.equal(decoder.summary().maximumActive,1);assert.equal(capture.summary().active,0);assert.equal(decoder.summary().active,0);assert.equal(capture.summary().poisoned,false);assert.equal(decoder.summary().poisoned,false);assert.equal(typeof capture.whenSettled,'function');assert.equal(typeof decoder.whenSettled,'function');
  browserSet.add(browser);pageSet.add(page);captureSet.add(capture);decoderSet.add(decoder);const state={key,browser,page,capture,decoder,retire,ownerOrdinal:owners.size+1,domSequence:0,active:false,poisoned:false,queue:[],rawDom:new Set(),retained:new Set(),lastKind:null,retirement:null,admitted:0,completed:0,generation:0};owners.set(key,state);
  const retireOwner=(reason='manual')=>{if(!state.retirement){state.poisoned=true;counters.retired++;const fixedReason=['manual','capture-deadline','decode-deadline','dom-deadline','context-closed','generation-retired','other','binary-budget','late-or-retired-result','observer-deadline'].includes(reason)?reason:'other';emit({category:'owner_retired',ownerOrdinal:state.ownerOrdinal,generation:state.generation,at:performance.now(),reason:fixedReason});for(const queued of state.queue.splice(0)){clearTimeout(queued.timer);queued.reject(Error('Native teacher retired'));}state.retirement=Promise.resolve().then(retire);state.retirement.catch(()=>{});}return state.retirement;};
  const pump=()=>{
   if(state.active||state.poisoned||closed||!state.queue.length)return;
   let index=0;if(state.queue.length>1){const other=state.queue.findIndex(job=>job.kind!==state.lastKind);if(other>=0)index=other;}
   const job=state.queue.splice(index,1)[0];clearTimeout(job.timer);state.active=true;state.lastKind=job.kind;state.admitted++;active++;peakActive=Math.max(peakActive,active);assert.ok(active<=maximumOwners);counters.admitted++;
   let release;try{release=memoryBudget.reserve('observer-'+key,32*1024*1024+RENDERED_VIEWPORT.width*RENDERED_VIEWPORT.height*4);}catch(error){state.active=false;active--;counters.failed++;job.reject(error);void retireOwner('binary-budget');return;}
   const startedAt=now(),generation=++state.generation;let taskOpen=true,completionCurrent=false,ownerDeadline=false;emit({category:'owner_admitted',ownerOrdinal:state.ownerOrdinal,generation,at:performance.now(),kind:job.kind});
   const timeCurrent=()=>{const observedAt=now();return Number.isFinite(observedAt)&&observedAt>=startedAt&&observedAt<=startedAt+deadlineMs;};
   const isCurrent=()=>taskOpen&&state.active&&state.generation===generation&&!closed&&!state.poisoned&&timeCurrent();
   const trackDom=(operation,operationCategory='other')=>{assert.ok(isCurrent(),'Native DOM read requires its exact current job generation');const fixedOperationCategory=['origin','capture-dom','navigation-dom','other'].includes(operationCategory)?operationCategory:'other',sequence=++state.domSequence;let outcome='pending',callerDeadlineAt=null,deadlineObserved=false;const trace=event=>{if(event.category==='caller_start')callerDeadlineAt=event.at+event.budgetMs;if(event.category==='caller_deadline')deadlineObserved=true;emit({...event,scope:'dom',ownerOrdinal:state.ownerOrdinal,generation,sequence,operationCategory:fixedOperationCategory});};trace({category:'dom_queued',at:performance.now()});const raw=Promise.resolve().then(()=>{assert.ok(isCurrent(),'Retired native DOM work');trace({category:'dom_sent',at:performance.now()});return operation();}).then(value=>{outcome='fulfilled';return value;},error=>{outcome='rejected';throw error;});Object.defineProperty(raw,'nativeMeasurementTrace',{value:trace});state.rawDom.add(raw);raw.finally(()=>{state.rawDom.delete(raw);const at=performance.now();trace({category:'dom_settled',at,outcome,deadlineObserved,late:callerDeadlineAt!==null&&at>callerDeadlineAt});}).catch(()=>{});raw.catch(()=>{});return raw;};
   const observedPage={evaluate:(...args)=>trackDom(()=>page.evaluate(...args),args[0]?.name==='nativeViewportOriginProof'?'origin':args[0]?.name==='collectRenderedDashboardSample'?'capture-dom':args[0]?.name==='collectRenderedNavigationPixelWitness'?'navigation-dom':'other')},scopedCapture={capture:(...args)=>{assert.ok(isCurrent(),'Retired native capture work');return capture.capture(...args);},whenSettled:()=>capture.whenSettled(),summary:()=>capture.summary()},scopedDecoder={run:(...args)=>{assert.ok(isCurrent(),'Retired native decode work');return decoder.run(...args);},whenSettled:()=>decoder.whenSettled(),summary:()=>decoder.summary()};
   const operation=Promise.resolve().then(()=>job.task({page:observedPage,capture:scopedCapture,decoder:scopedDecoder,trackDom,isCurrent})).then(value=>{completionCurrent=isCurrent();taskOpen=false;return value;},error=>{taskOpen=false;throw error;});operation.catch(()=>{});
   Object.defineProperty(operation,'nativeMeasurementTrace',{value:event=>{if(event.category==='caller_deadline')ownerDeadline=true;emit({...event,scope:'owner',ownerOrdinal:state.ownerOrdinal,generation,kind:job.kind});}});
   const caller=renderedDeadline(operation,deadlineMs);caller.then(value=>{if(!completionCurrent||closed||state.poisoned||!timeCurrent()){counters.failed++;job.reject(Error('Native teacher retired or late result'));void retireOwner('late-or-retired-result');}else job.resolve(value);},error=>{counters.failed++;job.reject(error);void retireOwner(ownerDeadline?'observer-deadline':failureCategory(error));});
   const work=(async()=>{try{await operation;}catch(error){void retireOwner(ownerDeadline?'observer-deadline':failureCategory(error));}finally{await Promise.allSettled([capture.whenSettled(),decoder.whenSettled(),...state.rawDom]);assert.equal(capture.summary().active,0);assert.equal(decoder.summary().active,0);assert.equal(state.rawDom.size,0);release();state.active=false;state.completed++;active--;counters.completed++;emit({category:'owner_settled',ownerOrdinal:state.ownerOrdinal,generation,at:performance.now(),kind:job.kind});pump();}})();retained.add(work);state.retained.add(work);work.finally(()=>{retained.delete(work);state.retained.delete(work);}).catch(()=>{});work.catch(()=>{});
  };
  const observe=(task,{kind='capture'}={})=>{assert.ok(['capture','navigation','prior'].includes(kind));assert.equal(typeof task,'function');if(closed||state.poisoned)return Promise.reject(Error('Native teacher retired'));if(state.queue.length>=maximumQueue){counters.queueRejected++;return Promise.reject(Error('Native teacher observation queue exceeded'));}
   const result=new Promise((resolve,reject)=>{const job={task,kind,resolve,reject,enqueuedAt:now(),timer:null};job.timer=setTimeout(()=>{const index=state.queue.indexOf(job);if(index>=0){state.queue.splice(index,1);counters.queueExpired++;reject(Error('Native teacher observation queue deadline exceeded'));}},queueDeadlineMs);state.queue.push(job);pump();});result.catch(()=>{});return result;};
  return{observe,retire:retireOwner,whenSettled:()=>Promise.allSettled([...state.retained]),summary:()=>({active:state.active,queued:state.queue.length,poisoned:state.poisoned,rawDom:state.rawDom.size,generation:state.generation,admitted:state.admitted,completed:state.completed,capture:capture.summary(),decoder:decoder.summary()})};
 };
 return{register,close:()=>{closed=true;return Promise.allSettled([...owners.values()].map(state=>{state.poisoned=true;for(const job of state.queue.splice(0)){clearTimeout(job.timer);job.reject(Error('Native teacher registry closed'));}if(!state.retirement){counters.retired++;emit({category:'owner_retired',ownerOrdinal:state.ownerOrdinal,generation:state.generation,at:performance.now(),reason:'shutdown'});state.retirement=Promise.resolve().then(state.retire);state.retirement.catch(()=>{});}return state.retirement;}));},whenSettled:()=>Promise.allSettled([...retained]),summary:()=>({...counters,owners:owners.size,maximumOwners,active,peakActive,queued:[...owners.values()].reduce((sum,state)=>sum+state.queue.length,0),rawDom:[...owners.values()].reduce((sum,state)=>sum+state.rawDom.size,0),closed,memory:memoryBudget.summary()})};
}

// Actual staging orchestration. Factories can be supplied by offline contract
// tests; the command-line driver uses only the fixed native defaults below.
export function createActualRenderedObserverRuntime({ maximumOwners = 20, now = () => performance.now(),
  ownerDeadlineMs = 8000, cleanupDeadlineMs = 8000, closeDeadlineMs = 4000,
  captureFactory = page => createNativeScreenshotCapture({ maximumActive: 1, maximumPages: 1,
    sessionFactory: () => page.context().newCDPSession(page) }),
  decoderFactory = () => createNativeScreenshotDecoder({ maximumActive: 1 }) } = {}) {
  for (const [value, maximum] of [[ownerDeadlineMs, 8000], [cleanupDeadlineMs, 8000], [closeDeadlineMs, 4000]]) {
    assert.ok(Number.isFinite(value) && value > 0 && value <= maximum);
  }
  const memoryBudget = createNativeBinaryBudget();
  const registry = createNativeTeacherRegistry({ maximumOwners, memoryBudget, now, deadlineMs: ownerDeadlineMs });
  const warm = createBoundedObserverPool({ limit: 2, maximumQueue: 40, now });
  const records = [], pendingOpens = new Set(), pendingSetups = new Set();
  let closed = false, cleanupResult = null;
  const processExited = record => Boolean(record.process && (record.process.exitCode !== null || record.process.signalCode !== null));
  const closeRecord = record => {
    if (record.closure) return record.closure;
    record.closure = (async () => {
      let closeFailed = false, killFailed = false;
      try { await renderedDeadline(Promise.resolve().then(() => record.server.close()), closeDeadlineMs); }
      catch { closeFailed = true; }
      if (!processExited(record) || record.browser?.isConnected()) {
        try { await renderedDeadline(Promise.resolve().then(() => record.server.kill()), closeDeadlineMs); }
        catch { killFailed = true; }
      }
      return { processExited: processExited(record), disconnected: !record.browser?.isConnected(), closeFailed, killFailed };
    })();
    record.closure.catch(() => {});
    return record.closure;
  };
  const openTeacherRaw = async ({ chromium, executablePath, index }) => {
    assert.ok(!closed && records.length < maximumOwners);
    const server = await chromium.launchServer({ executablePath, headless: true,
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const process = server.process();
    // Ownership is recorded before metadata checks, connect, context or Page.
    const record = { server, process, index, browser: null, closure: null, capture: null, decoder: null };
    records.push(record);
    try {
      assert.ok(process && Number.isSafeInteger(process.pid) && process.pid > 0);
      assert.ok(records.slice(0, -1).every(previous => previous.server !== server && previous.process?.pid !== process.pid));
      assert.equal(closed, false, 'Late owned BrowserServer retired');
      record.browser = await chromium.connect(server.wsEndpoint());
      assert.equal(closed, false, 'Late browser connection retired');
      const context = await record.browser.newContext({ viewport: RENDERED_VIEWPORT });
      assert.equal(closed, false, 'Late context creation retired');
      const page = await context.newPage();
      assert.equal(closed, false, 'Late Page creation retired');
      const physicalCapture = captureFactory(page);
      // Each job has a new scoped evaluate-only Page facade. Native session
      // identity always belongs to the immutable physical teacher Page.
      record.capture = { capture: (_scopedPage, ...args) => physicalCapture.capture(page, ...args),
        whenSettled: () => physicalCapture.whenSettled(), summary: () => physicalCapture.summary() };
      record.decoder = decoderFactory();
      const owner = registry.register({ key: 'rendered-teacher-' + index, browser: server, page,
        capture: record.capture, decoder: record.decoder, retire: () => closeRecord(record) });
      return { browser: record.browser, context, page, owner };
    } catch (error) { await closeRecord(record); throw error; }
  };
  const retainSetup = (pending, work) => {
    // Reserve before the first launch/setup call can run in its microtask.
    const raw = Promise.resolve().then(work);
    pending.add(raw);
    raw.finally(() => pending.delete(raw)).catch(() => {});
    raw.catch(() => {});
    return raw;
  };
  const openTeacher = options => {
    assert.ok(!closed && records.length + pendingOpens.size < maximumOwners, 'Owned browser launch bound exceeded');
    return retainSetup(pendingOpens, () => openTeacherRaw(options));
  };
  const setupTeacher = (options, setup) => retainSetup(pendingSetups, async () => {
    const opened = await openTeacher(options);
    assert.equal(closed, false, 'Teacher setup retired');
    await setup(opened);
    assert.equal(closed, false, 'Late authenticated teacher setup retired');
    return opened;
  });
  const prepareWarm = runtime => task => warm.run(async () => {
    try { return await runtime.owner.observe(task, { kind: 'prior' }); }
    finally { await runtime.owner.whenSettled(); }
  });
  const close = async ({ extraDrains = [] } = {}) => {
    if (cleanupResult) return cleanupResult;
    closed = true;
    // Start retirement and every exact owned close BEFORE raw DOM/native,
    // publisher, navigation or prior-preparation drains are awaited.
    const retirement = registry.close();
    const closings = records.map(closeRecord);
    let closureSettled = false, closureResults = [], drainsSettled = false;
    try { closureResults = await renderedDeadline(Promise.all(closings), cleanupDeadlineMs); closureSettled = true; }
    catch { /* Pending exact-owned operations remain unknown. */ }
    try {
      await renderedDeadline(Promise.allSettled([retirement, registry.whenSettled(), ...pendingOpens, ...pendingSetups, ...extraDrains]), cleanupDeadlineMs);
      drainsSettled = true;
    } catch { /* No synthetic release of a raw guard or memory reservation. */ }
    // Late launch results self-close in openTeacherRaw. Re-snapshot after the
    // bounded setup drain; unresolved launches can never yield passed cleanup.
    if (pendingOpens.size === 0 && pendingSetups.size === 0) {
      try { closureResults = await renderedDeadline(Promise.all(records.map(closeRecord)), cleanupDeadlineMs); }
      catch { closureSettled = false; }
    }
    const state = registry.summary();
    cleanupResult = { closureSettled, drainsSettled, pendingOpens: pendingOpens.size, pendingSetups: pendingSetups.size, ownedServers: records.length,
      ownedProcessesRemaining: records.filter(record => !processExited(record)).length,
      ownedBrowsersConnected: records.filter(record => record.browser?.isConnected()).length,
      closeFailed: closureResults.filter(value => value.closeFailed).length,
      killFailed: closureResults.filter(value => value.killFailed).length,
      registry: state, warm: warm.summary(),
      passed: closureSettled && drainsSettled && pendingOpens.size === 0 && pendingSetups.size === 0 && records.every(record => processExited(record) && !record.browser?.isConnected())
        && closureResults.every(value => !value.closeFailed && !value.killFailed)
        && state.active === 0 && state.queued === 0 && state.rawDom === 0 && state.memory.activeBytes === 0
        && warm.summary().active === 0 && warm.summary().queued === 0 };
    return cleanupResult;
  };
  const adapters = kind => records.filter(record => record[kind]).map(record => record[kind].summary());
  return { openTeacher, setupTeacher, prepareWarm, close, registry, memoryBudget, warm,
    summary: () => ({ registry: registry.summary(), warm: warm.summary(), pendingOpens: pendingOpens.size, pendingSetups: pendingSetups.size, ownedServers: records.length,
      ownedProcessesRemaining: records.filter(record => !processExited(record)).length,
      ownedBrowsersConnected: records.filter(record => record.browser?.isConnected()).length,
      captures: adapters('capture'), decoders: adapters('decoder'), cleanup: cleanupResult }) };
}

export function attachActualRenderedSocketObserver(runtime, socket, { invalidatePrior = () => {}, onDenial = () => {},
  onStudentScopeError = () => {}, onCommandScopeError = () => {}, now = () => performance.now() } = {}) {
  const generation = ++runtime.socketGeneration;
  let pendingRequestId = null;
  const invalidate = () => {
    runtime.subscribed = false;
    runtime.scopeEpoch = (runtime.scopeEpoch ?? 0) + 1;
    runtime.priorStripAbsent = false;
    runtime.frames.clear();
    runtime.realtime.clear();
    runtime.lastPaints.clear();
    invalidatePrior();
  };
  invalidate();
  const exactScope = message => (message.teachingSessionId === runtime.actor.teachingSessionId
      || message.sessionId === runtime.actor.teachingSessionId)
    && (message.teachingSessionId === undefined || message.teachingSessionId === runtime.actor.teachingSessionId)
    && (message.sessionId === undefined || message.sessionId === runtime.actor.teachingSessionId)
    && message.supervisionContextId === undefined
    && (message.schoolId === undefined || message.schoolId === runtime.actor.schoolId);
  socket.on('close', () => { if (runtime.socketGeneration === generation) { pendingRequestId = null; invalidate(); } });
  socket.on('framesent', event => {
    try {
      if (runtime.socketGeneration !== generation) return;
      const message = JSON.parse(String(event.payload));
      if (message.type !== 'subscribe-session' && message.type !== 'unsubscribe-session') return;
      // Every attempt changes authority, even A-to-B-to-A on the same socket.
      pendingRequestId = null;
      invalidate();
      if (message.type === 'subscribe-session' && exactScope(message)
        && typeof message.requestId === 'string' && message.requestId.length > 0) pendingRequestId = message.requestId;
    } catch { /* Malformed frames cannot establish authority. */ }
  });
  socket.on('framereceived', event => {
    try {
      if (runtime.socketGeneration !== generation) return;
      const message = JSON.parse(String(event.payload));
      if (message.type === 'session-subscription-success') {
        const exact = exactScope(message) && pendingRequestId !== null && message.requestId === pendingRequestId;
        if (pendingRequestId !== null && message.requestId === pendingRequestId) {
          if (!exact) { pendingRequestId = null; invalidate(); }
          else runtime.subscribed = true;
        }
      }
      if (message.type === 'auth-error' || message.type === 'session-subscription-error') {
        pendingRequestId = null; invalidate(); onDenial();
      }
      if (observeRenderedStudentState(runtime, message, now())) onStudentScopeError();
      if (observeRenderedCommandUpdate(runtime, message, now())) onCommandScopeError();
    } catch { /* Other transport frames cannot establish completion. */ }
  });
  return { invalidate: () => { pendingRequestId = null; invalidate(); }, generation,
    summary: () => ({ generation, scopeEpoch: runtime.scopeEpoch, subscribed: runtime.subscribed, pendingExpectedSubscription: pendingRequestId !== null }) };
}

export function renderedRuntimeAuthoritySnapshot(runtime, auth, runId, nowWall = Date.now()) {
  const actor = runtime.actor;
  assert.equal(actor.role, 'teacher');
  assert.equal(actor.schoolId, auth.schoolId);
  assert.ok(runtime.subscribed && Number.isSafeInteger(runtime.socketGeneration) && runtime.socketGeneration > 0);
  const expiresAt = Math.min(Date.parse(actor.expiresAt), Date.parse(auth.expiresAt), Date.parse(auth.deviceManifestExpiresAt));
  assert.ok(Number.isFinite(expiresAt) && Number.isFinite(nowWall) && nowWall < expiresAt);
  assert.ok(actor.studentIds.every(id => runtime.allowed.has(id) && typeof runtime.bindings.get(id) === 'string' && runtime.bindings.get(id).length > 0));
  return { actorId: actor.teacherId, runId, schoolId: actor.schoolId, teachingSessionId: actor.teachingSessionId,
    socketGeneration: runtime.socketGeneration, bindingsSha256: hash(Buffer.from(JSON.stringify(actor.studentIds.slice().sort().map(id => [id, runtime.bindings.get(id)])))),
    viewport: RENDERED_VIEWPORT };
}
export function renderedRuntimeAuthorityMatches(runtime, auth, fence, nowWall = Date.now()) {
  try { return JSON.stringify(renderedRuntimeAuthoritySnapshot(runtime, auth, fence.runId, nowWall)) === JSON.stringify(fence); }
  catch { return false; }
}

// Diagnostic outcomes explain unavailable proof without changing freshness or authority.
const CAPTURE_DIAGNOSTIC_REASONS = Object.freeze(['observed', 'authority-changed', 'missed-phase', 'owner-failure',
  'late-or-empty-attempt', 'result-missing', 'not-visible', 'not-displayed', 'not-decoded', 'frame-missing',
  'frame-not-authorized', 'before-after-dom-changed', 'native-pixel-mismatch', 'baseline-unproved',
  'unchanged-causal-paint-unproved', 'causal-age-rejected', 'unclassified-unavailable']);
const CAPTURE_DIAGNOSTIC_STAGES = Object.freeze(['before-dom', 'native-capture', 'after-dom', 'native-compare', 'owner-attempt']);
const CAPTURE_DIAGNOSTIC_MS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 8000, Infinity]);
export function createRenderedCaptureDiagnostics() {
  const reasons = Object.fromEntries(CAPTURE_DIAGNOSTIC_REASONS.map(reason => [reason, 0]));
  const timings = Object.fromEntries(CAPTURE_DIAGNOSTIC_STAGES.map(stage => [stage, CAPTURE_DIAGNOSTIC_MS.map(() => 0)]));
  let plannedTargets = 0, accountedTargets = 0, invalidCount = 0, invalidTimingCount = 0;
  return {
    planTargets(count) {
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(plannedTargets + count)) { invalidCount++; return; }
      plannedTargets += count;
    },
    account(reason, count = 1) {
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(accountedTargets + count)) { invalidCount++; return; }
      if (!Object.hasOwn(reasons, reason)) { reason = 'unclassified-unavailable'; invalidCount++; }
      reasons[reason] += count; accountedTargets += count;
    },
    timing(stage, milliseconds) {
      if (!Object.hasOwn(timings, stage) || !Number.isFinite(milliseconds) || milliseconds < 0) { invalidTimingCount++; return; }
      timings[stage][CAPTURE_DIAGNOSTIC_MS.findIndex(bound => milliseconds <= bound)]++;
    },
    summary() {
      return { version: 'fixed-capture-refusal-and-timing-v1', diagnosticOnly: true, plannedTargets, accountedTargets,
        pendingTargets: Math.max(0, plannedTargets - accountedTargets), finiteTargets: reasons.observed,
        unavailableTargets: accountedTargets - reasons.observed, overaccountedTargets: Math.max(0, accountedTargets - plannedTargets),
        reasonCounts: { ...reasons }, invalidCount, invalidTimingCount,
        timingBoundsMs: CAPTURE_DIAGNOSTIC_MS.map(value => Number.isFinite(value) ? value : null),
        timingCounts: Object.fromEntries(CAPTURE_DIAGNOSTIC_STAGES.map(stage => [stage, timings[stage].slice()])) };
    },
  };
}
async function captureDiagnosticTiming(diagnostics, stage, operation, now) {
  if (!diagnostics) return operation();
  const beganAt = now();
  try { return await operation(); }
  finally { diagnostics.timing(stage, now() - beganAt); }
}
// Content-free diagnostics separate delivery from the native witness overhead.
// The existing end-to-end navigation gate remains the acceptance measurement.
export function createRenderedNavigationDiagnostics() {
  const bounds = [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 8000, Infinity];
  const stages = ['trigger-to-socket', 'socket-to-owner-check', 'trigger-to-dom-witness',
    'dom-to-native-proof', 'trigger-to-native-proof'];
  const counts = Object.fromEntries(stages.map(stage => [stage, bounds.map(() => 0)]));
  let provenPaintTargets = 0, invalidCount = 0;
  return {
    observe({ triggerAt, socketAt, ownerAt, domAt, proofAt }) {
      const times = [triggerAt, socketAt, ownerAt, domAt, proofAt];
      if (times.some(value => !Number.isFinite(value) || value < 0)
        || times.some((value, index) => index > 0 && value < times[index - 1])) { invalidCount++; return false; }
      const durations = [socketAt - triggerAt, ownerAt - socketAt, domAt - triggerAt,
        proofAt - domAt, proofAt - triggerAt];
      for (let index = 0; index < stages.length; index++) counts[stages[index]][bounds.findIndex(bound => durations[index] <= bound)]++;
      provenPaintTargets++;
      return true;
    },
    summary() {
      return { version: 'fixed-navigation-phase-diagnostics-v1', diagnosticOnly: true, provenPaintTargets, invalidCount,
        boundsMs: bounds.map(value => Number.isFinite(value) ? value : null),
        counts: Object.fromEntries(stages.map(stage => [stage, counts[stage].slice()])) };
    },
  };
}
export function renderedCaptureRefusalReason({ age, visible, card, after, authorized, composed, previous, ageRejected }) {
  if (Number.isFinite(age)) return 'observed';
  if (!visible) return 'not-visible';
  if (!card?.displayed) return 'not-displayed';
  if (!card.decoded) return 'not-decoded';
  if (!card.frame) return 'frame-missing';
  if (!authorized) return 'frame-not-authorized';
  if (!composed?.matched) return !renderedCaptureFenceMatches(card, after) ? 'before-after-dom-changed' : 'native-pixel-mismatch';
  if (ageRejected) return 'causal-age-rejected';
  if (!previous?.rgba && previous?.nativeAbsence !== true) return 'baseline-unproved';
  return 'unchanged-causal-paint-unproved';
}
export function accountRenderedCaptureDiagnostic(diagnostics, attempt, result, authorized, age, metadata) {
  diagnostics.account(Number.isFinite(age) ? 'observed' : !attempt ? metadata.diagnosticReason || 'late-or-empty-attempt'
    : !authorized ? 'authority-changed' : result?.diagnosticReason || 'result-missing');
}

export async function observeActualRenderedCapture(runtime, scope, { auth, runId, publicBindings, pulseController,
  deadlineAt, now = () => performance.now(), nowWall = () => Date.now(), diagnostics }) {
  const fence = renderedRuntimeAuthoritySnapshot(runtime, auth, runId, nowWall());
  const scopeEpoch = runtime.scopeEpoch ?? 0;
  if (!scope.isCurrent() || now() >= deadlineAt) return null;
  const sample = await captureDiagnosticTiming(diagnostics, 'before-dom',
    () => renderedDeadline(scope.page.evaluate(collectRenderedDashboardSample)), now);
  const bundle = await captureDiagnosticTiming(diagnostics, 'native-capture',
    () => captureNativeWitnessClips(scope.page, planNativeWitnessClips(sample.cards, { kind: 'capture' }), scope.capture), now);
  const compositorSha256 = hash(Buffer.from(bundle.parts.map(part => hash(part.png)).join(':')));
  try {
    const after = await captureDiagnosticTiming(diagnostics, 'after-dom',
      () => renderedDeadline(scope.page.evaluate(collectRenderedDashboardSample, { skipAnimationFrames: true })), now);
    const originAfter = await readNativeViewportOrigin(scope.page, RENDERED_VIEWPORT, Math.min(2000, bundle.deadlineAt - now()));
    const pixels = await captureDiagnosticTiming(diagnostics, 'native-compare',
      () => compareNativeWitnessClips({ bundle, rows: sample.cards, afterRows: after.cards, kind: 'capture', originAfter, now }, scope.decoder), now);
    const observedAt = now();
    // t1 is the completion of actual native decode, never a corrected clock.
    if (!scope.isCurrent() || observedAt >= deadlineAt || (runtime.scopeEpoch ?? 0) !== scopeEpoch || !renderedRuntimeAuthorityMatches(runtime, auth, fence, nowWall())) return null;
    const results = runtime.actor.studentIds.map(studentId => {
      const card = sample.cards.find(row => row.studentId === studentId), composed = pixels.find(row => row.studentId === studentId);
      const contributors = composed?.contributors || [];
      const authorized = contributors.length > 0 && contributors.every(frame => renderedCaptureFrameAuthorized(frame, runtime.frames.get(studentId)));
      let age = Infinity, ageRejected = false;
      if (sample.visible && card?.displayed && card.decoded && card.frame && authorized && composed?.matched) {
        try { age = scoreRenderedCaptureAge({ frame: card.frame, composed, previous: runtime.lastPaints.get(studentId),
          publicBinding: publicBindings.get(studentId), observedAt, pulseController }); }
        catch { ageRejected = true; /* Unknown or aliased paint remains Infinity. */ }
      }
      const afterCard = after.cards.find(row => row.studentId === studentId);
      const diagnosticReason = renderedCaptureRefusalReason({ age, visible: sample.visible, card, after: afterCard, authorized,
        composed, previous: runtime.lastPaints.get(studentId), ageRejected });
      return { studentId, age, authorized, card, after: afterCard, composed, diagnosticReason };
    });
    return { fence, scopeEpoch, observedAt, visible: sample.visible, wrongClass: sample.cards.length !== runtime.actor.studentIds.length
      || new Set(sample.cards.map(card => card.studentId)).size !== runtime.actor.studentIds.length
      || sample.cards.some(card => !runtime.allowed.has(card.studentId)), results,
      compositorSha256 };
  } finally { for (const part of bundle.parts) part.png.fill(0); }
}

export async function observeActualRenderedNavigationPaint(scope, expectedRows, { afterReadMs = 2000,
  now = () => performance.now() } = {}) {
  assert.ok(Number.isFinite(afterReadMs) && afterReadMs > 0 && afterReadMs <= 2000);
  const witness = (await renderedDeadline(scope.page.evaluate(collectRenderedNavigationPixelWitness, expectedRows), afterReadMs))
    .filter(row => row.matched);
  if (!witness.length) return null;
  const diagnosticDomObservedAt = now();
  const bundle = await captureNativeWitnessClips(scope.page, planNativeWitnessClips(witness, { kind: 'navigation' }), scope.capture);
  try {
    const afterRows = await renderedDeadline(scope.page.evaluate(collectRenderedNavigationPixelWitness,
      { expectedRows, skipAnimationFrames: true }), afterReadMs);
    const originAfter = await readNativeViewportOrigin(scope.page, RENDERED_VIEWPORT, Math.min(2000, bundle.deadlineAt - now()));
    const composed = await compareNativeWitnessClips({ bundle, rows: witness, afterRows, kind: 'navigation', originAfter, now }, scope.decoder);
    return { witness, composed, receivedAt: now(), diagnosticDomObservedAt };
  } finally {
    // After-DOM/origin failures must zero already-owned native bytes too.
    for (const part of bundle.parts) part.png.fill(0);
  }
}

export function nativeNavigationPaintEvidence(witness, composed, fence, scopeEpoch) {
  assert.equal(composed?.matched, true);
  const points = nativeWitnessPoints(witness, 'navigation');
  assert.ok(points.length > 0 && points.length <= 13 && composed.pixels.length === points.length * 4);
  assert.ok(points.every(point => Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y)));
  assert.ok(composed.pixels.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255));
  return { points: points.map(point => ({ ...point })), pixels: composed.pixels.slice(), fence: structuredClone(fence), scopeEpoch };
}
export function nativeNavigationPaintChanged(previous, witness, composed, fence, scopeEpoch) {
  if (previous?.scopeEpoch !== scopeEpoch || JSON.stringify(previous?.fence) !== JSON.stringify(fence)) return false;
  try {
    const current = nativeNavigationPaintEvidence(witness, composed, fence, scopeEpoch), old = new Map();
    assert.ok(previous.points.length > 0 && previous.points.length <= 13 && previous.pixels.length === previous.points.length * 4);
    for (const [index, point] of previous.points.entries()) {
      const key = point.x + ':' + point.y, rgba = previous.pixels.slice(index * 4, index * 4 + 4);
      if (old.has(key)) assert.deepEqual(old.get(key), rgba);
      old.set(key, rgba);
    }
    return current.points.some((point, index) => nativePixelsCausallyChanged(old.get(point.x + ':' + point.y), current.pixels.slice(index * 4, index * 4 + 4)));
  } catch { return false; }
}
export function actualRenderedNavigationPaintDecision({ runtime, auth, fence, scopeEpoch, isCurrent,
  receivedAt, deadline, expected, witness, composed, previous, round, priorPaint, triggerAt }) {
  if (!isCurrent() || (runtime.scopeEpoch ?? 0) !== scopeEpoch || !renderedRuntimeAuthorityMatches(runtime, auth, fence)
    || !Number.isFinite(receivedAt) || receivedAt > deadline || !composed?.matched
    || !navigationMessageMatches(runtime.realtime.get(expected.studentId), expected, runtime)) return false;
  if (previous) return nativeNavigationPaintChanged(previous, witness, composed, fence, scopeEpoch);
  return round === 1 && runtime.priorStripAbsent && priorPaint.changed(runtime.actor.teacherId,
    { witness, composed, provenance: fence, triggerAt });
}

export function retainActualRenderedCaptureEvidence(runtime, result, visible) {
  const { age, card, after, composed } = result || {};
  if (!visible || !result?.authorized || !card?.displayed || !card.decoded
    || !composed?.matched || !after || !Array.isArray(composed.rgba) || composed.rgba.length !== 4
    || !composed.rgba.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)) return;
  const previous = runtime.lastPaints.get(result.studentId);
  const opaque = !composed.transitioned && card.opacity >= 1 && after.opacity >= 1;
  if (!Number.isFinite(age) || !opaque) {
    // An authorized, matched native fade is physical evidence, even when it
    // cannot identify one opaque frame. Never attach a frame or fresh age to
    // that baseline. Retiring the old frame prevents repeated fixture colours
    // from being compared forever against an unrelated, expired frame.
    if (!previous?.rgba || nativePixelsCausallyChanged(previous.rgba, composed.rgba) || !opaque && previous?.frame)
      runtime.lastPaints.set(result.studentId, { frame: null, rgba: composed.rgba, absent: false });
  } else if (sameFrame(previous?.frame, card.frame) || previous?.nativeAbsence === true
    || nativePixelsCausallyChanged(previous?.rgba, composed.rgba)) {
    runtime.lastPaints.set(result.studentId, { frame: card.frame, rgba: composed.rgba, absent: false });
  }
  return runtime.lastPaints.get(result.studentId);
}

export function updateActualRenderedCaptureBinding(runtime, studentId, bindingVersion, invalidatePrior) {
  if (runtime.bindings.get(studentId) !== bindingVersion) {
    runtime.frames.delete(studentId);
    runtime.lastPaints.delete(studentId);
    invalidatePrior(); runtime.priorStripAbsent = false;
  }
  runtime.bindings.set(studentId, bindingVersion);
}

// Reuse the one pre-start native screenshot as an anonymous physical baseline.
// Missing images/bindings remain UNKNOWN; this never establishes frame age.
export async function warmActualRenderedCaptureBaseline(runtime, scope, { auth, runId,
  now = () => performance.now(), nowWall = () => Date.now() }) {
  const beganAt = now(), deadlineAt = beganAt + 8000, epoch = runtime.scopeEpoch ?? 0;
  let lastNow = beganAt, png;
  const snapshot = () => {
    const actor = runtime.actor, wall = nowWall(), expiresAt = Math.min(Date.parse(actor.expiresAt), Date.parse(auth.expiresAt), Date.parse(auth.deviceManifestExpiresAt));
    assert.equal(actor.role, 'teacher'); assert.equal(actor.schoolId, auth.schoolId);
    assert.ok(runtime.subscribed && Number.isSafeInteger(runtime.socketGeneration) && runtime.socketGeneration > 0);
    assert.ok(Number.isFinite(expiresAt) && Number.isFinite(wall) && wall < expiresAt);
    assert.ok(actor.studentIds.every(id => runtime.allowed.has(id)));
    return JSON.stringify({ actorId: actor.teacherId, runId, schoolId: actor.schoolId, teachingSessionId: actor.teachingSessionId,
      socketGeneration: runtime.socketGeneration, studentIds: actor.studentIds, expiresAt,
      bindings: actor.studentIds.map(id => [id, typeof runtime.bindings.get(id) === 'string' ? runtime.bindings.get(id) : null]) });
  };
  const fence = snapshot();
  const remaining = () => {
    const at = now(); assert.ok(Number.isFinite(at) && at >= lastNow && at < deadlineAt, 'Whole native warm deadline exceeded'); lastNow = at;
    assert.ok(scope.isCurrent() && (runtime.scopeEpoch ?? 0) === epoch && snapshot() === fence, 'Native warm authority changed');
    return deadlineAt - at;
  };
  const read = async argument => {
    const budget = remaining(), value = await renderedDeadline(scope.page.evaluate(collectRenderedDashboardSample, argument), budget);
    remaining(); return value;
  };
  const exactCards = sample => Array.isArray(sample?.cards) && sample.cards.length === runtime.actor.studentIds.length
    && new Set(sample.cards.map(card => card.studentId)).size === sample.cards.length
    && sample.cards.every(card => runtime.actor.studentIds.includes(card.studentId));
  for (const id of runtime.actor.studentIds) runtime.lastPaints.set(id, { frame: null, rgba: null, absent: false });
  try {
    const before = await read();
    await readNativeViewportOrigin(scope.page, RENDERED_VIEWPORT, Math.min(2000, remaining())); remaining();
    const captureBudget = remaining(); png = await scope.capture.capture(scope.page, RENDERED_VIEWPORT, null, captureBudget); remaining();
    const after = await read({ skipAnimationFrames: true });
    await readNativeViewportOrigin(scope.page, RENDERED_VIEWPORT, Math.min(2000, remaining())); remaining();
    const compositorSha256 = hash(png); remaining();
    runtime.priorCompositorSha256 = compositorSha256;
    if (!before.visible || !after.visible || !exactCards(before) || !exactCards(after)) return { seeded: 0, compositorSha256 };
    const pixels = await compareRenderedCapturePaint({ png, cards: before.cards, afterCards: after.cards }, {
      run: (bytes, viewport, sample) => scope.decoder.run(bytes, viewport, sample, remaining()),
    });
    remaining();
    const seeds = [];
    for (const composed of pixels) {
      const card = before.cards.find(row => row.studentId === composed.studentId), afterCard = after.cards.find(row => row.studentId === composed.studentId);
      const binding = runtime.bindings.get(composed.studentId), contributors = composed.contributors ?? [];
      if (typeof binding !== 'string' || !binding.length || !composed.matched || composed.transitioned
        || !card?.displayed || !afterCard?.displayed || !card.decoded || !afterCard.decoded
        || !sameFrame(card.frame, afterCard.frame)
        || (card.previousFrame || afterCard.previousFrame) && !sameFrame(card.previousFrame, afterCard.previousFrame)
        || !contributors.length || !contributors.every(frame => renderedCaptureFrameAuthorized(frame, runtime.frames.get(composed.studentId)))
        || !Array.isArray(composed.rgba) || composed.rgba.length !== 4
        || !composed.rgba.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)) continue;
      seeds.push([composed.studentId, { frame: null, rgba: composed.rgba.slice(), absent: false }]);
    }
    remaining();
    for (const [studentId, value] of seeds) runtime.lastPaints.set(studentId, value);
    return { seeded: seeds.length, compositorSha256 };
  } finally { png?.fill(0); }
}

export async function runActualRenderedCapturePhases({ actors, startAt, endAt, observe, account, stopped = () => false,
  now = () => performance.now(), pause = delay, diagnostics }) {
  const phases = nativeObservationPhases(startAt, Math.ceil((endAt - startAt) / 5000));
  const pending = new Set();
  const plannedStudents = new Map(actors.map(runtime => [runtime, Object.freeze(runtime.actor.studentIds.slice())]));
  const counters = { plannedPhases: phases.length, plannedTargets: phases.length * actors.reduce((sum, runtime) => sum + plannedStudents.get(runtime).length, 0),
    enqueued: 0, missedPhases: 0, failedOwnerAttempts: 0, completedTargets: 0 };
  // Every planned target is declared before any queue or browser operation.
  for (const runtime of actors) account(runtime, null, { plannedOnly: true, count: phases.length * plannedStudents.get(runtime).length, studentIds: plannedStudents.get(runtime) });
  const launch = (runtime, plannedAt) => {
    const deadlineAt = Math.min(plannedAt + 5000, endAt);
    let operation;
    const ownerStartedAt = diagnostics ? now() : null;
    try { operation = runtime.owner.observe(scope => observe(runtime, scope, deadlineAt), { kind: 'capture' }); }
    catch (error) { operation = Promise.reject(error); }
    counters.enqueued++;
    const settled = Promise.resolve(operation).then(value => {
      const timely = !stopped() && value && now() < deadlineAt;
      account(runtime, timely ? value : null, { plannedAt, deadlineAt, studentIds: plannedStudents.get(runtime),
        diagnosticReason: timely ? null : 'late-or-empty-attempt' });
      counters.completedTargets += plannedStudents.get(runtime).length;
    }, () => {
      counters.failedOwnerAttempts++;
      account(runtime, null, { plannedAt, deadlineAt, studentIds: plannedStudents.get(runtime), diagnosticReason: 'owner-failure' });
      counters.completedTargets += plannedStudents.get(runtime).length;
    });
    pending.add(settled); settled.finally(() => {
      pending.delete(settled); if (diagnostics) diagnostics.timing('owner-attempt', now() - ownerStartedAt);
    }).catch(() => {});
  };
  for (const plannedAt of phases) {
    if (!stopped()) await pause(Math.max(0, plannedAt - now()));
    if (stopped() || now() >= Math.min(plannedAt + 5000, endAt)) {
      counters.missedPhases++;
      for (const runtime of actors) { account(runtime, null, { plannedAt, deadlineAt: Math.min(plannedAt + 5000, endAt), studentIds: plannedStudents.get(runtime), diagnosticReason: 'missed-phase' }); counters.completedTargets += plannedStudents.get(runtime).length; }
    } else for (const runtime of actors) launch(runtime, plannedAt);
  }
  return { counters, whenSettled: async () => {
    await Promise.allSettled([...pending]);
    assert.equal(counters.completedTargets, counters.plannedTargets);
    return counters;
  } };
}
export function observeRenderedCommandUpdate(runtime, message, observedAt) {
  if (message?.type !== 'classpilot-command-update') return false;
  const command = message.command;
  if (command?.teacherId !== runtime.actor.teacherId || command.teachingSessionId !== runtime.actor.teachingSessionId) return false;
  const id = message.commandId || command.id;
  if (typeof id !== 'string' || !Array.isArray(command.targets)) return false;
  let observed = runtime.commands.get(id);
  if (!observed) {
    observed = new Map(); runtime.commands.set(id, observed);
    if (runtime.commands.size > 32) runtime.commands.delete(runtime.commands.keys().next().value);
  }
  for (const target of command.targets) {
    if (!runtime.allowed.has(target.studentId)) return true;
    const timing = observed.get(target.studentId) || {};
    if ((target.receivedAt || ['received', 'completed'].includes(target.status)) && timing.receivedAt === undefined) timing.receivedAt = observedAt;
    if (target.status === 'completed' && timing.completedAt === undefined) timing.completedAt = observedAt;
    observed.set(target.studentId, timing);
  }
  return false;
}

export function renderedAgeHistogram() {
  const bounds = [5000, 10000, 15000, 30000, Infinity], counts = bounds.map(() => 0);
  let total = 0, maximum = 0;
  return { observe(age) { total += 1; maximum = Math.max(maximum, age); counts[bounds.findIndex(bound => age <= bound)] += 1; },
    percentile(percent) { if (!total) return null; let cumulative = 0;
      for (let index = 0; index < bounds.length; index += 1) { cumulative += counts[index]; if (cumulative >= Math.ceil(total * percent / 100)) return Number.isFinite(bounds[index]) ? bounds[index] : maximum; }
      return maximum; }, summary() { return { count: total, boundsMs: bounds.map(bound => Number.isFinite(bound) ? bound : null), counts: [...counts], maxMs: maximum }; } };
}

export function validateRenderedDashboardInputs(auth, count, env = process.env, startAtMs = Date.now()) {
  const profile = reliabilityProfile(count);
  assert.equal(auth.schemaVersion, 2);
  assert.equal(auth.baseUrl, 'https://staging.school-pilot.net');
  assert.equal(env.LOAD_RELIABILITY_STAGING_ORIGIN, auth.baseUrl);
  assert.equal(loadSessionCookieName(env), 'schoolpilot.staging.sid');
  assert.equal(auth.teacherAuth?.length, profile.classrooms);
  const ids = auth.teacherAuth.flatMap(actor => actor.studentIds);
  assert.equal(ids.length, count);
  assert.equal(new Set(ids).size, count);
  assert.equal(new Set(auth.teacherAuth.map(actor => actor.teacherId)).size, profile.classrooms);
  assert.equal(new Set(auth.teacherAuth.map(actor => actor.teachingSessionId)).size, profile.classrooms);
  const until = startAtMs + profile.durationSeconds * 1000 + 60_000;
  assert.ok(Date.parse(auth.deviceManifestExpiresAt) > until && Date.parse(auth.expiresAt) > until);
  for (const actor of auth.teacherAuth) {
    assert.ok(actor.role === 'teacher' && actor.schoolId === auth.schoolId && actor.teacherId && actor.teachingSessionId);
    assert.equal(actor.studentIds.length, profile.studentsPerClass);
    assert.ok(hasLoadSessionCookie(actor.teacherCookie, 'schoolpilot.staging.sid') && actor.csrfToken && actor.teacherToken);
    assert.ok(Date.parse(actor.expiresAt) > until);
  }
  return profile;
}

export function validateRenderedManifest(authBytes, manifest, primaryDevices, startAt, now = Date.now()) {
  assert.equal(manifest.files?.auth?.bytes, authBytes.length, 'Rendered auth byte count must match the fleet manifest');
  return validateStagingRunManifest(manifest, { startAt: startAt === undefined ? manifest.startAt : startAt,
    primaryDevices, authSha256: hash(authBytes) }, now);
}

export function renderedCommandRequestPath(pathname) {
  return pathname === '/api/commands' || pathname === '/api/classpilot/commands';
}

export function renderedCommandMatches(request, actor, commandUrl) {
  if (request?.teachingSessionId !== actor.teachingSessionId || request.commandType !== 'open-tab'
    || request.commandPayload?.url !== commandUrl || 'deviceId' in request || 'deviceIds' in request) return false;
  if (request.targetScope === 'class') return !('targetStudentIds' in request) && !('subgroupId' in request);
  const targets = request.targetStudentIds;
  return request.targetScope === 'students' && Array.isArray(targets) && targets.length === actor.studentIds.length
    && new Set(targets).size === targets.length && targets.every(id => actor.studentIds.includes(id)) && !('subgroupId' in request);
}

function assetHashes(directory, relative = '') {
  return readdirSync(join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = join(relative, entry.name);
    return entry.isDirectory() ? assetHashes(directory, name)
      : [{ path: '/' + name.replaceAll('\\', '/'), sha256: hash(readFileSync(join(directory, name))) }];
  });
}

export async function acceptActualRenderedMeasurementReady({channel,waiting,expected,startAt,nowWall=Date.now}) {
  validateMeasurementWaiting(waiting,expected,{startAt,mode:'workload',now:nowWall()});
  // Exactly one lookup of the previously accepted producer publication. A
  // missing/denied object is an invalid preparation, never positive readiness.
  const value=await channel.read('measurement-ready.json');
  validateMeasurementReadySignal(value,expected,waiting,nowWall());return value;
}
export async function awaitActualRenderedCausalSignal({channel,waiting,expected,name,kind,nonce,deadline,
  now=()=>performance.now(),nowWall=Date.now,sleep=milliseconds=>delay(milliseconds),stopped=()=>false,onRead=()=>{}}) {
  assert.ok(['measurement-started.json','measurement-drained.json'].includes(name));
  while(now()<deadline&&!stopped()) {
    try{
      const value=await channel.read(name,{kind,nonce});onRead();
      if(value?.kind==='classpilot-measurement-pending-v1')validateMeasurementPendingSignal(value,expected,waiting,name==='measurement-started.json'?'started':'drained',nowWall());
      else{validateMeasurementSignal(value,expected,kind,nonce);const observedAt=now();assert.ok(observedAt<deadline&&!stopped(),'Causal signal arrived after its deadline');return observedAt;}
    }catch(error){
      const status=error?.$metadata?.httpStatusCode;
      if(status===403||status===404||error?.name==='NoSuchKey'||error?.name==='AccessDenied')throw error;
      if(!measurementOperationRetryable(error))throw error;
    }
    await sleep(50);
  }
  throw Error('Causal signal deadline exceeded');
}
export async function runRenderedDashboards(arguments_ = process.argv.slice(2)) {
  const { values } = parseArgs({ args: arguments_, options: { config: { type: 'string' }, auth: { type: 'string' },
    output: { type: 'string' }, devices: { type: 'string' }, 'frontend-dist': { type: 'string' },
    'input-manifest': { type: 'string' }, 'device-manifest': { type: 'string' }, 'start-at': { type: 'string' },'measurement-waiting':{type:'string'},
    'chrome-path': { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) return console.log('Usage: node scripts/load/run-classpilot-rendered-dashboards.mjs --config <external-staging-config> --auth <selected-private-auth> --input-manifest <exact-remote-input-manifest> --measurement-waiting <exact-protected-startup-body> --output <fresh-private-dir> --devices40|500|800 --frontend-dist <exact-candidate-dist> [--start-at <matching-manifest-UTC>] [--chrome-path <Chrome>] [--dry-run]. Loads real authenticated dashboards before the shared UTC start barrier. No mock API or shortened staging duration.');
  assert.ok(values.config && values.auth && values.output && values.devices && values['frontend-dist'] && values['input-manifest'] && values['device-manifest']&&values['measurement-waiting']);
  const paths = assertExternalPaths(values.config, values.output);
  const authPath = assertExternalPaths(values.auth, paths.outputPath).configPath;
  const manifestPath = assertExternalPaths(values['input-manifest'], paths.outputPath).configPath;
  const config = loadExternalConfig(paths.configPath);
  assert.equal(config.syntheticStaging, true);
  assert.equal(config.reliabilityDeviceCount, Number(values.devices));
  const authBytes = readFileSync(authPath), auth = JSON.parse(authBytes.toString('utf8'));
  const inputManifestBytes = readFileSync(manifestPath);
  const manifest = validateRenderedManifest(authBytes, JSON.parse(inputManifestBytes.toString('utf8')),
    Number(values.devices), values['start-at']);
  assert.equal(manifest.renderedControllerSha256, hash(readFileSync(fileURLToPath(import.meta.url))), 'Exact declared real rendered controller bytes required');
  const profile = validateRenderedDashboardInputs(auth, Number(values.devices), process.env, Date.parse(manifest.startAt));
  const devicePath = assertExternalPaths(values['device-manifest'], paths.outputPath).configPath;
  const deviceBytes = readFileSync(devicePath), privateDevices = JSON.parse(deviceBytes);
  assert.equal(deviceBytes.length, manifest.files.devices.bytes); assert.equal(hash(deviceBytes), manifest.files.devices.sha256);
  assert.equal(privateDevices.length, profile.primaryDevices + 10);
  const primaryDevices = privateDevices.slice(10), publicBindings = new Map(primaryDevices.map(device => [device.studentId, publicBindingFromDevice(device)]));
  assert.equal(publicBindings.size, profile.primaryDevices);
  assert.ok(primaryDevices.every(device => device.schoolId === auth.schoolId));
  const measurementContext = measurementExpected(manifest, hash(inputManifestBytes));
  const waitingPath=assertExternalPaths(values['measurement-waiting'],paths.outputPath).configPath;
  const waiting=validateMeasurementWaiting(JSON.parse(readFileSync(waitingPath,'utf8')),measurementContext,{startAt:manifest.startAt,mode:'workload'});
  const startupGate=new MeasurementStartupGate(measurementContext,{startAt:manifest.startAt,mode:'workload'});startupGate.acceptWaiting(waiting);
  const dist = resolve(values['frontend-dist']);
  assert.ok(existsSync(join(dist, 'index.html')));
  const assets = assetHashes(dist).sort((first, second) => first.path.localeCompare(second.path));
  const expectedAssets = new Map(assets.filter(asset => /\.(?:js|css)$/.test(asset.path)).map(asset => [asset.path, asset.sha256]));
  assert.ok(expectedAssets.size > 0);
  if (values['dry-run']) return console.log(JSON.stringify({ operation: 'rendered-browser-preflight', profile,
    runId: manifest.runId, plannedStartAt: manifest.startAt, candidateAssetCount: expectedAssets.size,
    browserPaintValidated: false, managedDevicesValidated: false, productionAccepted: false }));
  preparePrivateOutputDirectory(paths.outputPath);
  assert.equal(existsSync(join(paths.outputPath, 'rendered-summary.json')), false, 'Fresh browser evidence required');
  const { chromium } = createRequire(join(root, 'schoolpilot-app/package.json'))('playwright');
  const chrome = values['chrome-path'] || process.env.CLASSPILOT_CHROME_PATH || chromium.executablePath();
  assert.ok(existsSync(chrome), 'Real Chrome/Chromium executable required');
  let startedAt = null, startedMonotonic = null, endMonotonic = null, barrier = null;
  const counters = { samples: 0, unavailable: 0, wrongClass: 0, wrongBinding: 0, hidden: 0,
    httpErrors: 0, pageErrors: 0, assetMismatch: 0, commandRequested: 0, commandCompletedWithin5s: 0,
    commandReceivedWithin2s: 0, commandTargets: 0, commandScopeMismatch: 0, crossOriginSockets: 0,
    sampleRounds: 0, slowSampleRounds: 0, measurementScopeErrors: 0, bootstrapApiReads: 0,
    controlPutAttempts: 0, controlGetAttempts: 0, controlBytes: 0, pulseSkipped: 0, navigationObserved: 0,
    finalUnsubscribed: 0, finalNotLive: 0, connectionDenials: 0 };
  const ages = renderedAgeHistogram(), actors = [], loadedAssets = new Set(), knownCaptureBindings = new Set();
  const captureDiagnostics = createRenderedCaptureDiagnostics();
  const navigationDiagnostics = createRenderedNavigationDiagnostics();
  const pulseController = new CapturePulseController(measurementContext, { now: () => performance.now() });
  const measurementChannel=createMeasurementArtifactChannel({role:'controller',expected:measurementContext,devices:privateDevices,startAt:manifest.startAt,startup:waiting});
  let controlStopped = false, publicationLoop = null, bootstrapSha = null, drainNonce = null,
    causalStartUpperMs = null, causalStartPassed = false, bootstrapComplete = false;
  const navigationSamples = [], navigationDevices = new Set(), navigationTasks = [], navigationPixels = new Map(), navigationRoundsAttempted = new Set();
  const observerRuntime = createActualRenderedObserverRuntime({ maximumOwners: profile.classrooms });
  const observerPool = observerRuntime.warm;
  const priorPaint = createNativePriorPaintStore({ maxSnapshots: profile.classrooms, memoryBudget: observerRuntime.memoryBudget });
  let priorPreparation = null, priorPreparationDone = false, priorPreparationFailed = false, priorPeakRssBytes = 0,
    capturePhases = null, finalSummary = null, cleanupProof = null;
  const priorProvenance = runtime => renderedRuntimeAuthoritySnapshot(runtime, auth, manifest.runId);
  const stripAbsent = (runtime, page) => renderedDeadline(page.evaluate(ids => document.visibilityState === 'visible'
    && document.querySelectorAll('[data-testid^="card-student-"]').length === ids.length
    && ids.every(id => document.querySelector('[data-testid="card-student-' + CSS.escape(id) + '"]')
      && !document.querySelector('[data-testid="tab-favicon-' + CSS.escape(id) + '-0"]')), runtime.actor.studentIds), 2000);
  const syncMeasurementCounters=()=>{const value=measurementChannel.summary();counters.controlPutAttempts=value.publishAttempts;counters.controlGetAttempts=value.readAttempts;counters.controlBytes=value.bytesWritten+value.bytesRead;counters.controlActualNetworkAttempts=value.actualNetworkAttempts;return value;};
  const putControl=async(name,value)=>{try{if(name==='measurement-control.json')assert.ok(startupGate.control(value));return await measurementChannel.publish(name,value);}finally{syncMeasurementCounters();}};
  const getSignal=(name,kind,nonce,deadline)=>awaitActualRenderedCausalSignal({channel:measurementChannel,waiting,expected:measurementContext,name,kind,nonce,deadline,stopped:()=>interrupted,onRead:syncMeasurementCounters});
  const httpMetrics = new RenderedHttpMetrics({ origin: auth.baseUrl });
  const staticTraffic = { requests: 0, completed: 0, failed: 0, encodedBytes: 0, inFlight: 0 };

  let thrown = false, interrupted = false, phase = 'preparing',timedWindowCompleteBeforeShutdown=false,timedWindowObservedMs=null;
  const barrierAbort = new AbortController();
  const interruption=createRenderedInterruptionEvidence({startAt:()=>startedMonotonic,endAt:()=>endMonotonic,phase:()=>phase});
  const markInterrupted=(source,error)=>{interruption.record(source,error);interrupted=true;barrierAbort.abort();};
  const stop = () => markInterrupted('signal');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  try {
    const identity = await promisify(execFile)('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text', '--region', 'us-east-1'],
      { timeout: 8000, maxBuffer: 1024, windowsHide: true });
    assert.equal(identity.stdout.trim(), measurementContext.account);
    await Promise.all(auth.teacherAuth.map((actor, index) => observerRuntime.setupTeacher({ chromium, executablePath: chrome, index }, async opened => {
      const context = opened.context;
      context.setDefaultTimeout(10_000);
      await context.route('**/*', route => new URL(route.request().url()).origin === auth.baseUrl ? route.continue() : route.abort());
      const pair = actor.teacherCookie.split(';').map(value => value.trim()).find(value => value.startsWith('schoolpilot.staging.sid='));
      await context.addCookies([{ name: 'schoolpilot.staging.sid', value: pair.slice('schoolpilot.staging.sid='.length),
        url: auth.baseUrl, secure: true, httpOnly: true, sameSite: 'Lax' }]);
      await context.addInitScript(schoolId => localStorage.setItem('sp_activeSchoolId', schoolId), actor.schoolId);
      const page = opened.page, frames = new Map(), allowed = new Set(actor.studentIds);
      const runtime = { actor, context, page, owner: opened.owner, browser: opened.browser, frames, allowed, index, initialPaint: false, lastOrdinals: new Map(), freshUpdates: 0,
        bindings: new Map(), commands: new Map(), samples: 0, unavailable: 0, compositorSha256: null,
        publicBindings, realtime: new Map(), baselineRows: new Map(), revisionSeeds: new Map(), socketGeneration: 0, subscribed: false, lastPaints: new Map(), priorStripAbsent: false };
      actors.push(runtime);
      attachRenderedHttpMetrics(page, httpMetrics, index);
      const staticCdp = await context.newCDPSession(page), staticPending = new Set();
      await staticCdp.send('Network.enable');
      staticCdp.on('Network.requestWillBeSent', event => {
        const now = performance.now(); if (startedMonotonic === null || now < startedMonotonic || now >= endMonotonic) return;
        const url = new URL(event.request.url);
        if (url.origin === auth.baseUrl && url.pathname === '/favicon.svg') { staticTraffic.requests += 1; staticTraffic.inFlight += 1; staticPending.add(event.requestId); }
      });
      staticCdp.on('Network.loadingFinished', event => { if (staticPending.delete(event.requestId)) {
        staticTraffic.completed += 1; staticTraffic.inFlight -= 1; staticTraffic.encodedBytes += event.encodedDataLength; } });
      staticCdp.on('Network.loadingFailed', event => { if (staticPending.delete(event.requestId)) { staticTraffic.failed += 1; staticTraffic.inFlight -= 1; } });
      page.on('pageerror', () => { counters.pageErrors += 1; });
      page.on('websocket', socket => {
        const url = new URL(socket.url());
        if (url.protocol !== 'wss:' || url.hostname !== new URL(auth.baseUrl).hostname) counters.crossOriginSockets += 1;
        attachActualRenderedSocketObserver(runtime, socket, {
          invalidatePrior: () => { priorPaint.invalidate(actor.teacherId); for (const id of actor.studentIds) navigationPixels.delete(id); },
          onDenial: () => { counters.connectionDenials++; },
          onStudentScopeError: () => { counters.measurementScopeErrors++; },
          onCommandScopeError: () => { counters.commandScopeMismatch++; }
        });
      });
      page.on('response', async response => {
        let expectedAsset = false;
        try {
          const url = new URL(response.url());
          if (url.origin !== auth.baseUrl) return;
          if (/\.(?:js|css)$/.test(url.pathname) && !expectedAssets.has(url.pathname)) counters.assetMismatch += 1;
          expectedAsset = expectedAssets.has(url.pathname);
          if (expectedAsset) {
            if (response.status() !== 200 || hash(await renderedDeadline(response.body())) !== expectedAssets.get(url.pathname)) counters.assetMismatch += 1;
            else loadedAssets.add(url.pathname);
          }
          if (url.pathname === '/api/students-aggregated' && url.searchParams.get('teachingSessionId') === actor.teachingSessionId && response.ok()) {
            const rows = await renderedDeadline(response.json());
            if (Array.isArray(rows) && rows.length === actor.studentIds.length && rows.every(row => allowed.has(row.studentId))) {
              for (const row of rows) if (row.realtimeBinding === publicBindings.get(row.studentId) && Number.isSafeInteger(row.tabSnapshotRevision)
                && row.tabSnapshotRevision > 0 && row.tabSnapshot?.revision === row.tabSnapshotRevision) runtime.baselineRows.set(row.studentId, { ...row, observedAt: performance.now() });
            }
          }
          if (url.pathname !== '/api/classpilot/tiles/screenshots') return;
          if (!response.ok()) { counters.httpErrors += 1; return; }
          const body = await renderedDeadline(response.json());
          for (const tile of body.tiles || []) {
            if (!allowed.has(tile.studentId)) { counters.wrongClass += 1; continue; }
            updateActualRenderedCaptureBinding(runtime, tile.studentId, tile.bindingVersion, () => priorPaint.invalidate(actor.teacherId));
            if (!tile.screenshot) continue;
            if (!reliabilityScreenshotBindingMatches(tile)) { counters.wrongBinding += 1; continue; }
            const source = tile.screenshot.screenshot;
            const tail = typeof source === 'string' && source.startsWith('data:image/jpeg;base64,') ? Buffer.from(source.split(',')[1], 'base64').subarray(-98, -2).toString('ascii') : '';
            const match = /^CLP_REL_FRAME_V2:(\d{13}):(\d{1,16}):(\d{1,7}):([a-f0-9]{24}):END/.exec(tail);
            const capture = match && { capturedAt: Number(match[1]), ordinal: Number(match[2]), pulseSequence: Number(match[3]), pulseMarker: match[4],
              jpegSha256: hash(Buffer.from(source.split(',')[1],'base64')) };
            if (!capture) continue;
            const recent = (frames.get(tile.studentId) || []).filter(frame => Date.now() - frame.seenAt < 30_000);
            recent.push({ ...capture, seenAt: Date.now() });
            frames.set(tile.studentId, recent.slice(-8));
          }
        } catch { counters.httpErrors += 1; if (expectedAsset) counters.assetMismatch += 1; }
      });
      await page.goto(auth.baseUrl + '/classpilot', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForFunction(expected => document.querySelectorAll('[data-testid^="card-student-"]').length === expected,
        profile.studentsPerClass, { timeout: 60_000 });
      await page.waitForFunction(expected => {
        const ids = [...document.querySelectorAll('[data-testid^="card-student-"]')].map(card => card.getAttribute('data-testid').slice('card-student-'.length));
        return document.visibilityState === 'visible' && ids.length === expected.length && new Set(ids).size === expected.length
          && ids.every(id => expected.includes(id))
          && document.querySelector('[data-testid="badge-connection-status"]')?.textContent.trim() === 'Live updates';
      }, actor.studentIds, { timeout: 30_000 });
    })));
    assert.equal(actors.length, profile.classrooms);
    // Establish prior real compositor state before the shared start. The
    // first causal pulse is then emitted directly at the controller start.
    await Promise.all(actors.map(runtime => observerRuntime.prepareWarm(runtime)(scope =>
      warmActualRenderedCaptureBaseline(runtime, scope, { auth, runId: manifest.runId }))));
    phase = 'start-barrier';
    await acceptActualRenderedMeasurementReady({channel:measurementChannel,waiting,expected:measurementContext,startAt:manifest.startAt});syncMeasurementCounters();startupGate.markReady();
    barrier = await waitForStagingStart({ startAt: manifest.startAt, origin: auth.baseUrl,
      inputCreatedAt: manifest.createdAt, signal: barrierAbort.signal,
      onReady: ready => writeFileSync(join(paths.outputPath, 'rendered-ready.json'), JSON.stringify({ schemaVersion: 1,
        runId: manifest.runId, startAt: manifest.startAt, ...ready,
        classrooms: actors.length, primaryDevices: profile.primaryDevices, candidateFrontendSha256: hash(JSON.stringify(assets)),
        authFileSha256: hash(authBytes), browserPaintValidated: false, managedDevicesValidated: false, productionAccepted: false })) });
    startedAt = Date.parse(barrier.actualStartedAt);
    startedMonotonic = barrier.monotonicStartedAt;
    endMonotonic = startedMonotonic + profile.durationSeconds * 1000;
    httpMetrics.startWindow(startedMonotonic, profile.durationSeconds * 1000);
    const firstPulse = pulseController.issue();
    await putControl('measurement-control.json', firstPulse);
    const startedReceiptAt = await getSignal('measurement-started.json', 'measurement-started-v3', firstPulse.nonce, startedMonotonic + 1000);
    causalStartUpperMs = startedReceiptAt - startedMonotonic;
    assert.ok(causalStartUpperMs <= 1000); causalStartPassed = true;
    const bootstrap = async pulse => {
      const drainEntryAt = performance.now();
      await getSignal('measurement-drained.json', 'measurement-drained-v3', drainNonce, drainEntryAt + 2000);
      await Promise.all(actors.map(async runtime => {
        counters.bootstrapApiReads += 1;
        const rows = await renderedDeadline(runtime.page.evaluate(async ({ sessionId, schoolId }) => {
          const response = await fetch('/api/students-aggregated?teachingSessionId=' + encodeURIComponent(sessionId), { credentials: 'include', headers: { 'x-school-id': schoolId } });
          if (!response.ok) throw Error('Bootstrap authority read unavailable'); return response.json();
        }, { sessionId: runtime.actor.teachingSessionId, schoolId: runtime.actor.schoolId }), 2000);
        assert.ok(Array.isArray(rows) && rows.length === runtime.actor.studentIds.length && new Set(rows.map(row => row.studentId)).size === rows.length);
        for (const row of rows) {
          assert.ok(runtime.allowed.has(row.studentId)); assert.equal(row.realtimeBinding, publicBindings.get(row.studentId));
          assert.ok(Number.isSafeInteger(row.tabSnapshotRevision) && row.tabSnapshotRevision > 0 && row.tabSnapshot?.revision === row.tabSnapshotRevision);
          const latest = runtime.realtime.get(row.studentId);
          if (latest) assert.equal(latest.realtimeBinding, row.realtimeBinding);
          const seed = Math.max(row.tabSnapshotRevision, latest?.tabSnapshotRevision || 0);
          runtime.baselineRows.set(row.studentId, { ...row, tabSnapshotRevision: seed, observedAt: performance.now() });
          assert.equal(runtime.revisionSeeds.has(row.studentId), false, 'Revision seed is immutable');
          runtime.revisionSeeds.set(row.studentId, seed);
        }
      }));
      const value = { schemaVersion: 1, runId: measurementContext.runId, sourceArtifactSha256: measurementContext.sourceArtifactSha256,
        cohortSha256: measurementContext.cohortSha256, planSha256: measurementContext.planSha256,
        revisionBaselines: actors.flatMap(runtime => runtime.actor.studentIds.map(studentId => ({ publicBinding: publicBindings.get(studentId), revisionBase: runtime.revisionSeeds.get(studentId) }))).sort((a,b) => a.publicBinding.localeCompare(b.publicBinding)) };
      validateRevisionBootstrap(value, measurementContext, privateDevices);
      await putControl('measurement-bootstrap.json', value); bootstrapSha = hash(Buffer.from(JSON.stringify(value)));
      const releasePulse = pulseController.issue({ revisionBaselinesSha256: bootstrapSha, revisionDrainNonce: drainNonce });
      await putControl('measurement-control.json', releasePulse);
      assert.ok(performance.now() - drainEntryAt <= 2000, 'Bootstrap drain caller budget'); bootstrapComplete = true;
    };
    const observeRound = async round => {
      navigationRoundsAttempted.add(round);
      const entry = pulseController.navigationHistory.get(round), deadline = entry.t0 + 8000;
      const observed = new Set(), firstReady = new Map();
      while (performance.now() < deadline && observed.size < profile.primaryDevices && !controlStopped) {
        await Promise.allSettled(actors.map(runtime => runtime.owner.observe(async ({ page, capture, decoder, isCurrent }) => {
          const fence = priorProvenance(runtime), scopeEpoch = runtime.scopeEpoch ?? 0;
          const pending = runtime.actor.studentIds.filter(id => !observed.has(id)); if (!pending.length) return;
          const expectedRows = pending.map(studentId => {
            const snapshot = navigationSnapshot({ runId: manifest.runId, round, nonce: entry.nonce }, publicBindings.get(studentId), runtime.revisionSeeds.get(studentId));
            return { ...snapshot, studentId, publicBinding: publicBindings.get(studentId) };
          }).filter(row => {
            const message = runtime.realtime.get(row.studentId), matched = navigationMessageMatches(message, row, runtime);
            const previous = firstReady.get(row.studentId);
            if (matched && (!previous || previous.socketGeneration !== runtime.socketGeneration || previous.scopeEpoch !== scopeEpoch))
              firstReady.set(row.studentId, { socketAt: message.observedAt, ownerAt: performance.now(),
                socketGeneration: runtime.socketGeneration, scopeEpoch });
            return matched;
          });
          if (!expectedRows.length) return;
          const painted = await observeActualRenderedNavigationPaint({ page, capture, decoder }, expectedRows);
          if (!painted) return;
          const { witness, composed, receivedAt } = painted;
          for (const row of composed) {
            const expected = expectedRows.find(expected => expected.studentId === row.studentId), previous = navigationPixels.get(row.studentId);
            const currentWitness = witness.find(value => value.studentId === row.studentId);
            if (actualRenderedNavigationPaintDecision({ runtime, auth, fence, scopeEpoch, isCurrent, receivedAt, deadline,
              expected, witness: currentWitness, composed: row, previous, round, priorPaint, triggerAt: entry.t0 })) {
              observed.add(row.studentId); navigationDevices.add(row.studentId);
              navigationPixels.set(row.studentId, nativeNavigationPaintEvidence(currentWitness, row, fence, scopeEpoch));
              navigationSamples.push(receivedAt - entry.t0); counters.navigationObserved += 1;
              navigationDiagnostics.observe({ triggerAt: entry.t0, ...firstReady.get(row.studentId),
                domAt: painted.diagnosticDomObservedAt, proofAt: receivedAt });
            }
          }
        }, { kind: 'navigation' })));
        await delay(50);
      }
      for (let count = observed.size; count < profile.primaryDevices; count += 1) navigationSamples.push(Infinity);if(round===1)priorPaint.dispose();
    };
    publicationLoop = (async () => {
      let nextPulseAt = startedMonotonic + 1000;
      while (!controlStopped && !interrupted && performance.now() < endMonotonic) {
        await delay(Math.max(0, nextPulseAt - performance.now())); if (controlStopped || interrupted || performance.now() >= endMonotonic) break;
        const elapsed = performance.now() - startedMonotonic;
        if (measurementChannel.summary().publicationInFlight) { counters.pulseSkipped += 1; nextPulseAt += 1000; continue; }
        if (elapsed >= 20000 && !drainNonce) drainNonce = randomBytes(24).toString('hex');
        const round = bootstrapComplete && elapsed >= MEASUREMENT_LIMITS.navigationStartMs && elapsed <= profile.durationSeconds*1000 - 30000
          ? Math.min(profile.measurementPlan.navigationRounds, Math.floor((elapsed - MEASUREMENT_LIMITS.navigationStartMs) / 60000) + 1) : pulseController.navigationRound;
        const previousRound = pulseController.navigationRound;
        if (bootstrapComplete && elapsed >= MEASUREMENT_LIMITS.navigationStartMs - 60000 && !priorPreparation) {
          priorPreparation = Promise.allSettled(actors.map(runtime => observerRuntime.prepareWarm(runtime)(async ({ page, capture, decoder, isCurrent }) => {
            assert.equal(priorPaint.summary().closed, false);
            let png;
            const provenance = priorProvenance(runtime);
            try {
              assert.equal(await stripAbsent(runtime, page), true);
              await readNativeViewportOrigin(page);
              png = await capture.capture(page);
              await readNativeViewportOrigin(page);
              await priorPaint.capture(runtime.actor.teacherId, { png, decoder, provenance });
              png = null;
              assert.equal(isCurrent(), true);
              assert.deepEqual(priorProvenance(runtime), provenance);
              assert.equal(await stripAbsent(runtime, page), true);
              assert.equal(isCurrent(), true);
              priorPeakRssBytes = Math.max(priorPeakRssBytes, process.memoryUsage().rss);
            } catch (error) { png?.fill(0); priorPaint.invalidate(runtime.actor.teacherId); throw error; }
          }))).then(results => { assert.ok(results.every(result => result.status === 'fulfilled'), 'Complete prior native preparation required'); });
          priorPreparation.then(() => { priorPreparationDone = true; }, () => { priorPreparationFailed = true; priorPaint.dispose(); });
          priorPreparation.catch(() => {});
        }
        if (round === 1 && previousRound === 0) {
          if (priorPreparationDone && !priorPreparationFailed) {
            await Promise.allSettled(actors.map(runtime => runtime.owner.observe(async ({ page, isCurrent }) => {
              const provenance = priorProvenance(runtime);
              runtime.priorStripAbsent = await stripAbsent(runtime, page);
              if (!isCurrent() || !runtime.priorStripAbsent || !renderedRuntimeAuthorityMatches(runtime, auth, provenance)) {
                runtime.priorStripAbsent = false;
                priorPaint.invalidate(runtime.actor.teacherId);
              }
            }, { kind: 'prior' })));
          } else { priorPaint.dispose(); for (const runtime of actors) runtime.priorStripAbsent = false; }
        }
        const pulse = pulseController.issue({ navigationRound: round, revisionBaselinesSha256: bootstrapSha, revisionDrainNonce: drainNonce });
        if (round === 1 && previousRound === 0) priorPaint.setTrigger(pulseController.navigationHistory.get(1).t0);
        await putControl('measurement-control.json', pulse);
        if (drainNonce && !bootstrapComplete) await bootstrap(pulse);
        if (round > previousRound) { const task=observeRound(round);task.catch(error=>markInterrupted('navigation',error));navigationTasks.push(task); }
        nextPulseAt += 1000; if (nextPulseAt < performance.now()) nextPulseAt = performance.now();
      }
    })();
    publicationLoop.catch(error => markInterrupted('publication',error));
    phase = 'warming';
    while (!interrupted && performance.now() < startedMonotonic + 60_000) await delay(1000);
    assert.equal(interrupted, false, 'Full campaign required');
    phase = 'classroom-command-burst';
    // All actors use the real candidate UI and submit once, concurrently.
    await Promise.all(actors.map(async ({ page }) => {
      await page.getByTestId('button-open-tab').click();
      await page.getByTestId('input-open-tab-url').fill(config.commandUrl);
    }));
    const burstStartedAt = performance.now(), commandSubmissionTimes = [];
    await Promise.all(actors.map(async runtime => {
      const { page, actor } = runtime;
      const requestPromise = page.waitForRequest(request => renderedCommandRequestPath(new URL(request.url()).pathname)
        && request.method() === 'POST', { timeout: 10_000 }).then(request => { commandSubmissionTimes.push(performance.now()); return request; });
      const responsePromise = page.waitForResponse(response => renderedCommandRequestPath(new URL(response.url()).pathname)
        && response.request().method() === 'POST', { timeout: 10_000 });
      const requestAt = performance.now();
      const [requestEvent, response] = await Promise.all([requestPromise, responsePromise,
        page.getByTestId('button-confirm-open-tab').click()]);
      counters.commandRequested += 1;
      const request = requestEvent.postDataJSON(), body = await renderedDeadline(response.json());
      if (response.status() !== 201 || !renderedCommandMatches(request, actor, config.commandUrl)
        || Number(body.summary?.sent) !== profile.studentsPerClass || !body.command?.id) {
        counters.commandScopeMismatch += 1; return;
      }
      counters.commandTargets += profile.studentsPerClass;
      // Timestamp the issuing teacher's observed socket frames. Poll response
      // arrival and server clocks must not substitute for UI receipt latency.
      while (performance.now() - requestAt < 7000) {
        const observed = runtime.commands.get(body.command.id);
        if (observed?.size === profile.studentsPerClass && [...observed.values()].every(target => target.completedAt !== undefined)) break;
        await delay(100);
      }
      for (const timing of runtime.commands.get(body.command.id)?.values() || []) {
        if (timing.receivedAt >= requestAt && timing.receivedAt - requestAt <= 2000) counters.commandReceivedWithin2s += 1;
        if (timing.completedAt >= requestAt && timing.completedAt - requestAt <= 5000) counters.commandCompletedWithin5s += 1;
      }
    }));
    const concurrentBurstElapsedMs = performance.now() - burstStartedAt;
    phase = 'sampling';
    const sampleStartAt = performance.now();
    capturePhases = await runActualRenderedCapturePhases({ actors, startAt: sampleStartAt, endAt: endMonotonic,
      stopped: () => interrupted || controlStopped, diagnostics: captureDiagnostics,
      observe: (runtime, scope, deadlineAt) => observeActualRenderedCapture(runtime, scope, { auth, runId: manifest.runId,
        publicBindings, pulseController, deadlineAt, diagnostics: captureDiagnostics }),
      account: (runtime, attempt, metadata) => {
        if (metadata.plannedOnly) { counters.samples += metadata.count; runtime.samples += metadata.count; captureDiagnostics.planTargets(metadata.count); return; }
        const authorized = attempt && (runtime.scopeEpoch ?? 0) === attempt.scopeEpoch && renderedRuntimeAuthorityMatches(runtime, auth, attempt.fence);
        if (attempt && !attempt.visible) counters.hidden++;
        if (attempt?.wrongClass) counters.wrongClass++;
        for (const studentId of metadata.studentIds) {
          const result = authorized && attempt.results.find(row => row.studentId === studentId), age = result?.age ?? Infinity;
          ages.observe(age);
          accountRenderedCaptureDiagnostic(captureDiagnostics, attempt, result, authorized, age, metadata);
          const nativePaint = result && retainActualRenderedCaptureEvidence(runtime, result, attempt.visible);
          if (!Number.isFinite(age)) { counters.unavailable++; runtime.unavailable++; continue; }
          knownCaptureBindings.add(publicBindings.get(studentId));
          if (nativePaint?.frame && runtime.lastOrdinals.get(studentId) !== nativePaint.frame.ordinal) { runtime.freshUpdates++; runtime.lastOrdinals.set(studentId, nativePaint.frame.ordinal); }
        }
        if (authorized && !runtime.initialPaint) { runtime.compositorSha256 = attempt.compositorSha256; runtime.initialPaint = true; }
        writeFileSync(join(paths.outputPath, 'rendered-progress.json'), JSON.stringify({ runId: manifest.runId,
          plannedStartAt: manifest.startAt, elapsedSeconds: (performance.now() - startedMonotonic) / 1000,
          classrooms: actors.length, counters, captureDiagnostics: captureDiagnostics.summary(), http: httpMetrics.progress(), p95CaptureAgeMs: ages.percentile(95), p99CaptureAgeMs: ages.percentile(99) }));
      } });
    counters.sampleRounds = capturePhases.counters.plannedPhases;
    while (!interrupted && performance.now() < endMonotonic) await delay(Math.min(1000, endMonotonic - performance.now()));
    timedWindowObservedMs=performance.now()-startedMonotonic;
    timedWindowCompleteBeforeShutdown=!interrupted&&performance.now()>=endMonotonic;
    controlStopped = true;
    await Promise.allSettled(actors.map(runtime => runtime.owner.observe(async ({ page, isCurrent }) => {
      const generation = runtime.socketGeneration, subscribed = runtime.subscribed;
      const actual = await renderedDeadline(page.evaluate(() => ({ visible: document.visibilityState === 'visible',
        live: document.querySelector('[data-testid="badge-connection-status"]')?.textContent.trim() === 'Live updates' })));
      if (!isCurrent() || !subscribed || !runtime.subscribed || generation !== runtime.socketGeneration) counters.finalUnsubscribed++;
      if (!actual.visible || !actual.live) counters.finalNotLive++;
    }, { kind: 'prior' }).catch(() => { counters.finalNotLive++; })));
    // No unlaunched navigation round or target can disappear from evidence.
    for (let round = 1; round <= profile.measurementPlan.navigationRounds; round++) {
      if (!navigationRoundsAttempted.has(round)) for (let index = 0; index < profile.primaryDevices; index++) navigationSamples.push(Infinity);
    }
    httpMetrics.closeWindow();
    await drainRenderedPublicationBeforeClose({publicationLoop,close:()=>measurementChannel.close(),onFailure:error=>markInterrupted('publication-drain',error)});
    priorPaint.dispose();
    cleanupProof = await observerRuntime.close({ extraDrains: [publicationLoop?.catch(() => {}),
      Promise.allSettled(navigationTasks), priorPreparation?.catch(() => {}), capturePhases?.whenSettled()].filter(Boolean) });
    const measuredDurationMs = performance.now() - startedMonotonic;
    phase = 'draining-http-evidence';
    await httpMetrics.drain();
    const http = httpMetrics.summary();
    const failures = [];
    const navigation = navigationGate(navigationSamples, { planned: profile.primaryDevices * profile.measurementPlan.navigationRounds,
      primaryDevices: profile.primaryDevices, observedDevices: navigationDevices.size, scopeErrors: counters.measurementScopeErrors });
    const navigationLatencyPassed = navigation.passed && bootstrapComplete;
    const causalCaptureFreshnessPassed = causalStartPassed && ages.summary().count === counters.samples && knownCaptureBindings.size === profile.primaryDevices
      && counters.samples > 0 && counters.unavailable/counters.samples <= .01 && (ages.percentile(95) ?? Infinity) <= 10000 && (ages.percentile(99) ?? Infinity) <= 15000;
    if (!causalStartPassed) failures.push('unproven causal paired-start bound');
    if (!navigationLatencyPassed) failures.push('missing or failing V3 navigation latency proof');
    if (!causalCaptureFreshnessPassed) failures.push('missing or failing V3 causal capture freshness proof');
    if(counters.finalUnsubscribed||counters.finalNotLive||counters.connectionDenials)failures.push('final exact subscription or rendered connection health failed');
    if (interrupted || performance.now() < endMonotonic) failures.push('full-duration campaign interrupted');
    if (actors.some(runtime => runtime.samples < profile.studentsPerClass * Math.floor((profile.durationSeconds - 90) / 5))) failures.push('rendered sample underrun');
    if (!counters.samples || counters.unavailable / counters.samples > 0.01) failures.push('more than1% rendered frames unavailable');
    if ((ages.percentile(95) ?? Infinity) > 10_000 || (ages.percentile(99) ?? Infinity) > 15_000) failures.push('rendered capture age exceeds p95=10s or p99=15s');
    if (counters.wrongClass || counters.wrongBinding || counters.commandScopeMismatch || counters.hidden || counters.assetMismatch
      || counters.pageErrors || counters.crossOriginSockets || !loadedAssets.size || actors.some(runtime => !runtime.compositorSha256)) failures.push('isolation, visibility, candidate asset or runtime error');
    if (counters.commandRequested !== profile.classrooms || counters.commandTargets !== profile.primaryDevices
      || counters.commandReceivedWithin2s / profile.primaryDevices < 0.99 || counters.commandCompletedWithin5s / profile.primaryDevices < 0.99) failures.push('concurrent UI command receipt/completion gate');
    const commandDispatchSpreadMs = Math.max(...commandSubmissionTimes) - Math.min(...commandSubmissionTimes);
    if (commandSubmissionTimes.length !== profile.classrooms || commandDispatchSpreadMs > 1000) failures.push('UI command dispatches did not form a one-second concurrent classroom burst');
    if (!http.allStartedRequestsMeasured || http.rawInFlightAfterDrain || http.counters.http403 || http.counters.http429
      || http.counters.otherHttpErrors) failures.push('incomplete or blocked browser API request evidence');
    if (!renderedHttpEndpointClassificationComplete(http)) failures.push('browser HTTP endpoint classification incomplete');
    if (!http.counters.requestsStarted || http.counters.failedMeasurements / http.counters.requestsStarted > 0.01) failures.push('browser API measurement failure rate exceeds one percent');
    for (const endpoint of ['GET /api/classpilot/commands/active-state', 'GET /api/classpilot/teacher/raised-hands']) {
      const latency = http.fineEndpointLatency.endpoints[endpoint];
      if (!latency?.p95Bounds.complete || !latency.p95Bounds.finite || latency.p95Bounds.upperMs > 1000) failures.push('classroom state or raised-hands p95 exceeds one second or is unmeasured');
      if (!latency?.count || latency.failedCount / latency.count > 0.01) failures.push('classroom state or raised-hands failure rate exceeds one percent');
      const counts = http.endpointRequestsPerActor[endpoint];
      if (!counts || actors.some(runtime => counts[runtime.index] < Math.max(1, Math.floor((profile.durationSeconds - 90) / 35)))) failures.push('classroom state or raised-hands read sample underrun');
    }
    const summary = { schemaVersion: 1, workload: profile.version, endpointShapeSha256: RELIABILITY_ENDPOINT_SHA256,
      runId: manifest.runId, startAt: manifest.startAt, candidateApiImage: manifest.candidateApiImage,
      inputManifestSha256: hash(inputManifestBytes), renderedControllerSha256: manifest.renderedControllerSha256,
      controllerDependencyClosure: RENDERED_CONTROLLER_DEPENDENCY_EVIDENCE,
      startBarrier: barrier, utcSkewDiagnosticOnly: true, measuredDurationMs, http, navigationStaticTraffic: staticTraffic,
      browser: actors[0]?.browser.version() ?? 'unavailable', startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
      durationSeconds: profile.durationSeconds, primaryDevices: profile.primaryDevices, classrooms: profile.classrooms,
      candidateFrontendSha256: hash(JSON.stringify(assets)), verifiedLoadedAssets: loadedAssets.size,
      viewport: RENDERED_VIEWPORT, commandTimingBasis: 'issuing-teacher-observed-websocket-frame-from-UI-click',
      classroomSamples: actors.sort((left, right) => left.index - right.index).map(runtime => ({ samples: runtime.samples,
        unavailable: runtime.unavailable, compositorSha256: runtime.compositorSha256 })),
      workloadVersion: profile.version, navigationLatencyPassed, causalCaptureFreshnessPassed, causalStartPassed,
      causalStartUpperMs, navigation, measurement: { revisionBootstrapComplete: bootstrapComplete, planSha256: manifest.measurementPlanSha256,
        controlPutAttempts: counters.controlPutAttempts, controlGetAttempts: counters.controlGetAttempts,
        actualS3NetworkAttempts: counters.controlActualNetworkAttempts, controlRead: measurementChannel.summary().reader, controlPublication:measurementChannel.summary().publisher, controlBytes: counters.controlBytes,
        bootstrapApiReads: counters.bootstrapApiReads, pulseSkipped: counters.pulseSkipped, observer: observerPool.summary() },
      nativePriorPaint:{...priorPaint.summary(),peakNodeRssBytes:priorPeakRssBytes,preparationComplete:priorPreparationDone,preparationFailed:priorPreparationFailed},nativeWitnessSampling:'all-original-points-unscaled-bounding-native-roi-v1',nativePixelDecoder:observerRuntime.summary().decoders,nativeCompositorCapture:observerRuntime.summary().captures,finalConnectionHealthPassed:!counters.finalUnsubscribed&&!counters.finalNotLive&&!counters.connectionDenials,
      counters, captureAge: { timingBasis: 'controller-monotonic-causal-pulse-upper-bound', knownPulseBindings: knownCaptureBindings.size,
        expectedAttempts: counters.samples, allExpectedAttemptsAccounted: ages.summary().count === counters.samples, unknownAttempts: counters.unavailable,
        ...ages.summary(), p95Ms: ages.percentile(95), p99Ms: ages.percentile(99) },
      minimumFreshUpdatesPerClassroom: Math.min(...actors.map(runtime => runtime.freshUpdates)),
      concurrentBurstElapsedMs, commandDispatchSpreadMs, browserPaintValidated: failures.length === 0,
      managedDevicesValidated: false, productionAccepted: false, failures };
    finalSummary = summary;

  } catch { thrown = true; throw new Error('Rendered dashboard campaign failed; no private response details emitted'); }
  finally {
    controlStopped = true;
    measurementChannel.close();
    priorPaint.dispose();
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop);
    const drains = [publicationLoop?.catch(() => {}), Promise.allSettled(navigationTasks), priorPreparation?.catch(() => {}), capturePhases?.whenSettled()].filter(Boolean);
    cleanupProof = await observerRuntime.close({ extraDrains: drains });
    syncMeasurementCounters();
    if (!finalSummary) finalSummary = { browserPaintValidated: false, productionAccepted: false,
      managedDevicesValidated: false, failurePhase: phase, counters, http: httpMetrics.summary(), failures: ['incomplete rendered dashboard campaign'] };
    // Final accounting and acceptance happen only after exact owned closure and
    // true raw settlement. Provisional pre-cleanup success is never published.
    finalSummary.observerRuntime = observerRuntime.summary();
    finalSummary.cleanup = cleanupProof;
    finalSummary.plannedCapture = capturePhases?.counters ?? null;
    finalSummary.captureDiagnostics = captureDiagnostics.summary();
    finalSummary.navigationDiagnostics = navigationDiagnostics.summary();
    finalSummary.interruption=interruption.summary();
    finalSummary.timedWindowCompleteBeforeShutdown=timedWindowCompleteBeforeShutdown;
    finalSummary.timedWindowObservedMs=timedWindowObservedMs;
    finalSummary.controllerRssBytes = process.memoryUsage().rss;
    finalSummary.binaryBudgetScope = 'native PNG/raw decode/prior RGBA only; excludes Chrome, RPC/base64 and DOM cache RSS';
    if (!cleanupProof.passed) finalSummary.failures.push('owned browser closure or true raw measurement settlement incomplete');
    if (capturePhases && ages.summary().count !== capturePhases.counters.plannedTargets) finalSummary.failures.push('all planned capture targets were not accounted');
    finalSummary.browserPaintValidated = !thrown && finalSummary.failures.length === 0 && cleanupProof.passed;
    writeFileSync(join(paths.outputPath, 'rendered-summary.json'), JSON.stringify(finalSummary));
    console.log(JSON.stringify({ operation: 'rendered-browser-finished', classrooms: profile.classrooms,
      browserPaintValidated: finalSummary.browserPaintValidated, failures: finalSummary.failures }));
    if (!finalSummary.browserPaintValidated) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRenderedDashboards().catch(() => { console.error('[rendered-dashboards] Refused or failed; private credentials and responses omitted'); process.exitCode = 1; });
}
