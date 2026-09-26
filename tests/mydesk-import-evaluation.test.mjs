import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectionMatches, evaluationMetrics, generateEvaluation, runEvaluationCli, runProviderEvaluation } from '../scripts/evaluate-mydesk-import.mjs';

let directory, template, pages, generated;
const config = { model: 'fixture-model' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const rejectsCode = code => error => error.evaluationCode === code && !String(error.stack).includes('PRIVATE_PROVIDER');

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mydesk-eval-unit-')); template = join(directory, 'offline');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Offline generation must never call a provider'); };
  try { generated = await generateEvaluation(template, config); } finally { globalThis.fetch = originalFetch; }
  pages = await readJson(join(template, 'expected.json'));
});
after(async () => { await rm(directory, { recursive: true, force: true }); });
async function cloned(name) { const target = join(directory, name); await cp(template, target, { recursive: true }); return target; }
function fakeAi({ failDetectionAt = -1, empty = false } = {}) {
  const byHash = new Map(pages.map(page => [page.sha256, page]));
  const expected = [...new Map(pages.flatMap(page => page.forms.map(form => [form.id, form]))).values()];
  let detectionCalls = 0, extractionCalls = 0, joined = 0;
  return {
    get counts() { return { detectionCalls, extractionCalls, joined }; },
    async detectImportForms(bytes) {
      detectionCalls++;
      if (detectionCalls === failDetectionAt) throw new Error('PRIVATE_PROVIDER request key source content');
      const page = byHash.get(digest(bytes)); assert.ok(page);
      return empty ? [] : page.forms.map(form => form.region);
    },
    async extractImportForm(crops) {
      if (crops.length > 1) joined++;
      const form = expected[extractionCalls++];
      return { subjectNames: form.subjectNames, entryDate: form.entryDate, category: form.category, title: 'Synthetic title',
        body: 'Staff reported an event. The student disputed it.', warnings: [] };
    },
  };
}

test('offline evaluation creates a new private corpus with immutable hashes and explicit pending human evidence', async () => {
  assert.equal(generated.providerCalled, false); assert.equal(generated.sourcePages, 34);
  assert.equal(generated.expectedFormRegions, 64); assert.equal(generated.expectedLogicalForms, 62);
  assert.equal(generated.acceptance, 'pending_human_review'); assert.equal(generated.automatedTypedThresholdsMet, null);
  const manifest = await readJson(join(template, 'manifest.json'));
  assert.equal(manifest.model, 'fixture-model'); assert.match(manifest.promptVersion, /^mydesk-forms-/);
  assert.ok(manifest.limitations.some(text => text.includes('cursive font renders do not establish handwriting accuracy')));
  assert.ok(manifest.limitations.some(text => text.includes('Android')));
  assert.ok(pages.some(page => page.rotation === 270)); assert.ok(pages.some(page => page.family === 'simulated-poor-photo'));
  assert.ok(pages.some(page => page.forms.length === 0)); assert.ok(pages.some(page => page.forms.some(form => form.subjectNames.length > 1)));
  assert.ok(pages.some(page => page.forms.some(form => form.entryDate === null)));
  for (const page of pages) assert.equal(digest(await readFile(join(template, page.file))), page.sha256);
  const human = await readJson(join(template, 'human-review.json'));
  assert.ok(Object.values(human.criticalFailures).every(value => value === null));
  assert.equal(human.actualHandwrittenInventedSamplesReviewed, false); assert.equal(human.medianImportReviewSeconds, null);
  await assert.rejects(generateEvaluation(template, config), rejectsCode('OUTPUT_ALREADY_EXISTS_USE_RESUME'));
  assert.equal((await readdir(join(template, 'checkpoints'))).length, 0);
});

test('detection scores penalize duplicates, extra forms and omissions separately from difficult key-field accuracy', () => {
  const region = { x: 0, y: 0, width: 0.4, height: 0.4 };
  const matches = detectionMatches([{ region }], [region, region, { x: 0.6, y: 0.6, width: 0.2, height: 0.2 }]);
  assert.equal(matches.length, 1);
  const metrics = evaluationMetrics([
    { difficulty: 'typed', expectedCount: 2, detectedCount: 3, matchedCount: 1 },
    { difficulty: 'difficult', expectedCount: 1, detectedCount: 1, matchedCount: 1 },
  ], [
    { difficulty: 'typed', fieldChecks: { subjectNames: true, entryDate: true, category: true } },
    { difficulty: 'typed', fieldChecks: null },
    { difficulty: 'difficult', fieldChecks: { subjectNames: false, entryDate: false, category: false } },
  ]);
  assert.equal(metrics.typed.precision, 1 / 3); assert.equal(metrics.typed.recall, 0.5);
  assert.equal(metrics.typed.falsePositivesIncludingDuplicates, 2); assert.equal(metrics.typed.missedRegions, 1);
  assert.equal(metrics.typed.exactFieldAccuracy.subjectNames, 0.5);
  assert.equal(metrics.difficult.recall, 1); assert.equal(metrics.difficult.exactFieldAccuracy.entryDate, 0);
});

