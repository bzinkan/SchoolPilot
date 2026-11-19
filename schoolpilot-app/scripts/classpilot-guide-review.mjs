import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';

const bases = new Set(['live-observed', 'released-source-verified', 'unverified']);
const officialHosts = new Set(['support.google.com', 'developers.google.com', 'chromeenterprise.google']);

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

async function validateReference(reference, repositoryRoot, allowOfficialUrl) {
  assert.equal(typeof reference, 'string', 'reference must be a path or official URL');
  if (/^https?:/i.test(reference)) {
    const url = new URL(reference);
    assert.ok(allowOfficialUrl && url.protocol === 'https:' && officialHosts.has(url.hostname)
      && !url.username && !url.password, `reference must use official documentation: ${reference}`);
    return;
  }
  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(root, reference);
  const relative = path.relative(root, resolved);
  assert.ok(reference && !path.isAbsolute(reference) && relative && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `reference must stay in repository: ${reference}`);
  try { await access(resolved); } catch { assert.fail(`reference does not exist: ${reference}`); }
}

/** Evidence is a review record, not a proof of deployment or continuing freshness. */
export async function validateGuideReviewEvidence({ repositoryRoot, topicsByGuide, reviews,
  asOf = new Date().toISOString().slice(0, 10) }) {
  assert.ok(validDate(asOf), 'asOf must be a valid date');
  assert.deepEqual(Object.keys(reviews).sort(), Object.keys(topicsByGuide).sort(), 'guide coverage must match');
  for (const [guide, topics] of Object.entries(topicsByGuide)) {
    assert.deepEqual(Object.keys(reviews[guide]).sort(), topics.map(topic => topic.id).sort(), `${guide} topic coverage must match`);
    for (const [id, review] of Object.entries(reviews[guide])) {
      const label = `${guide}/${id}`;
      assert.ok(review && validDate(review.reviewedOn), `${label}: review date must be a valid calendar date`);
      assert.ok(review.reviewedOn <= asOf, `${label}: review date cannot be in the future`);
      assert.ok(bases.has(review.basis), `${label}: unknown verification basis`);
      assert.ok(typeof review.notes === 'string' && review.notes.trim(), `${label}: notes must explain checked behavior and limits`);
      for (const [field, allowOfficialUrl] of [['sources', true], ['checks', false]]) {
        assert.ok(Array.isArray(review[field]) && review[field].length, `${label}: ${field} must be nonempty`);
        for (const reference of review[field]) await validateReference(reference, repositoryRoot, allowOfficialUrl);
      }
    }
  }
}
