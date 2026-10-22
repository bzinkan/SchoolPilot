import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SOURCES, guard, sha256, hashFile, safePath, readReference, verifyReference, writeNewJson } from './relocation.mjs';

const ROLE_KEYS = Object.freeze({ source: 'candidate', 'baseline-source': 'baseline', 'harness-source': 'harness' });
const CANONICAL_PATH = '/usr/local/bin:/usr/bin:/bin';
const CANONICAL_GIT_ENV = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
// Frozen canonical H invokes `git` by name. Admit only the same verified native
// binary and sanitized process environment used by the explicit Git checks.
export function assertCanonicalGitEnvironment(environment, tool, { stat = lstatSync, real = realpathSync } = {}) {
  guard(environment.PATH === CANONICAL_PATH, 'CANONICAL_GIT_PATH');
  const inherited = Object.fromEntries(Object.entries(environment).filter(([key]) => /^GIT_/i.test(key)));
  assert.deepEqual(inherited, CANONICAL_GIT_ENV, 'CANONICAL_GIT_ENVIRONMENT');
  let first = null;
  for (const directory of CANONICAL_PATH.split(':')) {
    // /bin may be an ordinary root-owned Ubuntu alias to /usr/bin. Bind its
    // root-owned link and canonical directory rather than following a user link.
    const lexical = stat(directory), resolved = real(directory), target = stat(resolved);
    guard(lexical.uid === 0 && target.uid === 0 && target.isDirectory() && (target.mode & 0o022) === 0, 'CANONICAL_GIT_PATH_CUSTODY');
    for (const pathname of [directory, resolved]) {
      for (let parent = path.posix.dirname(pathname); ; parent = path.posix.dirname(parent)) {
        const row = stat(parent); guard(row.uid === 0 && row.isDirectory() && (row.mode & 0o022) === 0, 'CANONICAL_GIT_PATH_ANCESTOR');
        if (parent === '/') break;
      }
    }
    if (first === null) {
      const candidate = path.posix.join(directory, 'git');
      try {
        const row = stat(candidate);
        guard(row.isFile() && !row.isSymbolicLink() && row.uid === 0 && row.nlink === 1 && (row.mode & 0o022) === 0 && (row.mode & 0o111) !== 0, 'CANONICAL_GIT_EXECUTABLE');
        first = real(candidate);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  guard(first === tool, 'CANONICAL_GIT_RESOLUTION');
}
function auditGitMetadata(root) {
  safePath(root, { directory: true, privateMode: true });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) auditGitMetadata(file);
    else safePath(file, { privateMode: true });
  }
}
export function sourceGitEnvironment(empty) {
  return { PATH: CANONICAL_PATH, HOME: empty, XDG_CONFIG_HOME: empty, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
}
export function expectedSourceGitConfig(empty) {
  return `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = false\n\tautocrlf = false\n\teol = lf\n\tfsmonitor = false\n\thooksPath = ${empty}\n[protocol]\n\tallow = never\n`;
}
export function assertSourceRestorationMetadata(receipt, review, request, plan) {
  guard(receipt.schemaVersion === 1 && receipt.kind === 'usage_current_native_linux_source_reconstruction' && receipt.passed === true, 'SOURCE_RESTORATION_RECEIPT');
  guard(review.schemaVersion === 1 && review.kind === 'usage_current_native_source_restoration_review' && review.passed === true && review.unresolvedFindings === 0 && typeof review.reviewer === 'string' && review.reviewer.trim(), 'SOURCE_RESTORATION_REVIEW');
  guard(review.nativeLinuxRestorationProven === true && review.disposition === 'reviewed_for_synthetic_execution' && Number.isFinite(Date.parse(review.reviewedAtUtc)), 'SOURCE_RESTORATION_REVIEW_SCOPE');
  for (const item of [receipt, review]) guard(item.capacityAccepted === false && item.productionReadiness === false, 'SOURCE_RESTORATION_AUTHORITY');
  guard(request.schemaVersion === 1 && request.kind === 'usage_linux_exact_source_restore_request', 'SOURCE_RESTORE_REQUEST');
  guard(/^\/srv\/usage\/work\/sources-[a-f0-9]{12}$/.test(request.destination), 'SOURCE_RESTORATION_ROOT');
  guard(plan.schemaVersion === 1 && plan.kind === 'usage_current_exact_head_git_transfer' && plan.parentHistoryIncluded === false && plan.coreFileMode === false && plan.workingFileMode === '0600' && plan.gitObjectModesPreserved === true, 'SOURCE_TRANSPORT_PLAN');
  assert.deepEqual(Object.keys(plan.roles).sort(), Object.keys(SOURCES).sort());
  assert.deepEqual(Object.keys(receipt.roles).sort(), Object.keys(SOURCES).sort());
  assert.deepEqual(plan.shallowHeads, Object.values(SOURCES).sort());
  guard(Array.isArray(plan.objects) && plan.objects.length > 3 && plan.objects.length < 30_000, 'SOURCE_OBJECTS');
  assert.deepEqual(plan.objects.map(r => r.oid), [...new Set(plan.objects.map(r => r.oid))].sort());
  for (const row of plan.objects) guard(/^[a-f0-9]{40}$/.test(row.oid) && ['commit', 'tree', 'blob'].includes(row.type) && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && /^[a-f0-9]{64}$/.test(row.payloadSha256), 'SOURCE_OBJECT_RECORD');
  assert.deepEqual(plan.objects.filter(r => r.type === 'commit').map(r => r.oid).sort(), plan.shallowHeads);
  for (const [role, source] of Object.entries(SOURCES)) {
    const actual = receipt.roles[role], expected = plan.roles[role];
    guard(expected.source === source && actual.source === source && actual.tree === expected.tree && actual.files === expected.files && actual.membersSha256 === expected.membersSha256, 'SOURCE_RESTORATION_ROLE');
    guard(actual.path === path.posix.join(request.destination, role) && actual.coreFileMode === false && actual.privateWorkingFiles0600 === true && actual.cleanDetachedGit === true && actual.parentHistoryIncluded === false, 'SOURCE_RESTORATION_CUSTODY');
    assert.deepEqual(actual.shallowHeads, plan.shallowHeads);
    guard(expected.archivePrefix === (role === 'baseline' ? 'baseline-source/' : role === 'candidate' ? 'candidate-source/' : ''), 'SOURCE_ARCHIVE_PREFIX');
    guard(Array.isArray(expected.members) && expected.members.length === expected.files, 'SOURCE_MEMBER_COUNT');
    assert.deepEqual(expected.members.map(row => row.path), [...new Set(expected.members.map(row => row.path))].sort());
    for (const row of expected.members) {
      guard(typeof row.path === 'string' && row.path.length > 0 && !path.posix.isAbsolute(row.path) && !/[\\\0\r\n\t]/.test(row.path) && !row.path.split('/').some(x => !x || x === '..' || x === '.' || x.toLowerCase() === '.git'), 'SOURCE_MEMBER_PATH');
      guard(['100644', '100755'].includes(row.gitMode) && /^[a-f0-9]{40}$/.test(row.gitBlobOid) && /^[a-f0-9]{64}$/.test(row.sha256), 'SOURCE_CANONICAL_MODE_OR_BLOB');
    }
    assert.deepEqual(expected.members.filter(row => row.gitMode === '100755').map(row => row.path), ['schoolpilot-app/android-gopilot/gradlew', 'schoolpilot-app/android-passpilot/gradlew']);
    guard(sha256(JSON.stringify(expected.members.map(row => [row.path, row.sha256]))) === expected.membersSha256, 'SOURCE_MEMBER_FINGERPRINT');
  }
}

export async function loadSourceRestoration(binding, { outputRoot } = {}) {
  guard(binding?.receipt && binding?.review, 'SOURCE_RESTORATION_REQUIRED');
  const receipt = await readReference(binding.receipt, { privateMode: true }), review = await readReference(binding.review, { privateMode: true });
  guard(review.subjectSha256 === binding.receipt.sha256, 'SOURCE_RESTORATION_REVIEW_SUBJECT');
  const request = await readReference(receipt.request, { privateMode: true });
  guard(receipt.plan.sha256 === request.plan.sha256 && review.planSha256 === request.plan.sha256, 'SOURCE_RESTORATION_PLAN_BINDING');
  const plan = await readReference(request.plan, { privateMode: true });
  assertSourceRestorationMetadata(receipt, review, request, plan);
  await verifyReference(request.pack, { privateMode: true });
  guard(request.pack.sha256 === plan.pack.sha256, 'SOURCE_PACK_BINDING');
  const tool = safePath(request.git.path), stat = lstatSync(tool);
  guard(process.platform === 'linux' && stat.uid === 0 && (stat.mode & 0o022) === 0 && (stat.mode & 0o111) !== 0, 'SOURCE_GIT_TOOL_CUSTODY');
  guard(await hashFile(tool) === request.git.sha256 && review.gitSha256 === request.git.sha256, 'SOURCE_GIT_TOOL_HASH');
  let cursor = path.dirname(tool);
  while (cursor !== path.dirname(cursor)) { const s = lstatSync(cursor); guard(s.uid === 0 && (s.mode & 0o022) === 0, 'SOURCE_GIT_TOOL_ANCESTOR'); cursor = path.dirname(cursor); }
  assertCanonicalGitEnvironment(process.env, tool);
  const empty = safePath(path.join(request.destination, 'empty'), { directory: true, privateMode: true });
  guard(readdirSync(empty).length === 0, 'SOURCE_GIT_HOOKS_NOT_EMPTY');
  guard(/^\/srv\/usage\/work\/source-checks-[a-f0-9]{12}$/.test(outputRoot), 'SOURCE_GIT_LOG_ROOT');
  safePath(outputRoot, { directory: true, privateMode: true });
  function git(root, args) {
    guard(sha256(readFileSync(tool)) === request.git.sha256, 'SOURCE_GIT_TOOL_CHANGED');
    assertCanonicalGitEnvironment(process.env, tool);
    const argv = ['--no-optional-locks', '-c', `core.hooksPath=${empty}`, '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never', '-C', root, ...args];
    const stem = path.join(outputRoot, `source-git-${randomUUID()}`);
    const result = spawnSync(tool, argv, { env: sourceGitEnvironment(empty), timeout: 30_000, maxBuffer: 32 * 1024 ** 2 });
    const stdout = Buffer.from(result.stdout ?? ''), stderr = Buffer.from(result.stderr ?? ''), exitCode = result.status;
    const outPath = `${stem}.stdout`, errPath = `${stem}.stderr`;
    writeFileSync(outPath, stdout, { flag: 'wx', mode: 0o600 }); writeFileSync(errPath, stderr, { flag: 'wx', mode: 0o600 });
    writeNewJson(`${stem}.json`, { arguments: argv, git: request.git, exitCode, signal: result.signal ?? null, errorCode: result.error?.code ?? null, stdout: { path: outPath, sha256: sha256(stdout) }, stderr: { path: errPath, sha256: sha256(stderr) } }, outputRoot);
    guard(exitCode === 0 && !result.error && !result.signal, 'SOURCE_GIT_NATIVE_FAILURE'); return stdout.toString('utf8');
  }
  return { receipt, request, plan, empty, git, roleFor: key => ROLE_KEYS[key] };
}

export async function verifyCheckout(root, record, { git, restoration, role } = {}) {
  guard(typeof git === 'function' && restoration?.plan && restoration?.empty && typeof role === 'string', 'SOURCE_PINNED_GIT_REQUIRED');
  safePath(root, { directory: true, privateMode: true });
  const expected = restoration.plan.roles[role];
  guard(expected && expected.source === record.source && expected.tree === record.tree && expected.files === record.files && expected.membersSha256 === record.membersSha256 && expected.archive.sha256 === record.sha256 && expected.archive.bytes === record.bytes, 'SOURCE_ARCHIVE_RESTORE_BINDING');
  const gd = safePath(path.join(root, '.git'), { root, directory: true, privateMode: true });
  auditGitMetadata(gd);
  const readPrivate = file => readFileSync(safePath(path.join(gd, file), { root: gd, privateMode: true }), 'utf8');
  guard(readPrivate('config') === expectedSourceGitConfig(restoration.empty), 'SOURCE_GIT_CONFIG');
  guard(readPrivate('shallow') === `${restoration.plan.shallowHeads.join('\n')}\n` && readPrivate('HEAD') === `${record.source}\n`, 'SOURCE_GIT_SHALLOW_OR_HEAD');
  for (const name of ['objects/info/alternates', 'objects/info/http-alternates', 'info/grafts', 'info/attributes', 'info/exclude', 'refs/replace', 'hooks', 'commondir', 'worktrees', 'config.worktree']) {
    let present = true; try { lstatSync(path.join(gd, name)); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
    guard(!present, 'SOURCE_GIT_INDIRECTION');
  }
  const packDirectory = safePath(path.join(gd, 'objects', 'pack'), { root: gd, directory: true, privateMode: true });
  const packedNames = readdirSync(packDirectory).sort();
  guard(packedNames.length === 2 && /^pack-[a-f0-9]{40}\.idx$/.test(packedNames[0]) && packedNames[1] === packedNames[0].replace(/\.idx$/, '.pack'), 'SOURCE_GIT_PACK_SET');
  const packedFile = safePath(path.join(packDirectory, packedNames[1]), { root: gd, privateMode: true });
  safePath(path.join(packDirectory, packedNames[0]), { root: gd, privateMode: true });
  guard(await hashFile(packedFile) === restoration.plan.pack.sha256, 'SOURCE_GIT_PACK_BYTES');
  const run = args => git(args), trim = args => run(args).trim();
  guard(trim(['rev-parse', 'HEAD']) === record.source && trim(['rev-parse', 'HEAD^{tree}']) === record.tree, 'SOURCE_GIT_IDENTITY');
  guard(run(['status', '--porcelain=v1', '--untracked-files=all']) === '', 'SOURCE_DIRTY');
  guard(trim(['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD', 'SOURCE_NOT_DETACHED');
  const expectedIndex = expected.members.map(row => `${row.gitMode} ${row.gitBlobOid} 0\t${row.path}\0`).join('');
  for (const row of expected.members) guard(['100644', '100755'].includes(row.gitMode) && /^[a-f0-9]{40}$/.test(row.gitBlobOid), 'SOURCE_CANONICAL_MODE_OR_BLOB');
  guard(run(['ls-files', '--stage', '-z']) === expectedIndex, 'SOURCE_INDEX_MODES_OR_BLOBS');
  const objectRows = run(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)']).trim().split('\n').map(x => x.replace(/\r$/, '')).sort();
  assert.deepEqual(objectRows, restoration.plan.objects.map(row => `${row.oid} ${row.type} ${row.bytes}`).sort());
  run(['fsck', '--strict', '--full', '--no-reflogs']);
  const files = run(['ls-files', '-z']).split('\0').filter(Boolean).sort();
  guard(files.length === record.files && new Set(files).size === files.length, 'SOURCE_FILE_SET');
  assert.deepEqual(files, expected.members.map(row => row.path));
  const entries = [], checkedDirectories = new Set([root]);
  for (const file of files) {
    guard(!path.isAbsolute(file) && !file.includes('\\') && !file.split('/').some(x => x === '..' || x === '.' || x.toLowerCase() === '.git'), 'SOURCE_MEMBER_PATH');
    const resolved = path.resolve(root, file); let parent = path.dirname(resolved);
    while (!checkedDirectories.has(parent)) {
      safePath(parent, { root, directory: true, privateMode: true }); checkedDirectories.add(parent); parent = path.dirname(parent);
    }
    entries.push([file, await hashFile(safePath(resolved, { root, privateMode: true }))]);
  }
  guard(sha256(JSON.stringify(entries)) === record.membersSha256, 'SOURCE_RAW_WORKING_BYTES');
  assert.deepEqual(entries, expected.members.map(row => [row.path, row.sha256]));
  guard(run(['status', '--porcelain=v1', '--untracked-files=all']) === '' && trim(['rev-parse', 'HEAD']) === record.source && run(['ls-files', '--stage', '-z']) === expectedIndex, 'SOURCE_CHANGED_DURING_CHECK');
  guard(readPrivate('config') === expectedSourceGitConfig(restoration.empty) && readPrivate('shallow') === `${restoration.plan.shallowHeads.join('\n')}\n`, 'SOURCE_GIT_METADATA_CHANGED');
  guard(await hashFile(packedFile) === restoration.plan.pack.sha256, 'SOURCE_GIT_PACK_CHANGED');
  auditGitMetadata(gd);
  return Object.fromEntries(entries);
}
