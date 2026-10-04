import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, PROFILES, profileHash } from './contracts.mjs';
import { generatedHelperFile } from './prepare-helper.mjs';
import { loadReceipt } from './receipts.mjs';
import { assertUsagePostVerificationEvidence } from './usage-post-verification.mjs';
import { DISTINCT_SERVICE_LIMITS, distinctEndpointOperationHash, runDistinctEndpointOperation } from './distinct-report-operation.mjs';
import { distinctReportContractHash } from './distinct-reports.mjs';
import { verifyDistinctReceiptCustody } from './distinct-report-custody.mjs';

// The distinct endpoint operation is separate from the three unchanged cold
// runs. It cannot relabel a failed/missing cold attempt or reuse its audit state.
export function verifyOriginalUsageCampaignOrder({contract,journal,inputs,source,contractSha256}){
  assert.equal(inputs?.length,3);assert.equal(contract.kind,'usage');assert.equal(contract.profile,PROFILES.usage.name);
  assert.equal(contract.contractSha256,profileHash(PROFILES.usage));assert.equal(contract.candidateSource,source);
  assert.deepEqual(contract.order,['C','C','C']);assert.equal(journal.contractSha256,contractSha256);assert.equal(journal.attempts.length,3);
  for(const [index,input]of inputs.entries()){
    const attempt=journal.attempts[index];assert.equal(attempt.index,index);assert.equal(attempt.state,'recorded');
    assert.equal(attempt.receiptManifestSha256,input.receiptManifestSha256);assert.equal(attempt.receipt.runPassed,true);
    assert.equal(attempt.receipt.source,source);assert.equal(attempt.receipt.profile,PROFILES.usage.name);assert.equal(attempt.receipt.arm,'C');
  }
  return true;
}
export function verifyOriginalUsagePrerequisites(inputs, expected) {
  assert.equal(inputs?.length, 3, 'Three original cold Usage receipts are required');
  const campaign=expected.originalUsageCampaign;assert.ok(campaign);
  const contractBytes=readFileSync(join(campaign.directory,'contract.json')),journalBytes=readFileSync(join(campaign.directory,'journal.json'));
  assert.equal(hash(contractBytes),campaign.contractSha256);assert.equal(hash(journalBytes),campaign.journalSha256);
  const contract=JSON.parse(contractBytes),journal=JSON.parse(journalBytes);
  verifyOriginalUsageCampaignOrder({contract,journal,inputs,source:expected.source,contractSha256:campaign.contractSha256});
  const receipts=[];
  const rows = inputs.map((input,index) => {
    const attempt=journal.attempts[index];assert.equal(attempt.index,index);assert.equal(attempt.state,'recorded');
    assert.equal(attempt.receiptManifestSha256,input.receiptManifestSha256);assert.deepEqual(attempt,JSON.parse(readFileSync(join(campaign.directory,`attempt-${index+1}.json`),'utf8')));
    const receipt = loadReceipt(input.receiptDirectory, input.receiptManifestSha256, input.privateDirectory);
    assert.deepEqual(receipt,attempt.receipt);
    assert.equal(receipt.profile, PROFILES.usage.name); assert.equal(receipt.contractSha256, profileHash(PROFILES.usage));
    for (const key of ['source', 'applicationImage', 'schemaSha256']) assert.equal(receipt[key], expected[key]);
    assert.equal(receipt.arm, 'C'); assert.equal(receipt.runPassed, true); assert.equal(receipt.cleanupPassed, true);
    assert.equal(receipt.sourceUnchanged, true); assert.ok(receipt.usagePostVerificationContractSha256);
    assertUsagePostVerificationEvidence(receipt);
    assert.equal(receipt.run,attempt.run);assert.equal(receipt.observedFlagsSha256,contract.observedFlagsSha256);receipts.push(receipt);
    return { run: receipt.run, source: receipt.source, applicationImage: receipt.applicationImage, schemaSha256: receipt.schemaSha256,
      receiptManifestSha256: input.receiptManifestSha256, usagePostVerificationContractSha256: receipt.usagePostVerificationContractSha256 };
  });
  assert.equal(new Set(rows.map(row => row.run)).size, 3);
  for(const key of ['helperImage','harnessSource','hostHarnessSource','observedFlagsSha256'])assert.equal(new Set(receipts.map(row=>row[key])).size,1);
  assert.equal(hash(readFileSync(join(campaign.directory,'contract.json'))),campaign.contractSha256);
  assert.equal(hash(readFileSync(join(campaign.directory,'journal.json'))),campaign.journalSha256);
  return rows;
}

