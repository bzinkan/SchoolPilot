import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pause } from './application.mjs';
const binding = JSON.parse(readFileSync('/control/binding.json', 'utf8'));
assert.match(binding.run, /^[a-f0-9]{12}$/); assert.match(binding.source, /^[a-f0-9]{40}$/);
assert.match(binding.containerId, /^[a-f0-9]{64}$/); assert.match(binding.nonce, /^[a-f0-9]{64}$/);
assert.equal(createHash('sha256').update(readFileSync(binding.entryFile)).digest('hex'), binding.entrySha256);
let lastId = 0, ready = false, shutdown = false;
const pending = new Map();
function resources() {
  const cpu = Object.fromEntries(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/)).map(([key, value]) => [key, Number(value)]));
  const events = Object.fromEntries(readFileSync('/sys/fs/cgroup/memory.events', 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/)).map(([key, value]) => [key, Number(value)]));
  return { hrtimeMicroseconds: Number(process.hrtime.bigint() / 1000n), cpu, memoryEvents: events, nodeVersion: process.version,
    cpuMax: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(), memoryMax: Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()) };
}
function emit(name, value) {
  const destination = '/control/' + name, temporary = destination + '.tmp';
  assert.equal(existsSync(destination), false, 'Immutable role response replay');
  writeFileSync(temporary, JSON.stringify({ ...value, resources: resources(), binding: { run: binding.run, source: binding.source, containerId: binding.containerId, role: binding.role } }) + '\n', { flag: 'wx' });
  renameSync(temporary, destination);
}
process.send = (message, ...args) => {
  const callback = args.find(value => typeof value === 'function');
  if (message.kind === 'ready') { assert.equal(ready, false); ready = true; emit('ready.json', message); }
  else {
    assert.ok(pending.has(message.id), 'Unknown or duplicate role reply');
    const operation = pending.get(message.id); pending.delete(message.id);
    if (operation === 'shutdown' && !message.error) shutdown = true;
    emit(`response-${message.id}.json`, message);
  }
  callback?.(); return true;
};
process.connected = true;
await import(pathToFileURL(binding.entryFile).href);
while (!shutdown) {
  const path = `/control/request-${lastId + 1}.json`;
  if (existsSync(path)) {
    const request = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(request.id, lastId + 1); assert.equal(request.nonce, binding.nonce);
    assert.ok(['initialize', 'phase', 'correctness', 'snapshot', 'reset', 'drain', 'quiesce', 'rollup', 'shutdown', 'seed', 'verify', 'measureWindow', 'queryPlans'].includes(request.operation));
    assert.ok(pending.size < 32); lastId = request.id; pending.set(request.id, request.operation);
    const { nonce: _nonce, ...message } = request;
    if (message.operation === 'measureWindow') {
      assert.equal(message.value.durationMs, 60_000); assert.ok(message.value.startsAtMs > Date.now());
      const startsAtMs = message.value.startsAtMs;
      setTimeout(() => {
        const start = resources(), startDelayMs = Math.max(0, Date.now() - startsAtMs);
        setTimeout(() => process.send({ id: message.id, value: { start, end: resources(), declaredDurationMs: 60_000,
          startDelayMs, endDelayMs: Math.max(0, Date.now() - startsAtMs - 60_000) } }), Math.max(0, startsAtMs + 60_000 - Date.now()));
      }, startsAtMs - Date.now());
    } else if (message.operation === 'phase' && message.value.startsAtMs) {
      assert.ok(message.value.startsAtMs > Date.now());
      setTimeout(() => process.emit('message', message), message.value.startsAtMs - Date.now());
    } else process.emit('message', message);
  }
  await pause(25);
}
