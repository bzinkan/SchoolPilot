import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPrivatePath, canonicalJson, createManifest, decryptBundle, encryptBundle,
  ensurePrivateDirectory, hashFile, manifestSha256, readBundle, sealDualCopyCustody,
  validateManifest, validateRelativePath, verifyManifest, verifyReturnedEvidence,
  writeBundle, writePrivateJsonExclusive,
} from './evidence.mjs';

let sandbox;
let sequence = 0;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const recipients = { input: `age1${'q'.repeat(58)}`, return: `age1${'p'.repeat(58)}` };
before(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'schoolpilot-custody-test-'));
  if (process.platform === 'win32') {
    const helper = fileURLToPath(new URL('../../../private-permissions.ps1', import.meta.url));
    const pwsh = [process.env.SCHOOLPILOT_CUSTODY_PWSH_PATH, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((folder) => path.join(folder, 'pwsh.exe'))].find((candidate) => candidate && path.isAbsolute(candidate) && existsSync(candidate));
    const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; . $env:SP_TEST_HELPER; Set-PrivatePathPermissions -Path $env:SP_TEST_PATH -Directory; Assert-PrivatePathPermissions -Path $env:SP_TEST_PATH -Directory"], {
      windowsHide: true, encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, ProgramFiles: process.env.ProgramFiles, SP_TEST_HELPER: helper, SP_TEST_PATH: sandbox },
    });
    assert.equal(result.status, 0, 'Private test-root ACL initialization');
  } else await chmod(sandbox, 0o700);
  await assertPrivatePath(sandbox, { directory: true });
});
after(async () => {
  const resolved = path.resolve(sandbox);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('schoolpilot-custody-test-'));
  await rm(resolved, { recursive: true });
});
async function directory() {
  const result = path.join(sandbox, `case-${++sequence}`);
  await ensurePrivateDirectory(result, { create: true });
  return result;
}
async function fixture() {
  const parent = await directory();
  const root = path.join(parent, 'source');
  await ensurePrivateDirectory(root, { create: true });
  await writePrivateJsonExclusive(path.join(root, 'metrics.json'), { passed: false, failures: ['retained'] });
  const manifest = await createManifest({ root, purpose: 'evidence_return', entries: [{ path: 'metrics.json', kind: 'raw_receipt' }] });
  const bundlePath = path.join(parent, 'bundle.private');
  const bundle = await writeBundle({ root, manifest, expectedManifestSha256: manifestSha256(manifest), bundlePath });
  return { parent, root, manifest, bundlePath, bundle, expectedManifestSha256: manifestSha256(manifest) };
}
function framed(manifest, payload = Buffer.alloc(0), suffix = Buffer.from('SPCEND1\n')) {
  const header = Buffer.from(canonicalJson(manifest));
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  return Buffer.concat([Buffer.from('SPCEVID1'), size, header, payload, suffix]);
}
async function privateBytes(file, data) {
  await writePrivateJsonExclusive(file, null);
  await writeFile(file, data);
  await assertPrivatePath(file);
}

test('member names reject escapes, ADS, Windows aliases and case/prefix collisions', () => {
  for (const name of ['../outside', '/absolute', 'a\\b', 'C:/file', 'a//b', 'a/./b', 'a/../b', 'aux.txt', 'file:stream', 'trailing.', 'white space', 'e\u0301.json', 'é.json']) assert.throws(() => validateRelativePath(name));
  assert.equal(validateRelativePath('runs/01/metrics.private.json'), 'runs/01/metrics.private.json');
  const entry = (name) => ({ path: name, kind: 'raw_receipt', sha256: '0'.repeat(64), bytes: 0 });
  for (const entries of [[entry('a'), entry('A')], [entry('a'), entry('a/b')], [entry('a'), entry('a-'), entry('a/b')]]) assert.throws(() => validateManifest({ schemaVersion: 1, purpose: 'evidence_return', entries, inputAllowlistSha256: null, totalBytes: 0 }), /COLLIDING_MEMBER/);
});

test('private permissions must be verified; mode-only Windows or shared Linux material is refused', async () => {
  const root = await directory();
  const file = path.join(root, 'inherited.json');
  await writeFile(file, '{}', { mode: 0o644 });
  await assert.rejects(assertPrivatePath(file), /PRIVATE_ACL_CHECK_FAILED|PRIVATE_MODE_REQUIRED/);
  const protectedFile = path.join(root, 'private.json');
  await writePrivateJsonExclusive(protectedFile, { synthetic: true });
  await assertPrivatePath(protectedFile);
});

