import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeCampaign, scopeBinding } from './run-campaign.mjs';
import { STAGES, PAIRED_ORDER, schoolDate } from './preflight.mjs';
import { FREEZE_SHA256, SOURCES, sha256, hashFile } from './relocation.mjs';

const now = Date.parse('2026-10-12T12:00:00Z');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
function put(root, name, value) { const bytes = JSON.stringify(value), file = path.join(root, name); writeFileSync(file, bytes, { mode: 0o600 }); return { path: file, sha256: sha256(bytes) }; }
async function fixture(t, { failedRun, inconclusiveStage, throwsRun } = {}) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(path.join(parent, 'usage-linux-campaign-'));
  t.after(() => { const resolved = realpathSync(root); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^usage-linux-campaign-/); rmSync(resolved, { recursive: true }); });
  const outputRoot = path.join(root, 'execution'); mkdirSync(outputRoot, { mode: 0o700 });
  const env = put(root, 'env', { definitions: [{ service: 'schoolpilot-production-api', environment: {} }] });
  const historical = put(root, 'historical', { closed: true, passed: false });
  const helper = put(root, 'helper', { helperImage: `sha256:${'1'.repeat(64)}`, helperConfigDigest: `sha256:${'2'.repeat(64)}` });
  const schema = put(root, 'schema', { synthetic: true }), receipt = put(root, 'schema-receipt', {});
  const quiet = { startsAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 5 * 3600_000).toISOString(), serialExecution: true, noOtherLoadOrBuilds: true };
  const quietRef = put(root, 'quiet', quiet);
  const preflightRequest = put(root, 'preflight', { schemaVersion: 1, kind: 'usage_linux_preflight_request', endpoint: 'unix:///var/run/docker.sock', quietWindow: quietRef, fixture: { directory: root, manifestSha256: '3'.repeat(64) }, sourceRestoration:{outputRoot:path.join(root,'source-checks')} });
  const toolSha256 = {};
  for (const name of ['relocation', 'preflight', 'run-campaign', 'source-checkout']) toolSha256[name] = await hashFile(path.join(path.dirname(fileURLToPath(import.meta.url)), `${name}.mjs`));
  const intent = put(root, 'intent', { kind: 'usage_linux_campaign_intent', stages: STAGES, expectedAttempts: 30, serialExecution: true, automaticRetries: false, preflightRequestSha256: preflightRequest.sha256, outputRoot, toolSha256 });
  const admission = put(root, 'admission', { kind: 'usage_linux_measurement_admission', preflightRequestSha256: preflightRequest.sha256, freezeSha256: FREEZE_SHA256,
    campaignRequestSha256: intent.sha256, endpoint: 'unix:///var/run/docker.sock', quietWindowSha256: quietRef.sha256 });
  const review = (kind, subjectSha256, file) => put(root, file, { schemaVersion: 1, kind, subjectSha256, disposition: 'reviewed_for_synthetic_execution', reviewer: 'Independent synthetic test reviewer', reviewedAtUtc: new Date(now).toISOString(), capacityAccepted: false, productionReadiness: false, operationalAuthorization: false });
  const request = { schemaVersion: 1, kind: 'usage_linux_campaign_request', outputRoot, preflightRequest, campaignIntent: intent, campaignIntentSha256: intent.sha256,
    measurementAdmission: admission, independentExecutionReview: review('usage_linux_execution_review', intent.sha256, 'execution-review'),
    independentAdmissionReview: review('usage_linux_measurement_admission_review', admission.sha256, 'admission-review'), historicalDiagnosticJournal: historical };
  const calls = [], closures = [], events = [], pending = new Map();
  const canonical = {
    PROFILES: Object.fromEntries(STAGES.map(row => [row.profile, { name: row.profile, kind: row.kind === 'paired' ? 'blackbox' : row.kind, usage: ['usage', 'distinct'].includes(row.name) }])),
    declareCampaign(options) {
      const stage = STAGES.find(row => row.name === path.basename(options.directory));
      if(stage.kind==='paired')assert.equal(options.baselineUsageSourceBindingSha256,'a'.repeat(64));
      else assert.equal(options.baselineUsageSourceBindingSha256,undefined);
      if (stage.name === 'distinct') { assert.equal(options.originalUsageReceiptManifestSha256s.length, 3); assert.equal(new Set(options.originalUsageReceiptManifestSha256s).size, 3); }
      mkdirSync(options.directory, { mode: 0o700 }); put(options.directory, 'contract.json', { order: stage.kind === 'paired' ? PAIRED_ORDER : Array(stage.count).fill('C') }); put(options.directory, 'journal.json', { attempts: [], closed: false });
    },
    reserveAttempt(options) {
      const journal = read(path.join(options.directory, 'journal.json')), order = read(path.join(options.directory, 'contract.json')).order, arm = order[journal.attempts.length];
      const reservation = { run: options.run, arm, source: arm === 'A' ? SOURCES.baseline : SOURCES.candidate, reservationFile: path.join(options.directory, `${options.run}.json`), reservationSha256: '4'.repeat(64) };
      journal.attempts.push({ ...reservation, receiptDirectory: options.receiptDirectory, state: 'reserved' }); put(options.directory, 'journal.json', journal); return reservation;
    },
    async runV2(options) {
      calls.push(options); const index = calls.length;
      assert.equal(options.endpoint, 'unix:///var/run/docker.sock'); assert.equal(options.acceptanceSuccessor, undefined); assert.equal(options.preparationSmoke, undefined);
      if (options.arm === 'A') assert.equal(options.usageSourceBindingSha256, 'a'.repeat(64)); else assert.equal(options.usageSourceBindingSha256, '5'.repeat(64));
      if (options.profile === 'distinct') assert.equal(options.originalUsageRuns.length, 3);
      if (index === throwsRun) throw new Error('SECRET SQL MUST NOT ENTER STDOUT');
      mkdirSync(options.outputDirectory, { mode: 0o700 }); put(options.outputDirectory, 'receipt-manifest.json', { run: options.run });
      pending.set(options.run, index !== failedRun); return { runPassed: index !== failedRun };
    },
    registerAttempt(options) {
      const journal = read(path.join(options.directory, 'journal.json')), row = journal.attempts.at(-1);
      row.state = 'recorded'; row.receiptManifestSha256 = options.receiptManifestSha256; row.receipt = { runPassed: pending.get(row.run) === true }; put(options.directory, 'journal.json', journal); return row.receipt;
    },
    closeCampaign(options) {
      const stage = path.basename(options.directory); closures.push({ stage, options });
      if (stage === 'usage') { assert.equal(options.pairedReleaseComparisons.length, 2); assert.equal(options.preservedDiagnosticJournalSha256, historical.sha256); }
      const journal = read(path.join(options.directory, 'journal.json')); journal.closed = true; journal.result = { passed: stage !== inconclusiveStage }; put(options.directory, 'journal.json', journal); put(options.directory, 'closure.json', journal.result); return journal.result;
    },
    verifyBroaderGate(options) { assert.equal(options.campaigns.length, 2); return { passed: true }; },
  };
  const freeze = { helpers: Object.fromEntries(['candidate', 'baseline', 'distinct'].map(k => [k, helper])), preparations: Object.fromEntries(['candidate', 'baseline', 'distinct'].map(k => [k, helper])),
    sourceDirectory: root, baselineSourceDirectory: root, schemaFile: schema.path, baselineSchema: { file: schema.path, receipt },
    references: { 'schema/lineage/schema-receipt.json': receipt, 'paired-client-2.9.6/advertisement.json': helper },
    observedEnvironment: env, historicalEvidence: { originalClosedJournalSha256: historical.sha256 }, usagePostVerification: { sha256: '6'.repeat(64) },
    usageSourceBindingFile: schema.path, usageSourceBindingSha256: '5'.repeat(64), usageSourceReviewFile: schema.path, usageSourceReviewSha256: '7'.repeat(64),
    baselineUsageSourceBindingFile: schema.path, baselineUsageSourceBindingSha256: 'a'.repeat(64), baselineUsageSourceReviewFile: schema.path, baselineUsageSourceReviewSha256: 'b'.repeat(64),
    postgresImage: `sha256:${'8'.repeat(64)}`, redisImage: `sha256:${'9'.repeat(64)}` };
  let index = 0;
  const dependencies = { preflight: async () => ({ freeze, canonical, quiet, relocation: { inputRoot: root }, fixture: { snapshot: { manifest: { preparedSchoolLocalDate: schoolDate(now) } } } }),
    now: () => now, runId: () => (++index).toString(16).padStart(12, '0'), event: e => events.push(e) };
  return { request, dependencies, calls, closures, events, root };
}
test('unchanged eight-stage thirty-run sequence uses canonical paired order and fresh distinct cold prerequisites', async t => {
  const f = await fixture(t), result = await executeCampaign(f.request, f.dependencies);
  assert.equal(result.passed, true); assert.equal(result.actualAttempts, 30); assert.equal(result.capacityAccepted, false); assert.equal(result.recoveryReleaseBlockerPreserved, true);
  assert.deepEqual(f.calls.slice(0, 8).map(row => row.arm), PAIRED_ORDER); assert.deepEqual(f.calls.slice(8, 16).map(row => row.arm), PAIRED_ORDER);
  assert.deepEqual(f.closures.map(row => row.stage), STAGES.map(row => row.name)); assert.equal(new Set(f.calls.map(row => row.run)).size, 30);
  assert.deepEqual(result.unstartedStages, []);
});

