import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { isFrontendPath, requireRelease, sha256 } from './frontend-bundle.mjs';

export const frontendLockKey = '__schoolpilot_frontend_lock';
const ownerKey = 'schoolpilot-release';
const recoveryKey = 'schoolpilot-restored';
const indexPath = 'index.html';
const indexCache = 'no-cache, no-store, must-revalidate';
const immutableCache = 'public, max-age=31536000, immutable';
const shaPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/plain',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function contentType(path) {
  return contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function readEntryAssetPaths(index) {
  const paths = [...new Set([...index.toString().matchAll(
    /\b(?:src|href)\s*=\s*["']\/(assets\/[^"']+\.(?:js|css))["']/g,
  )].map((match) => match[1]))];
  requireRelease(paths.some((path) => path.endsWith('.js')) && paths.every(isFrontendPath),
    'Frontend index must reference a local Vite entry script.');
  return paths;
}

function requireDeployable(bundle) {
  const paths = new Map(bundle.files.map((file) => [file.path, file]));
  requireRelease(paths.size === bundle.files.length && !paths.has(frontendLockKey),
    'Frontend bundle contains duplicate or reserved paths.');
  const index = paths.get(indexPath);
  requireRelease(index, 'Frontend bundle has no index.html.');
  const assets = readEntryAssetPaths(index.body).map((key) => {
    requireRelease(paths.has(key), 'Frontend entry asset is absent from its bundle: ' + key);
    return { key, sha256: paths.get(key).sha256 };
  });
  return { index: { sha256: index.sha256 }, assets };
}

function snapshot(object) {
  if (!object) return null;
  requireRelease(typeof object.versionId === 'string' && object.versionId &&
    typeof object.etag === 'string' && object.etag,
  'S3 did not return an exact frontend object version.');
  return {
    versionId: object.versionId, etag: object.etag, sha256: sha256(object.body),
    contentType: object.contentType, cacheControl: object.cacheControl,
  };
}

async function captureRollback(store) {
  const index = await store.get(indexPath);
  requireRelease(index, 'The active frontend index is missing.');
  const assets = await Promise.all(readEntryAssetPaths(index.body).map(async (key) => {
    const object = await store.get(key);
    requireRelease(object, 'Missing rollback asset: ' + key);
    return { key, sha256: sha256(object.body) };
  }));
  return { index: snapshot(index), assets };
}

function bundleIdentity(bundle) {
  return {
    sourceSha: bundle.sourceSha, runId: bundle.runId, attempt: bundle.attempt,
    manifestSha256: bundle.manifestSha256,
  };
}

export async function planFrontend(store, bundle) {
  requireDeployable(bundle);
  await store.checkTarget();
  requireRelease(!await store.get(frontendLockKey), 'A frontend release lock is held.');
  return { ...bundleIdentity(bundle), site: store.site, rollback: await captureRollback(store) };
}

async function acquireLock(store, receiptPath, receipt) {
  const owner = receipt.lockToken;
  let lock;
  try {
    lock = await store.put(frontendLockKey, {
      body: Buffer.from(owner), contentType: 'text/plain', ifNoneMatch: '*', metadata: { [ownerKey]: receipt.id },
    });
  } catch (error) {
    // A retry can return a conflict after the original request committed.
    const current = await store.get(frontendLockKey);
    if (current?.body.toString() === owner && current.metadata[ownerKey] === receipt.id) {
      lock = current;
    } else if (error.status === 412 || error.status === 409) {
      throw new Error('The frontend release lock is held by another operation.', { cause: error });
    } else {
      throw new Error('Frontend release lock ownership could not be established. Receipt: ' + receiptPath, { cause: error });
    }
  }
  receipt.lockVersionId = lock.versionId;
  await saveReceipt(receiptPath, receipt);
  return lock;
}

async function releaseLock(store, lock) {
  const current = await store.get(frontendLockKey);
  requireRelease(current?.versionId === lock.versionId, 'Frontend release lock ownership changed.');
  await store.deleteVersion(frontendLockKey, lock.versionId);
}

async function assertLock(store, lock) {
  requireRelease((await store.get(frontendLockKey))?.versionId === lock.versionId,
    'Frontend release lock ownership changed.');
}

