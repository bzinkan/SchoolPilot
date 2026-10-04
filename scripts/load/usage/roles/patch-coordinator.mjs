import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PROFILE } from './profile.mjs';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length - 1, 1, `Source anchor changed: ${before.slice(0, 100)}`);
  return text.replace(before, () => after);
}
// Generated from the exact candidate's canonical harness. No application module
// is copied over /app; every resulting harness byte is independently bound.
export function patchProfile(source) {
  let text = replaceOnce(source, "name: 'release-enabled-isolated-100rps-v1',", `name: '${PROFILE}',`);
  text = replaceOnce(text, 'export function releaseTrafficOptions(env) {', `export function releaseTrafficOptions(env) {
  if (env.USAGE_RELEASE_ROLE_CONTAINERS === 'true') {
    assert.ok(['diagnostic', 'capacity-candidate'].includes(env.USAGE_RELEASE_MODE));
    assert.equal(env.USAGE_RELEASE_CPU_PROFILE, 'false');
    assert.ok(['combined', 'ingest'].includes(env.USAGE_RELEASE_PHASE));
    assert.equal(env.USAGE_RELEASE_DIAGNOSTIC, env.USAGE_RELEASE_MODE === 'diagnostic' ? 'true' : 'false');
    if (env.USAGE_RELEASE_MODE === 'capacity-candidate') assert.equal(env.USAGE_RELEASE_PHASE, 'combined');
    return {}; // Every role run offers the full60s/6000 schedule, including diagnostics.
  }`);
  return text;
}
export function patchGenerator(source) {
  let text=replaceOnce(source.replaceAll('\r\n','\n'),'let heartbeatStatuses = null;',`let heartbeatStatuses = null;
let heartbeatCapabilityResponses = null;
const REQUIRED_MODERN_HEARTBEAT_CAPABILITIES = Object.freeze(['preciseRestrictionResourcesV1', 'focusTabV1', 'privateChatLifecycleV1', 'lateSignInRestrictionSsoV1', 'restrictionAuthPassThroughV1', 'screenshotTrackingWindowLeaseV1']);`);
  text=replaceOnce(text,"assert.ok([200, 204].includes(result.status), `Heartbeat HTTP ${result.status}`);\n  if (heartbeatStatuses) heartbeatStatuses[result.status] = (heartbeatStatuses[result.status] || 0) + 1;",
    "if (heartbeatStatuses) heartbeatStatuses[result.status] = (heartbeatStatuses[result.status] || 0) + 1;\n  assert.equal(result.status, 200, `Modern enabled heartbeat HTTP ${result.status}`);");
  text=replaceOnce(text,"['preciseRestrictionResourcesV1', 'focusTabV1', 'privateChatLifecycleV1']",
    'REQUIRED_MODERN_HEARTBEAT_CAPABILITIES');
  text=replaceOnce(text,'  return result;\n}\n\nexport function assertHistoricalReport',
    '  if (heartbeatCapabilityResponses !== null) heartbeatCapabilityResponses++;\n  return result;\n}\n\nexport function assertHistoricalReport');
  text=replaceOnce(text,'const cpuStart = process.cpuUsage(); heartbeatStatuses = {};',
    'const cpuStart = process.cpuUsage(); heartbeatStatuses = {}; heartbeatCapabilityResponses = 0;');
  text=replaceOnce(text,'value = { heartbeats, heartbeatStatuses, heartbeat204Reason:',
    'value = { heartbeats, heartbeatStatuses, heartbeatCapabilityProof: {requiredCapabilities:REQUIRED_MODERN_HEARTBEAT_CAPABILITIES,validatedResponses:heartbeatCapabilityResponses}, heartbeat204Reason:');
  text=replaceOnce(text,'      heartbeatStatuses = null;','      heartbeatStatuses = null; heartbeatCapabilityResponses = null;');
  text=replaceOnce(text,"Only the first offer to each of the ten explicitly warmed bindings may use the5s throttle. Every other204 fails. Raw persistence must equal200responses.",
    "This modern enabled profile requires every offered heartbeat to return200 with all enabled authority capabilities. Every204 fails; exactly6000 measured observations must persist.");
  return text;
}
export function patchCoordinator(source) {
  let text = replaceOnce(source, "import assert from 'node:assert/strict';", `import assert from 'node:assert/strict';
import { assertRuntime } from '/prototype-tools/verify-runtime.mjs';
import { getOwnedRoleCoordinator } from '/prototype/coordinator-owner.mjs';
import { assertExecutionMode } from '/prototype/profile.mjs';
assertRuntime('/prototype-tools/base-runtime.json');`);
  text = replaceOnce(text, "const root = fileURLToPath(new URL('../../../', import.meta.url)), output = process.env.USAGE_SCALE_OUTPUT;", `const harnessRoot = fileURLToPath(new URL('../../../', import.meta.url));
const root = '/source', output = process.env.USAGE_SCALE_OUTPUT;
assert.equal(process.platform, 'linux');
const execution = assertExecutionMode({mode:process.env.USAGE_RELEASE_MODE,phase:process.env.USAGE_RELEASE_PHASE,cpuProfile:process.env.USAGE_RELEASE_CPU_PROFILE !== 'false'});
assert.equal(process.env.USAGE_RELEASE_DIAGNOSTIC, execution.diagnosticOnly ? 'true' : 'false');
const diagnosticBinding = JSON.parse(readFileSync('/diagnostic/binding.json', 'utf8'));
assert.equal(diagnosticBinding.applicationSource, process.env.USAGE_SOURCE_REVISION);`);
  text = replaceOnce(text, "assert.ok(sourceClean || process.env.USAGE_RELEASE_DIAGNOSTIC === 'true', 'Capacity evidence requires clean source');", "assert.equal(sourceClean, true, 'Role evidence requires exact clean source');");
  text = replaceOnce(text, 'sourceRevision: source, sourceClean, sourceHashes,', 'sourceRevision: source, sourceClean, sourceHashes, diagnosticBinding, execution,');
  text = replaceOnce(text, 'Generator, API and worker use separate Node processes with512MiB heap caps; Windows process CPU and RSS are not hard-limited.', 'Separate Linux role containers use the exact candidate Node runtime and default V8 flags under fixed CPU/memory ceilings; observed V8 facts are recorded.');
  const start = text.indexOf('async function child(name, file, extraEnv) {');
  const end = text.indexOf('\ntry {\n  const snapshot =', start);
  assert.ok(start > 0 && end > start);
  text = text.slice(0, start) + `async function child(name, file, extraEnv) {
  const owner = await getOwnedRoleCoordinator().child(name, file, extraEnv);
  children.push(owner); return owner;
}` + text.slice(end);
  text = replaceOnce(text, 'metrics.processes = { api: apiReady.pid, worker: workerReady.pid, generator: generatorReady.pid };',
    'metrics.processes = Object.fromEntries(Object.entries({api: apiReady, worker: workerReady, generator: generatorReady}).map(([role, ready]) => [role, `${ready.containerId}:${ready.pid}`]));\n  metrics.poolReadiness = [...apiReady.poolReadiness, ...workerReady.poolReadiness];');
  text = replaceOnce(text, "  await Promise.all([api.rpc('reset'), worker.rpc('reset')]);", "  await Promise.all([api.rpc('reset'), worker.rpc('reset')]);\n  getOwnedRoleCoordinator().captureCoordinatorResources('before');");
  text = replaceOnce(text, "  phase.api = await api.rpc('snapshot'); phase.worker = await worker.rpc('snapshot');", "  phase.api = await api.rpc('snapshot'); phase.worker = await worker.rpc('snapshot');\n  getOwnedRoleCoordinator().captureCoordinatorResources('after');");
  text=replaceOnce(text,'const verification = { schoolIndex: school.index, fixtureViolations, correct: false };',`const persistedRows=phase.persistedAfter.filter(row=>row.school_id===school.id);
      assert.equal(persistedRows.length,1);
      const verification = { schoolIndex: school.index, schoolId:school.id, fixtureViolations, correct: false,
        rawObservationCount:raw.length,persistedObservationCount:persistedRows[0].count };
      assert.equal(verification.rawObservationCount,verification.persistedObservationCount);`);
  text=replaceOnce(text,'Object.assign(verification, result, { correct: result.seconds === expectedSeconds }); save();',`Object.assign(verification, result, { correct: result.seconds === expectedSeconds && result.heartbeatCount === verification.rawObservationCount }); save();
      assert.equal(result.heartbeatCount,verification.rawObservationCount);`);
  text = replaceOnce(text, 'metrics.acceptance = capacityAcceptance(metrics); metrics.capacityAccepted = Object.values(metrics.acceptance).every(Boolean);', `metrics.acceptance = capacityAcceptance(metrics);
    metrics.acceptance.modernHeartbeatPersistence = phase.traffic.heartbeatStatuses?.['200'] === 6000
      && (phase.traffic.heartbeatStatuses?.['204'] ?? 0) === 0 && phase.insertedObservations === 6000
      && phase.persistedBefore.length === 2 && phase.persistedBefore.every(row=>row.count===6)
      && phase.persistedAfter.length === 2 && phase.persistedAfter.every(row=>row.count===3006);
    metrics.runChecksPassed = Object.entries(metrics.acceptance).every(([key,value]) => execution.diagnosticOnly && key === 'acceptanceRun' || value === true);
    metrics.diagnosticChecksPassed = execution.diagnosticOnly && metrics.runChecksPassed;
    metrics.capacityAccepted = false; // Only the separately validated three-run campaign can accept capacity.`);
  text = replaceOnce(text, "assert.equal(metrics.capacityAccepted, true, 'Release-enabled capacity acceptance failed; preserved full diagnostic evidence');", "assert.equal(metrics.runChecksPassed, true, 'Role workload requirements failed; full evidence retained');");
  text = replaceOnce(text, "try { await owner.rpc('shutdown', undefined, 15_000); } catch { owner.process.kill(); }", "try { await owner.rpc('shutdown', undefined, 15_000); } catch { metrics.childCleanupFailure = true; process.exitCode = 1; owner.process.kill('SIGTERM'); }");
  text = replaceOnce(text, 'const watchdog = setTimeout(() => owner.process.kill(), 15_000);', "const watchdog = setTimeout(() => { metrics.childCleanupFailure = true; process.exitCode = 1; owner.process.kill('SIGKILL'); }, 15_000);");
  text = replaceOnce(text, 'if (!metrics.childShutdownClean) metrics.capacityAccepted = false;', 'if (!metrics.childShutdownClean) { metrics.runChecksPassed = false; metrics.diagnosticChecksPassed = false; }\n  metrics.capacityAccepted = false;');
  return { text, receipt: { inputSha256: hash(source), outputSha256: hash(text), applicationModulesChanged: 0, workloadChanged: false, capacityAccepted: false } };
}
export function patchProcess(source) {
  let text = replaceOnce(source, "import assert from 'node:assert/strict';", "import assert from 'node:assert/strict';\nimport {proveActualPool} from '/prototype/pool-readiness.mjs';");
  text = replaceOnce(text, "  db.startApiPoolReadiness();", `  const poolReadiness = await Promise.all([
    proveActualPool(mainPool,{name:'api',max:16,applicationName:RELEASE_PG_APPLICATION_NAMES.api}),
    proveActualPool(sessionPool,{name:'session',max:2,applicationName:RELEASE_PG_APPLICATION_NAMES.api}),
  ]);
  db.startApiPoolReadiness();`);
  text = replaceOnce(text, 'prewarmed, readiness: true, redis: true });', 'prewarmed, readiness: true, redis: true, poolReadiness });');
  text = replaceOnce(text, "  timer = setInterval(() => { metrics.peakWaiting = Math.max(metrics.peakWaiting, schedulerPool.waitingCount);", "  const poolReadiness = [await proveActualPool(schedulerPool,{name:'worker',max:5,applicationName:RELEASE_PG_APPLICATION_NAMES.worker,worker:true})];\n  timer = setInterval(() => { metrics.peakWaiting = Math.max(metrics.peakWaiting, schedulerPool.waitingCount);");
  text = replaceOnce(text, 'pools: { worker: 5 }, postgresApplicationName: RELEASE_PG_APPLICATION_NAMES.worker });', 'pools: { worker: 5 }, postgresApplicationName: RELEASE_PG_APPLICATION_NAMES.worker, poolReadiness });');
  return text;
}
