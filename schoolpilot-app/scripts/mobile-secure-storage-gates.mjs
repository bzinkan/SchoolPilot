import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LOCAL_DEPENDENCY = 'file:plugins/capacitor-secure-storage-plugin';
const LOCKED_LOCAL_PATH = 'plugins/capacitor-secure-storage-plugin';
const PACKAGE_NAME = 'capacitor-secure-storage-plugin';
const HELPER_PATH = path.join(
  'android',
  'src',
  'main',
  'java',
  'com',
  'whitestein',
  'securestorage',
  'PasswordStorageHelper.java',
);
const PLUGIN_PATH = path.join(
  'android',
  'src',
  'main',
  'java',
  'com',
  'whitestein',
  'securestorage',
  'SecureStoragePluginPlugin.java',
);
const NATIVE_SOURCE_ROOT = path.join('android', 'src');
const EXPECTED_NATIVE_SOURCES = [
  'main/java/com/whitestein/securestorage/PasswordStorageHelper.java',
  'main/java/com/whitestein/securestorage/SecureStorageException.java',
  'main/java/com/whitestein/securestorage/SecureStoragePluginPlugin.java',
];
const EXPECTED_COMPILED_CLASSES = [
  'com/whitestein/securestorage/PasswordStorageHelper.class',
  'com/whitestein/securestorage/SecureStorageException.class',
  'com/whitestein/securestorage/SecureStoragePluginPlugin.class',
];

async function readUtf8(filePath) {
  return readFile(filePath, 'utf8');
}

async function nativeSourceManifest(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.(?:java|kt|kts)$/.test(entry.name)) files.push(absolute);
    }
  }
  await visit(root);
  const manifest = await Promise.all(files.map(async (absolute) => ({
    path: path.relative(root, absolute).split(path.sep).join('/'),
    source: await readUtf8(absolute),
  })));
  return manifest.sort((left, right) => left.path.localeCompare(right.path));
}

