import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const releaseModule = new URL('../scripts/release/frontend-release.mjs', import.meta.url);
const lockKey = '__schoolpilot_frontend_lock';
const hash = (body) => createHash('sha256').update(body).digest('hex');
const page = (label) => '<script type="module" src="/assets/' + label + '.js"></script>';
const source = (label) => 'import("/assets/lazy-' + label + '.js");';
const file = (path, body) => ({ path, sha256: hash(body), body: Buffer.from(body) });

class FixtureSite {
  #objects = new Map();
  #sequence = 0;
  site = {
    bucket: 'frontend-fixture', distributionId: 'EFIXTURE', region: 'us-east-1',
    owner: '000000000000', url: 'http://127.0.0.1',
  };
  invalidations = [];
  async checkTarget() {}
  beforePut = async () => {};
  afterPut = async () => {};
  afterInvalidate = async () => {};

  async seed(label) {
    await this.put('assets/' + label + '.js', { body: Buffer.from(source(label)), contentType: 'text/javascript' });
    await this.put('assets/lazy-' + label + '.js', { body: Buffer.from('export default "' + label + '"'), contentType: 'text/javascript' });
    await this.put('settings.json', { body: Buffer.from('"' + label + '"'), contentType: 'application/json' });
    await this.put('index.html', { body: Buffer.from(page(label)), contentType: 'text/html' });
  }

  async get(path, versionId) {
    const versions = this.#objects.get(path) ?? [];
    return versionId ? versions.find((version) => version.versionId === versionId) ?? null : versions.at(-1) ?? null;
  }

  async put(path, options) {
    await this.beforePut(path, options);
    const prior = await this.get(path);
    if ((options.ifNoneMatch && prior) || (options.ifMatch && options.ifMatch !== prior?.etag)) {
      throw Object.assign(new Error('S3 conditional write rejected'), { status: 412 });
    }
    const version = {
      path, versionId: String(++this.#sequence), etag: '"' + hash(options.body).slice(0, 32) + '"',
      body: options.body, contentType: options.contentType,
      cacheControl: options.cacheControl, metadata: options.metadata ?? {},
    };
    const versions = this.#objects.get(path) ?? [];
    this.#objects.set(path, [...versions, version]);
    await this.afterPut(path, version);
    return version;
  }

  async deleteVersion(path, versionId) {
    this.#objects.set(path, this.#objects.get(path).filter((version) => version.versionId !== versionId));
  }

  async invalidate(paths, reference) {
    this.invalidations.push({ paths, reference });
    return 'IFIXTURE' + this.invalidations.length;
  }

  async waitInvalidation(id) {
    await this.afterInvalidate(id);
  }
}

function bundle(label) {
  return {
    sourceSha: hash(label).slice(0, 40), runId: '731', attempt: 1, manifestSha256: hash('manifest ' + label),
    files: [
      file('assets/' + label + '.js', source(label)),
      file('assets/lazy-' + label + '.js', 'export default "' + label + '"'),
      file('index.html', page(label)),
      file('settings.json', '"' + label + '"'),
    ],
  };
}

async function fixture(t) {
  const store = new FixtureSite();
  const evidenceDir = await mkdtemp(join(tmpdir(), 'schoolpilot cutover '));
  t.after(() => rm(evidenceDir, { force: true, recursive: true }));
  await store.seed('baseline');
  let badAsset = '';
  let badBody;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const key = ['/', '/login'].includes(pathname) ? 'index.html' : pathname.slice(1);
    const object = await store.get(key);
    if (object && (key !== badAsset || (badBody !== undefined && object.body.toString() !== badBody))) {
      response.writeHead(200, { 'content-type': object.contentType });
      response.end(object.body);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  store.site.url += ':' + server.address().port;
  return { store, evidenceDir, hideAsset: (asset, body) => { badAsset = asset; badBody = body; } };
}

async function publishCurrent(publishFrontend, store, candidate, evidenceDir) {
  const current = await store.get('index.html');
  return publishFrontend(store, candidate, evidenceDir, current.versionId);
}

test('publishes HTML after every new file and serves the prior release lazy chunk', async (t) => {
  const { store, evidenceDir } = await fixture(t);
  const { publishFrontend } = await import(releaseModule);
  await publishCurrent(publishFrontend, store, bundle('first'), evidenceDir);
  const oldEntry = await (await fetch(store.site.url + '/assets/first.js')).text();
  const writes = [];
  store.afterPut = async (path) => { writes.push(path); };

  const result = await publishCurrent(publishFrontend, store, bundle('second'), evidenceDir);

  assert.equal(writes.at(-1), 'index.html');
  assert.ok(writes.indexOf('assets/lazy-second.js') < writes.indexOf('index.html'));
  assert.ok(writes.indexOf('settings.json') < writes.indexOf('index.html'));
  assert.equal(await (await fetch(store.site.url + '/login')).text(), page('second'));
  const lazyPath = /import\("([^"]+)"\)/.exec(oldEntry)[1];
  assert.equal(await (await fetch(store.site.url + lazyPath)).text(), 'export default "first"');
  assert.equal((await store.get('assets/second.js')).cacheControl, 'public, max-age=31536000, immutable');
  assert.equal((await store.get('settings.json')).cacheControl, 'no-cache');
  assert.deepEqual(store.invalidations.at(-1).paths, ['/', '/index.html', '/settings.json']);
  const receipt = JSON.parse(await readFile(result.receiptPath));
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.indexVersionId, (await store.get('index.html')).versionId);
  assert.equal(await store.get(lockKey), null);
});