test('streamed bundle roundtrip retains exact bytes and finalized failure outcomes', async () => {
  const f = await fixture();
  const destinationRoot = path.join(f.parent, 'returned');
  const result = await readBundle({ ...f, destinationRoot });
  assert.equal(result.integrityPassed, true);
  assert.deepEqual(await readFile(path.join(destinationRoot, 'metrics.json')), await readFile(path.join(f.root, 'metrics.json')));
  assert.equal(JSON.parse(await readFile(path.join(destinationRoot, 'metrics.json'))).passed, false);
  await assert.rejects(readBundle({ ...f, destinationRoot }), { code: 'EEXIST' });
});

test('bundle writer never overwrites or writes a bundle into its own member tree', async () => {
  const f = await fixture();
  await assert.rejects(writeBundle(f), { code: 'EEXIST' });
  await assert.rejects(writeBundle({ ...f, bundlePath: path.join(f.root, 'recursive.bundle') }), /BUNDLE_OUTSIDE_SOURCE_REQUIRED/);
  const oldBytes = await readFile(f.bundlePath);
  await assert.rejects(writePrivateJsonExclusive(f.bundlePath, {}), { code: 'EEXIST' });
  assert.deepEqual(await readFile(f.bundlePath), oldBytes);
});

test('manifest completeness refuses extra, missing and changed members', async () => {
  const f = await fixture();
  await writePrivateJsonExclusive(path.join(f.root, 'unlisted.json'), {});
  await assert.rejects(verifyManifest(f), /UNLISTED_OR_MISSING_MEMBER/);
  await rm(path.join(f.root, 'unlisted.json'));
  await writeFile(path.join(f.root, 'metrics.json'), 'changed');
  await assert.rejects(verifyManifest(f), /MEMBER_HASH_MISMATCH/);
  await rm(path.join(f.root, 'metrics.json'));
  await assert.rejects(verifyManifest(f), /UNLISTED_OR_MISSING_MEMBER/);
});

test('input admission requires an exact independently supplied hash/size/kind allowlist', async () => {
  const root = await directory();
  await writePrivateJsonExclusive(path.join(root, 'binding.json'), { syntheticOnly: true });
  const entries = [{ path: 'binding.json', kind: 'nonsecret_metadata' }];
  const exact = { ...entries[0], ...(await hashFile(path.join(root, 'binding.json'))) };
  const manifest = await createManifest({ root, purpose: 'approved_input', entries, approvedInputAllowlist: [exact] });
  assert.equal(manifest.inputAllowlistSha256, sha(canonicalJson([exact])));
  await assert.rejects(createManifest({ root, purpose: 'approved_input', entries, approvedInputAllowlist: [{ ...exact, sha256: '0'.repeat(64) }] }), /INPUT_ALLOWLIST_MISMATCH/);
  await assert.rejects(createManifest({ root, purpose: 'approved_input', entries }), /INVALID_ENTRIES/);
  await assert.rejects(createManifest({ root, purpose: 'approved_input', entries: [{ ...entries[0], kind: 'production_database' }], approvedInputAllowlist: [{ ...exact, kind: 'production_database' }] }), /INPUT_KIND_FORBIDDEN/);
});

test('even an allowlisted input cannot carry env, cloud credential or private-key names', async () => {
  for (const name of ['.env', 'credentials.json', 'secret.key', 'production-dump.private']) {
    const root = await directory();
    await writePrivateJsonExclusive(path.join(root, name), { syntheticOnly: true });
    const entry = { path: name, kind: 'nonsecret_metadata', ...(await hashFile(path.join(root, name))) };
    await assert.rejects(createManifest({ root, purpose: 'approved_input', entries: [entry], approvedInputAllowlist: [entry] }), /INPUT_SECRET_PATH_FORBIDDEN/);
  }
});

test('links/junctions and hard links are refused without following them', async () => {
  const f = await fixture();
  const junction = path.join(f.parent, 'linked-source');
  await symlink(f.root, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createManifest({ ...f, root: junction, purpose: 'evidence_return', entries: [{ path: 'metrics.json', kind: 'raw_receipt' }] }), /LINK_FORBIDDEN|REPARSE_PATH_FORBIDDEN/);
  await assert.rejects(readBundle({ ...f, destinationRoot: path.join(junction, 'escaped') }), /LINK_FORBIDDEN|REPARSE_PATH_FORBIDDEN/);
  const linked = path.join(f.parent, 'hard.json');
  await link(path.join(f.root, 'metrics.json'), linked);
  await assert.rejects(hashFile(linked), /REGULAR_PRIVATE_PATH_REQUIRED/);
});

