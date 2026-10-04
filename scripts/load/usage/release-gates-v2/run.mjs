import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { profileFor, profileHash, hash, stageForRound } from './contracts.mjs';
import { validateRound } from './validation.mjs';
import { classifyLog, cpuWindow, negativeProbes, runNegativeProbes, negativeLogCoverage } from './measurements.mjs';
import { checkPersistence } from './persistence.mjs';
import { runMixed } from './mixed.mjs';
import { assertOutside, ownRole } from './owner.mjs';
import { pause } from './application.mjs';
import { roleEnvironment, remapObservedEnvironment, validateBaselineAdvertisement } from './environment.mjs';
import { withCommonDatabase } from './common-database.mjs';
import { withRestoredSnapshot } from '../roles/restore-snapshot.mjs';
import { loadSnapshot } from '../roles/snapshot-contract.mjs';
import { schoolDayOracle } from '../school-day-profile.mjs';

const execute = promisify(execFile), read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const save = (directory, name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true }).trim();

export async function runV2(options) {
  const profile = profileFor(options.profile), output = resolve(options.outputDirectory), control = resolve(options.privateDirectory);
  assert.match(options.source, /^[a-f0-9]{40}$/); assert.match(options.run, /^[a-f0-9]{12}$/);
  assert.match(options.endpoint, /^(?:npipe:\/{2,4}\.\/pipe\/[a-zA-Z0-9_.-]+|unix:\/\/\/[^\s?#]+)$/);
  assertOutside(options.sourceDirectory, output); assertOutside(options.sourceDirectory, control); assertOutside(output, control);
  assert.equal(existsSync(output), false); assert.equal(existsSync(control), false);
  assert.equal(git(options.sourceDirectory, ['rev-parse', 'HEAD']), options.source); assert.equal(git(options.sourceDirectory, ['status', '--porcelain']), '');
  for (const key of ['helperImage', 'helperConfigDigest', 'postgresImage', 'redisImage']) assert.match(options[key], /^sha256:[a-f0-9]{64}$/);
  const bindingBytes = readFileSync(options.helperBindingFile); assert.equal(hash(bindingBytes), options.helperBindingSha256);
  const binding = JSON.parse(bindingBytes); assert.equal(binding.applicationSource, options.source); assert.equal(binding.helperImage, options.helperImage);
  assert.equal(binding.helperConfigDigest, options.helperConfigDigest); assert.equal(binding.verified, true);
  assert.match(binding.helperContainerImage, /^sha256:[a-f0-9]{64}$/);
  const prepBytes = readFileSync(options.preparationFile); assert.equal(hash(prepBytes), binding.preparationSha256);
  const preparation = JSON.parse(prepBytes); assert.equal(preparation.applicationSource, options.source); assert.equal(preparation.applicationImage, binding.applicationImage);
  const envBytes = readFileSync(options.observedEnvironmentFile); assert.equal(hash(envBytes), options.observedEnvironmentSha256);
  const preparedSnapshot=profile.usage?loadSnapshot(options.snapshotDirectory,options.snapshotManifestSha256,{source:options.source,today:today()}):null;
  const remapped = remapObservedEnvironment(JSON.parse(envBytes), options.scopeBinding, today(),preparedSnapshot?.data['cold-fixture-state.json'].schools.map(row=>row.id));
  let clientCapabilities;
  if(['blackbox','diagnostic'].includes(profile.kind)){
    const advertisementBytes=readFileSync(options.clientAdvertisementFile);assert.equal(hash(advertisementBytes),options.clientAdvertisementSha256);
    clientCapabilities=validateBaselineAdvertisement(JSON.parse(advertisementBytes));
  }
  const reservationBytes=readFileSync(options.reservationFile);assert.equal(hash(reservationBytes),options.reservationSha256);
  const reservation=JSON.parse(reservationBytes);assert.equal(reservation.run,options.run);assert.equal(reservation.source,options.source);assert.equal(reservation.arm,options.arm);
  assert.equal(reservation.profile,profile.name);assert.equal(reservation.contractSha256,profileHash(profile));assert.equal(reservation.observedFlagsSha256,remapped.observedFlagsSha256);
  assert.equal(reservation.preparationSmoke,options.preparationSmoke===true);
  assert.equal(reservation.receiptDirectory,output);assert.equal(reservation.privateDirectory,control);
  const windowBytes = readFileSync(options.quietWindowFile); assert.equal(hash(windowBytes), options.quietWindowSha256);
  const window = JSON.parse(windowBytes); assert.equal(window.source, options.source); assert.equal(window.profile, profile.name);
  if(options.preparationSmoke===true)assert.equal(window.preparationSmoke,true);
  else assert.equal(window.noOtherLoadOrBuilds, true);
  assert.ok(Date.now() >= Date.parse(window.startsAt) && Date.now() < Date.parse(window.expiresAt));
  const run = options.run, arm = options.arm || 'C', declaredAt = new Date().toISOString();
  assert.ok(['A', 'B', 'C'].includes(arm)); assert.equal(profile.usage, !!options.snapshotDirectory);
  const plan = { schemaVersion: 2, run, source: options.source, arm, mode: 'diagnostic', declaredAt, profile: profile.name, contractSha256: profileHash(profile),
    reservationSha256:options.reservationSha256,campaignContractSha256:reservation.campaignContractSha256,
    clientAdvertisementSha256:options.clientAdvertisementSha256??null,clientAdvertisementVersion:clientCapabilities?'2.9.6':'2.9.7',
    applicationImage: binding.applicationImage, helperImage: options.helperImage, helperBindingSha256: options.helperBindingSha256,harnessSource:preparation.harnessSource,
    observedEnvironmentSha256: options.observedEnvironmentSha256, observedFlagsSha256: remapped.observedFlagsSha256,
    scopeBindingSha256: remapped.scopeBindingSha256, quietWindowSha256: options.quietWindowSha256,
    snapshotManifestSha256: options.snapshotManifestSha256 ?? null, schemaSha256: options.schemaSha256 ?? null,
    sourceAndSchemaAcceptance: false, productionReadiness: false, capacityAccepted: false };
  const planFile = output + '.plan.json'; writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' }); const planSha256 = hash(readFileSync(planFile));
  const environment = { ...process.env }; for (const key of Object.keys(environment)) if (/^(?:DOCKER_|BUILDX_BUILDER$|NODE_OPTIONS$)/.test(key)) delete environment[key];
  const docker = async (args, { input, timeout = 120_000 } = {}) => {
    try { const result = await execute(options.docker || 'docker', ['--host', options.endpoint, ...args], { env: environment, input, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 ** 2 }); return result.stdout + (args[0] === 'logs' ? result.stderr : ''); }
    catch (error) { throw Object.assign(Error('V2_DOCKER_OPERATION_FAILED'), { privateDetail: String(error.stderr || '').slice(0, 4000) }); }
  };
  // execFile does not accept stdin input. Feed only fixed owned-fixture DDL to
  // its actual child, without putting credentials or DDL in command arguments.
  const dockerInput = async (args, settings = {}) => {
    if (settings.input === undefined) return docker(args, settings);
    return new Promise((resolveValue, reject) => {
      const child = execFile(options.docker || 'docker', ['--host', options.endpoint, ...args], { env: environment, encoding: 'utf8', windowsHide: true, timeout: settings.timeout || 120_000, maxBuffer: 16 * 1024 ** 2 }, (error, stdout, stderr) => error ? reject(Object.assign(Error('V2_DOCKER_STDIN_FAILED'), { privateDetail: String(stderr).slice(0, 4000) })) : resolveValue(stdout));
      child.stdin.end(settings.input);
    });
  };
  const metrics = { ...plan, planSha256, rounds: [], transitions: [], startedAt: new Date().toISOString(), runPassed: false, sourceUnchanged: false, cleanupPassed: false,
    preparationSmoke:options.preparationSmoke===true,
    nodeVersion: binding.nodeVersion, diagnosticOnly: profile.kind === 'diagnostic', limitations: ['Local4CPU/4GiBPostgreSQL is not production headroom.', 'Synthetic client ACKs do not prove packaged browser enforcement.', 'Host filesystem cache is not cleared.'] };
  let failure;
  async function measure(configuration, restart, initialFixture) {
    const owners = [], active = new Map(), exits = []; let redisId; const secrets = { JWT_SECRET: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex'), STUDENT_TOKEN_SECRET: randomBytes(32).toString('hex'), RELEASE297_FIXTURE_PASSWORD: randomBytes(24).toString('hex') };
    const schemaReceipt = options.schemaReceiptFile ? read(options.schemaReceiptFile) : null;
    const tables = options.rlsTables ?? schemaReceipt?.rlsTables; assert.ok(Array.isArray(tables) && new Set(tables).size === tables.length);
    let observer, fixture;
    const environmentFor = (role, index = 0) => roleEnvironment({ base: remapped.environment, source: options.source, run, appUrl: configuration.appUrl, adminUrl: configuration.adminUrl, profile, role, tables, secrets, clientCapabilities, arm, apiIndex: index });
    async function role(name, entryFile, cpu, memory, index = 0) {
      const owner = await ownRole({ docker: dockerInput, run, source: options.source, helperImage: options.helperImage, helperConfigDigest: options.helperConfigDigest,
        helperContainerImage: binding.helperContainerImage, preparation, pgContainerId: configuration.pgContainerId, role: name, entryFile, environment: environmentFor(name, index), privateDirectory: control, outputDirectory: output, cpu, memory });
      owners.push(owner); return owner;
    }
    async function stop(owner) { const exit = await owner.shutdown(); exits.push(exit); await dockerInput(['rm', '--volumes', owner.id]); return exit; }
    try {
      const seeder = await role('seeder', '/harness/observer.mjs', .5, 1024 ** 3);
      fixture = initialFixture ? await seeder.rpc('initialize', { ...initialFixture, password: secrets.RELEASE297_FIXTURE_PASSWORD }) : await seeder.rpc('seed');
      const verification = await seeder.rpc('verify'); assert.equal(verification.passed, true);
      if (schemaReceipt) assert.deepEqual(verification.migrations, schemaReceipt.migrations);
      metrics.databasePreparation = verification; metrics.schemaSha256 = configuration.schemaSha256;
      metrics.fixtureLogicalSha256 = fixture.logicalFixtureSha256 ?? hash(JSON.stringify({ today: fixture.today, schools: fixture.schools }));
      assert.equal((await stop(seeder)).clean, true);
      await restart();
      const redisName = `schoolpilot-release297-v2-redis-${run}`;
      try { redisId = (await dockerInput(['run', '--detach', '--name', redisName, '--label', `codex.release297-v2=${run}`, '--label', `codex.release297-source=${options.source}`,
        '--cpus', '1', '--memory', '256m', '--memory-swap', '256m', '--network', 'container:' + configuration.pgContainerId,
        options.redisImage, 'redis-server', '--port', '6387', '--save', '', '--appendonly', 'no'])).trim(); }
      finally {
        const found = (await dockerInput(['container','ls','-a','--filter',`name=^/${redisName}$`,'--no-trunc','--format','{{.ID}}'])).trim();
        if (found) { const actual = JSON.parse(await dockerInput(['inspect',found]))[0]; assert.equal(actual.Config.Labels['codex.release297-v2'],run); assert.equal(actual.Config.Labels['codex.release297-source'],options.source); assert.equal(actual.Config.Image,options.redisImage); redisId = found; }
      }
      assert.match(redisId, /^[a-f0-9]{64}$/);
      for (let n = 0; n < 60; n++) { try { assert.equal((await dockerInput(['exec', redisId, 'redis-cli', '-p', '6387', 'PING'])).trim(), 'PONG'); break; } catch { if (n === 59) throw Error('REDIS_NOT_READY'); await pause(100); } }
      observer = await role('observer', '/harness/observer.mjs', .5, 1024 ** 3); await observer.rpc('initialize', fixture);
      const blackbox = ['blackbox', 'diagnostic'].includes(profile.kind);
      async function startApi(index) { const owner = await role('api' + index, blackbox ? '/harness/blackbox-api.mjs' : '/diagnostic/scripts/load/usage/release-enabled-process.mjs', 1, 2 * 1024 ** 3, index); active.set(index, owner); return owner; }
      await startApi(0);
      if (profile.kind === 'usage'||profile.initialApiTasks===3) { await startApi(1); await startApi(2); }
      const worker = profile.usage ? await role('worker', '/diagnostic/scripts/load/usage/release-enabled-process.mjs', .5, 1024 ** 3) : null;
      const generator = await role('generator', blackbox ? '/harness/blackbox-generator.mjs' : '/diagnostic/scripts/load/usage/release-enabled-generator.mjs', 2, 1024 ** 3);
      const apiBases = [0, 1, 2].map(n => 'http://127.0.0.1:' + (4001 + n));
      await generator.rpc('initialize', { ...fixture, apiBases });
      await pause(5500); // Keep the preflight's existing5s throttle out of measured ordinary offers.
      await Promise.all([...active.values()].map(owner => owner.rpc('quiesce')));
      if(options.preparationSmoke===true){
        const before=await observer.rpc('snapshot',{since:new Date(Date.now()-86400_000).toISOString()});
        const result=blackbox?await generator.rpc('verify'):await generator.rpc('phase',{offering:profile.offering,topology:{active:[...active.keys()],distribution:'uniform'},ingest:false,reports:false,lifecycle:true,reconnect:false});
        const drained=await Promise.all([...active.values()].map(owner=>owner.rpc('drain')));
        const after=await observer.rpc('snapshot',{since:new Date(Date.now()-86400_000).toISOString()});
        metrics.preparationSmokeResult={passed:drained.every(row=>row.complete)&&after.invalid===0&&(blackbox?result.passed:result.lifecycle?.passed),result,drained,
          persistedAfterWarmVerification:after.total-before.total,capacityAccepted:false,releaseAcceptance:false};
        save(output,'preparation-smoke.json',metrics.preparationSmokeResult);return;
      }
      if(profile.kind==='mixed') {
        await runMixed({profile,active,startApi,stop,generator,observer,fixture,metrics,
          save:(name,value)=>save(output,name,value),docker:dockerInput,readLog:name=>readFileSync(join(control,name+'-log.private'),'utf8'),
          pgContainerId:configuration.pgContainerId,expiresAt:window.expiresAt});
        assert.ok(metrics.continuous.passed && metrics.rounds.every(round=>round.acceptance.passed),'Continuous mixed acceptance failed');
        assert.equal(today(),fixture.today);return;
      }
      const canary = monitorEventLoopDelay({ resolution: 20 }); canary.enable();
      for (let index = 0; index < (profile.rounds ?? 1); index++) {
        assert.ok(Date.now() < Date.parse(window.expiresAt), 'Declared quiet window expired before a measured round');
        const roundStarted = performance.now(), stage = profile.kind === 'mixed' ? stageForRound(index) : { active: [...active.keys()], distribution: 'uniform' };
        let transition;
        if (profile.kind === 'mixed' && index === 5) { await startApi(1); await startApi(2); }
        if (profile.kind === 'mixed' && index === 10) { const exit = await stop(active.get(0)); active.delete(0); assert.equal(exit.clean, true); transition = { lostRole: 'api0', cleanShutdown: true, exit }; }
        if ([0,5,7,10].includes(index)) metrics.transitions.push({ round: index, active: stage.active, distribution: stage.distribution, ...transition });
        const since = new Date(Date.now() - 86400_000).toISOString(), before = await observer.rpc('snapshot', { since });
        await Promise.all([...active.values()].map(owner => owner.rpc('reset'))); if (worker) await worker.rpc('reset');
        const resourceBefore = [...active.values()].map(owner => ({ role: owner.role, value: owner.resources.at(-1) }));
        metrics.wholeOwnedCpuStarts=resourceBefore;
        const startsAtMs = Date.now() + 1000; canary.reset();
        const windowPromises = [...active.values()].map(owner => owner.rpc('measureWindow', { startsAtMs, durationMs: 60_000 }));
        const trafficPromise = generator.rpc('phase', { startsAtMs, offering: profile.offering, topology: stage, ingest: true, reports: profile.usage, lifecycle: !blackbox, reconnect: profile.kind === 'mixed' && index === 10 });
        const heavyDate = fixture.heavyDate;
        const workerPromises = worker ? fixture.schools.map(async school => {
          const date = new Date(heavyDate + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + 1);
          // School-local midnight is provided by the prepared source fixture.
          const cutoff = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', timeZoneName: 'longOffset', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date).find(part => part.type === 'timeZoneName').value.replace('GMT', '');
          const result = await worker.rpc('rollup', { schoolId: school.id, date: heavyDate, cutoff: `${date.toISOString().slice(0, 10)}T00:00:00${cutoff}` });
          const oracle = schoolDayOracle('school'); return { schoolIndex: school.index, ...result, correct: result.seconds === oracle.monitored && result.heartbeatCount === oracle.heartbeats && result.rowCount === oracle.grains };
        }) : [];
        const results = await Promise.allSettled([trafficPromise, ...workerPromises]);
        const traffic = results[0].status === 'fulfilled' ? results[0].value : { failed: true, error: 'GENERATOR_PHASE_FAILED' };
        const workers = results.slice(1).map(result => result.status === 'fulfilled' ? result.value : { correct: false, error: 'WORKER_PHASE_FAILED' });
        const windows = await Promise.all(windowPromises);
        const drains = await Promise.all([...active.values()].map(owner => owner.rpc('drain'))); if (worker) drains.push(await worker.rpc('drain'));
        const api = await Promise.all([...active.values()].map(owner => owner.rpc('snapshot'))), after = await observer.rpc('snapshot', { since });
        const cpuByRole = [...active.values()].map((owner, position) => ({ role: owner.role, window: windows[position], ...cpuWindow(windows[position]),
          wholeOwnedUsec: owner.resources.at(-1).cpu.usage_usec - resourceBefore[position].value.cpu.usage_usec }));
        const cpuUsec = cpuByRole.reduce((sum,row) => sum + row.usec,0), wholeCpuUsec = cpuByRole.reduce((sum,row) => sum + row.wholeOwnedUsec,0);
        const errorCoverage = await Promise.all([...active.values()].map(async owner => ({ role: owner.role, ...classifyLog(await owner.logs(),'api',{complete:true,expectedNegativeProbes:negativeProbes(traffic)}) })));
        if(worker)errorCoverage.push({role:'worker',...classifyLog(await worker.logs(),'api',{complete:true})});
        errorCoverage.push(classifyLog(await dockerInput(['logs',configuration.pgContainerId]),'postgres',{complete:true}));
        const persistence = checkPersistence(before,after,traffic,fixture);
        const successful = traffic.heartbeats?.succeeded ?? traffic.succeeded ?? 0;
        const round = { index, profile: profile.name, contractSha256: profileHash(profile), topology: stage, reconnect: profile.kind === 'mixed' && index === 10,
          durationMs: performance.now() - roundStarted, measuredWindowMs: 60_000, traffic, workers, drains, api, cpuByRole, persistence,
          persisted: after.total - before.total, invalidBindings: after.invalid, apiCpuMicroseconds: cpuUsec,
          apiCpuMeanFraction: Math.max(...cpuByRole.map(row => row.meanFraction)), wholeOwnedApiCpuMicroseconds: wholeCpuUsec,
          postWindowApiCpuMicroseconds: wholeCpuUsec-cpuUsec, cpuMsPer200: successful ? wholeCpuUsec / 1000 / successful : null,
          errorCoverage, databaseFailures: errorCoverage.reduce((sum,row) => sum + row.errorCount,0),
          rawBlackboxSqlFailureCountersAvailable: !blackbox, hostCanaryMaxMs: canary.max / 1e6 };
        if (profile.usage) {
          const cutoff = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
          const rawOracle = await observer.rpc('correctness', { cutoff }), currentWorkers = [];
          for (const school of fixture.schools) { const expected = rawOracle.schools.find(row => row.schoolIndex === school.index); const result = await worker.rpc('rollup', { schoolId: school.id, date: fixture.today, cutoff }); currentWorkers.push({ ...result, correct: result.seconds === expected.expectedSeconds && result.durationMs <= 48_000 }); }
          const exports = await generator.rpc('correctness'); let correct = currentWorkers.every(row => row.correct) && exports.length === 8;
          for (const row of exports) {
            const school = fixture.schools[row.schoolIndex], seconds = new Map(rawOracle.schools.find(result => result.schoolIndex === row.schoolIndex).secondsByStudent);
            const ids = school.students.filter((_, n) => row.scope === 'school' || (row.scope === 'grade' ? n % 5 === 0 : row.scope === 'class' ? n < 5 : n === 0));
            const current = ids.reduce((n, id) => n + (seconds.get(id) || 0), 0), expected = fixture.historyDays * 90 * ids.length + schoolDayOracle(row.scope).monitored + current;
            correct &&= row.report.totals.monitoredBrowserSeconds === expected && row.report.byDay.find(day => day.date === fixture.today)?.monitoredBrowserSeconds === current && row.csv.includes(`"Total","","${(expected / 60).toFixed(1)}"`);
            delete row.csv;
          }
          const audit = await observer.rpc('correctness',{audit:true,cutoff});
          round.correctness = { passed: correct && audit.passed === true, rawOracle, currentWorkers, exports, audit };
          round.drains.push(await worker.rpc('drain'));const finalWorker=await worker.rpc('snapshot');
          assert.ok(finalWorker.database?.acquisitions?.count>0);assert.equal(finalWorker.database.acquisitions.failures,0);
          assert.ok(Object.keys(finalWorker.database.statements).length>0);assert.ok(Object.values(finalWorker.database.statements).every(row=>row.failures===0));
          round.workerDatabase=finalWorker.database;
          round.errorCoverage=await Promise.all([...active.values()].map(async owner=>({role:owner.role,...classifyLog(await owner.logs(),'api',{complete:true,expectedNegativeProbes:negativeProbes(traffic)})})));
          round.errorCoverage.push({role:'worker',...classifyLog(await worker.logs(),'api',{complete:true})},classifyLog(await dockerInput(['logs',configuration.pgContainerId]),'postgres',{complete:true}));
          round.databaseFailures=round.errorCoverage.reduce((sum,row)=>sum+row.errorCount,0);
        }
        const checked = validateRound(round, profile, { diagnostic: profile.kind === 'diagnostic', baseline: arm === 'A' });
        round.acceptance = checked; metrics.rounds.push(round); save(output, `round-${index + 1}.json`, round);
        if (!checked.passed && profile.kind !== 'diagnostic') { failure = 'V2_NUMERICAL_ACCEPTANCE_FAILED'; break; }
        assert.equal(today(), fixture.today, 'Fixture crossed the school-local date');
        assert.ok(Date.now() < Date.parse(window.expiresAt), 'Declared quiet window expired during measured work');
      }
      canary.disable();
      if(profile.usage&&options.reportCostCases){
        metrics.reportCostDiagnostic=await observer.rpc('queryPlans',{source:options.source,schemaSha256:metrics.schemaSha256,profile:profile.name,cases:options.reportCostCases},120_000);
        assert.equal(metrics.reportCostDiagnostic.capacityAcceptance,false);save(output,'report-cost-diagnostic.json',metrics.reportCostDiagnostic);
      }
    } finally {
      for (const owner of owners.reverse()) {
        if (exits.some(exit => exit.containerId === owner.id)) continue;
        try { exits.push(await owner.shutdown()); } catch { exits.push({ role: owner.role, containerId: owner.id, clean: false }); }
      }
      if(profile.kind==='blackbox'||profile.kind==='diagnostic'){
        // Baseline exposes producer flush rather than a live batch drain.
        // Its final permanent flush is therefore part of the paired CPU cost,
        // measured through the owned shutdown acknowledgement in both arms.
        const successful=metrics.rounds[0]?.traffic?.succeeded;
        const whole=owners.filter(owner=>owner.role.startsWith('api')).reduce((sum,owner)=>{
          const start=metrics.wholeOwnedCpuStarts?.find(row=>row.role===owner.role)?.value;
          return sum+(start?owner.resources.at(-1).cpu.usage_usec-start.cpu.usage_usec:NaN);
        },0);
        metrics.wholeOwnedApiCpuMicroseconds=whole;metrics.cpuMsPer200=successful&&Number.isFinite(whole)?whole/1000/successful:null;
        metrics.wholeOwnedCpuIncludesFinalClassificationFlush=true;
      }
      metrics.errorCoverage = owners.map(owner => ({ role:owner.role,
        ...classifyLog(readFileSync(join(control,`${owner.role}-log.private`),'utf8'),'api',{complete:exits.find(exit => exit.containerId===owner.id)?.clean===true,expectedNegativeProbes:owner.role.startsWith('api')?runNegativeProbes(metrics):[]}) }));
      const pgLog = await dockerInput(['logs',configuration.pgContainerId]); writeFileSync(join(control,'postgres-log.private'),pgLog,{flag:'wx',mode:0o600});
      metrics.errorCoverage.push(classifyLog(pgLog,'postgres',{complete:true}));
      metrics.expectedNegativeLogCoverage=negativeLogCoverage(metrics.errorCoverage,runNegativeProbes(metrics));
      const ids = (await dockerInput(['container', 'ls', '-a', '--filter', `label=codex.release297-v2=${run}`, '--no-trunc', '--format', '{{.ID}}'])).trim().split(/\r?\n/).filter(Boolean);
      for (const id of ids) {
        if (id === configuration.pgContainerId) continue;
        const actual = JSON.parse(await dockerInput(['inspect', id]))[0]; assert.equal(actual.Config.Labels['codex.release297-v2'], run); assert.equal(actual.Config.Labels['codex.release297-source'], options.source);
        assert.ok(id === redisId || actual.Image === binding.helperContainerImage);
        if (actual.State.Running) { await dockerInput(['stop','--time','10',id]); const stopped=JSON.parse(await dockerInput(['inspect',id]))[0].State;
          if (id===redisId) metrics.redisCleanStop=stopped.ExitCode===0&&!stopped.OOMKilled&&!stopped.Running; }
        await dockerInput(['rm', '--volumes', id]);
      }
      const remaining = (await dockerInput(['container', 'ls', '-a', '--filter', `label=codex.release297-v2=${run}`, '--no-trunc', '--format', '{{.ID}}'])).trim().split(/\r?\n/).filter(Boolean);
      assert.ok(remaining.every(id => id === configuration.pgContainerId));
      metrics.roleCleanup = { exits, confirmedAbsent: true, cleanupPassed: exits.every(exit => exit.clean === true) && metrics.redisCleanStop===true };
      save(output, 'role-cleanup.json', metrics.roleCleanup);
    }
  }
  try {
    if (profile.usage) {
      const snapshot = loadSnapshot(options.snapshotDirectory, options.snapshotManifestSha256, { source: options.source, today: today() });
      const fixture = structuredClone(snapshot.data['cold-fixture-state.json']);
      const date = new Date(fixture.today + 'T12:00:00Z'), localDay = n => new Date(date.getTime() + n * 86400_000).toISOString().slice(0, 10);
      Object.assign(fixture, { heavyDate: localDay(-2), emptyDate: localDay(-3), gapDate: localDay(-5), from: localDay(-365), historyDays: 361 });
      await withRestoredSnapshot({ ...options, source: options.source, evidenceDirectory: output, privateDirectory: control,
        mode: 'diagnostic', planFile, planSha256, purpose: 'New v2 three-API synthetic campaign; original single-API contract is unchanged' }, async context => {
        const configuration = read(context.configurationFile); configuration.pgContainerId = context.ready.pgContainerId; configuration.schemaSha256 = snapshot.data['schema-fingerprint.json'].canonicalSha256;
        await measure(configuration, () => context.restartAfterRelease({ run, source: options.source, releasedAt: new Date().toISOString() }), fixture);
      });
    } else {
      mkdirSync(output); mkdirSync(control); save(output, 'run-plan.json', plan);
      await withCommonDatabase({ ...options, outputDirectory: output, privateDirectory: control }, dockerInput, (configuration, restart) => measure(configuration, restart));
    }
  } catch (error) { failure = error.code || error.message || 'V2_RUN_FAILED'; if (error.privateDetail && existsSync(control)) writeFileSync(join(control, 'failure.private'), error.privateDetail, { flag: 'wx', mode: 0o600 }); }
  finally {
    if (existsSync(output)) {
      metrics.sourceUnchanged = git(options.sourceDirectory, ['rev-parse', 'HEAD']) === options.source && git(options.sourceDirectory, ['status', '--porcelain']) === '';
      const pgCleanup = ['postgres-cleanup.json', 'cleanup.json'].map(name => join(output, name)).find(existsSync);
      metrics.cleanupPassed = metrics.roleCleanup?.cleanupPassed === true && pgCleanup && read(pgCleanup).cleanupPassed === true;
      metrics.diagnosticCompleted = !failure && profile.kind === 'diagnostic' && metrics.rounds.length === 1 && metrics.cleanupPassed===true && metrics.sourceUnchanged;
      metrics.smokePassed=!failure&&metrics.preparationSmoke===true&&metrics.preparationSmokeResult?.passed===true&&metrics.cleanupPassed===true&&metrics.sourceUnchanged
        &&metrics.expectedNegativeLogCoverage===true&&metrics.errorCoverage?.every(row=>row.complete&&row.available&&row.errorCount===0);
      metrics.runPassed = !metrics.preparationSmoke && !failure && profile.kind !== 'diagnostic' && metrics.rounds.length === (profile.rounds ?? 1)
        && metrics.rounds.every(round => round.acceptance.passed === true) && metrics.cleanupPassed === true && metrics.sourceUnchanged
        && metrics.errorCoverage?.length > 1 && metrics.errorCoverage.every(row=>row.complete&&row.available&&row.errorCount===0)&&metrics.expectedNegativeLogCoverage===true;
      if(profile.kind==='blackbox')metrics.runPassed&&=Number.isFinite(metrics.wholeOwnedApiCpuMicroseconds)&&metrics.wholeOwnedApiCpuMicroseconds>0&&metrics.wholeOwnedCpuIncludesFinalClassificationFlush===true;
      metrics.failure = failure ?? null; metrics.finishedAt = new Date().toISOString();
      if (metrics.rounds.length) { metrics.cpuMsPer200 ??= metrics.rounds[0].cpuMsPer200; metrics.p95Ms = (metrics.rounds[0].traffic.heartbeats ?? metrics.rounds[0].traffic).timings?.p95Ms ?? null; }
      save(output, 'metrics.json', metrics);
      const records = Object.fromEntries(readdirSync(output).filter(name => name.endsWith('.json')).sort().map(name => [name, hash(readFileSync(join(output, name)))]));
      save(output, 'receipt-manifest.json', { schemaVersion: 2, profile: profile.name, source: options.source, run, planSha256, records, capacityAccepted: false });
    }
  }
  return { output, source: options.source, profile: profile.name, runPassed: metrics.runPassed, smokePassed:metrics.smokePassed, diagnosticCompleted:metrics.diagnosticCompleted, cleanupPassed: metrics.cleanupPassed, failure, productionReadiness: false, capacityAccepted: false };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await runV2(read(process.argv[2])); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.runPassed || result.diagnosticCompleted || result.smokePassed ? 0 : 1; }
  catch { process.stderr.write('V2_RUN_PREPARATION_FAILED\n'); process.exitCode = 1; }
}
