import assert from 'node:assert/strict';
import {openSync, closeSync, writeFileSync, fsyncSync, readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, unlinkSync, existsSync} from 'node:fs';
import {resolve, join, dirname, basename, relative, isAbsolute, sep} from 'node:path';
import {canonicalHash, hash, loadBoundRun} from './receipt-loader.mjs';
import {validateCandidateRun, validateCandidateCampaign, CAMPAIGN_CONTRACT_SHA256} from './campaign-validation.mjs';
import {PROFILE} from './profile.mjs';
import {RELEASE_ENABLED_PROFILE} from '../release-enabled-profile.mjs';

// Local evidence ownership only. These functions never launch a fixture, enable
// candidate execution, or turn a diagnostic receipt into a capacity receipt.
// Retain returned trusted hashes outside the campaign directory. No automatic
// stale-lock recovery: an interrupted mutation requires explicit investigation.
const sha = value => assert.match(value, /^[a-f0-9]{64}$/);
const date = value => { assert.equal(typeof value, 'string'); const n = Date.parse(value); assert.ok(Number.isFinite(n)); return n; };
const json = value => JSON.stringify(value, null, 2) + '\n';
const now = () => new Date().toISOString();
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const prefix = ordinal => String(ordinal).padStart(3, '0');
const registrationName = ordinal => prefix(ordinal) + '.registration.json';
const completionName = ordinal => prefix(ordinal) + '.completion.json';
const disjoint = (a, b) => { for (const [parent, child] of [[a,b],[b,a]]) { const rel = relative(parent, child); assert.ok(rel && (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)), 'Campaign and run paths must be disjoint'); } };
function read(root, name, maximum = 8 * 1024 ** 2) {
  assert.match(name, /^[a-z0-9][a-z0-9.-]*\.json$/);
  const path = join(root, name), stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum);
  assert.equal(realpathSync(path), path);
  return readFileSync(path, 'utf8');
}
function write(root, name, raw) {
  const fd = openSync(join(root, name), 'wx', 0o600);
  try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
}
function locked(directory, work) {
  const root = realpathSync(directory), path = join(root, 'mutation.lock');
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, json({pid:process.pid})); fsyncSync(fd); return work(root); }
  finally { closeSync(fd); unlinkSync(path); }
}
function declarationCheck(campaign) {
  keys(campaign, ['mode','source','profile','phase','diagnosticOnly','identity','originalComparison']);
  assert.equal(campaign.mode, 'capacity-candidate'); assert.equal(campaign.profile, PROFILE);
  assert.equal(campaign.phase, 'combined'); assert.equal(campaign.diagnosticOnly, false);
  assert.match(campaign.source, /^[a-f0-9]{40}$/);
  // Use the validator's existing plan/identity checks, without inventing a
  // second schema. The other receipt groups intentionally have no inputs here.
  const plan = {schemaVersion:2,run:'0'.repeat(12),nonce:'0'.repeat(64),source:campaign.source,
    mode:campaign.mode,profile:campaign.profile,phase:campaign.phase,diagnosticOnly:false,cpuProfile:false,
    declaredAt:now(),campaignSha256:canonicalHash(campaign),ordinal:1,previousEntrySha256:canonicalHash(campaign),identity:campaign.identity};
  const planRaw = json(plan);
  const shape = validateCandidateRun({plan,planRaw,final:{source:campaign.source,clean:true,unchanged:true,harnessSha256:campaign.identity.harness.identity}}, hash(planRaw));
  assert.ok(!shape.failures.includes('plan'), 'Invalid campaign identity');
  assert.equal(campaign.identity.contractSha256, CAMPAIGN_CONTRACT_SHA256);
  const original = campaign.originalComparison;
  keys(original, ['source','schemaSha256','profile','phase','diagnosticOnly','collectApiCpuProfile','nodeOldSpaceMiB','scriptHashes']);
  assert.equal(original.source, campaign.source); assert.equal(original.schemaSha256, campaign.identity.schemaSha256);
  assert.equal(original.profile, RELEASE_ENABLED_PROFILE.name); assert.equal(original.phase, 'combined');
  assert.equal(original.diagnosticOnly, false); assert.equal(original.collectApiCpuProfile, false); assert.equal(original.nodeOldSpaceMiB, 512);
  for (const name of ['run-release-enabled-scale.ps1','release-enabled-scale.mjs','release-enabled-generator.mjs','release-enabled-process.mjs','release-enabled-profile.mjs']) sha(original.scriptHashes[name]);
  Object.values(original.scriptHashes).forEach(sha);
}
function state(root, trustedCampaignSha256) {
  sha(trustedCampaignSha256);
  const declaration = JSON.parse(read(root, 'campaign.json'));
  assert.equal(declaration.schemaVersion, 1); date(declaration.declaredAt);
  const campaign = declaration.campaign;
  assert.equal(canonicalHash(campaign), trustedCampaignSha256); declarationCheck(campaign);
  const files = readdirSync(root), registrations = [], attempts = [], outputs = new Set(), runs = new Set(), nonces = new Set();
  const registered = files.filter(name => /^\d{3}\.registration\.json$/.test(name));
  assert.ok(registered.length <= 100);
  let previous = trustedCampaignSha256, lastCleanup = date(declaration.declaredAt);
  for (let ordinal = 1; ordinal <= registered.length; ordinal++) {
    const raw = read(root, registrationName(ordinal)), r = JSON.parse(raw), p = JSON.parse(r.planRaw);
    assert.equal(r.schemaVersion, 1); assert.equal(r.campaignSha256, trustedCampaignSha256); assert.equal(r.ordinal, ordinal);
    assert.equal(r.previousEntrySha256, previous); assert.equal(p.previousEntrySha256, previous);
    assert.equal(hash(r.planRaw), r.planSha256); assert.equal(p.campaignSha256, trustedCampaignSha256);
    assert.equal(p.ordinal, ordinal); assert.equal(p.source, campaign.source); assert.deepEqual(p.identity, campaign.identity);
    for (const key of ['run','nonce']) assert.equal(p[key], r[key]);
    assert.match(r.run, /^[a-f0-9]{12}$/); assert.match(r.nonce, /^[a-f0-9-]{32,64}$/);
    assert.ok(!runs.has(r.run) && !nonces.has(r.nonce) && !outputs.has(r.outputDirectory));
    runs.add(r.run); nonces.add(r.nonce); outputs.add(r.outputDirectory);
    assert.ok(isAbsolute(r.outputDirectory)); disjoint(root, r.outputDirectory);
    assert.ok(ordinal === 1 ? date(r.registeredAt) >= lastCleanup : date(r.registeredAt) > lastCleanup); assert.equal(p.declaredAt, r.registeredAt);
    const registrationSha256 = hash(raw); registrations.push({...r,registrationSha256});
    const name = completionName(ordinal);
    if (!files.includes(name)) { assert.equal(ordinal, registered.length, 'Unfinished attempt before a later registration'); break; }
    const record = JSON.parse(read(root, name)), e = record.entry;
    assert.equal(record.schemaVersion, 1); assert.equal(e.registrationSha256, registrationSha256);
    for (const key of ['ordinal','run','nonce','registeredAt','previousEntrySha256','planSha256']) assert.equal(e[key], r[key]);
    const {entrySha256,...body} = e; assert.equal(entrySha256, canonicalHash(body)); previous = entrySha256;
    assert.ok(['completed','setup-failed','run-failed','aborted'].includes(e.status));
    assert.equal(hash(record.cleanupRaw), e.cleanupSha256);
    const cleanup = JSON.parse(record.cleanupRaw); assert.equal(cleanup.run, r.run);
    assert.equal(e.ownershipReleased, cleanup.cleanupPassed === true);
    assert.equal(e.cleanupFinishedAt, cleanup.finishedAt); assert.ok(date(e.cleanupFinishedAt) >= date(r.registeredAt));
    assert.ok(date(e.finishedAt) >= date(e.cleanupFinishedAt));
    if (e.status === 'completed') { sha(e.receiptManifestSha256); assert.equal(e.ownershipReleased, true); }
    else assert.match(e.failureCode, /^[A-Z][A-Z0-9_]{0,95}$/);
    attempts.push(e); lastCleanup = date(e.cleanupFinishedAt);
    if (!e.ownershipReleased) assert.equal(ordinal, registered.length, 'Unconfirmed ownership before a later attempt');
  }
  assert.equal(files.filter(name => /^\d{3}\.completion\.json$/.test(name)).length, attempts.length);
  return {campaign,declaration,registrations,attempts,previous,lastCleanup,runs,nonces,outputs};
}
function loadEntry(root, entry) {
  const raw = read(root, registrationName(entry.ordinal)), r = JSON.parse(raw);
  assert.equal(hash(raw), entry.registrationSha256);
  assert.equal(realpathSync(r.outputDirectory), r.outputDirectory);
  const loaded = loadBoundRun(r.outputDirectory, entry.receiptManifestSha256, entry.planSha256);
  assert.equal(loaded.bundle.planRaw, r.planRaw);
  const completion = JSON.parse(read(root, completionName(entry.ordinal)));
  assert.deepEqual(loaded.bundle.cleanup, JSON.parse(completion.cleanupRaw));
  return loaded;
}
function openState(root, trusted) {
  assert.equal(existsSync(join(root, 'journal.json')), false, 'Campaign journal is closed');
  return state(root, trusted);
}

