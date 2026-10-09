import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRoleControlRequest } from '../scripts/load/usage/release-gates-v2/role-control-request.mjs';

const entry = fileURLToPath(new URL('../scripts/load/usage/release-gates-v2/role-entry.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = '123456abcdef', source = 'a'.repeat(40), containerId = 'b'.repeat(64), nonce = 'c'.repeat(64);

function temporary() { return mkdtempSync(join(tmpdir(), 'release297-role-control-')); }
function remove(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('release297-role-control-'));
  rmSync(directory, { recursive: true, force: true });
}
async function until(predicate, milliseconds = 5_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await pause(10); }
  throw Error('Role fixture deadline');
}

// The actual role-entry runs unmodified in a child. Only its Linux absolute
// paths are redirected to real temporary files, so the same fixture runs on
// Windows and CI without containers or an application dependency install.
async function roleFixture(t, { holdIdleRead = false, responseAlreadyExists = false } = {}) {
  const directory = temporary(), control = join(directory, 'control'); mkdirSync(control);
  const cgroup = join(directory, 'cgroup'); mkdirSync(cgroup);
  for (const [name, value] of Object.entries({ 'cpu.stat': 'usage_usec 0\nuser_usec 0\nsystem_usec 0\n', 'memory.events': 'oom 0\noom_kill 0\n', 'cpu.max': '100000 100000\n', 'memory.max': '536870912\n' })) writeFileSync(join(cgroup, name), value);
  const application = join(directory, 'http-role.mjs');
  writeFileSync(application, `
    import { createServer } from 'node:http';
    let requests = 0;
    const server = createServer((_request, response) => { response.end(String(++requests)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.on('message', message => {
      if (message.value?.hold === true) return;
      if (message.operation === 'shutdown') server.close(() => process.send({ id: message.id, value: { closed: true } }));
      else process.send({ id: message.id, value: { operation: message.operation, requests } });
    });
    process.send({ kind: 'ready', port: server.address().port });
  `);
  const binding = { run, source, containerId, nonce, role: 'api0', entryFile: application, entrySha256: hash(readFileSync(application)) };
  writeFileSync(join(control, 'binding.json'), JSON.stringify(binding));
  if (responseAlreadyExists) writeFileSync(join(control, 'response-1.json'), 'immutable original response');
  const preload = join(directory, 'paths.mjs');
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const root = ${JSON.stringify(directory)}, control = ${JSON.stringify(control)}, cgroup = ${JSON.stringify(cgroup)};
    const original = Object.fromEntries(['readFileSync', 'writeFileSync', 'renameSync', 'existsSync'].map(name => [name, fs[name].bind(fs)]));
    const map = value => typeof value !== 'string' ? value : value.startsWith('/control/') ? join(control, value.slice(9)) : value.startsWith('/sys/fs/cgroup/') ? join(cgroup, value.slice(15)) : value;
    fs.readFileSync = (filename, ...args) => original.readFileSync(map(filename), ...args);
    fs.writeFileSync = (filename, ...args) => original.writeFileSync(map(filename), ...args);
    fs.renameSync = (from, to) => original.renameSync(map(from), map(to));
    fs.existsSync = filename => original.existsSync(map(filename));
    const originalRead = fs.promises.readFile.bind(fs.promises);
    let held = false;
    fs.promises.readFile = async (filename, ...args) => {
      if (${holdIdleRead} && !held && filename === '/control/request-1.json') {
        held = true; original.writeFileSync(join(root, 'idle-read-entered'), 'entered');
        while (!original.existsSync(join(root, 'release-idle-read'))) await new Promise(resolve => setTimeout(resolve, 10));
      }
      return originalRead(map(filename), ...args);
    };
    syncBuiltinESMExports();
  `);
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', exit;
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }); });
  t.after(async () => {
    if (!exit) { child.kill(); await completed; }
    remove(directory);
  });
  async function response(name) {
    return until(() => {
      if (existsSync(join(control, name))) return JSON.parse(readFileSync(join(control, name), 'utf8'));
      if (exit) throw Error('Role exited: ' + output);
    });
  }
  function publish(id, value = {}) {
    const destination = join(control, `request-${id}.json`), pending = destination + '.tmp';
    writeFileSync(pending, JSON.stringify({ id, nonce, operation: 'initialize', ...value }), { flag: 'wx' });
    renameSync(pending, destination);
  }
  const ready = await response('ready.json');
  assert.deepEqual(ready.binding, { run, source, containerId, role: 'api0' });
  return { directory, control, ready, publish, response, completed, output: () => output };
}

test('control reads distinguish a missing request from empty, malformed and failed reads', { timeout: 10_000 }, async () => {
  const directory = temporary();
  try {
    assert.equal(await readRoleControlRequest(join(directory, 'missing.json')), undefined);
    const empty = join(directory, 'empty.json'); writeFileSync(empty, '');
    assert.equal(await readRoleControlRequest(empty), '');
    const malformed = join(directory, 'malformed.json'); writeFileSync(malformed, '{');
    assert.equal(await readRoleControlRequest(malformed), '{');
    await assert.rejects(readRoleControlRequest(directory), error => error.code === 'EISDIR');
  } finally { remove(directory); }
});

test('actual role keeps HTTP responsive during a pending idle read, then consumes atomic requests and shuts down', { timeout: 10_000 }, async t => {
  const role = await roleFixture(t, { holdIdleRead: true });
  await until(() => existsSync(join(role.directory, 'idle-read-entered')));
  const body = await new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${role.ready.port}/`, response => {
      let body = ''; response.on('data', bytes => { body += bytes; }); response.on('end', () => resolve(body));
    });
    request.on('error', reject); request.setTimeout(1_000, () => request.destroy(Error('HTTP blocked behind idle control read')));
  });
  assert.equal(body, '1');
  assert.equal(existsSync(join(role.directory, 'release-idle-read')), false);
  writeFileSync(join(role.control, 'request-1.json.tmp'), '{', { flag: 'wx' });
  writeFileSync(join(role.directory, 'release-idle-read'), 'release');
  await pause(60); assert.equal(existsSync(join(role.control, 'response-1.json')), false);
  // A producer publishes only a complete immutable file by atomic rename.
  writeFileSync(join(role.control, 'request-1.json.tmp'), JSON.stringify({ id: 1, nonce, operation: 'initialize' }));
  renameSync(join(role.control, 'request-1.json.tmp'), join(role.control, 'request-1.json'));
  const reply = await role.response('response-1.json');
  assert.deepEqual(reply.binding, role.ready.binding); assert.equal(reply.value.requests, 1);
  const first = readFileSync(join(role.control, 'response-1.json'));
  role.publish(2, { operation: 'shutdown' });
  assert.equal((await role.response('response-2.json')).value.closed, true);
  assert.deepEqual(await role.completed, { code: 0, signal: null });
  assert.deepEqual(readFileSync(join(role.control, 'response-1.json')), first);
});