test('extraction refuses a forged escaping header before creating an output root', async () => {
  const f = await fixture();
  const manifest = { ...f.manifest, entries: [{ ...f.manifest.entries[0], path: '../outside.json' }] };
  const file = path.join(f.parent, 'escaping.bundle');
  await privateBytes(file, framed(manifest));
  await assert.rejects(readBundle({ ...f, bundlePath: file, destinationRoot: path.join(f.parent, 'escaped') }), /INVALID_MEMBER_PATH/);
});

test('payload tampering, truncation, extra bytes and manifest hash substitution all fail', async () => {
  const f = await fixture();
  const original = await readFile(f.bundlePath);
  const payloadOffset = 12 + original.readUInt32BE(8);
  const tampered = Buffer.from(original); tampered[payloadOffset] ^= 1;
  const cases = [tampered, original.subarray(0, payloadOffset + 2), original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from('extra')])];
  for (let i = 0; i < cases.length; i++) {
    const file = path.join(f.parent, `invalid-${i}.bundle`); await privateBytes(file, cases[i]);
    await assert.rejects(readBundle({ ...f, bundlePath: file, destinationRoot: path.join(f.parent, `invalid-${i}`) }), /MEMBER_HASH_MISMATCH|TRUNCATED_BUNDLE|TRAILING_BUNDLE_DATA/);
  }
  await assert.rejects(readBundle({ ...f, expectedManifestSha256: '0'.repeat(64), destinationRoot: path.join(f.parent, 'bad-manifest') }), /MANIFEST_HASH_MISMATCH/);
  await assert.rejects(readBundle({ ...f, maxTotalBytes: 1, destinationRoot: path.join(f.parent, 'too-large') }), /BUNDLE_SIZE_LIMIT/);
});

