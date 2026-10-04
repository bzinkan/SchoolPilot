import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, readlinkSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function tree(path) {
  const rows = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const file = resolve(directory, name), stat = lstatSync(file), key = relative(path, file).replaceAll('\\', '/');
      if (stat.isDirectory()) visit(file);
      else if (stat.isSymbolicLink()) rows.push([key, 'link', readlinkSync(file)]);
      else { assert.ok(stat.isFile()); rows.push([key, 'file', stat.mode & 0o777, hash(readFileSync(file))]); }
    }
  }
  visit(path); return { entries: rows.length, sha256: hash(JSON.stringify(rows)) };
}
function apk() {
  return Object.fromEntries(readFileSync('/lib/apk/db/installed', 'utf8').split('\n\n').filter(Boolean).map(record => {
    const lines = record.split('\n'); return [lines.find(line => line.startsWith('P:'))?.slice(2), lines.find(line => line.startsWith('V:'))?.slice(2)];
  }));
}
function snapshot() { return { platform: process.platform, arch: process.arch, versions: process.versions,
  nodeSha256: hash(readFileSync(process.execPath)), dist: tree('/app/dist'), nodeModules: tree('/app/node_modules'),
  packageJsonSha256: hash(readFileSync('/app/package.json')), lockSha256: hash(readFileSync('/app/package-lock.json')), apk: apk() }; }
export function assertRuntime(path, { git = true } = {}) {
  const expected = JSON.parse(readFileSync(path, 'utf8')), actual = snapshot();
  for (const key of ['platform','arch','versions','nodeSha256','dist','nodeModules','packageJsonSha256','lockSha256']) assert.deepEqual(actual[key], expected[key], `Candidate runtime changed: ${key}`);
  for (const [name, version] of Object.entries(expected.apk)) assert.equal(actual.apk[name], version, `Existing candidate APK package changed: ${name}`);
  if (git) {
    const binding = JSON.parse(readFileSync('/diagnostic/binding.json', 'utf8'));
    assert.equal(lstatSync('/source/.git').isDirectory(), true); assert.equal(existsSync('/source/.git/objects/info/alternates'), false);
    assert.equal(execFileSync('git', ['rev-parse','HEAD'], { cwd: '/source', encoding: 'utf8' }).trim(), binding.applicationSource);
    assert.equal(execFileSync('git', ['status','--porcelain'], { cwd: '/source', encoding: 'utf8' }).trim(), '');
    for (const [name, expectedHash] of Object.entries(binding.roleHarnessSha256)) assert.equal(hash(readFileSync(resolve('/prototype', name))), expectedHash);
    const tracked = execFileSync('git', ['ls-files','-z'], { cwd: '/source', encoding: 'utf8' }).split('\0').filter(Boolean);
    assert.ok(tracked.length > 0 && tracked.every(name => !/^(dist|node_modules)\//.test(name)));
    for (const [name, expectedHash] of Object.entries(binding.executedHarnessSha256)) assert.equal(hash(readFileSync(resolve('/diagnostic/scripts/load/usage', name))), expectedHash);
  }
  return actual;
}
if (process.argv[2] === 'capture') writeFileSync(process.argv[3], JSON.stringify(snapshot(), null, 2) + '\n');
if (process.argv[2] === 'assert-before-source') assertRuntime(process.argv[3], { git: false });
if (process.argv[2] === 'assert') assertRuntime(process.argv[3]);