for (const [name, request, expected] of [
  ['wrong nonce', { nonce: 'd'.repeat(64) }, /AssertionError/],
  ['out-of-order id', { id: 2 }, /AssertionError/],
  ['unknown operation', { operation: 'broadcast' }, /AssertionError/],
]) test(`actual role rejects ${name}`, { timeout: 10_000 }, async t => {
  const role = await roleFixture(t); role.publish(1, request);
  const result = await role.completed;
  assert.notEqual(result.code, 0); assert.match(role.output(), expected);
  assert.equal(existsSync(join(role.control, 'response-1.json')), false);
});

for (const [name, body] of [['empty', ''], ['malformed', '{']]) test(`actual role fails a published ${name} request without retrying it`, { timeout: 10_000 }, async t => {
  const role = await roleFixture(t); writeFileSync(join(role.control, 'request-1.json'), body, { flag: 'wx' });
  assert.notEqual((await role.completed).code, 0); assert.match(role.output(), /SyntaxError/);
  assert.equal(readFileSync(join(role.control, 'request-1.json'), 'utf8'), body);
});

test('actual role propagates a non-ENOENT filesystem error', { timeout: 10_000 }, async t => {
  const role = await roleFixture(t); mkdirSync(join(role.control, 'request-1.json'));
  assert.notEqual((await role.completed).code, 0); assert.match(role.output(), /EISDIR/);
});

test('actual role retains the 32-pending-operation limit', { timeout: 10_000 }, async t => {
  const role = await roleFixture(t);
  for (let id = 1; id <= 33; id++) role.publish(id, { value: { hold: true } });
  assert.notEqual((await role.completed).code, 0); assert.match(role.output(), /pending\.size < 32/);
  assert.equal(existsSync(join(role.control, 'response-1.json')), false);
});

test('actual role refuses to overwrite an immutable response', { timeout: 10_000 }, async t => {
  const role = await roleFixture(t, { responseAlreadyExists: true }); role.publish(1);
  assert.notEqual((await role.completed).code, 0); assert.match(role.output(), /Immutable role response replay/);
  assert.equal(readFileSync(join(role.control, 'response-1.json'), 'utf8'), 'immutable original response');
});
