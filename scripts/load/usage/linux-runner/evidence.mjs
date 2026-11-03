import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

// Opaque artifacts are admitted by an independently supplied exact allowlist,
// never by a filename or a newly computed hash alone. This module does not scan
// opaque OCI/source archives for secrets or establish human approval.
const INPUT_KINDS = new Set(['oci_image', 'public_source', 'public_frontend', 'synthetic_fixture', 'reviewed_tool', 'nonsecret_metadata']);
const MAGIC = Buffer.from('SPCEVID1');
const END = Buffer.from('SPCEND1\n');
const MAX_MANIFEST = 16 * 1024 * 1024;
const MAX_MEMBERS = 100_000;
const CHUNK = 256 * 1024;
const HELPER = fileURLToPath(new URL('../../../private-permissions.ps1', import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const RECIPIENT = /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const fail = (code) => { throw new Error(`USAGE_CUSTODY_${code}`); };
const digest = (data) => createHash('sha256').update(data).digest('hex');

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) fail('INVALID_JSON');
  return JSON.stringify(value);
}

export function manifestSha256(manifest) { return digest(canonicalJson(validateManifest(manifest))); }

export function validateRelativePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9._/-]+$/.test(value)) fail('INVALID_MEMBER_PATH');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('INVALID_MEMBER_PATH');
  return value;
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_MEMBERS) fail('INVALID_ENTRIES');
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'bytes,kind,path,sha256') fail('INVALID_ENTRY_SHAPE');
    validateRelativePath(entry.path);
    const folded = entry.path.toLowerCase();
    if (seen.has(folded)) fail('COLLIDING_MEMBER');
    seen.add(folded);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !HASH.test(entry.sha256) || typeof entry.kind !== 'string' || !/^[a-z_]+$/.test(entry.kind)) fail('INVALID_ENTRY');
  }
  for (const name of seen) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) fail('COLLIDING_MEMBER');
  }
  return entries;
}

function validateApprovedInputs(entries, approvedInputAllowlist) {
  validateEntries(approvedInputAllowlist);
  if (entries.length !== approvedInputAllowlist.length) fail('INPUT_ALLOWLIST_MISMATCH');
  const approved = new Map(approvedInputAllowlist.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    if (!INPUT_KINDS.has(entry.kind)) fail('INPUT_KIND_FORBIDDEN');
    if (entry.path.split('/').some((part) => /^(?:\.env(?:\..*)?|\.aws|\.azure|\.config|\.ssh|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|(?:production|prod)[-_](?:dump|data|database)(?:[._-].*)?)$/i.test(part)) || /\.(?:pem|key|p12|pfx)$/i.test(entry.path)) fail('INPUT_SECRET_PATH_FORBIDDEN');
    if (!approved.has(entry.path) || canonicalJson(entry) !== canonicalJson(approved.get(entry.path))) fail('INPUT_ALLOWLIST_MISMATCH');
  }
}

export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !['approved_input', 'evidence_return'].includes(manifest.purpose) || Object.keys(manifest).sort().join(',') !== 'entries,inputAllowlistSha256,purpose,schemaVersion,totalBytes') fail('INVALID_MANIFEST');
  validateEntries(manifest.entries);
  const total = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (!Number.isSafeInteger(total) || total !== manifest.totalBytes) fail('INVALID_TOTAL');
  if (manifest.purpose === 'approved_input' ? !HASH.test(manifest.inputAllowlistSha256) : manifest.inputAllowlistSha256 !== null) fail('INVALID_ALLOWLIST_BINDING');
  return manifest;
}

async function noLinks(absolute) {
  if (typeof absolute !== 'string' || !path.isAbsolute(absolute) || path.resolve(absolute) !== absolute) fail('ABSOLUTE_PATH_REQUIRED');
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) fail('LINK_FORBIDDEN');
    if (process.platform === 'win32' && (await realpath(current)).toLowerCase() !== current.toLowerCase()) fail('REPARSE_PATH_FORBIDDEN');
  }
}

