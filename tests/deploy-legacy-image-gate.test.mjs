import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { SCANNER, sha256, createEvidenceDirectory, inspectImage, scanCounts, scannerArguments,
  scanBuiltImage, verifyPublishedImage, validateRegistryManifest, archiveConfigDigest, verifyCleanSource } from '../scripts/verify-legacy-deploy-image.mjs';

const sourceSha = 'a'.repeat(40), imageId = `sha256:${'b'.repeat(64)}`;
function tar(entries) {
  const output = [];
  for (const [name, value] of entries) {
    const bytes = Buffer.from(value), header = Buffer.alloc(512);
    header.write(name); header.write(bytes.length.toString(8).padStart(11, '0'), 124); header[156] = 48;
    output.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...output, Buffer.alloc(1024)]);
}
function savedImage() {
  const config = JSON.stringify({ os: 'linux', architecture: 'amd64', config: { Labels: { 'org.opencontainers.image.revision': sourceSha } } });
  const configDigest = `sha256:${sha256(config)}`, name = `blobs/sha256/${sha256(config)}`;
  return { configDigest, bytes: tar([[name, config], ['manifest.json', JSON.stringify([{ Config: name, RepoTags: null, Layers: [] }])]]) };
}
function imageInspect() { return [{ Id: imageId, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': sourceSha } } }]; }
function report(configDigest, findings = []) { return { SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: configDigest }, Results: [{ Target: 'alpine', Vulnerabilities: findings }] }; }
function registryImage(configDigest, changes = {}) {
  const imageManifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: configDigest }, layers: [], ...changes });
  return { imageId: { imageDigest: `sha256:${sha256(imageManifest)}` }, imageManifest, imageManifestMediaType: JSON.parse(imageManifest).mediaType, repositoryName: 'schoolpilot-production-api' };
}
function fixture(t, options = {}) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'deploy image gate test '));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const directory = createEvidenceDirectory(sourceSha, parent), saved = savedImage(), commands = [];
  writeFileSync(path.join(directory, 'build-image-id.txt'), imageId);
  let inspectionCount = 0, scannerOwnership = '';
  const run = async (executable, args) => {
    commands.push({ executable, args });
    if (executable === 'aws') {
      const row = registryImage(options.wrongConfig ? `sha256:${'c'.repeat(64)}` : saved.configDigest);
      return { code: 0, stdout: JSON.stringify({ images: [row], failures: [] }), stderr: '' };
    }
    assert.equal(executable, 'docker');
    if (args[0] === 'context') {
      assert.deepEqual(args, ['context', 'inspect', 'reviewed-context']);
      return { code: 0, stdout: JSON.stringify([{ Endpoints: { docker: { Host: 'npipe:////./pipe/dockerDesktopLinuxEngine' } } }]), stderr: '' };
    }
    assert.deepEqual(args.slice(0, 2), ['--host', 'npipe:////./pipe/dockerDesktopLinuxEngine']);
    const operation = args.slice(2);
    if (operation[0] === 'pull') return { code: options.pullFail ? 1 : 0, stdout: '', stderr: '' };
    if (operation.slice(0, 2).join(' ') === 'image inspect') {
      if (operation[2] === SCANNER) return { code: 0, stdout: JSON.stringify([{ RepoDigests: [SCANNER] }]), stderr: '' };
      const value = imageInspect();
      if (options.drift && ++inspectionCount === 3) value[0].Id = `sha256:${'d'.repeat(64)}`;
      return { code: 0, stdout: JSON.stringify(value), stderr: '' };
    }
    if (operation.slice(0, 2).join(' ') === 'image save') {
      assert.equal(operation.at(-1), imageId);
      writeFileSync(operation[3], saved.bytes); return { code: 0, stdout: '', stderr: '' };
    }
    if (operation[0] === 'run') {
      scannerOwnership = operation[operation.indexOf('--label') + 1].split('=')[1];
      assert.ok(operation.includes(SCANNER)); assert.ok(operation.includes('--scanners'));
      assert.equal(operation.includes('--ignore-unfixed'), false); assert.equal(operation.includes('--severity'), false);
      writeFileSync(path.join(directory, 'reports', 'trivy.json'), JSON.stringify(report(saved.configDigest, options.findings)));
      return { code: options.scanFail ? 1 : 0, stdout: '', stderr: '' };
    }
    if (operation.slice(0, 2).join(' ') === 'container ls') return { code: options.cleanupUnknown ? 1 : 0, stdout: options.containerLeft ? 'synthetic-id' : '', stderr: '' };
    if (operation.slice(0, 2).join(' ') === 'container inspect') return { code: 0, stdout: JSON.stringify([{ Config: { Labels: { 'schoolpilot.image-scan': options.wrongOwner ? 'other-run' : scannerOwnership } } }]), stderr: '' };
    if (operation.slice(0, 2).join(' ') === 'container rm') return { code: 0, stdout: '', stderr: '' };
    throw new Error(`Unexpected command: ${operation.join(' ')}`);
  };
  const scan = () => scanBuiltImage({ directory, sourceSha, imageRef: 'schoolpilot-api:synthetic' }, { run, environment: options.context
    ? { DOCKER_HOST: 'must-not-use-this-host', DOCKER_CONTEXT: 'reviewed-context' }
    : { DOCKER_HOST: 'npipe:////./pipe/dockerDesktopLinuxEngine' } });
  return { directory, saved, commands, run, scan };
}

