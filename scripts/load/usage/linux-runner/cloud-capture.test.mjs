import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { captureAwsProcess, CloudController, decodeAwsResult, streamCapturedOutput } from './cloud.mjs';

function fixture(failAt) {
  const events = [], files = new Map();
  const info = { dev: 1, ino: 2, nlink: 1, isFile: () => true };
  const dependencies = {
    write: async (target, bytes) => {
      events.push(`create:${target}`); assert.equal(bytes.length, 0);
      if (failAt === `create:${target}`) throw new Error('private capture refused');
      files.set(target, Buffer.alloc(0));
    },
    check: async target => { events.push(`check:${target}`); return info; },
    open: async target => {
      events.push(`open:${target}`);
      return {
        fd: target === 'stdout' ? 101 : 102,
        stat: async () => failAt === `identity:${target}` ? { ...info, ino: 3 } : info,
        sync: async () => { events.push(`sync:${target}`); if (failAt === `sync:${target}`) throw new Error('capture flush failed'); },
        close: async () => events.push(`close:${target}`),
      };
    },
    run: (executable, args, options) => {
      events.push('invoke'); assert.equal(executable, 'pinned-aws'); assert.deepEqual(args, ['ec2', 'delete-volume']);
      assert.deepEqual(options.stdio, ['ignore', 101, 102]); assert.equal(options.timeout, 90000); assert.equal(options.windowsHide, true);
      if (failAt === 'invoke') throw new Error('native start failed');
      files.set('stderr', Buffer.from('native failure retained'));
      return { status: 254, signal: null, error: undefined };
    },
    snapshot: async (_handle, target) => ({ content: files.get(target).toString(), ref: { path: target } }),
  };
  return { events, files, dependencies, run: () => captureAwsProcess('pinned-aws', ['ec2', 'delete-volume'], { env: {}, stdoutPath: 'stdout', stderrPath: 'stderr' }, dependencies) };
}

test('AWS starts only after both exclusive private captures are open and identity checked', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.status, 254);
  assert.deepEqual(f.events.slice(0, 7), ['create:stdout', 'check:stdout', 'open:stdout', 'create:stderr', 'check:stderr', 'open:stderr', 'invoke']);
  assert.equal(f.files.get('stderr').toString(), 'native failure retained');
  assert.ok(f.events.includes('sync:stdout') && f.events.includes('sync:stderr'));
  assert.ok(f.events.includes('close:stdout') && f.events.includes('close:stderr'));
});

for (const failure of ['create:stdout', 'create:stderr', 'identity:stdout', 'identity:stderr']) {
  test(`private capture ${failure} refuses before any AWS call`, async () => {
    const f = fixture(failure); await assert.rejects(f.run);
    assert.ok(!f.events.includes('invoke'));
    for (const name of ['stdout', 'stderr']) if (f.events.includes(`open:${name}`)) assert.ok(f.events.includes(`close:${name}`));
  });
}

for (const failure of ['invoke', 'sync:stdout', 'sync:stderr']) {
  test(`${failure} remains failed and closes both captures without a retry`, async () => {
    const f = fixture(failure); await assert.rejects(f.run, error => {
      if (failure.startsWith('sync:')) { assert.equal(error.captureStage, 'flush'); assert.equal(error.nativeResult.status, 254); }
      else { assert.equal(error.captureStage, 'invoke'); assert.equal(error.nativeResult, null); }
      return true;
    });
    assert.equal(f.events.filter(x => x === 'invoke').length, 1);
    assert.ok(f.events.includes('close:stdout') && f.events.includes('close:stderr'));
  });
}

test('empty successful delete output is valid, while malformed output and failed native calls remain failures', () => {
  const ok = { status: 0, signal: null };
  assert.deepEqual(decodeAwsResult(ok, '', ''), {});
  assert.deepEqual(decodeAwsResult(ok, '{"result":true}\n', ''), { result: true });
  assert.throws(() => decodeAwsResult(ok, '{partial', ''));
  assert.throws(() => decodeAwsResult({ status: 1, signal: null }, '', 'private native detail'), /private receipt retained/);
});

test('only a completed native missing-resource response proves absence', () => {
  const stderr = 'An error occurred (InvalidVolume.NotFound) when calling the DescribeVolumes operation';
  const missing = ['InvalidVolume.NotFound'];
  assert.deepEqual(decodeAwsResult({ status: 254, signal: null }, '', stderr, missing), { absent: true, absenceCode: missing[0] });
  for (const result of [{ status: null, signal: 'SIGTERM' }, { status: 254, signal: null, error: { code: 'ETIMEDOUT' } }, { status: 0, signal: null, error: { code: 'EIO' } }]) {
    assert.throws(() => decodeAwsResult(result, '', stderr, missing));
  }
  assert.throws(() => decodeAwsResult({ status: 254, signal: null }, '', stderr, ['NoSuchEntity']));
});

