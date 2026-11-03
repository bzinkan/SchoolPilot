// Privileged, one-shot ciphertext placement. No cloud, image import, archive unpack or load.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrivatePath, canonicalJson, decryptBundle, ensurePrivateDirectory, hashFile, manifestSha256, readBundle, writePrivateJsonExclusive } from './evidence.mjs';

// Fixed privileged helper. Open directory FDs pin the parents, and the kernel
// refuses an existing destination atomically. There is deliberately no rename
// fallback, target precheck or privileged operation beneath the published tree.
export const ATOMIC_PUBLICATION_PYTHON = String.raw`import ctypes, os, re, stat, sys
assert sys.platform == 'linux' and os.geteuid() == 0, 'Linux root required'
assert len(sys.argv) == 2 and re.fullmatch(r'usage-linux-[a-z0-9-]{8,40}', sys.argv[1]), 'run identity'
run_id = sys.argv[1]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fds = []
def directory(name, parent=None, uid=0, mode=None):
    fd = os.open(name, flags, dir_fd=parent); fds.append(fd)
    info = os.fstat(fd)
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == uid, 'parent ownership'
    assert stat.S_IMODE(info.st_mode) == mode if mode is not None else not info.st_mode & 0o022, 'parent permissions'
    return fd, info
try:
    srv, _ = directory('/srv')
    usage, _ = directory('usage', srv)
    staging, _ = directory('staging', usage, mode=0o700)
    source, source_info = directory(run_id, staging, mode=0o700)
    destination, destination_info = directory('work', usage, uid=1000, mode=0o700)
    ready = os.stat('placement-ready', dir_fd=source, follow_symlinks=False)
    assert stat.S_ISDIR(ready.st_mode) and ready.st_uid == 1000 and stat.S_IMODE(ready.st_mode) == 0o700, 'prepared tree'
    assert source_info.st_dev == destination_info.st_dev == ready.st_dev, 'same filesystem required'
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source, b'placement-ready', destination, ('input-' + run_id).encode('ascii'), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
finally:
    for fd in reversed(fds): os.close(fd)
`;

// Run against the actual runner kernel on its retained data filesystem before
// publication. Both test trees stay root-private; success and collision evidence
// are retained rather than removed. This cannot be replaced by the Windows model.
export const NATIVE_PUBLICATION_PROBE_PYTHON = String.raw`import ctypes, errno, json, os, re, stat, sys
assert sys.platform == 'linux' and os.geteuid() == 0, 'Linux root required'
assert len(sys.argv) == 2 and re.fullmatch(r'/srv/usage/staging/usage-linux-[a-z0-9-]{8,40}', sys.argv[1]), 'staging identity'
parent = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
probe = None
try:
    info = os.fstat(parent)
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700
    os.mkdir('publication-native-probe', mode=0o700, dir_fd=parent)
    probe = os.open('publication-native-probe', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    os.mkdir('source', mode=0o700, dir_fd=probe); os.mkdir('collision', mode=0o700, dir_fd=probe)
    source = os.stat('source', dir_fd=probe, follow_symlinks=False)
    collision = os.stat('collision', dir_fd=probe, follow_symlinks=False)
    libc = ctypes.CDLL(None, use_errno=True); rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]; rename.restype = ctypes.c_int
    assert rename(probe, b'source', probe, b'collision', 1) == -1 and ctypes.get_errno() == errno.EEXIST, 'native collision must refuse'
    assert os.stat('source', dir_fd=probe, follow_symlinks=False).st_ino == source.st_ino
    assert os.stat('collision', dir_fd=probe, follow_symlinks=False).st_ino == collision.st_ino
    assert rename(probe, b'source', probe, b'published', 1) == 0, 'native publication must succeed'
    assert os.stat('published', dir_fd=probe, follow_symlinks=False).st_ino == source.st_ino
    try: os.stat('source', dir_fd=probe, follow_symlinks=False)
    except FileNotFoundError: pass
    else: raise AssertionError('native source must move')
    print(json.dumps({'schemaVersion': 1, 'kind': 'usage_linux_native_atomic_publication_probe', 'sameDevice': info.st_dev, 'nativeSuccess': True, 'nativeCollisionRefused': True, 'collisionUnchanged': True}))
finally:
    if probe is not None: os.close(probe)
    os.close(parent)
`;

