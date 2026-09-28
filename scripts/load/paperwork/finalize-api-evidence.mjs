import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertApiServerMetrics, matchServerReadProbes } from './api-server-contract.mjs';

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

export function finalizeApiEvidence(directory, expected) {
  assert.match(expected.imageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(expected.revision, /^[a-f0-9]{40}$/);
  assert.equal(expected.cpu, 1); assert.equal(expected.memoryBytes, 2 * 1024 ** 3);
  const api = read(join(directory, 'split-api-server-metrics.json'));
  const driver = read(join(directory, 'split-metrics.json'));
  assert.equal(driver.topologyVersion, 3); assert.equal(driver.measurementHost, 'separate_load_driver');
  assert.equal(driver.imageDigest, expected.imageDigest); assert.equal(driver.sourceRevision, expected.revision);
  assert.equal(api.sourceRevision, expected.revision);
  assert.ok(typeof driver.apiServerMetrics?.serverId === 'string' && driver.apiServerMetrics.serverId.length > 0);
  assertApiServerMetrics(api, { ...expected, serverId: driver.apiServerMetrics.serverId });
  const files = ['split-api-server-metrics.json', 'split-metrics.json', 'split-api-server.mjs', 'api-server-contract.mjs', 'physical-object-store.mjs', 'finalize-api-evidence.mjs'];
  const hashes = Object.fromEntries(files.map(file => [file, sha(join(directory, file))]));
  assert.equal(hashes['finalize-api-evidence.mjs'], sha(fileURLToPath(import.meta.url)), 'Final validator differs from copied measurement code');
  for (const [field, file] of [['serverSourceSha256', 'split-api-server.mjs'], ['contractSourceSha256', 'api-server-contract.mjs'], ['storageSourceSha256', 'physical-object-store.mjs']]) {
    assert.equal(api[field], hashes[file], `Serving API ${field} differs from copied measurement code`);
  }
  assert.ok(api.kernelPeakMemoryBytes < expected.memoryBytes * .70, 'Final API kernel peak exceeds unchanged70percent gate');
  assert.ok(api.peakCgroupMemoryBytes < expected.memoryBytes * .70, 'Final API observed peak exceeds unchanged70percent gate');
  const pairs = matchServerReadProbes(driver.readProbeEvidence.samples, api.serverProbeEvidence);
  return { schemaVersion: 1, accepted: true, role: 'api', serverId: api.serverId,
    imageDigest: expected.imageDigest, sourceRevision: expected.revision,
    limits: { cpu: expected.cpu, memoryBytes: expected.memoryBytes },
    matchedProbeCount: pairs.length, finalKernelPeakMemoryBytes: api.kernelPeakMemoryBytes,
    finalObservedPeakMemoryBytes: api.peakCgroupMemoryBytes, hashes,
    measurement: 'Final serving API report after shutdown; original driver and server reports remain unchanged' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, imageDigest, revision, cpu, memoryBytes, ...extra] = process.argv.slice(2);
  try {
    assert.ok(directory && !extra.length);
    const result = finalizeApiEvidence(directory, { imageDigest, revision, cpu: Number(cpu), memoryBytes: Number(memoryBytes) });
    writeFileSync(join(directory, 'split-api-final-validation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ accepted: true, matchedProbeCount: result.matchedProbeCount }) + '\n');
  } catch {
    process.stderr.write('Final serving API evidence did not pass identity, resources, readiness, or probe checks.\n');
    process.exitCode = 1;
  }
}
