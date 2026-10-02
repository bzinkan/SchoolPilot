#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const THREAD_TABLE = 'classpilot_private_chat_threads';
function inspect(task, name) {
  const containers = (task?.containerDefinitions ?? []).filter(container => container.name === name);
  if (containers.length !== 1) throw new Error(`Private chat release floor requires one ${name} container.`);
  const entries = containers[0].environment ?? [];
  const value = key => {
    const found = entries.filter(entry => entry.name === key);
    if (found.length > 1 || (containers[0].secrets ?? []).some(entry => entry.name === key)) throw new Error(`Ambiguous ${key}.`);
    return found[0]?.value;
  };
  const raw = value('RLS_ENABLED_TABLES');
  return { guc: value('RLS_GUC_ENABLED'), tables: typeof raw === 'string' ? raw.split(',').map(table => table.trim()) : [], gitSha: value('GIT_SHA'), image: containers[0].image };
}

function compatibleSource(files) {
  return /export const PRIVATE_CHAT_LIFECYCLE_WRITER_VERSION = 1;/.test(files?.writer ?? '') &&
    /export const PRIVATE_CHAT_BRIDGE_VERSION = 1;/.test(files?.writer ?? '') &&
    /id: "classpilot-private-chat-lifecycle-20261002"/.test(files?.migration ?? '') &&
    /OLD\.private_chat_lifecycle_required\s+AND\s+NOT\s+NEW\.private_chat_lifecycle_required/.test(files?.migration ?? '') &&
    /"privateChatLifecycleV1"/.test(files?.protocol ?? '');
}

export function assertPrivateChatReleaseFloor({ apiTaskDefinition, workerTaskDefinition, enablingTables = [], candidateSources, rollbackSourcesBySha = {}, candidateTaskDefinitions = [] }) {
  const source = [inspect(apiTaskDefinition, 'api'), inspect(workerTaskDefinition, 'scheduler-worker')];
  const admitted = source.some(item => item.tables.includes(THREAD_TABLE));
  if (!admitted && !enablingTables.includes(THREAD_TABLE)) return { required: false };
  const failure = 'Private chat admission is a durable release floor: require the complete preserved129 GUC admission and lifecycle-aware sticky writer/migration, even when its capability is off.';
  const registry = JSON.parse(candidateSources.registry);
  const inventory = registry.inventories?.classpilotPrivateChatLifecyclePostExpand;
  const previous = registry.inventories?.passpilotAppointmentsPostExpand?.tables;
  if (!Array.isArray(inventory?.tables) || inventory.count !== 129 || inventory.tables.length !== 129 ||
      new Set(inventory.tables).size !== 129 || !Array.isArray(previous) || previous.length !== 128 ||
      JSON.stringify(inventory.tables.slice(0, 128)) !== JSON.stringify(previous) || inventory.tables[128] !== THREAD_TABLE ||
      JSON.stringify(registry.reviewedEnablementRequests?.classpilotPrivateChatLifecycle) !== JSON.stringify([THREAD_TABLE]) ||
      !compatibleSource(candidateSources)) throw new Error(failure);
  const complete = item => item.guc === 'true' && new Set(item.tables).size === item.tables.length && inventory.tables.every(table => item.tables.includes(table));
  // If either service already admitted it, partial pairs and master-off fail.
  if (admitted && !source.every(complete)) throw new Error(failure);
  if (!admitted && !source.every(item => item.guc === 'true' && previous.every(table => item.tables.includes(table)))) throw new Error(failure);
  for (const item of source) {
    if (!/^[a-f0-9]{40}$/.test(item.gitSha ?? '') || !compatibleSource(rollbackSourcesBySha[item.gitSha])) {
      throw new Error('First private chat admission requires a stable compatible dark writer/bridge on both exact rollback source images. Deploy that reversible dark pair before enabling the thread table.');
    }
  }
  for (const candidate of candidateTaskDefinitions) {
    if (!complete(inspect(candidate.taskDefinition, candidate.containerName))) throw new Error(failure);
  }
  return { required: true, writerVersion: 1, inventoryCount: 129 };
}