test('a CloudFront asset error restores the exact prior HTML and public file bytes', async (t) => {
  const { store, evidenceDir, hideAsset } = await fixture(t);
  const { publishFrontend } = await import(releaseModule);
  hideAsset('assets/candidate.js');

  await assert.rejects(publishCurrent(publishFrontend, store, bundle('candidate'), evidenceDir), /verification.*restored/i);

  assert.equal((await store.get('index.html')).body.toString(), page('baseline'));
  assert.equal((await store.get('settings.json')).body.toString(), '"baseline"');
  assert.ok(await store.get('assets/lazy-candidate.js'));
  assert.equal(store.invalidations.length, 2);
  assert.equal(await store.get(lockKey), null);
});

test('a changed stable public file must be served correctly before cutover succeeds', async (t) => {
  const { store, evidenceDir, hideAsset } = await fixture(t);
  const { publishFrontend } = await import(releaseModule);
  hideAsset('settings.json', '"candidate"');

  await assert.rejects(publishCurrent(publishFrontend, store, bundle('candidate'), evidenceDir), /settings\.json.*restored/i);
  assert.equal((await store.get('settings.json')).body.toString(), '"baseline"');
});

test('a lost S3 write response is reconciled before releasing the lease', async (t) => {
  const { store, evidenceDir } = await fixture(t);
  const { publishFrontend } = await import(releaseModule);
  store.afterPut = async (path, version) => {
    if (path === 'settings.json' && version.body.toString() === '"candidate"') throw new Error('connection reset after write');
  };

  await assert.rejects(publishCurrent(publishFrontend, store, bundle('candidate'), evidenceDir), /connection reset.*restored/i);
  assert.equal((await store.get('settings.json')).body.toString(), '"baseline"');
  assert.equal((await store.get('index.html')).body.toString(), page('baseline'));
  assert.equal(await store.get(lockKey), null);
});

test('an unacknowledged shared write retains its lock while the previous version is still visible', async (t) => {
  const { store, evidenceDir } = await fixture(t);
  const { publishFrontend, rollbackFrontend } = await import(releaseModule);
  const previous = await store.get('settings.json');
  let delayedWrite;
  store.beforePut = async (key, options) => {
    if (key !== 'settings.json') return;
    delayedWrite = options;
    throw new Error('connection lost with request still in flight');
  };

  await assert.rejects(publishCurrent(publishFrontend, store, bundle('pending'), evidenceDir), /requires reconciliation/i);
  const [name] = await readdir(evidenceDir);
  const receiptPath = join(evidenceDir, name);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.status, 'recovery_required');
  assert.equal((await store.get(lockKey)).versionId, receipt.lockVersionId);
  assert.equal((await store.get('settings.json')).versionId, previous.versionId);
  store.beforePut = async () => {};
  await store.put('settings.json', delayedWrite);
  await assert.rejects(publishCurrent(publishFrontend, store, bundle('later'), evidenceDir), /frontend release lock/i);
  await store.deleteVersion(lockKey, receipt.lockVersionId);
  await rollbackFrontend(store, receiptPath);
  assert.equal((await store.get('settings.json')).body.toString(), '"baseline"');
  assert.equal(await store.get(lockKey), null);
});

