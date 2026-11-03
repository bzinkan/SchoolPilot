// Real local age/replay rehearsal. It proves owner tooling, never Linux host admission.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pinnedExecutable } from './cloud.mjs';
import { assertPrivatePath, createManifest, decryptBundle, encryptBundle, ensurePrivateDirectory, hashFile, manifestSha256, readBundle, sealDualCopyCustody, writeBundle, writePrivateBytesExclusive, writePrivateJsonExclusive } from './evidence.mjs';
export async function runCanary(p) {
  assert.equal(p.schemaVersion, 1); assert.equal(p.kind, 'usage_owner_custody_canary');
  assert.match(p.runId, /^canary-[a-z0-9-]{8,40}$/);
  await ensurePrivateDirectory(p.parent); await ensurePrivateDirectory(p.secondParent);
  assert.notEqual(path.resolve(p.parent), path.resolve(p.secondParent));
  for (const tool of [p.age, p.ageKeygen, p.replayer]) await pinnedExecutable(tool);
  const root = path.join(p.parent, p.runId); await ensurePrivateDirectory(root, { create: true });
  const identities = {}, recipients = {};
  for (const direction of ['input', 'return']) {
    const identity = path.join(root, `${direction}-identity.txt`);
    const result = spawnSync(p.ageKeygen.path, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, maxBuffer: 16384 });
    assert.equal(result.status, 0); await writePrivateBytesExclusive(identity, result.stdout); identities[direction] = identity;
    const pub = spawnSync(p.ageKeygen.path, ['-y', identity], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, encoding: 'utf8' });
    assert.equal(pub.status, 0); recipients[direction] = pub.stdout.trim();
  }
  assert.notEqual(recipients.input, recipients.return);
  const input = path.join(root, 'source'); await ensurePrivateDirectory(input, { create: true });
  await writePrivateJsonExclusive(path.join(input, 'retained-failure.json'), { schemaVersion: 1, kind: 'harmless_custody_canary', failed: true, capacityAccepted: false, productionReadiness: false, humanApprovalClaim: false });
  const manifest = await createManifest({ root: input, purpose: 'evidence_return', entries: [{ path: 'retained-failure.json', kind: 'raw_receipt' }] });
  const manifestHash = manifestSha256(manifest); await writePrivateJsonExclusive(path.join(root, 'return-manifest.json'), manifest);
  const bundlePath = path.join(root, 'return.bundle');
  const bundle = await writeBundle({ root: input, manifest, expectedManifestSha256: manifestHash, bundlePath });
  const encrypted = await encryptBundle({ bundlePath, expectedBundle: bundle, outputPath: path.join(root, 'return.age'), receiptPath: path.join(root, 'encrypted-return.json'), age: p.age, recipients, direction: 'return', location: 'runner' });
  const decoded = path.join(root, 'decrypted.bundle');
  await decryptBundle({ ciphertextPath: encrypted.ciphertext.file, expectedCiphertext: encrypted.ciphertext, outputPath: decoded, age: p.age, ageKeygen: p.ageKeygen, identityPath: identities.return, recipients, direction: 'return', location: 'owner' });
  assert.deepEqual(await hashFile(decoded), { sha256: bundle.sha256, bytes: bundle.bytes });
  const copies = [];
  for (const destinationRoot of [path.join(root, 'copy-one'), path.join(p.secondParent, p.runId)]) {
    await readBundle({ bundlePath: decoded, destinationRoot, expectedManifestSha256: manifestHash });
    copies.push({ root: destinationRoot, manifest, expectedManifestSha256: manifestHash, replay: async facts => {
      const nonce = randomUUID(); const request = path.join(root, `${nonce}-replay-input.json`), output = path.join(root, `${nonce}-replay-output.json`);
      await writePrivateJsonExclusive(request, facts); await pinnedExecutable(p.replayer);
      const result = spawnSync(process.execPath, [p.replayer.path, request, output], { windowsHide: true, stdio: 'ignore', timeout: 90000 });
      assert.equal(result.status, 0, 'independent canary replay refused'); const record = JSON.parse(await fs.readFile(output));
      return { passed: record.passed, reviewer: record.reviewer, receipt: { file: output, ...(await hashFile(output)) } };
    } });
  }
  const custody = await sealDualCopyCustody({ copies, receiptPath: path.join(root, 'dual-copy-custody.json') });
  // Separately exercise approved-input encryption/decryption with a nonsecret metadata allowlist.
  const metadata = await hashFile(path.join(input, 'retained-failure.json'));
  const allowlist = [{ path: 'retained-failure.json', kind: 'nonsecret_metadata', ...metadata }];
  const inputManifest = await createManifest({ root: input, purpose: 'approved_input', entries: [{ path: 'retained-failure.json', kind: 'nonsecret_metadata' }], approvedInputAllowlist: allowlist });
  const inputHash = manifestSha256(inputManifest), inputPath = path.join(root, 'input.bundle');
  const inputBundle = await writeBundle({ root: input, manifest: inputManifest, expectedManifestSha256: inputHash, approvedInputAllowlist: allowlist, bundlePath: inputPath });
  const inputEncrypted = await encryptBundle({ bundlePath: inputPath, expectedBundle: inputBundle, outputPath: path.join(root, 'input.age'), receiptPath: path.join(root, 'encrypted-input.json'), age: p.age, recipients, direction: 'input', location: 'owner' });
  const inputDecoded = path.join(root, 'input-decoded.bundle');
  await decryptBundle({ ciphertextPath: inputEncrypted.ciphertext.file, expectedCiphertext: inputEncrypted.ciphertext, outputPath: inputDecoded, age: p.age, ageKeygen: p.ageKeygen, identityPath: identities.input, recipients, direction: 'input', location: 'runner' });
  await readBundle({ bundlePath: inputDecoded, destinationRoot: path.join(root, 'input-copy'), expectedManifestSha256: inputHash, approvedInputAllowlist: allowlist });
  const ref = async name => ({ path: name, ...(await hashFile(name)) });
  await writePrivateJsonExclusive(path.join(root, 'canary-result.json'), { schemaVersion: 1, kind: 'usage_owner_custody_canary_result', passed: true, realAgeRoundtrips: ['input', 'return'], recipients, custodyReceipt: custody.receipt, returnManifest: await ref(path.join(root, 'return-manifest.json')), chains: {
    input: { encryptionReceipt: await ref(path.join(root, 'encrypted-input.json')), plaintext: await ref(inputPath), decrypted: await ref(inputDecoded), ageKeygenSha256: p.ageKeygen.sha256 },
    return: { encryptionReceipt: await ref(path.join(root, 'encrypted-return.json')), plaintext: await ref(bundlePath), decrypted: await ref(decoded), ageKeygenSha256: p.ageKeygen.sha256 },
  }, linuxHostAdmitted: false, capacityAccepted: false, productionReadiness: false });
  return custody;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [request, flag, expected] = process.argv.slice(2);
  Promise.resolve().then(async () => { assert.equal(flag, '--request-sha256'); await assertPrivatePath(request); assert.equal((await hashFile(request)).sha256, expected); await runCanary(JSON.parse(await fs.readFile(request))); console.log('Local real-age canary and both independent replays passed; Linux admission remains pending.'); }).catch(() => { console.error('Local canary failed; preserve all private partial evidence.'); process.exitCode = 1; });
}