export function verifyPrivateChatSourceImages({ apiTaskDefinition, workerTaskDefinition, expectedRepository, lookupDigest }) {
  const source = [inspect(apiTaskDefinition, 'api'), inspect(workerTaskDefinition, 'scheduler-worker')];
  for (const item of source) {
    if (!/^[a-f0-9]{40}$/.test(item.gitSha ?? '') || typeof item.image !== 'string' || !item.image.startsWith(`${expectedRepository}@`)) throw new Error('Source rollback image identity is incomplete.');
    const digest = item.image.slice(expectedRepository.length + 1);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Rollback sources must use immutable image digests.');
    let bound;
    try { bound = lookupDigest(item.gitSha); } catch { bound = lookupDigest(item.gitSha.slice(0, 12)); }
    if (bound !== digest) throw new Error('Rollback source GIT_SHA does not bind its exact source image digest.');
  }
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const value = key => {
    const index = args.indexOf(key);
    if (index < 0 || !args[index + 1]) throw new Error(`${key} is required.`);
    return args[index + 1];
  };
  const appSha = value('--app-sha');
  if (!/^[0-9a-f]{40}$/.test(appSha)) throw new Error('Candidate app SHA must be exact.');
  const root = value('--repository-root');
  const readSource = path => execFileSync('git', ['show', `${appSha}:${path}`], { cwd: root, encoding: 'utf8' });
  const json = path => JSON.parse(readFileSync(path, 'utf8'));
  const optional = key => args.includes(key) ? value(key) : null;
  // Read the exact candidate commit, never unstaged files or a mutable tag.
  const apiTaskDefinition = json(value('--api-source'));
  const workerTaskDefinition = json(value('--worker-source'));
  const enablingTables = (optional('--enable-rls-table') ?? '').split(',').filter(Boolean);
  const candidates = [['--api-candidate', 'api'], ['--worker-candidate', 'scheduler-worker']]
    .filter(([key]) => args.includes(key)).map(([key, containerName]) => ({ taskDefinition: json(value(key)), containerName }));
  const floor = [inspect(apiTaskDefinition, 'api'), inspect(workerTaskDefinition, 'scheduler-worker')].some(item => item.tables.includes(THREAD_TABLE)) || enablingTables.includes(THREAD_TABLE);
  const candidateSources = floor ? {
    registry: readSource('src/config/rlsRegistry.json'), writer: readSource('src/services/classpilotPrivateChatLifecycle.ts'),
    migration: readSource('src/db/classpilotPrivateChatLifecycleMigration.ts'), protocol: readSource('src/services/classpilotProtocol.ts'),
  } : null;
  const rollbackSourcesBySha = {};
  if (floor) for (const item of [inspect(apiTaskDefinition, 'api'), inspect(workerTaskDefinition, 'scheduler-worker')]) {
    if (!/^[a-f0-9]{40}$/.test(item.gitSha ?? '')) throw new Error('Compatible rollback source GIT_SHA is required before private chat admission.');
    rollbackSourcesBySha[item.gitSha] = Object.fromEntries([['writer','src/services/classpilotPrivateChatLifecycle.ts'],['migration','src/db/classpilotPrivateChatLifecycleMigration.ts'],['protocol','src/services/classpilotProtocol.ts']]
      .map(([key,path]) => [key, execFileSync('git', ['show', `${item.gitSha}:${path}`], { cwd: root, encoding: 'utf8' })]));
  }
  const result = assertPrivateChatReleaseFloor({ apiTaskDefinition, workerTaskDefinition, enablingTables, candidateSources, rollbackSourcesBySha, candidateTaskDefinitions: candidates });
  if (result.required) {
    const expectedRepository = value('--expected-repository');
    const repositoryName = expectedRepository.split('/').slice(1).join('/');
    if (!repositoryName || !/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9/_-]+$/.test(expectedRepository)) throw new Error('Expected ECR repository identity is invalid.');
    verifyPrivateChatSourceImages({ apiTaskDefinition, workerTaskDefinition, expectedRepository,
      lookupDigest: tag => {
        const digest = execFileSync('aws', ['ecr','describe-images','--repository-name',repositoryName,'--image-ids',`imageTag=${tag}`,'--query','imageDetails[0].imageDigest','--output','text','--region',value('--region'),'--no-cli-pager'], { encoding: 'utf8' }).trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('No source image binding.');
        return digest;
      } });
    result.sourceImagesVerified = true;
  }
  process.stdout.write(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
