import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { FILES, assertExternalPaths, preparePrivateOutputDirectory, writePrivateJson } from './prepare-classpilot-load-test.mjs';
import { measurementPlan, measurementPlanDigest } from './classpilot-reliability-profile.mjs';
import { remoteGeneratorConfig, validateInputManifest } from './run-classpilot-remote-generator.mjs';

export function prepareRemoteInputs(options, env = process.env) {
  const external = assertExternalPaths(join(options.source, FILES.auth), options.output);
  if (resolve(options.source) === resolve(options.output)) throw new Error('Remote inputs must use a fresh directory');
  if (existsSync(external.outputPath)) throw new Error('Remote input custody must use a new directory');
  const privateRoot = realpathSync(external.loadGatesRoot);
  const withinPrivateRoot = path => {
    const rel = relative(privateRoot, realpathSync(path));
    return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
  };
  if (!withinPrivateRoot(options.source)) throw new Error('Selected cohort must remain in protected load custody');
  const manifestBinding = { version: 1, candidateApiImage: options.candidateImage, scriptBundleSha256: options.scriptSha };
  const config = remoteGeneratorConfig({ AWS_REGION: 'us-east-1', CLP_GENERATOR_ACCOUNT_ID: options.account,
    CLP_GENERATOR_BUCKET: `schoolpilot-staging-load-${options.account}`, CLP_GENERATOR_CAMPAIGN: options.campaign,
    CLP_GENERATOR_RUN_ID: options.runId, CLP_GENERATOR_DEVICES: options.devices, CLP_GENERATOR_ORIGIN: 'https://staging.school-pilot.net',
    CLP_GENERATOR_START_AT: options.startAt,
    CLP_GENERATOR_INPUT_SHA256: '0'.repeat(64), CLP_GENERATOR_SCRIPT_SHA256: options.scriptSha,
    CLP_GENERATOR_CANDIDATE_IMAGE: options.candidateImage, CLP_GENERATOR_IMAGE_DIGEST: options.generatorDigest }, manifestBinding);
  const prepared = {};
  for (const [key, name] of Object.entries({ devices: FILES.devices, auth: FILES.auth, commands: FILES.commands })) {
    const source = assertExternalPaths(join(options.source, name), options.output);
    if (!withinPrivateRoot(source.configPath)) throw new Error('Selected inputs must remain in protected load custody');
    const value = JSON.parse(readFileSync(source.configPath, 'utf8'));
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    prepared[key] = { value, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const manifest = validateInputManifest({ version: 2, measurementPlan: measurementPlan(config.profile.primaryDevices),
    measurementPlanSha256: measurementPlanDigest(config.profile.primaryDevices), campaign: config.campaign, runId: config.runId,
    renderedControllerSha256: createHash('sha256').update(readFileSync(fileURLToPath(new URL('./run-classpilot-rendered-dashboards.mjs', import.meta.url)))).digest('hex'),
    startAt: config.startAt,
    primaryDevices: config.profile.primaryDevices, candidateApiImage: config.candidateApiImage,
    scriptBundleSha256: config.scriptBundleSha256, createdAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(prepared).map(([key, file]) => [key, { bytes: file.bytes, sha256: file.sha256 }])) }, config);
  preparePrivateOutputDirectory(external.outputPath, external.loadGatesRoot);
  for (const [key, file] of Object.entries(prepared)) writePrivateJson(external.outputPath, `${key}.json`, file.value);
  writePrivateJson(external.outputPath, 'manifest.json', manifest);
  return { version: 1, campaign: config.campaign, runId: config.runId, primaryDevices: config.profile.primaryDevices,
    inputManifestSha256: createHash('sha256').update(readFileSync(join(external.outputPath, 'manifest.json'))).digest('hex'),
    startAt: config.startAt,
    inputPrefix: `${config.prefix}/inputs/`, outputPrefix: `${config.prefix}/results/`,
    scriptBundleSha256: config.scriptBundleSha256, candidateApiImage: config.candidateApiImage,
    generatorImageDigest: config.generatorImageDigest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['source', 'output', 'account', 'campaign', 'run-id', 'devices', 'candidate-image', 'script-sha', 'generator-digest', 'start-at']
      .map(key => [key, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
    if (values.help) console.log('Prepare fresh private S3 input files for an exact isolated staging generator. --source <selected-private-cohort> --output <fresh-private-inputs> --account <12digits> --campaign <campaign> --run-id <40|500|800>-<freshhex> --devices40|500|800 --candidate-image <stageAPI@digest> --script-sha <64hex> --generator-digest sha256:<64hex> --start-at <canonicalUTC within five minutes>. No network calls.');
    else console.log(JSON.stringify(prepareRemoteInputs({ ...values, runId: values['run-id'], candidateImage: values['candidate-image'],
      scriptSha: values['script-sha'], generatorDigest: values['generator-digest'], startAt: values['start-at'] })));
  } catch { console.error('[remote-inputs] Refused invalid or non-private run inputs'); process.exitCode = 1; }
}
