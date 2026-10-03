import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
export const hash = value => createHash('sha256').update(value).digest('hex');
const names = Object.freeze(['plan', 'metrics', 'preparation', 'cold', 'gate', 'execution', 'final', 'candidate', 'runtime', 'roles', 'cleanup', 'database', 'runtimeFlags']);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const canonicalHash = value => hash(JSON.stringify(canonical(value)));
// Proposal only: every receipt must be emitted by its independently bound owner,
// not constructed from post-hoc booleans. This loader has no Docker/SQL side effects.
// Callers retain the pre-fixture trusted plan hash outside the result directory.
export function loadBoundRun(directory, trustedManifestSha256, trustedPlanSha256) {
  assert.ok(hex(trustedManifestSha256) && hex(trustedPlanSha256));
  const root = realpathSync(directory);
  const read = (file, maximum) => {
    assert.ok(typeof file === 'string' && /^[a-z0-9][a-z0-9.-]*\.json$/.test(file));
    const target = realpathSync(resolve(root, file)), rel = relative(root, target);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    const stat = statSync(target); assert.ok(stat.isFile() && stat.size > 0 && stat.size <= maximum);
    return readFileSync(target);
  };
  const rawManifest = read('receipt-manifest.json', 64 * 1024);
  assert.equal(hash(rawManifest), trustedManifestSha256);
  const manifest = JSON.parse(rawManifest);
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(Object.keys(manifest.records).sort(), [...names].sort());
  const bundle = {}, files = new Set(); let total = 0, cleanupRaw;
  for (const name of names) {
    const row = manifest.records[name];
    assert.deepEqual(Object.keys(row).sort(), ['file', 'sha256']);
    assert.ok(hex(row.sha256) && !files.has(row.file)); files.add(row.file);
    const raw = read(row.file, name === 'metrics' ? 64 * 1024 ** 2 : 4 * 1024 ** 2);
    total += raw.length; assert.ok(total <= 96 * 1024 ** 2); assert.equal(hash(raw), row.sha256);
    bundle[name] = JSON.parse(raw); if (name === 'plan') bundle.planRaw = raw.toString('utf8');
    if (name === 'cleanup') cleanupRaw = raw.toString('utf8');
  }
  assert.equal(hash(bundle.planRaw), trustedPlanSha256);
  return Object.freeze({ bundle, trustedPlanSha256, receiptManifestSha256: trustedManifestSha256, cleanupRaw });
}
// The journal is registered BEFORE fixture creation. All attempts, including
// setup errors, remain in order. A failed/unfinished attempt interrupts the streak.
// trustedJournalSha256 is retained independently by the campaign owner at closure.
export function validateCampaign({ journalRaw, trustedJournalSha256, trustedCampaignSha256, loadRun, validateRun }) {
  assert.ok(hex(trustedJournalSha256) && hex(trustedCampaignSha256));
  assert.equal(hash(journalRaw), trustedJournalSha256);
  const journal = JSON.parse(journalRaw); assert.equal(journal.schemaVersion, 2);
  assert.equal(canonicalHash(journal.campaign), trustedCampaignSha256);
  assert.equal(journal.campaign.mode, 'capacity-candidate');
  assert.ok(Array.isArray(journal.attempts) && journal.attempts.length >= 3 && journal.attempts.length <= 100);
  let previous = trustedCampaignSha256; const runs = new Set(), nonces = new Set(), fixtures = new Set();
  const results = [];
  for (const [index, entry] of journal.attempts.entries()) {
    assert.equal(entry.ordinal, index + 1); assert.equal(entry.previousEntrySha256, previous);
    const { entrySha256, ...body } = entry; assert.equal(entrySha256, canonicalHash(body)); previous = entrySha256;
    assert.ok(!runs.has(entry.run) && !nonces.has(entry.nonce)); runs.add(entry.run); nonces.add(entry.nonce);
    assert.ok(Number.isFinite(Date.parse(entry.registeredAt)));
    if (entry.status !== 'completed') { assert.ok(['setup-failed','run-failed','aborted'].includes(entry.status)); results.push({runPassed:false}); continue; }
    const loaded = loadRun(entry); const p = loaded.bundle.plan;
    assert.equal(p.run, entry.run); assert.equal(p.nonce, entry.nonce); assert.equal(p.campaignSha256, trustedCampaignSha256);
    assert.equal(p.ordinal, entry.ordinal); assert.equal(p.previousEntrySha256, entry.previousEntrySha256);
    assert.equal(p.source, journal.campaign.source); assert.equal(canonicalHash(p.identity), canonicalHash(journal.campaign.identity));
    assert.ok(Date.parse(entry.registeredAt) <= Date.parse(p.declaredAt));
    assert.ok(Date.parse(p.declaredAt) < Date.parse(loaded.bundle.preparation.startedAt));
    assert.ok(!fixtures.has(loaded.bundle.preparation.pgContainerId)); fixtures.add(loaded.bundle.preparation.pgContainerId);
    const result = validateRun(loaded.bundle, loaded.trustedPlanSha256); results.push(result);
  }
  const lastThree = results.slice(-3);
  return { schemaVersion:2, capacityAccepted:lastThree.length === 3 && lastThree.every(row => row.runPassed === true),
    productionReadiness:false, campaignSha256:trustedCampaignSha256, journalSha256:trustedJournalSha256,
    attempts:results.length, lastThree, limitations:['Bounded synthetic capacity only; production RDS, deployed shadow days and real-browser acceptance remain separate.'] };
}
