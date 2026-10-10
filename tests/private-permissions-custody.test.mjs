import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPrivatePermissionHelper, bindingHash, CURRENT_RELEASE_TOOL_DEPENDENCIES,
  PRIVATE_PERMISSION_HELPER, PRIVATE_PERMISSION_HELPER_HASHES, createBuildSecurityPermissionQueue } from '../scripts/release-source-binding.mjs';
import { FALLBACK } from '../scripts/register-compatible-fallback-inactive.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperSource = readFileSync(path.join(repository, PRIVATE_PERMISSION_HELPER), 'utf8').replaceAll('\r\n', '\n');
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'sp-private-custody-'));
  const root = path.join(directory, 'repo'), helper = path.join(root, PRIVATE_PERMISSION_HELPER);
  mkdirSync(path.dirname(helper), { recursive: true });
  writeFileSync(helper, helperSource);
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(directory, { recursive: true });
  });
  return { root, helper };
}

test('the frozen helper retains the five original permission functions without deployment imports', () => {
  // SHA of the original contiguous function block before extraction, normalized
  // for checkout line endings and its final blank separator. No historical
  // release receipt is rewritten.
  assert.equal(bindingHash(helperSource.slice(helperSource.indexOf('function Test-IsPathWithin {'))),
    '1b5c289406ff3771c149bd0b4a96e5698c158ae9e7f1b092399c107ece971bcd');
  assert.deepEqual([...helperSource.matchAll(/^function ([A-Za-z-]+) \{/gm)].map(match => match[1]), [
    'Test-IsPathWithin', 'Assert-NoReparsePointInExistingPath', 'Set-PrivatePathPermissions',
    'Assert-PrivatePathPermissions', 'Assert-PrivateInputPath',
  ]);
  assert.equal(/^\. /m.test(helperSource), false);
});

test('current tool custody accepts only the reviewed LF or CRLF helper bytes', t => {
  const f = fixture(t);
  assert.equal(assertPrivatePermissionHelper(f.root), f.helper);
  writeFileSync(f.helper, helperSource.replaceAll('\n', '\r\n'));
  assert.equal(assertPrivatePermissionHelper(f.root), f.helper);
  assert.deepEqual(new Set(PRIVATE_PERMISSION_HELPER_HASHES), new Set([
    bindingHash(helperSource), bindingHash(helperSource.replaceAll('\n', '\r\n')),
  ]));
  writeFileSync(f.helper, helperSource.replace('$security.SetAccessRuleProtection($true, $false)',
    '$security.SetAccessRuleProtection($false, $false)'));
  assert.throws(() => assertPrivatePermissionHelper(f.root), /BINDING_PERMISSION_HELPER_CHANGED/);
});

test('frozen helper tampering rejects a queued read before PowerShell or evidence consumption', async t => {
  const f = fixture(t);
  let commands = 0, reads = 0;
  const check = createBuildSecurityPermissionQueue(async () => { commands++; return { code: 0 }; },
    assertPrivatePermissionHelper(f.root), f.root, PRIVATE_PERMISSION_HELPER_HASHES);
  const pending = check(path.join(path.dirname(f.root), 'evidence.json')).then(() => { reads++; });
  writeFileSync(f.helper, helperSource + '\nfunction Assert-PrivateInputPath { return $Path }\n');
  await assert.rejects(pending, /BINDING_PERMISSION_HELPER_CHANGED/);
  assert.equal(commands, 0);
  assert.equal(reads, 0);
});

test('current runtime imports are all included in release-plan dependency custody', () => {
  const runtime = readFileSync(path.join(repository, 'scripts/deploy-classpilot-runtime-config.ps1'), 'utf8');
  const imports = [...runtime.matchAll(/^\. \(Join-Path \$PSScriptRoot '([^']+)'\)/gm)]
    .map(match => 'scripts/' + match[1]);
  assert.deepEqual(new Set(imports), new Set(CURRENT_RELEASE_TOOL_DEPENDENCIES));
  assert.equal(/^function (?:Test-IsPathWithin|Assert-NoReparsePointInExistingPath|Set-PrivatePathPermissions|Assert-PrivatePathPermissions|Assert-PrivateInputPath) \{/m.test(runtime), false);
});

test('runtime evolution does not alter permission custody or historical release pins', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'scripts/deploy-classpilot-runtime-config.ps1'), '# new rollout profile\n');
  assert.equal(assertPrivatePermissionHelper(f.root), f.helper);
  assert.equal(FALLBACK.permissionHelperSha256, 'bcfd3f3575974c23fa958eaad8c46045ff536523f732fdcfb6d082d34bd08049');
  assert.equal(FALLBACK.permissionHelperLfSha256, '02552442f804a5b58777d844c7b0f0c3680c84e6b14cfe7a3410cb4426125b24');
});

test('permission entry points retain strict failures without importing runtime rollout code', () => {
  for (const name of ['register-compatible-fallback-inactive.mjs', 'prepare-release-artifacts.mjs']) {
    const text = readFileSync(path.join(repository, 'scripts', name), 'utf8');
    assert.ok(text.includes('$ErrorActionPreference = "Stop"\\nSet-StrictMode -Version Latest\\n. $'), name);
  }
});
