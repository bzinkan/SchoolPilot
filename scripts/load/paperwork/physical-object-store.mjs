import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createStorageEvidence() {
  return { version: 1, implementation: 'awaited_physical_file_operations', maxSamples: 4096,
    operationCount: 0, samples: [] };
}

export async function createPhysicalObjectStore(directory, evidence, originMs = 0) {
  await mkdir(directory, { recursive: true });
  const filename = key => join(directory, createHash('sha256').update(key).digest('hex'));
  const measure = async (operation, bytes, execute) => {
    // Reserve the metadata slot before I/O so concurrent operations cannot exceed the bound.
    if (evidence.operationCount >= evidence.maxSamples) throw new Error('STORAGE_SAMPLE_LIMIT');
    evidence.operationCount++;
    const started = performance.now();
    let succeeded = false, errorCode = null;
    try {
      const result = await execute();
      if (operation === 'get') bytes = result.length;
      succeeded = true;
      return result;
    } catch (error) {
      errorCode = /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'STORAGE_OPERATION_FAILED';
      throw error;
    } finally {
      // Keys, filenames, file contents, and exception messages are deliberately excluded.
      evidence.samples.push({ operation, startedAtMs: started - originMs,
        durationMs: performance.now() - started, bytes, succeeded, errorCode });
    }
  };
  return {
    async put(key, bytes) {
      await measure('put', bytes.length, () => writeFile(filename(key), Buffer.from(bytes)));
    },
    async get(key) { return measure('get', 0, () => readFile(filename(key))); },
    async delete(key) { await measure('delete', 0, () => rm(filename(key), { force: true })); },
  };
}
