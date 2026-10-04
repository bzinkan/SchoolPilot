import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { PROFILES, USAGE_BASE, profileHash, profileFor, hash } from './contracts.mjs';
import { DISTINCT_ENDPOINT_OPERATION, DISTINCT_SERVICE_LIMITS, distinctEndpointOperationHash, distinctCoverageHash, verifyDistinctWorkloadOverlap } from './distinct-report-operation.mjs';
import { generatedHelperFile } from './prepare-helper.mjs';
import { assertDistinctGeneratedBinding,verifyOriginalUsageCampaignOrder } from './distinct-report-run.mjs';
import { patchGeneratorV2 } from './patch.mjs';
import { declareCampaign, reserveAttempt } from './campaign.mjs';
import { replayDistinctNativeRecord,verifyDistinctReceiptCustody } from './distinct-report-custody.mjs';
import { currentObservationSeconds, currentObservationFixtureViolations } from '../local-usage-scale.mjs';
import { countDistinctCurrentObservations,prepareDistinctReports,distinctPreparedStateHash,distinctReportCases,distinctCsvCases,distinctCanonicalKey,
  distinctReportContractHash,DISTINCT_REPORT_CONTRACT } from './distinct-reports.mjs';
import { schoolDayOracle } from '../school-day-profile.mjs';
import { checkPersistence } from './persistence.mjs';
import { verifyClassroomBindings } from './lifecycle-audience.mjs';

const source = 'ddc5996b3b8645859fa51a9613486db52c481b7f', run = 'abcdef123456';
const frozenOriginalUsageJson = '{"name":"release297-usage-shared-db-three-api-100-v2","kind":"usage","offering":{"requestsPerSecond":100,"schoolDevices":[500,500],"durationMs":60000,"deviceCadenceMs":10000,"expected":6000,"maxInFlight":1000,"requestTimeoutMs":20000,"maxOfferLatenessMs":100},"usage":true,"apiTasks":3,"repetitions":3,"reports":64,"rawPerSchool":1000000,"workerAcceptanceMs":48000,"pairedReleaseComparisonRequired":true}';
const raw = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const digest = value => hash(JSON.stringify(value));
const dateBefore = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
const midnight = date => {
  // New York's clock transitions occur after local midnight. UTC00 gives the
  // offset in effect at that date's upcoming local midnight, including DST.
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
    .formatToParts(new Date(date + 'T00:00:00Z')).find(row => row.type === 'timeZoneName').value.replace('GMT', '');
  return new Date(date + 'T00:00:00' + offset).toISOString();
};
const removeOwned = root => {
  assert.equal(dirname(root), resolve(tmpdir())); assert.ok(basename(root).startsWith('release297-distinct-'));
  rmSync(root, { recursive: true });
};

test('distinct profile is separately named and hash-bound while the exact original Usage JSON remains frozen', () => {
  assert.equal(JSON.stringify(USAGE_BASE), frozenOriginalUsageJson); assert.equal(PROFILES.usage, USAGE_BASE);
  assert.equal(profileHash(PROFILES.usage), hash(frozenOriginalUsageJson));
  assert.deepEqual(PROFILES.usageDistinct, DISTINCT_ENDPOINT_OPERATION);
  assert.equal(profileHash(PROFILES.usageDistinct), distinctEndpointOperationHash());
  assert.equal(profileFor(PROFILES.usageDistinct.name), PROFILES.usageDistinct);
  assert.notEqual(profileHash(PROFILES.usageDistinct), profileHash(PROFILES.usage));
  assert.throws(() => profileHash({ ...PROFILES.usageDistinct, repetitions: 3 }));
});