test('stream failure drains an active file write before capture can sync or close', async () => {
  const source = new PassThrough(), failures = [];
  let entered, finishWrite, completed = false;
  const writing = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finishWrite = resolve; });
  const capture = streamCapturedOutput(source, { write: async chunk => { entered(); await pending; return { bytesWritten: chunk.length }; } }, error => failures.push(error));
  capture.then(() => { completed = true; });
  source.write(Buffer.from('partial')); await writing;
  source.destroy(new Error('offline input lost'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'the handle must remain owned until its pending write settles');
  finishWrite(); await capture;
  assert.equal(completed, true); assert.equal(failures.length, 1);
});

test('real offline native children retain empty, failed, timed-out and bounded-output captures', { timeout: 240000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'schoolpilot-aws-capture-'));
  try {
    if (process.platform === 'win32') {
      const pwsh = process.env.SCHOOLPILOT_CUSTODY_PWSH_PATH ?? 'pwsh.exe';
      const helper = fileURLToPath(new URL('../../../private-permissions.ps1', import.meta.url));
      const prepared = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; . $env:SP_TEST_HELPER; Set-PrivatePathPermissions -Path $env:SP_TEST_ROOT -Directory"], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, SP_TEST_HELPER: helper, SP_TEST_ROOT: root } });
      assert.equal(prepared.status, 0, 'private offline test directory setup');
    } else await chmod(root, 0o700);
    const run = (name, script, timeout) => captureAwsProcess(process.execPath, ['-e', script], { env: { SystemRoot: process.env.SystemRoot }, stdoutPath: path.join(root, `${name}.out`), stderrPath: path.join(root, `${name}.err`), timeout });
    const empty = await run('empty', 'process.exit(0)');
    assert.deepEqual(decodeAwsResult(empty, empty.stdout.content, empty.stderr.content), {});
    assert.equal(empty.stdout.ref.bytes, 0); assert.equal(empty.stderr.ref.bytes, 0);
    const failed = await run('failed', 'process.stderr.write("offline diagnostic"); process.exitCode=254');
    assert.equal(failed.status, 254); assert.equal(failed.stderr.content, 'offline diagnostic');
    assert.equal((await readFile(failed.stderr.ref.path, 'utf8')), failed.stderr.content);
    const timedOut = await run('timeout', 'process.stdout.write("partial"); setInterval(()=>{},1000)', 1000);
    assert.equal(timedOut.error.code, 'ETIMEDOUT'); assert.equal(timedOut.stdout.content, 'partial');
    assert.throws(() => decodeAwsResult(timedOut, timedOut.stdout.content, timedOut.stderr.content));
    const excessive = await run('limit', 'process.stdout.write(Buffer.alloc(17*1024*1024))');
    assert.equal(excessive.error.code, 'ENOBUFS');
    assert.ok((await stat(excessive.stdout.ref.path)).size <= 16 * 1024 * 1024);
    assert.throws(() => decodeAwsResult(excessive, excessive.stdout.content, excessive.stderr.content));
  } finally {
    assert.ok(root.startsWith(path.join(tmpdir(), 'schoolpilot-aws-capture-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery reconciles a completed deletion with a lost response and never deletes that volume again', async () => {
  const p = { runId: 'usage-linux-test', accountId: '123456789012', region: 'us-east-1', ami: { id: 'ami-test' }, stopDeadlineUtc: '2026-10-17T02:00:00Z' };
  const Tags = [{ Key: 'RunId', Value: p.runId }, { Key: 'Purpose', Value: 'usage-linux-acceptance' }, { Key: 'SpendCapUsd', Value: '15' }, { Key: 'StopDeadlineUtc', Value: p.stopDeadlineUtc }];
  const inventory = { Vpcs: [], Subnets: [], InternetGateways: [], RouteTables: [], SecurityGroups: [], Volumes: ['vol-data', 'vol-root'].map((VolumeId, i) => ({ VolumeId, Size: i ? 30 : 200, State: 'available', Encrypted: true, Attachments: [], Tags })), Instances: [{ InstanceId: 'i-test', InstanceType: 'm7i.4xlarge', ImageId: p.ami.id, State: { Name: 'terminated' }, Tags }] };
  const deleted = [], c = new CloudController(p, '/not-used', {});
  c.seal = async () => {};
  c.discover = async () => structuredClone(inventory);
  c.aws = async (_service, operation, input) => {
    if (operation === 'delete-volume') {
      deleted.push(input.VolumeId); inventory.Volumes = inventory.Volumes.filter(x => x.VolumeId !== input.VolumeId);
      if (input.VolumeId === 'vol-data') throw new Error('response capture lost after deletion');
      return {};
    }
    if (['describe-document', 'get-role', 'get-instance-profile'].includes(operation)) return { absent: true };
    assert.fail(`unexpected mutation ${operation}`);
  };
  const custody = { kind: 'independently_replayed_dual_private_evidence_custody', passed: true, copies: ['/copy-a', '/copy-b'].map(root => ({ root, independentReplayPassed: true, replayHookInvoked: true })) };
  await assert.rejects(() => c.cleanup(custody));
  assert.deepEqual(deleted, ['vol-data']);
  await c.cleanup(custody);
  assert.deepEqual(deleted, ['vol-data', 'vol-root']);
  assert.equal(c.state.phase, 'runner_resources_deleted_operator_scope_closeout_and_cost_pending');
});