test('a retried lock conflict can be recognized as this publisher’s acknowledged lease', async (t) => {
  const { store, evidenceDir } = await fixture(t);
  const { publishFrontend } = await import(releaseModule);
  let observedToken;
  let persistedToken;
  store.afterPut = async (key, version) => {
    if (key !== lockKey) return;
    const [name] = await readdir(evidenceDir);
    const receipt = JSON.parse(await readFile(join(evidenceDir, name), 'utf8'));
    observedToken = version.body.toString();
    persistedToken = receipt.lockToken;
    throw Object.assign(new Error('retry saw its own successful write'), { status: 412 });
  };

  await publishCurrent(publishFrontend, store, bundle('reconciled'), evidenceDir);
  assert.equal(persistedToken, observedToken);
  assert.equal((await store.get('index.html')).body.toString(), page('reconciled'));
  assert.equal(await store.get(lockKey), null);
});

test('a held bucket lock protects cutover from a concurrent publisher', async (t) => {
  const { store, evidenceDir } = await fixture(t);
  const { publishFrontend } = await import(releaseModule);
  let resume;
  let publishing;
  const paused = new Promise((resolve) => { resume = resolve; });
  const writing = new Promise((resolve) => { publishing = resolve; });
  store.beforePut = async (path) => {
    if (path === 'assets/first.js') {
      publishing();
      await paused;
    }
  };
  const first = publishCurrent(publishFrontend, store, bundle('first'), evidenceDir);
  try {
    await writing;
    await assert.rejects(publishCurrent(publishFrontend, store, bundle('second'), evidenceDir), /frontend release lock/i);
    assert.equal(await store.get('assets/second.js'), null);
  } finally {
    resume();
    await first;
  }
});

test('rollback is bound to the live release receipt and rejects a superseded release', async (t) => {
  const { store, evidenceDir } = await fixture(t);
  const { publishFrontend, rollbackFrontend } = await import(releaseModule);
  const first = await publishCurrent(publishFrontend, store, bundle('first'), evidenceDir);
  const second = await publishCurrent(publishFrontend, store, bundle('second'), evidenceDir);

  await assert.rejects(rollbackFrontend(store, first.receiptPath), /no longer owns/i);
  assert.equal((await store.get('index.html')).body.toString(), page('second'));
  await rollbackFrontend(store, second.receiptPath);
  assert.equal((await store.get('index.html')).body.toString(), page('first'));
  assert.equal((await store.get('settings.json')).body.toString(), '"first"');
});

test('plan verifies a complete live rollback target without writing through the store', async (t) => {
  const { store } = await fixture(t);
  const { planFrontend } = await import(releaseModule);
  store.beforePut = async () => assert.fail('plan must not write to S3');
  const plan = await planFrontend(store, bundle('candidate'));
  assert.equal(plan.rollback.index.sha256, hash(page('baseline')));
  assert.equal(plan.sourceSha, bundle('candidate').sourceSha);
  const app = await store.get('assets/baseline.js');
  await store.deleteVersion(app.path, app.versionId);
  await assert.rejects(planFrontend(store, bundle('candidate')), /rollback asset.*assets\/baseline\.js/i);
});

test('a plan captured before a concurrent frontend release cannot overwrite that release', async (t) => {
  const { store, evidenceDir } = await fixture(t);
  const { planFrontend, publishFrontend } = await import(releaseModule);
  const older = await planFrontend(store, bundle('older'));
  await publishFrontend(store, bundle('newer'), evidenceDir, older.rollback.index.versionId);

  await assert.rejects(publishFrontend(store, bundle('older'), evidenceDir, older.rollback.index.versionId), /changed since preflight/i);
  assert.equal((await store.get('index.html')).body.toString(), page('newer'));
  assert.equal(await store.get('assets/older.js'), null);
});