test('distinct helper composition is opt-in after the latest generated wrappers and keeps ordinary routing, boundary proof and real cookies', () => {
  const generator = raw('../release-enabled-generator.mjs'), observer = raw('./observer.mjs'), role = raw('./role-entry.mjs');
  assert.equal(generatedHelperFile('release-enabled-generator.mjs', generator), patchGeneratorV2(generator));
  assert.equal(generatedHelperFile('release-gates-v2/observer.mjs', observer), observer);
  assert.equal(generatedHelperFile('release-gates-v2/role-entry.mjs', role), role);
  const generated = generatedHelperFile('release-enabled-generator.mjs', generator, { distinctReportRpc: true });
  for (const marker of ['offeringOffsetMs, actualDispatchOffsetMs', 'topologyForOffer', 'boundaryProof',
    'cookie: teacher ? school.teacherCookie : school.cookie', 'csrf: teacher ? school.teacherCsrf : school.csrf',
    'fetch(`${endpoint ?? base}${path}`', 'staffRequest: (...args) => staffRequest(...args)']) assert.ok(generated.includes(marker), marker);
  for (const name of ['prepareDistinctReports', 'distinctReports', 'boundaryProof']) assert.equal((generated.match(new RegExp(`rpc.operation === '${name}'`, 'g')) ?? []).length, 1);
  const owned = generatedHelperFile('release-gates-v2/role-entry.mjs', role, { distinctReportRpc: true });
  for (const name of ['distinctOracle', 'distinctAudit', 'prepareDistinctReports', 'distinctReports', 'boundaryProof']) assert.equal((owned.match(new RegExp(`'${name}'`, 'g')) ?? []).length, 1);
  const observed = generatedHelperFile('release-gates-v2/observer.mjs', observer, { distinctReportRpc: true });
  assert.ok(observed.includes('distinctHeavyRows') && observed.includes('school.school_timezone'));
  assert.throws(() => generatedHelperFile('release-enabled-generator.mjs', 'wrong anchors', { distinctReportRpc: true }));
  assert.throws(() => generatedHelperFile('release-enabled-generator.mjs', generator, { distinctReportRpc: 'true' }));
});

test('the executed generated helper binding fails closed on omitted composition or mutated endpoint/RPC bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'release297-distinct-generated-'));
  t.after(() => removeOwned(root));
  const preparation = { distinctReportRpc: true, distinctRpcComposition: 'after-existing-v2', canonicalFiles: {}, executedFiles: {} };
  const names = ['release-enabled-generator.mjs', 'release-gates-v2/observer.mjs', 'release-gates-v2/role-entry.mjs',
    'release-gates-v2/distinct-reports.mjs', 'release-gates-v2/distinct-report-rpc.mjs', 'release-gates-v2/distinct-report-rpc-overlay.mjs'];
  for (const name of names) {
    const bytes = raw('../' + name), path = 'scripts/load/usage/' + name;
    mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), bytes);
    preparation.canonicalFiles[path] = hash(bytes); preparation.executedFiles[path] = hash(generatedHelperFile(name, bytes, { distinctReportRpc: true }));
  }
  assert.equal(assertDistinctGeneratedBinding(preparation, root), true);
  assert.throws(() => assertDistinctGeneratedBinding({ ...preparation, distinctReportRpc: false }, root));
  const broken = structuredClone(preparation); broken.executedFiles['scripts/load/usage/release-enabled-generator.mjs'] = '0'.repeat(64);
  assert.throws(() => assertDistinctGeneratedBinding(broken, root));
});

test('distinct campaign and reservation require three immutable original receipts and cannot relabel the original Usage campaign', t => {
  const root = mkdtempSync(join(tmpdir(), 'release297-distinct-register-')); t.after(() => removeOwned(root));
  const values = ['1', '2', '3'].map(value => value.repeat(64));
  const options = { kind: 'distinct', profile: PROFILES.usageDistinct.name, candidateSource: source, observedFlagsSha256: '4'.repeat(64), originalUsageReceiptManifestSha256s: values,
    originalUsageCampaignContractSha256:'5'.repeat(64),originalUsageCampaignJournalSha256:'6'.repeat(64) };
  assert.throws(() => declareCampaign({ ...options, directory: join(root, 'missing'), originalUsageReceiptManifestSha256s: undefined }));
  assert.throws(() => declareCampaign({ ...options, directory: join(root, 'duplicate'), originalUsageReceiptManifestSha256s: [values[0], values[0], values[2]] }));
  assert.throws(() => declareCampaign({ ...options, directory: join(root, 'wrong-kind'), kind: 'usage' }));
  assert.throws(() => declareCampaign({ ...options, directory: join(root, 'old-relabel'), profile: PROFILES.usage.name }));
  const directory = join(root, 'new'), contract = declareCampaign({ ...options, directory }); assert.deepEqual(contract.order, ['C']);
  const reservation = reserveAttempt({ directory, run, receiptDirectory: join(root, 'receipt'), privateDirectory: join(root, 'private') });
  assert.deepEqual(JSON.parse(readFileSync(reservation.reservationFile)).originalUsageReceiptManifestSha256s, values);
  const old = declareCampaign({ kind: 'usage', profile: PROFILES.usage.name, candidateSource: source, observedFlagsSha256: '4'.repeat(64), directory: join(root, 'old') });
  assert.deepEqual(old.order, ['C', 'C', 'C']); assert.equal('originalUsageReceiptManifestSha256s' in old, false);
});

