import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../scripts/release/verify-ci-release-image.mjs', import.meta.url);
const sha = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);
const registry = '135775632425.dkr.ecr.us-east-1.amazonaws.com';
const image = registry + '/schoolpilot-production-api@' + digest;
const signer = 'https://github.com/bzinkan/SchoolPilot/.github/workflows/release-image.yml@refs/heads/main';

test('verifies the exact private ECR digest, CI signer, source SHA, and CycloneDX attestation', async () => {
  const { verifyCiReleaseImage } = await import(moduleUrl);
  const checks = [];
  let dockerConfig;
  await verifyCiReleaseImage(sha, image, async (command, args, env) => {
    if (command === 'aws') {
      assert.deepEqual(args.slice(0, 4), ['ecr', 'get-login-password', '--region', 'us-east-1']);
      return 'fixture-token\n';
    }
    assert.equal(command, 'cosign');
    assert.equal(args.at(-1), image);
    assert.ok(args.includes(signer));
    assert.ok(args.includes('https://token.actions.githubusercontent.com'));
    dockerConfig = env.DOCKER_CONFIG;
    const auth = JSON.parse(await readFile(join(dockerConfig, 'config.json'), 'utf8'));
    assert.equal(Buffer.from(auth.auths[registry].auth, 'base64').toString(), 'AWS:fixture-token');
    if (args[0] === 'verify') assert.ok(args.includes('applicationSha=' + sha));
    if (args[0] === 'verify-attestation') assert.ok(args.includes('cyclonedx'));
    checks.push(args[0]);
    return '{}';
  });
  assert.deepEqual(checks, ['verify', 'verify-attestation']);
  await assert.rejects(access(dockerConfig), { code: 'ENOENT' });
});

test('rejects a mutable registry tag before fetching any credentials', async () => {
  const { verifyCiReleaseImage } = await import(moduleUrl);
  await assert.rejects(verifyCiReleaseImage(sha, registry + '/schoolpilot-production-api:latest', () => {
    assert.fail('invalid image must stop before invoking AWS or Cosign');
  }), /exact production ECR digest/i);
});

test('the deploy CLI exits nonzero for an unverified image reference', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(moduleUrl), sha, registry + '/schoolpilot-production-api:latest'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /exact production ECR digest/i);
});

test('a rejected signature refuses to authorize the image', async () => {
  const { verifyCiReleaseImage } = await import(moduleUrl);
  const calls = [];
  await assert.rejects(verifyCiReleaseImage(sha, image, async (command, args) => {
    calls.push(command === 'aws' ? 'credentials' : args[0]);
    if (command === 'aws') return 'fixture-token\n';
    throw new Error('wrong source or signer');
  }), /signature verification failed/i);
  assert.deepEqual(calls, ['credentials', 'verify']);
});

test('a valid signature without a valid SBOM fails the release gate', async () => {
  const { verifyCiReleaseImage } = await import(moduleUrl);
  await assert.rejects(verifyCiReleaseImage(sha, image, async (command, args) => {
    if (command === 'aws') return 'fixture-token\n';
    if (args[0] === 'verify-attestation') throw new Error('could not find validated attestations');
    return '{}';
  }), /SBOM attestation verification failed/i);
});
