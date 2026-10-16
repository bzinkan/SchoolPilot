import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REMOTE_GENERATOR_SCRIPTS = Object.freeze([
  'classpilot-load-test.mjs', 'classpilot-reliability-profile.mjs', 'command-status-observer.mjs',
  'fine-endpoint-latency.mjs', 'monotonic-deadline.mjs', 'reliability-rendered-frame.mjs', 'remote-generator-manifest.mjs',
  'run-classpilot-reliability.mjs', 'run-classpilot-remote-generator.mjs', 'session-cookie.mjs', 'staging-start-barrier.mjs', 'tile-poll-accounting.mjs',
  'producer-source-ledger.mjs',
  'source-startup-contract.mjs',
  'source-ledger-sdk-bridge.mjs',
  'producer-source-hook.mjs',
  'source-ledger-harness-runtime.mjs',
]);

export function scriptManifest(directory, candidateApiImage, includedFiles = null) {
  if (!/^\d{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\/schoolpilot-staging-api@sha256:[a-f0-9]{64}$/.test(candidateApiImage)) {
    throw new Error('An immutable isolated staging API image is required');
  }
  const files = {};
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Generator scripts must not contain symbolic links');
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        files[relative(directory, child).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(child)).digest('hex');
      }
    }
  }
  if (includedFiles) {
    for (const name of includedFiles) {
      if (!/^[a-z0-9-]+\.mjs$/.test(name) || !lstatSync(join(directory, name)).isFile()) throw new Error('Exact regular generator script files are required');
      files[name] = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
    }
  } else visit(directory);
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return { version: 1, candidateApiImage, scriptBundleSha256: createHash('sha256').update(JSON.stringify(ordered)).digest('hex'), files: ordered };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const manifest = scriptManifest(directory, process.argv[2] || '', REMOTE_GENERATOR_SCRIPTS);
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(manifest), { mode: 0o644, flag: 'wx' });
  else console.log(JSON.stringify(manifest));
}