export function createCampaign(directory, declaration) {
  const campaign = JSON.parse(json(declaration)); declarationCheck(campaign);
  const root = resolve(realpathSync(dirname(resolve(directory))), basename(directory));
  mkdirSync(root); // Refuse an existing directory; never adopt or rewrite history.
  const campaignRaw = json({schemaVersion:1,declaredAt:now(),campaign});
  write(root, 'campaign.json', campaignRaw);
  return {campaignRaw,campaignSha256:canonicalHash(campaign)};
}

export function registerAttempt(directory, options) {
  return locked(directory, root => {
    const s = openState(root, options.trustedCampaignSha256);
    assert.equal(s.registrations.length, s.attempts.length, 'Prior attempt is unfinished');
    assert.ok(s.attempts.every(e => e.ownershipReleased), 'Prior ownership is unconfirmed');
    assert.ok(s.registrations.length < 100); assert.equal(options.source, s.campaign.source);
    assert.match(options.run, /^[a-f0-9]{12}$/); assert.match(options.nonce, /^[a-f0-9-]{32,64}$/);
    assert.ok(!s.runs.has(options.run) && !s.nonces.has(options.nonce));
    assert.ok(isAbsolute(options.outputDirectory));
    const outputDirectory = resolve(realpathSync(dirname(options.outputDirectory)), basename(options.outputDirectory));
    disjoint(root, outputDirectory); assert.equal(existsSync(outputDirectory), false, 'Run output must be fresh'); assert.ok(!s.outputs.has(outputDirectory));
    const registeredAt = now(); assert.ok(s.attempts.length === 0 ? date(registeredAt) >= s.lastCleanup : date(registeredAt) > s.lastCleanup, 'Registration must follow owner cleanup');
    const ordinal = s.registrations.length + 1;
    const plan = {schemaVersion:2,run:options.run,nonce:options.nonce,source:s.campaign.source,mode:'capacity-candidate',profile:PROFILE,phase:'combined',diagnosticOnly:false,cpuProfile:false,
      declaredAt:registeredAt,campaignSha256:options.trustedCampaignSha256,ordinal,previousEntrySha256:s.previous,identity:s.campaign.identity};
    const planRaw = json(plan), planSha256 = hash(planRaw);
    const raw = json({schemaVersion:1,campaignSha256:options.trustedCampaignSha256,ordinal,run:options.run,nonce:options.nonce,registeredAt,previousEntrySha256:s.previous,outputDirectory,planRaw,planSha256});
    write(root, registrationName(ordinal), raw);
    return {plan,planRaw,planSha256,registrationSha256:hash(raw)};
  });
}

