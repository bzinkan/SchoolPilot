#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { reliabilityProfile, RELIABILITY_WORKLOAD_VERSION, validateReliabilityEnvironment } from './classpilot-reliability-profile.mjs';

const { values } = parseArgs({ options: {
  devices: { type: 'string', default: '40' }, 'dry-run': { type: 'boolean' },
  smoke: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: node scripts/load/run-classpilot-reliability.mjs --devices 40|500|800 [--dry-run] [--smoke]\nRequires existing private LOAD_DEVICE_MANIFEST, LOAD_TEACHER_AUTH_FILE, LOAD_COMMAND_BODIES_FILE, unique external progress/summary paths and LOAD_BASE_URL. Production is deliberately blocked. --smoke is a 60-second loopback functional check, never capacity acceptance.');
  process.exit(0);
}
const profile = reliabilityProfile(Number(values.devices));
const env = {
  ...process.env,
  LOAD_RELIABILITY_WORKLOAD: RELIABILITY_WORKLOAD_VERSION,
  LOAD_RELIABILITY_DEVICE_COUNT: String(profile.primaryDevices),
  LOAD_RELIABILITY_SMOKE: String(Boolean(values.smoke)),
  LOAD_GATE_PROFILE: 'partial', LOAD_ENFORCE_THRESHOLDS: 'true',
  LOAD_ENGINEERING_ACCEPTANCE: 'false', LOAD_DIAGNOSTIC_ONLY: 'false',
  LOAD_WORKLOAD_SCHEMA_VERSION: RELIABILITY_WORKLOAD_VERSION,
  LOAD_DEVICE_COUNT: String(profile.primaryDevices + 10),
  LOAD_DURATION_SECONDS: String(values.smoke ? 60 : profile.durationSeconds),
  LOAD_HEARTBEAT_INTERVAL_MS: '10000', LOAD_SCREENSHOT_INTERVAL_MS: '5000',
  LOAD_SCREENSHOT_GET_INTERVAL_MS: '5000', LOAD_HISTORY_INTERVAL_MS: '30000',
  LOAD_REQUEST_TIMEOUT_MS: '8000', LOAD_WS_AUTH_TIMEOUT_MS: '5000',
  LOAD_TEACHER_HISTORY_WARMUP_MS: '18000', LOAD_SCREENSHOT_GET_WARMUP_MS: '13000',
  LOAD_COMMAND_WARMUP_MS: '30000',
  LOAD_SCREENSHOT_BYTES: String(profile.screenshotBytes),
  LOAD_TEACHER_INTERVAL_MS: '30000', LOAD_EXPECTED_CLASS_BODIES: String(profile.classrooms),
  LOAD_EXPECTED_TARGETS_PER_CLASS: String(profile.studentsPerClass),
  LOAD_EXPECTED_CANARY_DEVICES: '10', LOAD_WAF_DEVICE_LIMIT: '100000', LOAD_WAF_GENERAL_LIMIT: '50000',
  LOAD_TEACHER_PATHS: '/api/students-aggregated?teachingSessionId={teachingSessionId}',
  LOAD_TILE_HISTORY_PATH: '/api/classpilot/tiles/history', LOAD_TILE_SCREENSHOTS_PATH: '/api/classpilot/tiles/screenshots',
  LOAD_COMMAND_ENDPOINT: '/api/classpilot/commands', LOAD_SCREENSHOT_GET_PATH_TEMPLATE: '',
  LOAD_FORCE_RECONNECT_AT_SECONDS: values.smoke ? '15' : '120',
  LOAD_FORCE_RECONNECT_STAGGER_MS: values.smoke ? '10000' : '30000',
};
const baseUrl = env.LOAD_BASE_URL;
if (!baseUrl) throw new Error('LOAD_BASE_URL is required');
validateReliabilityEnvironment(env, baseUrl);
const args = [fileURLToPath(new URL('./classpilot-load-test.mjs', import.meta.url))];
if (values['dry-run']) args.push('--validate-config');
const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Reliability harness could not start'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
