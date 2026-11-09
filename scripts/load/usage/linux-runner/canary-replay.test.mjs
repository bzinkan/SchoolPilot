import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CANARY_PAYLOAD, replayHarmlessCanary } from './canary-replay.mjs';
import { assertPrivatePath, createManifest, ensurePrivateDirectory, manifestSha256, verifyReturnedEvidence, writePrivateJsonExclusive } from './evidence.mjs';

let sandbox;
let sequence = 0;
before(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'schoolpilot-canary-replay-'));
  if (process.platform === 'win32') {
    const helper = fileURLToPath(new URL('../../../private-permissions.ps1', import.meta.url));
    const executable = [process.env.SCHOOLPILOT_CUSTODY_PWSH_PATH, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'pwsh.exe'))].find((value) => value && path.isAbsolute(value) && existsSync(value));
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; . $env:SP_TEST_HELPER; Set-PrivatePathPermissions -Path $env:SP_TEST_PATH -Directory; Assert-PrivatePathPermissions -Path $env:SP_TEST_PATH -Directory"], { windowsHide: true, encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, ProgramFiles: process.env.ProgramFiles, SP_TEST_HELPER: helper, SP_TEST_PATH: sandbox } });
    assert.equal(result.status, 0);
  } else await chmod(sandbox, 0o700);
  await assertPrivatePath(sandbox, { directory: true });
});
after(async () => {
  assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(sandbox).startsWith('schoolpilot-canary-replay-'));
  await rm(sandbox, { recursive: true });
});
async function fixture(payload = CANARY_PAYLOAD) {
  const root = path.join(sandbox, `copy-${++sequence}`);
  await ensurePrivateDirectory(root, { create: true });
  await writePrivateJsonExclusive(path.join(root, 'retained-failure.json'), payload);
  const manifest = await createManifest({ root, purpose: 'evidence_return', entries: [{ path: 'retained-failure.json', kind: 'raw_receipt' }] });
  return { root, manifest, manifestSha256: manifestSha256(manifest), invocationNonce: randomUUID() };
}

test('independent hook preserves the byte-exact failed sample and binds the fresh invocation', async () => {
  const facts = await fixture();
  const output = path.join(sandbox, `${randomUUID()}.json`);
  const result = await verifyReturnedEvidence({ root: facts.root, manifest: facts.manifest, expectedManifestSha256: facts.manifestSha256, replay: async (actual) => {
    const record = await replayHarmlessCanary(actual, output);
    return { passed: record.passed, reviewer: record.reviewer, receipt: record.receipt };
  } });
  assert.equal(result.independentReplayPassed, true);
  const receipt = JSON.parse(await readFile(output));
  assert.equal(receipt.invocationNonce, result.invocationNonce);
  assert.equal(receipt.retainedFailedValue, true);
  assert.equal(receipt.capacityAccepted, false);
  assert.equal(receipt.productionReadiness, false);
  assert.equal(JSON.parse(await readFile(path.join(facts.root, 'retained-failure.json'))).failed, true);
});

test('a relabeled successful sample fails even under a newly valid manifest', async () => {
  const facts = await fixture({ ...CANARY_PAYLOAD, failed: false });
  await assert.rejects(replayHarmlessCanary(facts, path.join(sandbox, `${randomUUID()}.json`)));
});

test('unrelated content and malformed nonce are refused, and replay never overwrites a receipt', async () => {
  const facts = await fixture();
  await assert.rejects(replayHarmlessCanary({ ...facts, invocationNonce: 'supplied-stale-proof' }, path.join(sandbox, `${randomUUID()}.json`)));
  const output = path.join(sandbox, `${randomUUID()}.json`);
  await replayHarmlessCanary(facts, output);
  await assert.rejects(replayHarmlessCanary(facts, output), { code: 'EEXIST' });
  const unrelated = await fixture({ ...CANARY_PAYLOAD, extra: 'unreviewed input' });
  await assert.rejects(replayHarmlessCanary(unrelated, path.join(sandbox, `${randomUUID()}.json`)));
});

test('CLI reads the actual private request and writes only its bound harmless replay receipt', async () => {
  const facts = await fixture();
  const input = path.join(sandbox, `${randomUUID()}-request.json`);
  const output = path.join(sandbox, `${randomUUID()}-receipt.json`);
  const ref = await writePrivateJsonExclusive(input, facts);
  const execution = spawnSync(process.execPath, [fileURLToPath(new URL('./canary-replay.mjs', import.meta.url)), input, output], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, '');
  const record = JSON.parse(await readFile(output));
  assert.equal(record.requestReference.sha256, ref.sha256);
  assert.equal(record.invocationNonce, facts.invocationNonce);
  assert.equal(record.sampleOutcome, 'failed');
  assert.equal(record.operationalAuthorization, false);
});
