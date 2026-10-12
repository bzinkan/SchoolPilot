// Privileged, one-shot ciphertext placement. No cloud, image import, archive unpack or load.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrivatePath, canonicalJson, decryptBundle, ensurePrivateDirectory, hashFile, manifestSha256, readBundle, writePrivateJsonExclusive } from './evidence.mjs';

export function validateStageRequest(p) {
  assert.equal(p.schemaVersion, 1); assert.equal(p.kind, 'usage_linux_input_placement');
  assert.match(p.runId, /^usage-linux-[a-z0-9-]{8,40}$/); assert.equal(p.executorUid, 1000);
  assert.ok(Number.isInteger(p.transferUid) && p.transferUid > 1000);
  assert.equal(p.source, `/srv/usage/transfer/incoming/${p.runId}.age`);
  assert.equal(p.stagingRoot, `/srv/usage/staging/${p.runId}`);
  assert.equal(p.destinationRoot, `/srv/usage/work/input-${p.runId}`);
  assert.equal(p.identityPath, '/srv/usage/keys/input-identity.txt');
  assert.equal(p.direction, 'input'); assert.equal(p.location, 'runner');
  assert.equal(p.manifest.purpose, 'approved_input');
  assert.equal(manifestSha256(p.manifest), p.manifestSha256);
  assert.match(p.expectedCiphertext.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(p.expectedCiphertext.bytes) && p.expectedCiphertext.bytes > 0);
  assert.match(p.expectedBundle.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(p.expectedBundle.bytes) && p.expectedBundle.bytes >= p.manifest.totalBytes);
  assert.equal(p.manifest.totalBytes, p.approvedInputAllowlist.reduce((n, row) => n + row.bytes, 0));
  assert.equal(canonicalJson(p.manifest.entries), canonicalJson(p.approvedInputAllowlist));
}
async function validateSource(p) {
  for (const name of ['/srv/usage/transfer', '/srv/usage/transfer/incoming', p.source]) {
    const actual = await fs.realpath(name); assert.equal(actual, name, 'SFTP staging link refused');
    const s = await fs.lstat(name); assert.ok(!s.isSymbolicLink());
    if (name !== '/srv/usage/transfer') assert.equal(s.uid, p.transferUid);
    if (name === p.source) assert.ok(s.isFile() && s.nlink === 1 && (s.mode & 0o777) === 0o600);
    else assert.ok(s.isDirectory());
  }
  const handle = await fs.open(p.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  assert.equal((await handle.stat()).uid, p.transferUid); return handle;
}
export async function stageInput(p) {
  assert.equal(process.platform, 'linux'); assert.equal(process.geteuid(), 0); validateStageRequest(p);
  await assertPrivatePath('/srv/usage/staging', { directory: true });
  const parent = await fs.lstat('/srv/usage/work'); assert.equal(parent.uid, 1000); assert.equal(parent.mode & 0o777, 0o700);
  const space = await fs.statfs('/srv/usage');
  assert.ok(space.bavail * space.bsize >= p.expectedCiphertext.bytes + p.expectedBundle.bytes + 2 * p.manifest.totalBytes + 20 * 1024 ** 3, 'insufficient retained staging/placement headroom');
  await ensurePrivateDirectory(p.stagingRoot, { create: true });
  const cipher = path.join(p.stagingRoot, 'input.age'), bundle = path.join(p.stagingRoot, 'input.bundle');
  const source = await validateSource(p);
  const target = await fs.open(cipher, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const before = await source.stat();
    for await (const bytes of source.createReadStream({ autoClose: false })) await target.writeFile(bytes);
    await target.sync(); const after = await source.stat();
    assert.equal(after.ino, before.ino); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
  } finally { await source.close(); await target.close(); }
  assert.deepEqual(await hashFile(cipher), p.expectedCiphertext);
  await decryptBundle({ ciphertextPath: cipher, expectedCiphertext: p.expectedCiphertext, outputPath: bundle, age: p.age, ageKeygen: p.ageKeygen, identityPath: p.identityPath, recipients: p.recipients, direction: 'input', location: 'runner' });
  assert.deepEqual(await hashFile(bundle), { sha256: p.expectedBundle.sha256, bytes: p.expectedBundle.bytes });
  // Extract length-framed members to fresh root-owned storage, never to the SFTP chroot.
  const extracted = path.join(p.stagingRoot, 'verified');
  await readBundle({ bundlePath: bundle, expectedManifestSha256: p.manifestSha256, destinationRoot: extracted, approvedInputAllowlist: p.approvedInputAllowlist });
  const rootInfo = await fs.lstat(extracted); assert.equal(rootInfo.uid, 0);
  // Work parent is UID1000/private, so install only after verification. No overwrite or archive execution.
  await fs.mkdir(p.destinationRoot, { mode: 0o700 });
  for (const entry of p.manifest.entries) {
    const destination = path.join(p.destinationRoot, ...entry.path.split('/'));
    let current = p.destinationRoot;
    for (const part of entry.path.split('/').slice(0, -1)) { current = path.join(current, part); try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } const info = await fs.lstat(current); assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0); }
    const original = path.join(extracted, ...entry.path.split('/'));
    // copyFile with EXCL keeps large archives streamed by the OS, without loading them into memory.
    await fs.copyFile(original, destination, constants.COPYFILE_EXCL); await fs.chmod(destination, 0o600);
    assert.deepEqual(await hashFile(destination), { sha256: entry.sha256, bytes: entry.bytes });
  }
  const receipt = { schemaVersion: 1, kind: 'usage_linux_verified_input_placement', runId: p.runId, destinationRoot: p.destinationRoot, manifestSha256: p.manifestSha256, ciphertext: p.expectedCiphertext, placedAtUtc: new Date().toISOString(), productionUsage: 'off/off', measuredTrafficAdmitted: false };
  await writePrivateJsonExclusive(path.join(p.stagingRoot, 'placement.json'), receipt);
  const own = async directory => { for (const name of await fs.readdir(directory)) { const child = path.join(directory, name), info = await fs.lstat(child); assert.ok(!info.isSymbolicLink()); if (info.isDirectory()) await own(child); else { assert.ok(info.isFile() && info.nlink === 1); await fs.chown(child, 1000, 1000); } } await fs.chown(directory, 1000, 1000); };
  await own(p.destinationRoot); return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [request, flag, expected] = process.argv.slice(2);
  Promise.resolve().then(async () => { assert.equal(flag, '--request-sha256'); await assertPrivatePath(request); assert.equal((await hashFile(request)).sha256, expected); await stageInput(JSON.parse(await fs.readFile(request))); console.log('Approved ciphertext placed privately; no campaign started.'); }).catch(() => { console.error('Input placement refused; preserve staging and inspect private receipts.'); process.exitCode = 1; });
}