test('original Usage prerequisites require all three declared consecutive passes rather than selected favourable receipts',()=>{
  const inputs=['1','2','3'].map(value=>({receiptManifestSha256:value.repeat(64)}));
  const contract={kind:'usage',profile:PROFILES.usage.name,contractSha256:profileHash(PROFILES.usage),candidateSource:source,order:['C','C','C']};
  const contractSha256=digest(contract),journal={contractSha256,attempts:inputs.map((input,index)=>({index,state:'recorded',...input,
    receipt:{runPassed:true,source,profile:PROFILES.usage.name,arm:'C'}}))};
  assert.equal(verifyOriginalUsageCampaignOrder({contract,journal,inputs,source,contractSha256}),true);
  for(const mutate of [row=>row.journal.attempts[1].receipt.runPassed=false,row=>row.journal.attempts[1].state='reserved',
    row=>row.journal.attempts[1].index=2,row=>row.journal.attempts.push(row.journal.attempts[2]),
    row=>row.inputs.reverse(),row=>row.journal.attempts[0].receipt.source='a'.repeat(40),row=>row.contract.order=['A','B','B']]){
    const input=structuredClone({contract,journal,inputs,source,contractSha256});mutate(input);
    assert.throws(()=>verifyOriginalUsageCampaignOrder(input));
  }
});

function nativeRecord() {
  const today = '2026-10-04', cutoff = '2026-10-04T07:00:00.000Z';
  const fixture = { sourceRevision: source, today, heavyDate: dateBefore(today, 2), emptyDate: dateBefore(today, 3), gapDate: dateBefore(today, 5),
    apiBases: [4001, 4002, 4003].map(port => 'http://127.0.0.1:' + port), schools: [0, 1].map(index => ({ index, id: 'school-' + index, staff: 'staff-' + index,
      students: Array.from({ length: 500 }, (_, n) => `student-${index}-${n}`), devices: Array.from({ length: 500 }, (_, n) => `device-${index}-${n}`),
      groups: Array.from({ length: 100 }, (_, n) => `class-${index}-${n}`),teachers:['teacher-'+index],currentSession:'activity-'+index,
      studentSessions:Array.from({length:500},(_,n)=>`session-${index}-${n}`) })) };
  const native = fixture.schools.map(school => {
    const end = BigInt(Date.parse(cutoff)) * 1000n;
    const rows = [[0, end - 15_499_999n], [0, end - 499_999n], [0, end - 499_998n], [1, end - 1n]].map(([index, at], n) => ({
      id: `raw-${school.index}-${n}`, school_id: school.id, student_id: school.students[index], device_id: school.devices[index], timestamp_microseconds: String(at),
      valid_binding: true, expected_url: true, expected_classification: true, expected_teacher_intent: true }));
    const counts = { currentAiDecisionRows: 0, invalidRosterStudents: 0 };
    return { schoolIndex: school.index, raw: rows, counts, violations: currentObservationFixtureViolations(rows, school.students, counts), auditRecords: [],
      role: { role: 'runtime_role', rolsuper: false, rolbypassrls: false, school: school.id, is_super: 'off' }, scoped: { students: 0, heartbeats: 0, coverage: 0 },
      window: { zone: 'America/New_York', start_microseconds: String(BigInt(Date.parse(midnight(today))) * 1000n),
        end_microseconds: String(BigInt(Date.parse(midnight(dateBefore(today, -1)))) * 1000n) },
      coverage: Array.from({ length: 365 }, (_, index) => dateBefore(today, 364 - index)).filter(date => date !== fixture.gapDate)
        .map(date => ({ date, is_final: date !== today, processed_through: date === today ? cutoff : midnight(dateBefore(date, -1)), valid_window: true })) };
  });
  const oracle = { kind: 'distinct-report-independent-raw-coverage-v1', source, cutoff, aggregateRowsUsedForExpected: false,
    productReportCodeUsedForExpected: false, preparedActualWorkersVerified: true, coverageFrozenForOffering: true,
    schools: native.map(row => ({ schoolIndex: row.schoolIndex, invalidRawBindings: 0, invalidClassificationOrRoster: 0,
      ...countDistinctCurrentObservations(row.raw, cutoff), secondsByStudent: [...currentObservationSeconds(row.raw, new Date(cutoff))].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      coverage: row.coverage.map(item => ({ date: item.date, isFinal: item.is_final, processedThrough: item.processed_through })) })) };
  return { fixture, record: { kind: 'distinct-report-native-before', run, source, cutoff, oracle, native, audits: [], rawPrefixSha256: digest(native.map(({ schoolIndex, raw }) => ({ schoolIndex, raw }))) } };
}

