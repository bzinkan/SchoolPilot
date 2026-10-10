import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCANNER = 'aquasec/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const severities = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const media = {
  manifests: new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']),
  indexes: new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']),
};
export const sha256 = value => createHash('sha256').update(value).digest('hex');
async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function jsonFile(filename, value) { writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
function validSource(sourceSha) { assert.match(sourceSha, SHA, 'Exact source SHA required'); }
function safePath(directory) {
  assert.ok(path.isAbsolute(directory) && !/[\r\n\t,]/.test(directory), 'Absolute evidence path without control characters or commas required');
  return directory.replaceAll('\\', '/');
}
export function createEvidenceDirectory(sourceSha, temporaryRoot = os.tmpdir()) {
  validSource(sourceSha);
  const directory = mkdtempSync(path.join(temporaryRoot, 'schoolpilot-image-scan-'));
  mkdirSync(path.join(directory, 'input')); mkdirSync(path.join(directory, 'reports')); mkdirSync(path.join(directory, 'cache'));
  jsonFile(path.join(directory, 'source.json'), { schemaVersion: 1, sourceSha, createdAt: new Date().toISOString() });
  return safePath(directory);
}

// No shell: Windows paths containing spaces remain one argument. Children inherit
// the same Docker context/credentials as deploy; only content-free receipts persist.
export function runCommand(executable, args, options = {}) {
  return new Promise(resolve => execFile(executable, args, {
    windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })));
}
async function checked(run, executable, args, options) {
  const result = await run(executable, args, options);
  assert.equal(result.code, 0, `${executable} command failed`);
  return result.stdout;
}
export async function verifyCleanSource(sourceSha, run = runCommand) {
  validSource(sourceSha);
  assert.equal((await checked(run, 'git', ['rev-parse', 'HEAD'])).trim(), sourceSha, 'Deploy source moved');
  assert.equal((await checked(run, 'git', ['status', '--porcelain', '--untracked-files=no'])).trim(), '', 'Tracked deploy source changed');
  // The existing controller creates untracked task-definition scratch files.
  // Permit those while rejecting any new file entering a Docker COPY boundary.
  assert.equal((await checked(run, 'git', ['ls-files', '--others', '--exclude-standard', '--',
    'src', 'docs/soc2', 'package.json', 'package-lock.json', 'tsconfig.json', 'drizzle.config.ts', 'Dockerfile', '.dockerignore'])).trim(), '', 'Untracked image source changed');
}
async function dockerHost(run, environment) {
  if (!environment.DOCKER_CONTEXT && environment.DOCKER_HOST) return environment.DOCKER_HOST;
  const context = environment.DOCKER_CONTEXT || (await checked(run, 'docker', ['context', 'show'])).trim();
  const inspected = JSON.parse(await checked(run, 'docker', ['context', 'inspect', context]));
  assert.equal(inspected.length, 1);
  const host = inspected[0]?.Endpoints?.docker?.Host;
  assert.equal(typeof host, 'string'); assert.ok(host.length > 0 && !/[\r\n\t]/.test(host));
  return host;
}
// Docker's containerd image store exposes an index/manifest as image.Id; the
// classic store exposes its config digest. Read the config bytes from the exact
// saved archive instead of confusing these identities or trusting report labels.
async function readTarEntry(filename, wanted) {
  const file = await open(filename, 'r');
  try {
    const bytes = (await file.stat()).size;
    for (let position = 0; position + 512 <= bytes;) {
      const header = Buffer.alloc(512);
      assert.equal((await file.read(header, 0, 512, position)).bytesRead, 512);
      if (header.every(value => value === 0)) break;
      const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
      const sizeText = text(124, 12).trim(); assert.match(sizeText, /^[0-7]+$/);
      const size = Number.parseInt(sizeText, 8); assert.ok(Number.isSafeInteger(size) && size >= 0);
      const prefix = text(345, 155), name = `${prefix ? `${prefix}/` : ''}${text(0, 100)}`;
      assert.ok(position + 512 + size <= bytes, 'Truncated image archive');
      if (name === wanted) {
        assert.ok(header[156] === 0 || header[156] === 48, 'Archive metadata must be a regular file');
        assert.ok(size > 0 && size <= 8 * 1024 * 1024, 'Unbounded archive metadata');
        const value = Buffer.alloc(size);
        assert.equal((await file.read(value, 0, size, position + 512)).bytesRead, size);
        return value;
      }
      position += 512 + Math.ceil(size / 512) * 512;
    }
    throw new Error('Image archive metadata missing');
  } finally { await file.close(); }
}
export async function archiveConfigDigest(filename, sourceSha) {
  const manifest = JSON.parse((await readTarEntry(filename, 'manifest.json')).toString('utf8'));
  assert.ok(Array.isArray(manifest) && manifest.length === 1, 'Exactly one saved executable image required');
  assert.match(manifest[0].Config, /^(?:blobs\/sha256\/)?[a-f0-9]{64}(?:\.json)?$/);
  const bytes = await readTarEntry(filename, manifest[0].Config), digest = sha256(bytes);
  assert.ok(manifest[0].Config.includes(digest), 'Saved config filename/hash mismatch');
  const config = JSON.parse(bytes.toString('utf8'));
  assert.equal(config.os, 'linux'); assert.equal(config.architecture, 'amd64');
  assert.equal(config.config?.Labels?.['org.opencontainers.image.revision'], sourceSha);
  return `sha256:${digest}`;
}
export function inspectImage(value, expectedId, sourceSha) {
  assert.match(expectedId, DIGEST);
  assert.ok(Array.isArray(value) && value.length === 1, 'Exactly one local image required');
  const image = value[0];
  assert.equal(image.Id, expectedId, 'Built image identity changed');
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64');
  assert.equal(image.Config?.Labels?.['org.opencontainers.image.revision'], sourceSha, 'Image source label mismatch');
  return { imageId: image.Id, os: image.Os, architecture: image.Architecture, sourceSha };
}
export function scanCounts(report, imageId) {
  assert.equal(report.SchemaVersion, 2, 'Unsupported scanner report');
  assert.equal(report.ArtifactType, 'container_image');
  assert.equal(report.Metadata?.ImageID, imageId, 'Scanner did not inspect the built image');
  assert.ok(Array.isArray(report.Results) && report.Results.length > 0, 'Missing full scan results');
  const counts = Object.fromEntries(severities.map(value => [value, 0]));
  for (const result of report.Results) {
    assert.equal(typeof result.Target, 'string');
    assert.ok(result.Vulnerabilities === undefined || Array.isArray(result.Vulnerabilities));
    for (const finding of result.Vulnerabilities ?? []) {
      assert.ok(severities.includes(finding.Severity), 'Unknown severity encoding');
      counts[finding.Severity]++;
    }
  }
  return counts;
}
export function scannerArguments(directory, containerName, ownership) {
  const root = safePath(directory);
  return ['run', '--rm', '--name', containerName, '--label', `schoolpilot.image-scan=${ownership}`,
    '--mount', `type=bind,source=${root}/input,target=/input,readonly`,
    '--mount', `type=bind,source=${root}/reports,target=/reports`,
    '--mount', `type=bind,source=${root}/cache,target=/root/.cache/trivy`,
    SCANNER, 'image', '--input', '/input/image.tar', '--scanners', 'vuln', '--timeout', '10m',
    '--format', 'json', '--output', '/reports/trivy.json', '--exit-code', '0'];
}
export async function scanBuiltImage({ directory, sourceSha, imageRef }, { run = runCommand, environment = process.env } = {}) {
  validSource(sourceSha); safePath(directory);
  assert.match(imageRef, /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/);
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'source.json'), 'utf8')).sourceSha, sourceSha);
  const expectedId = readFileSync(path.join(directory, 'build-image-id.txt'), 'utf8').trim();
  assert.match(expectedId, DIGEST);
  const host = await dockerHost(run, environment);
  const docker = (args, options) => checked(run, 'docker', ['--host', host, ...args], options);
  const ownership = randomUUID(), containerName = `schoolpilot-image-scan-${ownership}`;
  const receiptPath = path.join(directory, 'scan-receipt.json');
  let attemptedContainer = false;
  try {
    const image = inspectImage(JSON.parse(await docker(['image', 'inspect', expectedId])), expectedId, sourceSha);
    inspectImage(JSON.parse(await docker(['image', 'inspect', imageRef])), expectedId, sourceSha);
    await docker(['image', 'save', '--output', path.join(directory, 'input', 'image.tar'), expectedId], { timeout: 600_000 });
    const archiveSha256 = await fileHash(path.join(directory, 'input', 'image.tar'));
    const configDigest = await archiveConfigDigest(path.join(directory, 'input', 'image.tar'), sourceSha);
    // Always use the immutable scanner digest, including its initial pull.
    await docker(['pull', SCANNER], { timeout: 600_000 });
    const scanner = JSON.parse(await docker(['image', 'inspect', SCANNER]));
    assert.ok(scanner.length === 1 && scanner[0].RepoDigests?.some(value => value.endsWith(`@${SCANNER.split('@')[1]}`)), 'Scanner digest mismatch');
    attemptedContainer = true;
    const scan = await run('docker', ['--host', host, ...scannerArguments(directory, containerName, ownership)], { timeout: 720_000 });
    writeFileSync(path.join(directory, 'reports', 'scanner.stdout.log'), scan.stdout, { flag: 'wx' });
    writeFileSync(path.join(directory, 'reports', 'scanner.stderr.log'), scan.stderr, { flag: 'wx' });
    assert.equal(scan.code, 0, 'Pinned scanner execution failed');
    const reportPath = path.join(directory, 'reports', 'trivy.json');
    const counts = scanCounts(JSON.parse(readFileSync(reportPath, 'utf8')), configDigest);
    assert.equal(await fileHash(path.join(directory, 'input', 'image.tar')), archiveSha256, 'Scanned archive changed');
    inspectImage(JSON.parse(await docker(['image', 'inspect', imageRef])), expectedId, sourceSha);
    const receipt = { schemaVersion: 1, passed: counts.HIGH === 0 && counts.CRITICAL === 0,
      createdAt: new Date().toISOString(), ...image, configDigest, dockerHost: host, scanner: SCANNER, counts,
      gate: 'All HIGH and CRITICAL findings block regardless of fix availability',
      archiveSha256, reportSha256: await fileHash(reportPath) };
    jsonFile(receiptPath, receipt);
    assert.equal(receipt.passed, true, 'HIGH/CRITICAL image vulnerabilities block publication');
    return { imageId: expectedId, dockerHost: host, receiptPath: safePath(receiptPath), receiptSha256: await fileHash(receiptPath) };
  } catch (error) {
    if (!existsSync(path.join(directory, 'failure.json'))) jsonFile(path.join(directory, 'failure.json'), {
      schemaVersion: 1, sourceSha, expectedId, passed: false, stage: 'image_scan',
      reason: error instanceof Error ? error.message : 'Image scan failed',
    });
    throw new Error(`Legacy image scan failed; retained evidence: ${directory}`, { cause: error });
  } finally {
    if (attemptedContainer) {
      // A timed-out Docker client can leave its scanner running. Remove only this
      // run's named and labelled container; an uncertain cleanup fails closed.
      try {
        const inspected = await run('docker', ['--host', host, 'container', 'ls', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.ID}}']);
        assert.equal(inspected.code, 0, 'Cannot confirm scanner cleanup');
        if (inspected.stdout.trim()) {
          const value = JSON.parse(await docker(['container', 'inspect', containerName]));
          assert.equal(value.length, 1); assert.equal(value[0].Config?.Labels?.['schoolpilot.image-scan'], ownership);
          await docker(['container', 'rm', '--force', containerName]);
        }
        jsonFile(path.join(directory, 'cleanup.json'), { complete: true, ownedScanner: containerName });
      } catch {
        jsonFile(path.join(directory, 'cleanup.json'), { complete: false, ownedScanner: containerName });
        throw new Error(`Scanner cleanup unconfirmed; publication blocked; retained evidence: ${directory}`);
      }
    }
  }
}

