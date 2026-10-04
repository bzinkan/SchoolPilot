import assert from 'node:assert/strict';
import { replaceOnce } from '../roles/patch-coordinator.mjs';

// Hash-bound generated overlay: canonical historical files never change.
export function patchGeneratorV2(source) {
  let text = source.replaceAll('\r\n', '\n');
  text = replaceOnce(text, "import { offerOpenLoopHeartbeats, OPEN_LOOP_HEARTBEATS } from './open-loop-heartbeats.mjs';", "import { offerHeartbeats as offerOpenLoopHeartbeats, sealTimings } from './release-gates-v2/offering.mjs';\nimport { assertOffering, profileFor, stickyTarget, stageForRound } from './release-gates-v2/contracts.mjs';\nimport { lostReconnectBindings } from './release-gates-v2/reconnect.mjs';");
  text = replaceOnce(text, 'let fixture, base, schools;', `let fixture, base, schools;
const v2Profile = profileFor(process.env.RELEASE297_PROFILE);
let topology = { active: [0], distribution: 'uniform' }, apiBases, continuousStartsAtMs;
const issuedRecipients=new Map();
const observedStickyBindings=new Map();
const endpointFor = (school, index) => {
  const ordinal = school.index * 500 + index;
  const activeTopology = continuousStartsAtMs ? stageForRound(Math.min(v2Profile.rounds-1,Math.max(0,Math.floor((Date.now()-continuousStartsAtMs)/60_000))),v2Profile) : topology;
  const target = stickyTarget(ordinal, activeTopology.active, activeTopology.distribution);
  assert.ok(apiBases[target]); return apiBases[target];
};`);
  text = replaceOnce(text, "{ method = 'GET', body, cookie, token, schoolId, csrf, signal } = {}", "{ method = 'GET', body, cookie, token, schoolId, csrf, signal, endpoint } = {}");
  text = replaceOnce(text, 'fetch(`${base}${path}`,', 'fetch(`${endpoint ?? base}${path}`,');
  text = replaceOnce(text, "async function heartbeat(school, index, signal, allowPreflightThrottle = false) {", "async function heartbeat(school, index, signal, allowPreflightThrottle = false) {\n  const actualEndpoint=endpointFor(school,index);");
  text = replaceOnce(text, "method: 'POST', token: school.tokens[index], signal,", "method: 'POST', token: school.tokens[index], signal, endpoint: actualEndpoint,");
  text = replaceOnce(text, "assert.ok([200, 204].includes(result.status), `Heartbeat HTTP ${result.status}`);", "if (!(result.status === 200 || (allowPreflightThrottle && result.status === 204))) throw Object.assign(new Error('Heartbeat status'), { httpStatus: result.status });");
  text = replaceOnce(text, 'offer.index < RELEASE_ENABLED_PROFILE.preflightDevicesPerSchool * schools.length', 'false');
  text = replaceOnce(text, '  return result;\n}\n\nexport function assertHistoricalReport', `  const targetIndex=apiBases.indexOf(actualEndpoint);
  if(continuousStartsAtMs&&v2Profile.broaderCapacityGate&&!allowPreflightThrottle&&result.status===200){
    const stage=stageForRound(Math.min(v2Profile.rounds-1,Math.floor((Date.now()-continuousStartsAtMs)/60_000)),v2Profile);
    if(stage.distribution==='sticky80')observedStickyBindings.set(school.index+':'+index,{schoolIndex:school.index,deviceIndex:index,targetIndex,observedAtMs:Date.now()});
  }
  return { ...result, targetIndex };\n}\n\nexport function assertHistoricalReport`);
  text = replaceOnce(text, "`${base.replace('http:', 'ws:')}/ws`", "`${endpointFor(school, index).replace('http:', 'ws:')}/ws`");
  text = replaceOnce(text, '  return issued.body.command.id;', "  issuedRecipients.set('command:'+issued.body.command.id,school.students[index]);\n  return issued.body.command.id;");
  text = replaceOnce(text, 'const events = [], sockets = [];', 'const events = [], sockets = [], expectedNegativeProbes = [];');
  text = replaceOnce(text, "events.push('stale_private_reply_rejected');", "const requestId=stale.headers.get('x-request-id');assert.match(requestId,/^[a-f0-9-]{36}$/);assert.equal(stale.body.requestId,requestId);expectedNegativeProbes.push({requestId,status:stale.status,code:stale.body.code});events.push('stale_private_reply_rejected');");
  text = replaceOnce(text, 'return { passed: true, events, simulatedClientAcknowledgements:', 'return { passed: true, events, expectedNegativeProbes, simulatedClientAcknowledgements:');
  text = replaceOnce(text, 'return { passed: false, events, error:', 'return { passed: false, events, expectedNegativeProbes, error:');
  text = replaceOnce(text, "const sent = await send(); assert.equal(sent.status, 202);", "const sent = await send(); assert.equal(sent.status, 202); issuedRecipients.set('message:'+sent.body.message.id,school.students[2]);");
  text = replaceOnce(text, "const pending = await send(); assert.equal(pending.status, 202);", "const pending = await send(); assert.equal(pending.status, 202); issuedRecipients.set('message:'+pending.body.message.id,school.students[2]);");
  text = replaceOnce(text, 'socket.close(); const reconnected = await connectStudent(school, 2); sockets.push(reconnected); await reconnected.drain();',
    'socket.close(); const reconnected = await connectStudent(school, 2); sockets.push(reconnected); const oldPrivateFrames=socket.frames;controlSockets[2]=reconnected;await reconnected.drain();');
  text = replaceOnce(text, "events.push('precise_cleanup_ack');", `events.push('precise_cleanup_ack');
      await sleep(250);await Promise.all(controlSockets.map(connection=>connection.drain()));
      for(let recipient=0;recipient<controlSockets.length;recipient++)for(const frame of [...controlSockets[recipient].frames,...(recipient===2?oldPrivateFrames:[])]){
        const key=frame.commandId?'command:'+frame.commandId:frame.chatMessageId?'message:'+frame.chatMessageId:null;
        if(key&&issuedRecipients.has(key))assert.equal(issuedRecipients.get(key),school.students[recipient],'Forbidden same-school recipient received a private message or command');
      }events.push('forbidden_recipient_frames_absent');`);
  text = replaceOnce(text, 'signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),', '// Fixed public request budget; never create a near-zero timeout while polling.\n      signal: AbortSignal.timeout(20_000),');
  text = replaceOnce(text, 'fixture = rpc.value; base = fixture.base; schools = fixture.schools;', 'fixture = rpc.value; apiBases = fixture.apiBases; base = apiBases[0]; schools = fixture.schools;');
  text = replaceOnce(text, "        assertHistoricalReport(await report(school, 'school'), 'school', fixture);", "        if (v2Profile.usage) assertHistoricalReport(await report(school, 'school'), 'school', fixture);");
  text = replaceOnce(text, "      const foreign = await staffRequest(schools[0],", "      if (v2Profile.usage) {\n      const foreign = await staffRequest(schools[0],");
  text = replaceOnce(text, "      value = { realSessionCookies: true, acceptedCapabilities: true };", "      }\n      value = { realSessionCookies: true, acceptedCapabilities: true };");
  text = replaceOnce(text, '      const config = { ...OPEN_LOOP_HEARTBEATS, ...(rpc.value.durationMs ? { durationMs: rpc.value.durationMs } : {}) };', `      const config = rpc.value.offering;
      assertOffering(config); assert.deepEqual(config, rpc.value.continuous ? v2Profile.continuousOffering : v2Profile.offering);
      if(rpc.value.startsAtMs)while(Date.now()<rpc.value.startsAtMs)await sleep(Math.max(1,rpc.value.startsAtMs-Date.now()));
      continuousStartsAtMs=rpc.value.continuous?rpc.value.startsAtMs:null;
      observedStickyBindings.clear();
      topology = rpc.value.topology; base = apiBases[topology.active[0]];
      assert.ok(base);`);
  text = replaceOnce(text,'false), { config }) : null,','false), { config, startsAtMs:rpc.value.startsAtMs }) : null,');
  // Long survival waves are fixed-clock offers, routed through targets that
  // are active when offered. They do not reuse the last lifecycle's base.
  text = replaceOnce(text, '  const start = performance.now(), result = await staffRequest(school, `/admin/usage?${query}`);',
    '  const start = performance.now(), result = await staffRequest(school, `/admin/usage?${query}`, {endpoint:endpointFor(school,0)});');
  text = replaceOnce(text, '    const days = RELEASE_ENABLED_PROFILE.reportOffers.rangesInDays[wave];',
    `    if(continuousStartsAtMs)await sleep(Math.max(0,continuousStartsAtMs+v2Profile.reportWaveOffsetsMs[wave]-Date.now()));
    const days = RELEASE_ENABLED_PROFILE.reportOffers.rangesInDays[wave];`);
  text = replaceOnce(text, 'const row = { wave, days, schoolIndex: school.index, scope, status: 0, correct: false };',
    `const row = { wave, days, schoolIndex: school.index, scope, status: 0, correct: false,
      scheduledOffsetMs:continuousStartsAtMs?v2Profile.reportWaveOffsetsMs[wave]:null,
      offeredOffsetMs:continuousStartsAtMs?Date.now()-continuousStartsAtMs:null,endpointIndex:apiBases.indexOf(endpointFor(school,0)) };`);
  text = replaceOnce(text, 'const [heartbeats, reports, classroom] = await Promise.all([', 'const [heartbeats, reports, classroom, reconnect] = await Promise.all([');
  text = replaceOnce(text, 'rpc.value.reports ? reportWaves() : [], rpc.value.lifecycle ? lifecycle() : null,', `rpc.value.reports ? reportWaves() : [], rpc.value.lifecycle ? (rpc.value.continuous ? (async()=>{
          const rounds=[];for(let minute=0;minute<v2Profile.rounds;minute++){
            await sleep(Math.max(0,continuousStartsAtMs+minute*60_000-Date.now()));base=apiBases[stageForRound(minute,v2Profile).active[0]];
            rounds.push({minute,...await lifecycle()});
          }return {passed:rounds.length===v2Profile.rounds&&rounds.every(row=>row.passed),rounds};})() : lifecycle()) : null,
        rpc.value.reconnect ? (async()=>{const stage=v2Profile.stages.find(row=>row.reconnectOffers);
          await sleep(rpc.value.continuous?Math.max(0,continuousStartsAtMs+stage.fromRound*60_000+stage.reconnectStartDelayMs-Date.now()):stage.reconnectStartDelayMs);
          const selected=stage.reconnectLostOnly?lostReconnectBindings([...observedStickyBindings.values()],v2Profile,continuousStartsAtMs):null;
          const result=await offerOpenLoopHeartbeats((offer,signal)=>heartbeat(schools[offer.schoolIndex],offer.deviceIndex,signal,true),
            {config:{...config,schoolDevices:stage.reconnectSchoolDevices??config.schoolDevices,maxInFlight:stage.reconnectOffers,durationMs:stage.reconnectWindowMs,deviceCadenceMs:stage.reconnectWindowMs,expected:stage.reconnectOffers},reconnect:true,
              ...(selected?{mapOffer:offer=>({...offer,deviceIndex:selected.schools[offer.schoolIndex][offer.deviceIndex].deviceIndex})}:{})});
          if(selected)result.lostBindingEvidence=selected;return result;})() : null,`);
  text = replaceOnce(text, 'if (heartbeats) { heartbeats.timings = summarize(heartbeats.timingsMs); delete heartbeats.timingsMs; }', 'if (heartbeats) { sealTimings(heartbeats); heartbeats.capabilityAcknowledgements200=heartbeats.succeeded; } if (reconnect) sealTimings(reconnect);');
  text = replaceOnce(text, "'Only the first offer to each of the ten explicitly warmed bindings may use the5s throttle. Every other204 fails. Raw persistence must equal200responses.'", "'Ordinary offerings all require200; only the separately counted reconnect extras may be204. Raw rows equal exact per-binding200 acknowledgements.'");
  text = replaceOnce(text, 'value = { heartbeats, heartbeatStatuses, heartbeat204Reason:', 'value = { heartbeats, reconnect, topology, contractProfile: v2Profile.name, heartbeatStatuses, heartbeat204Reason:');
  return text;
}

