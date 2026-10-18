import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FREEZE_SHA256 = '1db9e79a6343f9f4371d9817a96adc2ffee3d7cf389552215c56f92020583bd6';
export const SOURCES = Object.freeze({ candidate: 'f4d5e7188b672c5673744298e81fa54174c728ea', baseline: '8dec7482c6516d37d426f86e613c8f4b32e9ed0b', harness: 'd9c45a6ed21ff508045fd6c137e9535f6f8a46ae' });
export function guard(condition, code) { if (!condition) { const error = new Error(code); error.code = code; throw error; } }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function assertSha(value) { guard(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_SHA256'); return value; }
export async function hashFile(file) {
  const before = lstatSync(file); guard(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'REGULAR_SINGLE_LINK_FILE_REQUIRED');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), h = createHash('sha256');
  try {
    const opened = await handle.stat(); guard(opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1, 'FILE_CHANGED');
    let bytes = 0; for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; h.update(chunk); }
    const after = await handle.stat(); guard(bytes === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, 'FILE_CHANGED');
    return h.digest('hex');
  } finally { await handle.close(); }
}
export function parseJson(bytes) { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
export function contains(root, file) { const rel = path.relative(root, file); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); }

// Reject symlinks at every component, including parents; realpath alone loses this evidence.
export function safePath(file, { root, directory = false, privateMode = false, uid = process.getuid?.() } = {}) {
  guard(typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0'), 'ABSOLUTE_PATH_REQUIRED');
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); guard(!lstatSync(cursor).isSymbolicLink(), 'SYMLINK_REFUSED');
  }
  const actual = realpathSync(absolute), stat = lstatSync(actual);
  guard(directory ? stat.isDirectory() : stat.isFile(), 'PATH_TYPE_MISMATCH');
  if (!directory) guard(stat.nlink === 1, 'HARDLINK_REFUSED');
  if (root) guard(contains(realpathSync(root), actual), 'PATH_ESCAPE');
  if (privateMode && process.platform !== 'win32') {
    guard(stat.uid === uid && (stat.mode & 0o777) === (directory ? 0o700 : 0o600), 'PRIVATE_OWNERSHIP_REQUIRED');
  }
  return actual;
}
export async function verifyReference(ref, { root, privateMode = false } = {}) {
  guard(ref && typeof ref === 'object' && typeof ref.path === 'string', 'REFERENCE_REQUIRED'); assertSha(ref.sha256);
  const file = safePath(ref.path, { root, privateMode });
  if (ref.bytes !== undefined) guard(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && lstatSync(file).size === ref.bytes, 'BYTE_LENGTH_MISMATCH');
  guard(await hashFile(file) === ref.sha256, 'REFERENCE_HASH_MISMATCH'); return file;
}
export async function readReference(ref, options) {
  const file = await verifyReference(ref, options); guard(lstatSync(file).size <= 64 * 1024 ** 2, 'JSON_REFERENCE_TOO_LARGE');
  const bytes = readFileSync(file); guard(sha256(bytes) === ref.sha256, 'REFERENCE_CHANGED_WHILE_READING'); return parseJson(bytes);
}
export function writeNewJson(file, value, root) {
  const parent = safePath(path.dirname(file), { root, directory: true, privateMode: true });
  guard(path.basename(file) !== '.' && contains(parent, path.resolve(file)), 'OUTPUT_PATH_ESCAPE');
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  safePath(file, { root, privateMode: true }); return file;
}
export function originalPathKey(value) {
  guard(typeof value === 'string' && /^(?:[a-zA-Z]:[\\/]|\/)/.test(value) && !/[\0\r\n]/.test(value), 'INVALID_ORIGINAL_PATH');
  // Windows identity is case insensitive, but path traversal and alternate data streams are never aliases.
  guard(!value.replaceAll('\\', '/').split('/').some(part => part === '.' || part === '..'), 'ORIGINAL_PATH_TRAVERSAL');
  guard(!/^[a-zA-Z]:.*:/.test(value), 'ORIGINAL_PATH_STREAM_REFUSED');
  return /^[a-zA-Z]:/.test(value) ? value.replaceAll('\\', '/').toLowerCase() : value;
}

