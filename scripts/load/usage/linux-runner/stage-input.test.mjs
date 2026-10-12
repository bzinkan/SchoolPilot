import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStageRequest } from './stage-input.mjs';
import { manifestSha256 } from './evidence.mjs';
const runId = 'usage-linux-test-20261012';
function request() { const manifest = { schemaVersion: 1, purpose: 'approved_input', totalBytes: 1, inputAllowlistSha256: 'b'.repeat(64), entries: [{ path: 'image.tar', kind: 'oci_image', bytes: 1, sha256: 'a'.repeat(64) }] }; return { schemaVersion: 1, kind: 'usage_linux_input_placement', runId, executorUid: 1000, transferUid: 1001, source: `/srv/usage/transfer/incoming/${runId}.age`, stagingRoot: `/srv/usage/staging/${runId}`, destinationRoot: `/srv/usage/work/input-${runId}`, identityPath: '/srv/usage/keys/input-identity.txt', direction: 'input', location: 'runner', manifest, manifestSha256: manifestSha256(manifest), expectedCiphertext: { sha256: 'c'.repeat(64), bytes: 99 }, expectedBundle: { sha256: 'd'.repeat(64), bytes: 20 }, approvedInputAllowlist: manifest.entries }; }
test('placement binds source chroot, unique staging, executor, identity and exact input allowlist', () => {
  validateStageRequest(request());
  for (const [key, value] of Object.entries({ source: '/srv/usage/keys/input-identity.txt', destinationRoot: '/srv/usage/raw', stagingRoot: '/tmp/staging', executorUid: 0, transferUid: 1000, location: 'owner', direction: 'return', manifestSha256: '0'.repeat(64) })) assert.throws(() => validateStageRequest({ ...request(), [key]: value }), key);
  const altered = request(); altered.approvedInputAllowlist = [{ ...altered.manifest.entries[0], sha256: 'd'.repeat(64) }]; assert.throws(() => validateStageRequest(altered));
});
