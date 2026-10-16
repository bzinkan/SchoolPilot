import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FILES, assertExternalPaths, loadExternalConfig, preparePrivateOutputDirectory,
  validateAuthArtifactContract, validateStateContract, writePrivateJson } from './prepare-classpilot-load-test.mjs';
import { reliabilityProfile } from './classpilot-reliability-profile.mjs';

export function validateReliabilityCommandBodies(commands, teacherAuth, commandUrl) {
  assert.ok(Array.isArray(commands) && commands.length === teacherAuth.length, 'One governed command per source teacher required');
  const sessions = new Set(teacherAuth.map(actor => actor.teachingSessionId));
  assert.equal(new Set(commands.map(command => command.teachingSessionId)).size, sessions.size);
  for (const command of commands) {
    assert.deepEqual(Object.keys(command).sort(), ['commandPayload', 'commandType', 'targetScope', 'teachingSessionId']);
    assert.ok(sessions.has(command.teachingSessionId) && command.targetScope === 'class' && command.commandType === 'open-tab');
    assert.deepEqual(Object.keys(command.commandPayload || {}), ['url']);
    assert.equal(command.commandPayload.url, commandUrl, 'Only the governed fixture URL is permitted');
  }
}

export function selectReliabilityCohort({ config, state, auth, devices, commands, primaryDevices }) {
  const profile = reliabilityProfile(primaryDevices);
  assert.equal(config.syntheticStaging, true, 'Only isolated synthetic staging fixtures may be selected');
  assert.equal(config.reliabilityDeviceCount, primaryDevices, 'Fixture must be prepared for this exact campaign');
  validateStateContract(state, config);
  validateAuthArtifactContract(auth, config, state);
  validateReliabilityCommandBodies(commands, auth.teacherAuth, config.commandUrl);
  assert.equal(devices.length, state.devices.length, 'Full source manifest must match governed fixture state');
  const sourceById = new Map(devices.map(device => [device.deviceId, device]));
  assert.equal(sourceById.size, devices.length, 'Source devices must be unique');
  for (const owned of state.devices) {
    const actual = sourceById.get(owned.deviceId);
    assert.ok(actual && actual.schoolId === owned.schoolId && actual.studentId === owned.studentId
      && actual.classId === owned.classId && actual.studentToken, 'Source device must retain its exact governed identity');
  }
  const actors = auth.teacherAuth.slice(0, profile.classrooms);
  const selectedStudents = new Set(actors.flatMap(actor => actor.studentIds));
  assert.equal(selectedStudents.size, primaryDevices, 'Exact disjoint classroom roster cardinality required');
  assert.ok(actors.every(actor => actor.studentIds.length === profile.studentsPerClass), 'Every classroom must have its configured size');
  const canaries = state.devices.filter(device => device.schoolKey === 'canary');
  assert.equal(canaries.length, 10, 'Exactly ten foreign canaries required');
  const primary = state.devices.filter(device => device.schoolKey === 'primary' && selectedStudents.has(device.studentId));
  assert.equal(primary.length, primaryDevices, 'Every selected student must have one exact device');
  const sessions = new Set(actors.map(actor => actor.teachingSessionId));
  const bodies = commands.filter(command => sessions.has(command.teachingSessionId));
  assert.equal(bodies.length, profile.classrooms, 'Exactly one class command per actor required');
  assert.equal(new Set(bodies.map(command => command.teachingSessionId)).size, profile.classrooms);
  assert.ok(bodies.every(command => command.targetScope === 'class' && command.commandType === 'open-tab'), 'Only governed class commands accepted');
  return { devices: [...canaries, ...primary].map(device => sourceById.get(device.deviceId)),
    commands: bodies, auth: { ...auth, teacherAuth: actors }, profile };
}

export function runSelection(arguments_ = process.argv.slice(2)) {
  const { values } = parseArgs({ args: arguments_, options: {
    config: { type: 'string' }, source: { type: 'string' }, output: { type: 'string' }, devices: { type: 'string' },
    'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) return console.log('Usage: node scripts/load/select-classpilot-reliability-cohort.mjs --config <external-json> --source <verified-private-fixture-dir> --output <fresh-private-campaign-dir> --devices 40|500|800 [--dry-run]. No network requests. Source artifacts are never modified.');
  assert.ok(values.config && values.source && values.output && values.devices, 'Exact external config/source/output and device count required');
  const output = assertExternalPaths(values.config, values.output);
  const source = assertExternalPaths(values.config, values.source);
  assert.notEqual(source.outputPath, output.outputPath, 'Source and campaign directories must differ');
  const config = loadExternalConfig(output.configPath);
  const read = name => JSON.parse(readFileSync(join(source.outputPath, name), 'utf8'));
  const verification = read(FILES.verification);
  assert.equal(verification.fixtureId, config.fixtureId, 'Fresh verification must belong to this fixture');
  const verifiedAt = Date.parse(verification.verifiedAt || verification.generatedAt || '');
  assert.ok(Number.isFinite(verifiedAt) && Date.now() - verifiedAt >= 0 && Date.now() - verifiedAt <= 15 * 60_000,
    'Governed verification must be completed within fifteen minutes');
  for (const gate of ['autoEnrollDisabled', 'trackingDisabled', 'schedulesDisabled', 'exactSchoolTimezones',
    'classRostersExactAndDisjoint', 'allDeviceTokensLive', 'allStaffAuthArtifactsLive']) assert.equal(verification.gates?.[gate], true);
  const selected = selectReliabilityCohort({ config, state: read(FILES.state), auth: read(FILES.auth),
    devices: read(FILES.devices), commands: read(FILES.commands), primaryDevices: Number(values.devices) });
  if (!values['dry-run']) {
    preparePrivateOutputDirectory(output.outputPath);
    assert.notEqual(realpathSync(source.outputPath), realpathSync(output.outputPath), 'Never overwrite source artifacts');
    for (const name of [FILES.devices, FILES.auth, FILES.commands]) assert.equal(existsSync(join(output.outputPath, name)), false, 'Fresh campaign artifacts required');
    writePrivateJson(output.outputPath, FILES.devices, selected.devices);
    writePrivateJson(output.outputPath, FILES.auth, selected.auth);
    writePrivateJson(output.outputPath, FILES.commands, selected.commands);
  }
  console.log(JSON.stringify({ operation: values['dry-run'] ? 'cohort-preflight' : 'cohort-written', primaryDevices: selected.profile.primaryDevices,
    canaryDevices: 10, teacherActors: selected.profile.classrooms, studentsPerClass: selected.profile.studentsPerClass,
    durationSeconds: selected.profile.durationSeconds, productionAccepted: false, browserPaintValidated: false, managedDevicesValidated: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runSelection(); } catch { console.error('[reliability-cohort] Refused invalid, stale or mismatched external fixture artifacts'); process.exitCode = 1; }
}
