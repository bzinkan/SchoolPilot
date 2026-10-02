import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertPrivateChatReleaseFloor, verifyPrivateChatSourceImages } from '../scripts/enforce-private-chat-release-floor.mjs';

const registry = JSON.parse(readFileSync('src/config/rlsRegistry.json', 'utf8'));
const tables = registry.inventories.classpilotPrivateChatLifecyclePostExpand.tables;
const candidateSources = {
  registry: JSON.stringify(registry), writer: readFileSync('src/services/classpilotPrivateChatLifecycle.ts', 'utf8'),
  migration: readFileSync('src/db/classpilotPrivateChatLifecycleMigration.ts', 'utf8'),
  protocol: readFileSync('src/services/classpilotProtocol.ts', 'utf8'),
  relay: readFileSync('src/realtime/websocket.ts', 'utf8'),
};
function task(name: string, admitted = true, guc = 'true') {
  return { containerDefinitions: [{ name, image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@sha256:${'d'.repeat(64)}`, environment: [
    { name: 'GIT_SHA', value: (name === 'api' ? 'a' : 'b').repeat(40) },
    { name: 'RLS_GUC_ENABLED', value: guc },
    { name: 'RLS_ENABLED_TABLES', value: (admitted ? tables : tables.slice(0, 128)).join(',') },
    { name: 'CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1', value: 'false' },
    { name: 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON', value: '{"privateChatLifecycleV1":{"mode":"off"}}' },
  ] }] };
}
const rollbackSourcesBySha = { ['a'.repeat(40)]: candidateSources, ['b'.repeat(40)]: candidateSources };
function input() { return { apiTaskDefinition: task('api'), workerTaskDefinition: task('scheduler-worker'), candidateSources, rollbackSourcesBySha }; }
function withoutRelay() { const source = { ...candidateSources }; Reflect.deleteProperty(source, 'relay'); return source; }

it('preserves historical pre-admission deployment behavior', () => {
  assert.deepEqual(assertPrivateChatReleaseFloor({ apiTaskDefinition: task('api', false), workerTaskDefinition: task('scheduler-worker', false), candidateSources: null }), { required: false });
});
it('requires a compatible writer with capability off after129 admission', () => {
  assert.deepEqual(assertPrivateChatReleaseFloor(input()), { required: true, writerVersion: 1, inventoryCount: 129 });
  assert.throws(() => assertPrivateChatReleaseFloor({ ...input(), candidateSources: { ...candidateSources, writer: 'legacy writer' } }), /durable release floor/);
});
for (const key of ['writer', 'migration', 'protocol', 'relay'] as const) {
  it(`rejects candidate ${key} downgrade after admission`, () => {
    assert.throws(() => assertPrivateChatReleaseFloor({ ...input(), candidateSources: { ...candidateSources, [key]: '' } }));
  });
}
for (const role of ['api', 'worker'] as const) {
  it(`rejects a partial ${role} source pair after either service admits threads`, () => {
    const value = input(); value[role === 'api' ? 'apiTaskDefinition' : 'workerTaskDefinition'] = task(role === 'api' ? 'api' : 'scheduler-worker', false);
    assert.throws(() => assertPrivateChatReleaseFloor(value));
  });
  it(`rejects ${role} master-off after withdrawal`, () => {
    const value = input(); value[role === 'api' ? 'apiTaskDefinition' : 'workerTaskDefinition'] = task(role === 'api' ? 'api' : 'scheduler-worker', true, 'false');
    assert.throws(() => assertPrivateChatReleaseFloor(value));
  });
}
it('checks the candidate writer on first singleton admission', () => {
  const value = { apiTaskDefinition: task('api', false), workerTaskDefinition: task('scheduler-worker', false), enablingTables: ['classpilot_private_chat_threads'], candidateSources, rollbackSourcesBySha };
  assert.equal(assertPrivateChatReleaseFloor(value).required, true);
  assert.throws(() => assertPrivateChatReleaseFloor({ ...value, candidateSources: { ...candidateSources, migration: 'not sticky' } }));
});
it('first admission refuses the current legacy rollback source even when candidate writer is compatible', () => {
  const value = { apiTaskDefinition: task('api', false), workerTaskDefinition: task('scheduler-worker', false), enablingTables: ['classpilot_private_chat_threads'], candidateSources, rollbackSourcesBySha };
  for (const key of ['writer', 'migration', 'protocol', 'relay'] as const) {
    const old = { ...candidateSources, [key]: 'legacy rollback source' };
    assert.throws(() => assertPrivateChatReleaseFloor({ ...value, rollbackSourcesBySha: { ...rollbackSourcesBySha, ['a'.repeat(40)]: old } }), /compatible dark writer\/bridge/);
  }
  const noBridge = { ...candidateSources, writer: candidateSources.writer.replace('export const PRIVATE_CHAT_BRIDGE_VERSION = 1;', '') };
  assert.throws(() => assertPrivateChatReleaseFloor({ ...value, rollbackSourcesBySha: { ...rollbackSourcesBySha, ['b'.repeat(40)]: noBridge } }), /compatible dark writer\/bridge/);
});
for (const admitted of [false, true]) {
  for (const role of ['api', 'scheduler-worker']) {
    it(`rejects a pre-relay ${role} rollback image with capability off ${admitted ? 'after' : 'before'} admission`, () => {
      const value = { ...input(), apiTaskDefinition: task('api', admitted), workerTaskDefinition: task('scheduler-worker', admitted),
        enablingTables: admitted ? [] : ['classpilot_private_chat_threads'] };
      const sha = (role === 'api' ? 'a' : 'b').repeat(40);
      for (const source of [withoutRelay(), { ...candidateSources, relay: candidateSources.relay.replace('export const PRIVATE_CHAT_RELAY_VERSION = 1;', '') },
        { ...candidateSources, relay: candidateSources.relay.replace('export const PRIVATE_CHAT_RELAY_VERSION = 1;', 'export const PRIVATE_CHAT_RELAY_VERSION = 2;') }]) {
        assert.throws(() => assertPrivateChatReleaseFloor({ ...value,
          rollbackSourcesBySha: { ...rollbackSourcesBySha, [sha]: source } }), /compatible dark writer\/bridge/);
      }
    });
  }
}
it('writer and bridge markers cannot substitute for the exact candidate relay marker', () => {
  for (const source of [withoutRelay(), { ...candidateSources, relay: candidateSources.relay.replace('export const PRIVATE_CHAT_RELAY_VERSION = 1;', '') },
    { ...candidateSources, relay: 'export const PRIVATE_CHAT_LIFECYCLE_WRITER_VERSION = 1;\nexport const PRIVATE_CHAT_BRIDGE_VERSION = 1;' }]) {
    assert.throws(() => assertPrivateChatReleaseFloor({ ...input(), candidateSources: source }), /durable release floor/);
  }
});
it('a missing rollback GIT_SHA cannot be replaced by the candidate commit', () => {
  const value = input(); const [container] = value.apiTaskDefinition.containerDefinitions; assert.ok(container);
  container.environment = container.environment.filter(entry => entry.name !== 'GIT_SHA');
  assert.throws(() => assertPrivateChatReleaseFloor(value), /compatible dark writer\/bridge/);
});
it('binds both source images independently to exact GIT_SHA tags and supports the established short build tag', () => {
  const value = input(), expectedRepository = '123456789012.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api';
  const tags: string[] = [];
  assert.equal(verifyPrivateChatSourceImages({ ...value, expectedRepository, lookupDigest: tag => { tags.push(tag); return 'sha256:' + 'd'.repeat(64); } }), true);
  assert.deepEqual(tags, ['a'.repeat(40), 'b'.repeat(40)]);
  const shortTags: string[] = [];
  assert.equal(verifyPrivateChatSourceImages({ ...value, expectedRepository, lookupDigest: tag => { shortTags.push(tag); if (tag.length === 40) throw new Error('tag absent'); return 'sha256:' + 'd'.repeat(64); } }), true);
  assert.deepEqual(shortTags, ['a'.repeat(40), 'a'.repeat(12), 'b'.repeat(40), 'b'.repeat(12)]);
  const mismatchTags: string[] = [];
  assert.throws(() => verifyPrivateChatSourceImages({ ...value, expectedRepository, lookupDigest: tag => { mismatchTags.push(tag); return 'sha256:' + 'e'.repeat(64); } }), /exact source image/);
  assert.deepEqual(mismatchTags, ['a'.repeat(40)], 'An existing mismatched full tag must not fall back to a convenient short tag.');
  assert.throws(() => verifyPrivateChatSourceImages({ ...value, expectedRepository, lookupDigest: () => { throw new Error('no binding'); } }));
  assert.throws(() => verifyPrivateChatSourceImages({ ...value, expectedRepository: 'wrong-repository', lookupDigest: () => 'sha256:' + 'd'.repeat(64) }));
});
it('rejects a candidate which removes the admitted singleton or master enforcement', () => {
  for (const candidate of [task('api', false), task('api', true, 'false')]) {
    assert.throws(() => assertPrivateChatReleaseFloor({ ...input(), candidateTaskDefinitions: [{ taskDefinition: candidate, containerName: 'api' }] }));
  }
});
it('rejects registry duplicates and a rewritten128 prefix', () => {
  const invalid = structuredClone(registry); invalid.inventories.classpilotPrivateChatLifecyclePostExpand.tables[0] = 'classpilot_private_chat_threads';
  assert.throws(() => assertPrivateChatReleaseFloor({ ...input(), candidateSources: { ...candidateSources, registry: JSON.stringify(invalid) } }));
});
it('preserves the pre-admission CLI and rejects an unknown candidate commit before cloud lookup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'schoolpilot-private-chat-floor-'));
  try {
    const api = join(directory, 'api.json'), worker = join(directory, 'worker.json');
    writeFileSync(api, JSON.stringify(task('api', false))); writeFileSync(worker, JSON.stringify(task('scheduler-worker', false)));
    const appSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const args = ['scripts/enforce-private-chat-release-floor.mjs', '--repository-root', process.cwd(), '--app-sha', appSha, '--api-source', api, '--worker-source', worker];
    assert.equal(JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' })).required, false);
    writeFileSync(api, JSON.stringify(task('api'))); writeFileSync(worker, JSON.stringify(task('scheduler-worker')));
    const wrong = [...args]; wrong[wrong.indexOf('--app-sha') + 1] = '0'.repeat(40);
    assert.throws(() => execFileSync(process.execPath, wrong, { stdio: 'pipe' }));
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.match(directory, /schoolpilot-private-chat-floor-/);
    rmSync(directory, { recursive: true, force: true });
  }
});
it('whitespace around the admitted table cannot hide the retained floor', () => {
  const value = input();
  const [apiContainer] = value.apiTaskDefinition.containerDefinitions;
  assert.ok(apiContainer);
  for (const entry of apiContainer.environment) {
    if (entry.name === 'RLS_ENABLED_TABLES') entry.value += ' ,classpilot_private_chat_threads ';
  }
  assert.throws(() => assertPrivateChatReleaseFloor(value));
});
it('deploy guard runs before build and checks rendered candidates before migration or service update', () => {
  const source = readFileSync('scripts/deploy.sh', 'utf8').replace(/\r\n/g, '\n');
  const preflight = source.indexOf('\n  preflight_private_chat_release_floor\n');
  const candidates = source.indexOf('\n  verify_private_chat_release_floor_candidates\n');
  assert.ok(preflight >= 0 && preflight < source.indexOf('    docker build -t'));
  assert.ok(candidates >= 0 && candidates < source.indexOf('\n  MIGRATION_OVERRIDES=$(ENABLE_RLS_TABLE='));
  assert.match(source, /--repository-root "\$PROJECT_ROOT" --app-sha "\$LOCAL_SHA"/);
});
it('registered candidate check accepts both the standard short reference and emergency full ARN', () => {
  const source = readFileSync('scripts/deploy.sh', 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('verify_private_chat_release_floor_candidates() {');
  const finish = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && finish > start);
  const helper = source.slice(start, finish + 3);
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  for (const api of ['schoolpilot-production-api:12', 'arn:aws:ecs:us-east-1:123456789012:task-definition/schoolpilot-production-api-emergency:4']) {
    const script = `${helper}\n` + `
      describe_exact_classpilot_candidate_task_definition() {
        [[ "$1" =~ ^arn:aws:ecs:us-east-1:123456789012:task-definition/schoolpilot-production-(api|api-emergency|scheduler-worker):[1-9][0-9]*$ ]] || return 1
      }
      node() { return 0; }
      error() { printf '%s\\n' "$1" >&2; return 1; }
      verify_private_chat_release_floor_candidates
    `;
    execFileSync(bash, ['-c', script], { env: { ...process.env, API_ROLLOUT_TASK_DEF: api,
      WORKER_CANDIDATE_TASK_DEF: 'arn:aws:ecs:us-east-1:123456789012:task-definition/schoolpilot-production-scheduler-worker:7',
      REGION: 'us-east-1', ACCOUNT_ID: '123456789012', PROJECT_ROOT: process.cwd(), SCRIPT_DIR: 'scripts', LOCAL_SHA: 'a'.repeat(40) }, stdio: 'pipe' });
  }
});