export async function assertRepositoryControlledSecureStorage(appRoot) {
  const controlledRoot = path.join(appRoot, 'plugins', PACKAGE_NAME);
  const installedRoot = path.join(appRoot, 'node_modules', PACKAGE_NAME);
  const [appPackage, packageLock, controlledPackage, installedPackage, tokenStorage, authContext] = await Promise.all([
    readUtf8(path.join(appRoot, 'package.json')).then(JSON.parse),
    readUtf8(path.join(appRoot, 'package-lock.json')).then(JSON.parse),
    readUtf8(path.join(controlledRoot, 'package.json')).then(JSON.parse),
    readUtf8(path.join(installedRoot, 'package.json')).then(JSON.parse),
    readUtf8(path.join(appRoot, 'src', 'native', 'storage.js')),
    readUtf8(path.join(appRoot, 'src', 'contexts', 'AuthContext.jsx')),
  ]);

  assert.equal(appPackage.dependencies?.[PACKAGE_NAME], LOCAL_DEPENDENCY);
  assert.equal(packageLock.packages?.['']?.dependencies?.[PACKAGE_NAME], LOCAL_DEPENDENCY);
  assert.deepEqual(packageLock.packages?.[`node_modules/${PACKAGE_NAME}`], {
    resolved: LOCKED_LOCAL_PATH,
    link: true,
  });
  assert.equal(packageLock.packages?.[LOCKED_LOCAL_PATH]?.version, controlledPackage.version);
  assert.equal(controlledPackage.name, PACKAGE_NAME);
  assert.equal(installedPackage.name, PACKAGE_NAME);
  assert.equal(installedPackage.version, controlledPackage.version);
  assert.match(tokenStorage, /await secure\.set\(\{ key: KEY, value: token \}\);[\s\S]*await secure\.get\(\{ key: KEY \}\)/);
  assert.match(tokenStorage, /verification\?\.value !== token/);
  assert.match(tokenStorage, /error\?\.code === 'SECURE_STORAGE_ITEM_NOT_FOUND'\) return null/);
  assert.match(authContext, /const stored = await loadToken\(\);[\s\S]*if \(stored\) \{[\s\S]*publishToken\(stored\)/);

  const [controlledSources, installedSources] = await Promise.all([
    nativeSourceManifest(path.join(controlledRoot, NATIVE_SOURCE_ROOT)),
    nativeSourceManifest(path.join(installedRoot, NATIVE_SOURCE_ROOT)),
  ]);
  assert.deepEqual(
    controlledSources.map(({ path: sourcePath }) => sourcePath),
    EXPECTED_NATIVE_SOURCES,
    'The secure-storage fork may contain only the three reviewed Java/Kotlin sources.',
  );
  assert.deepEqual(
    installedSources,
    controlledSources,
    'Every installed secure-storage Java source must exactly match the reviewed local fork.',
  );

  const controlledFiles = await Promise.all([
    readUtf8(path.join(controlledRoot, HELPER_PATH)),
    readUtf8(path.join(controlledRoot, PLUGIN_PATH)),
    readUtf8(path.join(controlledRoot, 'android', 'build.gradle')),
    readUtf8(path.join(controlledRoot, 'dist', 'esm', 'index.js')),
  ]);
  const installedFiles = await Promise.all([
    readUtf8(path.join(installedRoot, HELPER_PATH)),
    readUtf8(path.join(installedRoot, PLUGIN_PATH)),
    readUtf8(path.join(installedRoot, 'android', 'build.gradle')),
    readUtf8(path.join(installedRoot, 'dist', 'esm', 'index.js')),
  ]);
  assert.deepEqual(installedFiles, controlledFiles, 'Installed native plugin must exactly match the reviewed local fork.');

  const [helper, plugin, gradle, jsEntry] = controlledFiles;
  assert.match(gradle, /minSdkVersion\s+24\b/);
  assert.doesNotMatch(gradle, /minSdkVersion\s+project\./);

  assert.match(helper, /AndroidKeyStore/);
  assert.match(helper, /AES\/GCM\/NoPadding/);
  assert.match(helper, /sp-keystore-aes-gcm-v1:/);
  assert.match(helper, /PURPOSE_ENCRYPT\s*\|\s*KeyProperties\.PURPOSE_DECRYPT/);
  assert.match(helper, /setRandomizedEncryptionRequired\(true\)/);
  assert.match(helper, /cipher\.updateAAD\(/);
  assert.match(helper, /if \(!preferences\.edit\(\)\.putString\(storageKey, encoded\)\.commit\(\)\)/);
  assert.match(helper, /throw new SecureStorageException\("Secure storage encryption failed\./);
  assert.match(helper, /!encoded\.startsWith\(STORAGE_FORMAT_PREFIX\)[\s\S]*removeUnreadableValue\(storageKey\);[\s\S]*return null/);
  assert.match(helper, /catch \(AEADBadTagException exception\) \{[\s\S]*removeUnreadableValue\(storageKey\);[\s\S]*return null/);
  assert.match(helper, /catch \(Exception exception\) \{\s*throw new SecureStorageException\("Secure storage decryption failed\./);
  assert.match(helper, /if \(!preferences\.edit\(\)\.remove\(storageKey\)\.commit\(\) \|\| preferences\.contains\(storageKey\)\)/);
  assert.match(helper, /Unreadable secure value could not be removed/);

  for (const unsafePattern of [
    /PasswordStorageHelper_SDK16/,
    /PasswordStorageHelper_SDK18/,
    /SDK_INT\s*<\s*18/,
    /RSA\/ECB\/PKCS1Padding/,
    /Base64\.encodeToString\(data\s*,/,
    /return\s+Base64\.decode\(res\s*,/,
    /printStackTrace\(/,
    /catch\s*\([^)]*\)\s*\{\s*\}/,
  ]) {
    assert.doesNotMatch(helper, unsafePattern);
  }

  assert.match(plugin, /@CapacitorPlugin\(name = "SecureStoragePlugin"\)/);
  assert.match(plugin, /initializationFailure/);
  assert.match(plugin, /SECURE_STORAGE_FAILED/);
  assert.match(plugin, /requireStorage\(\)\.assertAvailable\(\)/);
  assert.doesNotMatch(plugin, /printStackTrace\(|Log\./);
  assert.match(jsEntry, /registerPlugin\('SecureStoragePlugin'\)/);
  assert.doesNotMatch(jsEntry, /localStorage|sessionStorage|Preferences/);
}

export async function assertGeneratedSecureStorage(appRoot, androidProject) {
  const projectRoot = path.join(appRoot, androidProject);
  const [settings, capacitorBuild, variables, plugins, mergedManifest] = await Promise.all([
    readUtf8(path.join(projectRoot, 'capacitor.settings.gradle')),
    readUtf8(path.join(projectRoot, 'app', 'capacitor.build.gradle')),
    readUtf8(path.join(projectRoot, 'variables.gradle')),
    readUtf8(path.join(projectRoot, 'app', 'src', 'main', 'assets', 'capacitor.plugins.json')),
    readUtf8(path.join(
      projectRoot,
      'app',
      'build',
      'intermediates',
      'merged_manifest',
      'debug',
      'processDebugMainManifest',
      'AndroidManifest.xml',
    )),
  ]);

  assert.match(settings, /\.\.\/plugins\/capacitor-secure-storage-plugin\/android/);
  assert.match(capacitorBuild, /implementation project\(':capacitor-secure-storage-plugin'\)/);
  assert.match(variables, /minSdkVersion\s*=\s*24\b/);
  assert.match(mergedManifest, /android:minSdkVersion="24"/);

  const registration = JSON.parse(plugins).find((entry) => entry.pkg === PACKAGE_NAME);
  assert.deepEqual(registration, {
    pkg: PACKAGE_NAME,
    classpath: 'com.whitestein.securestorage.SecureStoragePluginPlugin',
  });
}

export async function assertSecureStorageApk(appRoot, androidProject) {
  const metadataPath = path.join(
    appRoot,
    androidProject,
    'app',
    'build',
    'outputs',
    'apk',
    'debug',
    'output-metadata.json',
  );
  const metadata = JSON.parse(await readUtf8(metadataPath));
  const outputFile = metadata.elements?.[0]?.outputFile;
  assert.ok(outputFile, 'Debug APK metadata is missing its output file.');
  const apkPath = path.join(path.dirname(metadataPath), outputFile);
  assert.ok((await stat(apkPath)).size > 1_000_000, 'Built APK is unexpectedly small.');

  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), 'schoolpilot-apk-security-'));
  try {
    execFileSync('jar', ['xf', apkPath], {
      cwd: extractionRoot,
      stdio: 'pipe',
      windowsHide: true,
    });
    const dexFiles = (await readdir(extractionRoot)).filter((name) => /^classes\d*\.dex$/.test(name));
    assert.ok(dexFiles.length > 0, 'Built APK does not contain a classes.dex payload.');
    const dexText = (await Promise.all(
      dexFiles.map((name) => readFile(path.join(extractionRoot, name))),
    )).map((buffer) => buffer.toString('latin1')).join('\n');

    assert.match(dexText, /SecureStoragePluginPlugin/);
    assert.match(dexText, /SecureStorageException/);
    assert.match(dexText, /sp-keystore-aes-gcm-v1:/);
    assert.match(dexText, /AES\/GCM\/NoPadding/);
    assert.match(dexText, /Unreadable secure value could not be removed/);
    assert.match(dexText, /Secure storage decryption failed\./);
    assert.doesNotMatch(dexText, /PasswordStorageHelper_SDK16|PasswordStorageHelper_SDK18/);
    assert.doesNotMatch(dexText, /RSA\/ECB\/PKCS1Padding/);

    const aarPath = path.join(
      appRoot,
      'plugins',
      PACKAGE_NAME,
      'android',
      'build',
      'outputs',
      'aar',
      'capacitor-secure-storage-plugin-debug.aar',
    );
    const aarExtractionRoot = path.join(extractionRoot, 'secure-storage-aar');
    await mkdir(aarExtractionRoot);
    execFileSync('jar', ['xf', aarPath], {
      cwd: aarExtractionRoot,
      stdio: 'pipe',
      windowsHide: true,
    });
    const compiledClasses = execFileSync('jar', ['tf', path.join(aarExtractionRoot, 'classes.jar')], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split(/\r?\n/)
      .filter((entry) => entry.endsWith('.class'))
      .sort();
    assert.deepEqual(
      compiledClasses,
      EXPECTED_COMPILED_CLASSES,
      'The compiled secure-storage Android library must contain only the three reviewed classes.',
    );
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}