test('retained native distinct proof replays exact microseconds, deduplication, tenant scope and school-local coverage', () => {
  const { fixture, record } = nativeRecord();
  assert.equal(replayDistinctNativeRecord(record, fixture, { run, source, runtimeRole: 'runtime_role' }), record.oracle);
  assert.equal(record.oracle.schools[0].rawRows, 4); assert.equal(record.oracle.schools[0].deduplicatedRows, 3);
  assert.deepEqual(record.oracle.schools[0].secondsByStudent.map(([, seconds]) => seconds), [15, 0]);
});

test('rebound oracle hashes cannot turn missing raw attribution, false zero or wrong tenant/day boundaries into acceptance', () => {
  for (const mutate of [row => row.record.oracle.schools[0].secondsByStudent[0][1]++,
    row => row.record.native[0].raw[0].school_id = row.fixture.schools[1].id,
    row => row.record.native[0].raw[0].device_id = row.fixture.schools[1].devices[0],
    row => row.record.native[0].raw[0].timestamp_microseconds = String(BigInt(Date.parse(midnight(row.fixture.today))) * 1000n - 1n),
    row => row.record.native[0].scoped.coverage = 1, row => row.record.native[0].role.rolbypassrls = true,
    row => { row.record.native[0].coverage[0].processed_through = row.record.native[0].coverage[0].date + 'T12:00:00Z';
      row.record.oracle.schools[0].coverage[0].processedThrough = row.record.native[0].coverage[0].processed_through; },
    row => row.record.native[0].counts.invalidRosterStudents = 1]) {
    const input = nativeRecord(); mutate(input); input.record.rawPrefixSha256 = digest(input.record.native.map(({ schoolIndex, raw }) => ({ schoolIndex, raw })));
    assert.throws(() => replayDistinctNativeRecord(input.record, input.fixture, { run, source, runtimeRole: 'runtime_role' }));
  }
});

test('distinct runner stays outside the original report/coverage path and requires final native custody, all-role errors and graceful cleanup', () => {
  const runner = raw('./run.mjs'), receipts = raw('./receipts.mjs'), execute = raw('./distinct-report-run.mjs');
  assert.ok(runner.indexOf('if(profile.distinctReports){\n        await executeDistinctProfile') < runner.indexOf('if(profile.kind===\'mixed\')'));
  assert.ok(runner.includes('metrics.rounds.length===0') && runner.includes('verifyDistinctCompletedRun(output,control,metrics)'));
  assert.ok(runner.includes('metrics.errorCoverage?.length===8') && runner.includes('metrics.hostHarnessSourceUnchanged'));
  assert.ok(receipts.includes('verifyDistinctReceiptCustody(root,privateDirectory,metrics)'));
  assert.ok(receipts.includes('row.expired===0&&row.unsettledAtExit===0'));
  assert.ok(execute.includes("observer.rpc('correctness', { classroom: true })"));
  assert.ok(execute.includes("save('continuous-traffic.json', result)"));
});

const cleanDrain=()=>({complete:true,physicallyIdle:true,physicallySettled:true,budgetMs:20_000,elapsedMs:10,passes:2,abortedResponses:0,
  gauges:Object.fromEntries(['activeOperations','pendingCheckouts','activeCheckouts','pendingAcquisitions','activeQueries','poolWaiting','poolHeld',
    'httpResponses','pendingTenantReleases','queuedHeartbeats','admittedHeartbeats'].map(key=>[key,0]))});