// Candidate owners consume only the current immutable pending registration.
// A caller-supplied plan or a completed diagnostic cannot stand in for it.
export function loadRegisteredAttempt(directory, options) {
  return locked(directory,root=>{
    const s=openState(root,options.trustedCampaignSha256),r=s.registrations.at(-1);
    assert.ok(r&&s.registrations.length===s.attempts.length+1,'No pending registered attempt');
    assert.equal(r.registrationSha256,options.registrationSha256);
    assert.equal(r.run,options.run);assert.equal(r.outputDirectory,resolve(options.outputDirectory));
    assert.equal(s.campaign.source,options.source);
    return {plan:JSON.parse(r.planRaw),planRaw:r.planRaw,planSha256:r.planSha256,registrationSha256:r.registrationSha256};
  });
}

export function finishAttempt(directory, options) {
  return locked(directory, root => {
    const s = openState(root, options.trustedCampaignSha256), r = s.registrations.at(-1);
    assert.ok(r && s.registrations.length === s.attempts.length + 1, 'No unfinished attempt');
    assert.equal(options.registrationSha256, r.registrationSha256);
    assert.ok(['completed','setup-failed','run-failed','aborted'].includes(options.status));
    assert.equal(typeof options.cleanupRaw, 'string'); assert.ok(Buffer.byteLength(options.cleanupRaw) <= 4 * 1024 ** 2);
    const cleanup = JSON.parse(options.cleanupRaw); assert.equal(cleanup.run, r.run);
    assert.equal(typeof cleanup.cleanupPassed, 'boolean'); assert.ok(date(cleanup.finishedAt) >= date(r.registeredAt));
    const finishedAt = now(); assert.ok(date(finishedAt) >= date(cleanup.finishedAt));
    if (options.status === 'completed') {
      sha(options.receiptManifestSha256); assert.equal(cleanup.cleanupPassed, true);
      assert.equal(realpathSync(r.outputDirectory), r.outputDirectory);
      const loaded = loadBoundRun(r.outputDirectory, options.receiptManifestSha256, r.planSha256);
      assert.equal(loaded.bundle.planRaw, r.planRaw); assert.deepEqual(loaded.bundle.cleanup, cleanup);
    } else assert.match(options.failureCode, /^[A-Z][A-Z0-9_]{0,95}$/);
    const entry = {ordinal:r.ordinal,run:r.run,nonce:r.nonce,registeredAt:r.registeredAt,previousEntrySha256:r.previousEntrySha256,registrationSha256:r.registrationSha256,planSha256:r.planSha256,
      status:options.status,finishedAt,cleanupFinishedAt:cleanup.finishedAt,cleanupSha256:hash(options.cleanupRaw),ownershipReleased:cleanup.cleanupPassed,
      ...(options.receiptManifestSha256 ? {receiptManifestSha256:options.receiptManifestSha256} : {}),...(options.status === 'completed' ? {} : {failureCode:options.failureCode})};
    if (entry.receiptManifestSha256) sha(entry.receiptManifestSha256);
    entry.entrySha256 = canonicalHash(entry);
    write(root, completionName(r.ordinal), json({schemaVersion:1,entry,cleanupRaw:options.cleanupRaw}));
    return entry;
  });
}

