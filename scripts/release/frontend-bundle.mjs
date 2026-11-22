import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const SCHOOLPILOT_REPOSITORY = 'bzinkan/SchoolPilot';

const exec = promisify(execFile);
const manifestSchema = 1;
const frontendJob = 'Frontend (Vite Build)';
const fileSegment = /^[a-z0-9_][a-z0-9_.-]*$/i;
const gitShaPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function requireRelease(condition, message) {
  if (!condition) throw new Error(message);
}

export function isFrontendPath(path) {
  return typeof path === 'string' && path.split('/').every((part) =>
    fileSegment.test(part) && !part.endsWith('.') &&
    !/^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export async function releaseCommand(command, args, timeout = 120_000) {
  const { stdout } = await exec(command, args, {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout, windowsHide: true,
  });
  return stdout;
}

function validateIdentity(identity) {
  requireRelease(identity.repository === SCHOOLPILOT_REPOSITORY &&
    gitShaPattern.test(identity.sourceSha ?? '') &&
    typeof identity.runId === 'string' && /^[1-9]\d*$/.test(identity.runId) &&
    Number.isSafeInteger(identity.attempt) && identity.attempt > 0,
  'The frontend CI identity is invalid.');
}

async function inventory(root, prefix = '') {
  const dir = join(root, prefix);
  requireRelease((await lstat(dir)).isDirectory(), 'Expected frontend bundle directory.');
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    requireRelease(isFrontendPath(path), 'Invalid frontend bundle path: ' + path);
    if (entry.isDirectory()) {
      paths.push(...await inventory(root, path));
    } else {
      requireRelease(entry.isFile(), 'Expected a regular frontend file: ' + path);
      paths.push(path);
    }
  }
  requireRelease(new Set(paths.map((path) => path.toLowerCase())).size === paths.length,
    'Conflicting frontend bundle paths.');
  return paths.sort();
}

export async function packFrontendBundle(dist, artifact, identity) {
  validateIdentity(identity);
  const paths = await inventory(dist);
  requireRelease(paths.includes('index.html'), 'Standard frontend bundle has no index.html.');
  const files = [];
  for (const path of paths) {
    const body = await readFile(join(dist, path));
    const target = join(artifact, 'dist', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, { flag: 'wx' });
    files.push({ path, size: body.length, sha256: sha256(body) });
  }
  await writeFile(join(artifact, 'manifest.json'),
    JSON.stringify({ manifestSchema, ...identity, files }, null, 2) + '\n', { flag: 'wx' });
}

export async function readFrontendBundle(artifact, expected) {
  const manifestPath = join(artifact, 'manifest.json');
  requireRelease((await lstat(manifestPath)).isFile(), 'Frontend manifest must be a regular file.');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  validateIdentity(manifest);
  requireRelease(manifest.manifestSchema === manifestSchema &&
    Object.entries(expected).every(([key, value]) => manifest[key] === value),
  'Frontend manifest identity does not match the selected CI artifact.');
  const root = join(artifact, 'dist');
  const paths = await inventory(root);
  requireRelease(Array.isArray(manifest.files) && paths.includes('index.html') &&
    manifest.files.length === paths.length &&
    manifest.files.every((file, index) => file?.path === paths[index]),
  'Frontend artifact inventory does not match its manifest.');
  const files = [];
  for (const entry of manifest.files) {
    const body = await readFile(join(root, entry.path));
    requireRelease(sha256Pattern.test(entry.sha256 ?? '') &&
      body.length === entry.size && sha256(body) === entry.sha256,
    'Frontend artifact checksum mismatch: ' + entry.path);
    files.push({ path: entry.path, sha256: entry.sha256, body });
  }
  return {
    manifestSchema,
    repository: manifest.repository,
    sourceSha: manifest.sourceSha,
    runId: manifest.runId,
    attempt: manifest.attempt,
    manifestSha256: sha256(manifestBytes),
    files,
  };
}

const githubJson = async (args) => JSON.parse(await releaseCommand('gh', args));

export async function resolveFrontendArtifact(sourceSha, gh = githubJson) {
  requireRelease(gitShaPattern.test(sourceSha ?? ''), 'Expected a full frontend commit SHA.');
  const runs = await gh([
    'run', 'list', '--repo', SCHOOLPILOT_REPOSITORY, '--workflow', 'ci-build.yml',
    '--branch', 'main', '--event', 'push', '--commit', sourceSha, '--limit', '1',
    '--json', 'databaseId,status,conclusion',
  ]);
  const latest = runs[0];
  requireRelease(latest?.status === 'completed' && latest.conclusion === 'success' &&
    Number.isSafeInteger(latest.databaseId), 'Exact main push CI has not succeeded.');
  const runId = String(latest.databaseId);
  const runPath = 'repos/' + SCHOOLPILOT_REPOSITORY + '/actions/runs/' + runId;
  const run = await gh(['api', runPath]);
  requireRelease(run.id === latest.databaseId && run.head_sha === sourceSha &&
    run.head_branch === 'main' && run.event === 'push' && run.path === '.github/workflows/ci-build.yml' &&
    run.head_repository?.full_name === SCHOOLPILOT_REPOSITORY &&
    run.status === 'completed' && run.conclusion === 'success' &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
  'GitHub CI run identity changed or did not match main.');
  for (let attempt = run.run_attempt; attempt >= 1; attempt--) {
    const pages = await gh([
      'api', runPath + '/attempts/' + attempt + '/jobs?per_page=100', '--paginate', '--slurp',
    ]);
    const jobs = pages.flatMap((page) => page.jobs).filter((job) => job.name === frontendJob);
    if (jobs.length === 0) continue;
    requireRelease(jobs.length === 1 && jobs[0].head_sha === sourceSha &&
      jobs[0].status === 'completed' && jobs[0].conclusion === 'success',
    'The selected CI frontend job did not succeed.');
    return {
      repository: SCHOOLPILOT_REPOSITORY, sourceSha, runId, attempt,
      name: 'schoolpilot-web-' + sourceSha + '-' + attempt,
    };
  }
  throw new Error('No standard frontend build job is available for the selected CI run.');
}

export async function downloadFrontendBundle(sourceSha, target) {
  const { name, ...identity } = await resolveFrontendArtifact(sourceSha);
  await releaseCommand('gh', [
    'run', 'download', identity.runId, '--repo', SCHOOLPILOT_REPOSITORY, '--name', name, '--dir', target,
  ]);
  const bundle = await readFrontendBundle(target, identity);
  return bundle.manifestSha256;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, dist, artifact] = process.argv.slice(2);
  requireRelease(operation === 'pack' && dist && artifact,
    'Usage: node scripts/release/frontend-bundle.mjs pack <dist> <artifact-directory>');
  await packFrontendBundle(dist, artifact, {
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  });
}
