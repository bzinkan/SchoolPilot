import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES, PAIRED_ORDER, assertWindow, schoolDate, verifyPreflight, verifyReview, sourceBindingOptions } from './preflight.mjs';
import { FREEZE_SHA256, SOURCES, guard, hashFile, readReference, safePath, writeNewJson, readCliRequest, isMain, cliFailure, verifyReference, contains } from './relocation.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function expectedOrder(stage) { return stage.kind === 'paired' ? [...PAIRED_ORDER] : Array(stage.count).fill('C'); }
function safeFailure(error) {
  return { name: /^[a-zA-Z]+$/.test(error?.name ?? '') ? error.name : 'Error',
    code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'CAMPAIGN_EXECUTION_FAILED',
    // Do not copy the secret-bearing first error line, argv, environment, SQL or privateDetail into stdout.
    frames: typeof error?.stack === 'string' ? error.stack.split('\n').slice(1).filter(line => /^\s+at /.test(line)).slice(0, 12) : [] };
}
export function scopeBinding(capture) {
  const env = capture.definitions.find(row => row.service === 'schoolpilot-production-api')?.environment;
  guard(env, 'OBSERVED_API_ENVIRONMENT_REQUIRED'); const ids = new Set();
  for (const rollout of Object.values(JSON.parse(env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON || '{}')))
    for (const key of ['schoolIds', 'excludedSchoolIds']) for (const id of rollout[key] || []) ids.add(id);
  for (const [key, value] of Object.entries(env)) if (/(?:SCHOOL_IDS|EXCLUDED_SCHOOL_IDS)$/.test(key) && value)
    for (const id of value.split(',')) ids.add(id.trim());
  guard(ids.size <= 2, 'OBSERVED_SCHOOL_SCOPE_OVERFLOW');
  return [...ids].sort().map((observedSchoolId, fixtureSchoolIndex) => ({ observedSchoolId, fixtureSchoolIndex }));
}

/** Linux-only path successor to the retained controller. All acceptance, declarations,
 * reservations, receipt reload and closure decisions remain in the frozen harness modules. */
