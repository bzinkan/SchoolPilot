import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { moduleFromApplication } from './application.mjs';
import { profileFor } from './contracts.mjs';
import { offerHeartbeats, sealTimings } from './offering.mjs';
import {writeFileSync,readFileSync} from 'node:fs';
import {hash} from './contracts.mjs';
import {createLowerStaffReader} from './lower-staff.mjs';
const profile = profileFor(process.env.RELEASE297_PROFILE);
const { createStudentToken } = await moduleFromApplication('services/deviceJwt.js');
const required = JSON.parse(process.env.RELEASE297_REQUIRED_CAPABILITIES), capabilities = JSON.parse(process.env.RELEASE297_CLIENT_CAPABILITIES);
assert.ok(required.includes('scopedAuthorityChecksV1') && required.includes('screenshotTrackingWindowLeaseV1'));
let fixture, tokens,lowerStaffReader;
process.send({ kind: 'ready', pid: process.pid });
process.on('message', async request => {
  try {
    let value;
    if (request.operation === 'initialize') {
      fixture = request.value;
      tokens = fixture.schools.map(school => school.students.map((studentId, index) => createStudentToken({ studentId, schoolId: school.id,
        deviceId: school.devices[index], sessionId: school.studentSessions[index], studentEmail: `scale-${studentId}@example.test` })));
      if(profile.lowerLoadEnvelope)lowerStaffReader=await createLowerStaffReader(fixture,profile);
      value = { acceptedCapabilities: required, noInjectedQueryWrappers: true };
    } else if (request.operation === 'phase' || request.operation === 'verify') {
      const verification=request.operation==='verify';
      if(!verification)assert.deepEqual(request.value.offering, profile.offering);
      const started = performance.now();
      const heartbeats=offerHeartbeats(async (offer, signal) => {
        const school = fixture.schools[offer.schoolIndex];
        const response = await fetch(fixture.apiBases[0] + '/api/classpilot/device/heartbeat', { method: 'POST', signal,
          headers: { Authorization: 'Bearer ' + tokens[offer.schoolIndex][offer.deviceIndex], 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientProtocolVersion: 3, extensionVersion: process.env.RELEASE297_EXTENSION_VERSION,
            capabilities, activeTabUrl: 'https://ixl.com/lesson', activeTabTitle: 'Synthetic current scope', tabSnapshotRevision: 9,
            allOpenTabs: [{ tabRef: `synthetic-tab-${offer.deviceIndex}`, url: 'https://ixl.com/lesson', title: 'Synthetic current scope' }] }) });
        const body = await response.json();
        if (response.status !== 200) throw Object.assign(Error('Heartbeat failed'), { httpStatus: response.status });
        for (const capability of required) assert.ok(body.acceptedCapabilities?.includes(capability), `Missing negotiated ${capability}`);
        return { status: response.status, school: school.index, targetIndex:0 };
      }, { startsAtMs:verification?undefined:request.value.startsAtMs,
        config: verification?{...profile.offering,requestsPerSecond:200,schoolDevices:[1,1],durationMs:10,deviceCadenceMs:10,expected:2,maxInFlight:2}:profile.offering });
      if(profile.lowerLoadEnvelope&&!verification){
        const settled=await Promise.allSettled([heartbeats,lowerStaffReader(request.value.startsAtMs)]);
        assert.equal(settled[0].status,'fulfilled');value=sealTimings(settled[0].value);
        if(settled[1].status==='fulfilled'){
          const proof={source:process.env.USAGE_SOURCE_REVISION,run:JSON.parse(readFileSync('/control/binding.json','utf8')).run,profile:profile.name,...settled[1].value};
          const bytes=JSON.stringify(proof)+'\n';writeFileSync('/control/lower-staff-reads.private.json',bytes,{flag:'wx',mode:0o600});
          value.lowerStaffReads={...proof.summary,nativeProofSha256:hash(bytes)};
        }else value.lowerStaffReads={passed:false,error:'LOWER_STAFF_READ_FAILED'};
      }else value=sealTimings(await heartbeats);
      value.clientWorkCompletedMs = performance.now() - started;
      value.capabilityAcknowledgements200=value.succeeded;
      if(verification)value.passed=value.accepted&&value.succeeded===2;
    } else if (request.operation === 'shutdown') { process.send({ id: request.id, value: true }, () => process.exit(0)); return; }
    else throw Error('Unknown blackbox generator operation');
    process.send({ id: request.id, value });
  } catch (error) { process.send({ id: request.id, error: { code: error.code || 'BLACKBOX_GENERATOR_FAILED', name: error.name } }); }
});
