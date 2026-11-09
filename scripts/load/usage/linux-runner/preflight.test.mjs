import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256, hashFile } from './relocation.mjs';
import { assertWindow, assertFreshCapture, verifyCheckout, verifyImageImport, assertFixtureAuthority, assertNativeFixtureFacts, verifyPreflight, sourceBindingOptions } from './preflight.mjs';
import { expectedSourceGitConfig } from './source-checkout.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(path.join(parent, 'usage-linux-preflight-'));
  t.after(() => { const resolved = realpathSync(root); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^usage-linux-preflight-/); rmSync(resolved, { recursive: true }); }); return root;
}
function put(root, name, value) { const bytes = typeof value === 'string' ? value : JSON.stringify(value), file = path.join(root, name); writeFileSync(file, bytes, { mode: 0o600 }); return { path: file, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) }; }
const now = Date.parse('2026-10-12T12:00:00Z');
test('each release source requires its own complete binding and review; baseline cannot inherit candidate authority',()=>{
  const freeze={usageSourceBindingFile:'/candidate/binding',usageSourceBindingSha256:'a'.repeat(64),usageSourceReviewFile:'/candidate/review',usageSourceReviewSha256:'b'.repeat(64),
    baselineUsageSourceBindingFile:'/baseline/binding',baselineUsageSourceBindingSha256:'c'.repeat(64),baselineUsageSourceReviewFile:'/baseline/review',baselineUsageSourceReviewSha256:'d'.repeat(64)};
  assert.equal(sourceBindingOptions(freeze,'baseline').usageSourceBindingFile,'/baseline/binding');
  assert.equal(sourceBindingOptions(freeze,'candidate').usageSourceReviewSha256,'b'.repeat(64));
  assert.throws(()=>sourceBindingOptions({...freeze,baselineUsageSourceReviewSha256:undefined},'baseline'),/SOURCE_BINDING_REQUIRED/);
  assert.throws(()=>sourceBindingOptions({...freeze,baselineUsageSourceBindingSha256:'a'},'baseline'),/INVALID_SHA256/);
  assert.throws(()=>sourceBindingOptions(freeze,'other'),/SOURCE_BINDING_ROLE/);
});
test('quiet admission enforces 240 minutes, current date, serial execution, and actual freshness', () => {
  const window = { startsAt: new Date(now - 1).toISOString(), expiresAt: new Date(now + 240 * 60_000).toISOString(), noOtherLoadOrBuilds: true, serialExecution: true };
  assertWindow(window, now);
  assert.throws(() => assertWindow({ ...window, expiresAt: new Date(now + 239 * 60_000).toISOString() }, now), /QUIET_WINDOW_TOO_SHORT/);
  assert.throws(() => assertWindow({ ...window, expiresAt: '2026-10-13T05:00:00Z' }, now), /CROSSES_SCHOOL_DATE/);
  for (const at of [now + 1, now - 600_001]) assert.throws(() => assertFreshCapture({ capturedAtUtc: new Date(at).toISOString() }, now), /STALE/);
});
function checkoutFixture(t) {
  const root = fixture(t); put(root, 'input', 'x\r\n');
  const gd = path.join(root, '.git'), packName = `pack-${'c'.repeat(40)}`;
  mkdirSync(path.join(gd, 'objects', 'pack'), { recursive: true, mode: 0o700 });
  const record = { source: 'a'.repeat(40), tree: 'b'.repeat(40), files: 1, sha256: sha256('archive'), bytes: 7, membersSha256: sha256(JSON.stringify([['input', sha256('x\r\n')]])) };
  const members = [{ path: 'input', gitMode: '100755', gitBlobOid: 'd'.repeat(40), sha256: sha256('x\r\n') }];
  const restoration = { empty: path.join(root, 'empty'), plan: { roles: { candidate: { ...record, archive: { sha256: record.sha256, bytes: record.bytes }, members } }, shallowHeads: [record.source], objects: [{ oid: record.source, type: 'commit', bytes: 100 }], pack: { sha256: sha256('pack') } } };
  put(gd, 'config', expectedSourceGitConfig(restoration.empty)); put(gd, 'shallow', `${record.source}\n`); put(gd, 'HEAD', `${record.source}\n`);
  put(path.join(gd, 'objects', 'pack'), `${packName}.pack`, 'pack'); put(path.join(gd, 'objects', 'pack'), `${packName}.idx`, 'index');
  const responses = { 'rev-parse HEAD': record.source, 'rev-parse HEAD^{tree}': record.tree, 'rev-parse --abbrev-ref HEAD': 'HEAD', 'status --porcelain=v1 --untracked-files=all': '', 'ls-files -z': 'input\0', 'ls-files --stage -z': `100755 ${'d'.repeat(40)} 0\tinput\0`, 'cat-file --batch-all-objects --batch-check=%(objectname) %(objecttype) %(objectsize)': `${record.source} commit 100\n`, 'fsck --strict --full --no-reflogs': '' };
  return { root, gd, record, responses, options: { restoration, role: 'candidate', git: args => { assert.ok(Object.hasOwn(responses, args.join(' '))); return responses[args.join(' ')]; } } };
}
test('full checkout proof detects CRLF conversion even with matching Git HEAD/tree and clean status', async t => {
  const { root, record, options } = checkoutFixture(t);
  await verifyCheckout(root, record, options); put(root, 'input', 'x\n');
  await assert.rejects(verifyCheckout(root, record, options), /SOURCE_RAW_WORKING_BYTES/);
});
test('full checkout rejects dirty or attached working trees before imports', async t => {
  const { root, record, options, responses } = checkoutFixture(t);
  responses['status --porcelain=v1 --untracked-files=all'] = ' M input';
  await assert.rejects(verifyCheckout(root, record, options), /SOURCE_DIRTY/);
  responses['status --porcelain=v1 --untracked-files=all'] = ''; responses['rev-parse --abbrev-ref HEAD'] = 'main';
  await assert.rejects(verifyCheckout(root, record, options), /SOURCE_NOT_DETACHED/);
});
test('private working modes do not replace canonical Git index modes or pack bytes', async t => {
  const { root, gd, record, options, responses } = checkoutFixture(t);
  await verifyCheckout(root, record, options);
  responses['ls-files --stage -z'] = responses['ls-files --stage -z'].replace('100755', '100644');
  await assert.rejects(verifyCheckout(root, record, options), /SOURCE_INDEX_MODES_OR_BLOBS/);
  responses['ls-files --stage -z'] = responses['ls-files --stage -z'].replace('100644', '100755');
  put(path.join(gd, 'objects', 'pack'), `pack-${'c'.repeat(40)}.pack`, 'changed');
  await assert.rejects(verifyCheckout(root, record, options), /SOURCE_GIT_PACK_BYTES/);
});
test('supplied Git indirection and altered generated config are refused before imports', async t => {
  const { root, gd, record, options } = checkoutFixture(t);
  put(gd, 'config', `${expectedSourceGitConfig(options.restoration.empty)}[include]\npath=/tmp/foreign\n`);
  await assert.rejects(verifyCheckout(root, record, options), /SOURCE_GIT_CONFIG/);
  put(gd, 'config', expectedSourceGitConfig(options.restoration.empty)); put(gd, 'commondir', '/tmp/foreign');
  await assert.rejects(verifyCheckout(root, record, options), /SOURCE_GIT_INDIRECTION/);
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
