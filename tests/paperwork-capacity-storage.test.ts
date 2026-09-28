import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPhysicalObjectStore, createStorageEvidence } from '../scripts/load/paperwork/physical-object-store.mjs';

test('capacity object storage awaits physical bytes shared by API and worker instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schoolpilot-capacity-storage-'));
  try {
    const evidence = createStorageEvidence();
    const api = await createPhysicalObjectStore(directory, evidence);
    const worker = await createPhysicalObjectStore(directory, evidence);
    const key = 'synthetic-private-source-key', bytes = Buffer.from('synthetic bytes, not metadata');
    await api.put(key, bytes);
    assert.deepEqual(await worker.get(key), bytes);
    assert.equal((await readdir(directory)).length, 1);
    await worker.delete(key);
    await api.delete(key);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(api.get(key), { code: 'ENOENT' });
    assert.equal(evidence.operationCount, 5);
    assert.equal(evidence.samples.length, 5);
    assert.equal(evidence.samples[1]?.bytes, bytes.length);
    assert.equal(evidence.samples[4]?.errorCode, 'ENOENT');
    assert.equal(evidence.samples[4]?.succeeded, false);
    assert.doesNotMatch(JSON.stringify(evidence), /synthetic-private|synthetic bytes|schoolpilot-capacity-storage/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('capacity storage metadata bounds concurrent I/O without dropping observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schoolpilot-capacity-storage-'));
  try {
    const evidence = createStorageEvidence();
    evidence.maxSamples = 2;
    const store = await createPhysicalObjectStore(directory, evidence);
    const results = await Promise.allSettled(['one', 'two', 'three'].map(key => store.put(key, Buffer.from(key))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await readdir(directory)).length, 2);
    assert.equal(evidence.operationCount, 2);
    assert.equal(evidence.samples.length, 2);
    assert.ok(evidence.samples.every(sample => sample.succeeded && sample.durationMs >= 0));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
