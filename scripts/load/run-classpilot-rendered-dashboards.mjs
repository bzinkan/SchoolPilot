import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createMeasurementArtifactChannel } from './run-classpilot-remote-generator.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { assertExternalPaths, loadExternalConfig, preparePrivateOutputDirectory } from './prepare-classpilot-load-test.mjs';
import { hasLoadSessionCookie, loadSessionCookieName } from './session-cookie.mjs';
import { reliabilityProfile, reliabilityScreenshotBindingMatches, RELIABILITY_ENDPOINT_SHA256,
  CapturePulseController, measurementExpected, publicBindingFromDevice, validateRevisionBootstrap,
  observeRenderedStudentState, navigationSnapshot, navigationMessageMatches, navigationGate,
  collectNavigationPixelWitness, validateMeasurementSignal, MEASUREMENT_LIMITS, createBoundedObserverPool } from './classpilot-reliability-profile.mjs';
import { readReliabilityFrame } from './reliability-rendered-frame.mjs';
import { validateStagingRunManifest, waitForStagingStart } from './staging-start-barrier.mjs';
import { RenderedHttpMetrics, attachRenderedHttpMetrics } from './rendered-http-metrics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const RENDERED_VIEWPORT = Object.freeze({ width: 1920, height: 4320 });

export async function renderedDeadline(operation, milliseconds = 8000) {
  const controller = new AbortController();
  const timeout = delay(milliseconds, null, { signal: controller.signal, ref: false })
    .then(() => { throw new Error('Rendered instrumentation deadline exceeded'); });
  try { return await Promise.race([operation, timeout]); }
  finally { controller.abort(); }
}

