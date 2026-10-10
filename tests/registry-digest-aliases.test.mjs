import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { selectRegistryDigestImage, validateRegistryManifest } from '../scripts/verify-legacy-deploy-image.mjs';

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const expected = { registryId: '135775632425', repository: 'schoolpilot-production-api' };
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const configDigest = digest('scanned-config');
const platform = JSON.stringify({ schemaVersion: 2, mediaType: manifestType, config: { digest: configDigest }, layers: [] });
const indexType = 'application/vnd.oci.image.index.v1+json';
const index = JSON.stringify({ schemaVersion: 2, mediaType: indexType, manifests: [
  { digest: digest(platform), platform: { os: 'linux', architecture: 'amd64' } },
  { digest: digest('attestation'), platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
] });
function response(manifest = index, tags = ['a'.repeat(40), 'a'.repeat(12)]) {
  return { images: tags.map(imageTag => ({ registryId: expected.registryId, repositoryName: expected.repository,
    imageId: { imageDigest: digest(manifest), imageTag }, imageManifest: manifest,
    imageManifestMediaType: manifest === index ? indexType : manifestType })), failures: [] };
}
const select = value => selectRegistryDigestImage(value, { ...expected, digest: digest(index) });

for (const count of [1, 2, 4, 100]) test(`${count} byte-identical digest aliases are accepted without consuming tag identity`, () => {
  const value = response(index, Array.from({ length: count }, (_, n) => `alias-${n}`));
  const before = structuredClone(value);
  assert.equal(select(value), value.images[0]); assert.deepEqual(value, before);
  value.images.reverse(); assert.equal(select(value), value.images[0]);
});

test('actual index-to-platform manifest validation accepts both full and short aliases at each digest', async () => {
  const requests = [];
  const proof = await validateRegistryManifest(async requested => {
    requests.push(requested);
    const value = response(requested === digest(index) ? index : platform);
    return selectRegistryDigestImage(value, { ...expected, digest: requested });
  }, digest(index), configDigest);
  assert.deepEqual(requests, [digest(index), digest(platform)]);
  assert.deepEqual(proof, { digest: digest(index), platformDigest: digest(platform), configDigest });
});

for (const [name, mutate] of Object.entries({
  wrongRegistry: value => { value.images[1].registryId = '000000000000'; },
  wrongRepository: value => { value.images[1].repositoryName = 'another-repository'; },
  wrongDigest: value => { value.images[1].imageId.imageDigest = digest('substitution'); },
  conflictingManifest: value => { value.images[1].imageManifest += '\n'; },
  conflictingMediaType: value => { value.images[1].imageManifestMediaType = manifestType; },
  missingDigest: value => { delete value.images[1].imageId; },
  missingRow: value => { value.images[1] = null; },
  emptyManifest: value => { value.images[0].imageManifest = ''; },
  emptyMediaType: value => { value.images[0].imageManifestMediaType = ''; },
  emptyImages: value => { value.images = []; },
  missingImages: value => { delete value.images; },
  tooManyImages: value => { value.images = Array.from({ length: 101 }, () => structuredClone(value.images[0])); },
  providerFailure: value => { value.failures.push({ failureCode: 'ImageNotFound' }); },
  missingFailures: value => { delete value.failures; },
  malformedFailures: value => { value.failures = {}; },
})) test(`digest alias selector rejects ${name}`, () => {
  const value = response(); mutate(value); assert.throws(() => select(value), /REGISTRY_/);
});

for (const field of ['registryId', 'repository', 'digest']) test(`invalid requested ${field} rejects before row selection`, () => {
  const value = response();
  assert.throws(() => selectRegistryDigestImage(value, { ...expected, digest: digest(index), [field]: 'invalid' }), /REGISTRY_/);
});

test('matching aliases cannot bypass manifest byte digest validation', async () => {
  const value = response(); for (const row of value.images) row.imageManifest += '\n';
  await assert.rejects(validateRegistryManifest(async () => select(value), digest(index), configDigest), /Registry manifest bytes do not match digest/);
});
