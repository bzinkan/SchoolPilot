// A separate, deliberately narrow replay hook for the local encryption canary.
// A pass proves custody of this one harmless failed sample only, never capacity.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertPrivatePath, canonicalJson, hashFile, verifyManifest, writePrivateJsonExclusive } from './evidence.mjs';

export const CANARY_PAYLOAD = Object.freeze({ schemaVersion: 1, kind: 'harmless_custody_canary', failed: true, capacityAccepted: false, productionReadiness: false, humanApprovalClaim: false });
const PAYLOAD_BYTES = Buffer.from(`${canonicalJson(CANARY_PAYLOAD)}\n`);
const PAYLOAD_SHA256 = createHash('sha256').update(PAYLOAD_BYTES).digest('hex');
const REVIEWER = 'Independent harmless custody canary replayer (AI-reviewed tooling)';

export async function replayHarmlessCanary(facts, outputPath, requestReference = null) {
  assert.match(facts.invocationNonce, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(facts.manifest?.purpose, 'evidence_return');
  assert.equal(facts.manifest.entries.length, 1);
  assert.deepEqual(facts.manifest.entries[0], { path: 'retained-failure.json', kind: 'raw_receipt', sha256: PAYLOAD_SHA256, bytes: PAYLOAD_BYTES.length });
  await verifyManifest({ root: facts.root, manifest: facts.manifest, expectedManifestSha256: facts.manifestSha256 });
  const samplePath = path.join(facts.root, 'retained-failure.json');
  await assertPrivatePath(samplePath);
  assert.deepEqual(await readFile(samplePath), PAYLOAD_BYTES, 'The original failed canary must remain byte-exact and failed.');
  const receipt = {
    schemaVersion: 1, kind: 'independent_usage_evidence_replay', passed: true,
    root: facts.root, manifestSha256: facts.manifestSha256, invocationNonce: facts.invocationNonce,
    reviewer: REVIEWER, reviewedAtUtc: new Date().toISOString(), requestReference,
    scope: 'One fixed harmless local custody canary; no Linux transfer or canonical acceptance replay.',
    sampleOutcome: 'failed', retainedFailedValue: true, sampleSha256: PAYLOAD_SHA256,
    capacityAccepted: false, operationalAuthorization: false, productionReadiness: false, humanApprovalClaim: false,
  };
  return { ...receipt, receipt: await writePrivateJsonExclusive(outputPath, receipt) };
}

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2);
  const [inputPath, outputPath] = args;
  await assertPrivatePath(inputPath);
  const request = await hashFile(inputPath);
  assert.ok(request.bytes <= 1024 * 1024);
  const facts = JSON.parse(await readFile(inputPath, 'utf8'));
  assert.equal((await hashFile(inputPath)).sha256, request.sha256);
  await replayHarmlessCanary(facts, outputPath, { file: inputPath, ...request });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('Harmless custody canary replay refused; private records retained.\n'); process.exitCode = 1; });
}