export function assertDistinctGeneratedBinding(preparation, sourceDirectory) {
  assert.equal(preparation.distinctReportRpc, true); assert.equal(preparation.distinctRpcComposition, 'after-existing-v2');
  for (const name of ['release-enabled-generator.mjs', 'release-gates-v2/observer.mjs', 'release-gates-v2/role-entry.mjs']) {
    const path = 'scripts/load/usage/' + name, canonical = readFileSync(join(sourceDirectory, path), 'utf8');
    assert.equal(hash(canonical), preparation.canonicalFiles[path]);
    const actual = generatedHelperFile(name, canonical, { distinctReportRpc: true });
    assert.equal(hash(actual), preparation.executedFiles[path]);
    if (name === 'release-enabled-generator.mjs') {
      assert.ok(actual.includes('fetch(`${endpoint ?? base}${path}`'));
      assert.ok(actual.includes('createDistinctGeneratorRpc') && actual.includes('boundaryProof'));
      // The retained staffRequest constructs actual cookie/CSRF headers; the
      // new reports pass only an endpoint override into that same function.
      assert.ok(actual.includes('school.cookie') && actual.includes('school.csrf'));
    }
  }
  for (const name of ['distinct-reports.mjs', 'distinct-report-rpc.mjs', 'distinct-report-rpc-overlay.mjs']) {
    const path = 'scripts/load/usage/release-gates-v2/' + name;
    assert.equal(hash(readFileSync(join(sourceDirectory, path))), preparation.canonicalFiles[path]);
    assert.equal(preparation.executedFiles[path], preparation.canonicalFiles[path]);
  }
  return true;
}

export async function executeDistinctProfile({ options, metrics, preparation, fixture, active, worker, observer, generator, output, save }) {
  assertDistinctGeneratedBinding(preparation, options.harnessDirectory);
  assert.equal(active.size, 3); assert.equal(fixture.sourceRevision, options.source);
  const restoreBytes = readFileSync(join(output, 'ready.json')), restore = JSON.parse(restoreBytes);
  const bootstrapBytes = readFileSync(join(output, 'operational-fixture-bootstrap.json')), bootstrap = JSON.parse(bootstrapBytes);
  assert.equal(restore.restorationPassed, true); assert.equal(restore.source, options.source); assert.equal(restore.run, options.run);
  assert.equal(restore.snapshotManifestSha256, options.snapshotManifestSha256);
  assert.equal(bootstrap.originalSnapshotRestore.restorationPassed, true);
  assert.equal(bootstrap.originalSnapshotRestore.snapshotManifestSha256, options.snapshotManifestSha256);
  assert.equal(bootstrap.canonicalMigrationSchemaRelabeled, false);
  assert.deepEqual(metrics.databasePreparation.distinctHeavyRows, [{ schoolIndex: 0, count: 1_000_000 }, { schoolIndex: 1, count: 1_000_000 }]);
  const apis = [0, 1, 2].map(index => active.get(index));
  const registration = { run: options.run, source: options.source, profile: PROFILES.usageDistinct.name,
    operationContractSha256: distinctEndpointOperationHash(), reportContractSha256: distinctReportContractHash(),
    helperBindingSha256: options.helperBindingSha256, helperImage: options.helperImage,
    snapshotManifestSha256: options.snapshotManifestSha256, restorationReceiptSha256: hash(restoreBytes),
    operationalFixtureReceiptSha256: hash(bootstrapBytes), schemaInputSha256: metrics.schemaInputSha256,
    canonicalSourceSchemaSha256: metrics.schemaSha256, actualRestorationPassed: true,
    healthHookAppliedAfterOriginalVerification: true, healthHookRelabeledCanonicalSchema: false,
    sessionCookiePathVerified: metrics.generatorInitialization.realSessionCookies === true,
    generatedEndpointOverrideVerified: true, serviceLimits: DISTINCT_SERVICE_LIMITS,
    nativeHeavyObservationCounts: metrics.databasePreparation.distinctHeavyRows.map(row => row.count),
    ownerBindings: [...apis, worker, observer, generator].map(owner => ({ ...owner.ready.binding, helperImage: owner.helperImage })) };
  save('distinct-registration.json', registration); metrics.distinctFixtureSha256 = hash(JSON.stringify(fixture));
  // Preserve the exact fulfilled phase even when an independent later oracle
  // fails. Its expected negative probes remain part of the final log coverage.
  const recordedGenerator = { ...generator, async rpc(operation, value, ...rest) {
    const result = await generator.rpc(operation, value, ...rest);
    if (operation === 'phase') { metrics.continuousTraffic = result; save('continuous-traffic.json', result); }
    return result;
  } };
  metrics.distinctOperation = await runDistinctEndpointOperation({ registration, fixture, apis, worker, observer, generator: recordedGenerator });
  save('distinct-endpoint-operation.json', metrics.distinctOperation);
  assert.equal(metrics.distinctOperation.passed, true, 'Distinct endpoint operation failed');
  metrics.distinctClassroomBindings = await observer.rpc('correctness', { classroom: true });
  save('distinct-classroom-bindings.json', metrics.distinctClassroomBindings);
  assert.equal(metrics.distinctClassroomBindings.passed, true);
  assert.ok(metrics.distinctClassroomBindings.nativeRowsSha256);
}

export function verifyDistinctCompletedRun(output, privateDirectory, metrics) {
  const result = verifyDistinctReceiptCustody(output, privateDirectory, metrics);
  assert.equal(result.verified, true); return result;
}
