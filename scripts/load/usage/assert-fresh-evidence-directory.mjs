import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertFreshEvidenceDirectory(directory) {
  if (typeof directory !== 'string' || !directory) throw new Error('An evidence directory is required.');
  if (existsSync(directory) && (!statSync(directory).isDirectory() || readdirSync(directory).length > 0)) {
    throw new Error('Choose a fresh empty evidence directory; existing artifacts will not be overwritten.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { assertFreshEvidenceDirectory(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
