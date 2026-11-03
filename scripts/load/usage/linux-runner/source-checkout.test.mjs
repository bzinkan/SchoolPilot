import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, sha256 } from './relocation.mjs';
import { assertSourceRestorationMetadata, assertCanonicalGitEnvironment, sourceGitEnvironment, loadSourceRestoration, verifyCheckout } from './source-checkout.mjs';

function metadata() {
  const destination = '/srv/usage/work/sources-123456abcdef';
  const members = ['schoolpilot-app/android-gopilot/gradlew', 'schoolpilot-app/android-passpilot/gradlew'].map(name => ({ path: name, sha256: sha256(name), gitMode: '100755', gitBlobOid: 'd'.repeat(40) }));
  const roles = Object.fromEntries(Object.entries(SOURCES).map(([role, source]) => [role, { source, tree: 'c'.repeat(40), files: 2, members, membersSha256: sha256(JSON.stringify(members.map(r => [r.path, r.sha256]))), archivePrefix: role === 'baseline' ? 'baseline-source/' : '' }]));
  const shallowHeads = Object.values(SOURCES).sort();
  const plan = { schemaVersion: 1, kind: 'usage_current_exact_head_git_transfer', parentHistoryIncluded: false, coreFileMode: false, workingFileMode: '0600', gitObjectModesPreserved: true, roles, shallowHeads, objects: [...shallowHeads.map(oid => ({ oid, type: 'commit', bytes: 123, payloadSha256: 'f'.repeat(64) })), { oid: '1'.repeat(40), type: 'tree', bytes: 100, payloadSha256: 'f'.repeat(64) }].sort((a,b) => a.oid.localeCompare(b.oid)) };
  const request = { schemaVersion: 1, kind: 'usage_linux_exact_source_restore_request', destination };
  const receipt = { schemaVersion: 1, kind: 'usage_current_native_linux_source_reconstruction', passed: true, capacityAccepted: false, productionReadiness: false, roles: Object.fromEntries(Object.entries(roles).map(([role, record]) => [role, { ...record, path: `${destination}/${role}`, coreFileMode: false, privateWorkingFiles0600: true, cleanDetachedGit: true, parentHistoryIncluded: false, shallowHeads }])) };
  const review = { schemaVersion: 1, kind: 'usage_current_native_source_restoration_review', passed: true, unresolvedFindings: 0, reviewer: 'independent synthetic test', reviewedAtUtc: '2026-10-12T22:00:00Z', nativeLinuxRestorationProven: true, disposition: 'reviewed_for_synthetic_execution', capacityAccepted: false, productionReadiness: false };
  return { receipt, review, request, plan };
}
function check(data) { assertSourceRestorationMetadata(data.receipt, data.review, data.request, data.plan); }
test('source admission requires reviewed native restoration with exact three identities and original Git modes', () => check(metadata()));
for (const [name, mutate] of [
  ['unproven native restore', x => { x.review.nativeLinuxRestorationProven = false; }],
  ['unreviewed receipt', x => { x.review.kind = 'source_only_review'; }],
  ['wrong source', x => { x.plan.roles.candidate.source = '1'.repeat(40); }],
  ['different tree', x => { x.receipt.roles.baseline.tree = '1'.repeat(40); }],
  ['history widening', x => { x.plan.parentHistoryIncluded = true; }],
  ['mode normalization', x => { x.plan.roles.harness.members[0].gitMode = '100644'; }],
  ['extra shallow boundary', x => { x.plan.shallowHeads.push('1'.repeat(40)); }],
  ['foreign root', x => { x.request.destination = '/tmp/sources-123456abcdef'; }],
  ['capacity approval', x => { x.review.capacityAccepted = true; }],
  ['incorrect archive prefix', x => { x.plan.roles.baseline.archivePrefix = ''; }],
  ['traversal member', x => { x.plan.roles.baseline.members[0].path = '../escape'; }],
  ['altered raw fingerprint', x => { x.plan.roles.candidate.membersSha256 = '0'.repeat(64); x.receipt.roles.candidate.membersSha256 = '0'.repeat(64); }],
]) test(`source restoration rejects ${name}`, () => { const value = metadata(); mutate(value); assert.throws(() => check(value)); });
test('Git environment is explicit and excludes ambient config, credentials and replacement objects', () => {
  const env = sourceGitEnvironment('/srv/usage/work/sources-123456abcdef/empty');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.ok(!Object.hasOwn(env, 'AWS_PROFILE')); assert.ok(!Object.hasOwn(env, 'GIT_CONFIG_COUNT')); assert.ok(!Object.hasOwn(env, 'GIT_OBJECT_DIRECTORY'));
});
test('no restoration evidence or ambient Git fallback can admit a checkout', async () => {
  await assert.rejects(loadSourceRestoration({}), /SOURCE_RESTORATION_REQUIRED/);
  await assert.rejects(verifyCheckout('/unused', {}), /SOURCE_PINNED_GIT_REQUIRED/);
});
function ambientFixture() {
  const env = sourceGitEnvironment('/private/empty');
  const directory = { uid: 0, mode: 0o40755, isDirectory: () => true };
  const binary = { uid: 0, nlink: 1, mode: 0o100755, isFile: () => true, isSymbolicLink: () => false };
  const entries = { '/': directory, '/usr': directory, '/usr/local': directory, '/usr/local/bin': directory, '/usr/bin': directory, '/bin': { ...directory }, '/usr/bin/git': binary };
  return { env, entries, options: { stat: name => { if (!entries[name]) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return entries[name]; }, real: name => name === '/bin' ? '/usr/bin' : name } };
}
test('canonical H resolves the same pinned Git through only root-owned fixed PATH directories', () => {
  const x = ambientFixture(); assertCanonicalGitEnvironment(x.env, '/usr/bin/git', x.options);
});
for (const [name, mutate] of [
  ['custom PATH', x => { x.env.PATH = `/tmp:${x.env.PATH}`; }],
  ['config injection', x => { x.env.GIT_CONFIG_COUNT = '1'; }],
  ['case-variant injection', x => { x.env.Git_DIR = '/tmp/foreign'; }],
  ['missing global isolation', x => { delete x.env.GIT_CONFIG_GLOBAL; }],
  ['different first executable', x => { x.entries['/usr/local/bin/git'] = x.entries['/usr/bin/git']; }],
  ['user-writable search directory', x => { x.entries['/usr/local/bin'] = { ...x.entries['/usr/local/bin'], mode: 0o40777 }; }],
  ['user-owned alias', x => { x.entries['/bin'] = { ...x.entries['/bin'], uid: 1000 }; }],
  ['user-owned resolved ancestor', x => { const row = x.entries['/usr']; x.entries['/home'] = row; x.entries['/home/user'] = { ...row, uid: 1000 }; x.entries['/home/user/bin'] = row; x.options.real = name => name === '/usr/local/bin' ? '/home/user/bin' : name; }],
  ['symlink executable', x => { x.entries['/usr/bin/git'] = { ...x.entries['/usr/bin/git'], isSymbolicLink: () => true }; }],
]) test(`canonical H Git admission refuses ${name}`, () => { const x = ambientFixture(); mutate(x); assert.throws(() => assertCanonicalGitEnvironment(x.env, '/usr/bin/git', x.options)); });