export function patchProcessV2(source) {
  let text = source.replaceAll('\r\n', '\n');
  text = replaceOnce(text, 'let metrics;', 'let metrics; let seenHeartbeatOffers=0;');
  text = replaceOnce(text, 'const started = performance.now();', 'const started = performance.now(), operationStartedAtMs=Date.now();');
  text = replaceOnce(text, 'value = { ...value, durationMs: performance.now() - started };',
    'value = { ...value, durationMs: performance.now() - started, startedAtMs:operationStartedAtMs, finishedAtMs:Date.now() };');
  text = replaceOnce(text, 'const reset = () => { metrics = fresh();', 'const reset = () => { seenHeartbeatOffers=0; metrics = fresh();');
  text = replaceOnce(text, '    activeResponses++; let ended = false;', "    if(_req.url?.split('?')[0]==='/api/classpilot/device/heartbeat')seenHeartbeatOffers++;\n    activeResponses++; let ended = false;");
  // API ports are stable within the owned PostgreSQL network namespace. Each
  // distinct process retains its original16/2 caps and original cleanup path.
  text = replaceOnce(text, "server.listen(0, '127.0.0.1', resolve)", "server.listen(Number(process.env.RELEASE297_API_PORT), '127.0.0.1', resolve)");
  text = replaceOnce(text, 'let admission;', `let admission;
const heartbeatGate = role === 'api' ? await import('../../../dist/middleware/classpilotHeartbeatAdmission.js') : null;
if (heartbeatGate) assert.equal(typeof heartbeatGate.getClasspilotHeartbeatAdmissionSnapshot, 'function');`);
  text = replaceOnce(text, 'http: { activeResponses, abortedResponses }, tenantReleases:', 'http: { activeResponses, abortedResponses, seenHeartbeatOffers }, heartbeatAdmission: heartbeatGate?.getClasspilotHeartbeatAdmissionSnapshot(), tenantReleases:');
  return text;
}

export function patchDrainV2(source) {
  let text = source.replaceAll('\r\n', '\n');
  text = replaceOnce(text, '    pendingTenantReleases: snapshot.tenantReleases?.pending,', `    pendingTenantReleases: snapshot.tenantReleases?.pending,
    queuedHeartbeats: snapshot.heartbeatAdmission?.queued ?? 0,
    admittedHeartbeats: snapshot.heartbeatAdmission?.active ?? 0,`);
  return text;
}