export function selectRegistryDigestImage(response, { registryId, repository, digest }) {
  assert.match(registryId, /^\d{12}$/, 'REGISTRY_ACCOUNT_REQUIRED');
  assert.match(repository, /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/, 'REGISTRY_REPOSITORY_REQUIRED');
  assert.match(digest, DIGEST, 'REGISTRY_DIGEST_REQUIRED');
  assert.ok(Array.isArray(response?.failures) && response.failures.length === 0, 'REGISTRY_IMAGE_FAILURES');
  assert.ok(Array.isArray(response.images) && response.images.length > 0 && response.images.length <= 100, 'REGISTRY_IMAGE_ROWS_INVALID');
  const first = response.images[0];
  assert.ok(typeof first?.imageManifest === 'string' && first.imageManifest.length > 0
    && typeof first.imageManifestMediaType === 'string' && first.imageManifestMediaType.length > 0, 'REGISTRY_MANIFEST_REQUIRED');
  // Digest queries can emit one row per tag. Every alias must bind the same bytes.
  for (const image of response.images) {
    assert.deepEqual([image?.registryId, image?.repositoryName, image?.imageId?.imageDigest],
      [registryId, repository, digest], 'REGISTRY_IMAGE_IDENTITY_CHANGED');
    assert.equal(image.imageManifest, first.imageManifest, 'REGISTRY_ALIAS_MANIFEST_CHANGED');
    assert.equal(image.imageManifestMediaType, first.imageManifestMediaType, 'REGISTRY_ALIAS_MEDIA_TYPE_CHANGED');
  }
  return first;
}

