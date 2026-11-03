import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FREEZE_SHA256, hashFile, sha256, originalPathKey, safePath, verifyRelocation, writeNewJson } from './relocation.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(path.join(parent, 'usage-linux-relocation-'));
  t.after(() => { const resolved = realpathSync(root); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^usage-linux-relocation-/); rmSync(resolved, { recursive: true }); });
  return root;
}
function put(root, name, value) { const file = path.join(root, name); writeFileSync(file, value, { mode: 0o600 }); return file; }
async function manifest(root, files, directories = []) {
  const sidecar = { schemaVersion: 1, kind: 'usage_linux_relocation_sidecar', originalFreezeSha256: FREEZE_SHA256, inputRoot: root, files, directories };
  const file = put(root, 'sidecar.json', JSON.stringify(sidecar)); return { path: file, sha256: await hashFile(file) };
}
test('explicit mapping preserves raw CRLF bytes and Windows path identity without rewriting originals', async t => {
  const root = fixture(t), raw = Buffer.from('first\r\nsecond\r\n'), file = put(root, 'input', raw);
  const ref = await manifest(root, [{ originalPath: 'C:\\Evidence\\sealed.txt', path: file, bytes: raw.length, sha256: sha256(raw) }]);
  const original = await hashFile(ref.path), relocation = await verifyRelocation(ref);
  assert.equal(relocation.resolve('c:/evidence/SEALED.txt', sha256(raw)), file);
  assert.equal(await hashFile(ref.path), original);
  assert.throws(() => relocation.resolve('C:/Evidence/missing.txt'), /UNMAPPED_HISTORICAL_PATH/);
  assert.throws(() => relocation.resolve('C:/Evidence/sealed.txt', '0'.repeat(64)), /RELOCATION_REFERENCE_HASH/);
});
test('mapping rejects duplicate Windows aliases and filesystem destination aliases', async t => {
  const root = fixture(t), file = put(root, 'input', 'x'), row = { originalPath: 'C:/A', path: file, bytes: 1, sha256: sha256('x') };
  const ref = await manifest(root, [row, { ...row, originalPath: 'c:\\a' }]);
  await assert.rejects(verifyRelocation(ref), /DUPLICATE_ORIGINAL_PATH/);
});
test('correct sidecar hash cannot conceal drift in payload bytes or lengths', async t => {
  const root = fixture(t), file = put(root, 'input', 'changed');
  const ref = await manifest(root, [{ originalPath: 'C:/A', path: file, bytes: 7, sha256: sha256('initial') }]);
  await assert.rejects(verifyRelocation(ref), /REFERENCE_HASH_MISMATCH/);
});
test('absolute originals refuse traversal and alternate data streams', () => {
  for (const original of ['C:/a/../b', 'C:/a:stream', 'relative', 'C:/a\n']) assert.throws(() => originalPathKey(original));
});
test('resolved destinations cannot escape input root, and new receipts never overwrite', t => {
  const root = fixture(t), inside = path.join(root, 'inside'); mkdirSync(inside, { mode: 0o700 });
  const outside = put(root, 'outside', 'x'); assert.throws(() => safePath(outside, { root: inside }), /PATH_ESCAPE/);
  const receipt = path.join(inside, 'receipt.json'); writeNewJson(receipt, { first: true }, inside);
  assert.throws(() => writeNewJson(receipt, { first: false }, inside), { code: 'EEXIST' });
});
test('symlink component is rejected even when its target stays inside root', t => {
  const root = fixture(t), directory = path.join(root, 'real'); mkdirSync(directory, { mode: 0o700 });
  const link = path.join(root, 'alias'); symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  put(directory, 'input', 'x'); assert.throws(() => safePath(path.join(link, 'input'), { root }), /SYMLINK_REFUSED/);
});
