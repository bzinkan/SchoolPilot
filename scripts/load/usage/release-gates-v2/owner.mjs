import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hash } from './contracts.mjs';
import { pause } from './application.mjs';

export function privateFile(path, data) { assert.equal(existsSync(path), false); const temporary = path + '.tmp'; writeFileSync(temporary, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
export function assertOutside(root, path) { const rel = relative(resolve(root), resolve(path)); assert.ok(rel && (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))), 'Evidence/control directory must be outside source'); }
export async function ownRole({ docker, run, source, helperImage, helperConfigDigest, helperContainerImage, preparation, pgContainerId, role, entryFile, environment, privateDirectory, outputDirectory, cpu, memory }) {
  assert.match(run, /^[a-f0-9]{12}$/); assert.match(source, /^[a-f0-9]{40}$/); assert.match(role, /^(?:api[012]|worker|generator|observer|seeder)$/);
  assert.match(helperImage, /^sha256:[a-f0-9]{64}$/); assert.match(helperConfigDigest, /^sha256:[a-f0-9]{64}$/); assert.match(pgContainerId, /^[a-f0-9]{64}$/);
  assert.match(helperContainerImage, /^sha256:[a-f0-9]{64}$/);
  const control = join(privateDirectory, role); mkdirSync(control);
  const envFile = join(control, 'environment.private');
  for (const [key, value] of Object.entries(environment)) { assert.match(key, /^[A-Z_][A-Z0-9_]*$/); assert.equal(typeof value, 'string'); assert.doesNotMatch(value, /[\r\n\0]/); assert.doesNotMatch(key, /^(?:AWS_|DOCKER_|NODE_OPTIONS$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/); }
  writeFileSync(envFile, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const name = `schoolpilot-release297-v2-${role}-${run}`;
  const args = ['create', '--name', name, '--label', `codex.release297-v2=${run}`, '--label', `codex.release297-role=${role}`, '--label', `codex.release297-source=${source}`,
    '--network', `container:${pgContainerId}`, '--cpus', String(cpu), '--memory', String(memory), '--memory-swap', String(memory),
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--init', '--no-healthcheck', '--user', 'node', '--workdir', '/app',
    '--env-file', envFile, '--mount', `type=bind,source=${control},target=/control`, '--entrypoint', 'node', helperImage, '/harness/role-entry.mjs'];
  let id;
  try { id = (await docker(args)).trim(); assert.match(id, /^[a-f0-9]{64}$/); }
  catch (error) {
    const found = (await docker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--no-trunc', '--format', '{{.ID}}'])).trim();
    if (found) { const inspect = JSON.parse(await docker(['inspect', found]))[0]; assert.equal(inspect.Config.Labels['codex.release297-v2'], run); await docker(['rm', '--force', '--volumes', found]); }
    throw error;
  }
  const inspected = JSON.parse(await docker(['inspect', id]))[0];
  assert.equal(inspected.Name, '/' + name); assert.equal(inspected.Image, helperContainerImage);
  assert.equal(inspected.Config.Image, helperImage);
  assert.equal(inspected.Config.Labels['codex.release297-v2'], run); assert.equal(inspected.Config.Labels['codex.release297-role'], role);
  assert.equal(inspected.Config.Labels['codex.release297-source'], source); assert.equal(inspected.HostConfig.NetworkMode, `container:${pgContainerId}`);
  assert.equal(inspected.HostConfig.NanoCpus, cpu * 1e9); assert.equal(inspected.HostConfig.Memory, memory); assert.equal(inspected.HostConfig.MemorySwap, memory);
  assert.equal(inspected.HostConfig.Privileged, false); assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  const basename = entryFile.replace('/diagnostic/', ''), digest = preparation.executedFiles[basename] ?? preparation.executedFiles['scripts/load/usage/release-gates-v2/' + entryFile.split('/').at(-1)];
  assert.match(digest, /^[a-f0-9]{64}$/);
  const binding = { run, source, role, containerId: id, nonce: randomBytes(32).toString('hex'), entryFile, entrySha256: digest };
  privateFile(join(control, 'binding.json'), binding);
  await docker(['start', id]);
  let nextId = 0, settled = 0, expired = 0, closed = false; const pending = new Map(), resources = [];
  let checkedAt=0, stateReading, lastState;
  async function checkAlive(){
    if(!stateReading&&Date.now()-checkedAt>=1000){checkedAt=Date.now();stateReading=docker(['inspect',id]).then(bytes=>{lastState=JSON.parse(bytes)[0].State;}).finally(()=>{stateReading=undefined;});}
    if(stateReading)await stateReading;if(lastState&&!lastState.Running)throw Error('V2_ROLE_EXITED_BEFORE_RESPONSE');
  }
  async function wait(name, deadlineMs = 30_000) {
    const deadline = Date.now() + deadlineMs, file = join(control, name);
    while (Date.now() < deadline) {
      if (existsSync(file)) {
        const message = JSON.parse(readFileSync(file, 'utf8'));
        assert.deepEqual(message.binding, { run, source, role, containerId: id });
        if (message.resources) resources.push({ operation: name, ...message.resources });
        return message;
      }
      // A role can atomically publish its final acknowledgement and exit
      // between our first file check and the native state observation. Read
      // that response through the normal binding checks before rejecting the
      // exit; an exit without an actual response still fails immediately.
      try { await checkAlive(); }
      catch (error) { if (!existsSync(file)) throw error; continue; }
      await pause(25);
    }
    throw Error('V2_ROLE_RESPONSE_DEADLINE');
  }
  const ready = await wait('ready.json');
  const owner = { role, id, ready, source, helperImage, cpu, memory, resources,
    async logs() { return docker(['logs', id]); },
    async rpc(operation, value, timeoutMs = 120_000) {
      assert.equal(closed, false); const requestId = ++nextId; pending.set(requestId, operation);
      privateFile(join(control, `request-${requestId}.json`), { id: requestId, nonce: binding.nonce, operation, ...(value === undefined ? {} : { value }) });
      try {
        const message = await wait(`response-${requestId}.json`, timeoutMs); assert.equal(message.id, requestId); pending.delete(requestId); settled++;
        if (message.error) throw Error(message.error.code); return message.value;
      } catch (error) { if (pending.has(requestId)) expired++; throw error; }
    },
    async shutdown() {
      let acknowledged = false; try { await owner.rpc('shutdown', undefined, 30_000); acknowledged = true; } catch {}
      closed = true;
      let state = JSON.parse(await docker(['inspect', id]))[0].State;
      for (let n = 0; state.Running && n < 50; n++) { await pause(100); state = JSON.parse(await docker(['inspect', id]))[0].State; }
      const forced = state.Running;
      if (forced) { await docker(['kill', id]); state = JSON.parse(await docker(['inspect', id]))[0].State; }
      // Timed-out owners remain pending until an actual response or process exit.
      const unsettledAtExit = pending.size; pending.clear();
      const logs = await docker(['logs', id]); writeFileSync(join(privateDirectory, `${role}-log.private`), logs, { flag: 'wx', mode: 0o600 });
      const receipt = { run, source, role, containerId: id, helperImage, inspected: true, exitCode: state.ExitCode, oomKilled: state.OOMKilled,
        forced, acknowledged, requests: nextId, settled, expired, unsettledAtExit, logsSha256: hash(logs),
        clean: acknowledged && state.ExitCode === 0 && !state.OOMKilled && !forced && expired === 0 && unsettledAtExit === 0 };
      writeFileSync(join(outputDirectory, `${role}-exit.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
      return receipt;
    } };
  return owner;
}