export async function validateRegistryManifest(fetchManifest, digest, expectedImageId) {
  assert.match(digest, DIGEST); assert.match(expectedImageId, DIGEST);
  const top = await fetchManifest(digest);
  function parse(value, expected) {
    assert.equal(value.imageId?.imageDigest, expected, 'Registry response digest mismatch');
    assert.equal(`sha256:${sha256(value.imageManifest)}`, expected, 'Registry manifest bytes do not match digest');
    const manifest = JSON.parse(value.imageManifest);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.mediaType, value.imageManifestMediaType);
    return manifest;
  }
  let manifest = parse(top, digest), platformDigest = digest;
  if (media.indexes.has(manifest.mediaType)) {
    assert.ok(Array.isArray(manifest.manifests));
    const platforms = manifest.manifests.filter(value => value.platform?.os === 'linux' && value.platform?.architecture === 'amd64');
    assert.equal(platforms.length, 1, 'Exactly one linux/amd64 registry image required');
    for (const value of manifest.manifests) if (value !== platforms[0]) {
      assert.ok(value.platform?.os === 'unknown' && value.platform?.architecture === 'unknown'
        && value.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest', 'Unexpected executable image in registry index');
    }
    platformDigest = platforms[0].digest; assert.match(platformDigest, DIGEST);
    manifest = parse(await fetchManifest(platformDigest), platformDigest);
  }
  assert.ok(media.manifests.has(manifest.mediaType), 'Unsupported registry image format');
  assert.equal(manifest.config?.digest, expectedImageId, 'Published config differs from scanned image');
  return { digest, platformDigest, configDigest: expectedImageId };
}
export async function verifyPublishedImage({ receiptPath, receiptSha256, sourceSha, repository, digest, region }, { run = runCommand } = {}) {
  validSource(sourceSha); assert.match(receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(await fileHash(receiptPath), receiptSha256, 'Scan receipt changed');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')), directory = path.dirname(receiptPath);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.sourceSha, sourceSha); assert.equal(receipt.passed, true);
  assert.equal(receipt.scanner, SCANNER); assert.equal(receipt.os, 'linux'); assert.equal(receipt.architecture, 'amd64');
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'cleanup.json'), 'utf8')).complete, true, 'Scanner cleanup unconfirmed');
  const reportPath = path.join(directory, 'reports', 'trivy.json');
  assert.equal(await fileHash(reportPath), receipt.reportSha256, 'Scan report changed');
  const counts = scanCounts(JSON.parse(readFileSync(reportPath, 'utf8')), receipt.configDigest);
  assert.equal(counts.HIGH, 0); assert.equal(counts.CRITICAL, 0); assert.deepEqual(counts, receipt.counts);
  assert.equal(await fileHash(path.join(directory, 'input', 'image.tar')), receipt.archiveSha256, 'Scanned export changed');
  assert.equal(await archiveConfigDigest(path.join(directory, 'input', 'image.tar'), sourceSha), receipt.configDigest);
  assert.match(repository, /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/); assert.match(region, /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/);
  const proof = await validateRegistryManifest(async imageDigest => {
    const result = JSON.parse(await checked(run, 'aws', ['ecr', 'batch-get-image', '--repository-name', repository,
      '--image-ids', `imageDigest=${imageDigest}`, '--region', region, '--output', 'json', '--no-cli-pager']));
    assert.ok(Array.isArray(result.images) && result.images.length > 0 && (result.failures ?? []).length === 0, 'Exact registry image unavailable');
    const image = result.images[0];
    // ECR can return one entry per tag even when queried by an immutable digest.
    // Admit aliases only when every entry describes exactly the same manifest.
    for (const alias of result.images) {
      assert.equal(alias.repositoryName, repository, 'Registry repository mismatch');
      assert.equal(alias.imageId?.imageDigest, imageDigest, 'Registry response digest mismatch');
      assert.equal(alias.imageManifestMediaType, image.imageManifestMediaType, 'Registry alias media type mismatch');
      assert.equal(alias.imageManifest, image.imageManifest, 'Registry alias manifest mismatch');
    }
    return image;
  }, digest, receipt.configDigest);
  const result = { schemaVersion: 1, passed: true, sourceSha, receiptSha256, scanner: SCANNER,
    repository, region, ...proof, verifiedAt: new Date().toISOString() };
  jsonFile(path.join(directory, 'registry-proof.json'), result);
  return result;
}

async function main(argv) {
  const [operation, ...args] = argv;
  if (operation === 'init' && args.length === 1) {
    await verifyCleanSource(args[0]); console.log(createEvidenceDirectory(args[0]));
  } else if (operation === 'scan' && args.length === 3) {
    await verifyCleanSource(args[1]);
    const result = await scanBuiltImage({ directory: args[0], sourceSha: args[1], imageRef: args[2] });
    await verifyCleanSource(args[1]); console.log(JSON.stringify(result));
  } else if (operation === 'verify-registry' && args.length === 6) {
    await verifyCleanSource(args[2]);
    const result = await verifyPublishedImage({ receiptPath: args[0], receiptSha256: args[1], sourceSha: args[2], repository: args[3], digest: args[4], region: args[5] });
    await verifyCleanSource(args[2]); console.log(JSON.stringify(result));
  }
  else throw new Error('Expected init <source>, scan <evidence-directory> <source> <local-tag>, or verify-registry <receipt> <receipt-sha256> <source> <repository> <digest> <region>');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
