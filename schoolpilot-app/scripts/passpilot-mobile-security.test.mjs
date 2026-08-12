import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertGeneratedSecureStorage,
  assertRepositoryControlledSecureStorage,
  assertSecureStorageApk,
} from './mobile-secure-storage-gates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

test('PassPilot registers secure storage without the removed Preferences plugin', async () => {
  const [settings, build, storage, packageJson] = await Promise.all([
    read('android-passpilot/capacitor.settings.gradle'),
    read('android-passpilot/app/capacitor.build.gradle'),
    read('src/native/storage.js'),
    read('package.json'),
  ]);

  assert.match(settings, /capacitor-secure-storage-plugin/);
  assert.match(build, /capacitor-secure-storage-plugin/);
  assert.doesNotMatch(`${settings}\n${build}`, /capacitor-preferences/);
  assert.doesNotMatch(packageJson, /@capacitor\/preferences/);
  assert.doesNotMatch(storage, /@capacitor\/preferences|Preferences|SharedPreferences|localStorage/);
  assert.match(storage, /VITE_APP_PRODUCT === 'passpilot' \? 'PassPilot' : 'GoPilot'/);
  await assertRepositoryControlledSecureStorage(root);
  await assertGeneratedSecureStorage(root, 'android-passpilot');
});

test('PassPilot APK contains only the fail-closed Keystore storage implementation', async () => {
  await assertSecureStorageApk(root, 'android-passpilot');
});

test('PassPilot release signing is externalized while debug signing remains available', async () => {
  const [gradle, rootIgnore, appIgnore] = await Promise.all([
    read('android-passpilot/app/build.gradle'),
    read('../.gitignore'),
    read('.gitignore'),
  ]);

  for (const variable of [
    'PASSPILOT_KEYSTORE_PATH',
    'PASSPILOT_KEYSTORE_PASSWORD',
    'PASSPILOT_KEY_ALIAS',
    'PASSPILOT_KEY_PASSWORD',
  ]) {
    assert.match(gradle, new RegExp(variable));
  }
  assert.doesNotMatch(gradle, /storeFile\s+file\(['"][^'"]+['"]\)/);
  assert.doesNotMatch(gradle, /storePassword\s+['"][^'"]+['"]|keyPassword\s+['"][^'"]+['"]/);
  assert.match(gradle, /releaseRequested && !releaseSigningConfigured/);

  for (const pattern of ['*.keystore', '*.jks', '*.p12', '*.pem', '*.key']) {
    const escaped = pattern.replace('.', '\\.').replace('*', '\\*');
    assert.match(`${rootIgnore}\n${appIgnore}`, new RegExp(escaped));
  }
});

test('PassPilot debug APK is produced when the Android build has run', async () => {
  const metadataPath = path.join(
    root,
    'android-passpilot',
    'app',
    'build',
    'outputs',
    'apk',
    'debug',
    'output-metadata.json',
  );

  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const output = metadata.elements?.[0];
    assert.equal(output?.versionCode, 1);
    assert.equal(output?.versionName, '1.0');
    const apkPath = path.join(path.dirname(metadataPath), output.outputFile);
    assert.ok((await stat(apkPath)).size > 1_000_000, 'Built PassPilot APK is unexpectedly small.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
});