async function inBatches(items, work) {
  for (let offset = 0; offset < items.length; offset += 8) {
    const results = await Promise.allSettled(items.slice(offset, offset + 8).map(work));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

async function stageAssets(store, files) {
  const assets = files.filter((file) => file.path.startsWith('assets/'));
  await inBatches(assets, async (asset) => {
    let current = await store.get(asset.path);
    if (!current) {
      try {
        await store.put(asset.path, {
          body: asset.body, contentType: contentType(asset.path), cacheControl: immutableCache, ifNoneMatch: '*',
        });
        return;
      } catch (error) {
        if (error.status !== 412) throw error;
        current = await store.get(asset.path);
      }
    }
    requireRelease(current && sha256(current.body) === asset.sha256,
      'Immutable frontend asset already exists with different bytes: ' + asset.path);
  });
}

function sameVersion(current, expected) {
  return current && expected ? current.versionId === expected.versionId : !current && !expected;
}

async function putSharedFile(store, key, options, before, checkpoint) {
  requireRelease(sameVersion(await store.get(key), before),
    'Live frontend object changed before writing: ' + key);
  const condition = before ? { ifMatch: before.etag } : { ifNoneMatch: '*' };
  await checkpoint();
  return store.put(key, { ...options, ...condition });
}

async function captureChanges(store, files, rollback) {
  const changes = [];
  for (const file of files) {
    if (file.path === indexPath || file.path.startsWith('assets/')) continue;
    const current = snapshot(await store.get(file.path));
    if (current?.sha256 === file.sha256 && current.cacheControl === 'no-cache' &&
        current.contentType === contentType(file.path)) continue;
    changes.push({ key: file.path, previous: current, candidateSha256: file.sha256 });
  }
  const index = files.find((file) => file.path === indexPath);
  return [...changes, { key: indexPath, previous: rollback.index, candidateSha256: index.sha256 }];
}

async function saveReceipt(path, receipt) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}

async function verifyPublic(store, release, stable) {
  const views = [
    ...['/', '/login', '/index.html'].map((path) => ({
      path, sha256: release.index.sha256, type: 'text/html',
    })),
    ...release.assets.map(({ key, sha256: digest }) => ({
      path: '/' + key, sha256: digest, type: contentType(key),
    })),
    ...stable,
  ];
  try {
    await inBatches(views, async ({ path, sha256: digest, type }) => {
      const response = await fetch(new URL(path, store.site.url), {
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const expectedType = type.split(';')[0].trim().toLowerCase();
      const matchesType = mime === expectedType || (expectedType === 'text/javascript' && mime === 'application/javascript');
      const body = Buffer.from(await response.arrayBuffer());
      requireRelease(response.status === 200 && matchesType && sha256(body) === digest,
        'CloudFront verification failed for ' + path + ' (HTTP ' + response.status + ', ' + mime + ').');
    });
  } catch (error) {
    throw new Error('Frontend CDN verification failed: ' + error.message, { cause: error });
  }
}

async function invalidateAndVerify(store, receipt, path, release, restoring = false) {
  const stable = receipt.changes.filter(({ key }) => key !== indexPath && receipt.attempted.includes(key));
  const paths = ['/', '/index.html', ...stable.map(({ key }) => '/' + key)];
  const checks = stable.filter((change) => !restoring || change.previous).map((change) => ({
    path: '/' + change.key,
    sha256: restoring ? change.previous.sha256 : change.candidateSha256,
    type: (restoring && change.previous.contentType) || contentType(change.key),
  }));
  const field = restoring ? 'rollbackInvalidationId' : 'invalidationId';
  // CloudFront makes a retry with the same caller reference idempotent.
  receipt[field] = await store.invalidate(paths, receipt.id + (restoring ? '-rollback' : '-publish'));
  await saveReceipt(path, receipt);
  await store.waitInvalidation(receipt[field]);
  await verifyPublic(store, release, checks);
}

function matchesReceipt(current, change, receipt) {
  return current && current.metadata[ownerKey] === receipt.id && sha256(current.body) === change.candidateSha256;
}

function alreadyRestored(current, previous, receipt) {
  return current && previous && current.metadata[recoveryKey] === receipt.id &&
    sha256(current.body) === previous.sha256;
}

async function planRestore(store, receipt) {
  const index = await store.get(indexPath);
  const indexChange = receipt.changes.find(({ key }) => key === indexPath);
  requireRelease(sameVersion(index, receipt.rollback.index) ||
    matchesReceipt(index, indexChange, receipt) || alreadyRestored(index, receipt.rollback.index, receipt),
  'This receipt no longer owns the live frontend index.');
  const writes = [];
  for (const change of receipt.changes) {
    if (!receipt.attempted.includes(change.key)) continue;
    const current = await store.get(change.key);
    if (receipt.pendingWrite?.key === change.key) {
      const confirmed = receipt.pendingWrite.phase === 'publish'
        ? matchesReceipt(current, change, receipt)
        : alreadyRestored(current, change.previous, receipt);
      requireRelease(confirmed, 'The outcome of the pending S3 write is unresolved: ' + change.key);
      receipt.pendingWrite = null;
    }
    if (sameVersion(current, change.previous) || alreadyRestored(current, change.previous, receipt)) continue;
    requireRelease(matchesReceipt(current, change, receipt),
      'This receipt no longer owns the frontend object: ' + change.key);
    // Newly introduced static paths remain available to browsers that loaded the candidate.
    if (!change.previous) continue;
    const previous = await store.get(change.key, change.previous.versionId);
    requireRelease(previous?.versionId === change.previous.versionId && sha256(previous.body) === change.previous.sha256,
      'The recorded rollback version is unavailable: ' + change.key);
    writes.push({ key: change.key, previous, current });
  }
  return writes;
}

async function restoreFrontend(store, path, receipt, writes, lock) {
  receipt.status = 'rolling_back';
  await saveReceipt(path, receipt);
  for (const { key, previous, current } of writes) {
    await assertLock(store, lock);
    await putSharedFile(store, key, {
      body: previous.body,
      contentType: previous.contentType || contentType(key),
      cacheControl: previous.cacheControl,
      metadata: { ...previous.metadata, [recoveryKey]: receipt.id },
    }, current, async () => {
      receipt.pendingWrite = { phase: 'rollback', key };
      await saveReceipt(path, receipt);
    });
    receipt.pendingWrite = null;
  }
  await invalidateAndVerify(store, receipt, path, receipt.rollback, true);
  receipt.status = 'rolled_back';
  await saveReceipt(path, receipt);
}

export async function publishFrontend(store, bundle, evidenceDir, expectedIndexVersion) {
  requireRelease(typeof expectedIndexVersion === 'string' && expectedIndexVersion,
    'A frontend preflight index version is required.');
  const expected = requireDeployable(bundle);
  await store.checkTarget();
  await mkdir(evidenceDir, { recursive: true });
  const id = randomUUID();
  const receiptPath = resolve(evidenceDir, id + '.json');
  const receipt = {
    schemaVersion: 1, id, ...bundleIdentity(bundle), site: store.site, expectedIndexVersion,
    status: 'preparing', attempted: [], lockToken: randomUUID(), pendingWrite: null,
  };
  await saveReceipt(receiptPath, receipt);
  const lock = await acquireLock(store, receiptPath, receipt);
  let releaseProven = true;
  try {
    receipt.rollback = await captureRollback(store);
    requireRelease(receipt.rollback.index.versionId === expectedIndexVersion,
      'The live frontend index changed since preflight. Prepare a new release plan.');
    receipt.changes = await captureChanges(store, bundle.files, receipt.rollback);
    await saveReceipt(receiptPath, receipt);
    await stageAssets(store, bundle.files);
    const files = new Map(bundle.files.map((file) => [file.path, file]));
    for (const change of receipt.changes) {
      await assertLock(store, lock);
      const result = await putSharedFile(store, change.key, {
        body: files.get(change.key).body, contentType: contentType(change.key),
        cacheControl: change.key === indexPath ? indexCache : 'no-cache',
        metadata: { [ownerKey]: id },
      }, change.previous, async () => {
        receipt.status = 'publishing';
        receipt.attempted.push(change.key);
        receipt.pendingWrite = { phase: 'publish', key: change.key };
        await saveReceipt(receiptPath, receipt);
      });
      receipt.pendingWrite = null;
      if (change.key === indexPath) receipt.indexVersionId = result.versionId;
    }
    await invalidateAndVerify(store, receipt, receiptPath, expected);
    requireRelease((await store.get(indexPath))?.versionId === receipt.indexVersionId,
      'Live frontend index changed during verification.');
    receipt.status = 'published';
    await saveReceipt(receiptPath, receipt);
    return { receiptPath, indexVersionId: receipt.indexVersionId, invalidationId: receipt.invalidationId };
  } catch (error) {
    if (receipt.attempted.length === 0) {
      receipt.status = 'failed_before_cutover';
      await saveReceipt(receiptPath, receipt);
      throw error;
    }
    releaseProven = false;
    try {
      await assertLock(store, lock);
      await restoreFrontend(store, receiptPath, receipt, await planRestore(store, receipt), lock);
      releaseProven = true;
    } catch (recoveryError) {
      receipt.status = 'recovery_required';
      await saveReceipt(receiptPath, receipt);
      throw new Error(error.message + '. Frontend recovery requires reconciliation with ' + receiptPath +
        '. ' + recoveryError.message, { cause: recoveryError });
    }
    throw new Error(error.message + '. Previous frontend restored. Receipt: ' + receiptPath, { cause: error });
  } finally {
    if (releaseProven) await releaseLock(store, lock);
  }
}

function validateReceipt(receipt, site) {
  const validSite = Object.entries(site).every(([key, value]) => receipt.site?.[key] === value);
  const isShared = (key) => isFrontendPath(key) && !key.startsWith('assets/') && key !== frontendLockKey;
  const validObject = (object) => typeof object?.versionId === 'string' && object.versionId &&
    typeof object.etag === 'string' && object.etag && shaPattern.test(object.sha256 ?? '');
  requireRelease(validSite && receipt.schemaVersion === 1 && uuidPattern.test(receipt.id ?? '') &&
    validObject(receipt.rollback?.index) && Array.isArray(receipt.rollback.assets) &&
    receipt.rollback.assets.length > 0 && receipt.rollback.assets.every((asset) =>
      isFrontendPath(asset.key) && asset.key.startsWith('assets/') && shaPattern.test(asset.sha256 ?? '')) &&
    Array.isArray(receipt.changes) && receipt.changes.at(-1)?.key === indexPath &&
    receipt.changes.every((change) => isShared(change.key) && shaPattern.test(change.candidateSha256 ?? '') &&
      (change.previous === null || validObject(change.previous))) &&
    new Set(receipt.changes.map(({ key }) => key)).size === receipt.changes.length &&
    receipt.changes.at(-1)?.previous?.versionId === receipt.rollback.index.versionId &&
    Array.isArray(receipt.attempted) && receipt.attempted.length > 0 &&
    receipt.attempted.every((key, offset) => key === receipt.changes[offset]?.key) &&
    (!receipt.pendingWrite || (['publish', 'rollback'].includes(receipt.pendingWrite.phase) &&
      receipt.attempted.includes(receipt.pendingWrite.key))),
  'Frontend rollback receipt is invalid or belongs to a different target.');
}

export async function rollbackFrontend(store, path) {
  const sourcePath = resolve(path);
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const lockToken = randomUUID();
  const receipt = { ...source, lockToken, lockVersionId: undefined, rollbackOf: sourcePath };
  validateReceipt(receipt, store.site);
  await store.checkTarget();
  const receiptPath = join(dirname(sourcePath), receipt.id + '.' + lockToken + '.rollback.json');
  await saveReceipt(receiptPath, receipt);
  const lock = await acquireLock(store, receiptPath, receipt);
  let releaseProven = !receipt.pendingWrite;
  try {
    if (receipt.status === 'published') {
      requireRelease((await store.get(indexPath))?.versionId === receipt.indexVersionId,
        'This receipt no longer owns the live frontend index.');
    }
    const writes = await planRestore(store, receipt);
    releaseProven = false;
    await restoreFrontend(store, receiptPath, receipt, writes, lock);
    releaseProven = true;
    return { receiptPath, invalidationId: receipt.rollbackInvalidationId };
  } catch (error) {
    if (!releaseProven) {
      receipt.status = 'recovery_required';
      await saveReceipt(receiptPath, receipt);
    }
    throw error;
  } finally {
    if (releaseProven) await releaseLock(store, lock);
  }
}