test('duplicate JSON keys cannot change the meaning of a pinned manifest', async () => {
  const f = await fixture();
  const header = Buffer.from(canonicalJson(f.manifest).replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const file = path.join(f.parent, 'duplicate-keys.bundle');
  await privateBytes(file, Buffer.concat([Buffer.from('SPCEVID1'), length, header]));
  await assert.rejects(readBundle({ ...f, bundlePath: file, expectedManifestSha256: sha(header), destinationRoot: path.join(f.parent, 'duplicate-keys') }), /MANIFEST_HASH_MISMATCH/);
});

test('key separation and return-private-key runner refusal happen before tool/key access', async () => {
  const f = await fixture();
  const config = { ...f, expectedBundle: f.bundle, outputPath: path.join(f.parent, 'encrypted.age'), receiptPath: path.join(f.parent, 'encrypted.json'), age: { path: process.execPath, sha256: '0'.repeat(64) }, recipients, direction: 'return', location: 'owner' };
  await assert.rejects(encryptBundle({ ...config, recipients: { input: recipients.input, return: recipients.input } }), /KEY_SEPARATION_REQUIRED/);
  await assert.rejects(encryptBundle({ ...config, direction: 'input', location: 'runner' }), /INPUT_ENCRYPTION_OWNER_ONLY/);
  await assert.rejects(decryptBundle({ recipients, direction: 'return', location: 'runner' }), /RETURN_PRIVATE_KEY_FORBIDDEN_ON_RUNNER/);
  await assert.rejects(encryptBundle(config), /TOOL_HASH_MISMATCH/);
  await assert.rejects(encryptBundle({ ...config, expectedBundle: { ...f.bundle, sha256: '0'.repeat(64) } }), /BUNDLE_HASH_MISMATCH/);
});

test('return verification binds a real private replay receipt and rehashes after the replay hook', async () => {
  const f = await fixture();
  const ref = await writePrivateJsonExclusive(path.join(f.parent, 'replay.json'), { passed: true, independent: true });
  const replay = async ({ root, manifestSha256: manifestHash, invocationNonce }) => {
    const reviewer = 'independent AI reviewer';
    const receipt = await writePrivateJsonExclusive(path.join(f.parent, `${invocationNonce}.json`), { schemaVersion: 1, kind: 'independent_usage_evidence_replay', passed: true, root, manifestSha256: manifestHash, invocationNonce, reviewer, reviewedAtUtc: new Date().toISOString() });
    return { passed: true, reviewer, receipt };
  };
  const verified = await verifyReturnedEvidence({ ...f, replay });
  assert.equal(verified.independentReplayPassed, true);
  assert.equal(verified.replayHookInvoked, true);
  assert.equal(verified.productionReadiness, false);
  await assert.rejects(verifyReturnedEvidence({ ...f, replay: async () => ({ passed: true, reviewer: 'reviewer', receipt: ref }) }), /REPLAY_INVOCATION_NOT_BOUND/);
  await assert.rejects(verifyReturnedEvidence({ ...f, replay: async () => ({ passed: false }) }), /INDEPENDENT_REPLAY_NOT_PROVEN/);
  await assert.rejects(verifyReturnedEvidence({ ...f, replay: async () => ({ passed: true, reviewer: 'reviewer', receipt: { ...ref, sha256: '0'.repeat(64) } }) }), /REPLAY_RECEIPT_HASH_MISMATCH/);
  await assert.rejects(verifyReturnedEvidence({ ...f, replay: async (context) => { await writeFile(path.join(f.root, 'metrics.json'), 'changed'); return replay(context); } }), /MEMBER_HASH_MISMATCH/);
});

test('dual custody needs two distinct complete private copies, both independently replayed', async () => {
  const f = await fixture();
  const replay = async ({ root, manifestSha256: manifestHash, invocationNonce }) => {
    const reviewer = 'second reviewer';
    const receipt = await writePrivateJsonExclusive(path.join(f.parent, `${invocationNonce}.json`), { schemaVersion: 1, kind: 'independent_usage_evidence_replay', passed: true, root, manifestSha256: manifestHash, invocationNonce, reviewer, reviewedAtUtc: new Date().toISOString() });
    return { passed: true, reviewer, receipt };
  };
  const primary = { ...f, replay };
  await assert.rejects(sealDualCopyCustody({ copies: [primary, primary], receiptPath: path.join(f.parent, 'false-dual.json') }), /DISTINCT_PRIVATE_COPIES_REQUIRED/);
  const secondRoot = path.join(f.parent, 'second-copy');
  await readBundle({ ...f, destinationRoot: secondRoot });
  const receiptPath = path.join(f.parent, 'dual-copy.json');
  const result = await sealDualCopyCustody({ copies: [primary, { ...primary, root: secondRoot }], receiptPath });
  assert.equal(result.passed, true);
  assert.equal(result.copies.length, 2);
  assert.equal(result.operationalAuthorization, false);
  assert.equal(result.humanApprovalClaim, false);
  await assert.rejects(sealDualCopyCustody({ copies: [primary, { ...primary, root: secondRoot }], receiptPath }), { code: 'EEXIST' });
});

test('large binary and zero-length members are preserved without changing bundle semantics', async () => {
  const parent = await directory();
  const root = path.join(parent, 'source'); await ensurePrivateDirectory(root, { create: true });
  await privateBytes(path.join(root, 'binary.bin'), Buffer.alloc(1024 * 1024 + 17, 173));
  await privateBytes(path.join(root, 'empty.bin'), Buffer.alloc(0));
  const manifest = await createManifest({ root, purpose: 'evidence_return', entries: [{ path: 'binary.bin', kind: 'raw_receipt' }, { path: 'empty.bin', kind: 'raw_receipt' }] });
  const options = { root, manifest, expectedManifestSha256: manifestSha256(manifest), bundlePath: path.join(parent, 'large.bundle') };
  await writeBundle(options);
  const extracted = await readBundle({ ...options, destinationRoot: path.join(parent, 'returned') });
  assert.equal(extracted.bytes, 1024 * 1024 + 17);
  assert.equal(extracted.members, 2);
  assert.deepEqual(await readFile(path.join(extracted.root, 'binary.bin')), await readFile(path.join(root, 'binary.bin')));
});

test('second-copy replay cannot invalidate the first copy or place its seal inside the member tree', async () => {
  const f = await fixture();
  const secondRoot = path.join(f.parent, 'second');
  await readBundle({ ...f, destinationRoot: secondRoot });
  const replay = async ({ root, manifestSha256: manifestHash, invocationNonce }) => {
    if (root === secondRoot) await writeFile(path.join(f.root, 'metrics.json'), 'tampered during second replay');
    const reviewer = 'independent test callback';
    const receipt = await writePrivateJsonExclusive(path.join(f.parent, `${invocationNonce}.json`), { schemaVersion: 1, kind: 'independent_usage_evidence_replay', passed: true, root, manifestSha256: manifestHash, invocationNonce, reviewer, reviewedAtUtc: new Date().toISOString() });
    return { passed: true, reviewer, receipt };
  };
  const copies = [{ ...f, replay }, { ...f, root: secondRoot, replay }];
  await assert.rejects(sealDualCopyCustody({ copies, receiptPath: path.join(f.root, 'custody.json') }), /CUSTODY_RECEIPT_OUTSIDE_COPIES_REQUIRED/);
  await assert.rejects(sealDualCopyCustody({ copies, receiptPath: path.join(f.parent, 'custody.json') }), /MEMBER_HASH_MISMATCH/);
});
