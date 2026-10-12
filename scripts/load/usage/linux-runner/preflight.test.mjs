import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256, hashFile } from './relocation.mjs';
import { assertWindow, assertFreshCapture, verifyCheckout, verifyImageImport, assertFixtureAuthority, assertNativeFixtureFacts, verifyPreflight } from './preflight.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(path.join(parent, 'usage-linux-preflight-'));
  t.after(() => { const resolved = realpathSync(root); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^usage-linux-preflight-/); rmSync(resolved, { recursive: true }); }); return root;
}
function put(root, name, value) { const bytes = typeof value === 'string' ? value : JSON.stringify(value), file = path.join(root, name); writeFileSync(file, bytes, { mode: 0o600 }); return { path: file, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) }; }
const now = Date.parse('2026-10-12T12:00:00Z');
test('quiet admission enforces 240 minutes, current date, serial execution, and actual freshness', () => {
  const window = { startsAt: new Date(now - 1).toISOString(), expiresAt: new Date(now + 240 * 60_000).toISOString(), noOtherLoadOrBuilds: true, serialExecution: true };
  assertWindow(window, now);
  assert.throws(() => assertWindow({ ...window, expiresAt: new Date(now + 239 * 60_000).toISOString() }, now), /QUIET_WINDOW_TOO_SHORT/);
  assert.throws(() => assertWindow({ ...window, expiresAt: '2026-10-13T05:00:00Z' }, now), /CROSSES_SCHOOL_DATE/);
  for (const at of [now + 1, now - 600_001]) assert.throws(() => assertFreshCapture({ capturedAtUtc: new Date(at).toISOString() }, now), /STALE/);
});
test('full checkout proof detects CRLF conversion even with matching Git HEAD/tree and clean status', async t => {
  const root = fixture(t); put(root, 'input', 'x\r\n');
  const record = { source: 'a'.repeat(40), tree: 'b'.repeat(40), files: 1, membersSha256: sha256(JSON.stringify([['input', sha256('x\r\n')]])) };
  const git = args => ({ 'rev-parse HEAD': record.source, 'rev-parse HEAD^{tree}': record.tree, 'rev-parse --abbrev-ref HEAD': 'HEAD', 'status --porcelain': '', 'ls-files -z': 'input\0' }[args.join(' ')]);
  await verifyCheckout(root, record, { git }); put(root, 'input', 'x\n');
  await assert.rejects(verifyCheckout(root, record, { git }), /SOURCE_RAW_WORKING_BYTES/);
});
test('full checkout rejects dirty or attached working trees before imports', async t => {
  const root = fixture(t), record = { source: 'a', tree: 'b' };
  await assert.rejects(verifyCheckout(root, record, { git: args => args[1] === 'HEAD' ? 'a' : args[1] === 'HEAD^{tree}' ? 'b' : ' M input' }), /SOURCE_DIRTY/);
});
async function imageFixture(root) {
  const layer = put(root, 'layer', 'compressed-layer'), source = 'a'.repeat(40);
  const diff = `sha256:${sha256('uncompressed-layer')}`;
  const config = put(root, 'config', { os: 'linux', architecture: 'amd64', config: { Labels: { 'org.opencontainers.image.revision': source } }, rootfs: { diff_ids: [diff] } });
  const manifest = put(root, 'manifest', { schemaVersion: 2, config: { digest: `sha256:${config.sha256}` }, layers: [{ digest: `sha256:${layer.sha256}`, size: layer.bytes }] });
  const index = put(root, 'index', { schemaVersion: 2, manifests: [{ digest: `sha256:${manifest.sha256}`, platform: { os: 'linux', architecture: 'amd64' } }] });
  const image = `sha256:${index.sha256}`, legacyContainerImage = `sha256:${sha256('legacy-container-image')}`;
  const imageInspect = put(root, 'image-inspect', { Id: image, Os: 'linux', Architecture: 'amd64', Descriptor: { digest: image }, RootFS: { Layers: [diff] }, Config: { Labels: { 'org.opencontainers.image.revision': source } } });
  const containerInspect = put(root, 'container-inspect', { Image: legacyContainerImage, Config: { Image: image } });
  const archive = put(root, 'archive', 'archive-bytes');
  return { record: { platform: 'linux/amd64', archive, index, manifest, config, layers: [layer], imageInspect, containerInspect }, expected: { image, containerImage: legacyContainerImage, source, configDigest: `sha256:${config.sha256}`, archiveSha256: archive.sha256 } };
}
test('OCI import validates actual index/platform/config/layers while preserving legacy container.Image', async t => {
  const root = fixture(t), { record, expected } = await imageFixture(root), result = await verifyImageImport(record, expected, { root });
  assert.equal(result.configDigest, expected.configDigest); assert.notEqual(result.configDigest, expected.image);
  await assert.rejects(verifyImageImport(record, { ...expected, containerImage: expected.configDigest }, { root }), /CONTAINER_IMAGE_STORE_IDENTITY/);
});
test('flattened image, changed layer bytes, and substituted archive are hard holds', async t => {
  const root = fixture(t), { record, expected } = await imageFixture(root);
  await assert.rejects(verifyImageImport(record, { ...expected, image: expected.configDigest }, { root }), /IMPORTED_IMAGE_IDENTITY/);
  await assert.rejects(verifyImageImport(record, { ...expected, archiveSha256: '0'.repeat(64) }, { root }), /ORIGINAL_IMAGE_ARCHIVE/);
  writeFileSync(record.layers[0].path, 'changed', { mode: 0o600 }); await assert.rejects(verifyImageImport(record, expected, { root }), /BYTE_LENGTH_MISMATCH|REFERENCE_HASH_MISMATCH/);
});
function authority() { return ['a', 'b'].map(schoolId => ({ schoolId, otherClients: 0, schoolActiveRows: 1, licenseRows: 1, controlRows: 500, teachingRows: 100, manualSharedRows: 0, requiredValidUntil: new Date(now + 5 * 3600_000).toISOString(),
  schoolExpiries: 0, licenseExpiries: 0, controlExpiries: 0, teachingExpiries: 0, manualSessionExpiries: 0,
  observedAtUtc: new Date(now).toISOString(), ...Object.fromEntries(['schoolActiveUntil', 'licenseExpiresAt', 'controlHardExpiry', 'teachingScheduledEnd', 'manualSharedLeaseUntil'].map(k => [k, new Date(now + 10 * 3600_000).toISOString()])) })); }
