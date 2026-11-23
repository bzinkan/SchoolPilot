import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const registry = '135775632425.dkr.ecr.us-east-1.amazonaws.com';
const imagePattern = /^135775632425\.dkr\.ecr\.us-east-1\.amazonaws\.com\/schoolpilot-production-api@sha256:[a-f0-9]{64}$/;
const issuer = 'https://token.actions.githubusercontent.com';
const signer = 'https://github.com/bzinkan/SchoolPilot/.github/workflows/release-image.yml@refs/heads/main';
const exec = promisify(execFile);

async function runCommand(command, args, env) {
  const { stdout } = await exec(command, args, {
    env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  return stdout;
}

export async function verifyCiReleaseImage(applicationSha, image, run = runCommand) {
  if (!/^[a-f0-9]{40}$/.test(applicationSha ?? '') || !imagePattern.test(image ?? '')) {
    throw new Error('Expected a full application SHA and exact production ECR digest.');
  }
  let token;
  try {
    token = (await run('aws', [
      'ecr', 'get-login-password', '--region', 'us-east-1', '--no-cli-pager',
    ], process.env)).trim();
    if (!token || /\s/.test(token)) throw new Error('Invalid ECR credential.');
  } catch (error) {
    throw new Error('Could not obtain short-lived ECR credentials for Cosign.', { cause: error });
  }

  const dockerConfig = await mkdtemp(join(tmpdir(), 'schoolpilot-cosign-'));
  try {
    const auth = Buffer.from('AWS:' + token).toString('base64');
    await writeFile(join(dockerConfig, 'config.json'), JSON.stringify({
      auths: { [registry]: { auth } },
    }), { flag: 'wx', mode: 0o600 });
    const env = { ...process.env, DOCKER_CONFIG: dockerConfig };
    const identity = ['--certificate-identity', signer, '--certificate-oidc-issuer', issuer];
    try {
      await run('cosign', ['verify', ...identity, '-a', 'applicationSha=' + applicationSha, image], env);
    } catch (error) {
      const detail = error.code === 'ENOENT' ? ' Install Cosign on the release host.' : '';
      throw new Error('CI release image signature verification failed.' + detail, { cause: error });
    }
    try {
      await run('cosign', ['verify-attestation', ...identity, '--type', 'cyclonedx', image], env);
    } catch (error) {
      throw new Error('CI release image SBOM attestation verification failed.', { cause: error });
    }
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyCiReleaseImage(...process.argv.slice(2));
    console.log('Verified the release-image workflow signature, application SHA, and CycloneDX SBOM.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
