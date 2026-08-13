import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertGeneratedSecureStorage,
  assertRepositoryControlledSecureStorage,
  assertSecureStorageApk,
} from './mobile-secure-storage-gates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath, encoding = 'utf8') => readFile(path.join(root, relativePath), encoding);

async function walk(directory, predicate) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(absolute, predicate));
    else if (predicate(absolute)) results.push(absolute);
  }
  return results;
}

test('generated Android project registers secure storage and no plaintext fallback', async () => {
  const [settings, build, storage, manifest] = await Promise.all([
    read('android-gopilot/capacitor.settings.gradle'),
    read('android-gopilot/app/capacitor.build.gradle'),
    read('src/native/storage.js'),
    read('android-gopilot/app/src/main/AndroidManifest.xml'),
  ]);
  assert.match(settings, /capacitor-secure-storage-plugin/);
  assert.match(build, /capacitor-secure-storage-plugin/);
  assert.doesNotMatch(`${settings}\n${build}`, /capacitor-preferences/);
  assert.doesNotMatch(storage, /Preferences|SharedPreferences|localStorage/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.doesNotMatch(manifest, /android\.permission\.CAMERA|usesCleartextTraffic="true"|android\.intent\.category\.BROWSABLE|com\.schoolpilot\.gopilot/);
  await assertRepositoryControlledSecureStorage(root);
  await assertGeneratedSecureStorage(root, 'android-gopilot');
});

test('GoPilot APK contains only the fail-closed Keystore storage implementation', async () => {
  await assertSecureStorageApk(root, 'android-gopilot');
});

test('generated GoPilot web bundle is staff-only', async () => {
  const publicRoot = path.join(root, 'android-gopilot', 'app', 'src', 'main', 'assets', 'public');
  const files = await walk(publicRoot, (file) => /\.(?:html|js|json)$/i.test(file));
  assert.ok(files.length > 0, 'Capacitor public bundle is missing; run cap:sync:gopilot first.');
  const names = files.map((file) => path.basename(file)).join('\n');
  assert.doesNotMatch(names, /ParentApp|ParentOnboarding|JoinSchool|LinkChild|QrScanner/i);
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(source, /html5-qrcode|qrcode\.react|@capacitor\/preferences|Scan Parent QR/i);
  for (const retiredPath of ['/gopilot/join/', '/gopilot/onboarding', '/gopilot/parent', '/gopilot/link']) {
    assert.equal(source.includes(retiredPath), false, `${retiredPath} must not be bundled into native GoPilot`);
  }
  assert.doesNotMatch(source, /GoPilot parent portal is unavailable/);
  assert.match(source, /GoPilot staff access is unavailable/);
  assert.match(source, /Sign out/);
  assert.match(source, /staff_car_number/);
  assert.match(source, /staff_search/);
});

test('Android release signing is externalized and debug APK carries bumped identity when built', async () => {
  const [gradle, rootIgnore, appIgnore] = await Promise.all([
    read('android-gopilot/app/build.gradle'),
    read('../.gitignore'),
    read('.gitignore'),
  ]);
  assert.match(gradle, /GOPILOT_KEYSTORE_PATH/);
  assert.match(gradle, /GOPILOT_KEYSTORE_PASSWORD/);
  assert.match(gradle, /versionCode 5/);
  assert.match(gradle, /versionName ['"]2\.0\.0['"]/);
  assert.doesNotMatch(gradle, /storePassword\s+['"][^'"]+['"]|keyPassword\s+['"][^'"]+['"]/);
  for (const pattern of ['*.keystore', '*.jks', '*.p12', '*.pem', '*.key']) {
    assert.match(`${rootIgnore}\n${appIgnore}`, new RegExp(pattern.replace('.', '\\.').replace('*', '\\*')));
  }

  const secretFiles = await walk(path.join(root, 'android-gopilot'), (file) =>
    !file.includes(`${path.sep}build${path.sep}`) && /\.(?:jks|keystore|p12|pem|key)$/i.test(file));
  assert.deepEqual(secretFiles, [], 'Signing key material must not be stored in the project.');

  const metadataPath = path.join(root, 'android-gopilot', 'app', 'build', 'outputs', 'apk', 'debug', 'output-metadata.json');
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.equal(metadata.elements[0].versionCode, 5);
    assert.equal(metadata.elements[0].versionName, '2.0.0');
    const apkPath = path.join(path.dirname(metadataPath), metadata.elements[0].outputFile);
    assert.ok((await stat(apkPath)).size > 1_000_000, 'Built APK is unexpectedly small.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
});