const writeJson=(file,value)=>writeFileSync(file,JSON.stringify(value)+'\n');
function fullCustody(t){
  const root=mkdtempSync(join(tmpdir(),'release297-distinct-custody-'));t.after(()=>removeOwned(root));
  const receipt=join(root,'receipt'),privateRoot=join(root,'private');mkdirSync(receipt);mkdirSync(privateRoot);
  const {fixture,record:before}=nativeRecord(),helperImage='sha256:'+'a'.repeat(64),snapshot='b'.repeat(64),helperBinding='c'.repeat(64);
  const roles=['api0','api1','api2','worker','observer','generator'];
  const exits=roles.map((role,index)=>({role,containerId:String(index+1).repeat(64),helperImage,clean:true}));
  const bindings=roles.map((role,index)=>({run,source,role,containerId:exits[index].containerId}));
  for(const binding of bindings){mkdirSync(join(privateRoot,binding.role));writeJson(join(privateRoot,binding.role,'binding.json'),{...binding,nonce:'d'.repeat(64)});
    writeJson(join(privateRoot,binding.role,'ready.json'),{binding});}
  function rpc(role,rows){const binding=bindings.find(row=>row.role===role);
    for(const [index,[operation,input,value]]of rows.entries()){
      const id=index+1;writeJson(join(privateRoot,role,`request-${id}.json`),{id,nonce:'d'.repeat(64),operation,...(input===undefined?{}:{value:input})});
      writeJson(join(privateRoot,role,`response-${id}.json`),{id,value,binding});
    }
  }
  const prepared=prepareDistinctReports(fixture,before.oracle),preparedHash=distinctPreparedStateHash({run,fixture,oracle:before.oracle,prepared});
  const preparedResult={prepared:true,contractSha256:prepared.contractSha256,casesSha256:prepared.caseManifestSha256,
    expectedSha256:prepared.expectedReportsSha256,oracleSha256:prepared.oracleSha256,preparedHash,caseCount:64,csvCount:8};
  const startsAtMs=Date.parse(before.cutoff)+1500;
  const reportRow=item=>({ordinal:item.ordinal,wave:item.wave,schoolIndex:item.schoolIndex,scope:item.scope,targetOrdinal:item.targetOrdinal,days:item.days,
    endpointIndex:item.endpointIndex,requestKeySha256:distinctCanonicalKey(item),effectiveKeySha256:distinctCanonicalKey(item),status:200,correct:true,
    durationMs:1000,offerLatenessMs:0,declaredOffsetMs:item.wave*15_000,offeredOffsetMs:item.wave*15_000});
  const reports={source,startsAtMs,profile:DISTINCT_REPORT_CONTRACT.name,passed:true,capacityAcceptance:false,contractSha256:prepared.contractSha256,
    preparedHash,expectedReportsSha256:prepared.expectedReportsSha256,independentOracleSha256:prepared.oracleSha256,currentProcessedCutoff:before.cutoff,peakInFlight:16,
    checks:Object.fromEntries(['all64ActualAuthenticatedEndpoints','allRequestsWithinUnchangedDeadline','actualDeclaredOffers','uniqueRequestAndEffectiveKeys',
      'all8CsvCorrect','drainedClientOffers','concurrentEndpointWorkObserved'].map(key=>[key,true])),reportCases:distinctReportCases(fixture).map(reportRow),
    csvCases:distinctCsvCases(fixture).map(item=>({...reportRow(item),csvSha256:'e'.repeat(64),declaredOffsetMs:46_000,offeredOffsetMs:46_000}))};
  const traffic={heartbeats:{configured:PROFILES.usage.offering,expected:6000,started:6000,succeeded:6000,capabilityAcknowledgements200:6000,
    failed:0,refusedAtInFlightLimit:0,lateOffers:0,outstandingAfterDrain:0,accepted:true,timings:{count:6000,maxMs:100},startAlignmentAccepted:true,
    declaredStartLatenessMs:20,declaredStartedAtMs:startsAtMs,actualStartedAtMs:startsAtMs+20,offerWindowMs:60_000,targetHistogram:{0:2004,1:1998,2:1998},
    bindings:Object.fromEntries(fixture.schools.flatMap(school=>school.students.map((_,index)=>[`${school.index}:${index}`,{acknowledged200:6}])))} ,
    reports:[],lifecycle:{passed:true,expectedNegativeProbes:[0,1].map(index=>({requestId:`00000000-0000-0000-0000-00000000000${index}`,status:409,code:'PRIVATE_CHAT_LIFECYCLE_STALE'}))}};
  const first={rows:fixture.schools.flatMap(school=>[{school_id:school.id,student_id:school.students[0],count:3,invalid:0},
    {school_id:school.id,student_id:school.students[1],count:1,invalid:0}]),total:8,invalid:0};
  const last={rows:fixture.schools.flatMap(school=>school.students.map((id,index)=>({school_id:school.id,student_id:id,count:6+(index===0?3:index===1?1:0),invalid:0}))),total:6008,invalid:0};
  const expectedHeavy=schoolDayOracle('school'),heavy=fixture.schools.map(school=>({schoolIndex:school.index,seconds:expectedHeavy.monitored,
    heartbeatCount:expectedHeavy.heartbeats,rowCount:expectedHeavy.grains,durationMs:1000,startedAtMs:startsAtMs+25,finishedAtMs:startsAtMs+1025,correct:true}));
  const current=fixture.schools.map(school=>({schoolIndex:school.index,seconds:before.oracle.schools[school.index].secondsByStudent.reduce((sum,[,seconds])=>sum+seconds,0),
    heartbeatCount:before.oracle.schools[school.index].deduplicatedRows,durationMs:10,correct:true}));
  const database={acquisitions:{count:1,failures:0},statements:{heartbeat:{failures:0}}};
  const apiSnapshots=[0,1,2].map(index=>({database,seenHeartbeatOffers:traffic.heartbeats.targetHistogram[index]})),workerSnapshot={database};
  const audits=distinctCsvCases(fixture).map((item,index)=>({id:'audit-'+index,action:'classpilot.usage.export',school_id:item.schoolId,user_id:fixture.schools[item.schoolIndex].staff,
    entity_type:'classpilot_usage_'+item.scope,entity_id:item.id??item.schoolId,metadata:{scope:item.scope,from:item.from,to:item.to}}));
  const beforeBytes=JSON.stringify(before)+'\n';writeFileSync(join(privateRoot,'observer','distinct-native-1.private.json'),beforeBytes);
  const after=structuredClone(before);after.kind='distinct-report-native-after';after.beforeProofSha256=hash(beforeBytes);after.audits=audits;
  for(const row of after.native)row.auditRecords=audits.filter(item=>item.school_id===fixture.schools[row.schoolIndex].id);
  const afterBytes=JSON.stringify(after)+'\n';writeFileSync(join(privateRoot,'observer','distinct-native-2.private.json'),afterBytes);
  const native={source,cutoff:before.cutoff,passed:true,coverageBeforeSha256:distinctCoverageHash(before.oracle),coverageAfterSha256:distinctCoverageHash(before.oracle),
    coverageUnchanged:true,rawOracleSha256:digest(before.oracle),auditCount:8,expectedAuditKeysSha256:digest(distinctCsvCases(fixture).map(distinctCanonicalKey)),
    auditRecordsSha256:digest(audits),privateRawProofSha256:hash(afterBytes),violations:{invalidRawBindings:0,invalidClassificationOrRoster:0,coverageDifferences:0,auditDifferences:0,rawOracleDifferences:0}};
  const registration={run,source,profile:PROFILES.usageDistinct.name,helperImage,helperBindingSha256:helperBinding,snapshotManifestSha256:snapshot,
    serviceLimits:DISTINCT_SERVICE_LIMITS,ownerBindings:bindings.map(row=>({...row,helperImage})),operationContractSha256:distinctEndpointOperationHash(),
    reportContractSha256:distinctReportContractHash(),schemaInputSha256:'6b40d8811ce1f50eb3f33b3a5ca39256b404699b994c3802c48f86119d0542e3',
    canonicalSourceSchemaSha256:'3afe69c3b2dcdeaae049f24d766c542c5e12cf762227b194db329dc0368df570',actualRestorationPassed:true,
    healthHookAppliedAfterOriginalVerification:true,healthHookRelabeledCanonicalSchema:false,sessionCookiePathVerified:true,
    generatedEndpointOverrideVerified:true,nativeHeavyObservationCounts:[1_000_000,1_000_000]};
  const restore={run,source,snapshotManifestSha256:snapshot,restorationPassed:true,freshRole:'runtime_role'};
  const bootstrap={originalSnapshotRestore:{restorationPassed:true}},restoreBytes=JSON.stringify(restore)+'\n',bootstrapBytes=JSON.stringify(bootstrap)+'\n';
  writeFileSync(join(receipt,'ready.json'),restoreBytes);writeFileSync(join(receipt,'operational-fixture-bootstrap.json'),bootstrapBytes);
  registration.restorationReceiptSha256=hash(restoreBytes);registration.operationalFixtureReceiptSha256=hash(bootstrapBytes);writeJson(join(receipt,'distinct-registration.json'),registration);
  const migrations=Array.from({length:54},(_,index)=>({id:'migration-'+index,checksum:String(index%10).repeat(64),status:'complete'}));
  writeJson(join(receipt,'database-validation.json'),{passed:true,clientsClosed:true,source,snapshotManifestSha256:snapshot,
    schools:[0,1].map(()=>({raw:1_000_001,heavyBindings:{invalid:0}})),migrations:54,admittedTables:129,migrationRows:migrations,
    role:{superuser:false,bypassRls:false,freshCredentialRole:true},database:{today:fixture.today},
    screenshotEvidence:{signature:'public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text)',runtimeExecute:true,publicExecute:false,exactDefinition:true}});
  const schema='3afe69c3b2dcdeaae049f24d766c542c5e12cf762227b194db329dc0368df570';
  writeJson(join(receipt,'schema-comparison.json'),{passed:true,originalCanonicalSha256:schema,referenceCanonicalSha256:schema,restoredCanonicalSha256:schema});
  writeJson(join(receipt,'cold-restart-receipt.json'),{run,restarted:true,clientsClosed:true});
  const operation={passed:true,operationContractSha256:distinctEndpointOperationHash(),registrationSha256:digest(registration),reports,native,
    preparation:{heavyWorkers:heavy,currentWorkers:current},concurrent:[traffic,reports,heavy].map(value=>({status:'fulfilled',valueSha256:digest(value)})),
    actualWorkloadOverlap:verifyDistinctWorkloadOverlap(heavy,traffic,reports,startsAtMs),drains:Array.from({length:4},cleanDrain),finalDrains:Array.from({length:4},cleanDrain),
    persistence:checkPersistence(first,last,traffic,fixture),workerSnapshot,apiSnapshots};
  const metrics={run,source,helperImage,helperBindingSha256:helperBinding,snapshotManifestSha256:snapshot,schemaSha256:schema,profile:PROFILES.usageDistinct.name,
    contractSha256:profileHash(PROFILES.usageDistinct),distinctReportRpc:true,distinctOperation:operation,continuousTraffic:traffic,
    distinctFixtureSha256:digest(fixture),roleCleanup:{exits},originalColdRunPrerequisites:[0,1,2].map(index=>({run:String(index+1).repeat(12)})),
    databasePreparation:{restrictedRole:true,crossSchool:true,migrations,distinctHeavyRows:[0,1].map(schoolIndex=>({schoolIndex,count:1_000_000}))}};
  const classroom={commands:[],messages:[],deliveries:[],threads:[],schoolSettings:[],activitySettings:[],memberships:[],staff:[]};
  for(const school of fixture.schools){const index=school.index,thread='thread-'+index,assignment='assignment-'+index;
    classroom.threads.push({id:thread,school_id:school.id,student_id:school.students[2],teaching_session_id:school.currentSession,supervision_context_id:null,authority_assignment_id:assignment,generation:2});
    classroom.memberships.push({id:assignment,school_id:school.id,student_id:school.students[2],teaching_session_id:school.currentSession});
    classroom.staff.push({school_id:school.id,teaching_session_id:school.currentSession,staff_id:school.teachers[0]});
    classroom.schoolSettings.push({school_id:school.id,private_chat_epoch:1,student_messaging_enabled:true});
    classroom.activitySettings.push({school_id:school.id,session_id:school.currentSession,supervision_context_id:null,private_chat_epoch:1,chat_enabled:true});
    for(const command_type of ['lock-screen','unlock-screen','focus-tab','stop-focus']){const target=command_type.includes('screen')?0:1;
      classroom.commands.push({school_id:school.id,teacher_id:school.teachers[0],teaching_session_id:school.currentSession,command_type,target_scope:'students',target_count:1,
        student_id:school.students[target],student_session_id:school.studentSessions[target],device_id:school.devices[target],status:'completed'});}
    for(const delivered of [true,false]){const id=`message-${index}-${delivered}`;
      classroom.messages.push({id,school_id:school.id,session_id:school.currentSession,supervision_context_id:null,sender_id:school.teachers[0],student_id:school.students[2],
        student_session_id:null,device_id:school.devices[2],recipient_id:school.devices[2],delivery_status:delivered?'delivered':'sent',delivered_at:delivered?before.cutoff:null,
        private_chat_thread_id:thread,private_chat_generation:1,private_chat_school_epoch:1,private_chat_activity_epoch:1});
      classroom.deliveries.push({id:'delivery-'+id,chat_message_id:id,school_id:school.id,student_id:school.students[2],teaching_session_id:school.currentSession,supervision_context_id:null,
        state:delivered?'delivered':'attempted',attempt_count:1,last_attempt_at:before.cutoff,last_attempt_student_session_id:school.studentSessions[2],last_attempt_device_id:school.devices[2],delivered_at:delivered?before.cutoff:null});}
  }
  const classroomBytes=JSON.stringify(classroom)+'\n';writeFileSync(join(privateRoot,'observer','classroom-bindings.private.json'),classroomBytes);
  metrics.distinctClassroomBindings={...verifyClassroomBindings({...classroom,fixture,profile:PROFILES.usageDistinct}),nativeRowsSha256:hash(classroomBytes)};
  writeJson(join(receipt,'distinct-classroom-bindings.json'),metrics.distinctClassroomBindings);writeJson(join(receipt,'distinct-endpoint-operation.json'),operation);
  rpc('observer',[['initialize',fixture,fixture],['distinctOracle',{source,cutoff:before.cutoff},before.oracle],['snapshot',{},first],['snapshot',{},last],
    ['distinctAudit',{},native],['correctness',{classroom:true},metrics.distinctClassroomBindings],['shutdown',undefined,{}]]);
  rpc('generator',[['initialize',fixture,{realSessionCookies:true,acceptedCapabilities:true}],['prepareDistinctReports',{},preparedResult],
    ['phase',{},traffic],['distinctReports',{startsAtMs,preparedHash},reports],['shutdown',undefined,{}]]);
  const resultWithoutSchool=row=>{const {schoolIndex,correct,...value}=row;return value;};
  rpc('worker',[['drain',undefined,cleanDrain()],...heavy.map(row=>['rollup',{schoolId:fixture.schools[row.schoolIndex].id,date:fixture.heavyDate},resultWithoutSchool(row)]),
    ...current.map(row=>['rollup',{schoolId:fixture.schools[row.schoolIndex].id,date:fixture.today,cutoff:before.cutoff},resultWithoutSchool(row)]),['reset',undefined,{}],
    ...heavy.map(row=>['rollup',{schoolId:fixture.schools[row.schoolIndex].id,date:fixture.heavyDate},resultWithoutSchool(row)]),['drain',undefined,cleanDrain()],
    ['snapshot',undefined,workerSnapshot],['drain',undefined,cleanDrain()],['shutdown',undefined,{}]]);
  for(const index of [0,1,2])rpc('api'+index,[['quiesce',undefined,{}],['drain',undefined,cleanDrain()],['reset',undefined,{}],['drain',undefined,cleanDrain()],
    ['snapshot',undefined,apiSnapshots[index]],['drain',undefined,cleanDrain()],['shutdown',undefined,{}]]);
  return{root,receipt,privateRoot,metrics,before,after,fixture};
}