test('complete local scan binds Docker index ID, saved config, scanner report, receipt and registry bytes', async t => {
  const f = fixture(t), scan = await f.scan();
  assert.equal(scan.imageId, imageId); assert.equal(await archiveConfigDigest(path.join(f.directory, 'input', 'image.tar'), sourceSha), f.saved.configDigest);
  const row = registryImage(f.saved.configDigest);
  const proof = await verifyPublishedImage({ ...scan, sourceSha, repository: 'schoolpilot-production-api', region: 'us-east-1', digest: row.imageId.imageDigest }, { run: f.run });
  assert.equal(proof.passed, true); assert.equal(proof.configDigest, f.saved.configDigest);
  assert.ok(f.commands.filter(value => value.executable === 'aws').every(value => value.args[0] === 'ecr' && value.args[1] === 'batch-get-image'));
});
test('Docker context environment precedence matches the actual build and pins later operations', async t => {
  const f = fixture(t, { context: true }); await f.scan();
  assert.deepEqual(f.commands[0].args, ['context', 'inspect', 'reviewed-context']);
});
test('full report retains lower severities and cleanup removes only the owned scanner', async t => {
  const f = fixture(t, { containerLeft: true, findings: [{ Severity: 'MEDIUM', FixedVersion: '' }, { Severity: 'LOW', FixedVersion: '1' }] });
  const scan = await f.scan(), receipt = JSON.parse(readFileSync(scan.receiptPath));
  assert.equal(receipt.passed, true); assert.equal(receipt.counts.MEDIUM, 1); assert.equal(receipt.counts.LOW, 1);
  assert.equal(f.commands.filter(value => value.args.includes('rm')).length, 1);
});
for (const options of [{ cleanupUnknown: true }, { containerLeft: true, wrongOwner: true }]) test(`uncertain cleanup never returns usable admission: ${Object.keys(options).join(',')}`, async t => {
  const f = fixture(t, options); await assert.rejects(f.scan(), /cleanup unconfirmed/);
  assert.equal(JSON.parse(readFileSync(path.join(f.directory, 'cleanup.json'))).complete, false);
  assert.equal(f.commands.some(value => value.args.includes('rm')), false);
});
for (const Severity of ['HIGH', 'CRITICAL']) for (const FixedVersion of ['', '1.2.3']) test(`${Severity} blocks even when FixedVersion is ${FixedVersion || 'absent'}`, async t => {
  const f = fixture(t, { findings: [{ Severity, FixedVersion }] });
  await assert.rejects(f.scan(), /Legacy image scan failed/);
  const receipt = JSON.parse(readFileSync(path.join(f.directory, 'scan-receipt.json')));
  assert.equal(receipt.passed, false); assert.equal(receipt.counts[Severity], 1);
  assert.ok(existsSync(path.join(f.directory, 'reports', 'trivy.json')));
  assert.equal(f.commands.some(value => value.executable === 'aws'), false);
});
for (const options of [{ pullFail: true }, { scanFail: true }, { drift: true }]) test(`scan fails closed on ${Object.keys(options)[0]}`, async t => {
  const f = fixture(t, options); await assert.rejects(f.scan(), /Legacy image scan failed/);
  assert.ok(existsSync(path.join(f.directory, 'failure.json')));
  assert.equal(f.commands.some(value => value.executable === 'aws'), false);
});
for (const target of ['scan-receipt.json', 'reports/trivy.json', 'input/image.tar']) test(`changed ${target} cannot reach registry verification`, async t => {
  const f = fixture(t), scan = await f.scan(); writeFileSync(path.join(f.directory, target), 'tampered');
  await assert.rejects(verifyPublishedImage({ ...scan, sourceSha, repository: 'schoolpilot-production-api', region: 'us-east-1', digest: imageId }, { run: f.run }));
  assert.equal(f.commands.some(value => value.executable === 'aws'), false);
});
test('local source/platform mismatch and missing scan data fail closed', () => {
  const good = imageInspect(); assert.equal(inspectImage(good, imageId, sourceSha).imageId, imageId);
  for (const change of [{ Id: `sha256:${'f'.repeat(64)}` }, { Architecture: 'arm64' }, { Os: 'windows' }, { Config: { Labels: {} } }]) assert.throws(() => inspectImage([{ ...good[0], ...change }], imageId, sourceSha));
  assert.throws(() => scanCounts(report(`sha256:${'f'.repeat(64)}`), imageId));
  assert.throws(() => scanCounts({ ...report(imageId), Results: [] }, imageId));
});
test('Windows and Linux bind paths with spaces remain single literal arguments', () => {
  const windows = 'C:\\Users\\Synthetic Person\\AppData\\Local\\Temp\\image scan';
  if (process.platform === 'win32') {
    const args = scannerArguments(windows, 'owned-scanner', 'synthetic');
    assert.ok(args.includes('type=bind,source=C:/Users/Synthetic Person/AppData/Local/Temp/image scan/input,target=/input,readonly'));
  }
  const args = scannerArguments(path.join(os.tmpdir(), 'image scan'), 'owned-scanner', 'synthetic');
  assert.equal(args.filter(value => value.startsWith('type=bind')).length, 3);
  assert.equal(args.includes(SCANNER), true);
});
test('registry manifest and index retain exact digest/config/platform bindings', async () => {
  const manifest = registryImage(imageId);
  assert.equal((await validateRegistryManifest(async () => manifest, manifest.imageId.imageDigest, imageId)).configDigest, imageId);
  const index = registryImage(imageId, { mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
    { digest: manifest.imageId.imageDigest, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: `sha256:${'e'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
  ] });
  const proof = await validateRegistryManifest(async digest => digest === index.imageId.imageDigest ? index : manifest, index.imageId.imageDigest, imageId);
  assert.equal(proof.platformDigest, manifest.imageId.imageDigest);
  await assert.rejects(validateRegistryManifest(async () => ({ ...manifest, imageManifest: `${manifest.imageManifest} ` }), manifest.imageId.imageDigest, imageId), /manifest bytes/);
  await assert.rejects(validateRegistryManifest(async () => manifest, manifest.imageId.imageDigest, `sha256:${'f'.repeat(64)}`), /Published config/);
  const wrong = registryImage(imageId, { mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ digest: manifest.imageId.imageDigest, platform: { os: 'linux', architecture: 'arm64' } }] });
  await assert.rejects(validateRegistryManifest(async () => wrong, wrong.imageId.imageDigest, imageId), /linux\/amd64/);
});

const deploy = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const trapStart = deploy.indexOf('deploy_exit_cleanup() {');
const trapEnd = deploy.indexOf('\n}\n', trapStart) + 3;
assert.ok(trapStart > 0 && trapEnd > trapStart);
const start = deploy.indexOf('  if [[ -n "$IMMUTABLE_IMAGE_DIGEST" ]]; then', deploy.indexOf('  preflight_microsoft_sign_in_secret\n'));
const end = deploy.indexOf('  # Register API, worker, and one-off migration definitions', start);
assert.ok(start > 0 && end > start);
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
for (const failure of ['build', 'scan', 'registry', 'none', 'immutable']) test(`actual legacy deployment fragment orders publication/registration safely: ${failure}`, t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'deploy fragment ')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const slash = value => value.replaceAll('\\', '/');
  const trace = path.join(directory, 'trace'), script = path.join(directory, 'test.sh');
  const scan = { imageId, dockerHost: 'npipe:////./pipe/dockerDesktopLinuxEngine', receiptPath: `${slash(directory)}/receipt.json`, receiptSha256: 'e'.repeat(64) };
  writeFileSync(path.join(directory, 'scan.json'), JSON.stringify(scan));
  writeFileSync(script, `set -euo pipefail
info() { :; }; success() { :; }; error() { :; }
cleanup_temp_files() { printf 'cleanup-scratch\\n' >> "$TRACE"; }
cleanup_protected_window_recovery_files() { printf 'cleanup-recovery\\n' >> "$TRACE"; }
${deploy.slice(trapStart, trapEnd)}
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=false
PROTECTED_WINDOW_DEPLOYMENT_BOUNDS_ACTIVE=false
PRODUCTION_SCALING_HOLD_ACTIVE=false
trap deploy_exit_cleanup EXIT
node() {
 if [[ "$1" == *verify-legacy-deploy-image.mjs ]]; then
  printf '%s\\n' "helper:$2" >> "$TRACE"
  case "$2" in
   init) printf '%s\\n' "$SCAN_DIR" ;;
   scan) [[ "$FAILURE" != scan ]] || return 1; cat "$SCAN_DIR/scan.json" ;;
   verify-registry) [[ "$FAILURE" != registry ]] || return 1 ;;
  esac
 else "$REAL_NODE" "$@"; fi
}
docker() { printf '%s\\n' "docker:$*" >> "$TRACE"; if [[ "$1" == build && "$FAILURE" == build ]]; then return 1; fi; }
aws() { printf '%s\\n' "aws:$*" >> "$TRACE"; if [[ "$2" == describe-images ]]; then printf '%s\\n' "$TEST_DIGEST"; else printf 'synthetic-login-input'; fi; }
${deploy.slice(start, end)}
printf 'register-task-definition\\n' >> "$TRACE"
`);
  const result = spawnSync(bash, [slash(script)], { shell: false, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, FAILURE: failure, TRACE: slash(trace), SCAN_DIR: slash(directory), REAL_NODE: slash(process.execPath),
      SCRIPT_DIR: '/unused scripts', IMMUTABLE_IMAGE_DIGEST: failure === 'immutable' ? imageId : '', IMMUTABLE_IMAGE_SHA: sourceSha,
      LOCAL_SHA: sourceSha, NAME: 'schoolpilot-production', IMAGE_TAG: sourceSha, REGION: 'us-east-1', ACCOUNT_ID: '123456789012',
      ECR_REPO: '123456789012.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api', CONFIRM_PROTECTED_WINDOW_PRODUCTION_MUTATION: 'false', TEST_DIGEST: imageId },
    timeout: 15_000 });
  const calls = readFileSync(trace, 'utf8');
  assert.equal(result.status, ['none', 'immutable'].includes(failure) ? 0 : 1, result.stderr);
  assert.equal(calls.includes('register-task-definition'), ['none', 'immutable'].includes(failure));
  assert.match(calls, /cleanup-scratch\ncleanup-recovery\n$/);
  if (['build', 'scan'].includes(failure)) assert.doesNotMatch(calls, /aws:| push | login /);
  if (failure === 'none') {
    assert.ok(calls.indexOf('helper:scan') < calls.indexOf('aws:ecr get-login-password'));
    assert.ok(calls.indexOf('helper:verify-registry') < calls.indexOf('register-task-definition'));
    assert.match(calls, new RegExp(` tag ${imageId} `));
  }
  if (failure === 'immutable') assert.doesNotMatch(calls, /docker:|helper:/);
});

test('source rechecks reject moved, dirty and newly introduced image inputs', async () => {
  for (const defect of ['none', 'head', 'tracked', 'untracked']) {
    const calls = [];
    const run = async (executable, args) => {
      assert.equal(executable, 'git'); calls.push(args);
      return { code: 0, stdout: args[0] === 'rev-parse' ? `${defect === 'head' ? 'c'.repeat(40) : sourceSha}\n`
        : args[0] === 'status' && defect === 'tracked' ? ' M src/changed.ts\n'
        : args[0] === 'ls-files' && defect === 'untracked' ? 'src/new.ts\n' : '', stderr: '' };
    };
    if (defect === 'none') { await verifyCleanSource(sourceSha, run); assert.ok(calls[2].includes('docs/soc2')); }
    else await assert.rejects(verifyCleanSource(sourceSha, run));
  }
});