// This function runs in the actual candidate page, after the compositor has
// had two animation frames. Mounted or decoded offscreen images do not count.
export async function collectRenderedDashboardSample({ skipAnimationFrames = false } = {}) {
  if (!skipAnimationFrames) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const parse = source => { if (!source?.startsWith('data:image/jpeg;base64,')) return null;
    try { const bytes=atob(source.slice('data:image/jpeg;base64,'.length));
      const m=bytes.slice(-98,-2).match(/^CLP_REL_FRAME_V2:(\d{13}):(\d{1,16}):(\d{1,7}):([a-f0-9]{24}):END/);
      return m && { capturedAt:Number(m[1]),ordinal:Number(m[2]),pulseSequence:Number(m[3]),pulseMarker:m[4] }; } catch { return null; } };
  const color = image => { if (!image?.complete || !image.naturalWidth) return null;
    const c=document.createElement('canvas'); c.width=1;c.height=1;const ctx=c.getContext('2d');ctx.drawImage(image,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]; };
  const digest = async source => { if (!source?.startsWith('data:image/jpeg;base64,')) return null;
    const binary=atob(source.slice('data:image/jpeg;base64,'.length));if(binary.length!==40960)return null;
    if(!crypto.subtle)throw Error('Secure WebCrypto source hash required');
    const bytes=Uint8Array.from(binary,value=>value.charCodeAt(0)),hash=await crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(hash)].map(value=>value.toString(16).padStart(2,'0')).join(''); };
  return { visible:document.visibilityState==='visible', cards:await Promise.all([...document.querySelectorAll('[data-testid^="card-student-"]')].map(async card=>{
    const studentId=card.getAttribute('data-testid').slice('card-student-'.length), image=card.querySelector(`[data-testid="screenshot-${CSS.escape(studentId)}"]`), previous=card.querySelector(`[data-testid="screenshot-previous-${CSS.escape(studentId)}"]`);
    const source=image?.currentSrc||'', previousSource=previous?.currentSrc||'', frame=parse(source), previousFrame=parse(previousSource), box=image?.getBoundingClientRect();
    if(frame)frame.jpegSha256=await digest(source);if(previousFrame)previousFrame.jpegSha256=await digest(previousSource);
    let displayed=!!box&&box.width>0&&box.height>0&&box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight;
    for(let node=image;displayed&&node;node=node.parentElement){const s=getComputedStyle(node),b=node.getBoundingClientRect();
      if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)!==1 && node!==image
        ||/hidden|clip|scroll|auto/.test(s.overflowX)&&(box.left<b.left||box.right>b.right)
        ||/hidden|clip|scroll|auto/.test(s.overflowY)&&(box.top<b.top||box.bottom>b.bottom))displayed=false;}
    const decoded=!!image?.complete&&image.naturalWidth>0, rgba=color(image), previousRgba=color(previous), opacity=image?Number(getComputedStyle(image).opacity):0, points=[];
    if(displayed&&decoded&&rgba){
      // object-contain paints a centered square for these1x1 fixtures. Sample
      // the upper interior, outside the actual screenshot caption gradient.
      const scale=Math.min(box.width/image.naturalWidth,box.height/image.naturalHeight), width=image.naturalWidth*scale,height=image.naturalHeight*scale,left=box.left+(box.width-width)/2,top=box.top+(box.height-height)/2;
      for(const[x,y]of[[.35,.2],[.5,.3],[.65,.4]]){const px=Math.floor(left+width*x),py=Math.floor(top+height*y),hit=document.elementFromPoint(px,py);
        if(!hit||!(hit===image||hit===previous||image.contains(hit)||hit.contains(image)&&image.closest('button')?.contains(hit)))displayed=false;points.push({x:px,y:py});}
    }
    return{studentId,frame,previousFrame,displayed,decoded,points,rgba,previousRgba,opacity,
      geometry:box?{left:box.left,top:box.top,width:box.width,height:box.height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,objectFit:getComputedStyle(image).objectFit}:null,
      contributors:opacity<1&&previous?[previousFrame,frame]:[frame]};
  }))};
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
export function createNativeScreenshotDecoder({ timeoutMs = 8000, maximumActive = 2, decodeFactory } = {}) {
  sharp.cache(false);
  let active = 0, poisoned = false;
  const counters = { started: 0, completed: 0, timeouts: 0, lateSettlements: 0, peakActive: 0, peakRawBytes: 0 };
  const actualFactory = png => {
    const pipeline = sharp(png, { limitInputPixels: RENDERED_VIEWPORT.width * RENDERED_VIEWPORT.height, failOn: 'warning' })
      .ensureAlpha().raw().timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) });
    return { promise: pipeline.toBuffer({ resolveWithObject: true }), destroy: () => pipeline.destroy() };
  };
  const run = async (png, viewport, sample) => {
    assert.ok(!poisoned && active < maximumActive, 'Native decoder unavailable or bounded concurrency exceeded');
    assert.ok(Buffer.isBuffer(png) && png.length >= 24 && png.length <= 32 * 1024 * 1024);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Native PNG required');
    assert.equal(png.subarray(12,16).toString('ascii'), 'IHDR');
    assert.ok(Number.isSafeInteger(viewport.width) && Number.isSafeInteger(viewport.height) && viewport.width > 0 && viewport.height > 0
      && viewport.width * viewport.height <= RENDERED_VIEWPORT.width * RENDERED_VIEWPORT.height);
    assert.equal(png.readUInt32BE(16), viewport.width); assert.equal(png.readUInt32BE(20), viewport.height);
    active += 1; counters.started += 1; counters.peakActive = Math.max(counters.peakActive, active);
    let timedOut = false, job, timer;
    try { job = (decodeFactory || actualFactory)(png); }
    catch (error) { active -= 1; throw error; }
    const underlying = Promise.resolve(job.promise).then(({ data, info }) => {
      try {
        assert.ok(Buffer.isBuffer(data)); assert.equal(info.width, viewport.width); assert.equal(info.height, viewport.height);
        assert.equal(info.channels, 4); assert.equal(data.length, viewport.width * viewport.height * 4);
        counters.peakRawBytes = Math.max(counters.peakRawBytes, data.length);
        if (timedOut) return null;
        const pixel = ({ x, y }) => {
          assert.ok(Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && y >= 0 && x < info.width && y < info.height);
          const start = (y * info.width + x) * 4; return [...data.subarray(start, start + 4)];
        };
        return sample(pixel);
      } finally { data?.fill?.(0); }
    });
    const settled = underlying.finally(() => { active -= 1; counters.completed += 1; if (timedOut) counters.lateSettlements += 1; });
    settled.catch(() => {});
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      timedOut = true; poisoned = true; counters.timeouts += 1; job.destroy?.(); reject(new Error('Native compositor decode deadline exceeded'));
    }, timeoutMs); });
    try { return await Promise.race([settled, deadline]); } finally { clearTimeout(timer); }
  };
  return { run, summary: () => ({ ...counters, active, poisoned, maximumActive }) };
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
export async function compareRenderedCapturePaint({ png, cards, afterCards, viewport = RENDERED_VIEWPORT }, decoder = createNativeScreenshotDecoder()) {
  return decoder.run(png, viewport, pixel => cards.map(card => {
    const after = afterCards.find(row => row.studentId === card.studentId), actual = card.points.map(pixel);
    const low = Math.min(card.opacity, after?.opacity ?? 0), high = Math.max(card.opacity, after?.opacity ?? 0), old = card.previousRgba;
    const contributors=renderedCaptureContributors(card,after),swapped=!sameFrame(card.frame,after?.frame);
    const legalPaint=swapped
      ? renderedPixelsMatchBlend(actual,card.rgba,old||card.rgba,card.opacity,1)
        ||renderedPixelsMatchBlend(actual,after?.rgba,after?.previousRgba||card.rgba,0,after?.opacity??0)
      : renderedPixelsMatchBlend(actual,card.rgba,old||card.rgba,low,high);
    const matched = renderedCaptureFenceMatches(card, after) && card.rgba && card.points.length === 3
      && contributors.length>0&&contributors.every(frame=>frame&&/^[a-f0-9]{64}$/.test(frame.jpegSha256||''))
      && (low >= 1 || old && card.previousFrame || swapped)&&legalPaint;
    return { studentId: card.studentId, matched: Boolean(matched), rgba: actual[1] || null,contributors,transitioned:swapped };
  }));
}
export async function compareRenderedNavigationPaint({ png, rows, afterRows, viewport = RENDERED_VIEWPORT }, decoder = createNativeScreenshotDecoder()) {
  return decoder.run(png, viewport, pixel => rows.map(row => {
    const after = afterRows.find(value => value.studentId === row.studentId), actual = row.points.map(pixel);
    const same = row.matched && after?.matched && row.marker === after.marker && JSON.stringify(row.points) === JSON.stringify(after.points);
    return { studentId: row.studentId, marker: row.marker, matched: Boolean(same && row.points.length >= 5
      && row.points.every((point,index) => point.rgba.every((value,channel) => Math.abs(value-actual[index][channel]) <= 12))), pixels: actual.flat() };
  }));
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

export async function runRenderedDashboards(arguments_ = process.argv.slice(2)) {
  const { values } = parseArgs({ args: arguments_, options: { config: { type: 'string' }, auth: { type: 'string' },
    output: { type: 'string' }, devices: { type: 'string' }, 'frontend-dist': { type: 'string' },
    'input-manifest': { type: 'string' }, 'device-manifest': { type: 'string' }, 'start-at': { type: 'string' },
    'chrome-path': { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) return console.log('Usage: node scripts/load/run-classpilot-rendered-dashboards.mjs --config <external-staging-config> --auth <selected-private-auth> --input-manifest <exact-remote-input-manifest> --output <fresh-private-dir> --devices40|500|800 --frontend-dist <exact-candidate-dist> [--start-at <matching-manifest-UTC>] [--chrome-path <Chrome>] [--dry-run]. Loads real authenticated dashboards before the shared UTC start barrier. No mock API or shortened staging duration.');
  assert.ok(values.config && values.auth && values.output && values.devices && values['frontend-dist'] && values['input-manifest'] && values['device-manifest']);
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
  const pulseController = new CapturePulseController(measurementContext, { now: () => performance.now() });
  const measurementChannel=createMeasurementArtifactChannel({role:'controller',expected:measurementContext,devices:privateDevices});
  let controlStopped = false, publicationLoop = null, bootstrapSha = null, drainNonce = null,
    causalStartUpperMs = null, causalStartPassed = false, bootstrapComplete = false;
  const navigationSamples = [], navigationDevices = new Set(), navigationTasks = [], navigationPixels = new Map();
  const observerPool=createBoundedObserverPool({limit:2,maximumQueue:40});const observeLimited=observerPool.run;
  const nativeDecoder=createNativeScreenshotDecoder();
  const syncMeasurementCounters=()=>{const value=measurementChannel.summary();counters.controlPutAttempts=value.publishAttempts;counters.controlGetAttempts=value.readAttempts;counters.controlBytes=value.bytesWritten+value.bytesRead;counters.controlActualNetworkAttempts=value.actualNetworkAttempts;return value;};
  const putControl=async(name,value)=>{try{return await measurementChannel.publish(name,value);}finally{syncMeasurementCounters();}};
  const getSignal = async (name, kind, nonce, deadline) => {
    while (performance.now() < deadline && !interrupted) {
      try {
        const value = await measurementChannel.read(name,{kind,nonce});syncMeasurementCounters(); validateMeasurementSignal(value, measurementContext, kind, nonce); return performance.now();
      } catch (error) { if (!(error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404 || error?.name === 'AbortError' || error?.message?.includes('deadline') || measurementChannel.summary().readInFlight)) throw error; }
      await delay(50);
    }
    throw Error('Causal signal deadline exceeded');
  };
  const httpMetrics = new RenderedHttpMetrics({ origin: auth.baseUrl });
  const staticTraffic = { requests: 0, completed: 0, failed: 0, encodedBytes: 0, inFlight: 0 };
  const browser = await chromium.launch({ executablePath: chrome, headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  let thrown = false, interrupted = false, phase = 'preparing';
  const barrierAbort = new AbortController();
  const stop = () => { interrupted = true; barrierAbort.abort(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  try {
    const identity = await promisify(execFile)('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text', '--region', 'us-east-1'],
      { timeout: 8000, maxBuffer: 1024, windowsHide: true });
    assert.equal(identity.stdout.trim(), measurementContext.account);
    await Promise.all(auth.teacherAuth.map(async (actor, index) => {
      const context = await browser.newContext({ viewport: RENDERED_VIEWPORT });
      context.setDefaultTimeout(10_000);
      await context.route('**/*', route => new URL(route.request().url()).origin === auth.baseUrl ? route.continue() : route.abort());
      const pair = actor.teacherCookie.split(';').map(value => value.trim()).find(value => value.startsWith('schoolpilot.staging.sid='));
      await context.addCookies([{ name: 'schoolpilot.staging.sid', value: pair.slice('schoolpilot.staging.sid='.length),
        url: auth.baseUrl, secure: true, httpOnly: true, sameSite: 'Lax' }]);
      await context.addInitScript(schoolId => localStorage.setItem('sp_activeSchoolId', schoolId), actor.schoolId);
      const page = await context.newPage(), frames = new Map(), allowed = new Set(actor.studentIds);
      const runtime = { actor, context, page, frames, allowed, index, initialPaint: false, lastOrdinals: new Map(), freshUpdates: 0,
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
        const socketGeneration = ++runtime.socketGeneration; runtime.subscribed = false; let subscriptionRequestId=null;
        socket.on('close', () => { if (runtime.socketGeneration === socketGeneration) runtime.subscribed = false; });
        socket.on('framesent', event => { try { const message=JSON.parse(String(event.payload));
          if(socketGeneration===runtime.socketGeneration&&message.type==='subscribe-session'&&message.teachingSessionId===actor.teachingSessionId
            &&typeof message.requestId==='string'&&message.requestId.length>0&&!message.supervisionContextId){subscriptionRequestId=message.requestId;runtime.subscribed=false;}
        }catch{ /* Invalid outbound frames cannot establish observer scope. */ } });
        socket.on('framereceived', event => {
          try {
            if (socketGeneration !== runtime.socketGeneration) return;
            const message = JSON.parse(String(event.payload));
            if (message.type === 'session-subscription-success' && message.teachingSessionId === actor.teachingSessionId
              && (message.sessionId===undefined||message.sessionId===actor.teachingSessionId) && !message.supervisionContextId
              && subscriptionRequestId!==null && message.requestId===subscriptionRequestId) runtime.subscribed = true;
            if(message.type==='auth-error'||message.type==='session-subscription-error'){
              runtime.subscribed=false;counters.connectionDenials+=1;
            }
            if (observeRenderedStudentState(runtime, message, performance.now())) counters.measurementScopeErrors += 1;
            if (observeRenderedCommandUpdate(runtime, message, performance.now())) counters.commandScopeMismatch += 1;
          } catch { /* Other transport frames cannot establish command completion. */ }
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
            if (runtime.bindings.get(tile.studentId) !== tile.bindingVersion) frames.delete(tile.studentId);
            runtime.bindings.set(tile.studentId, tile.bindingVersion);
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
    }));
    assert.equal(actors.length, profile.classrooms);
    // Establish prior real compositor state before the shared start. The
    // first causal pulse is then emitted directly at the controller start.
    await Promise.all(actors.map(runtime=>observeLimited(async()=>{
      const sample=await renderedDeadline(runtime.page.evaluate(collectRenderedDashboardSample)), png=await renderedDeadline(runtime.page.screenshot({timeout:8000}));
      for(const card of sample.cards) runtime.lastPaints.set(card.studentId,{frame:null,rgba:card.rgba,absent:!card.decoded});
      runtime.priorCompositorSha256=hash(png);
    })));
    phase = 'start-barrier';
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
      const entry = pulseController.navigationHistory.get(round), deadline = entry.t0 + 8000;
      const observed = new Set();
      while (performance.now() < deadline && observed.size < profile.primaryDevices && !controlStopped) {
        await Promise.all(actors.map(runtime => observeLimited(async () => {
          const pending = runtime.actor.studentIds.filter(id => !observed.has(id)); if (!pending.length) return;
          const expectedRows = pending.map(studentId => {
            const snapshot = navigationSnapshot({ runId: manifest.runId, round, nonce: entry.nonce }, publicBindings.get(studentId), runtime.revisionSeeds.get(studentId));
            return { ...snapshot, studentId, publicBinding: publicBindings.get(studentId) };
          });
          if (!expectedRows.every(row => navigationMessageMatches(runtime.realtime.get(row.studentId), row, runtime))) return;
          const witness = await renderedDeadline(runtime.page.evaluate(collectNavigationPixelWitness, expectedRows), 2000);
          if (!witness.every(row => row.matched)) return;
          const png = await renderedDeadline(runtime.page.screenshot({ timeout: 2000 }), 2000);
          const afterRows = await renderedDeadline(runtime.page.evaluate(collectNavigationPixelWitness,expectedRows),2000);
          const composed = await compareRenderedNavigationPaint({png,rows:witness,afterRows},nativeDecoder);
          const receivedAt = performance.now();
          for (const row of composed) {
            const expected = expectedRows.find(expected => expected.studentId === row.studentId), previous = navigationPixels.get(row.studentId), pixels = JSON.stringify(row.pixels);
            if (receivedAt <= deadline && row.matched && (previous ? previous !== pixels : round===1&&runtime.priorStripAbsent)
              && navigationMessageMatches(runtime.realtime.get(row.studentId), expected, runtime)) {
              observed.add(row.studentId); navigationDevices.add(row.studentId); navigationPixels.set(row.studentId, pixels);
              navigationSamples.push(receivedAt - entry.t0); counters.navigationObserved += 1;
            }
          }
        })));
        await delay(50);
      }
      for (let count = observed.size; count < profile.primaryDevices; count += 1) navigationSamples.push(Infinity);
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
        if(round===1&&previousRound===0){
          // The seeded regular body has no open-tab strip. Identical prior SVG
          // pixels are refused rather than credited from new title attributes.
          await Promise.all(actors.map(runtime=>observeLimited(async()=>{
            const absent=await renderedDeadline(runtime.page.evaluate(ids=>ids.every(id=>!document.querySelector('[data-testid="tab-favicon-'+CSS.escape(id)+'-0"]')),runtime.actor.studentIds),2000);
            assert.equal(absent,true,'Round1 requires actual prior strip absence');
            runtime.priorNavigationCompositorSha256=hash(await renderedDeadline(runtime.page.screenshot({timeout:2000}),2000));
            assert.equal(await renderedDeadline(runtime.page.evaluate(ids=>ids.every(id=>!document.querySelector('[data-testid="tab-favicon-'+CSS.escape(id)+'-0"]')),runtime.actor.studentIds),2000),true);
            runtime.priorStripAbsent=true;
          })));
        }
        const pulse = pulseController.issue({ navigationRound: round, revisionBaselinesSha256: bootstrapSha, revisionDrainNonce: drainNonce });
        await putControl('measurement-control.json', pulse);
        if (drainNonce && !bootstrapComplete) await bootstrap(pulse);
        if (round > previousRound) { const task=observeRound(round);task.catch(()=>{interrupted=true;barrierAbort.abort();});navigationTasks.push(task); }
        nextPulseAt += 1000; if (nextPulseAt < performance.now()) nextPulseAt = performance.now();
      }
    })();
    publicationLoop.catch(() => { interrupted = true; barrierAbort.abort(); });
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
    let nextSampleAt = performance.now();
    while (!interrupted && performance.now() < endMonotonic) {
      const roundStartedAt = performance.now();
      counters.sampleRounds += 1;
      await Promise.all(actors.map(runtime => observeLimited(async () => {
        const generation=runtime.socketGeneration,bindingsBefore=new Map(runtime.bindings);
        const sample = await renderedDeadline(runtime.page.evaluate(collectRenderedDashboardSample));
        const png = await renderedDeadline(runtime.page.screenshot({ timeout: 8000 }));
        const after = await renderedDeadline(runtime.page.evaluate(collectRenderedDashboardSample,{skipAnimationFrames:true}));
        const pixels = await compareRenderedCapturePaint({png,cards:sample.cards,afterCards:after.cards},nativeDecoder);
        const observedAt = performance.now();
        if (!sample.visible) counters.hidden += 1;
        if (sample.cards.length !== profile.studentsPerClass || new Set(sample.cards.map(card => card.studentId)).size !== profile.studentsPerClass) counters.wrongClass += 1;
        for (const card of sample.cards) {
          counters.samples += 1;
          runtime.samples += 1;
          if (!runtime.allowed.has(card.studentId)) { counters.wrongClass += 1; continue; }
          const frame = card.frame;
          const composed=pixels.find(row=>row.studentId===card.studentId),contributors=composed?.contributors||[];
          const authorized = generation===runtime.socketGeneration&&runtime.subscribed&&bindingsBefore.get(card.studentId)===runtime.bindings.get(card.studentId)
            &&contributors.length>0&&contributors.every(value=>renderedCaptureFrameAuthorized(value,runtime.frames.get(card.studentId)));
          let age = Infinity;
          if (sample.visible && card.displayed && card.decoded && frame && authorized && pixels.find(row => row.studentId === card.studentId)?.matched) {
            try {
              const previous=runtime.lastPaints.get(card.studentId), colorChanged=previous?.absent||!previous?.rgba||JSON.stringify(previous.rgba)!==JSON.stringify(composed.rgba);
              if(composed.transitioned||previous?.frame?.ordinal===frame.ordinal||colorChanged){
                age=Math.max(...contributors.map(value=>pulseController.ageUpper(value,publicBindings.get(card.studentId),observedAt)));
                if(!composed.transitioned&&card.opacity>=1&&after.cards.find(row=>row.studentId===card.studentId)?.opacity>=1)runtime.lastPaints.set(card.studentId,{frame,rgba:composed.rgba,absent:false});
              } else if(previous?.frame) age=pulseController.ageUpper(previous.frame,publicBindings.get(card.studentId),observedAt);
              if(Number.isFinite(age))knownCaptureBindings.add(publicBindings.get(card.studentId));
            } catch { /* Unknown/aliased paint cannot gain freshness from rawDate or a new decoded source. */ }
          }
          ages.observe(age);
          if (!Number.isFinite(age)) { counters.unavailable += 1; runtime.unavailable += 1; continue; }
          if (runtime.lastOrdinals.get(card.studentId) !== frame.ordinal) { runtime.freshUpdates += 1; runtime.lastOrdinals.set(card.studentId, frame.ordinal); }
        }
        if (!runtime.initialPaint) {
          // The native compositor output proves rendering without persisting
          // pixels or identifiers in the operational result artifacts.
          runtime.compositorSha256 = hash(png);
          runtime.initialPaint = true;
        }
      })));
      writeFileSync(join(paths.outputPath, 'rendered-progress.json'), JSON.stringify({ runId: manifest.runId,
        plannedStartAt: manifest.startAt, elapsedSeconds: (performance.now() - startedMonotonic) / 1000,
        classrooms: actors.length, counters, http: httpMetrics.progress(), p95CaptureAgeMs: ages.percentile(95), p99CaptureAgeMs: ages.percentile(99) }));
      if (performance.now() - roundStartedAt > 5000) counters.slowSampleRounds += 1;
      nextSampleAt += 5000;
      if (nextSampleAt < performance.now()) nextSampleAt = performance.now();
      await delay(Math.min(Math.max(0, nextSampleAt - performance.now()), Math.max(0, endMonotonic - performance.now())));
    }
    controlStopped = true; await publicationLoop; await Promise.all(navigationTasks);
    await Promise.all(actors.map(runtime=>observeLimited(async()=>{
      const generation=runtime.socketGeneration,subscribed=runtime.subscribed;
      const actual=await renderedDeadline(runtime.page.evaluate(()=>({visible:document.visibilityState==='visible',live:document.querySelector('[data-testid="badge-connection-status"]')?.textContent.trim()==='Live updates'})));
      if(!subscribed||!runtime.subscribed||generation!==runtime.socketGeneration)counters.finalUnsubscribed+=1;
      if(!actual.visible||!actual.live)counters.finalNotLive+=1;
    })));
    httpMetrics.closeWindow();
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
      startBarrier: barrier, utcSkewDiagnosticOnly: true, measuredDurationMs, http, navigationStaticTraffic: staticTraffic,
      browser: browser.version(), startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
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
      nativePixelDecoder:nativeDecoder.summary(),finalConnectionHealthPassed:!counters.finalUnsubscribed&&!counters.finalNotLive&&!counters.connectionDenials,
      counters, captureAge: { timingBasis: 'controller-monotonic-causal-pulse-upper-bound', knownPulseBindings: knownCaptureBindings.size,
        expectedAttempts: counters.samples, allExpectedAttemptsAccounted: ages.summary().count === counters.samples, unknownAttempts: counters.unavailable,
        ...ages.summary(), p95Ms: ages.percentile(95), p99Ms: ages.percentile(99) },
      minimumFreshUpdatesPerClassroom: Math.min(...actors.map(runtime => runtime.freshUpdates)),
      concurrentBurstElapsedMs, commandDispatchSpreadMs, browserPaintValidated: failures.length === 0,
      managedDevicesValidated: false, productionAccepted: false, failures };
    writeFileSync(join(paths.outputPath, 'rendered-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ operation: 'rendered-browser-finished', classrooms: profile.classrooms,
      browserPaintValidated: summary.browserPaintValidated, failures }));
    if (failures.length) process.exitCode = 1;
  } catch { thrown = true; throw new Error('Rendered dashboard campaign failed; no private response details emitted'); }
  finally {
    controlStopped = true; if (publicationLoop) await publicationLoop.catch(() => {}); await Promise.allSettled(navigationTasks); measurementChannel.close();syncMeasurementCounters();
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop);
    await browser.close();
    if (thrown) writeFileSync(join(paths.outputPath, 'rendered-summary.json'), JSON.stringify({ browserPaintValidated: false,
      productionAccepted: false, managedDevicesValidated: false, failurePhase: phase, counters, http: httpMetrics.summary(), failures: ['incomplete rendered dashboard campaign'] }, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRenderedDashboards().catch(() => { console.error('[rendered-dashboards] Refused or failed; private credentials and responses omitted'); process.exitCode = 1; });
}