test('fixture authority covers late stages and refuses one expiring lease, hidden extra school, or another client', () => {
  const rows = authority(), options = { now, through: now + 5 * 3600_000, schoolIds: ['a', 'b'] }; assertFixtureAuthority(rows, options);
  for (const patch of [{ manualSharedLeaseUntil: new Date(options.through).toISOString() }, { otherClients: 1 }, { schoolId: 'c' }]) assert.throws(() => assertFixtureAuthority([{ ...rows[0], ...patch }, rows[1]], options));
});
test('canonical unlimited school/license/teaching and zero manual sessions retain explicit null authority without invented dates', () => {
  const rows = authority().map(row => ({ ...row, schoolActiveUntil: null, licenseExpiresAt: null, teachingScheduledEnd: null, manualSharedLeaseUntil: null }));
  const options = { now, through: now + 5 * 3600_000, schoolIds: ['a', 'b'] }; assertFixtureAuthority(rows, options);
  assert.throws(() => assertFixtureAuthority([{ ...rows[0], controlHardExpiry: null }, rows[1]], options));
  assert.throws(() => assertFixtureAuthority([{ ...rows[0], manualSharedRows: 1 }, rows[1]], options));
  assert.throws(() => assertFixtureAuthority([{ ...rows[0], schoolActiveRows: 0 }, rows[1]], options));
});
test('native evidence must carry full exact ledger/catalog and restricted authority, not counts or passed booleans', () => {
  const binding = { source: 'c', expectedMigrations: [{ id: 'expand', checksum: 'a', status: 'complete' }], rlsTables: ['table'] };
  const snapshot = { manifestSha256: 's', data: { 'cold-fixture-state.json': { schools: [{ id: 'a' }, { id: 'b' }] } } };
  const proof = { source: 'c', snapshotManifestSha256: 's', migrations: binding.expectedMigrations, catalog: [{ relname: 'table', relrowsecurity: true, relforcerowsecurity: true, tenantPolicy: true }],
    restrictedRole: { rolsuper: false, rolbypassrls: false, rolinherit: false, currentUser: 'local', expectedUser: 'local' }, schoolCounts: [{ schoolId: 'a', observations: 1_000_001 }, { schoolId: 'b', observations: 1_000_001 }], heartbeatRows: 2_000_002,
    encoding: 'UTF8', timezone: 'UTC', serverVersion: '16.15', authority: authority() };
  const options = { now, through: now + 5 * 3600_000 }; assertNativeFixtureFacts(proof, binding, snapshot, options);
  assert.throws(() => assertNativeFixtureFacts({ ...proof, migrations: [{ ...proof.migrations[0], checksum: 'changed' }], passed: true }, binding, snapshot, options));
  assert.throws(() => assertNativeFixtureFacts({ ...proof, restrictedRole: { ...proof.restrictedRole, rolbypassrls: true } }, binding, snapshot, options), /UNRESTRICTED/);
});
test('wrong host identity and remote Docker endpoints refuse before canonical imports or execution', async () => {
  const request = { schemaVersion: 1, kind: 'usage_linux_preflight_request', endpoint: 'tcp://remote:2375' };
  let called = false; const canonicalLoader = () => { called = true; };
  await assert.rejects(verifyPreflight(request, { platform: 'win32', uid: 1000, canonicalLoader }), /LINUX_UID/);
  await assert.rejects(verifyPreflight(request, { platform: 'linux', uid: 1000, canonicalLoader }), /LOCAL_UNIX/); assert.equal(called, false);
});