export function closeJournal(directory, {trustedCampaignSha256}) {
  return locked(directory, root => {
    const s = openState(root, trustedCampaignSha256);
    assert.ok(s.attempts.length > 0); assert.equal(s.registrations.length, s.attempts.length);
    assert.ok(s.attempts.every(e => e.ownershipReleased), 'Cannot close with unconfirmed owners');
    const closedAt = now(); assert.ok(date(closedAt) >= s.lastCleanup);
    for (const e of s.attempts) assert.ok(date(closedAt) >= date(e.finishedAt));
    for (const e of s.attempts) if (e.status === 'completed') loadEntry(root, e);
    const journalRaw = json({schemaVersion:2,campaign:s.campaign,attempts:s.attempts,closedAt});
    write(root, 'journal.json', journalRaw);
    return {journalRaw,trustedJournalSha256:hash(journalRaw),capacityAccepted:false};
  });
}

export function closeCampaign(directory, {trustedCampaignSha256,trustedJournalSha256,comparisonRaw}) {
  return locked(directory, root => {
    const s = state(root, trustedCampaignSha256), journalRaw = read(root, 'journal.json');
    sha(trustedJournalSha256); assert.equal(hash(journalRaw), trustedJournalSha256);
    const journal = JSON.parse(journalRaw);
    assert.deepEqual(journal.campaign, s.campaign); assert.deepEqual(journal.attempts, s.attempts);
    assert.equal(existsSync(join(root, 'closure.json')), false);
    const options = {journalRaw,trustedJournalSha256,trustedCampaignSha256,loadRun:entry => loadEntry(root, entry)};
    // Run the complete strict journal/ownership checks before preserving a
    // comparison. Missing comparison deliberately keeps overall acceptance false.
    const streak = validateCandidateCampaign(options);
    assert.ok(streak.lastThree.length === 3 && streak.lastThree.every(row => row.runPassed === true), 'Original comparison follows three consecutive successful candidates');
    assert.equal(typeof comparisonRaw, 'string'); assert.ok(Buffer.byteLength(comparisonRaw) <= 64 * 1024 ** 2);
    const receipt = JSON.parse(comparisonRaw), closedAt = now();
    assert.ok(date(receipt.metrics.startedAt) > date(journal.closedAt));
    assert.ok(date(receipt.metrics.finishedAt) >= date(receipt.metrics.startedAt));
    assert.ok(date(closedAt) >= date(receipt.metrics.finishedAt));
    const closureRaw = json({schemaVersion:1,campaignSha256:trustedCampaignSha256,journalSha256:trustedJournalSha256,
      comparisonDeclarationSha256:canonicalHash(s.campaign.originalComparison),comparisonReceiptSha256:hash(comparisonRaw),closedAt});
    // Preserve a failed comparison too. A separately validated false result is
    // final for this closure; retries require a new explicitly declared campaign.
    write(root, 'comparison.json', comparisonRaw); write(root, 'closure.json', closureRaw);
    const trustedClosureSha256 = hash(closureRaw);
    const validation = validateCandidateCampaign({...options,closureRaw,trustedClosureSha256,comparison:{raw:comparisonRaw,receipt}});
    return {closureRaw,trustedClosureSha256,validation};
  });
}
