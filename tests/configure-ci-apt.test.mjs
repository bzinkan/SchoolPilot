import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APT_NETWORK_POLICY, replaceAzureMirror, configureCiApt } from '../scripts/configure-ci-apt.mjs';

test('observed runner mirror list keeps priorities, fallback entries and line endings', () => {
  for (const newline of ['\n', '\r\n']) {
    const original = ['http://azure.archive.ubuntu.com/ubuntu/\tpriority:1', 'https://archive.ubuntu.com/ubuntu/\tpriority:2', 'https://security.ubuntu.com/ubuntu/\tpriority:3', ''].join(newline);
    const expected = original.replace('http://azure.archive.ubuntu.com/ubuntu/', 'https://archive.ubuntu.com/ubuntu/');
    assert.equal(replaceAzureMirror(original), expected);
    assert.equal(replaceAzureMirror(expected), expected);
  }
});

test('replacement accepts the exact URI only, preserving unrelated repositories and metadata', () => {
  const lines = ['# http://azure.archive.ubuntu.com/ubuntu/', 'http://azure.archive.ubuntu.com.evil/ubuntu/', 'http://azure.archive.ubuntu.com/ubuntu-other/', 'https://azure.archive.ubuntu.com/ubuntu/', 'https://packages.microsoft.com/ubuntu/24.04/prod', 'http://archive.ubuntu.com/ubuntu/'];
  const original = lines.join('\n'); assert.equal(replaceAzureMirror(original), original);
  assert.equal(replaceAzureMirror('http://azure.archive.ubuntu.com/ubuntu\tpriority:1 arch:amd64 codename:noble\n'), 'https://archive.ubuntu.com/ubuntu\tpriority:1 arch:amd64 codename:noble\n');
});

test('configuration writes bounded transport policy without changing sources or signing keys', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-ci-apt-'));
  try {
    mkdirSync(path.join(directory, 'apt.conf.d')); mkdirSync(path.join(directory, 'sources.list.d')); mkdirSync(path.join(directory, 'trusted.gpg.d'));
    const unchanged = { 'sources.list.d/ubuntu.sources': 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates noble-security\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n', 'trusted.gpg.d/fixture.gpg': 'synthetic-key-bytes', 'apt.conf.d/50existing': 'Existing::Option "preserved";\n' };
    for (const [name, bytes] of Object.entries(unchanged)) writeFileSync(path.join(directory, name), bytes);
    writeFileSync(path.join(directory, 'apt-mirrors.txt'), 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n');
    assert.deepEqual(configureCiApt(directory), { mirrorChanged: true, timeoutSeconds: 30, retries: 2 });
    assert.equal(readFileSync(path.join(directory, 'apt.conf.d/99schoolpilot-ci-network'), 'utf8'), APT_NETWORK_POLICY);
    assert.deepEqual(configureCiApt(directory), { mirrorChanged: false, timeoutSeconds: 30, retries: 2 });
    for (const [name, bytes] of Object.entries(unchanged)) assert.equal(readFileSync(path.join(directory, name), 'utf8'), bytes);
    assert.doesNotMatch(APT_NETWORK_POLICY, /AllowUnauthenticated|Verify-Peer|Verify-Host|AllowInsecure|Trusted|ForceIPv4/i);
  } finally {
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('sp-ci-apt-'));
    rmSync(resolved, { recursive: true });
  }
});