export async function executeCampaign(request, { preflight = verifyPreflight, now = Date.now, runId = () => randomBytes(6).toString('hex'), event = value => process.stdout.write(JSON.stringify(value) + '\n') } = {}) {
  guard(request.schemaVersion === 1 && request.kind === 'usage_linux_campaign_request', 'CAMPAIGN_REQUEST_SCHEMA');
  const preflightRequest = await readReference(request.preflightRequest, { privateMode: true });
  const sourceLogs=preflightRequest.sourceRestoration?.outputRoot;
  guard(typeof sourceLogs==='string'&&path.isAbsolute(sourceLogs)&&typeof request.outputRoot==='string'&&path.isAbsolute(request.outputRoot),'SOURCE_LOG_ROOT_REQUIRED');
  guard(!contains(sourceLogs,request.outputRoot)&&!contains(request.outputRoot,sourceLogs),'SOURCE_LOG_ROOT_OVERLAP');
  await verifyReview(request.independentExecutionReview, request.campaignIntentSha256, 'usage_linux_execution_review');
  // The privileged/paid launcher owns deadlines and admission. This program only admits its exact hashed scope.
  const admission = await readReference(request.measurementAdmission, { privateMode: true });
  guard(admission.kind === 'usage_linux_measurement_admission' && admission.preflightRequestSha256 === request.preflightRequest.sha256 && admission.freezeSha256 === FREEZE_SHA256, 'MEASUREMENT_ADMISSION_BINDING');
  guard(admission.campaignRequestSha256 === request.campaignIntentSha256, 'MEASUREMENT_INTENT_BINDING');
  const intent = await readReference(request.campaignIntent, { privateMode: true });
  guard(request.campaignIntentSha256 === request.campaignIntent.sha256 && intent.kind === 'usage_linux_campaign_intent', 'CAMPAIGN_INTENT');
  assert.deepEqual(intent.stages, STAGES); guard(intent.expectedAttempts === 30 && intent.serialExecution === true && intent.automaticRetries === false, 'CAMPAIGN_INTENT_CONTRACT');
  guard(intent.preflightRequestSha256 === request.preflightRequest.sha256 && intent.outputRoot === request.outputRoot, 'CAMPAIGN_INTENT_INPUTS');
  for (const name of ['relocation', 'preflight', 'run-campaign', 'source-checkout']) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), `${name}.mjs`);
    guard(intent.toolSha256?.[name] === await hashFile(file), 'CAMPAIGN_REVIEWED_TOOL_DRIFT');
  }
  await verifyReview(request.independentAdmissionReview, request.measurementAdmission.sha256, 'usage_linux_measurement_admission_review');
  const context = await preflight(preflightRequest, { now: now() });
  const { freeze, canonical, quiet, relocation } = context;
  guard(admission.quietWindowSha256 === preflightRequest.quietWindow.sha256 && admission.endpoint === preflightRequest.endpoint, 'ADMISSION_WINDOW_ENDPOINT');
  assertWindow(quiet, now());
  const root = safePath(request.outputRoot, { directory: true, privateMode: true });
  guard(readdirSync(root).length === 0, 'CAMPAIGN_OUTPUT_NOT_FRESH');
  // Readiness/root/quiet records are inputs outside this fresh execution directory.
  for (const directory of ['campaigns', 'receipts', 'private', 'windows', 'options', 'events']) mkdirSync(path.join(root, directory), { mode: 0o700 });
  const save = (relative, value) => writeNewJson(path.join(root, relative), value, root);
  const bindingFields = sourceBindingOptions(freeze,'candidate');
  const baselineBindingFields = sourceBindingOptions(freeze,'baseline');
  const pairedBaselineFields=Object.fromEntries(Object.entries(baselineBindingFields).map(([key,value])=>['baseline'+key[0].toUpperCase()+key.slice(1),value]));
  const scope = scopeBinding(await readReference(freeze.observedEnvironment)); save('scope-binding.json', scope);
  const stageResults = []; let failure = null, broader = null, actualAttempts = 0, activeStage = null;
  const stageDirectory = name => path.join(root, 'campaigns', name);
  function usageInputs() {
    const directory = stageDirectory('usage'), journal = read(path.join(directory, 'journal.json'));
    guard(journal.closed === true && journal.result.passed === true && journal.attempts.length === 3, 'DISTINCT_COLD_PREREQUISITES');
    return { runs: journal.attempts.map(row => ({ directory: row.receiptDirectory, receiptDirectory: row.receiptDirectory,
      receiptManifestSha256: row.receiptManifestSha256, privateDirectory: path.join(root, 'private', row.run) })),
    campaign: { directory, contractSha256: undefined, journalSha256: undefined } };
  }
  async function distinctPrerequisites(forContract = false) {
    const { runs, campaign } = usageInputs(); campaign.contractSha256 = await hashFile(path.join(campaign.directory, 'contract.json')); campaign.journalSha256 = await hashFile(path.join(campaign.directory, 'journal.json'));
    return forContract ? { originalUsageReceiptManifestSha256s: runs.map(r => r.receiptManifestSha256), originalUsageCampaignContractSha256: campaign.contractSha256, originalUsageCampaignJournalSha256: campaign.journalSha256 }
      : { originalUsageRuns: runs, originalUsageCampaign: campaign };
  }
  async function comparisons() {
    const pairedReleaseComparisons = [];
    for (const name of ['sole', 'normal']) { const directory = stageDirectory(name), journal = read(path.join(directory, 'journal.json'));
      guard(journal.closed === true && journal.result.passed === true, 'PAIRED_RELEASE_COMPARISON_REQUIRED');
      pairedReleaseComparisons.push({ directory, closureSha256: await hashFile(path.join(directory, 'closure.json')),
        privateDirectories: journal.attempts.map(row => path.join(root, 'private', row.run)) }); }
    const historical = await verifyReference(request.historicalDiagnosticJournal, { root: relocation.inputRoot, privateMode: true });
    guard(request.historicalDiagnosticJournal.sha256 === freeze.historicalEvidence.originalClosedJournalSha256, 'HISTORICAL_DIAGNOSTIC_JOURNAL');
    return { pairedReleaseComparisons, preservedDiagnosticJournalFile: historical, preservedDiagnosticJournalSha256: request.historicalDiagnosticJournal.sha256 };
  }
  async function makeOptions(stage, profile, reservation) {
    const baseline = reservation.arm === 'A', kind = baseline ? 'baseline' : stage.name === 'distinct' ? 'distinct' : 'candidate';
    const helperRecord = freeze.helpers[kind], helper = await readReference(helperRecord);
    const schemaFile = baseline ? freeze.baselineSchema.file : freeze.schemaFile;
    const schemaReceipt = baseline ? freeze.baselineSchema.receipt : freeze.references['schema/lineage/schema-receipt.json'];
    const windowFile = path.join(root, 'windows', `${stage.name}-${reservation.source.slice(0, 8)}.json`);
    if (!existsSync(windowFile)) save(path.relative(root, windowFile), { ...quiet, schemaVersion: 1, source: reservation.source, profile: profile.name, productionActivationAuthorized: false });
    return { run: reservation.run, source: reservation.source, arm: reservation.arm, profile: profile.name,
      sourceDirectory: baseline ? freeze.baselineSourceDirectory : freeze.sourceDirectory,
      outputDirectory: path.join(root, 'receipts', reservation.run), privateDirectory: path.join(root, 'private', reservation.run), endpoint: preflightRequest.endpoint,
      postgresImage: freeze.postgresImage, redisImage: freeze.redisImage, helperImage: helper.helperImage, helperConfigDigest: helper.helperConfigDigest,
      helperBindingFile: helperRecord.path, helperBindingSha256: helperRecord.sha256, preparationFile: freeze.preparations[kind].path,
      schemaFile, schemaSha256: await hashFile(schemaFile), schemaReceiptFile: schemaReceipt.path, schemaReceiptSha256: schemaReceipt.sha256,
      observedEnvironmentFile: freeze.observedEnvironment.path, observedEnvironmentSha256: freeze.observedEnvironment.sha256, scopeBinding: scope,
      reservationFile: reservation.reservationFile, reservationSha256: reservation.reservationSha256, quietWindowFile: windowFile, quietWindowSha256: await hashFile(windowFile),
      ...(baseline ? baselineBindingFields : bindingFields),
      ...(['blackbox', 'diagnostic'].includes(profile.kind) ? { clientAdvertisementFile: freeze.references['paired-client-2.9.6/advertisement.json'].path,
        clientAdvertisementSha256: freeze.references['paired-client-2.9.6/advertisement.json'].sha256 } : {}),
      ...(profile.usage ? { snapshotDirectory: preflightRequest.fixture.directory, snapshotManifestSha256: preflightRequest.fixture.manifestSha256 } : {}),
      ...(stage.kind === 'usage' ? { usagePostVerificationContractSha256: freeze.usagePostVerification.sha256, hostHarnessSource: SOURCES.harness } : {}),
      ...(stage.kind === 'distinct' ? await distinctPrerequisites() : {}) };
  }
  try {
    for (const stage of STAGES) {
      activeStage = stage.name;
      assertWindow(quiet, now(), { entry: false });
      guard(schoolDate(now()) === context.fixture.snapshot.manifest.preparedSchoolLocalDate, 'FIXTURE_SCHOOL_DATE_CHANGED');
      for (const prior of stageResults) guard(prior.passed === true, 'PRIOR_STAGE_BLOCKS_CAMPAIGN');
      const directory = stageDirectory(stage.name), profile = canonical.PROFILES[stage.profile];
      canonical.declareCampaign({ directory, kind: stage.kind, profile: profile.name, candidateSource: SOURCES.candidate, baselineSource: SOURCES.baseline,
        observedFlagsSha256: freeze.observedFlagsSha256, ...bindingFields,
        ...(stage.kind==='paired'?pairedBaselineFields:{}),
        ...(stage.kind === 'usage' ? { usagePostVerificationContractSha256: freeze.usagePostVerification.sha256, hostHarnessSource: SOURCES.harness } : {}),
        ...(stage.kind === 'distinct' ? await distinctPrerequisites(true) : {}) });
      const contract = read(path.join(directory, 'contract.json')); assert.deepEqual(contract.order, expectedOrder(stage));
      let failedRun = null;
      for (let index = 0; index < stage.count; index++) {
        assertWindow(quiet, now(), { entry: false });
        const prior = read(path.join(directory, 'journal.json')); guard(prior.closed === false && prior.attempts.length === index && prior.attempts.every(row => row.state === 'recorded' && row.receipt.runPassed === true), 'FAILED_OR_RESERVED_ATTEMPT_BLOCKS_RETRY');
        const run = runId(); guard(/^[a-f0-9]{12}$/.test(run), 'INVALID_RUN_ID');
        const reservation = canonical.reserveAttempt({ directory, run, receiptDirectory: path.join(root, 'receipts', run), privateDirectory: path.join(root, 'private', run) });
        actualAttempts++; event({ event: 'attempt_started', stage: stage.name, index: index + 1, run, arm: reservation.arm, at: new Date(now()).toISOString() });
        let result;
        try { const options = await makeOptions(stage, profile, reservation); save(`options/${run}.json`, options); result = await canonical.runV2(options); }
        catch (error) { save(`events/${run}-failure.json`, safeFailure(error)); result = { runPassed: false, cleanupPassed: false, failure: 'RUN_PREPARATION_OR_EXECUTION_EXCEPTION' }; }
        const manifest = path.join(root, 'receipts', run, 'receipt-manifest.json'), manifestSha256 = existsSync(manifest) ? await hashFile(manifest) : '0'.repeat(64);
        const registered = canonical.registerAttempt({ directory, receiptDirectory: path.join(root, 'receipts', run), receiptManifestSha256: manifestSha256, privateDirectory: path.join(root, 'private', run) });
        save(`events/${run}-result.json`, { stage: stage.name, run, result, registered, receiptManifestSha256: manifestSha256, capacityAccepted: false });
        const record = read(path.join(directory, 'journal.json')).attempts.at(-1).receipt;
        event({ event: 'attempt_finished', stage: stage.name, index: index + 1, run, runPassed: record.runPassed === true });
        if (record.runPassed !== true) { failedRun = run; break; }
      }
      if (failedRun) { stageResults.push({ stage: stage.name, passed: false, blockedRun: failedRun, disposition: 'failed_attempt_retained' }); failure = 'INDIVIDUAL_GATE_FAILED'; break; }
      const journal = read(path.join(directory, 'journal.json'));
      const closure = canonical.closeCampaign({ directory, privateDirectories: journal.attempts.map(row => path.join(root, 'private', row.run)),
        ...(stage.kind === 'usage' ? await comparisons() : stage.kind === 'distinct' ? await distinctPrerequisites() : {}) });
      stageResults.push({ stage: stage.name, ...closure }); event({ event: 'campaign_closed', stage: stage.name, passed: closure.passed === true });
      if (closure.passed !== true) { failure = 'CLOSED_GATE_FAILED_OR_INCONCLUSIVE'; break; }
    }
    if (!failure && stageResults.length === STAGES.length) {
      const campaigns = [];
      for (const name of ['ordinary800', 'concentrated800']) { const directory = stageDirectory(name), journal = read(path.join(directory, 'journal.json'));
        campaigns.push({ directory, closureSha256: await hashFile(path.join(directory, 'closure.json')), privateDirectories: journal.attempts.map(row => path.join(root, 'private', row.run)) }); }
      broader = canonical.verifyBroaderGate({ campaigns }); save('broader-gate.json', broader);
      if (broader.passed !== true) failure = 'COMBINED_800_GATE_FAILED';
      assertWindow(quiet, now(), { entry: false });
    }
  } catch (error) { failure = 'CAMPAIGN_EXCEPTION'; if (activeStage && !stageResults.some(row => row.stage === activeStage)) stageResults.push({ stage: activeStage, passed: false, disposition: 'exception_retained' }); save('events/campaign-failure.json', safeFailure(error)); }
  const passed = failure === null && actualAttempts === 30 && stageResults.length === 8 && stageResults.every(row => row.passed === true) && broader?.passed === true;
  const result = { schemaVersion: 1, kind: 'usage_linux_full_campaign_result', freezeSha256: FREEZE_SHA256, source: SOURCES.candidate, baselineSource: SOURCES.baseline, harnessSource: SOURCES.harness,
    passed, actualAttempts, expectedAttempts: 30, stages: stageResults, unstartedStages: STAGES.slice(stageResults.length).map(row => row.name), failure,
    automaticRetries: false, originalThresholdsUnchanged: true, productionUsageMode: 'off/off',
    // Capacity evidence is subject to independent full receipt replay. Recovery remains a separate release blocker.
    capacityAccepted: false, recoveryReleaseBlockerPreserved: true, productionReadiness: false, operationalAuthorization: false };
  save('campaign-result.json', result); return result;
}
if (isMain(import.meta.url)) {
  try {
    const { request } = await readCliRequest('execute', 'usage_linux_campaign_request');
    const result = await executeCampaign(request); process.stdout.write(JSON.stringify({ passed: result.passed, actualAttempts: result.actualAttempts, capacityAccepted: false }) + '\n');
    process.exitCode = result.passed ? 0 : 2;
  } catch (error) { cliFailure(error); }
}
