#!/usr/bin/env node
// Bound Ubuntu runner package downloads; retain APT's existing signing/TLS policy.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APT_NETWORK_POLICY = 'Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::Retries "2";\n';

export function replaceAzureMirror(text) {
  // APT mirror-list entries are URI + optional tab-separated metadata. Match
  // only the observed URI, not comments, other paths or lookalike host names.
  return text.replace(/^([ \t]*)http:\/\/azure\.archive\.ubuntu\.com\/ubuntu(\/?)(?=[ \t\r]|$)/gm,
    '$1https://archive.ubuntu.com/ubuntu$2');
}

export function configureCiApt(aptDirectory = '/etc/apt') {
  const root = path.resolve(aptDirectory), configDirectory = path.join(root, 'apt.conf.d');
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'APT_DIRECTORY_REQUIRED');
  assert.ok(lstatSync(configDirectory).isDirectory() && !lstatSync(configDirectory).isSymbolicLink(), 'APT_CONFIG_DIRECTORY_REQUIRED');
  const mirrorFile = path.join(root, 'apt-mirrors.txt');
  let mirrorChanged = false;
  if (existsSync(mirrorFile)) {
    assert.ok(lstatSync(mirrorFile).isFile() && !lstatSync(mirrorFile).isSymbolicLink(), 'ORDINARY_APT_MIRROR_FILE_REQUIRED');
    const original = readFileSync(mirrorFile, 'utf8'), updated = replaceAzureMirror(original);
    if (updated !== original) { writeFileSync(mirrorFile, updated); mirrorChanged = true; }
  }
  const configFile = path.join(configDirectory, '99schoolpilot-ci-network');
  if (existsSync(configFile)) assert.ok(lstatSync(configFile).isFile() && !lstatSync(configFile).isSymbolicLink(), 'ORDINARY_APT_CONFIG_FILE_REQUIRED');
  writeFileSync(configFile, APT_NETWORK_POLICY, { mode: 0o644 });
  return { mirrorChanged, timeoutSeconds: 30, retries: 2 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.platform, 'linux', 'UBUNTU_RUNNER_REQUIRED');
  assert.equal(process.argv.length, 2, 'UNEXPECTED_APT_CONFIGURATION_ARGUMENTS');
  console.log(JSON.stringify(configureCiApt()));
}
