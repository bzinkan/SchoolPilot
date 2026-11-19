import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateGuideReviewEvidence } from './classpilot-guide-review.mjs';

test('review evidence requires complete topic coverage and actual sources/checks', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'guide-review-'));
  try {
    await mkdir(path.join(repositoryRoot, 'src'));
    await writeFile(path.join(repositoryRoot, 'src', 'page.jsx'), 'fixture');
    await writeFile(path.join(repositoryRoot, 'check.test.mjs'), 'fixture');
    const review = { reviewedOn: '2026-11-18', basis: 'released-source-verified',
      sources: ['src/page.jsx', 'https://support.google.com/chrome/a/answer/1375678'],
      checks: ['check.test.mjs'], notes: 'Reviewed released behavior; device adoption is separate.' };
    const args = { repositoryRoot, asOf: '2026-11-18', topicsByGuide: {
      teacher: [{ id: 'class' }], admin: [{ id: 'setup' }],
    }, reviews: { teacher: { class: review }, admin: { setup: review } } };
    await validateGuideReviewEvidence(args);

    for (const [label, change, pattern] of [
      ['missing topic', a => { delete a.reviews.teacher.class; }, /coverage/],
      ['orphan topic', a => { a.reviews.teacher.obsolete = review; }, /coverage/],
      ['future review', a => { a.reviews.teacher.class.reviewedOn = '2026-11-19'; }, /future/],
      ['invalid date', a => { a.reviews.teacher.class.reviewedOn = '2026-02-30'; }, /date/],
      ['missing source', a => { a.reviews.teacher.class.sources = ['src/missing.jsx']; }, /reference/],
      ['outside repository', a => { a.reviews.teacher.class.sources = ['../outside']; }, /repository/],
      ['unsupported authority', a => { a.reviews.teacher.class.sources = ['https://example.com/policy']; }, /official/],
      ['empty checks', a => { a.reviews.teacher.class.checks = []; }, /checks/],
      ['unknown basis', a => { a.reviews.teacher.class.basis = 'tests-passed'; }, /basis/],
      ['unexplained limitation', a => { a.reviews.teacher.class.basis = 'unverified'; a.reviews.teacher.class.notes = ''; }, /notes/],
    ]) {
      const changed = structuredClone(args);
      change(changed);
      await assert.rejects(validateGuideReviewEvidence(changed), pattern, label);
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('unverified and live-observed evidence remain distinct from released-source review', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'guide-review-basis-'));
  try {
    await writeFile(path.join(repositoryRoot, 'observation.md'), 'fixture');
    const common = { reviewedOn: '2026-11-18', sources: ['observation.md'], checks: ['observation.md'], notes: 'Explicit basis and limits.' };
    await validateGuideReviewEvidence({ repositoryRoot, asOf: '2026-11-18',
      topicsByGuide: { teacher: [{ id: 'one' }], admin: [{ id: 'two' }] },
      reviews: { teacher: { one: { ...common, basis: 'live-observed' } }, admin: { two: { ...common, basis: 'unverified' } } },
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test('CI suite entrypoints remain reachable from the complete local release aggregate', async () => {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { scripts } = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  const workflow = await readFile(path.join(appRoot, '..', '.github', 'workflows', 'ci-build.yml'), 'utf8');
  const matrix = workflow.match(/shard:\s*\[([\d,\s]+)\]/);
  assert.ok(matrix, 'Release matrix must declare its shards');
  function entrypoints(name, seen = new Set()) {
    assert.ok(scripts[name], `Missing package script: ${name}`);
    if (seen.has(name)) return new Set();
    seen.add(name);
    const command = scripts[name];
    const files = new Set(command.match(/scripts\/[\w.-]+\.(?:mjs|py)/g) || []);
    for (const [, child] of command.matchAll(/npm run ([\w:-]+)/g)) {
      for (const file of entrypoints(child, seen)) files.add(file);
    }
    return files;
  }
  const local = entrypoints('test:release-focused');
  const ci = new Set(matrix[1].split(',').flatMap(shard => [...entrypoints(`test:release-focused:shard-${shard.trim()}`)]));
  assert.deepEqual([...ci].filter(file => !local.has(file)).sort(), [], 'Local release aggregate must include every CI suite entrypoint');
  assert.ok(ci.has('scripts/classpilot-guide-browser.test.mjs'), 'Guide browser checks must run in the CI release matrix');
});
