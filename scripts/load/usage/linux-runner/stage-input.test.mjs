import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ATOMIC_PUBLICATION_PYTHON, validateStageRequest } from './stage-input.mjs';
import { manifestSha256 } from './evidence.mjs';
const runId = 'usage-linux-test-20261012';
function request() { const manifest = { schemaVersion: 1, purpose: 'approved_input', totalBytes: 1, inputAllowlistSha256: 'b'.repeat(64), entries: [{ path: 'image.tar', kind: 'oci_image', bytes: 1, sha256: 'a'.repeat(64) }] }; return { schemaVersion: 1, kind: 'usage_linux_input_placement', runId, executorUid: 1000, transferUid: 1001, source: `/srv/usage/transfer/incoming/${runId}.age`, stagingRoot: `/srv/usage/staging/${runId}`, destinationRoot: `/srv/usage/work/input-${runId}`, identityPath: '/srv/usage/keys/input-identity.txt', direction: 'input', location: 'runner', manifest, manifestSha256: manifestSha256(manifest), expectedCiphertext: { sha256: 'c'.repeat(64), bytes: 99 }, expectedBundle: { sha256: 'd'.repeat(64), bytes: 20 }, approvedInputAllowlist: manifest.entries }; }
test('placement binds source chroot, unique staging, executor, identity and exact input allowlist', () => {
  validateStageRequest(request());
  for (const [key, value] of Object.entries({ source: '/srv/usage/keys/input-identity.txt', destinationRoot: '/srv/usage/raw', stagingRoot: '/tmp/staging', executorUid: 0, transferUid: 1000, location: 'owner', direction: 'return', manifestSha256: '0'.repeat(64) })) assert.throws(() => validateStageRequest({ ...request(), [key]: value }), key);
  const altered = request(); altered.approvedInputAllowlist = [{ ...altered.manifest.entries[0], sha256: 'd'.repeat(64) }]; assert.throws(() => validateStageRequest(altered));
});

const bundledPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const python = process.env.USAGE_TEST_PYTHON ?? (process.platform === 'win32' && existsSync(bundledPython) ? bundledPython : 'python3');
// Run the actual fixed helper, modeling its kernel boundary on Windows. A Linux
// host must additionally exercise native renameat2 before privileged placement.
const publicationModel = String.raw`import ctypes, errno, json, os, pathlib, stat, sys, tempfile, types
helper, case = sys.argv[1:]
run_id = 'usage-linux-test-20261012'
with tempfile.TemporaryDirectory(prefix='usage-publication-test-') as temporary:
    base = pathlib.Path(temporary)
    ready = base / 'private' / 'placement-ready'; ready.mkdir(parents=True)
    (ready / 'approved.txt').write_text('reviewed input')
    work = base / 'work'; work.mkdir()
    destination = work / ('input-' + run_id)
    sentinel = base / 'outside.txt'; sentinel.write_text('must stay unchanged')
    trace, names, infos = [], {}, {}
    flags = 0x10000 | 0x20000
    def opened(name, value, dir_fd=None):
        assert value & flags == flags, 'O_DIRECTORY and O_NOFOLLOW required'
        label = name if dir_fd is None else names[dir_fd] + '/' + name
        fd = len(names) + 3; names[fd] = label
        uid = 1000 if label.endswith('/work') else 0
        mode = 0o755 if label == '/srv' else 0o710 if label == '/srv/usage' else 0o700
        device = 2 if case == 'cross-device' and uid == 1000 else 1
        if case == 'wrong-owner' and label.endswith('/staging'): uid = 1000
        infos[fd] = types.SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=uid, st_dev=device)
        trace.append(['open', label]); return fd
    def staged(name, *, dir_fd, follow_symlinks):
        assert name == 'placement-ready' and names[dir_fd].endswith('/' + run_id)
        assert follow_symlinks is False
        return types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=1000, st_dev=1)
    class Rename:
        def __call__(self, source_fd, source_name, destination_fd, destination_name, value):
            assert names[source_fd] == '/srv/usage/staging/' + run_id
            assert names[destination_fd] == '/srv/usage/work'
            assert source_name == b'placement-ready' and destination_name == ('input-' + run_id).encode()
            assert value == 1, 'RENAME_NOREPLACE required'
            trace.append(['renameat2', value])
            if case == 'racing-collision':
                # Another UID1000 process claims the name at the syscall boundary,
                # after every validation, with its own real tree and marker.
                destination.mkdir(); (destination / 'attacker.txt').write_text('preserve collision')
            if destination.exists(): ctypes.set_errno(errno.EEXIST); return -1
            os.rename(ready, destination); return 0
    native = types.SimpleNamespace(renameat2=Rename())
    if case == 'missing-syscall': native = types.SimpleNamespace()
    fake_os = types.SimpleNamespace(O_RDONLY=0, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000,
        geteuid=lambda: 0, open=opened, fstat=lambda fd: infos[fd], stat=staged,
        close=lambda fd: trace.append(['close', fd]), strerror=os.strerror)
    real_os, real_platform, real_argv, real_cdll = sys.modules['os'], sys.platform, sys.argv, ctypes.CDLL
    sys.modules['os'] = fake_os; sys.platform = 'linux'; sys.argv = ['fixed-helper', run_id]
    ctypes.CDLL = lambda *args, **kwargs: native
    failure = None
    try: exec(helper, {'__name__': '__main__'})
    except Exception as error: failure = type(error).__name__
    finally:
        sys.modules['os'] = real_os; sys.platform = real_platform; sys.argv = real_argv; ctypes.CDLL = real_cdll
    assert sentinel.read_text() == 'must stay unchanged'
    if case == 'success':
        assert failure is None and not ready.exists()
        assert (destination / 'approved.txt').read_text() == 'reviewed input'
    else:
        assert failure is not None and (ready / 'approved.txt').read_text() == 'reviewed input'
        if case == 'racing-collision':
            assert failure == 'FileExistsError'
            assert (destination / 'attacker.txt').read_text() == 'preserve collision'
            assert not (destination / 'approved.txt').exists()
        else: assert not destination.exists()
    mutations = [row for row in trace if row[0] == 'renameat2']
    assert len(mutations) == (1 if case in ['success', 'racing-collision'] else 0)
    print(json.dumps({'case': case, 'failure': failure, 'modeledKernelBoundary': True, 'renameCalls': len(mutations), 'outsideUnchanged': True}))
`;

test('fixed publication helper refuses a racing target without clobbering or a rename fallback (modeled syscall boundary)', () => {
  for (const scenario of ['success', 'racing-collision', 'cross-device', 'wrong-owner', 'missing-syscall']) {
    const result = spawnSync(python, ['-I', '-c', publicationModel, ATOMIC_PUBLICATION_PYTHON, scenario], { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.modeledKernelBoundary, true); assert.equal(proof.outsideUnchanged, true);
  }
});