/** Sidecar schema: originalFreezeSha256; inputRoot; files[{originalPath,path,bytes,sha256}];
 * directories[{originalPath,path}]. No prefix substitutions and no changes to sealed JSON. */
export async function verifyRelocation(sidecarRef, { privateMode = true } = {}) {
  const sidecar = await readReference(sidecarRef, { privateMode });
  guard(sidecar.schemaVersion === 1 && sidecar.kind === 'usage_linux_relocation_sidecar', 'RELOCATION_SCHEMA');
  guard(sidecar.originalFreezeSha256 === FREEZE_SHA256, 'WRONG_FREEZE');
  const inputRoot = safePath(sidecar.inputRoot, { directory: true, privateMode });
  guard(Array.isArray(sidecar.files) && sidecar.files.length > 0 && Array.isArray(sidecar.directories), 'RELOCATION_EMPTY');
  const mapping = new Map(), destinations = new Set();
  for (const row of [...sidecar.files, ...sidecar.directories]) {
    const key = originalPathKey(row.originalPath);
    guard(!mapping.has(key), 'DUPLICATE_ORIGINAL_PATH');
    const directory = sidecar.directories.includes(row);
    const actual = safePath(row.path, { root: inputRoot, directory, privateMode });
    guard(!destinations.has(actual), 'DUPLICATE_DESTINATION'); destinations.add(actual);
    if (!directory) {
      guard(Number.isSafeInteger(row.bytes) && row.bytes >= 0, 'RELOCATION_LENGTH_REQUIRED');
      await verifyReference(row, { root: inputRoot, privateMode });
    }
    mapping.set(key, { ...row, path: actual, directory });
  }
  function resolve(original, expectedSha256) {
    const row = mapping.get(originalPathKey(original)); guard(row, 'UNMAPPED_HISTORICAL_PATH');
    if (expectedSha256 !== undefined) guard(!row.directory && row.sha256 === expectedSha256, 'RELOCATION_REFERENCE_HASH');
    return row.path;
  }
  function ref(original) {
    guard(original && typeof original === 'object', 'HISTORICAL_REFERENCE_REQUIRED');
    const p = original.path ?? original.file;
    return { path: resolve(p, assertSha(original.sha256)), sha256: original.sha256 };
  }
  return { sidecar, sidecarSha256: sidecarRef.sha256, inputRoot, mapping, resolve, ref };
}

export async function readCliRequest(expectedAction, expectedKind) {
  guard(process.platform === 'linux' && process.getuid?.() === 1000, 'LINUX_UID_1000_REQUIRED');
  process.umask(0o077);
  const args = process.argv.slice(2);
  guard(args.length === 4 && args[0] === expectedAction && args[2] === '--request-sha256', 'CLI_ARGUMENTS');
  const requestRef = { path: path.resolve(args[1]), sha256: assertSha(args[3]) };
  const request = await readReference(requestRef, { privateMode: true });
  guard(request.schemaVersion === 1 && request.kind === expectedKind, 'REQUEST_SCHEMA');
  return { request, requestRef };
}
export function isMain(meta) { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(meta); }
export function cliFailure(error) { process.stderr.write(JSON.stringify({ passed: false, code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'VALIDATION_FAILED' }) + '\n'); process.exitCode = 1; }
if (isMain(import.meta.url)) {
  try {
    const { request, requestRef } = await readCliRequest('verify', 'usage_linux_relocation_request');
    const result = await verifyRelocation(request.sidecar);
    const receipt = { schemaVersion: 1, kind: 'usage_linux_relocation_verification', requestSha256: requestRef.sha256,
      sidecarSha256: request.sidecar.sha256, originalFreezeSha256: FREEZE_SHA256, files: result.sidecar.files.length,
      directories: result.sidecar.directories.length, verifiedAt: new Date().toISOString(), capacityAccepted: false, productionReadiness: false };
    writeNewJson(request.outputFile, receipt, request.outputRoot);
    process.stdout.write(JSON.stringify({ passed: true, outputSha256: await hashFile(request.outputFile), capacityAccepted: false }) + '\n');
  } catch (error) { cliFailure(error); }
}
