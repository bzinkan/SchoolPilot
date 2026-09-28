import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAPACITY_SOURCE_FILES = Object.freeze([
  'run-split.ps1', 'runner-provenance.mjs', 'split-worker.mjs', 'split.test.mjs',
  'split-api-observation.mjs', 'scheduler-overlap.mjs', 'latency-metrics.mjs',
  'physical-object-store.mjs', 'split-api-server.mjs', 'api-server-contract.mjs',
  'finalize-api-evidence.mjs',
]);
const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], {
  encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const equalPath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;
function rootAt(directory) {
  try { return realpathSync(git(directory, ['rev-parse', '--show-toplevel'])); }
  catch { return null; }
}
function cleanRevision(root) {
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=normal']), '', 'SOURCE_CHECKOUT_DIRTY');
  const revision = git(root, ['rev-parse', 'HEAD']);
  assert.match(revision, /^[a-f0-9]{40}$/);
  return revision;
}

// Application bytes and measurement tools may come from different reviewed
// commits. Neither identity is inferred from the other's checkout or image tag.
export function captureCapacitySourceIdentity({ applicationRepositoryRoot, expectedApplicationRevision, runnerPath }) {
  assert.match(expectedApplicationRevision, /^[a-f0-9]{40}$/);
  const repositoryRoot = realpathSync(applicationRepositoryRoot);
  assert.equal(rootAt(repositoryRoot), repositoryRoot, 'APPLICATION_REPOSITORY_ROOT_INVALID');
  const repositoryRevision = cleanRevision(repositoryRoot);
  assert.equal(repositoryRevision, expectedApplicationRevision, 'APPLICATION_REVISION_CHANGED');
  assert.ok(lstatSync(runnerPath).isFile() && !lstatSync(runnerPath).isSymbolicLink(), 'RUNNER_SOURCE_INVALID');
  const actualRunner = realpathSync(runnerPath), sourceDirectory = dirname(actualRunner);
  const discoveredRoot = rootAt(sourceDirectory);
  const canonical = discoveredRoot !== null && equalPath(actualRunner,
    join(discoveredRoot, 'scripts', 'load', 'paperwork', 'run-split.ps1'));
  const harnessRepositoryRoot = canonical ? discoveredRoot : null;
  const harnessRevision = canonical ? cleanRevision(harnessRepositoryRoot) : null;
  const files = {};
  for (const file of CAPACITY_SOURCE_FILES) {
    const path = join(sourceDirectory, file), metadata = lstatSync(path);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'HARNESS_SOURCE_INVALID');
    if (canonical) git(harnessRepositoryRoot, ['ls-files', '--error-unmatch', '--', `scripts/load/paperwork/${file}`]);
    files[file] = { sha256: sha(path) };
  }
  return { schemaVersion: 1, repositoryRoot, repositoryRevision, harnessRepositoryRoot, harnessRevision,
    harnessSource: canonical ? 'reviewed_repository' : 'external_diagnostic', runnerPath: actualRunner,
    runnerSourceSha256: files['run-split.ps1'].sha256, files };
}

export function verifyCapacitySourceIdentity(before) {
  assert.equal(before.schemaVersion, 1);
  const after = captureCapacitySourceIdentity({ applicationRepositoryRoot: before.repositoryRoot,
    expectedApplicationRevision: before.repositoryRevision, runnerPath: before.runnerPath });
  assert.deepEqual(after, before, 'CAPACITY_SOURCE_IDENTITY_CHANGED');
  return after;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    let proof;
    if (action === 'capture') {
      assert.equal(args.length, 3);
      proof = captureCapacitySourceIdentity({ applicationRepositoryRoot: args[0],
        expectedApplicationRevision: args[1], runnerPath: args[2] });
    } else {
      assert.equal(action, 'verify'); assert.equal(args.length, 2);
      proof = verifyCapacitySourceIdentity(JSON.parse(readFileSync(args[0], 'utf8').replace(/^\uFEFF/, '')));
      writeFileSync(args[1], JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
    }
    process.stdout.write(JSON.stringify(proof) + '\n');
  } catch {
    process.stderr.write('Capacity application or harness source identity is missing, dirty, untracked, or changed.\n');
    process.exitCode = 1;
  }
}