async function proveNativePublication(stagingRoot) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', NATIVE_PUBLICATION_PROBE_PYTHON, stagingRoot], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384, env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'native atomic publication probe refused; retain root-private staging');
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.kind, 'usage_linux_native_atomic_publication_probe');
  assert.equal(proof.nativeSuccess, true); assert.equal(proof.nativeCollisionRefused, true); assert.equal(proof.collisionUnchanged, true);
  assert.ok(Number.isSafeInteger(proof.sameDevice));
  await writePrivateJsonExclusive(path.join(stagingRoot, 'publication-native-probe.json'), { ...proof, observedAtUtc: new Date().toISOString() });
}

export function publishStagedInput(runId) {
  assert.match(runId, /^usage-linux-[a-z0-9-]{8,40}$/);
  const result = spawnSync('/usr/bin/python3', ['-I', '-c', ATOMIC_PUBLICATION_PYTHON, runId], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384, env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'atomic input publication refused; retain root-private staging');
}

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
  await proveNativePublication(p.stagingRoot);
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
  // UID1000 can replace any child of work. Keep every root write and ownership
  // change behind the root-private staging ancestor until one atomic publication.
  const prepared = path.join(p.stagingRoot, 'placement-ready');
  await fs.mkdir(prepared, { mode: 0o700 });
  for (const entry of p.manifest.entries) {
    const destination = path.join(prepared, ...entry.path.split('/'));
    let current = prepared;
    for (const part of entry.path.split('/').slice(0, -1)) { current = path.join(current, part); try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } const info = await fs.lstat(current); assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0); }
    const original = path.join(extracted, ...entry.path.split('/'));
    // copyFile with EXCL keeps large archives streamed by the OS, without loading them into memory.
    await fs.copyFile(original, destination, constants.COPYFILE_EXCL); await fs.chmod(destination, 0o600);
    assert.deepEqual(await hashFile(destination), { sha256: entry.sha256, bytes: entry.bytes });
  }
  const preparation = { schemaVersion: 1, kind: 'usage_linux_input_placement_prepared', runId: p.runId, destinationRoot: p.destinationRoot, manifestSha256: p.manifestSha256, ciphertext: p.expectedCiphertext, preparedAtUtc: new Date().toISOString(), publicationProven: false, productionUsage: 'off/off', measuredTrafficAdmitted: false };
  await writePrivateJsonExclusive(path.join(p.stagingRoot, 'placement-prepared.json'), preparation);
  const own = async directory => { for (const name of await fs.readdir(directory)) { const child = path.join(directory, name), info = await fs.lstat(child); assert.ok(!info.isSymbolicLink()); if (info.isDirectory()) await own(child); else { assert.ok(info.isFile() && info.nlink === 1); await fs.chown(child, 1000, 1000); } } await fs.chown(directory, 1000, 1000); };
  await own(prepared);
  publishStagedInput(p.runId); // Last root filesystem mutation; never write under work afterward.
  return { ...preparation, kind: 'usage_linux_verified_input_placement', publicationProven: true, placedAtUtc: new Date().toISOString() };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [request, flag, expected] = process.argv.slice(2);
  Promise.resolve().then(async () => { assert.equal(flag, '--request-sha256'); await assertPrivatePath(request); assert.equal((await hashFile(request)).sha256, expected); const receipt = await stageInput(JSON.parse(await fs.readFile(request))); console.log(JSON.stringify(receipt)); }).catch(() => { console.error('Input placement refused; preserve staging and inspect private receipts.'); process.exitCode = 1; });
}