test('complete retained distinct custody replays real-shaped RPC sequences including double-digit worker IDs and actual 11-gauge drains',t=>{
  const input=fullCustody(t),result=verifyDistinctReceiptCustody(input.receipt,input.privateRoot,input.metrics);
  assert.equal(result.verified,true);assert.equal(result.beforeProofSha256,hash(readFileSync(join(input.privateRoot,'observer','distinct-native-1.private.json'))));
});

test('rebound public success flags cannot hide mutated native audits, wrong delivery parents, RPC owner identity or a held admission lease',t=>{
  for(const kind of ['audit','classroom','identity','drain','heartbeat']){
    const input=fullCustody(t);
    if(kind==='audit'){
      const path=join(input.privateRoot,'observer','distinct-native-2.private.json'),changed=JSON.parse(readFileSync(path));changed.audits[0].user_id='foreign';
      changed.native[0].auditRecords=changed.audits.filter(row=>row.school_id===input.fixture.schools[0].id);writeJson(path,changed);
      input.metrics.distinctOperation.native.privateRawProofSha256=hash(readFileSync(path));
      input.metrics.distinctOperation.native.auditRecordsSha256=digest(changed.audits);writeJson(join(input.receipt,'distinct-endpoint-operation.json'),input.metrics.distinctOperation);
    }else if(kind==='classroom'){
      const path=join(input.privateRoot,'observer','classroom-bindings.private.json'),changed=JSON.parse(readFileSync(path));changed.deliveries[0].student_id=input.fixture.schools[1].students[2];writeJson(path,changed);
      input.metrics.distinctClassroomBindings.nativeRowsSha256=hash(readFileSync(path));writeJson(join(input.receipt,'distinct-classroom-bindings.json'),input.metrics.distinctClassroomBindings);
    }else if(kind==='identity'){
      const path=join(input.privateRoot,'generator','response-4.json'),changed=JSON.parse(readFileSync(path));changed.binding.source='a'.repeat(40);writeJson(path,changed);
    }else if(kind==='drain'){
      const path=join(input.privateRoot,'worker','response-11.json'),changed=JSON.parse(readFileSync(path));changed.value.gauges.admittedHeartbeats=1;writeJson(path,changed);
    }else{
      input.metrics.continuousTraffic.heartbeats.failed=1;
      const path=join(input.privateRoot,'generator','response-3.json'),changed=JSON.parse(readFileSync(path));changed.value=input.metrics.continuousTraffic;writeJson(path,changed);
      input.metrics.distinctOperation.concurrent[0].valueSha256=digest(changed.value);writeJson(join(input.receipt,'distinct-endpoint-operation.json'),input.metrics.distinctOperation);
    }
    assert.throws(()=>verifyDistinctReceiptCustody(input.receipt,input.privateRoot,input.metrics));
  }
});