test('source verification logs cannot occupy or contain the fresh campaign output',async t=>{
  const f=await fixture(t);
  for(const outputRoot of [f.request.outputRoot,path.dirname(f.request.outputRoot),path.join(f.request.outputRoot,'logs')]){
    const original=read(f.request.preflightRequest.path);
    const changed=put(f.root,'overlapping-preflight',{...original,sourceRestoration:{outputRoot}});
    await assert.rejects(executeCampaign({...f.request,preflightRequest:changed},f.dependencies),/SOURCE_LOG_ROOT_OVERLAP/);
  }
  assert.equal(f.calls.length,0);
});
test('one failed receipt stops immediately and keeps every later stage unstarted without retry', async t => {
  const f = await fixture(t, { failedRun: 4 }), result = await executeCampaign(f.request, f.dependencies);
  assert.equal(result.passed, false); assert.equal(f.calls.length, 4); assert.equal(result.actualAttempts, 4); assert.equal(f.closures.length, 0);
  assert.deepEqual(result.unstartedStages, STAGES.slice(1).map(row => row.name));
  const journal = read(path.join(f.request.outputRoot, 'campaigns', 'sole', 'journal.json')); assert.equal(journal.attempts.at(-1).receipt.runPassed, false);
  await assert.rejects(executeCampaign(f.request, f.dependencies), /CAMPAIGN_OUTPUT_NOT_FRESH/);
});
test('all individually passing controls with inconclusive closure never admit next stage or accepted capacity', async t => {
  const f = await fixture(t, { inconclusiveStage: 'sole' }), result = await executeCampaign(f.request, f.dependencies);
  assert.equal(f.calls.length, 8); assert.equal(result.passed, false); assert.equal(result.failure, 'CLOSED_GATE_FAILED_OR_INCONCLUSIVE'); assert.equal(result.capacityAccepted, false);
});
test('exception preserves failed reservation/receipt and never emits secret-bearing first error line', async t => {
  const f = await fixture(t, { throwsRun: 1 }), result = await executeCampaign(f.request, f.dependencies);
  assert.equal(result.actualAttempts, 1); assert.equal(result.passed, false);
  assert.equal(JSON.stringify(f.events).includes('SECRET'), false);
  const failure = read(path.join(f.request.outputRoot, 'events', '000000000001-failure.json')); assert.equal(JSON.stringify(failure).includes('SECRET'), false);
});
test('unreviewed or modified intent fails before canonical run and creates no measured outputs', async t => {
  const f = await fixture(t); f.request.campaignIntentSha256 = '0'.repeat(64);
  await assert.rejects(executeCampaign(f.request, f.dependencies), /INDEPENDENT_REVIEW_BINDING/); assert.equal(f.calls.length, 0);
});
test('scope mapping never discards third production school scope', () => {
  const capture = { definitions: [{ service: 'schoolpilot-production-api', environment: { TEST_SCHOOL_IDS: 'a,b,c' } }] };
  assert.throws(() => scopeBinding(capture), /OBSERVED_SCHOOL_SCOPE_OVERFLOW/);
});