test('checkpointed synthetic run scores typed and difficult subsets but never autoapproves; resume makes zero duplicate calls', async () => {
  const target = await cloned('complete'), ai = fakeAi();
  const report = await runProviderEvaluation(target, { ...config, ai });
  assert.deepEqual(ai.counts, { detectionCalls: 34, extractionCalls: 62, joined: 2 });
  assert.equal(report.metrics.typed.precision, 1); assert.equal(report.metrics.typed.recall, 1);
  assert.equal(report.metrics.difficult.exactFieldAccuracy.subjectNames, 1);
  assert.equal(report.automatedTypedThresholdsMet, true); assert.equal(report.acceptance, 'pending_human_review');
  assert.equal(report.unsupportedStatementReview, 'pending human review');
  const checkpointCount = (await readdir(join(target, 'checkpoints'))).length; assert.equal(checkpointCount, 96);
  const noCalls = { detectImportForms() { assert.fail('Completed detection repeated'); }, extractImportForm() { assert.fail('Completed extraction repeated'); } };
  const resumed = await runProviderEvaluation(target, { ...config, ai: noCalls });
  assert.deepEqual(resumed.metrics, report.metrics);
  assert.equal(resumed.fixtureManifestSha256, report.fixtureManifestSha256);
  const checkpointFile = join(target, 'checkpoints', 'detect-page-01.json');
  const checkpoint = await readJson(checkpointFile); checkpoint.result = []; await writeFile(checkpointFile, JSON.stringify(checkpoint));
  await assert.rejects(runProviderEvaluation(target, { ...config, ai: noCalls }), rejectsCode('CHECKPOINT_RESULT_MISMATCH'));
});

test('uncertain paid calls require explicit retry, while successful earlier calls stay checkpointed and provider errors stay private', async () => {
  const target = await cloned('interrupted'), ai = fakeAi({ failDetectionAt: 2 });
  await assert.rejects(runProviderEvaluation(target, { ...config, ai }), rejectsCode('PROVIDER_RESULT_UNAVAILABLE'));
  assert.equal(ai.counts.detectionCalls, 2);
  const saved = await readFile(join(target, 'checkpoints', 'detect-page-02.json'), 'utf8');
  assert.ok(!saved.includes('PRIVATE_PROVIDER')); assert.equal(JSON.parse(saved).status, 'uncertain');
  const blocked = fakeAi();
  await assert.rejects(runProviderEvaluation(target, { ...config, ai: blocked }), rejectsCode('UNCERTAIN_CALL_REQUIRES_EXPLICIT_RETRY'));
  assert.deepEqual(blocked.counts, { detectionCalls: 0, extractionCalls: 0, joined: 0 });
  // Empty detection minimizes fixture work here; the completed page-one call remains reused.
  const retry = fakeAi({ empty: true });
  await runProviderEvaluation(target, { ...config, ai: retry, retryUncertain: true });
  assert.equal(retry.counts.detectionCalls, 33);
  assert.equal((await readJson(join(target, 'checkpoints', 'detect-page-01.json'))).attempts, 1);
  assert.equal((await readJson(join(target, 'checkpoints', 'detect-page-02.json'))).attempts, 2);
});

test('changed source/model and concurrent runners fail before making any provider call', async () => {
  const target = await cloned('tampered');
  const noCalls = { detectImportForms() { assert.fail('Provider called'); }, extractImportForm() { assert.fail('Provider called'); } };
  await assert.rejects(runProviderEvaluation(target, { model: 'different-model', ai: noCalls }), rejectsCode('EVALUATION_VERSION_MISMATCH'));
  await writeFile(join(target, '.evaluation.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(runProviderEvaluation(target, { ...config, ai: noCalls }), rejectsCode('EVALUATION_LOCKED'));
  await rm(join(target, '.evaluation.lock'));
  await writeFile(join(target, 'page-01.png'), 'changed synthetic source');
  await assert.rejects(runProviderEvaluation(target, { ...config, ai: noCalls }), rejectsCode('FIXTURE_HASH_MISMATCH'));
  await assert.rejects(runEvaluationCli(['--output', target, '--retry-uncertain']), rejectsCode('INVALID_ARGUMENTS'));
});