function windowsPermissions(target, directory, set) {
  // Mode bits are deliberately never accepted as ACL evidence on Windows.
  const executable = [process.env.SCHOOLPILOT_CUSTODY_PWSH_PATH, path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'), ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((folder) => path.join(folder, 'pwsh.exe'))].find((candidate) => candidate && path.isAbsolute(candidate) && existsSync(candidate));
  if (!executable) fail('PRIVATE_ACL_CHECK_FAILED');
  const script = ". $env:SP_CUSTODY_HELPER; Assert-NoReparsePointInExistingPath -Path $env:SP_CUSTODY_PATH; $d=$env:SP_CUSTODY_DIRECTORY -eq '1'; if($env:SP_CUSTODY_SET -eq '1'){Set-PrivatePathPermissions -Path $env:SP_CUSTODY_PATH -Directory:$d}; Assert-PrivatePathPermissions -Path $env:SP_CUSTODY_PATH -Directory:$d";
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${script}`], {
    windowsHide: true, timeout: 30_000, maxBuffer: 16_384, encoding: 'utf8',
    env: { SystemRoot: process.env.SystemRoot, ProgramFiles: process.env.ProgramFiles, SP_CUSTODY_HELPER: HELPER, SP_CUSTODY_PATH: target, SP_CUSTODY_DIRECTORY: directory ? '1' : '0', SP_CUSTODY_SET: set ? '1' : '0' },
  });
  if (result.error || result.status !== 0) fail('PRIVATE_ACL_CHECK_FAILED');
}

export async function assertPrivatePath(target, { directory = false } = {}) {
  await noLinks(target);
  const info = await lstat(target);
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) fail('REGULAR_PRIVATE_PATH_REQUIRED');
  if (process.platform === 'win32') windowsPermissions(target, directory, false);
  else if (process.platform === 'linux' || process.platform === 'darwin') {
    if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600) || info.uid !== process.geteuid()) fail('PRIVATE_MODE_REQUIRED');
  } else fail('UNSUPPORTED_PRIVATE_PLATFORM');
  return info;
}

async function setPrivate(target, directory) {
  await noLinks(target);
  if (process.platform === 'win32') windowsPermissions(target, directory, true);
  else await chmod(target, directory ? 0o700 : 0o600);
  return assertPrivatePath(target, { directory });
}

export async function ensurePrivateDirectory(target, { create = false } = {}) {
  await noLinks(target);
  if (create) {
    await assertPrivatePath(path.dirname(target), { directory: true });
    await mkdir(target, { mode: 0o700 }); // Existing directories are never silently adopted.
    await setPrivate(target, true);
  }
  await assertPrivatePath(target, { directory: true });
  return target;
}

async function newPrivateFile(target) {
  await noLinks(target);
  await assertPrivatePath(path.dirname(target), { directory: true });
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await setPrivate(target, false); } catch (error) { await handle.close(); throw error; }
  return handle;
}

async function openPrivateRead(target) {
  const before = await assertPrivatePath(target);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const actual = await handle.stat();
  if (actual.dev !== before.dev || actual.ino !== before.ino || actual.nlink !== 1 || !actual.isFile()) { await handle.close(); fail('FILE_CHANGED'); }
  return handle;
}

export async function writePrivateJsonExclusive(target, value) {
  return writePrivateBytesExclusive(target, Buffer.from(`${canonicalJson(value)}\n`));
}

export async function writePrivateBytesExclusive(target, bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('BYTES_REQUIRED');
  const handle = await newPrivateFile(target);
  try { await writeAll(handle, bytes); await handle.sync(); } finally { await handle.close(); }
  await assertPrivatePath(target);
  return { file: target, ...(await hashFile(target)) };
}

export async function hashFile(target) {
  const handle = await openPrivateRead(target);
  const before = await handle.stat();
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: CHUNK })) { hash.update(chunk); bytes += chunk.length; }
    const after = await handle.stat();
    if (before.size !== bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('FILE_CHANGED');
  } finally { await handle.close(); }
  return { sha256: hash.digest('hex'), bytes };
}

async function listMembers(root, prefix = '') {
  await assertPrivatePath(prefix ? path.join(root, ...prefix.split('/')) : root, { directory: true });
  const entries = [];
  for (const item of await readdir(prefix ? path.join(root, ...prefix.split('/')) : root, { withFileTypes: true })) {
    const member = prefix ? `${prefix}/${item.name}` : item.name;
    validateRelativePath(member);
    const absolute = path.join(root, ...member.split('/'));
    if (item.isSymbolicLink()) fail('LINK_FORBIDDEN');
    if (item.isDirectory()) entries.push(...await listMembers(root, member));
    else { await assertPrivatePath(absolute); entries.push(member); }
  }
  return entries.sort();
}

export async function createManifest({ root, entries, purpose, approvedInputAllowlist }) {
  await ensurePrivateDirectory(root);
  if (!Array.isArray(entries)) fail('INVALID_ENTRIES');
  const manifestEntries = [];
  for (const entry of entries) {
    validateRelativePath(entry.path);
    manifestEntries.push({ path: entry.path, kind: entry.kind, ...(await hashFile(path.join(root, ...entry.path.split('/')))) });
  }
  manifestEntries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  validateEntries(manifestEntries);
  if (canonicalJson((await listMembers(root))) !== canonicalJson(manifestEntries.map((entry) => entry.path).sort())) fail('UNLISTED_OR_MISSING_MEMBER');
  if (purpose === 'approved_input') validateApprovedInputs(manifestEntries, approvedInputAllowlist);
  return validateManifest({ schemaVersion: 1, purpose, entries: manifestEntries, totalBytes: manifestEntries.reduce((sum, entry) => sum + entry.bytes, 0), inputAllowlistSha256: purpose === 'approved_input' ? digest(canonicalJson(approvedInputAllowlist)) : null });
}

export async function verifyManifest({ root, manifest, expectedManifestSha256, approvedInputAllowlist }) {
  validateManifest(manifest);
  if (!HASH.test(expectedManifestSha256) || manifestSha256(manifest) !== expectedManifestSha256) fail('MANIFEST_HASH_MISMATCH');
  if (manifest.purpose === 'approved_input') {
    validateApprovedInputs(manifest.entries, approvedInputAllowlist);
    if (digest(canonicalJson(approvedInputAllowlist)) !== manifest.inputAllowlistSha256) fail('INPUT_ALLOWLIST_MISMATCH');
  }
  if (canonicalJson(await listMembers(root)) !== canonicalJson(manifest.entries.map((entry) => entry.path).sort())) fail('UNLISTED_OR_MISSING_MEMBER');
  for (const entry of manifest.entries) {
    const actual = await hashFile(path.join(root, ...entry.path.split('/')));
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) fail('MEMBER_HASH_MISMATCH');
  }
  return { integrityPassed: true, manifestSha256: expectedManifestSha256, members: manifest.entries.length, bytes: manifest.totalBytes };
}

async function writeAll(handle, data) {
  let offset = 0;
  while (offset < data.length) { const result = await handle.write(data, offset, data.length - offset); if (!result.bytesWritten) fail('SHORT_WRITE'); offset += result.bytesWritten; }
}

export async function writeBundle({ root, manifest, expectedManifestSha256, approvedInputAllowlist, bundlePath }) {
  const relative = path.relative(root, bundlePath);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('BUNDLE_OUTSIDE_SOURCE_REQUIRED');
  await verifyManifest({ root, manifest, expectedManifestSha256, approvedInputAllowlist });
  const header = Buffer.from(canonicalJson(manifest));
  if (header.length > MAX_MANIFEST) fail('MANIFEST_TOO_LARGE');
  const out = await newPrivateFile(bundlePath);
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  try {
    await writeAll(out, MAGIC); await writeAll(out, length); await writeAll(out, header);
    for (const entry of manifest.entries) {
      const input = await openPrivateRead(path.join(root, ...entry.path.split('/')));
      const hash = createHash('sha256'); let bytes = 0;
      try { for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: CHUNK })) { bytes += chunk.length; if (bytes > entry.bytes) fail('MEMBER_CHANGED'); hash.update(chunk); await writeAll(out, chunk); } }
      finally { await input.close(); }
      if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256) fail('MEMBER_CHANGED');
    }
    await writeAll(out, END); await out.sync();
  } finally { await out.close(); }
  return { file: bundlePath, ...(await hashFile(bundlePath)), manifestSha256: expectedManifestSha256, purpose: manifest.purpose };
}

async function readExactly(handle, count) {
  const data = Buffer.alloc(count); let offset = 0;
  while (offset < count) { const result = await handle.read(data, offset, count - offset); if (!result.bytesRead) fail('TRUNCATED_BUNDLE'); offset += result.bytesRead; }
  return data;
}

// New roots only. A failed extraction is intentionally retained as partial
// evidence and must never be adopted or overwritten by a retry.
export async function readBundle({ bundlePath, destinationRoot, expectedManifestSha256, approvedInputAllowlist, maxTotalBytes = 64 * 1024 ** 3 }) {
  const input = await openPrivateRead(bundlePath);
  try {
    if (!(await readExactly(input, MAGIC.length)).equals(MAGIC)) fail('INVALID_BUNDLE_MAGIC');
    const size = (await readExactly(input, 4)).readUInt32BE();
    if (!size || size > MAX_MANIFEST) fail('MANIFEST_TOO_LARGE');
    const raw = await readExactly(input, size);
    let manifest;
    try { manifest = JSON.parse(raw.toString('utf8')); } catch { fail('INVALID_MANIFEST_JSON'); }
    validateManifest(manifest);
    if (!raw.equals(Buffer.from(canonicalJson(manifest))) || !HASH.test(expectedManifestSha256) || digest(raw) !== expectedManifestSha256) fail('MANIFEST_HASH_MISMATCH');
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0 || manifest.totalBytes > maxTotalBytes) fail('BUNDLE_SIZE_LIMIT');
    if (manifest.purpose === 'approved_input') {
      validateApprovedInputs(manifest.entries, approvedInputAllowlist);
      if (digest(canonicalJson(approvedInputAllowlist)) !== manifest.inputAllowlistSha256) fail('INPUT_ALLOWLIST_MISMATCH');
    }
    await ensurePrivateDirectory(destinationRoot, { create: true });
    for (const entry of manifest.entries) {
      const parts = entry.path.split('/'); let parent = destinationRoot;
      for (const part of parts.slice(0, -1)) {
        parent = path.join(parent, part);
        try { await ensurePrivateDirectory(parent); } catch (error) { if (error.code !== 'ENOENT') throw error; await ensurePrivateDirectory(parent, { create: true }); }
      }
      const out = await newPrivateFile(path.join(destinationRoot, ...parts));
      const hash = createHash('sha256'); let remaining = entry.bytes;
      try { while (remaining) { const data = await readExactly(input, Math.min(CHUNK, remaining)); hash.update(data); await writeAll(out, data); remaining -= data.length; } await out.sync(); }
      finally { await out.close(); }
      if (hash.digest('hex') !== entry.sha256) fail('MEMBER_HASH_MISMATCH');
    }
    if (!(await readExactly(input, END.length)).equals(END)) fail('INVALID_BUNDLE_END');
    if ((await input.read(Buffer.alloc(1), 0, 1)).bytesRead) fail('TRAILING_BUNDLE_DATA');
    return { root: destinationRoot, manifest, ...(await verifyManifest({ root: destinationRoot, manifest, expectedManifestSha256, approvedInputAllowlist })) };
  } finally { await input.close(); }
}

async function assertPinnedTool(tool) {
  if (!tool || !HASH.test(tool.sha256)) fail('PINNED_TOOL_REQUIRED');
  await noLinks(tool.path);
  const info = await lstat(tool.path);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o022))) fail('PINNED_TOOL_REQUIRED');
  const hash = createHash('sha256');
  for await (const data of createReadStream(tool.path)) hash.update(data);
  if (hash.digest('hex') !== tool.sha256) fail('TOOL_HASH_MISMATCH');
}

function keyPolicy({ recipients, direction, location }) {
  if (!recipients || !RECIPIENT.test(recipients.input) || !RECIPIENT.test(recipients.return) || recipients.input === recipients.return) fail('KEY_SEPARATION_REQUIRED');
  if (!['input', 'return'].includes(direction) || !['owner', 'runner'].includes(location)) fail('INVALID_KEY_SCOPE');
  return recipients[direction];
}

function cleanEnvironment() {
  return process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : { LANG: 'C' };
}

async function crypt({ tool, args, inputPath, outputPath }) {
  await assertPinnedTool(tool);
  await assertPrivatePath(inputPath);
  const input = await openPrivateRead(inputPath);
  let out;
  try {
    out = await newPrivateFile(outputPath);
    const timeoutMs = tool.timeoutMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60_000) fail('INVALID_CRYPTO_TIMEOUT');
    const child = spawn(tool.path, args, { windowsHide: true, shell: false, env: cleanEnvironment(), stdio: ['pipe', out.fd, 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('close', () => clearTimeout(timer));
    child.once('error', () => clearTimeout(timer));
    const exit = new Promise((resolve, reject) => { child.once('error', () => reject(new Error('USAGE_CUSTODY_AGE_START_FAILED'))); child.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('USAGE_CUSTODY_AGE_FAILED'))); });
    const piped = pipeline(input.createReadStream({ autoClose: false }), child.stdin);
    const outcomes = await Promise.allSettled([exit, piped]);
    if (outcomes.some((result) => result.status === 'rejected')) fail('AGE_FAILED');
    await out.sync();
    await assertPinnedTool(tool);
  } finally { await input.close(); if (out) await out.close(); }
  return { file: outputPath, ...(await hashFile(outputPath)) };
}

export async function encryptBundle({ bundlePath, expectedBundle, outputPath, receiptPath, age, recipients, direction, location }) {
  const recipient = keyPolicy({ recipients, direction, location });
  if (direction === 'input' && location !== 'owner') fail('INPUT_ENCRYPTION_OWNER_ONLY');
  if (!expectedBundle || expectedBundle.purpose !== (direction === 'input' ? 'approved_input' : 'evidence_return') || !HASH.test(expectedBundle.manifestSha256)) fail('BUNDLE_BINDING_REQUIRED');
  const before = await hashFile(bundlePath);
  if (before.sha256 !== expectedBundle.sha256 || before.bytes !== expectedBundle.bytes) fail('BUNDLE_HASH_MISMATCH');
  const input = await openPrivateRead(bundlePath);
  try {
    if (!(await readExactly(input, MAGIC.length)).equals(MAGIC)) fail('INVALID_BUNDLE_MAGIC');
    const size = (await readExactly(input, 4)).readUInt32BE();
    if (!size || size > MAX_MANIFEST) fail('MANIFEST_TOO_LARGE');
    const header = await readExactly(input, size);
    let manifest;
    try { manifest = validateManifest(JSON.parse(header.toString('utf8'))); } catch { fail('INVALID_MANIFEST'); }
    if (!header.equals(Buffer.from(canonicalJson(manifest))) || digest(header) !== expectedBundle.manifestSha256 || manifest.purpose !== expectedBundle.purpose || before.bytes !== MAGIC.length + 4 + size + manifest.totalBytes + END.length) fail('BUNDLE_BINDING_REQUIRED');
  } finally { await input.close(); }
  const ciphertext = await crypt({ tool: age, args: ['--encrypt', '--recipient', recipient], inputPath: bundlePath, outputPath });
  const after = await hashFile(bundlePath);
  if (canonicalJson(before) !== canonicalJson(after)) fail('FILE_CHANGED');
  const receipt = { schemaVersion: 1, kind: 'encrypted_private_evidence_bundle', direction, location, plaintext: before, manifestSha256: expectedBundle.manifestSha256, ciphertext, recipient, recipientSha256: digest(recipient), ageToolSha256: age.sha256, createdAtUtc: new Date().toISOString(), operationalAuthorization: false, humanApprovalClaim: false };
  return { ...receipt, receipt: await writePrivateJsonExclusive(receiptPath, receipt) };
}

export async function decryptBundle({ ciphertextPath, expectedCiphertext, outputPath, age, ageKeygen, identityPath, recipients, direction, location }) {
  const recipient = keyPolicy({ recipients, direction, location });
  if (direction === 'return' && location === 'runner') fail('RETURN_PRIVATE_KEY_FORBIDDEN_ON_RUNNER');
  await assertPrivatePath(identityPath);
  await assertPinnedTool(ageKeygen);
  const derived = spawnSync(ageKeygen.path, ['-y', identityPath], { windowsHide: true, shell: false, env: cleanEnvironment(), timeout: 30_000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (derived.error || derived.status !== 0 || derived.stdout.trim() !== recipient) fail('IDENTITY_RECIPIENT_MISMATCH');
  await assertPinnedTool(ageKeygen);
  const actual = await hashFile(ciphertextPath);
  if (!expectedCiphertext || actual.sha256 !== expectedCiphertext.sha256 || actual.bytes !== expectedCiphertext.bytes) fail('CIPHERTEXT_HASH_MISMATCH');
  const plaintext = await crypt({ tool: age, args: ['--decrypt', '--identity', identityPath], inputPath: ciphertextPath, outputPath });
  if (canonicalJson(actual) !== canonicalJson(await hashFile(ciphertextPath))) fail('FILE_CHANGED');
  return { plaintext, recipientSha256: digest(recipient), ageToolSha256: age.sha256, ageKeygenToolSha256: ageKeygen.sha256, direction, location, humanApprovalClaim: false };
}

export async function verifyReturnedEvidence({ root, manifest, expectedManifestSha256, replay }) {
  if (manifest?.purpose !== 'evidence_return' || typeof replay !== 'function') fail('RETURN_REPLAY_REQUIRED');
  const integrity = await verifyManifest({ root, manifest, expectedManifestSha256 });
  const invocationNonce = randomUUID();
  const started = Date.now();
  const result = await replay({ root, manifest, manifestSha256: expectedManifestSha256, invocationNonce });
  if (!result || result.passed !== true || typeof result.reviewer !== 'string' || !result.reviewer.trim() || !result.receipt || !HASH.test(result.receipt.sha256)) fail('INDEPENDENT_REPLAY_NOT_PROVEN');
  const replayReceipt = await hashFile(result.receipt.file);
  if (replayReceipt.sha256 !== result.receipt.sha256) fail('REPLAY_RECEIPT_HASH_MISMATCH');
  if (replayReceipt.bytes > 1024 * 1024) fail('REPLAY_RECEIPT_TOO_LARGE');
  const replayInput = await openPrivateRead(result.receipt.file);
  let bound;
  try { bound = JSON.parse(await replayInput.readFile({ encoding: 'utf8' })); } catch { fail('REPLAY_RECEIPT_INVALID'); }
  finally { await replayInput.close(); }
  if (bound.kind !== 'independent_usage_evidence_replay' || bound.schemaVersion !== 1 || bound.passed !== true || bound.invocationNonce !== invocationNonce || bound.manifestSha256 !== expectedManifestSha256 || bound.root !== root || bound.reviewer !== result.reviewer || !Number.isFinite(Date.parse(bound.reviewedAtUtc)) || Date.parse(bound.reviewedAtUtc) < started || Date.parse(bound.reviewedAtUtc) > Date.now() + 1000) fail('REPLAY_INVOCATION_NOT_BOUND');
  if (canonicalJson(await hashFile(result.receipt.file)) !== canonicalJson(replayReceipt)) fail('REPLAY_RECEIPT_CHANGED');
  await verifyManifest({ root, manifest, expectedManifestSha256 });
  return { ...integrity, root, passed: true, replayHookInvoked: true, invocationNonce, independentReplayPassed: true, reviewer: result.reviewer, replayReceipt: { file: result.receipt.file, ...replayReceipt }, operationalAuthorization: false, productionReadiness: false, humanApprovalClaim: false };
}

export async function sealDualCopyCustody({ copies, receiptPath }) {
  if (!Array.isArray(copies) || copies.length !== 2) fail('TWO_PRIVATE_COPIES_REQUIRED');
  const roots = await Promise.all(copies.map(async (copy) => { await ensurePrivateDirectory(copy.root); return realpath(copy.root); }));
  const folded = roots.map((root) => process.platform === 'win32' ? root.toLowerCase() : root);
  if (folded[0] === folded[1] || folded.some((root, i) => root.startsWith(`${folded[1 - i]}${path.sep}`))) fail('DISTINCT_PRIVATE_COPIES_REQUIRED');
  const foldedReceipt = process.platform === 'win32' ? path.resolve(receiptPath).toLowerCase() : path.resolve(receiptPath);
  if (folded.some((root) => foldedReceipt === root || foldedReceipt.startsWith(`${root}${path.sep}`))) fail('CUSTODY_RECEIPT_OUTSIDE_COPIES_REQUIRED');
  if (copies[0].expectedManifestSha256 !== copies[1].expectedManifestSha256) fail('COPY_MANIFEST_MISMATCH');
  const verified = [];
  for (const copy of copies) verified.push(await verifyReturnedEvidence(copy));
  // The second callback must not invalidate the already-checked first copy.
  for (let i = 0; i < copies.length; i++) {
    await verifyManifest({ root: copies[i].root, manifest: copies[i].manifest, expectedManifestSha256: copies[i].expectedManifestSha256 });
    const actual = await hashFile(verified[i].replayReceipt.file);
    if (actual.sha256 !== verified[i].replayReceipt.sha256 || actual.bytes !== verified[i].replayReceipt.bytes) fail('REPLAY_RECEIPT_CHANGED');
  }
  const receipt = { schemaVersion: 1, kind: 'independently_replayed_dual_private_evidence_custody', passed: true, copies: verified, createdAtUtc: new Date().toISOString(), operationalAuthorization: false, productionReadiness: false, humanApprovalClaim: false };
  return { ...receipt, receipt: await writePrivateJsonExclusive(receiptPath, receipt) };
}
